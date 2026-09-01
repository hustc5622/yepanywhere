import { createHash } from "node:crypto";
import {
  CODEX_THREAD_ITEM_TYPES,
  type InputRequest,
  SESSION_DISPLAY_MAX_NOTICE_LENGTH,
  SESSION_DISPLAY_MAX_TOOL_NAMES,
  type SessionDisplayPage,
  SessionDisplayPageSchema,
  type SessionDisplayQuestion,
  type SessionDisplaySegment,
  type SessionDisplayUserContent,
  type SessionQuestionPage,
  SessionQuestionPageSchema,
} from "@yep-anywhere/shared";
import type { Message } from "../supervisor/types.js";
import { isSyntheticUserPromptText } from "./user-prompt-classification.js";
import { isUserPromptMessage } from "./user-prompt-message.js";
import { compactQuestionText } from "./user-questions.js";

const MUTATING_FILE_TOOLS = new Set([
  "edit",
  "multiedit",
  "notebookedit",
  "write",
  "applypatch",
]);
const CHECK_COMMAND_RE =
  /\b((pnpm|npm|yarn|bun)\s+(--filter\s+\S+\s+)?(run\s+)?(lint|typecheck|test(?::e2e)?|build)\b|tsc\b|vitest\b|playwright\s+test\b|biome\s+check\b)/i;
const KNOWN_CODEX_THREAD_ITEM_TYPES = new Set<string>(CODEX_THREAD_ITEM_TYPES);
const INSPECTOR_ONLY_CODEX_ITEM_TYPES = new Set(["threadGoal", "turnPlan"]);

type QuestionCoverage = SessionQuestionPage["coverage"];
type ToolStatus = "running" | "completed" | "failed";
type ToolGroupStatus = Extract<
  SessionDisplaySegment,
  { type: "tool_group" }
>["status"];

interface ToolResultSummary {
  isError: boolean;
  isSilentWaitResult: boolean;
}

interface ToolProjectionItem {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  sourceIds: string[];
  silentWaitKey?: string;
  timestamp?: string;
}

interface TurnBuilder {
  id: string;
  question: SessionDisplayQuestion | null;
  segments: SessionDisplaySegment[];
}

export interface SessionDisplayDetailLocator {
  detailRef: string;
  turnId: string;
  kind: "tool_group" | "action_required";
  /** One row per tool as rendered after transport-noise collapsing. */
  toolRows: string[][];
  toolUseIds: string[];
}

export interface DecodedSessionDisplayDetailRef {
  turnId: string;
  kind: SessionDisplayDetailLocator["kind"];
  index: number;
  /** Reader-native revision needed to reopen a generic provider snapshot. */
  sourceRevision?: string;
}

export interface SessionDisplayProjection {
  page: SessionDisplayPage;
  questions: SessionQuestionPage;
  /** Server-private locators; never serialize these into the display page. */
  detailLocators: SessionDisplayDetailLocator[];
}

export interface BuildSessionDisplayProjectionParams {
  sessionId: string;
  revision: string;
  /** Reader-native revision bound into detail refs but never exposed as data. */
  detailSourceRevision?: string;
  messages: readonly Message[];
  questionCoverage: QuestionCoverage;
  /** Authoritative live/persisted input request; never inferred from tool args. */
  pendingInputRequest?: InputRequest | null;
  /** Suppress stale orphan classification while a provider turn may be active. */
  toolsMayBeActive?: boolean;
}

/**
 * Build a read-only display projection from already-normalized messages.
 *
 * The function intentionally does not read provider files, mutate messages or
 * retain tool bodies. Tool input is inspected only for safe aggregate counts.
 */
