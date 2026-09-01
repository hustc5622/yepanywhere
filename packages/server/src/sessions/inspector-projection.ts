import type { ContentBlock, Message } from "../supervisor/types.js";
import { isUserPromptMessage } from "./user-prompt-message.js";

const MAX_INSPECTOR_PATHS = 128;
const MAX_PATH_LENGTH = 4_096;
const MAX_COMMAND_LENGTH = 8_192;
const MAX_PLAN_ITEMS = 256;
const MAX_PLAN_TEXT_LENGTH = 2_048;
const MAX_NATIVE_TEXT_LENGTH = 8_192;
const MAX_SUBAGENTS = 128;

const CHECK_COMMAND_RE =
  /\b((pnpm|npm|yarn|bun)\s+(--filter\s+\S+\s+)?(run\s+)?(lint|typecheck|test(?::e2e)?|build)\b|tsc\b|vitest\b|playwright\s+test\b|biome\s+check\b)/i;

type InspectorToolStatus = "running" | "completed" | "failed";

interface ToolResultFact {
  isError: boolean;
}

/**
 * Build the body-free message subset consumed by SessionInspector.
 *
 * The result deliberately contains no tool output, patch body, source text,
 * reasoning, media, or provider-private payload. It preserves only the small
 * pieces needed to derive file/check/plan/goal/sub-agent indexes while keeping
 * existing client-side render-item helpers reusable.
 */
export function projectSessionInspectorMessages(
  messages: readonly Message[],
): Message[] {
  const resultsByToolId = collectToolResultFacts(messages);
  const projected: Message[] = [];
  let currentQuestionId: string | undefined;

  for (
    let messageIndex = 0;
    messageIndex < messages.length;
    messageIndex += 1
  ) {
    const message = messages[messageIndex];
    if (!message) continue;
    const messageId = getMessageId(message, messageIndex);

    if (isUserPromptMessage(message)) {
      currentQuestionId = messageId;
      projected.push({
        uuid: messageId,
        type: "system",
        subtype: "inspector_question_boundary",
        inspectorQuestionBoundary: true,
        inspectorNavigationMessageId: messageId,
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      });
      continue;
    }

    const nativeItem = projectNativeInspectorItem(message.codexThreadItem);
    if (
      message.type === "system" &&
      message.subtype === "codex_native_item" &&
      nativeItem
    ) {
      projected.push({
        uuid: messageId,
        type: "system",
        subtype: "codex_native_item",
        codexThreadItem: nativeItem,
        ...(message.codexThreadItemLifecycle
          ? { codexThreadItemLifecycle: message.codexThreadItemLifecycle }
          : {}),
        ...(message.codexThreadId
          ? { codexThreadId: message.codexThreadId }
          : {}),
        ...(message.codexTurnId ? { codexTurnId: message.codexTurnId } : {}),
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      });
      continue;
    }

    if (!isAssistantLikeMessage(message)) continue;

    if (
      (message.codexMessagePhase === "commentary" ||
        message.codexMessagePhase === "final_answer") &&
      hasReadableAssistantText(message)
    ) {
      projected.push({
        uuid: messageId,
        type: "assistant",
        codexMessagePhase: message.codexMessagePhase,
        ...(typeof message.codexCorrelationKey === "string"
          ? { codexCorrelationKey: message.codexCorrelationKey }
          : {}),
        message: { role: "assistant", content: "message" },
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      });
    }

    const content = getMessageContent(message);
    if (!Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex];
      if (
        !isRecord(block) ||
        block.type !== "tool_use" ||
        typeof block.id !== "string" ||
        !block.id ||
        typeof block.name !== "string" ||
        !block.name.trim()
      ) {
        continue;
      }
      const safeInput = projectInspectorToolInput(block.name, block.input);
      if (!safeInput) continue;
      const status = resolveInspectorToolStatus(
        block,
        resultsByToolId.get(block.id),
        message.orphanedToolUseIds?.includes(block.id) === true,
      );
      const toolBlock = {
        type: "tool_use" as const,
        id: block.id,
        name: block.name.trim().slice(0, 256),
        input: safeInput,
        status,
      } as ContentBlock;
      projected.push({
        // Inspector rows navigate to the owning question in the lightweight
        // timeline, where the raw assistant message itself is intentionally
        // absent until a tool group is expanded.
        uuid: `${messageId}:inspector:${blockIndex}`,
        type: "assistant",
        ...(currentQuestionId
          ? { inspectorNavigationMessageId: currentQuestionId }
          : {}),
        message: { role: "assistant", content: [toolBlock] },
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      });
    }
  }

  return projected;
}

