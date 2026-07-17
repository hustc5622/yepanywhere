import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  hasEquivalentJsonlMessage,
  reconcileCodexLinearMessages,
} from "../codexLinearMessages";

describe("hasEquivalentJsonlMessage", () => {
  it("requires matching content and close timestamps", () => {
    const existing: Message[] = [
      {
        uuid: "jsonl-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.900Z",
        _source: "jsonl",
        message: { role: "assistant", content: "Done." },
      },
    ];

    expect(
      hasEquivalentJsonlMessage(existing, {
        uuid: "sdk-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:01.200Z",
        _source: "sdk",
        message: { role: "assistant", content: "Done." },
      }),
    ).toBe(true);

    expect(
      hasEquivalentJsonlMessage(existing, {
        uuid: "sdk-2",
        type: "assistant",
        timestamp: "2026-03-09T10:00:10.200Z",
        _source: "sdk",
        message: { role: "assistant", content: "Done." },
      }),
    ).toBe(false);
  });

  it("allows replay messages to match persisted jsonl within a wider overlap window", () => {
    const existing: Message[] = [
      {
        uuid: "jsonl-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:45.000Z",
        _source: "jsonl",
        message: {
          role: "assistant",
          content:
            "There's one small TypeScript widening issue in the new helper.",
        },
      },
    ];

    expect(
      hasEquivalentJsonlMessage(existing, {
        uuid: "sdk-replay-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "sdk",
        isReplay: true,
        message: {
          role: "assistant",
          content:
            "There's one small TypeScript widening issue in the new helper.",
        },
      }),
    ).toBe(true);
  });
});

describe("reconcileCodexLinearMessages", () => {
  it("merges sdk/jsonl duplicates and prefers jsonl", () => {
    const messages: Message[] = [
      {
        uuid: "sdk-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.500Z",
        _source: "sdk",
        message: { role: "assistant", content: "Committed." },
      },
      {
        uuid: "jsonl-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.800Z",
        _source: "jsonl",
        message: { role: "assistant", content: "Committed." },
      },
    ];

    const result = reconcileCodexLinearMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]?._source).toBe("jsonl");
    expect(result[0]?.uuid).toBe("jsonl-1");
    expect(result[0]?.timestamp).toBe("2026-03-09T10:00:00.800Z");
  });

  it("orders messages by timestamp for Codex's linear history", () => {
    const messages: Message[] = [
      {
        uuid: "late",
        type: "assistant",
        timestamp: "2026-03-09T10:00:03.000Z",
        _source: "sdk",
        message: { role: "assistant", content: "Third" },
      },
      {
        uuid: "early",
        type: "user",
        timestamp: "2026-03-09T10:00:01.000Z",
        _source: "jsonl",
        message: { role: "user", content: "First" },
      },
      {
        uuid: "middle",
        type: "assistant",
        timestamp: "2026-03-09T10:00:02.000Z",
        _source: "jsonl",
        message: { role: "assistant", content: "Second" },
      },
    ];

    const result = reconcileCodexLinearMessages(messages);

    expect(result.map((message) => message.uuid)).toEqual([
      "early",
      "middle",
      "late",
    ]);
  });

  it("keeps repeated same-text messages when they are far apart", () => {
    const messages: Message[] = [
      {
        uuid: "sdk-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "sdk",
        message: { role: "assistant", content: "Done." },
      },
      {
        uuid: "jsonl-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:09.000Z",
        _source: "jsonl",
        message: { role: "assistant", content: "Done." },
      },
    ];

    const result = reconcileCodexLinearMessages(messages);

    expect(result).toHaveLength(2);
  });

  it("merges replay/jsonl duplicates across a larger reconnect overlap window", () => {
    const messages: Message[] = [
      {
        uuid: "sdk-replay-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "sdk",
        isReplay: true,
        message: {
          role: "assistant",
          content:
            "There's one small TypeScript widening issue in the new helper.",
        },
      },
      {
        uuid: "jsonl-1",
        type: "assistant",
        timestamp: "2026-03-09T10:00:45.000Z",
        _source: "jsonl",
        message: {
          role: "assistant",
          content:
            "There's one small TypeScript widening issue in the new helper.",
        },
      },
    ];

    const result = reconcileCodexLinearMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]?._source).toBe("jsonl");
    expect(result[0]?.uuid).toBe("jsonl-1");
  });

  it("merges partial sdk tool_result with complete jsonl copy by tool_use_id", () => {
    const messages: Message[] = [
      {
        uuid: "sdk-result",
        type: "user",
        timestamp: "2026-03-09T10:00:00.500Z",
        _source: "sdk",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: "partial str",
            },
          ],
        },
      },
      {
        uuid: "jsonl-result",
        type: "user",
        timestamp: "2026-03-09T10:00:01.200Z",
        _source: "jsonl",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: "partial stream output, now complete",
            },
          ],
        },
      },
    ];

    const result = reconcileCodexLinearMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]?._source).toBe("jsonl");
    expect(result[0]?.message?.content).toMatchObject([
      {
        type: "tool_result",
        tool_use_id: "call-1",
        content: "partial stream output, now complete",
      },
    ]);
  });

  it("merges sdk tool_use with partial input into the jsonl copy", () => {
    const messages: Message[] = [
      {
        uuid: "sdk-use",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.000Z",
        _source: "sdk",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-1", name: "Bash", input: {} },
          ],
        },
      },
      {
        uuid: "jsonl-use",
        type: "assistant",
        timestamp: "2026-03-09T10:00:00.900Z",
        _source: "jsonl",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "Bash",
              input: { command: "ls -la" },
            },
          ],
        },
      },
    ];

    const result = reconcileCodexLinearMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]?._source).toBe("jsonl");
    expect(result[0]?.message?.content).toMatchObject([
      {
        type: "tool_use",
        id: "call-1",
        input: { command: "ls -la" },
      },
    ]);
  });
});
