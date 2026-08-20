import { join } from "node:path";
import type {
  ClaudeSessionEntry,
  CodexCompactedEntry,
  CodexCustomToolCallOutputPayload,
  CodexCustomToolCallPayload,
  CodexEventMsgEntry,
  CodexFunctionCallPayload,
  CodexImageGenerationPayload,
  CodexMessagePayload,
  CodexMessagePhase,
  CodexPatchApplyEndEvent,
  CodexReasoningPayload,
  CodexResponseItemEntry,
  CodexSessionEntry,
  CodexWebSearchCallPayload,
  ContextCompactEvent,
  ContextCumulativeUsage,
  ContextUsage,
  GeminiAssistantMessage,
  GeminiSessionMessage,
  GeminiUserMessage,
  KimiContentPartEvent,
  KimiSessionContent,
  KimiStepEndEvent,
  KimiToolCallEvent,
  KimiToolResultEvent,
  KimiTurnEndedRecord,
  PiAgentMessage,
  PiAssistantMessage,
  PiSessionContent,
  PiSessionEntry,
  PiToolResultMessage,
  ProviderName,
  SessionBranchOption,
  SessionBranchState,
  UnifiedSession,
  ZCodeSessionContent,
  ZCodeStoredMessage,
} from "@yep-anywhere/shared";
import {
  getGeminiUserMessageText,
  getKimiGoalTimeline,
  getKimiPromptImages,
  getKimiPromptText,
  getMessageContent,
  getModelContextWindow,
  getPiMessageText,
  isConversationEntry,
  isKimiLoopEventRecord,
  isKimiTurnEndedRecord,
  isKimiTurnPromptRecord,
} from "@yep-anywhere/shared";
import {
  isCodexCorrelationDebugEnabled,
  logCodexCorrelationDebug,
  summarizeCodexNormalizedMessage,
} from "../codex/correlationDebugLogger.js";
import {
  buildCodexEditInput,
  formatCodexFileChangeResult,
  isCodexFileChangeError,
  normalizeCodexFileChangeStatus,
  normalizeCodexFileChanges,
} from "../codex/file-change.js";
import {
  buildCodexImageGenerationResultText,
  isCodexImageGenerationRecord,
  normalizeCodexImageGenerationRecord,
  summarizeCodexImageGenerationResult,
} from "../codex/image-generation.js";
import {
  type CodexToolCallContext,
  canonicalizeCodexToolName,
  deriveCodexWebRunInvocation,
  extractCodexExecUpdatePlan,
  normalizeCodexToolInvocation,
  normalizeCodexToolOutputWithContext,
  parseCodexToolArguments,
} from "../codex/normalization.js";
import { normalizeKimiToolInput } from "../kimi/tool-input.js";
import type {
  ContentBlock,
  Message,
  Session,
  SessionSummary,
} from "../supervisor/types.js";
import { collectVisibleClaudeEntries } from "./claude-messages.js";
import { codexEntryAnchor } from "./codex-entry-anchor.js";
import { applyCodexRollbackMarkers } from "./codex-rollback.js";
import {
  CODEX_TURN_ABORTED_DISPLAY_TEXT,
  isCodexTurnAbortedNoticeText,
} from "./codex-turn-aborted.js";
import { parsePiProviderId } from "./pi-model-refs.js";
import { canonicalizePiToolName, normalizePiToolInput } from "./pi-tools.js";
import {
  MANAGED_ATTACHMENT_MARKER,
  sanitizePublicUserPrompt,
} from "./public-user-prompt.js";
import type { LoadedSession } from "./types.js";
import { isUserPromptMessage } from "./user-prompt-message.js";
import { createSessionQuestion } from "./user-questions.js";

interface CodexToolUseConversion {
  callId: string;
  message: Message;
  context: CodexToolCallContext;
}

interface PendingExternalCodexToolCall {
  callId: string;
  context: CodexToolCallContext;
}

function appendNestedCodexPlanBlock(
  content: ContentBlock[],
  callId: string,
  context: CodexToolCallContext,
): void {
  if (context.toolName !== "CodexExec") return;
  const nestedPlan = extractCodexExecUpdatePlan(context.input);
  if (!nestedPlan) return;

  content.push({
    type: "tool_use",
    id: `${callId}-update-plan`,
    name: "UpdatePlan",
    input: nestedPlan,
    status: "completed",
  });
}

function normalizeClaudeQueueOperationContent(content: unknown): string {
  if (content === undefined) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (!item || typeof item !== "object") {
        return "";
      }

      const type = (item as { type?: unknown }).type;
      if (type === "text") {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      if (type === "image") return "[Image]";
      if (type === "document") return "[Document]";
      if (type === "tool_result") return "[Tool Result]";

      return "";
    })
    .join("\n");
}

function sanitizePublicMimeType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = value
    .replace(/[^A-Za-z0-9!#$&^_.+/-]+/g, "_")
    .trim()
    .slice(0, 120);
  return safe || undefined;
}

function safePublicMediaUrl(
  value: unknown,
  kind: "image" | "audio",
): string | undefined {
  if (typeof value !== "string") return undefined;
  const url = value.trim();
  if (!url) return undefined;

  const dataPrefix = kind === "image" ? /^data:image\//iu : /^data:audio\//iu;
  if (dataPrefix.test(url) && /;base64,/iu.test(url.slice(0, 256))) {
    return url;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizePublicMediaBlock(block: ContentBlock): ContentBlock {
  if (block.type !== "input_image" && block.type !== "input_audio") {
    return block;
  }

  const kind = block.type === "input_image" ? "image" : "audio";
  const urlKey = kind === "image" ? "image_url" : "audio_url";
  const rawUrl = block[urlKey];
  const publicUrl = safePublicMediaUrl(rawUrl, kind);
  const mimeType = sanitizePublicMimeType(block.mime_type);
  const hadManagedLocation =
    typeof block.file_path === "string" ||
    typeof block.path === "string" ||
    (typeof rawUrl === "string" && !publicUrl);
  const needsClone =
    hadManagedLocation || publicUrl !== rawUrl || mimeType !== block.mime_type;
  if (!needsClone) return block;

  const projected = Object.fromEntries(
    Object.entries(block).filter(
      ([key]) =>
        key !== "file_path" &&
        key !== "path" &&
        key !== urlKey &&
        key !== "mime_type",
    ),
  ) as ContentBlock;
  if (publicUrl) {
    projected[urlKey] = publicUrl;
  }
  if (mimeType) {
    projected.mime_type = mimeType;
  }
  if (hadManagedLocation) {
    projected.managed_attachment = MANAGED_ATTACHMENT_MARKER;
  }
  return projected;
}

function sanitizePublicUserContent(
  content: string | ContentBlock[] | undefined,
  codex: boolean,
): string | ContentBlock[] | undefined {
  if (typeof content === "string") {
    return sanitizePublicUserPrompt(content, { codex });
  }
  if (!Array.isArray(content)) return content;

  let changed = false;
  const projected = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    if (block.type === "text" && typeof block.text === "string") {
      const text = sanitizePublicUserPrompt(block.text, { codex });
      if (text !== block.text) {
        changed = true;
        return { ...block, text };
      }
    }
    const media = sanitizePublicMediaBlock(block);
    if (media !== block) changed = true;
    return media;
  });
  return changed ? projected : content;
}

function truncatePublicBranchTitle(prompt: string, maxLength: number): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const text = firstLine || prompt.trim() || MANAGED_ATTACHMENT_MARKER;
  if (maxLength < 4 || text.length <= maxLength) {
    return text.slice(0, maxLength);
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function sanitizePublicBranchOption(
  branch: SessionBranchOption,
  codex: boolean,
): SessionBranchOption {
  const prompt = sanitizePublicUserPrompt(branch.prompt, { codex });
  const sanitizedTitle = sanitizePublicUserPrompt(branch.title, { codex });
  const title =
    prompt === branch.prompt
      ? sanitizedTitle
      : truncatePublicBranchTitle(prompt, Math.max(branch.title.length, 1));
  return prompt === branch.prompt && title === branch.title
    ? branch
    : { ...branch, prompt, title };
}

function sanitizePublicBranchState(
  branchState: SessionBranchState | undefined,
  codex: boolean,
): SessionBranchState | undefined {
  if (!branchState) return undefined;
  const branches = branchState.branches.map((branch) =>
    sanitizePublicBranchOption(branch, codex),
  );
  return branches.every(
    (branch, index) => branch === branchState.branches[index],
  )
    ? branchState
    : { ...branchState, branches };
}

function sanitizeMessageBranchMetadata(
  value: unknown,
  codex: boolean,
): unknown {
  if (!isRecord(value) || !Array.isArray(value.alternatives)) return value;
  const currentAlternatives = value.alternatives as unknown[];
  const alternatives = currentAlternatives.map((branch) =>
    isRecord(branch) &&
    typeof branch.prompt === "string" &&
    typeof branch.title === "string"
      ? sanitizePublicBranchOption(
          branch as unknown as SessionBranchOption,
          codex,
        )
      : branch,
  );
  return alternatives.every(
    (branch, index) => branch === currentAlternatives[index],
  )
    ? value
    : { ...value, alternatives };
}

function sanitizePublicNormalizedMessage(
  message: Message,
  codex: boolean,
): Message {
  let projected = message;

  if (isUserPromptMessage(message)) {
    const nestedContent = sanitizePublicUserContent(
      message.message?.content,
      codex,
    );
    const directContent = sanitizePublicUserContent(
      message.content as string | ContentBlock[] | undefined,
      codex,
    );
    if (
      nestedContent !== message.message?.content ||
      directContent !== message.content
    ) {
      projected = {
        ...projected,
        ...(message.message
          ? { message: { ...message.message, content: nestedContent } }
          : {}),
        ...(message.content !== undefined ? { content: directContent } : {}),
      };
    }
  }

  const branch = sanitizeMessageBranchMetadata(projected.branch, codex);
  const codexBranch = sanitizeMessageBranchMetadata(
    projected.codexBranch,
    codex,
  );
  if (branch !== projected.branch || codexBranch !== projected.codexBranch) {
    projected = { ...projected, branch, codexBranch };
  }
  return projected;
}

function sanitizePublicNormalizedSession(session: Session): Session {
  const codex =
    session.provider === "codex" || session.provider === "codex-oss";
  const messages = session.messages.map((message) =>
    sanitizePublicNormalizedMessage(message, codex),
  );
  const branchState = sanitizePublicBranchState(session.branchState, codex);
  const codexBranchState = sanitizePublicBranchState(
    session.codexBranchState,
    codex,
  );
  const title = session.title
    ? sanitizePublicUserPrompt(session.title, { codex })
    : session.title;
  const fullTitle = session.fullTitle
    ? sanitizePublicUserPrompt(session.fullTitle, { codex })
    : session.fullTitle;
  const userQuestions = session.userQuestions?.map((question) => ({
    ...question,
    text: sanitizePublicUserPrompt(question.text, { codex }),
  }));

  return {
    ...session,
    title,
    fullTitle,
    userQuestions,
    branchState,
    codexBranchState,
    messages,
  };
}

export interface NormalizeSessionOptions {
  /** Omit inline image payloads from Pi messages. */
  deferMedia?: boolean;
  /** Omit Pi thinking blocks from messages. */
  deferThinking?: boolean;
}

/**
 * Normalize a UnifiedSession into the generic Session format expected by the frontend.
 */
export function normalizeSession(
  loaded: LoadedSession,
  options?: NormalizeSessionOptions,
): Session {
  const { summary, data } = loaded;

  switch (data.provider) {
    case "claude":
    case "claude-ollama": {
      const rawMessages = data.session.messages;
      const { entries, orphanedToolUses } = loaded.messagesAlreadyProjected
        ? {
            entries: rawMessages,
            orphanedToolUses: loaded.orphanedToolUses ?? new Set<string>(),
          }
        : collectVisibleClaudeEntries(rawMessages, {
            branchId: loaded.branchState?.selectedBranchId ?? undefined,
            sessionId: summary.id,
          });
      const messages: Message[] = entries.map((raw, index) =>
        convertClaudeMessage(raw, index, orphanedToolUses),
      );

      return sanitizePublicNormalizedSession({
        ...summary,
        branchState: loaded.branchState,
        messages: loaded.branchState
          ? annotateBranchMessages(messages, loaded.branchState)
          : messages,
      });
    }
    case "codex":
    case "codex-oss": {
      const branchState = loaded.codexBranchState ?? loaded.branchState;
      const messages = loaded.projectedMessages
        ? loaded.projectedMessages
        : convertCodexEntries(
            applyCodexRollbackMarkers(data.session.entries),
            summary.id,
            branchState,
            {
              model: summary.model,
              provider: data.provider,
            },
          );
      return sanitizePublicNormalizedSession({
        ...summary,
        branchState,
        codexBranchState: loaded.codexBranchState,
        messages,
      });
    }
    case "gemini":
      return sanitizePublicNormalizedSession({
        ...summary,
        messages: convertGeminiMessages(data.session.messages),
      });
    case "pi": {
      const precomputed = loaded.precomputedPiMessages;
      const deferMedia =
        options?.deferMedia ?? precomputed?.deferMedia ?? false;
      const deferThinking =
        options?.deferThinking ?? precomputed?.deferThinking ?? false;
      const messages =
        precomputed &&
        precomputed.deferMedia === deferMedia &&
        precomputed.deferThinking === deferThinking
          ? precomputed.messages
          : convertPiSession(data.session, {
              deferMedia,
              deferThinking,
            }).messages;
      return sanitizePublicNormalizedSession({
        ...summary,
        branchState: loaded.branchState,
        messages: loaded.branchState
          ? annotateBranchMessages(messages, loaded.branchState)
          : messages,
      });
    }
    case "kimi":
      return sanitizePublicNormalizedSession({
        ...summary,
        messages: convertKimiMessages(data.session),
      });
    case "zcode": {
      const messages = convertZCodeMessages(data.session);
      return sanitizePublicNormalizedSession({
        ...summary,
        branchState: loaded.branchState,
        messages: loaded.branchState
          ? annotateBranchMessages(messages, loaded.branchState)
          : messages,
      });
    }
  }
}

// --- Pi Conversion Logic ---

export interface PiDerivedSession {
  model?: string;
  reasoningEffort?: string;
  titleText: string;
  messageCount: number;
  userQuestions: NonNullable<SessionSummary["userQuestions"]>;
  contextUsage?: ContextUsage;
  cumulativeUsage?: ContextCumulativeUsage;
  compactEvents?: ContextCompactEvent[];
  lastTurnStatus?: SessionSummary["lastTurnStatus"];
  lastErrorMessage?: string;
}

export interface PiSessionConversionOptions {
  /** Omit inline image payloads from the normalized message blocks. */
  deferMedia?: boolean;
  /** Omit thinking blocks from the normalized message blocks. */
  deferThinking?: boolean;
  /** Resolve provider-specific context windows while deriving the summary. */
  getContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
    sessionId?: string,
  ) => number | undefined;
}

export interface PiSessionConversion {
  messages: Message[];
  derived: PiDerivedSession;
}

function isPiSessionMessageEntry(
  entry: PiSessionEntry,
): entry is PiSessionEntry & { type: "message"; message: PiAgentMessage } {
  return (
    entry.type === "message" && "message" in entry && isRecord(entry.message)
  );
}

function qualifyPiSessionModel(
  modelId: string,
  providerId: string | undefined,
): string {
  const { channelId } = parsePiProviderId(providerId);
  if (!channelId || modelId.startsWith(`${channelId}/`)) return modelId;
  return `${channelId}/${modelId}`;
}

interface PiDerivationAccumulator {
  model?: string;
  reasoningEffort?: string;
  explicitName?: string;
  firstUserText: string;
  messageCount: number;
  lastConversationRole?: string;
  lastAssistant?: PiAssistantMessage;
  userQuestions: NonNullable<SessionSummary["userQuestions"]>;
  compactEvents: ContextCompactEvent[];
  cumulative: ContextCumulativeUsage;
}

function createPiDerivationAccumulator(): PiDerivationAccumulator {
  return {
    firstUserText: "",
    messageCount: 0,
    userQuestions: [],
    compactEvents: [],
    cumulative: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      turnCount: 0,
    },
  };
}