export function buildSessionDisplayProjection(
  params: BuildSessionDisplayProjectionParams,
): SessionDisplayProjection {
  const { resultsByToolId, latestToolUseById, orphanedToolIds } =
    collectToolFacts(params.messages);
  const turns: TurnBuilder[] = [];
  const detailLocators: SessionDisplayDetailLocator[] = [];
  const seenToolIds = new Set<string>();
  const seenQuestionIds = new Set<string>();
  const seenQuestionIdentityKeys = new Set<string>();
  const nextDetailIndexByTurn = new Map<string, number>();
  let currentTurn: TurnBuilder | null = null;
  let preambleTurn: TurnBuilder | null = null;
  let pendingTools: ToolProjectionItem[] = [];

  const ensurePreambleTurn = (): TurnBuilder => {
    if (preambleTurn) return preambleTurn;
    preambleTurn = {
      id: `preamble:${stableDigest([params.sessionId, params.revision]).slice(0, 16)}`,
      question: null,
      segments: [],
    };
    turns.push(preambleTurn);
    return preambleTurn;
  };

  const targetTurn = (): TurnBuilder => currentTurn ?? ensurePreambleTurn();

  const flushToolGroup = (): void => {
    if (pendingTools.length === 0) return;
    const turn = targetTurn();
    const toolUseIds = pendingTools.flatMap((tool) => tool.sourceIds);
    const detailRef = buildDetailRef(
      params.sessionId,
      params.revision,
      turn.id,
      "tool_group",
      takeDetailIndex(turn.id, nextDetailIndexByTurn),
      params.detailSourceRevision,
    );
    const changedFiles = new Set<string>();
    let checkCount = 0;
    let failedCount = 0;
    const toolNames: string[] = [];
    const seenNames = new Set<string>();

    for (const tool of pendingTools) {
      if (tool.status === "failed") failedCount += 1;
      if (isMutatingFileTool(tool.name)) {
        for (const path of extractToolPaths(tool.input)) changedFiles.add(path);
      }
      if (isCheckTool(tool.input)) checkCount += 1;
      if (
        toolNames.length < SESSION_DISPLAY_MAX_TOOL_NAMES &&
        !seenNames.has(tool.name)
      ) {
        seenNames.add(tool.name);
        toolNames.push(tool.name.slice(0, 256));
      }
    }

    const first = pendingTools[0];
    const segment: SessionDisplaySegment = {
      type: "tool_group",
      id: `tool-group:${detailRef.slice(-16)}`,
      status: summarizeToolGroupStatus(pendingTools),
      count: pendingTools.length,
      failedCount,
      ...(changedFiles.size > 0 ? { changedFileCount: changedFiles.size } : {}),
      ...(checkCount > 0 ? { checkCount } : {}),
      toolNames,
      detailRef,
      ...(first?.timestamp ? { timestamp: first.timestamp } : {}),
    };
    turn.segments.push(segment);
    detailLocators.push({
      detailRef,
      turnId: turn.id,
      kind: "tool_group",
      toolRows: pendingTools.map((tool) => tool.sourceIds),
      toolUseIds,
    });
    pendingTools = [];
  };

  const appendSegment = (segment: SessionDisplaySegment): void => {
    targetTurn().segments.push(segment);
  };

  const appendSetupNotice = (messageId: string, timestamp?: string): void => {
    flushToolGroup();
    const turn = targetTurn();
    const last = turn.segments.at(-1);
    if (last?.type === "notice" && last.kind === "session_setup") {
      last.count = (last.count ?? 1) + 1;
      return;
    }
    turn.segments.push({
      type: "notice",
      id: `setup:${messageId}`,
      kind: "session_setup",
      count: 1,
      ...(timestamp ? { timestamp } : {}),
    });
  };

  for (
    let messageIndex = 0;
    messageIndex < params.messages.length;
    messageIndex += 1
  ) {
    const message = params.messages[messageIndex];
    if (!message) continue;
    const messageId = getMessageId(message, messageIndex);
    const timestamp = message.timestamp;

    if (message.type === "error") {
      flushToolGroup();
      appendSegment({
        type: "error",
        id: messageId,
        message: boundedText(
          firstString(message.error, message.content) ?? "Agent error",
        ),
        ...(timestamp ? { timestamp } : {}),
      });
      continue;
    }

    if (message.type === "system") {
      const notice = projectSystemNotice(message, messageId);
      if (notice) {
        flushToolGroup();
        appendSegment(notice);
      }
      continue;
    }

    if (message.type === "kimi_goal") {
      const notice = projectKimiGoalNotice(message, messageId);
      if (notice) {
        flushToolGroup();
        appendSegment(notice);
      }
      continue;
    }

    if (isUserPromptMessage(message)) {
      const content = projectPublicUserContent(getMessageContent(message));
      const promptText = publicUserContentText(content);
      const hasMedia = Array.isArray(content)
        ? content.some((block) => block.type === "media")
        : false;
      if (promptText && isSyntheticUserPromptText(promptText) && !hasMedia) {
        appendSetupNotice(messageId, timestamp);
        continue;
      }

      const userIdentity = projectUserMessageIdentity(message);
      const identityKeys = userMessageIdentityKeys(userIdentity);
      if (
        seenQuestionIds.has(messageId) ||
        identityKeys.some((key) => seenQuestionIdentityKeys.has(key))
      ) {
        continue;
      }
      seenQuestionIds.add(messageId);
      for (const key of identityKeys) seenQuestionIdentityKeys.add(key);
      flushToolGroup();
      currentTurn = {
        id: getTurnId(message, messageId),
        question: {
          messageId,
          ...userIdentity,
          ...(message.parentUuid !== undefined
            ? { parentMessageId: message.parentUuid }
            : {}),
          content,
          ...(timestamp ? { timestamp } : {}),
          ...projectBranchRef(message),
        },
        segments: [],
      };
      turns.push(currentTurn);
      continue;
    }

    if (!isAssistantLikeMessage(message)) continue;
    const content = getMessageContent(message);
    if (typeof content === "string") {
      if (content.trim()) {
        flushToolGroup();
        appendSegment({
          type: "assistant_text",
          id: messageId,
          ...projectAssistantMessageIdentity(message),
          phase: projectAssistantPhase(message),
          content,
          ...(timestamp ? { timestamp } : {}),
        });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const rawBlock = content[blockIndex];
      if (!isRecord(rawBlock)) continue;
      if (rawBlock.type === "text" && typeof rawBlock.text === "string") {
        if (!rawBlock.text.trim()) continue;
        flushToolGroup();
        appendSegment({
          type: "assistant_text",
          id: `${messageId}:${blockIndex}`,
          ...projectAssistantMessageIdentity(message),
          phase: projectAssistantPhase(message),
          content: rawBlock.text,
          ...(timestamp ? { timestamp } : {}),
        });
        continue;
      }
      if (
        rawBlock.type !== "tool_use" ||
        typeof rawBlock.id !== "string" ||
        !rawBlock.id ||
        seenToolIds.has(rawBlock.id)
      ) {
        continue;
      }

      seenToolIds.add(rawBlock.id);
      const latestBlock = latestToolUseById.get(rawBlock.id) ?? rawBlock;
      const name =
        typeof latestBlock.name === "string" && latestBlock.name.trim()
          ? latestBlock.name.trim()
          : "Tool";
      const tool: ToolProjectionItem = {
        id: rawBlock.id,
        name,
        input: latestBlock.input,
        status: resolveToolStatus(
          latestBlock,
          resultsByToolId.get(rawBlock.id),
          orphanedToolIds.has(rawBlock.id) &&
            !params.pendingInputRequest &&
            !params.toolsMayBeActive,
        ),
        sourceIds: [rawBlock.id],
        ...projectSilentWaitKey(
          name,
          latestBlock.input,
          resultsByToolId.get(rawBlock.id),
        ),
        ...(timestamp ? { timestamp } : {}),
      };

      if (isPlanProgressTool(tool)) continue;
      if (isQuestionTool(name)) {
        flushToolGroup();
        const turn = targetTurn();
        const detailRef = buildDetailRef(
          params.sessionId,
          params.revision,
          turn.id,
          "action_required",
          takeDetailIndex(turn.id, nextDetailIndexByTurn),
          params.detailSourceRevision,
        );
        turn.segments.push({
          type: "action_required",
          id: `action:${tool.id}`,
          action: "question",
          status: tool.status,
          detailRef,
          ...(timestamp ? { timestamp } : {}),
        });
        detailLocators.push({
          detailRef,
          turnId: turn.id,
          kind: "action_required",
          toolRows: [[tool.id]],
          toolUseIds: [tool.id],
        });
        continue;
      }
      const previousTool = pendingTools.at(-1);
      if (
        tool.silentWaitKey !== undefined &&
        previousTool?.silentWaitKey === tool.silentWaitKey
      ) {
        pendingTools[pendingTools.length - 1] = {
          ...tool,
          id: previousTool.id,
          sourceIds: [...previousTool.sourceIds, ...tool.sourceIds],
          ...(previousTool.timestamp
            ? { timestamp: previousTool.timestamp }
            : {}),
        };
        continue;
      }
      pendingTools.push(tool);
    }
  }

  flushToolGroup();
  appendPendingInput(params.pendingInputRequest, currentTurn ?? preambleTurn, {
    ensurePreambleTurn,
  });
  if (params.toolsMayBeActive) markOpenLiveTail(turns);

  const page = SessionDisplayPageSchema.parse({
    sessionId: params.sessionId,
    revision: params.revision,
    turns: turns.filter(
      (turn) => turn.question !== null || turn.segments.length > 0,
    ),
  });
  const questions = SessionQuestionPageSchema.parse({
    coverage: params.questionCoverage,
    questions: page.turns.flatMap((turn) => {
      if (!turn.question) return [];
      const preview = compactQuestionText(
        publicUserContentText(turn.question.content),
      );
      return [
        {
          messageId: turn.question.messageId,
          turnId: turn.id,
          ...(turn.question.clientUserMessageId
            ? { clientUserMessageId: turn.question.clientUserMessageId }
            : {}),
          ...(turn.question.codexCorrelationKey
            ? { codexCorrelationKey: turn.question.codexCorrelationKey }
            : {}),
          preview,
          ...(turn.question.timestamp
            ? { timestamp: turn.question.timestamp }
            : {}),
        },
      ];
    }),
  });

  return { page, questions, detailLocators };
}

/**
 * Mark only the newest tool group after the latest readable assistant output.
 * Notices do not close the batch, while an assistant response, error, or
 * interactive action does. Raw details for this marker are the sole active
 * history exception; all older groups stay lazy.
 */
function markOpenLiveTail(turns: TurnBuilder[]): void {
  const turn = turns.at(-1);
  if (!turn) return;
  for (let index = turn.segments.length - 1; index >= 0; index -= 1) {
    const segment = turn.segments[index];
    if (!segment) continue;
    if (segment.type === "tool_group") {
      segment.liveTail = true;
      return;
    }
    if (
      segment.type === "assistant_text" ||
      segment.type === "error" ||
      segment.type === "action_required"
    ) {
      return;
    }
  }
}

/**
 * Keep only the normalized messages/blocks required to render one tool group.
 * This is used exclusively by the explicit detail route.
 */
export function selectSessionDisplayToolMessages(
  messages: readonly Message[],
  toolUseIds: readonly string[],
): Message[] {
  const selectedIds = new Set(toolUseIds);
  const selectedMessages: Message[] = [];

  for (const message of messages) {
    const taskNotification = getTaskNotificationResult(message);
    if (taskNotification && selectedIds.has(taskNotification.toolUseId)) {
      selectedMessages.push(message);
      continue;
    }

    const content = getMessageContent(message);
    if (!Array.isArray(content)) continue;
    const selectedBlocks = content.filter((block) => {
      if (!isRecord(block)) return false;
      return (
        (block.type === "tool_use" &&
          typeof block.id === "string" &&
          selectedIds.has(block.id)) ||
        (block.type === "tool_result" &&
          typeof block.tool_use_id === "string" &&
          selectedIds.has(block.tool_use_id))
      );
    });
    if (selectedBlocks.length === 0) continue;

    const projected: Message = {
      ...message,
      ...(message.message
        ? { message: { ...message.message, content: selectedBlocks } }
        : {}),
      ...(message.content !== undefined ? { content: selectedBlocks } : {}),
      ...(message.orphanedToolUseIds
        ? {
            orphanedToolUseIds: message.orphanedToolUseIds.filter((id) =>
              selectedIds.has(id),
            ),
          }
        : {}),
    };
    const originalResultCount = content.filter(
      (block) => isRecord(block) && block.type === "tool_result",
    ).length;
    if (originalResultCount > 1) {
      Reflect.deleteProperty(projected, "toolUseResult");
      Reflect.deleteProperty(projected, "tool_use_result");
    }
    selectedMessages.push(projected);
  }

  return selectedMessages;
}

function collectToolFacts(messages: readonly Message[]): {
  resultsByToolId: Map<string, ToolResultSummary>;
  latestToolUseById: Map<string, Record<string, unknown>>;
  orphanedToolIds: Set<string>;
} {
  const resultsByToolId = new Map<string, ToolResultSummary>();
  const latestToolUseById = new Map<string, Record<string, unknown>>();
  const orphanedToolIds = new Set<string>();

  for (const message of messages) {
    for (const id of message.orphanedToolUseIds ?? []) {
      orphanedToolIds.add(id);
    }

    const taskNotification = getTaskNotificationResult(message);
    if (taskNotification) {
      resultsByToolId.set(taskNotification.toolUseId, {
        isError: taskNotification.isError,
        isSilentWaitResult: false,
      });
    }

    const content = getMessageContent(message);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        block.id
      ) {
        latestToolUseById.set(block.id, block);
      } else if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        block.tool_use_id
      ) {
        resultsByToolId.set(block.tool_use_id, {
          isError: block.is_error === true,
          isSilentWaitResult: isSilentWaitResult(block.content),
        });
      }
    }
  }

  return { resultsByToolId, latestToolUseById, orphanedToolIds };
}

