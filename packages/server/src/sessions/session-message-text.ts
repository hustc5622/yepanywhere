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

export type SessionTitleTranscriptEntry =
  | { kind: "user"; text: string }
  | {
      kind: "assistant_progress" | "assistant_thinking" | "assistant_response";
      text: string;
    };

/**
 * Build the conversation context used by explicit session-title generation.
 *
 * Unlike the old first-turn automatic title path, a user-triggered title uses
 * everything that exists at click time: real user prompts, assistant progress
 * updates, reasoning/thinking, and final responses. Tool calls and tool results
 * are deliberately omitted, including their arguments and output text.
 */
export function extractSessionTitleTranscript(
  session: Session,
): SessionTitleTranscriptEntry[] {
  const entries: SessionTitleTranscriptEntry[] = [];

  for (const message of session.messages) {
    const role = getSessionMessageRole(message)?.toLowerCase();
    const messageType = message.type.toLowerCase();
    if (isToolContentType(messageType)) continue;

    if (role === "user") {
      const text = extractTitleContentSegments(
        message.message?.content ?? message.content,
        "user",
      )
        .map((segment) => segment.text)
        .join("\n")
        .trim();
      if (!text || isSyntheticUserPromptText(text)) continue;
      entries.push({ kind: "user", text });
      continue;
    }

    const isThinkingMessage =
      messageType === "reasoning" || messageType === "thinking";
    if (role !== "assistant" && !isThinkingMessage) continue;

    const phase = (message as { codexMessagePhase?: unknown })
      .codexMessagePhase;
    const defaultKind: Exclude<SessionTitleTranscriptEntry["kind"], "user"> =
      isThinkingMessage
        ? "assistant_thinking"
        : phase === "commentary"
          ? "assistant_progress"
          : "assistant_response";
    const segments = extractTitleContentSegments(
      message.message?.content ?? message.content,
      defaultKind,
    );

    for (const segment of segments) {
      const previous = entries.at(-1);
      if (previous?.kind === segment.kind) {
        previous.text = `${previous.text}\n${segment.text}`;
      } else {
        entries.push(segment);
      }
    }
  }

  // Codex sessions can retain the original prompt only in the rollout/session
  // summary after compaction or legacy projection. Tool-only user messages are
  // intentionally filtered above, so reuse the same trusted title fallback as
  // the legacy title path only when no real user text survived in history.
  if (!entries.some((entry) => entry.kind === "user")) {
    const fallbackUserPrompt = extractFirstUserPromptText(session);
    if (fallbackUserPrompt) {
      entries.unshift({ kind: "user", text: fallbackUserPrompt });
    }
  }

  return entries;
}

function extractTitleContentSegments(
  content: unknown,
  defaultKind: SessionTitleTranscriptEntry["kind"],
): SessionTitleTranscriptEntry[] {
  if (typeof content === "string") {
    const text = cleanMessageText(content).trim();
    return text
      ? [{ kind: defaultKind, text } as SessionTitleTranscriptEntry]
      : [];
  }
  if (!Array.isArray(content)) return [];

  const segments: SessionTitleTranscriptEntry[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      appendTitleSegment(segments, defaultKind, block);
      continue;
    }
    if (!block || typeof block !== "object") continue;

    const record = block as Record<string, unknown>;
    const type =
      typeof record.type === "string" ? record.type.toLowerCase() : undefined;
    if (type && isToolContentType(type)) continue;

    if (type === "reasoning" || type === "thinking") {
      const thinking =
        typeof record.thinking === "string"
          ? record.thinking
          : typeof record.text === "string"
            ? record.text
            : "";
      appendTitleSegment(segments, "assistant_thinking", thinking);
      continue;
    }
    if (type === "input_image" || type === "image") {
      appendTitleSegment(segments, defaultKind, "[image]");
      continue;
    }
    if (type === "document") {
      appendTitleSegment(segments, defaultKind, "[document]");
      continue;
    }

    const text = typeof record.text === "string" ? record.text : "";
    if (!isIdeMetadata(text)) {
      appendTitleSegment(segments, defaultKind, text);
    }
  }

  return segments;
}

function appendTitleSegment(
  segments: SessionTitleTranscriptEntry[],
  kind: SessionTitleTranscriptEntry["kind"],
  rawText: string,
): void {
  const text = cleanMessageText(rawText).trim();
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.kind === kind) {
    previous.text = `${previous.text}\n${text}`;
  } else {
    segments.push({ kind, text } as SessionTitleTranscriptEntry);
  }
}

function isToolContentType(type: string): boolean {
  const normalized = type.toLowerCase().replaceAll("-", "_");
  return (
    normalized.includes("tool") ||
    normalized === "function_call" ||
    normalized === "function_call_output" ||
    normalized === "command" ||
    normalized === "command_execution" ||
    normalized === "command_output" ||
    normalized === "file_change" ||
    normalized === "web_search"
  );
}

function hasToolPart(message: Message): boolean {
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

  if (session.provider === "pi") {
    // Pi persists one assistant message before each tool execution. Only the
    // later tool-free stop response is the completed answer suitable for a
    // generated session title.
    if (hasToolPart(message)) return false;
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
