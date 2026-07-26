import type {
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACPClient } from "../../../src/sdk/providers/acp/client.js";
import {
  KimiProvider,
  toKimiAcpMode,
} from "../../../src/sdk/providers/kimi.js";
import type { SDKMessage } from "../../../src/sdk/types.js";

function convertKimiUpdate(
  provider: KimiProvider,
  update: SessionUpdate,
): SDKMessage | null {
  return (
    provider as unknown as {
      convertUpdateToSDKMessage(
        update: SessionUpdate,
        sessionId: string,
      ): SDKMessage | null;
    }
  ).convertUpdateToSDKMessage(update, "session-1");
}

function streamKimiUpdates(
  provider: KimiProvider,
  promptPromise: Promise<unknown>,
  updateQueue: SessionNotification[],
  signal: AbortSignal,
): AsyncIterableIterator<SDKMessage> {
  return (
    provider as unknown as {
      yieldUpdates(
        promptPromise: Promise<unknown>,
        updateQueue: SessionNotification[],
        sessionId: string,
        signal: AbortSignal,
      ): AsyncIterableIterator<SDKMessage>;
    }
  ).yieldUpdates(promptPromise, updateQueue, "session-1", signal);
}

function kimiThoughtChunk(text: string): SessionNotification {
  return {
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    },
  };
}

describe("KimiProvider permission modes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("advertises Kimi's four native modes in their UI order", () => {
    expect(new KimiProvider().permissionModes).toEqual([
      "default",
      "plan",
      "auto",
      "bypassPermissions",
    ]);
  });

  it.each([
    ["default", "default"],
    ["plan", "plan"],
    ["auto", "auto"],
    ["bypassPermissions", "yolo"],
    ["acceptEdits", "default"],
  ] as const)("maps Yep %s to Kimi ACP %s", (mode, expected) => {
    expect(toKimiAcpMode(mode)).toBe(expected);
  });

  it("applies the native mode on startup and supports live switching", async () => {
    vi.spyOn(ACPClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(ACPClient.prototype, "initialize").mockResolvedValue(
      {} as Awaited<ReturnType<ACPClient["initialize"]>>,
    );
    vi.spyOn(ACPClient.prototype, "newSession").mockResolvedValue("session-1");
    const setSessionMode = vi
      .spyOn(ACPClient.prototype, "setSessionMode")
      .mockResolvedValue();
    vi.spyOn(ACPClient.prototype, "close").mockImplementation(() => {});

    const session = await new KimiProvider({
      kimiPath: process.execPath,
    }).startSession({
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
    });

    await expect(session.iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "system",
        subtype: "init",
        session_id: "session-1",
      },
    });
    expect(setSessionMode).toHaveBeenCalledWith("session-1", "yolo");

    await session.setPermissionMode?.("auto");
    expect(setSessionMode).toHaveBeenLastCalledWith("session-1", "auto");

    session.abort();
  });
});