function getTaskNotificationResult(
  message: Message,
): { toolUseId: string; isError: boolean } | null {
  const content = getMessageContent(message);
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((block) =>
              isRecord(block) &&
              block.type === "text" &&
              typeof block.text === "string"
                ? [block.text]
                : [],
            )
            .join("\n")
        : "";
  if (!text.trimStart().startsWith("<task-notification>")) return null;
  const toolUseId = extractXmlTag(text, "tool-use-id");
  if (!toolUseId) return null;
  const status = extractXmlTag(text, "status") ?? "completed";
  return { toolUseId, isError: status !== "completed" };
}

function extractXmlTag(text: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim();
}

function getMessageContent(message: Message): unknown {
  return message.message?.content ?? message.content;
}

function getMessageId(message: Message, index: number): string {
  if (typeof message.uuid === "string" && message.uuid) return message.uuid;
  if (typeof message.id === "string" && message.id) return message.id;
  return `message:${index}`;
}

function projectUserMessageIdentity(message: Message): {
  clientUserMessageId?: string;
  codexCorrelationKey?: string;
} {
  const clientUserMessageId = nonEmptyString(message.clientUserMessageId);
  const codexCorrelationKey = nonEmptyString(message.codexCorrelationKey);
  return {
    ...(clientUserMessageId ? { clientUserMessageId } : {}),
    ...(codexCorrelationKey ? { codexCorrelationKey } : {}),
  };
}