function consumePiDerivation(
  accumulator: PiDerivationAccumulator,
  entry: PiSessionEntry,
): void {
  if (entry.type === "session_info" && "name" in entry) {
    const name = entry.name;
    if (typeof name === "string" && name.trim()) {
      accumulator.explicitName = name;
    }
  } else if (entry.type === "model_change" && "modelId" in entry) {
    if (typeof entry.modelId === "string") {
      accumulator.model = qualifyPiSessionModel(
        entry.modelId,
        "provider" in entry && typeof entry.provider === "string"
          ? entry.provider
          : undefined,
      );
    }
  } else if (
    entry.type === "thinking_level_change" &&
    "thinkingLevel" in entry &&
    typeof entry.thinkingLevel === "string"
  ) {
    accumulator.reasoningEffort = entry.thinkingLevel;
  } else if (entry.type === "compaction" && "summary" in entry) {
    const beforeTokens =
      "tokensBefore" in entry && typeof entry.tokensBefore === "number"
        ? entry.tokensBefore
        : undefined;
    accumulator.compactEvents.push({
      timestamp: entry.timestamp,
      beforeTokens,
      trigger: "pi",
    });
  }

  if (!isPiSessionMessageEntry(entry)) return;
  const message = entry.message;
  if (message.role === "user") {
    accumulator.messageCount += 1;
    accumulator.lastConversationRole = "user";
    const text = getPiMessageText(message);
    if (!accumulator.firstUserText && text.trim()) {
      accumulator.firstUserText = text;
    }
    const question = createSessionQuestion(
      { id: entry.id, text, timestamp: entry.timestamp },
      `pi-user-${accumulator.userQuestions.length}`,
    );
    if (question) accumulator.userQuestions.push(question);
  } else if (message.role === "assistant") {
    accumulator.messageCount += 1;
    accumulator.lastConversationRole = "assistant";
    accumulator.lastAssistant = message;
    accumulator.model = message.model
      ? qualifyPiSessionModel(message.model, message.provider)
      : accumulator.model;
    if (message.usage) {
      accumulator.cumulative.inputTokens += message.usage.input ?? 0;
      accumulator.cumulative.outputTokens += message.usage.output ?? 0;
      accumulator.cumulative.cacheReadTokens += message.usage.cacheRead ?? 0;
      accumulator.cumulative.cacheCreationTokens +=
        message.usage.cacheWrite ?? 0;
      accumulator.cumulative.totalTokens =
        (accumulator.cumulative.totalTokens ?? 0) +
        (message.usage.totalTokens ?? 0);
      accumulator.cumulative.turnCount += 1;
    }
  } else if (message.role === "toolResult") {
    // A trailing tool result means the assistant still owes a reply. Tool
    // results are not conversation turns, so only the tail marker moves.
    accumulator.lastConversationRole = "toolResult";
  }
}

function finishPiDerivation(
  session: PiSessionContent,
  accumulator: PiDerivationAccumulator,
  options: PiSessionConversionOptions,
): PiDerivedSession {
  const usage = accumulator.lastAssistant?.usage;
  const contextWindow =
    options.getContextWindow?.(accumulator.model, "pi", session.header.id) ??
    (accumulator.model
      ? getModelContextWindow(accumulator.model, "pi")
      : undefined);
  const inputTokens = usage
    ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
    : 0;
  const contextUsage =
    usage && contextWindow
      ? {
          inputTokens,
          outputTokens: usage.output ?? 0,
          cacheReadTokens: usage.cacheRead ?? 0,
          cacheCreationTokens: usage.cacheWrite ?? 0,
          contextWindow,
          percentage: Math.min(100, (inputTokens / contextWindow) * 100),
        }
      : undefined;
  const stopReason = accumulator.lastAssistant?.stopReason;
  // Only these stop reasons hand control back to the user. `toolUse` (and the
  // non-final `pending`/`deferred`) mean the agent was still mid-turn, so a
  // persisted session ending there was cut short rather than completed — it
  // used to be reported as "completed" because any last assistant message
  // counted as one.
  const settledStopReason =
    stopReason === "stop" || stopReason === "length" || stopReason === "error";
  const lastTurnStatus =
    accumulator.lastConversationRole === "user" ||
    accumulator.lastConversationRole === "toolResult"
      ? ("interrupted" as const)
      : stopReason === "error"
        ? ("failed" as const)
        : !accumulator.lastAssistant
          ? undefined
          : settledStopReason
            ? ("completed" as const)
            : ("interrupted" as const);

  return {
    model: accumulator.model,
    reasoningEffort: accumulator.reasoningEffort,
    titleText: accumulator.explicitName ?? accumulator.firstUserText,
    messageCount: accumulator.messageCount,
    userQuestions: accumulator.userQuestions,
    contextUsage,
    cumulativeUsage:
      accumulator.cumulative.turnCount > 0 ? accumulator.cumulative : undefined,
    compactEvents:
      accumulator.compactEvents.length > 0
        ? accumulator.compactEvents
        : undefined,
    lastTurnStatus,
    lastErrorMessage:
      stopReason === "error"
        ? accumulator.lastAssistant?.errorMessage
        : undefined,
  };
}

export function derivePiSession(
  session: PiSessionContent,
  options: PiSessionConversionOptions = {},
): PiDerivedSession {
  const accumulator = createPiDerivationAccumulator();
  for (const entry of session.activeEntries) {
    consumePiDerivation(accumulator, entry);
  }
  return finishPiDerivation(session, accumulator, options);
}

