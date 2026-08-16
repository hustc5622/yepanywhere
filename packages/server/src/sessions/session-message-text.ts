import {
  isIdeMetadata,
  stripBridgeMetadata,
  stripIdeMetadata,
} from "@yep-anywhere/shared";
import type { Message, Session } from "../supervisor/types.js";
import { isSyntheticUserPromptText } from "./user-prompt-classification.js";

export function getSessionMessageRole(message: Message): string | undefined {
  const nestedRole = message.message?.role;
  if (typeof nestedRole === "string") return nestedRole;
  const legacyRole = (message as { role?: unknown }).role;
  if (typeof legacyRole === "string") return legacyRole;
  return message.type;
}

export function extractSessionMessageText(message: Message): string | null {
  const content = message.message?.content ?? message.content;
  const text = extractContentText(content).trim();
  return text || null;
}

export function extractFirstUserPromptText(session: Session): string | null {
  for (const message of session.messages) {
    if (getSessionMessageRole(message) !== "user") continue;
    const text = extractSessionMessageText(message);
    if (text && !isSyntheticUserPromptText(text)) return text;
  }

  for (const candidate of [session.fullTitle, session.title]) {
    const text = candidate?.trim();
    if (text && !isSyntheticUserPromptText(text)) return text;
  }

  return null;
}

export function extractFirstAssistantResponseText(
  session: Session,
): string | null {
  let seenRealUserPrompt = false;

  for (const message of session.messages) {
    const role = getSessionMessageRole(message);
    if (role === "user") {
      const text = extractSessionMessageText(message);
      if (text && !isSyntheticUserPromptText(text)) {
        seenRealUserPrompt = true;
      }
      continue;
    }

    if (!seenRealUserPrompt || role !== "assistant") continue;
    if (!isFinalAssistantResponseMessage(session, message)) continue;
    const text = extractSessionMessageText(message);
    if (text) return text;
  }

  return null;
}

function hasOpenCodeToolPart(message: Message): boolean {
  if (
    (message as { openCodeHasToolPart?: unknown }).openCodeHasToolPart === true
  ) {
    return true;
  }

  const content = message.message?.content ?? message.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const type = (block as { type?: unknown }).type;
    return (
      typeof type === "string" &&
      (type.toLowerCase() === "tool_use" || type.toLowerCase() === "tool")
    );
  });
}

function isFinalAssistantResponseMessage(
  session: Session,
  message: Message,
): boolean {
  const messageType = message.type.toLowerCase();
  if (
    messageType === "reasoning" ||
    messageType === "thinking" ||
    messageType === "tool_use" ||
    messageType === "tool_result"
  ) {
    return false;
  }

  const codexMessagePhase = (message as { codexMessagePhase?: unknown })
    .codexMessagePhase;
  if (codexMessagePhase === "commentary") return false;
  if (codexMessagePhase === "final_answer") return true;

  if (session.provider === "opencode") {
    // OpenCode writes assistant text before executing tools, then marks that
    // intermediate message as `tool-calls`. Some providers can report `stop`
    // while also returning tool parts, and OpenCode continues the loop in that
    // case. A final response must therefore contain no tool part. Error,
    // cancellation, filtering and truncation must not trigger title generation
    // from partial text. Older persisted OpenCode messages can lack `finish`;
    // accept those only when the reader observed OpenCode's real
    // `time.completed` field.
    if (hasOpenCodeToolPart(message)) return false;
    const finish = (message as { finish?: unknown }).finish;
    if (finish === "stop") return true;
    if (finish !== undefined) return false;
    return (
      (
        message as {
          openCodeCompleted?: unknown;
        }
      ).openCodeCompleted === true
    );
  }

  if (session.provider === "pi") {
    // Pi persists one assistant message before each tool execution. Only the
    // later tool-free stop response is the completed answer suitable for a
    // generated session title.
    if (hasOpenCodeToolPart(message)) return false;
    return (message as { stopReason?: unknown }).stopReason === "stop";
  }

  // Claude, Gemini and legacy Codex sessions do not consistently carry an
  // explicit completion phase. Preserve their existing text-based fallback.
  return true;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return cleanMessageText(content);
  }
  if (!Array.isArray(content)) return "";

  return cleanMessageText(
    content
      .map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";

        const record = block as Record<string, unknown>;
        const type =
          typeof record.type === "string"
            ? record.type.toLowerCase()
            : undefined;
        if (
          type &&
          (type === "reasoning" ||
            type === "thinking" ||
            type === "tool_use" ||
            type === "tool_result")
        ) {
          return "";
        }
        if (type && (type === "input_image" || type === "image")) {
          return "[image]";
        }
        if (type === "document") {
          return "[document]";
        }

        const text = typeof record.text === "string" ? record.text : "";
        return isIdeMetadata(text) ? "" : text;
      })
      .filter(Boolean)
      .join("\n"),
  );
}

function cleanMessageText(text: string): string {
  return stripBridgeMetadata(stripIdeMetadata(text));
}