function projectAssistantMessageIdentity(message: Message): {
  codexCorrelationKey?: string;
} {
  const codexCorrelationKey = nonEmptyString(message.codexCorrelationKey);
  return codexCorrelationKey ? { codexCorrelationKey } : {};
}

function userMessageIdentityKeys(identity: {
  clientUserMessageId?: string;
  codexCorrelationKey?: string;
}): string[] {
  return [
    ...(identity.clientUserMessageId
      ? [`client:${identity.clientUserMessageId}`]
      : []),
    ...(identity.codexCorrelationKey
      ? [`correlation:${identity.codexCorrelationKey}`]
      : []),
  ];
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function getTurnId(message: Message, messageId: string): string {
  const nativeTurnId = message.codexTurnId;
  return typeof nativeTurnId === "string" && nativeTurnId
    ? `turn:${nativeTurnId}`
    : `turn:${messageId}`;
}

function isAssistantLikeMessage(message: Message): boolean {
  const role = message.message?.role ?? message.role;
  return (
    role === "assistant" ||
    message.type === "assistant" ||
    message.type === "summary"
  );
}

function projectAssistantPhase(
  message: Message,
): "progress" | "final" | "text" {
  return message.codexMessagePhase === "commentary"
    ? "progress"
    : message.codexMessagePhase === "final_answer"
      ? "final"
      : "text";
}

function projectPublicUserContent(content: unknown): SessionDisplayUserContent {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const projected: Exclude<SessionDisplayUserContent, string> = [];
  for (const block of content) {
    if (typeof block === "string") {
      projected.push({ type: "text", text: block });
      continue;
    }
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      projected.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "tool_result" || block.type === "tool_use") continue;

    const kind = publicMediaKind(block.type);
    if (!kind) continue;
    const mimeType = publicMimeType(block);
    projected.push({
      type: "media",
      kind,
      ...(mimeType ? { mimeType } : {}),
      deferred: true,
    });
  }
  return projected;
}