function piInputContent(
  message: Extract<PiAgentMessage, { role: "user" | "custom" }>,
  options: PiSessionConversionOptions,
): string | ContentBlock[] {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const blocks: ContentBlock[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      blocks.push(
        options.deferMedia || block.deferred
          ? {
              type: "input_image",
              mime_type: block.mimeType,
              deferred: true,
            }
          : {
              type: "input_image",
              mime_type: block.mimeType,
              image_url: `data:${block.mimeType};base64,${block.data}`,
            },
      );
    }
  }
  return blocks;
}

interface PiToolCallRegistration {
  id: string;
  nativeName: string;
  nativeInput: unknown;
  block: ContentBlock;
}

function piAssistantContent(
  message: PiAssistantMessage,
  resultDetailsByCallId: ReadonlyMap<string, unknown>,
  options: PiSessionConversionOptions,
  onToolCall?: (registration: PiToolCallRegistration) => void,
): ContentBlock[] {
  if (!Array.isArray(message.content)) return [];
  const blocks: ContentBlock[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        blocks.push({ type: "text", text: block.text });
        break;
      case "thinking":
        if (options.deferThinking || block.deferred) break;
        blocks.push({
          type: "thinking",
          thinking: block.thinking,
          ...((block.thinkingSignature ?? block.signature)
            ? { signature: block.thinkingSignature ?? block.signature }
            : {}),
        });
        break;
      case "toolCall": {
        const toolBlock: ContentBlock = {
          type: "tool_use",
          id: block.id,
          name: canonicalizePiToolName(block.name),
          input: normalizePiToolInput(
            block.name,
            block.arguments,
            resultDetailsByCallId.get(block.id),
          ),
        };
        blocks.push(toolBlock);
        onToolCall?.({
          id: block.id,
          nativeName: block.name,
          nativeInput: block.arguments,
          block: toolBlock,
        });
        break;
      }
      case "image":
        blocks.push(
          options.deferMedia || block.deferred
            ? { type: "image", mime_type: block.mimeType, deferred: true }
            : {
                type: "image",
                mime_type: block.mimeType,
                image_url: `data:${block.mimeType};base64,${block.data}`,
              },
        );
        break;
    }
  }
  return blocks;
}

function piToolResultContent(message: PiToolResultMessage): string {
  if (!Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push("[Image]");
  }
  return parts.join("\n");
}

/**
 * Convert Pi's active JSONL branch and derive its summary in one traversal.
 * Tool-result details are applied retroactively to the corresponding tool-use
 * block, so the old details pre-scan is no longer needed.
 */
export function convertPiSession(
  session: PiSessionContent,
  options: PiSessionConversionOptions = {},
): PiSessionConversion {
  const messages: Message[] = [];
  const accumulator = createPiDerivationAccumulator();
  const resultDetailsByCallId = new Map<string, unknown>();
  const toolCallsById = new Map<string, PiToolCallRegistration[]>();

  const registerToolCall = (registration: PiToolCallRegistration): void => {
    const registrations = toolCallsById.get(registration.id) ?? [];
    registrations.push(registration);
    toolCallsById.set(registration.id, registrations);
    const details = resultDetailsByCallId.get(registration.id);
    if (details !== undefined) {
      registration.block.input = normalizePiToolInput(
        registration.nativeName,
        registration.nativeInput,
        details,
      );
    }
  };

  for (const entry of session.activeEntries) {
    consumePiDerivation(accumulator, entry);

    if (entry.type === "compaction" && "summary" in entry) {
      messages.push({
        uuid: entry.id,
        parentUuid: entry.parentId,
        type: "system",
        subtype: "compact_boundary",
        content:
          typeof entry.summary === "string"
            ? entry.summary
            : "Context compacted",
        timestamp: entry.timestamp,
      });
      continue;
    }
    if (entry.type === "branch_summary" && "summary" in entry) {
      messages.push({
        uuid: entry.id,
        parentUuid: entry.parentId,
        type: "summary",
        message: {
          role: "assistant",
          content: typeof entry.summary === "string" ? entry.summary : "",
        },
        timestamp: entry.timestamp,
      });
      continue;
    }
    if (!isPiSessionMessageEntry(entry)) continue;

    const message = entry.message;
    switch (message.role) {
      case "user":
        messages.push({
          uuid: entry.id,
          parentUuid: entry.parentId,
          type: "user",
          message: {
            role: "user",
            content: piInputContent(message, options),
          },
          timestamp: entry.timestamp,
        });
        break;
      case "assistant":
        messages.push({
          uuid: entry.id,
          parentUuid: entry.parentId,
          type: "assistant",
          message: {
            role: "assistant",
            content: piAssistantContent(
              message,
              resultDetailsByCallId,
              options,
              registerToolCall,
            ),
            ...(message.model ? { model: message.model } : {}),
          },
          usage: message.usage,
          stopReason: message.stopReason,
          ...(message.errorMessage ? { error: message.errorMessage } : {}),
          timestamp: entry.timestamp,
        });
        break;
      case "toolResult": {
        resultDetailsByCallId.set(message.toolCallId, message.details);
        for (const registration of toolCallsById.get(message.toolCallId) ??
          []) {
          registration.block.input = normalizePiToolInput(
            registration.nativeName,
            registration.nativeInput,
            message.details,
          );
        }
        const content = piToolResultContent(message);
        messages.push({
          uuid: entry.id,
          parentUuid: entry.parentId,
          type: "user",
          tool_use_id: message.toolCallId,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: message.toolCallId,
                content,
                ...(message.isError ? { is_error: true } : {}),
              },
            ],
          },
          timestamp: entry.timestamp,
        });
        break;
      }
      case "bashExecution":
        messages.push({
          uuid: entry.id,
          parentUuid: entry.parentId,
          type: "system",
          subtype: "bash_execution",
          content: `Ran \`${message.command}\`\n\n${message.output}`,
          exitCode: message.exitCode,
          timestamp: entry.timestamp,
        });
        break;
      case "custom":
        if (message.display) {
          messages.push({
            uuid: entry.id,
            parentUuid: entry.parentId,
            type: "system",
            subtype: message.customType,
            message: {
              role: "user",
              content: piInputContent(message, options),
            },
            timestamp: entry.timestamp,
          });
        }
        break;
      case "branchSummary":
      case "compactionSummary":
        messages.push({
          uuid: entry.id,
          parentUuid: entry.parentId,
          type: "summary",
          message: { role: "assistant", content: message.summary },
          timestamp: entry.timestamp,
        });
        break;
    }
  }

  return {
    messages,
    derived: finishPiDerivation(session, accumulator, options),
  };
}

/** Convert Pi's active JSONL branch into Yep's provider-neutral transcript. */
export function convertPiMessages(
  session: PiSessionContent,
  options: PiSessionConversionOptions = {},
): Message[] {
  return convertPiSession(session, options).messages;
}

// --- Claude Conversion Logic ---

function convertClaudeMessage(
  raw: ClaudeSessionEntry,
  _index: number,
  orphanedToolUses: Set<string>,
): Message {
  if (raw.type === "queue-operation" && raw.operation === "enqueue") {
    const content = normalizeClaudeQueueOperationContent(raw.content).trim();
    const rawAny = raw as Record<string, unknown>;

    return {
      ...rawAny,
      id: `queue-operation-${_index}-${raw.timestamp}`,
      type: "user",
      role: "user",
      content,
      message: {
        role: "user",
        content,
      },
      deferred: true,
      deferredSource: "queue-operation",
    };
  }

  // Normalize content blocks - pass through all fields
  let content: string | ContentBlock[] | undefined;
  const rawContent = getMessageContent(raw);
  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    // Pass through all fields from each content block
    // Filter out string items (which can appear in user message content)
    content = rawContent
      .filter((block) => typeof block !== "string")
      .map((block) => ({ ...(block as object) })) as ContentBlock[];
  }

  // Build message by spreading all raw fields, then override with normalized values
  // Use type assertion since we're converting to a looser Message type
  const rawAny = raw as Record<string, unknown>;
  const message: Message = {
    ...rawAny,
    // Include normalized content if message had content
    ...(isConversationEntry(raw) && {
      message: {
        ...(raw.message as Record<string, unknown>),
        ...(content !== undefined && { content }),
      },
    }),
    // Ensure type is set
    type: raw.type,
  };

  // Identify orphaned tool_use IDs in this message's content
  if (Array.isArray(content)) {
    const orphanedIds = content
      .filter(
        (b): b is ContentBlock & { id: string } =>
          b.type === "tool_use" &&
          typeof b.id === "string" &&
          orphanedToolUses.has(b.id),
      )
      .map((b) => b.id);

    if (orphanedIds.length > 0) {
      message.orphanedToolUseIds = orphanedIds;
    }
  }

  return message;
}

// --- Codex Conversion Logic ---

const CODEX_COMPACTION_EVENT_DEDUPE_WINDOW_MS = 5_000;

function timestampToMs(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function hasNearbyCodexCompactedEntry(
  compactedTimestamps: number[],
  timestamp: string | undefined,
): boolean {
  const eventTimestamp = timestampToMs(timestamp);
  if (eventTimestamp === null) return false;

  return compactedTimestamps.some(
    (compactedTimestamp) =>
      Math.abs(compactedTimestamp - eventTimestamp) <=
      CODEX_COMPACTION_EVENT_DEDUPE_WINDOW_MS,
  );
}

interface CodexContextSnapshotOptions {
  model?: string;
  provider: "codex" | "codex-oss";
  /** Global rollout fact used when the supplied page starts mid-file. */
  hasResponseItemUser?: boolean;
  /** Global semantic facts collected by the bounded Codex page scanner. */
  patchApplyCallIds?: ReadonlySet<string>;
  directEditCallIds?: ReadonlySet<string>;
  responseImageGenerationIds?: ReadonlySet<string>;
  imageGenerationEndIds?: ReadonlySet<string>;
}

function isCodexTokenCountImmediatelyAfterCompaction(
  entries: readonly CodexSessionEntry[],
  tokenCountIndex: number,
): boolean {
  for (let i = tokenCountIndex - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type === "compacted") return true;
    if (
      entry.type === "event_msg" &&
      entry.payload.type === "context_compacted"
    ) {
      return true;
    }
    if (entry.type === "event_msg" && entry.payload.type === "token_count") {
      return false;
    }
  }

  return false;
}

function extractCodexTokenCountContextUsage(
  entries: readonly CodexSessionEntry[],
  tokenCountIndex: number,
  options: CodexContextSnapshotOptions,
): ContextUsage | undefined {
  const entry = entries[tokenCountIndex];
  if (
    !entry ||
    entry.type !== "event_msg" ||
    entry.payload.type !== "token_count"
  ) {
    return undefined;
  }

  const info = entry.payload.info;
  const usage = info?.last_token_usage ?? info?.total_token_usage;
  if (!usage) return undefined;

  let inputTokens = usage.input_tokens;
  if (
    inputTokens === 0 &&
    usage.total_tokens > 0 &&
    isCodexTokenCountImmediatelyAfterCompaction(entries, tokenCountIndex)
  ) {
    inputTokens = usage.total_tokens;
  }
  if (inputTokens <= 0) return undefined;

  const contextWindow =
    info?.model_context_window && info.model_context_window > 0
      ? info.model_context_window
      : getModelContextWindow(options.model, options.provider);

  const result: ContextUsage = {
    inputTokens,
    percentage: Math.min(100, Math.round((inputTokens / contextWindow) * 100)),
    contextWindow,
  };

  if (usage.output_tokens > 0) {
    result.outputTokens = usage.output_tokens;
  }
  if ((usage.cached_input_tokens ?? 0) > 0) {
    result.cacheReadTokens = usage.cached_input_tokens;
  }

  return result;
}

