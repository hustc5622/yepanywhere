import {
  type SessionQuestion,
  isIdeMetadata,
  stripBridgeMetadata,
  stripIdeMetadata,
} from "@yep-anywhere/shared";
import { sanitizeManagedAttachmentPrompt } from "../sdk/messageQueue.js";
import {
  isSessionSetupText,
  isSyntheticUserPromptText,
} from "./user-prompt-classification.js";

export const SESSION_QUESTION_MAX_LENGTH = 140;

export function compactQuestionText(
  text: string,
  maxLength = SESSION_QUESTION_MAX_LENGTH,
): string {
  const normalized = sanitizeManagedAttachmentPrompt(
    stripBridgeMetadata(stripIdeMetadata(text)),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 0) return "";
  const ellipsis = "...";
  if (maxLength <= ellipsis.length) return ellipsis.slice(0, maxLength);
  return `${normalized.slice(0, maxLength - ellipsis.length)}${ellipsis}`;
}

export function isSessionSetupQuestionText(text: string): boolean {
  return isSessionSetupText(text);
}

export function createSessionQuestion(
  params: {
    id: string | undefined;
    turnId?: string;
    clientUserMessageId?: string;
    codexCorrelationKey?: string;
    text: string;
    timestamp?: string;
  },
  fallbackId: string,
): SessionQuestion | null {
  if (!params.text.trim()) return null;
  if (isSyntheticUserPromptText(params.text)) return null;

  const compact = compactQuestionText(params.text);
  if (!compact) return null;

  return {
    id: params.id || fallbackId,
    ...(params.turnId ? { turnId: params.turnId } : {}),
    ...(params.clientUserMessageId
      ? { clientUserMessageId: params.clientUserMessageId }
      : {}),
    ...(params.codexCorrelationKey
      ? { codexCorrelationKey: params.codexCorrelationKey }
      : {}),
    text: compact,
    ...(params.timestamp ? { timestamp: params.timestamp } : {}),
  };
}

export function extractQuestionTextFromContent(
  content:
    | string
    | Array<{
        type?: unknown;
        text?: unknown;
      }>,
): string {
  if (typeof content === "string") {
    return stripBridgeMetadata(stripIdeMetadata(content));
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        !isIdeMetadata(block.text)
      ) {
        return stripBridgeMetadata(stripIdeMetadata(block.text));
      }
      if (block.type === "input_image" || block.type === "image") {
        return "[image]";
      }
      if (block.type === "document") {
        return "[document]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