function publicMediaKind(
  type: unknown,
): "image" | "audio" | "document" | "file" | null {
  if (type === "input_image" || type === "image") return "image";
  if (type === "input_audio" || type === "audio") return "audio";
  if (type === "document") return "document";
  if (typeof type === "string" && type) return "file";
  return null;
}

function publicMimeType(block: Record<string, unknown>): string | undefined {
  const source = isRecord(block.source) ? block.source : undefined;
  const candidate = [block.mime_type, block.mimeType, source?.media_type].find(
    (value): value is string => typeof value === "string",
  );
  if (!candidate) return undefined;
  const normalized = candidate.trim().slice(0, 128);
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(normalized)
    ? normalized
    : undefined;
}

function publicUserContentText(content: SessionDisplayUserContent): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : `[${block.kind}]`))
    .filter(Boolean)
    .join("\n");
}

function projectBranchRef(message: Message): {
  branch?: SessionDisplayQuestion["branch"];
} {
  const branch = isRecord(message.branch)
    ? message.branch
    : isRecord(message.codexBranch)
      ? message.codexBranch
      : null;
  if (
    !branch ||
    typeof branch.branchId !== "string" ||
    !branch.branchId ||
    (typeof branch.parentId !== "string" && branch.parentId !== null) ||
    !Number.isInteger(branch.siblingIndex) ||
    Number(branch.siblingIndex) < 0 ||
    !Number.isInteger(branch.siblingCount) ||
    Number(branch.siblingCount) < 1
  ) {
    return {};
  }
  return {
    branch: {
      branchId: branch.branchId,
      parentId: branch.parentId,
      siblingIndex: Number(branch.siblingIndex),
      siblingCount: Number(branch.siblingCount),
    },
  };
}