export function convertCodexEntries(
  entries: readonly CodexSessionEntry[],
  sessionId: string,
  branchState?: SessionBranchState,
  contextOptions: CodexContextSnapshotOptions = { provider: "codex" },
): Message[] {
  const messages: Message[] = [];
  let messageIndex = 0;
  let pendingContextMessage: Message | null = null;
  const hasResponseItemUser =
    contextOptions.hasResponseItemUser ??
    hasCodexResponseItemUserMessages(entries);
  const compactedTimestamps = entries
    .filter((entry) => entry.type === "compacted")
    .map((entry) => timestampToMs(entry.timestamp))
    .filter((timestamp): timestamp is number => timestamp !== null);
  const toolCallContexts = new Map<string, CodexToolCallContext>();
  const externalToolCalls: PendingExternalCodexToolCall[] = [];
  const responseItemImageGenerationIds =
    contextOptions.responseImageGenerationIds ??
    collectResponseItemImageGenerationIds(entries);
  const imageGenerationEndKeys =
    contextOptions.imageGenerationEndIds ??
    collectCodexImageGenerationEndKeys(entries);
  const patchApplyEndByCallId = collectCodexPatchApplyEndEvents(entries);
  const patchApplySkipCallIds =
    contextOptions.patchApplyCallIds ?? new Set(patchApplyEndByCallId.keys());
  const directEditCallIds =
    contextOptions.directEditCallIds ?? collectCodexDirectEditCallIds(entries);

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (!entry) continue;

    // Identity is anchored to the entry, not to how far into this array we are,
    // so a tail read of the same rollout produces the same ids.
    const anchor = codexEntryAnchor(
      entry,
      `${messageIndex}-${entry.timestamp}`,
    );

    if (entry.type === "response_item") {
      messageIndex++;
      const converted = convertCodexResponseItem(
        entry,
        anchor,
        toolCallContexts,
        externalToolCalls,
        {
          skippedImageGenerationCallKeys: imageGenerationEndKeys,
          patchApplyEndByCallId,
          skippedPatchApplyCallIds: patchApplySkipCallIds,
        },
      );
      const convertedMessages = Array.isArray(converted)
        ? converted
        : converted
          ? [converted]
          : [];
      const correlationKey = getCodexResponseCorrelationKey(entry.payload);
      const responseTurnId = getCodexResponsePayloadTurnId(entry.payload);
      for (const msg of convertedMessages) {
        if (correlationKey) {
          msg.codexCorrelationKey = correlationKey;
        }
        if (responseTurnId) {
          msg.codexTurnId = responseTurnId;
        }
        if (isCodexCorrelationDebugEnabled()) {
          logCodexCorrelationDebug({
            sessionId,
            channel: "jsonl",
            authority: "durable",
            entryType: entry.type,
            payloadType: entry.payload.type,
            eventKind: getCodexResponseEventKind(entry.payload),
            callId: getCodexResponsePayloadCallId(entry.payload),
            itemId: getCodexResponsePayloadItemId(entry.payload),
            ...summarizeCodexNormalizedMessage(msg),
          });
        }
        messages.push(msg);
        if (isUserPromptMessage(msg)) {
          pendingContextMessage = msg;
        }
      }
    } else if (entry.type === "compacted") {
      pendingContextMessage = null;
      messageIndex++;
      const msg = convertCodexCompactedEntry(entry, anchor);
      if (msg) {
        if (isCodexCorrelationDebugEnabled()) {
          logCodexCorrelationDebug({
            sessionId,
            channel: "jsonl",
            authority: "durable",
            entryType: entry.type,
            eventKind: "context_compacted",
            ...summarizeCodexNormalizedMessage(msg),
          });
        }
        messages.push(msg);
      }
    } else if (entry.type === "event_msg") {
      if (entry.payload.type === "token_count") {
        const contextUsage = extractCodexTokenCountContextUsage(
          entries,
          entryIndex,
          contextOptions,
        );
        if (contextUsage && pendingContextMessage) {
          pendingContextMessage.contextBefore = contextUsage;
          pendingContextMessage = null;
        }
        continue;
      }

      const shouldIncludeUserMessage =
        entry.payload.type === "user_message" && !hasResponseItemUser;
      const shouldIncludeTurnAborted = entry.payload.type === "turn_aborted";
      const shouldIncludeContextCompacted =
        entry.payload.type === "context_compacted" &&
        !hasNearbyCodexCompactedEntry(compactedTimestamps, entry.timestamp);
      if (entry.payload.type === "context_compacted") {
        pendingContextMessage = null;
      }
      const imageGenerationMessages =
        entry.payload.type === "item_completed"
          ? convertCodexItemCompletedImageGeneration(
              entry,
              anchor,
              responseItemImageGenerationIds,
            )
          : entry.payload.type === "image_generation_end"
            ? convertCodexImageGenerationEndEvent(entry, anchor)
            : null;
      const patchApplyPayload =
        entry.payload.type === "patch_apply_end" ? entry.payload : null;
      const patchApplyMessages = patchApplyPayload
        ? convertCodexPatchApplyEndEvent(
            entry,
            anchor,
            !directEditCallIds.has(patchApplyPayload.call_id),
          )
        : null;
      // Skip agent_message and agent_reasoning events when response_item exists;
      // those are streaming artifacts that duplicate full response data.
      if (patchApplyMessages && patchApplyPayload) {
        messageIndex++;
        for (const msg of patchApplyMessages) {
          if (isCodexCorrelationDebugEnabled()) {
            logCodexCorrelationDebug({
              sessionId,
              channel: "jsonl",
              authority: "durable",
              entryType: entry.type,
              payloadType: entry.payload.type,
              eventKind: "file_change",
              turnId: getCodexEventPayloadTurnId(entry.payload),
              callId: patchApplyPayload.call_id,
              status: normalizeCodexFileChangeStatus(
                patchApplyPayload.status,
                patchApplyPayload.success,
              ),
              ...summarizeCodexNormalizedMessage(msg),
            });
          }
          messages.push(msg);
        }
      } else if (imageGenerationMessages) {
        messageIndex++;
        for (const msg of imageGenerationMessages) {
          if (isCodexCorrelationDebugEnabled()) {
            logCodexCorrelationDebug({
              sessionId,
              channel: "jsonl",
              authority: "durable",
              entryType: entry.type,
              payloadType: entry.payload.type,
              eventKind: "image_generation",
              turnId: getCodexEventPayloadTurnId(entry.payload),
              itemId: getCodexEventPayloadItemId(entry.payload),
              ...summarizeCodexNormalizedMessage(msg),
            });
          }
          messages.push(msg);
        }
      } else if (
        shouldIncludeUserMessage ||
        shouldIncludeTurnAborted ||
        shouldIncludeContextCompacted
      ) {
        messageIndex++;
        const msg = convertCodexEventMsg(entry, anchor);
        if (msg) {
          if (isCodexCorrelationDebugEnabled()) {
            logCodexCorrelationDebug({
              sessionId,
              channel: "jsonl",
              authority: "durable",
              entryType: entry.type,
              payloadType: entry.payload.type,
              eventKind: entry.payload.type,
              turnId: getCodexEventPayloadTurnId(entry.payload),
              itemId: getCodexEventPayloadItemId(entry.payload),
              ...summarizeCodexNormalizedMessage(msg),
            });
          }
          messages.push(msg);
          if (isUserPromptMessage(msg)) {
            pendingContextMessage = msg;
          }
        }
      }
    }
  }

  return branchState
    ? annotateBranchMessages(messages, branchState, { includeCodexAlias: true })
    : messages;
}

function getNormalizedUserText(message: Message): string | null {
  if (message.type !== "user") return null;

  const content = message.message?.content ?? message.content;
  if (typeof content === "string") {
    const text = content.trim();
    return text.length > 0 ? content : null;
  }

  if (!Array.isArray(content)) return null;

  const text = content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String(block.text ?? "")
        : "",
    )
    .join("");
  return text.trim().length > 0 ? text : null;
}

function branchMessageKey(timestamp: string | undefined, prompt: string) {
  return `${timestamp ?? ""}\n${prompt}`;
}

function annotateBranchMessages(
  messages: Message[],
  branchState: SessionBranchState,
  options: { includeCodexAlias?: boolean } = {},
): Message[] {
  if (branchState.branches.length === 0) {
    return messages;
  }

  const branchById = new Map<string, SessionBranchOption>();
  const branchByKey = new Map<string, SessionBranchOption>();
  const branchesByParent = new Map<string, SessionBranchOption[]>();

  for (const branch of branchState.branches) {
    branchById.set(branch.id, branch);
    branchByKey.set(branchMessageKey(branch.createdAt, branch.prompt), branch);

    const parentKey = branch.parentId ?? "<root>";
    const siblings = branchesByParent.get(parentKey) ?? [];
    siblings.push(branch);
    branchesByParent.set(parentKey, siblings);
  }

  for (const siblings of branchesByParent.values()) {
    siblings.sort((a, b) => a.siblingIndex - b.siblingIndex);
  }

  return messages.map((message) => {
    const text = getNormalizedUserText(message);
    if (!text) return message;

    const messageId =
      typeof message.uuid === "string"
        ? message.uuid
        : typeof message.id === "string"
          ? message.id
          : undefined;
    const branch =
      (messageId ? branchById.get(messageId) : undefined) ??
      branchByKey.get(branchMessageKey(message.timestamp, text));
    if (!branch || branch.siblingCount <= 1) return message;

    const parentKey = branch.parentId ?? "<root>";
    const alternatives = branchesByParent.get(parentKey) ?? [branch];
    const branchMetadata = {
      // Cross-session edit alternatives carry the branch's native session id.
      sessionId: branch.sessionId,
      branchId: branch.id,
      activeBranchId: branchState.activeBranchId,
      selectedBranchId: branchState.selectedBranchId,
      parentId: branch.parentId,
      siblingIndex: branch.siblingIndex,
      siblingCount: branch.siblingCount,
      alternatives,
    };

    return {
      ...message,
      branch: branchMetadata,
      ...(options.includeCodexAlias && { codexBranch: branchMetadata }),
    };
  });
}

function getCodexResponseEventKind(
  payload: CodexResponseItemEntry["payload"],
): string {
  if (payload.type === "message") {
    return payload.role === "assistant" ? "assistant_message" : "user_message";
  }
  return payload.type;
}

