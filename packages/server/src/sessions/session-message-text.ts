import {
  isIdeMetadata,
  parseUserPromptMetadata,
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
    if (isAssistantProgressMessage(message)) continue;
    const text = extractSessionMessageText(message);
    if (text) return text;
  }

  return null;
}

function isAssistantProgressMessage(message: Message): boolean {
  return (
    (message as { codexMessagePhase?: unknown }).codexMessagePhase ===
    "commentary"
  );
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
        const type = typeof record.type === "string" ? record.type : undefined;
        if (
          type &&
          (type === "thinking" || type === "tool_use" || type === "tool_result")
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
  const parsed = parseUserPromptMetadata(text);
  const visibleText =
    parsed.text || parsed.mentionedFiles.map((file) => file.name).join(", ");
  return stripBridgeMetadata(stripIdeMetadata(visibleText));
}