function collectToolResultFacts(
  messages: readonly Message[],
): Map<string, ToolResultFact> {
  const facts = new Map<string, ToolResultFact>();
  for (const message of messages) {
    const content = getMessageContent(message);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        block.tool_use_id
      ) {
        facts.set(block.tool_use_id, { isError: block.is_error === true });
      }
    }
  }
  return facts;
}

function projectInspectorToolInput(
  name: string,
  input: unknown,
): Record<string, unknown> | null {
  const normalizedName = normalizeToolName(name);
  const inputRecord = isRecord(input) ? input : {};
  const projected: Record<string, unknown> = {};
  const paths = extractToolPaths(inputRecord);
  if (paths.length > 0) {
    projected.file_path = paths[0];
    if (paths.length > 1) {
      projected.changes = paths.map((path) => ({ path }));
    }
  }

  const command = extractCheckCommand(inputRecord);
  if (command) projected.command = boundedString(command, MAX_COMMAND_LENGTH);

  if (normalizedName === "updateplan") {
    const plan = projectPlanItems(inputRecord.plan, "step");
    if (plan.length > 0) projected.plan = plan;
    const explanation = boundedOptionalString(
      inputRecord.explanation,
      MAX_NATIVE_TEXT_LENGTH,
    );
    if (explanation) projected.explanation = explanation;
  } else if (normalizedName === "todowrite" || normalizedName === "todolist") {
    const todos = projectTodoItems(inputRecord.todos);
    if (todos.length > 0) projected.todos = todos;
  }

  return Object.keys(projected).length > 0 ? projected : null;
}

function projectPlanItems(value: unknown, labelKey: string) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PLAN_ITEMS).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry[labelKey] !== "string") return [];
    const label = boundedString(
      String(entry[labelKey]).trim(),
      MAX_PLAN_TEXT_LENGTH,
    );
    if (!label) return [];
    return [
      {
        [labelKey]: label,
        ...(typeof entry.status === "string"
          ? { status: boundedString(entry.status, 64) }
          : {}),
      },
    ];
  });
}

function projectTodoItems(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PLAN_ITEMS).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const content = boundedOptionalString(entry.content, MAX_PLAN_TEXT_LENGTH);
    const title = boundedOptionalString(entry.title, MAX_PLAN_TEXT_LENGTH);
    if (!content && !title) return [];
    return [
      {
        ...(content ? { content } : {}),
        ...(title ? { title } : {}),
        ...(typeof entry.status === "string"
          ? { status: boundedString(entry.status, 64) }
          : {}),
      },
    ];
  });
}