function getCodexResponsePayloadCallId(
  payload: CodexResponseItemEntry["payload"],
): string | undefined {
  switch (payload.type) {
    case "function_call":
    case "function_call_output":
      return payload.call_id;
    case "custom_tool_call":
    case "custom_tool_call_output":
    case "web_search_call":
      return typeof payload.call_id === "string"
        ? payload.call_id
        : typeof payload.id === "string"
          ? payload.id
          : undefined;
    default:
      return undefined;
  }
}

function getCodexResponsePayloadItemId(
  payload: CodexResponseItemEntry["payload"],
): string | undefined {
  switch (payload.type) {
    case "message":
    case "reasoning":
      return payload.id;
    case "function_call":
    case "function_call_output":
      return payload.call_id;
    case "custom_tool_call":
    case "custom_tool_call_output":
    case "web_search_call":
      return typeof payload.id === "string"
        ? payload.id
        : typeof payload.call_id === "string"
          ? payload.call_id
          : undefined;
    default:
      return undefined;
  }
}

function getCodexResponsePayloadTurnId(
  payload: CodexResponseItemEntry["payload"],
): string | undefined {
  if (payload.type !== "message" && payload.type !== "reasoning") {
    return undefined;
  }
  return payload.internal_chat_message_metadata_passthrough?.turn_id;
}

function getCodexResponseCorrelationKey(
  payload: CodexResponseItemEntry["payload"],
): string | undefined {
  const itemId = getCodexResponsePayloadItemId(payload);
  const turnId = getCodexResponsePayloadTurnId(payload);
  if (!itemId || !turnId) return undefined;

  if (payload.type === "message" && payload.role === "assistant") {
    return `codex:${turnId}:agent-message:${itemId}`;
  }
  if (payload.type === "reasoning") {
    return `codex:${turnId}:reasoning:${itemId}`;
  }
  return undefined;
}

function getCodexEventPayloadTurnId(
  payload: CodexEventMsgEntry["payload"],
): string | undefined {
  return "turn_id" in payload && typeof payload.turn_id === "string"
    ? payload.turn_id
    : undefined;
}

function getCodexEventPayloadItemId(
  payload: CodexEventMsgEntry["payload"],
): string | undefined {
  if (payload.type !== "item_completed") {
    return undefined;
  }

  if (!payload.item || typeof payload.item !== "object") {
    return undefined;
  }

  const item = payload.item as { id?: unknown };
  return typeof item.id === "string" ? item.id : undefined;
}

function hasCodexResponseItemUserMessages(
  entries: readonly CodexSessionEntry[],
): boolean {
  return entries.some(
    (entry) =>
      entry.type === "response_item" &&
      entry.payload.type === "message" &&
      entry.payload.role === "user",
  );
}

function collectResponseItemImageGenerationIds(
  entries: readonly CodexSessionEntry[],
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "response_item") continue;
    const payload = entry.payload;
    if (!isCodexImageGenerationRecord(payload)) continue;
    const id = getFirstString((payload as Record<string, unknown>).id);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function collectCodexPatchApplyEndEvents(
  entries: readonly CodexSessionEntry[],
): Map<string, CodexPatchApplyEndEvent> {
  const events = new Map<string, CodexPatchApplyEndEvent>();
  for (const entry of entries) {
    if (
      entry.type === "event_msg" &&
      entry.payload.type === "patch_apply_end"
    ) {
      events.set(entry.payload.call_id, entry.payload);
    }
  }
  return events;
}

function collectCodexDirectEditCallIds(
  entries: readonly CodexSessionEntry[],
): Set<string> {
  const callIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "response_item") continue;
    const payload = entry.payload;
    if (
      payload.type !== "function_call" &&
      payload.type !== "custom_tool_call"
    ) {
      continue;
    }
    const rawName = payload.name;
    if (
      typeof rawName === "string" &&
      canonicalizeCodexToolName(rawName, payload.namespace ?? undefined) ===
        "Edit"
    ) {
      const callId = getCodexResponsePayloadCallId(payload);
      if (callId) callIds.add(callId);
    }
  }
  return callIds;
}

function collectCodexImageGenerationEndKeys(
  entries: readonly CodexSessionEntry[],
): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (
      entry.type !== "event_msg" ||
      entry.payload.type !== "image_generation_end"
    ) {
      continue;
    }

    for (const key of collectCodexImageGenerationRecordKeys(
      entry.payload as Record<string, unknown>,
    )) {
      keys.add(key);
    }
  }
  return keys;
}

function collectCodexImageGenerationRecordKeys(
  record: Record<string, unknown>,
): string[] {
  const image = normalizeCodexImageGenerationRecord(record);
  const keys: string[] = [];
  if (image.id) keys.push(`id:${image.id}`);
  if (image.path) keys.push(`path:${image.path}`);
  if (image.url) keys.push(`url:${image.url}`);
  if (image.result) keys.push(`result:${image.result}`);
  return keys;
}

function hasMatchingCodexImageGenerationRecordKey(
  record: Record<string, unknown>,
  keys?: ReadonlySet<string>,
): boolean {
  if (!keys?.size) return false;
  return collectCodexImageGenerationRecordKeys(record).some((key) =>
    keys.has(key),
  );
}

function convertCodexItemCompletedImageGeneration(
  entry: CodexEventMsgEntry,
  anchor: string,
  responseItemImageGenerationIds: ReadonlySet<string>,
): Message[] | null {
  if (entry.payload.type !== "item_completed") {
    return null;
  }

  const item = entry.payload.item;
  if (!isRecord(item) || !isCodexImageGenerationRecord(item)) {
    return null;
  }

  const itemId = getFirstString(item.id);
  if (itemId && responseItemImageGenerationIds.has(itemId)) {
    return null;
  }

  return convertCodexImageGenerationRecord(
    item,
    `codex-event-${anchor}`,
    entry.timestamp,
  );
}

function convertCodexImageGenerationEndEvent(
  entry: CodexEventMsgEntry,
  anchor: string,
): Message[] | null {
  if (entry.payload.type !== "image_generation_end") {
    return null;
  }

  return convertCodexImageGenerationRecord(
    entry.payload as Record<string, unknown>,
    `codex-event-${anchor}`,
    entry.timestamp,
  );
}

function convertCodexPatchApplyEndEvent(
  entry: CodexEventMsgEntry,
  anchor: string,
  includeToolUse = true,
): Message[] | null {
  if (entry.payload.type !== "patch_apply_end") {
    return null;
  }

  const payload = entry.payload;
  const changes = normalizeCodexFileChanges(payload.changes);
  const status = normalizeCodexFileChangeStatus(
    payload.status,
    payload.success,
  );
  const isError = isCodexFileChangeError(status);
  const stdout = payload.stdout?.trim() ?? "";
  const stderr = payload.stderr?.trim() ?? "";
  const fallbackResult = formatCodexFileChangeResult(changes, status);
  const resultText = isError
    ? [stderr, stdout].filter(Boolean).join("\n") || fallbackResult
    : stdout || stderr || fallbackResult;
  const uuid = `codex-${anchor}-patch`;

  const toolUseMessage: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: payload.call_id,
          name: "Edit",
          input: buildCodexEditInput(changes),
          status: isError ? "error" : "completed",
        },
      ],
    },
    codexToolName: "apply_patch",
    timestamp: entry.timestamp,
  };
  const toolResultMessage: Message = {
    uuid: `${uuid}-result`,
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: payload.call_id,
          content: resultText,
          ...(isError && { is_error: true }),
        },
      ],
    },
    timestamp: entry.timestamp,
  };

  return includeToolUse
    ? [toolUseMessage, toolResultMessage]
    : [toolResultMessage];
}

function convertCodexResponseItem(
  entry: CodexResponseItemEntry,
  anchor: string,
  toolCallContexts: Map<string, CodexToolCallContext>,
  externalToolCalls: PendingExternalCodexToolCall[],
  options: {
    skippedImageGenerationCallKeys?: ReadonlySet<string>;
    patchApplyEndByCallId?: ReadonlyMap<string, CodexPatchApplyEndEvent>;
    skippedPatchApplyCallIds?: ReadonlySet<string>;
  } = {},
): Message | Message[] | null {
  const payload = entry.payload;
  const uuid = `codex-${anchor}`;

  switch (payload.type) {
    case "message":
      if (payload.role === "developer") {
        return null;
      }
      return convertCodexMessagePayload(
        payload,
        uuid,
        entry.timestamp,
        externalToolCalls,
      );

    case "reasoning":
      return convertCodexReasoningPayload(payload, uuid, entry.timestamp);

    case "function_call": {
      const converted = convertCodexFunctionCallPayload(
        payload,
        uuid,
        entry.timestamp,
      );
      enrichCodexEditConversionWithPatchEvent(
        converted,
        options.patchApplyEndByCallId?.get(converted.callId),
      );
      toolCallContexts.set(converted.callId, converted.context);
      return converted.message;
    }

    case "function_call_output":
      if (
        options.patchApplyEndByCallId?.has(payload.call_id) ||
        options.skippedPatchApplyCallIds?.has(payload.call_id)
      ) {
        return null;
      }
      return convertCodexToolCallOutputPayload(
        payload.call_id,
        payload.output,
        uuid,
        entry.timestamp,
        toolCallContexts.get(payload.call_id),
      );

    case "custom_tool_call": {
      const converted = convertCodexCustomToolCallPayload(
        payload,
        uuid,
        entry.timestamp,
      );
      enrichCodexEditConversionWithPatchEvent(
        converted,
        options.patchApplyEndByCallId?.get(converted.callId),
      );
      toolCallContexts.set(converted.callId, converted.context);
      return converted.message;
    }

    case "custom_tool_call_output": {
      const customCallId = payload.call_id ?? `${uuid}-custom-tool-result`;
      if (
        options.patchApplyEndByCallId?.has(customCallId) ||
        options.skippedPatchApplyCallIds?.has(customCallId)
      ) {
        return null;
      }
      return convertCodexToolCallOutputPayload(
        customCallId,
        payload.output,
        uuid,
        entry.timestamp,
        toolCallContexts.get(customCallId),
      );
    }

    case "web_search_call":
      return convertCodexWebSearchCallPayload(payload, uuid, entry.timestamp);

    case "image_generation":
    case "imageGeneration":
    case "image_generation_call":
      if (
        payload.type === "image_generation_call" &&
        hasMatchingCodexImageGenerationRecordKey(
          payload as Record<string, unknown>,
          options.skippedImageGenerationCallKeys,
        )
      ) {
        return null;
      }
      return convertCodexImageGenerationPayload(payload, uuid, entry.timestamp);

    case "ghost_snapshot":
      return null;

    default:
      return null;
  }
}

