import type { InputRequest } from "@yep-anywhere/shared";
import type { Message } from "../supervisor/types.js";

type ContentBlockLike = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
};

function getContentBlocks(message: Message): ContentBlockLike[] {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => !!block && typeof block === "object")
    .map((block) => block as ContentBlockLike);
}

function isQuestionInput(input: unknown): input is {
  questions: Array<{ question?: unknown }>;
} {
  if (!input || typeof input !== "object") return false;
  const questions = (input as { questions?: unknown }).questions;
  return Array.isArray(questions) && questions.length > 0;
}

function normalizeQuestionInput(input: unknown): unknown {
  if (!isQuestionInput(input)) return input;
  return {
    ...(input as Record<string, unknown>),
    questions: input.questions.map((question) => {
      if (!question || typeof question !== "object") return question;
      const record = question as Record<string, unknown>;
      return {
        ...record,
        multiSelect: Boolean(record.multiSelect ?? record.multiple),
      };
    }),
  };
}

/**
 * Provider sessions owned by an external terminal can stop at a question
 * tool_use. Yep does not own that process, so the live Process pending-input
 * queue is empty, but the pending question is still visible in persisted data.
 * Reconstruct a read-only InputRequest from the persisted tool_use so the UI can
 * show the choice prompt instead of appearing idle.
 */
export function getPersistedAskUserQuestionInputRequest(
  messages: Message[],
  sessionId: string,
): InputRequest | null {
  const answeredToolUseIds = new Set<string>();

  for (const message of messages) {
    for (const block of getContentBlocks(message)) {
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        answeredToolUseIds.add(block.tool_use_id);
      }
    }
  }

  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const message = messages[messageIndex];
    if (!message || message.type !== "assistant") continue;

    const blocks = getContentBlocks(message);
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = blocks[blockIndex];
      if (!block) continue;
      if (
        block?.type !== "tool_use" ||
        block.name !== "AskUserQuestion" ||
        typeof block.id !== "string" ||
        answeredToolUseIds.has(block.id) ||
        !isQuestionInput(block.input)
      ) {
        continue;
      }

      const toolInput = normalizeQuestionInput(block.input);
      const firstQuestion = block.input.questions[0]?.question;
      return {
        id: block.id,
        sessionId,
        type: "question",
        prompt: typeof firstQuestion === "string" ? firstQuestion : "Question",
        toolName: "AskUserQuestion",
        toolInput,
        timestamp: message.timestamp ?? new Date().toISOString(),
        source: "persisted",
      };
    }
  }

  return null;
}
