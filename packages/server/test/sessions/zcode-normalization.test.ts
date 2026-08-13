/**
 * ZCode normalization tests.
 *
 * Tests `convertZCodeMessages` against synthetic ZCode session content:
 *   - Text parts → text content blocks
 *   - Reasoning parts → thinking content blocks
 *   - Tool parts (completed/error) → tool_use + tool_result blocks
 *   - Step-start/step-finish/timeline → safely ignored
 *   - Unknown part types → safely ignored
 *   - Malformed JSON data → handled gracefully
 */

import type {
  ZCodeSessionContent,
  ZCodeStoredMessage,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { convertZCodeMessages } from "../../src/sessions/normalization.js";

function makeMessage(
  id: string,
  role: string,
  parts: unknown[],
): ZCodeStoredMessage {
  return { id, role, parts: parts as ZCodeStoredMessage["parts"] };
}

function makeSession(messages: ZCodeStoredMessage[]): ZCodeSessionContent {
  return { sessionId: "test-session", messages };
}

describe("convertZCodeMessages", () => {
  it("converts text parts to text content blocks", () => {
    const session = makeSession([
      makeMessage("m1", "assistant", [{ type: "text", text: "Hello world" }]),
    ]);
    const messages = convertZCodeMessages(session);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe("assistant");
    const content = messages[0]?.message?.content as Array<{
      type: string;
      text: string;
    }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toBe("Hello world");
  });

  it("converts reasoning parts to thinking content blocks", () => {
    const session = makeSession([
      makeMessage("m1", "assistant", [
        { type: "reasoning", text: "Let me think..." },
        { type: "text", text: "The answer is 42" },
      ]),
    ]);
    const messages = convertZCodeMessages(session);
    expect(messages).toHaveLength(1);
    const content = messages[0]?.message?.content as Array<{
      type: string;
      thinking?: string;
      text?: string;
    }>;
    expect(content[0]?.type).toBe("thinking");
    expect(content[0]?.thinking).toBe("Let me think...");
    expect(content[1]?.type).toBe("text");
    expect(content[1]?.text).toBe("The answer is 42");
  });

  it("converts tool parts to tool_use + tool_result blocks", () => {
    const session = makeSession([
      makeMessage("m1", "assistant", [
        {
          type: "tool",
          callID: "tool-1",
          tool: "Bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "file.txt",
          },
        },
      ]),
    ]);
    const messages = convertZCodeMessages(session);
    // One assistant message with tool_use + one user message with tool_result
    expect(messages).toHaveLength(2);
    expect(messages[0]?.type).toBe("assistant");
    const useContent = messages[0]?.message?.content as Array<
      Record<string, unknown>
    >;
    expect(useContent[0]?.type).toBe("tool_use");
    expect(useContent[0]?.name).toBe("Bash");
    expect(useContent[0]?.status).toBe("completed");

    expect(messages[1]?.type).toBe("user");
    expect(messages[1]?.tool_use_id).toBe("tool-1");
    const resultContent = messages[1]?.message?.content as Array<
      Record<string, unknown>
    >;
    expect(resultContent[0]?.type).toBe("tool_result");
    expect(resultContent[0]?.tool_use_id).toBe("tool-1");
  });

  it("marks tool_result with error status on error", () => {
    const session = makeSession([
      makeMessage("m1", "assistant", [
        {
          type: "tool",
          callID: "tool-err",
          tool: "Bash",
          state: {
            status: "error",
            input: { command: "rm -rf /" },
            output: "Permission denied",
          },
        },
      ]),
    ]);
    const messages = convertZCodeMessages(session);
    const resultContent = messages[1]?.message?.content as Array<
      Record<string, unknown>
    >;
    expect(resultContent[0]?.status).toBe("error");
  });

  it("emits tool_use without tool_result for pending tools", () => {
    const session = makeSession([
      makeMessage("m1", "assistant", [
        {
          type: "tool",
          callID: "tool-pending",
          tool: "Read",
          state: {
            status: "running",
            input: { file_path: "test.txt" },
          },
        },
      ]),
    ]);
    const messages = convertZCodeMessages(session);
    // Only the assistant message with tool_use, no tool_result
    expect(messages).toHaveLength(1);
    const content = messages[0]?.message?.content as Array<
      Record<string, unknown>
    >;
    expect(content[0]?.type).toBe("tool_use");
    expect(content[0]?.status).toBe("running");
  });

  it("safely ignores step-start, step-finish, timeline, file parts", () => {
    const session = makeSession([
      makeMessage("m1", "assistant", [
        { type: "step-start" },
        { type: "text", text: "Working..." },
        { type: "step-finish", reason: "end" },
        { type: "timeline", timelineType: "model" },
        { type: "file", filename: "test.txt" },
      ]),
    ]);
    const messages = convertZCodeMessages(session);
    expect(messages).toHaveLength(1);
    const content = messages[0]?.message?.content as Array<{ type: string }>;
    // Only the text block should survive
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
  });

  it("safely ignores unknown part types", () => {
    const session = makeSession([
      makeMessage("m1", "assistant", [
        { type: "future-unknown-part", data: "irrelevant" },
        { type: "text", text: "Hello" },
      ]),
    ]);
    const messages = convertZCodeMessages(session);
    expect(messages).toHaveLength(1);
    const content = messages[0]?.message?.content as Array<{ type: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
  });

  it("returns empty array for empty messages", () => {
    const session = makeSession([]);
    const messages = convertZCodeMessages(session);
    expect(messages).toEqual([]);
  });

  it("handles messages with no parts", () => {
    const session = makeSession([makeMessage("m1", "assistant", [])]);
    const messages = convertZCodeMessages(session);
    // No blocks → no message emitted
    expect(messages).toEqual([]);
  });

  it("preserves user message role", () => {
    const session = makeSession([
      makeMessage("u1", "user", [{ type: "text", text: "What is 2+2?" }]),
    ]);
    const messages = convertZCodeMessages(session);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe("user");
  });

  it("preserves model from stored message", () => {
    const session = makeSession([
      {
        id: "m1",
        role: "assistant",
        model: "zai/glm-4.6",
        parts: [{ type: "text", text: "Hi" }],
      },
    ]);
    const messages = convertZCodeMessages(session);
    expect(messages[0]?.message?.model).toBe("zai/glm-4.6");
  });
});