function enrichCodexEditConversionWithPatchEvent(
  conversion: CodexToolUseConversion,
  event: CodexPatchApplyEndEvent | undefined,
): void {
  if (!event || conversion.context.toolName !== "Edit") return;

  const changes = normalizeCodexFileChanges(event.changes);
  if (changes.length === 0) return;

  const editInput = buildCodexEditInput(changes);
  const currentInput = conversion.context.input;
  const mergedInput = isRecord(currentInput)
    ? { ...currentInput, ...editInput }
    : {
        ...(currentInput !== undefined ? { input: currentInput } : {}),
        ...editInput,
      };
  conversion.context.input = mergedInput;

  const content = conversion.message.message?.content;
  if (!Array.isArray(content)) return;
  const toolUse = content.find(
    (block) =>
      block.type === "tool_use" &&
      block.id === conversion.callId &&
      block.name === "Edit",
  );
  if (toolUse) {
    toolUse.input = mergedInput;
  }
}

function convertCodexImageGenerationPayload(
  payload: CodexImageGenerationPayload,
  uuid: string,
  timestamp: string,
): Message[] {
  return convertCodexImageGenerationRecord(
    payload as Record<string, unknown>,
    uuid,
    timestamp,
  );
}

function convertCodexImageGenerationRecord(
  record: Record<string, unknown>,
  uuid: string,
  timestamp: string,
): Message[] {
  const image = normalizeCodexImageGenerationRecord(record);
  const callId = image.id ?? `${uuid}-image-generation`;

  const input: Record<string, unknown> = {
    title: "Generated image",
    ...(image.path ? { path: image.path } : {}),
    ...(image.url ? { url: image.url } : {}),
    ...(image.status ? { status: image.status } : {}),
    ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
    ...(!image.path && !image.url && image.result
      ? { result: summarizeCodexImageGenerationResult(image.result) }
      : {}),
  };

  const toolUseMessage: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: callId,
          name: "ViewImage",
          input,
        },
      ],
    },
    codexToolName: "imageGeneration",
    timestamp,
  };

  const toolResult: ContentBlock = {
    type: "tool_result",
    tool_use_id: callId,
    content: buildCodexImageGenerationResultText({
      path: image.path,
      url: image.url,
      status: image.status,
      result: image.result,
    }),
  };

  return [
    toolUseMessage,
    {
      uuid: `${uuid}-result`,
      type: "user",
      message: {
        role: "user",
        content: [toolResult],
      },
      toolUseResult: {
        type: "image",
        ...(image.path ? { path: image.path } : {}),
        ...(image.url ? { url: image.url } : {}),
        ...(image.status ? { status: image.status } : {}),
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
      },
      timestamp,
    },
  ];
}

function convertCodexMessagePayload(
  payload: CodexMessagePayload,
  uuid: string,
  timestamp: string,
  externalToolCalls: PendingExternalCodexToolCall[],
): Message | null {
  const codexMessagePhase =
    payload.role === "assistant"
      ? normalizeCodexMessagePhase(payload.phase)
      : undefined;

  if (payload.role === "assistant") {
    const externalToolMessage = convertExternalAgentToolMarkerPayload(
      payload,
      uuid,
      timestamp,
      externalToolCalls,
    );
    if (externalToolMessage) {
      return externalToolMessage;
    }
  }

  const content: ContentBlock[] = [];

  const fullText = payload.content
    .map((block) =>
      "text" in block && typeof block.text === "string" ? block.text : "",
    )
    // Codex emits local-media labels as separate input_text items around the
    // input_image/input_audio item. Keep those user-input boundaries so a
    // preceding managed-upload line cannot absorb the next media marker into
    // its private path during public projection. Assistant output fragments
    // remain byte-for-byte concatenated.
    .join(payload.role === "user" ? "\n" : "");

  if (
    payload.role === "user" &&
    fullText.trim() &&
    isCodexTurnAbortedNoticeText(fullText)
  ) {
    return null;
  }

  if (fullText.trim()) {
    content.push({
      type: "text",
      text: fullText,
    });
  }

  for (const block of payload.content) {
    if (block.type === "input_image") {
      content.push(normalizeCodexInputImageBlock(block));
    } else if (block.type === "input_audio") {
      content.push(normalizeCodexInputAudioBlock(block));
    }
  }

  if (content.length === 0) {
    return {
      uuid,
      type: payload.role,
      ...(codexMessagePhase ? { codexMessagePhase } : {}),
      message: {
        role: payload.role,
        content: [],
      },
      timestamp,
    };
  }

  return {
    uuid,
    type: payload.role,
    ...(codexMessagePhase ? { codexMessagePhase } : {}),
    message: {
      role: payload.role,
      content,
    },
    timestamp,
  };
}

function normalizeCodexMessagePhase(
  phase: CodexMessagePhase,
): "commentary" | "final_answer" | undefined {
  return phase === "commentary" || phase === "final_answer" ? phase : undefined;
}

function convertCodexReasoningPayload(
  payload: CodexReasoningPayload,
  uuid: string,
  timestamp: string,
): Message | null {
  const summaryText = payload.summary
    ?.map((s) => s.text)
    .join("\n")
    .trim();

  if (!summaryText) {
    return null;
  }

  return {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: summaryText,
        },
      ],
    },
    timestamp,
  };
}

type CodexInputImageBlock = Extract<
  CodexMessagePayload["content"][number],
  { type: "input_image" }
>;

type CodexInputAudioBlock = Extract<
  CodexMessagePayload["content"][number],
  { type: "input_audio" }
>;

function normalizeCodexInputImageBlock(
  block: CodexInputImageBlock,
): ContentBlock {
  const normalized: ContentBlock = { type: "input_image" };

  const filePath =
    typeof block.file_path === "string" ? block.file_path.trim() : "";
  if (filePath) {
    normalized.file_path = filePath;
  }

  const mimeType = resolveCodexInputImageMimeType(block);
  if (mimeType) {
    normalized.mime_type = mimeType;
  }

  const imageUrl =
    typeof block.image_url === "string" ? block.image_url.trim() : "";
  if (imageUrl) {
    normalized.image_url = imageUrl;
  }

  return normalized;
}

function normalizeCodexInputAudioBlock(
  block: CodexInputAudioBlock,
): ContentBlock {
  const normalized: ContentBlock = { type: "input_audio" };
  const filePath =
    typeof block.file_path === "string" ? block.file_path.trim() : "";
  if (filePath) {
    normalized.file_path = filePath;
  }

  const audioUrl =
    typeof block.audio_url === "string" ? block.audio_url.trim() : "";
  if (audioUrl) {
    normalized.audio_url = audioUrl;
  }

  const mimeType =
    sanitizePublicMimeType(block.mime_type) ??
    (audioUrl ? parseDataUrlMimeType(audioUrl) : undefined);
  if (mimeType) {
    normalized.mime_type = mimeType;
  }
  return normalized;
}

function resolveCodexInputImageMimeType(
  block: CodexInputImageBlock,
): string | undefined {
  const explicitMime =
    typeof block.mime_type === "string" ? block.mime_type.trim() : "";
  if (explicitMime) {
    return explicitMime;
  }

  if (typeof block.image_url !== "string") {
    return undefined;
  }

  const dataUrlMime = parseDataUrlMimeType(block.image_url);
  return dataUrlMime || undefined;
}

function parseDataUrlMimeType(dataUrl: string): string | null {
  const match = /^data:([^;,]+)[;,]/i.exec(dataUrl);
  return match?.[1] ?? null;
}

function convertExternalAgentToolMarkerPayload(
  payload: CodexMessagePayload,
  uuid: string,
  timestamp: string,
  externalToolCalls: PendingExternalCodexToolCall[],
): Message | null {
  const text = payload.content
    .map((block) =>
      "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .join("");

  const toolCall = parseExternalAgentToolCallText(text);
  if (toolCall) {
    const converted = convertExternalAgentToolCall(toolCall, uuid, timestamp);
    externalToolCalls.push({
      callId: converted.callId,
      context: converted.context,
    });
    return converted.message;
  }

  const toolResult = parseExternalAgentToolResultText(text);
  if (!toolResult) {
    return null;
  }

  const pendingCall = externalToolCalls.shift();
  if (!pendingCall) {
    return null;
  }

  return convertCodexToolCallOutputPayload(
    pendingCall.callId,
    toolResult.output,
    uuid,
    timestamp,
    pendingCall.context,
    toolResult.isError,
  );
}

function parseExternalAgentToolCallText(
  text: string,
): { toolName: string; input: unknown } | null {
  const match =
    /^\[external_agent_tool_call:\s*([^\]\n]+)\]\n?([\s\S]*?)\n?\[\/external_agent_tool_call\]$/.exec(
      text.trim(),
    );
  if (!match?.[1]) {
    return null;
  }

  return {
    toolName: match[1].trim(),
    input: parseExternalAgentToolInput(match[2] ?? ""),
  };
}

function parseExternalAgentToolResultText(
  text: string,
): { output: string; isError: boolean } | null {
  const match =
    /^\[external_agent_tool_result(?::\s*([^\]\n]+))?\]\n?([\s\S]*?)\n?\[\/external_agent_tool_result\]$/.exec(
      text.trim(),
    );
  if (!match) {
    return null;
  }

  const status = match[1]?.trim().toLowerCase();
  return {
    output: match[2] ?? "",
    isError: status === "error",
  };
}

function parseExternalAgentToolInput(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) {
    return {};
  }

  const inputMatch = /^input:\s*([\s\S]*)$/.exec(trimmed);
  if (inputMatch?.[1]) {
    return parseExternalAgentToolValue(inputMatch[1].trim());
  }

  const lines = trimmed.split("\n");
  const input: Record<string, unknown> = {};
  let sawField = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fieldMatch = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!fieldMatch?.[1]) {
      continue;
    }

    sawField = true;
    const key = normalizeExternalAgentToolInputKey(fieldMatch[1]);
    const value = fieldMatch[2] ?? "";

    if (key === "command") {
      input.command = [value, ...lines.slice(i + 1)].join("\n").trimEnd();
      break;
    }

    input[key] = parseExternalAgentToolValue(value.trim());
  }

  return sawField ? input : { content: trimmed };
}

function normalizeExternalAgentToolInputKey(key: string): string {
  const normalized = key.trim();
  if (normalized === "file" || normalized === "path") {
    return "file_path";
  }
  return normalized;
}

