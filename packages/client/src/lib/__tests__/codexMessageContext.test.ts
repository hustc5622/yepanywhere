import { describe, expect, it } from "vitest";
import type { Message, Session } from "../../types";
import {
  applyContextUsageToLatestUserPrompt,
  extractCodexTurnContextUsage,
} from "../codexMessageContext";

describe("codexMessageContext", () => {
  it("extracts context usage from a Codex turn_complete message", () => {
    const session = {
      provider: "codex",
      model: "gpt-5.3-codex",
    } as Session;
    const message = {
      type: "system",
      subtype: "turn_complete",
      usage: {
        input_tokens: 20_100,
        output_tokens: 321,
        cached_input_tokens: 18_000,
        model_context_window: 258_000,
      },
    } as Message;

    expect(extractCodexTurnContextUsage(message, session)).toMatchObject({
      inputTokens: 20_100,
      outputTokens: 321,
      cacheReadTokens: 18_000,
      percentage: 8,
      contextWindow: 258_000,
    });
  });

  it("extracts context usage before a Codex turn completes", () => {
    const session = {
      provider: "codex",
      model: "gpt-5.3-codex",
    } as Session;
    const message = {
      type: "system",
      subtype: "turn_usage",
      usage: {
        input_tokens: 167_772,
        output_tokens: 1_024,
        cached_input_tokens: 150_000,
        model_context_window: 258_400,
      },
    } as Message;

    expect(extractCodexTurnContextUsage(message, session)).toMatchObject({
      inputTokens: 167_772,
      outputTokens: 1_024,
      cacheReadTokens: 150_000,
      percentage: 65,
      contextWindow: 258_400,
    });
  });

  it("applies context usage to the latest real user prompt", () => {
    const messages: Message[] = [
      {
        type: "user",
        message: { role: "user", content: "first prompt" },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: "tool output",
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
        },
      },
    ];

    const updated = applyContextUsageToLatestUserPrompt(messages, {
      inputTokens: 10_000,
      percentage: 4,
      contextWindow: 258_000,
    });

    expect(updated).not.toBe(messages);
    expect(updated[0]?.contextBefore?.inputTokens).toBe(10_000);
    expect(updated[1]?.contextBefore).toBeUndefined();
  });
});