function projectNativeInspectorItem(
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "threadGoal": {
      const objective = boundedOptionalString(
        value.objective,
        MAX_NATIVE_TEXT_LENGTH,
      );
      if (!objective) return null;
      return {
        type: "threadGoal",
        objective,
        ...(typeof value.status === "string"
          ? { status: boundedString(value.status, 64) }
          : {}),
        ...finiteNumberFields(value, [
          "tokenBudget",
          "tokensUsed",
          "timeUsedSeconds",
        ]),
      };
    }
    case "turnPlan": {
      const steps = projectPlanItems(value.steps, "step");
      if (steps.length === 0) return null;
      const explanation = boundedOptionalString(
        value.explanation,
        MAX_NATIVE_TEXT_LENGTH,
      );
      return {
        type: "turnPlan",
        steps,
        ...(explanation ? { explanation } : {}),
      };
    }
    case "subAgentActivity": {
      const agentThreadId = boundedOptionalString(
        value.agentThreadId,
        MAX_PATH_LENGTH,
      );
      if (!agentThreadId) return null;
      return {
        type: "subAgentActivity",
        agentThreadId,
        ...(boundedOptionalString(value.agentPath, MAX_PATH_LENGTH)
          ? {
              agentPath: boundedOptionalString(
                value.agentPath,
                MAX_PATH_LENGTH,
              ),
            }
          : {}),
        ...(boundedOptionalString(value.kind, 64)
          ? { kind: boundedOptionalString(value.kind, 64) }
          : {}),
      };
    }
    case "collabAgentToolCall": {
      if (!isRecord(value.agentsStates)) return null;
      const agentsStates: Record<string, unknown> = {};
      for (const [threadId, rawState] of Object.entries(
        value.agentsStates,
      ).slice(0, MAX_SUBAGENTS)) {
        if (!isRecord(rawState)) continue;
        const safeThreadId = boundedString(threadId, MAX_PATH_LENGTH);
        if (!safeThreadId) continue;
        agentsStates[safeThreadId] = {
          ...(boundedOptionalString(rawState.nickname, 512)
            ? { nickname: boundedOptionalString(rawState.nickname, 512) }
            : {}),
          ...(boundedOptionalString(rawState.role, 128)
            ? { role: boundedOptionalString(rawState.role, 128) }
            : {}),
          ...(boundedOptionalString(rawState.agent_type, 128)
            ? { agent_type: boundedOptionalString(rawState.agent_type, 128) }
            : {}),
          ...(boundedOptionalString(rawState.status, 64)
            ? { status: boundedOptionalString(rawState.status, 64) }
            : {}),
        };
      }
      return Object.keys(agentsStates).length > 0
        ? { type: "collabAgentToolCall", agentsStates }
        : null;
    }
    default:
      return null;
  }
}

function finiteNumberFields(
  record: Record<string, unknown>,
  keys: string[],
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const key of keys) {
    const value = record[key];
    if (
      value === null ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      result[key] = value as number | null;
    }
  }
  return result;
}

function resolveInspectorToolStatus(
  block: Record<string, unknown>,
  result: ToolResultFact | undefined,
  orphaned: boolean,
): InspectorToolStatus {
  if (result) return result.isError ? "failed" : "completed";
  const status =
    typeof block.status === "string" ? block.status.toLowerCase() : "";
  if (["complete", "completed", "success"].includes(status)) return "completed";
  if (
    orphaned ||
    [
      "error",
      "failed",
      "aborted",
      "cancelled",
      "canceled",
      "declined",
    ].includes(status)
  ) {
    return "failed";
  }
  return "running";
}

function extractToolPaths(input: Record<string, unknown>): string[] {
  const candidates: unknown[] = [
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
    for (const change of input.changes.slice(0, MAX_INSPECTOR_PATHS)) {
      if (isRecord(change)) candidates.push(change.path);
    }
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const path = boundedString(candidate.trim(), MAX_PATH_LENGTH);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= MAX_INSPECTOR_PATHS) break;
  }
  return paths;
}

function extractCheckCommand(input: Record<string, unknown>): string | null {
  const direct = [input.command, input.cmd, input.script].find(
    (value): value is string =>
      typeof value === "string" && value.trim() !== "",
  );
  const command =
    direct ??
    (Array.isArray(input.args) &&
    input.args.every((arg) => typeof arg === "string")
      ? input.args.join(" ")
      : null);
  return command && CHECK_COMMAND_RE.test(command) ? command : null;
}

function hasReadableAssistantText(message: Message): boolean {
  const content = getMessageContent(message);
  if (typeof content === "string") return content.trim().length > 0;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim().length > 0,
    )
  );
}

function isAssistantLikeMessage(message: Message): boolean {
  const role = message.message?.role ?? message.role;
  return (
    role === "assistant" ||
    message.type === "assistant" ||
    message.type === "summary"
  );
}

function getMessageContent(message: Message): unknown {
  return message.message?.content ?? message.content;
}

function getMessageId(message: Message, index: number): string {
  return (
    message.uuid ??
    (typeof message.id === "string" ? message.id : `message:${index}`)
  );
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function boundedOptionalString(
  value: unknown,
  maxLength: number,
): string | undefined {
  return typeof value === "string"
    ? boundedString(value.trim(), maxLength) || undefined
    : undefined;
}

function boundedString(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