function parseExternalAgentToolValue(value: string): unknown {
  if (!value) {
    return "";
  }

  if (/^(?:\{|\[|"|-?\d|true$|false$|null$)/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}

function convertExternalAgentToolCall(
  marker: { toolName: string; input: unknown },
  uuid: string,
  timestamp: string,
): CodexToolUseConversion {
  const rawToolName = marker.toolName;
  const canonicalToolName = canonicalizeCodexToolName(rawToolName);
  const normalizedInvocation = normalizeCodexToolInvocation(
    canonicalToolName,
    marker.input,
  );
  const callId = `${uuid}-external-tool`;

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: callId,
      name: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
    },
  ];
  appendNestedCodexPlanBlock(content, callId, {
    toolName: normalizedInvocation.toolName,
    input: normalizedInvocation.input,
  });

  const message: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    timestamp,
  };

  return {
    callId,
    message,
    context: {
      toolName: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      readShellInfo: normalizedInvocation.readShellInfo,
      writeShellInfo: normalizedInvocation.writeShellInfo,
    },
  };
}

function convertCodexFunctionCallPayload(
  payload: CodexFunctionCallPayload,
  uuid: string,
  timestamp: string,
): CodexToolUseConversion {
  const rawToolName = payload.name;
  const parsedInput = parseCodexToolArguments(payload.arguments);
  const normalizedInvocation =
    deriveCodexWebRunInvocation(
      rawToolName,
      payload.namespace ?? undefined,
      parsedInput,
    ) ??
    normalizeCodexToolInvocation(
      canonicalizeCodexToolName(rawToolName),
      parsedInput,
    );

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: payload.call_id,
      name: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
    },
  ];
  appendNestedCodexPlanBlock(content, payload.call_id, {
    toolName: normalizedInvocation.toolName,
    input: normalizedInvocation.input,
  });

  const message: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    timestamp,
  };

  return {
    callId: payload.call_id,
    message,
    context: {
      toolName: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      readShellInfo: normalizedInvocation.readShellInfo,
      writeShellInfo: normalizedInvocation.writeShellInfo,
    },
  };
}

function convertCodexCustomToolCallPayload(
  payload: CodexCustomToolCallPayload,
  uuid: string,
  timestamp: string,
): CodexToolUseConversion {
  const callId = payload.call_id ?? payload.id ?? `${uuid}-custom-tool`;
  const rawToolName = payload.name ?? "custom_tool_call";
  const canonicalToolName = canonicalizeCodexToolName(
    rawToolName,
    payload.namespace,
  );
  const rawInput =
    payload.input !== undefined
      ? payload.input
      : parseCodexToolArguments(payload.arguments);
  const normalizedInvocation = normalizeCodexToolInvocation(
    canonicalToolName,
    rawInput,
  );

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: callId,
      name: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
    },
  ];
  appendNestedCodexPlanBlock(content, callId, {
    toolName: normalizedInvocation.toolName,
    input: normalizedInvocation.input,
  });

  const message: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    ...(payload.namespace ? { codexToolNamespace: payload.namespace } : {}),
    timestamp,
  };

  return {
    callId,
    message,
    context: {
      toolName: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      readShellInfo: normalizedInvocation.readShellInfo,
      writeShellInfo: normalizedInvocation.writeShellInfo,
    },
  };
}

function convertCodexWebSearchCallPayload(
  payload: CodexWebSearchCallPayload,
  uuid: string,
  timestamp: string,
): Message[] {
  const callId = payload.call_id ?? payload.id ?? `${uuid}-web-search`;
  const rawToolName = payload.name ?? payload.type;
  const toolName = canonicalizeCodexToolName(rawToolName);
  const payloadRecord = payload as Record<string, unknown>;
  const status =
    typeof payloadRecord.status === "string" ? payloadRecord.status : undefined;

  const parsedArguments = parseCodexToolArguments(payload.arguments);
  let input: Record<string, unknown>;

  if (isRecord(payload.input)) {
    input = { ...payload.input };
  } else if (isRecord(parsedArguments)) {
    input = { ...parsedArguments };
  } else {
    input = {};
  }

  if (typeof payload.query === "string" && typeof input.query !== "string") {
    input.query = payload.query;
  }

  if (payload.action !== undefined && input.action === undefined) {
    input.action = payload.action;
  }
  const actionSummary = summarizeCodexWebSearchAction(payload.action);
  if (typeof input.query !== "string" && actionSummary.query) {
    input.query = actionSummary.query;
  }
  if (actionSummary.label && typeof input.query !== "string") {
    input.query = actionSummary.label;
  }

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: callId,
      name: toolName,
      input,
    },
  ];

  const toolUseMessage: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    timestamp,
  };

  if (status !== "completed" && status !== "complete") {
    return [toolUseMessage];
  }

  const query =
    typeof input.query === "string" && input.query.trim()
      ? input.query
      : actionSummary.label || "Codex web search";
  const result = {
    query,
    results: [],
    codexActionLabel: actionSummary.label,
    codexAction: payload.action,
  };
  const toolResult: ContentBlock = {
    type: "tool_result",
    tool_use_id: callId,
    content: actionSummary.label
      ? `Codex web search completed: ${actionSummary.label}`
      : "Codex web search completed",
  };

  return [
    toolUseMessage,
    {
      uuid: `${uuid}-result`,
      type: "user",
      message: {
        role: "user",
        content: [toolResult],
      },
      toolUseResult: result,
      timestamp,
    },
  ];
}

function summarizeCodexWebSearchAction(action: unknown): {
  label?: string;
  query?: string;
} {
  if (!isRecord(action)) {
    return {};
  }

  const actionType =
    typeof action.type === "string" && action.type.trim()
      ? action.type.trim()
      : undefined;

  if (actionType === "search") {
    const query = getFirstString(
      action.query,
      Array.isArray(action.queries) ? action.queries[0] : undefined,
    );
    return {
      ...(query ? { query } : {}),
      label: query ? `Search: ${query}` : "Search",
    };
  }

  if (actionType === "open_page" || actionType === "openPage") {
    const url = getFirstString(action.url);
    return {
      ...(url ? { query: url } : {}),
      label: url ? `Open page: ${url}` : "Open page",
    };
  }

  if (actionType === "find_in_page" || actionType === "findInPage") {
    const pattern = getFirstString(action.pattern);
    const url = getFirstString(action.url);
    const target = [pattern, url].filter(Boolean).join(" @ ");
    return {
      ...(target ? { query: target } : {}),
      label: target ? `Find in page: ${target}` : "Find in page",
    };
  }

  return actionType ? { label: actionType } : {};
}

function getFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function convertCodexToolCallOutputPayload(
  callId: string,
  output: unknown,
  uuid: string,
  timestamp: string,
  context?: CodexToolCallContext,
  forceError = false,
): Message {
  const normalized = normalizeCodexToolOutputWithContext(output, context);
  const content = normalized.content;
  const structured = normalized.structured;
  const isError = forceError || normalized.isError;

  const toolResult: ContentBlock = {
    type: "tool_result",
    tool_use_id: callId,
    content,
    ...(isError && { is_error: true }),
  };

  return {
    uuid,
    type: "user",
    message: {
      role: "user",
      content: [toolResult],
    },
    ...(structured !== undefined && {
      toolUseResult: structured,
    }),
    timestamp,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function convertCodexCompactedEntry(
  entry: CodexCompactedEntry,
  anchor: string,
): Message {
  const uuid = `codex-compacted-${anchor}`;
  return {
    uuid,
    type: "system",
    subtype: "compact_boundary",
    content: entry.payload.message || "Context compacted",
    timestamp: entry.timestamp,
  };
}

function convertCodexEventMsg(
  entry: CodexEventMsgEntry,
  anchor: string,
): Message | null {
  const payload = entry.payload;
  const uuid = `codex-event-${anchor}`;

  switch (payload.type) {
    case "user_message":
      return {
        uuid,
        type: "user",
        message: {
          role: "user",
          content: payload.message,
        },
        timestamp: entry.timestamp,
      };

    case "agent_message":
      return {
        uuid,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: payload.message }],
        },
        timestamp: entry.timestamp,
      };

    case "agent_reasoning":
      return {
        uuid,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: payload.text }],
        },
        timestamp: entry.timestamp,
      };

    case "turn_aborted":
      return {
        uuid,
        type: "system",
        subtype: "turn_aborted",
        content: CODEX_TURN_ABORTED_DISPLAY_TEXT,
        timestamp: entry.timestamp,
      };

    case "context_compacted":
      return {
        uuid,
        type: "system",
        subtype: "compact_boundary",
        content: "Context compacted",
        timestamp: entry.timestamp,
      };

    case "item_completed":
      return null;

    default:
      return null;
  }
}

// --- Gemini Conversion Logic ---

function convertGeminiMessages(
  sessionMessages: GeminiSessionMessage[],
): Message[] {
  const messages: Message[] = [];
  for (const msg of sessionMessages) {
    if (msg.type === "user") {
      const userMsg = msg as GeminiUserMessage;
      messages.push({
        uuid: userMsg.id,
        type: "user",
        message: {
          role: "user",
          content: getGeminiUserMessageText(userMsg.content),
        },
        timestamp: userMsg.timestamp,
      });
    } else if (msg.type === "gemini") {
      const assistantMsg = msg as GeminiAssistantMessage;
      const content: ContentBlock[] = [];

      if (assistantMsg.thoughts) {
        for (const thought of assistantMsg.thoughts) {
          content.push({
            type: "thinking",
            thinking: `${thought.subject}: ${thought.description}`,
          });
        }
      }

      if (assistantMsg.content) {
        content.push({
          type: "text",
          text: assistantMsg.content,
        });
      }

      if (assistantMsg.toolCalls) {
        for (const toolCall of assistantMsg.toolCalls) {
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.args,
          });
        }
      }

      messages.push({
        uuid: assistantMsg.id,
        type: "assistant",
        message: {
          role: "assistant",
          content,
        },
        timestamp: assistantMsg.timestamp,
      });

      if (assistantMsg.toolCalls) {
        for (const toolCall of assistantMsg.toolCalls) {
          if (toolCall.result && toolCall.result.length > 0) {
            for (const result of toolCall.result) {
              messages.push({
                uuid: `${assistantMsg.id}-result-${result.functionResponse.id}`,
                type: "tool_result",
                toolUseResult: {
                  tool_use_id: result.functionResponse.id,
                  content: result.functionResponse.response.output,
                },
                timestamp: toolCall.timestamp ?? assistantMsg.timestamp,
              });
            }
          }
        }
      }
    }
  }
  return messages;
}

/**
 * Build the normalized content for one Kimi user turn.
 *
 * Text-only turns stay a plain string (the common case, and what the client's
 * prompt parser expects). When the turn carried images, they are emitted as
 * `input_image` blocks — the same shape Codex uses, so the client renders them
 * as attachment chips with an inline preview without provider-specific code.
 *
 * `blobref:` parts are served through `/api/local-image`; the blobs directory
 * is allow-listed alongside yep's own uploads. `data:` urls are passed straight
 * through as the preview source.
 */
function buildKimiUserContent(
  input: readonly unknown[],
  blobsDir: string | undefined,
): string | ContentBlock[] {
  const text = getKimiPromptText(input);
  const images = getKimiPromptImages(input);
  if (images.length === 0) return text;

  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: "text", text } as ContentBlock);

  for (const image of images) {
    const block: Record<string, unknown> = {
      type: "input_image",
      mime_type: image.mimeType,
    };
    if (image.blobHash && blobsDir) {
      const path = join(blobsDir, image.blobHash);
      block.file_path = path;
      block.image_url = `/api/local-image?path=${encodeURIComponent(path)}`;
    } else if (!image.blobHash) {
      block.image_url = image.url;
    }
    blocks.push(block as ContentBlock);
  }

  return blocks;
}

// --- Kimi Conversion Logic ---