function resolveToolStatus(
  block: Record<string, unknown>,
  result: ToolResultSummary | undefined,
  orphaned: boolean,
): ToolStatus {
  if (result) return result.isError ? "failed" : "completed";
  const status =
    typeof block.status === "string" ? block.status.toLowerCase() : "";
  if (["complete", "completed", "success"].includes(status)) {
    return "completed";
  }
  if (
    [
      "error",
      "failed",
      "aborted",
      "cancelled",
      "canceled",
      "declined",
    ].includes(status) ||
    orphaned
  ) {
    return "failed";
  }
  return "running";
}

function projectSilentWaitKey(
  name: string,
  input: unknown,
  result: ToolResultSummary | undefined,
): { silentWaitKey?: string } {
  const normalized = normalizedToolName(name);
  if (normalized !== "wait" && normalized !== "codexwait") return {};
  if (result && !result.isSilentWaitResult) return {};
  const inputRecord = isRecord(input) ? input : {};
  const cellId = inputRecord.cell_id ?? inputRecord.cellId ?? "";
  return { silentWaitKey: String(cellId) };
}

function isSilentWaitResult(content: unknown): boolean {
  const text = getTextContent(content).trim();
  if (!text) return false;
  let decoded = text;
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "string") decoded = parsed.trim();
    } catch {
      // Keep the original text when it is not a JSON-encoded string.
    }
  }
  const lines = decoded.split("\n").map((line) => line.trim());
  const first = lines[0] ?? "";
  if (!/^Script (?:running with cell ID .+|terminated)$/i.test(first)) {
    return false;
  }
  const outputIndex = lines.findIndex((line) => /^Output:$/i.test(line));
  return (
    outputIndex < 0 ||
    lines.slice(outputIndex + 1).every((line) => line.length === 0)
  );
}

function getTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function summarizeToolGroupStatus(
  tools: readonly ToolProjectionItem[],
): ToolGroupStatus {
  const statuses = new Set(tools.map((tool) => tool.status));
  if (statuses.size > 1) return "mixed";
  const status = tools[0]?.status;
  return status === "completed"
    ? "completed"
    : status === "failed"
      ? "failed"
      : "running";
}

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isMutatingFileTool(name: string): boolean {
  return MUTATING_FILE_TOOLS.has(normalizedToolName(name));
}

function isQuestionTool(name: string): boolean {
  const normalized = normalizedToolName(name);
  return normalized === "question" || normalized === "askuserquestion";
}

function isPlanProgressTool(tool: ToolProjectionItem): boolean {
  const normalized = normalizedToolName(tool.name);
  if (normalized === "updateplan" || normalized === "todowrite") return true;
  return (
    normalized === "todolist" &&
    isRecord(tool.input) &&
    Array.isArray(tool.input.todos)
  );
}

function extractToolPaths(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const values: unknown[] = [
    input.file_path,
    input.filePath,
    input.path,
    input.notebook_path,
    input.notebookPath,
    input.old_path,
    input.oldPath,
    input.new_path,
    input.newPath,
  ];
  if (Array.isArray(input.changes)) {
    for (const change of input.changes) {
      if (isRecord(change)) values.push(change.path);
    }
  }
  return values.filter(
    (value): value is string =>
      typeof value === "string" && value.trim() !== "",
  );
}

function isCheckTool(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const command = [input.command, input.cmd, input.script].find(
    (value): value is string =>
      typeof value === "string" && value.trim() !== "",
  );
  if (command) return CHECK_COMMAND_RE.test(command);
  return (
    Array.isArray(input.args) &&
    input.args.every((arg) => typeof arg === "string") &&
    CHECK_COMMAND_RE.test(input.args.join(" "))
  );
}

function projectSystemNotice(
  message: Message,
  messageId: string,
): Extract<SessionDisplaySegment, { type: "notice" }> | null {
  const subtype = typeof message.subtype === "string" ? message.subtype : "";
  const timestamp = message.timestamp;
  if (subtype === "compact_boundary") {
    return {
      type: "notice",
      id: messageId,
      kind: "compaction",
      ...(timestamp ? { timestamp } : {}),
    };
  }
  if (subtype === "turn_aborted") {
    return {
      type: "notice",
      id: messageId,
      kind: "turn_aborted",
      ...(timestamp ? { timestamp } : {}),
    };
  }
  if (subtype === "warning") {
    return {
      type: "notice",
      id: messageId,
      kind: "warning",
      message: boundedText(
        typeof message.content === "string" ? message.content : "Warning",
      ),
      ...(timestamp ? { timestamp } : {}),
    };
  }
  if (subtype !== "codex_native_item" || !isRecord(message.codexThreadItem)) {
    return null;
  }

  const item = message.codexThreadItem;
  const itemType = typeof item.type === "string" ? item.type : "";
  if (!itemType || INSPECTOR_ONLY_CODEX_ITEM_TYPES.has(itemType)) return null;
  const lifecycle =
    message.codexThreadItemLifecycle === "started" ? "running" : "completed";
  if (itemType === "plan") {
    return {
      type: "notice",
      id: messageId,
      kind: "plan",
      ...(typeof item.text === "string"
        ? { message: boundedText(item.text) }
        : {}),
      status: lifecycle,
      ...(timestamp ? { timestamp } : {}),
    };
  }
  if (itemType === "collabAgentToolCall" || itemType === "subAgentActivity") {
    const title = firstString(item.tool, item.kind);
    return {
      type: "notice",
      id: messageId,
      kind: "subagent",
      ...(title ? { title: boundedText(title, 512) } : {}),
      status: lifecycle,
      ...(timestamp ? { timestamp } : {}),
    };
  }
  if (KNOWN_CODEX_THREAD_ITEM_TYPES.has(itemType)) return null;
  return {
    type: "notice",
    id: messageId,
    kind: "provider_event",
    title: boundedText(itemType, 512),
    status: lifecycle,
    ...(timestamp ? { timestamp } : {}),
  };
}