describe("KimiProvider ACP updates", () => {
  it("streams cumulative thought snapshots under one stable message id", async () => {
    const provider = new KimiProvider();
    const updateQueue = [kimiThoughtChunk("User")];
    const abortController = new AbortController();
    let finishPrompt: (() => void) | undefined;
    const promptPromise = new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
    const iterator = streamKimiUpdates(
      provider,
      promptPromise,
      updateQueue,
      abortController.signal,
    );

    const first = await iterator.next();
    expect(first.value).toMatchObject({
      type: "assistant",
      uuid: expect.any(String),
      message: {
        content: [{ type: "thinking", thinking: "User" }],
      },
    });

    updateQueue.push(kimiThoughtChunk(" wants"), kimiThoughtChunk(" help"));
    const second = await iterator.next();
    expect(second.value).toMatchObject({
      type: "assistant",
      uuid: first.value?.uuid,
      message: {
        content: [{ type: "thinking", thinking: "User wants help" }],
      },
    });

    finishPrompt?.();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("keeps native file-tool arguments and adds renderer-compatible aliases", () => {
    const provider = new KimiProvider();

    expect(
      convertKimiUpdate(provider, {
        sessionUpdate: "tool_call",
        toolCallId: "write-1",
        title: "Writing src/app.ts",
        kind: "edit",
        status: "in_progress",
        rawInput: {
          path: "src/app.ts",
          content: "export const value = 1;\n",
        },
      }),
    ).toMatchObject({
      type: "assistant",
      uuid: expect.any(String),
      session_id: "session-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "write-1",
            name: "Write",
            input: {
              path: "src/app.ts",
              file_path: "src/app.ts",
              content: "export const value = 1;\n",
            },
          },
        ],
      },
    });

    expect(
      convertKimiUpdate(provider, {
        sessionUpdate: "tool_call_update",
        toolCallId: "read-1",
        title: "Reading src/app.ts",
        kind: "read",
        status: "in_progress",
        rawInput: {
          path: "src/app.ts",
          line_offset: 5,
          n_lines: 10,
        },
      }),
    ).toMatchObject({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: {
              path: "src/app.ts",
              file_path: "src/app.ts",
              line_offset: 5,
              offset: 5,
              n_lines: 10,
              limit: 10,
            },
          },
        ],
      },
    });
  });

  it("distinguishes Glob from Grep when both include a path", () => {
    const provider = new KimiProvider();

    expect(
      convertKimiUpdate(provider, {
        sessionUpdate: "tool_call",
        toolCallId: "glob-1",
        title: "Searching **/*.ts",
        kind: "read",
        status: "in_progress",
        rawInput: {
          pattern: "**/*.ts",
          path: "src",
        },
      }),
    ).toMatchObject({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "glob-1",
            name: "Glob",
            input: {
              pattern: "**/*.ts",
              path: "src",
            },
          },
        ],
      },
    });

    expect(
      convertKimiUpdate(provider, {
        sessionUpdate: "tool_call",
        toolCallId: "grep-1",
        title: "Searching for 'TODO' in src",
        kind: "read",
        status: "in_progress",
        rawInput: {
          pattern: "TODO",
          path: "src",
        },
      }),
    ).toMatchObject({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "grep-1",
            name: "Grep",
            input: {
              pattern: "TODO",
              path: "src",
            },
          },
        ],
      },
    });
  });

  it("emits completed and failed ACP tool updates as pairable results", () => {
    const provider = new KimiProvider();

    expect(
      convertKimiUpdate(provider, {
        sessionUpdate: "tool_call_update",
        toolCallId: "read-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "1\tconst value = 1;" },
          },
        ],
      }),
    ).toMatchObject({
      type: "user",
      uuid: expect.any(String),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: "1\tconst value = 1;",
          },
        ],
      },
    });

    expect(
      convertKimiUpdate(provider, {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "failed",
        rawOutput: { message: "old_string was not found" },
      }),
    ).toMatchObject({
      type: "user",
      uuid: expect.any(String),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "edit-1",
            content: '{"message":"old_string was not found"}',
            is_error: true,
          },
        ],
      },
    });
  });

  it("maps Kimi thought and plan updates instead of dropping them", () => {
    const provider = new KimiProvider();

    expect(
      convertKimiUpdate(provider, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Checking the implementation" },
      }),
    ).toMatchObject({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Checking the implementation" },
        ],
      },
    });

    expect(
      convertKimiUpdate(provider, {
        sessionUpdate: "plan",
        entries: [
          {
            content: "Inspect session data",
            priority: "high",
            status: "completed",
          },
          {
            content: "Fix normalization",
            priority: "high",
            status: "in_progress",
          },
        ],
      }),
    ).toMatchObject({
      type: "assistant",
      message: {
        content: [
          {
            type: "thinking",
            thinking: "- [x] Inspect session data\n- [>] Fix normalization",
          },
        ],
      },
    });
  });
});