/**
 * Convert a parsed Kimi session (wire.jsonl records) into normalized messages.
 *
 * Reconstruction uses `turn.prompt` for user turns and `context.append_loop_event`
 * for the assistant stream (content.part think/text, tool.call, tool.result).
 * `context.append_message` records are ignored — they are the post-compaction
 * context-memory projection and would double-count tool results as user turns.
 */
export function convertKimiMessages(session: KimiSessionContent): Message[] {
  const messages: Message[] = [];
  const sid = session.sessionId;

  let assistantBlocks: ContentBlock[] = [];
  let assistantTs: number | undefined;
  let assistantSeq = 0;
  let userSeq = 0;
  let lastStepEnd: KimiStepEndEvent | undefined;

  const appendAssistantPart = (
    part:
      | { type: "thinking"; thinking: string }
      | { type: "text"; text: string },
  ) => {
    const previous = assistantBlocks[assistantBlocks.length - 1];
    if (
      part.type === "thinking" &&
      previous?.type === "thinking" &&
      typeof previous.thinking === "string"
    ) {
      previous.thinking += part.thinking;
      return;
    }
    if (
      part.type === "text" &&
      previous?.type === "text" &&
      typeof previous.text === "string"
    ) {
      previous.text += part.text;
      return;
    }
    assistantBlocks.push(part);
  };

  const toIso = (ms: number | undefined): string | undefined =>
    typeof ms === "number" ? new Date(ms).toISOString() : session.createdAt;

  const flushAssistant = () => {
    if (assistantBlocks.length === 0) return;
    messages.push({
      uuid: `${sid}-assistant-${assistantSeq++}`,
      type: "assistant",
      message: { role: "assistant", content: assistantBlocks },
      timestamp: toIso(assistantTs),
    });
    assistantBlocks = [];
    assistantTs = undefined;
  };

  const appendTurnError = (record: KimiTurnEndedRecord) => {
    const error = record.error;
    if (!error) return;
    const errorText =
      error.message?.trim() ||
      (error.code === "provider.filtered"
        ? "Provider safety policy blocked the response."
        : error.name || error.code);
    if (!errorText) return;

    flushAssistant();
    const turnKey =
      record.turnId === undefined
        ? `${userSeq}-${messages.length}`
        : String(record.turnId);
    messages.push({
      uuid: `${sid}-turn-${turnKey}-error`,
      type: "error",
      error: errorText,
      content: errorText,
      errorCode: error.code,
      retryable: error.retryable,
      finishReason: lastStepEnd?.finishReason,
      providerFinishReason: lastStepEnd?.providerFinishReason,
      rawFinishReason: lastStepEnd?.rawFinishReason,
      timestamp: toIso(record.time),
    });
  };

  for (const record of session.records) {
    if (isKimiTurnPromptRecord(record)) {
      flushAssistant();
      lastStepEnd = undefined;
      messages.push({
        uuid: `${sid}-user-${userSeq++}`,
        type: "user",
        message: {
          role: "user",
          content: buildKimiUserContent(record.input, session.blobsDir),
        },
        timestamp: toIso(record.time),
      });
      continue;
    }

    if (isKimiTurnEndedRecord(record)) {
      appendTurnError(record);
      continue;
    }

    if (!isKimiLoopEventRecord(record)) continue;

    const event = record.event;
    switch (event.type) {
      case "content.part": {
        const part = (event as KimiContentPartEvent).part;
        if (part.type === "think") {
          appendAssistantPart({ type: "thinking", thinking: part.think });
        } else if (part.type === "text") {
          appendAssistantPart({ type: "text", text: part.text });
        }
        assistantTs ??= record.time;
        break;
      }
      case "tool.call": {
        const toolCall = event as KimiToolCallEvent;
        assistantBlocks.push({
          type: "tool_use",
          id: toolCall.toolCallId,
          name: toolCall.name,
          input: normalizeKimiToolInput(toolCall.name, toolCall.args),
        });
        assistantTs ??= record.time;
        break;
      }
      case "tool.result": {
        // Flush the assistant message (carrying the tool_use blocks) before
        // emitting the corresponding tool results.
        flushAssistant();
        const toolResult = event as KimiToolResultEvent;
        const output =
          toolResult.result?.output ?? toolResult.result?.note ?? "";
        const toolUseId = toolResult.toolCallId ?? "";
        messages.push({
          uuid: `${sid}-result-${toolResult.toolCallId ?? `${assistantSeq}-${messages.length}`}`,
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                content: output,
                ...(toolResult.result?.isError === true && { is_error: true }),
              },
            ],
          },
          timestamp: toIso(record.time),
        });
        break;
      }
      case "step.end": {
        lastStepEnd = event as KimiStepEndEvent;
        break;
      }
      default:
        break;
    }
  }

  flushAssistant();

  // Replay the main-agent goal lifecycle (goal.create / goal.update /
  // goal.clear / forked) and merge the snapshots into the transcript as
  // inline `type: "kimi_goal"` messages, placed at their record timestamps.
  // Goals are main-agent autonomous targets with budgets; surfacing them
  // inline lets the UI show what the agent was pursuing (and how much budget
  // it consumed) at each point in the transcript. Child-agent wires typically
  // have no goal.* records, so this is a no-op there.
  return mergeKimiGoalSnapshots(
    messages,
    getKimiGoalTimeline(session.records),
    sid,
  );
}

/**
 * Merge goal snapshots into a transcript as inline `type: "kimi_goal"` messages.
 *
 * Each snapshot becomes a message whose `goal` payload (objective, status,
 * budget consumption, actor, change kind) is read by the client
 * `GoalInlineRenderer`. Snapshots are placed by their `time` field: a snapshot
 * lands after the last existing message with a timestamp ≤ the snapshot's
 * time. Snapshots without a time are appended in order. This keeps the goal
 * markers interleaved with the turns that produced them, so the UI can show
 * "goal created → assistant worked → goal blocked → …" in context.
 */
function mergeKimiGoalSnapshots(
  messages: Message[],
  snapshots: readonly import("@yep-anywhere/shared").KimiGoalSnapshot[],
  sessionId: string,
): Message[] {
  if (snapshots.length === 0) return messages;

  const goalMessages: Message[] = snapshots.map((snapshot, index) => {
    const message: Message = {
      type: "kimi_goal",
      uuid: `${sessionId}-goal-${index}`,
      goal: snapshot,
      ...(snapshot.time !== undefined
        ? { timestamp: new Date(snapshot.time).toISOString() }
        : {}),
    };
    return message;
  });

  // Stable merge by timestamp: existing messages keep their order, goal
  // messages slot in by time. Messages without timestamps go to the end.
  const result: Message[] = [];
  let gi = 0;
  const messageTime = (message: Message | undefined): number => {
    if (!message?.timestamp) return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(message.timestamp);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  const goalTime = (message: Message): number => {
    const snapshot = message.goal as { time?: number };
    return snapshot.time ?? Number.POSITIVE_INFINITY;
  };

  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if (!msg) continue;
    const msgTime = messageTime(msg);
    while (gi < goalMessages.length) {
      const goal = goalMessages[gi];
      if (!goal) break;
      if (goalTime(goal) < msgTime) {
        result.push(goal);
        gi += 1;
      } else {
        break;
      }
    }
    result.push(msg);

    // Equal timestamps stay stable: every existing transcript message at the
    // timestamp is emitted before goal markers at that same timestamp.
    if (messageTime(messages[index + 1]) !== msgTime) {
      while (gi < goalMessages.length) {
        const goal = goalMessages[gi];
        if (!goal || goalTime(goal) > msgTime) break;
        result.push(goal);
        gi += 1;
      }
    }
  }
  // Append any remaining goal snapshots.
  while (gi < goalMessages.length) {
    const goal = goalMessages[gi];
    if (goal) result.push(goal);
    gi += 1;
  }
  return result;
}

// --- ZCode Conversion Logic ---

/**
 * Convert a persisted ZCode session into normalized Messages.
 * Full implementation: maps stored messages to Message objects with text,
 * reasoning (thinking), and tool (tool_use + tool_result) parts.
 * Unknown part types are safely ignored.
 */
export function convertZCodeMessages(session: ZCodeSessionContent): Message[] {
  const messages: Message[] = [];
  const sid = session.sessionId;

  for (const stored of session.messages) {
    const role = stored.role === "user" ? "user" : "assistant";
    const blocks: ContentBlock[] = [];
    const toolResults: Array<{
      toolUseId: string;
      content: string;
      isError: boolean;
    }> = [];

    for (const part of stored.parts) {
      const partType = part?.type;
      if (typeof partType !== "string") continue;

      switch (partType) {
        case "text": {
          const text = typeof part.text === "string" ? part.text : "";
          if (text) {
            blocks.push({ type: "text", text });
          }
          break;
        }
        case "reasoning": {
          const thinking = typeof part.text === "string" ? part.text : "";
          if (thinking) {
            blocks.push({ type: "thinking", thinking });
          }
          break;
        }
        case "tool": {
          const callId =
            typeof part.callID === "string" ? part.callID : part.id;
          const toolName =
            typeof part.tool === "string" ? part.tool : "Unknown";
          const state = part.state as Record<string, unknown> | undefined;
          const status =
            typeof state?.status === "string" ? state.status : "pending";
          const input = state?.input;
          const output = state?.output;
          const isError = status === "error";

          // Emit tool_use block.
          blocks.push({
            type: "tool_use",
            id: callId,
            name: toolName,
            input: input ?? {},
            status,
          });

          // Emit tool_result if completed or error.
          if (status === "completed" || status === "error") {
            toolResults.push({
              toolUseId: callId,
              content:
                typeof output === "string"
                  ? output
                  : JSON.stringify(output ?? ""),
              isError,
            });
          }
          break;
        }
        case "step-start":
        case "step-finish":
        case "timeline":
        case "file":
        case "snapshot":
        case "patch":
        case "compaction":
        case "retry":
        case "agent":
        case "subagent":
          // Metadata-only parts — no transcript content in P2.
          break;
        default:
          // Unknown part type — safely ignored.
          break;
      }
    }

    // Emit assistant message with content blocks.
    if (blocks.length > 0) {
      messages.push({
        type: role,
        uuid: stored.id,
        session_id: sid,
        ...(typeof stored.createdAt === "number"
          ? { timestamp: new Date(stored.createdAt).toISOString() }
          : {}),
        message: {
          role,
          content: blocks,
          ...(stored.model ? { model: stored.model } : {}),
        },
      });
    }

    // Emit tool results as separate user messages.
    for (const tr of toolResults) {
      messages.push({
        type: "user",
        session_id: sid,
        tool_use_id: tr.toolUseId,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: tr.toolUseId,
              content: tr.content,
              ...(tr.isError ? { status: "error" } : {}),
            },
          ],
        },
      });
    }
  }

  return messages;
}

// Suppress unused import — ZCodeStoredMessage is used for type safety.
void (null as unknown as ZCodeStoredMessage);