function projectKimiGoalNotice(
  message: Message,
  messageId: string,
): Extract<SessionDisplaySegment, { type: "notice" }> | null {
  if (!isRecord(message.goal)) return null;
  const goal = message.goal;
  return {
    type: "notice",
    id: messageId,
    kind: "goal",
    ...(typeof goal.objective === "string"
      ? { message: boundedText(goal.objective) }
      : typeof goal.reason === "string"
        ? { message: boundedText(goal.reason) }
        : {}),
    ...(typeof goal.status === "string"
      ? { status: boundedText(goal.status, 64) }
      : {}),
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
  };
}

function appendPendingInput(
  request: InputRequest | null | undefined,
  currentTurn: TurnBuilder | null,
  helpers: { ensurePreambleTurn: () => TurnBuilder },
): void {
  if (!request) return;
  const turn = currentTurn ?? helpers.ensurePreambleTurn();
  const action = request.type === "tool-approval" ? "approval" : "question";
  if (
    turn.segments.some(
      (segment) =>
        segment.type === "action_required" &&
        segment.action === action &&
        segment.status === "running",
    )
  ) {
    return;
  }
  turn.segments.push({
    type: "action_required",
    id: `pending:${request.id}`,
    action,
    status: "running",
    label: boundedText(request.prompt),
    ...(request.timestamp ? { timestamp: request.timestamp } : {}),
  });
}

function buildDetailRef(
  sessionId: string,
  revision: string,
  turnId: string,
  kind: SessionDisplayDetailLocator["kind"],
  index: number,
  sourceRevision?: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      t: turnId,
      k: kind === "tool_group" ? "g" : "a",
      i: index,
      ...(sourceRevision ? { r: sourceRevision } : {}),
    }),
  ).toString("base64url");
  const checksum = stableDigest([sessionId, revision, payload]).slice(0, 16);
  return `sd1.${payload}.${checksum}`;
}

export function decodeSessionDisplayDetailRef(
  sessionId: string,
  revision: string,
  detailRef: string,
): DecodedSessionDisplayDetailRef | null {
  const match = /^sd1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{16})$/.exec(detailRef);
  const payload = match?.[1];
  const checksum = match?.[2];
  if (
    !payload ||
    !checksum ||
    stableDigest([sessionId, revision, payload]).slice(0, 16) !== checksum
  ) {
    return null;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !isRecord(decoded) ||
      decoded.v !== 1 ||
      typeof decoded.t !== "string" ||
      !decoded.t ||
      (decoded.k !== "g" && decoded.k !== "a") ||
      !Number.isSafeInteger(decoded.i) ||
      Number(decoded.i) < 0 ||
      (decoded.r !== undefined && (typeof decoded.r !== "string" || !decoded.r))
    ) {
      return null;
    }
    return {
      turnId: decoded.t,
      kind: decoded.k === "g" ? "tool_group" : "action_required",
      index: Number(decoded.i),
      ...(typeof decoded.r === "string" ? { sourceRevision: decoded.r } : {}),
    };
  } catch {
    return null;
  }
}

function takeDetailIndex(
  turnId: string,
  nextByTurn: Map<string, number>,
): number {
  const index = nextByTurn.get(turnId) ?? 0;
  nextByTurn.set(turnId, index + 1);
  return index;
}

function stableDigest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(":");
    hash.update(part);
    hash.update(";");
  }
  return hash.digest("base64url").slice(0, 32);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" && value.trim() !== "",
  );
}

function boundedText(
  value: string,
  maxLength = SESSION_DISPLAY_MAX_NOTICE_LENGTH,
): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
