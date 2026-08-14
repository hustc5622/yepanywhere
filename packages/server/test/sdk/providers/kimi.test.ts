import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ContentBlock,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { zSessionNotification } from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACPClient } from "../../../src/sdk/providers/acp/client.js";
import {
  KimiProvider,
  parseKimiModelCatalog,
  resolveKimiImageSupport,
  toKimiAcpMode,
} from "../../../src/sdk/providers/kimi.js";
import type { StartSessionOptions } from "../../../src/sdk/providers/types.js";
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
  promptPromise: Promise<PromptResponse>,
  updateQueue: SessionNotification[],
  signal: AbortSignal,
): AsyncIterableIterator<SDKMessage> {
  return (
    provider as unknown as {
      yieldUpdates(
        promptPromise: Promise<PromptResponse>,
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

describe("KimiProvider model thinking metadata", () => {
  it("projects each model's exact ACP thinking choices", () => {
    const models = parseKimiModelCatalog(`
[models."custom-kimi/kimi-k3"]
model = "kimi-k3"
capabilities = ["thinking", "always_thinking"]
support_efforts = ["low", "high", "max"]
default_effort = "high"

[models."custom/reasoning-toggle"]
model = "reasoning-toggle"
capabilities = ["thinking"]
support_efforts = ["low", "medium", "high"]

[models."custom/boolean-thinking"]
model = "boolean-model"
capabilities = ["thinking"]

[models."custom/overridden"]
model = "overridden-model"
capabilities = ["thinking"]
support_efforts = ["low", "high", "max"]
default_effort = "max"

[models."custom/overridden".overrides]
capabilities = ["thinking", "always_thinking"]
support_efforts = ["low", "high"]
default_effort = "high"

[models."custom/plain"]
model = "plain-model"
capabilities = ["tool_use"]
`);

    expect(models).toEqual([
      {
        id: "custom-kimi/kimi-k3",
        name: "kimi-k3",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "high" },
          { reasoningEffort: "max" },
        ],
        defaultReasoningEffort: "high",
        supportsEffort: true,
      },
      {
        id: "custom/reasoning-toggle",
        name: "reasoning-toggle",
        supportedReasoningEfforts: [
          { reasoningEffort: "off" },
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
        ],
        defaultReasoningEffort: "medium",
        supportsEffort: true,
      },
      {
        id: "custom/boolean-thinking",
        name: "boolean-thinking",
        supportedReasoningEfforts: [
          { reasoningEffort: "off" },
          { reasoningEffort: "on" },
        ],
        defaultReasoningEffort: "on",
        supportsEffort: false,
      },
      {
        id: "custom/overridden",
        name: "overridden",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "high" },
        ],
        defaultReasoningEffort: "high",
        supportsEffort: true,
      },
      {
        id: "custom/plain",
        name: "plain",
      },
    ]);
  });
});

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

  it("applies and reports the selected thinking effort before startup", async () => {
    vi.spyOn(ACPClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(ACPClient.prototype, "initialize").mockResolvedValue(
      {} as Awaited<ReturnType<ACPClient["initialize"]>>,
    );
    vi.spyOn(ACPClient.prototype, "newSession").mockResolvedValue("session-1");
    const callOrder: string[] = [];
    const setSessionConfigOption = vi
      .spyOn(ACPClient.prototype, "setSessionConfigOption")
      .mockImplementation(async () => {
        callOrder.push("thinking");
        return {
          configOptions: [
            {
              type: "select",
              id: "thinking",
              name: "Thinking",
              category: "thought_level",
              currentValue: "max",
              options: [
                { value: "low", name: "Thinking Low" },
                { value: "high", name: "Thinking High" },
                { value: "max", name: "Thinking Max" },
              ],
            },
          ],
        };
      });
    vi.spyOn(ACPClient.prototype, "setSessionMode").mockImplementation(
      async () => {
        callOrder.push("mode");
      },
    );
    vi.spyOn(ACPClient.prototype, "close").mockImplementation(() => {});

    const session = await new KimiProvider({
      kimiPath: process.execPath,
    }).startSession({
      cwd: process.cwd(),
      model: "custom-kimi/kimi-k3",
      reasoningEffort: "max",
    });

    await expect(session.iterator.next()).resolves.toMatchObject({
      value: {
        type: "system",
        subtype: "init",
        session_id: "session-1",
        model: "custom-kimi/kimi-k3",
        reasoningEffort: "max",
      },
    });
    expect(setSessionConfigOption).toHaveBeenCalledWith(
      "session-1",
      "thinking",
      "max",
    );
    expect(callOrder).toEqual(["thinking", "mode"]);

    session.abort();
  });

  it("fails visibly when Kimi clamps the requested thinking effort", async () => {
    vi.spyOn(ACPClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(ACPClient.prototype, "initialize").mockResolvedValue(
      {} as Awaited<ReturnType<ACPClient["initialize"]>>,
    );
    vi.spyOn(ACPClient.prototype, "newSession").mockResolvedValue("session-1");
    vi.spyOn(ACPClient.prototype, "setSessionConfigOption").mockResolvedValue({
      configOptions: [
        {
          type: "select",
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          currentValue: "high",
          options: [{ value: "high", name: "Thinking High" }],
        },
      ],
    });
    vi.spyOn(ACPClient.prototype, "close").mockImplementation(() => {});

    const session = await new KimiProvider({
      kimiPath: process.execPath,
    }).startSession({
      cwd: process.cwd(),
      reasoningEffort: "max",
    });

    await expect(session.iterator.next()).resolves.toMatchObject({
      value: {
        type: "error",
        error: 'Kimi ACP did not apply thinking effort "max" (active: "high")',
      },
    });
  });
});

describe("KimiProvider prompt completion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockKimiSessionStart() {
    vi.spyOn(ACPClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(ACPClient.prototype, "initialize").mockResolvedValue(
      {} as Awaited<ReturnType<ACPClient["initialize"]>>,
    );
    vi.spyOn(ACPClient.prototype, "newSession").mockResolvedValue("session-1");
    vi.spyOn(ACPClient.prototype, "setSessionMode").mockResolvedValue();
    vi.spyOn(ACPClient.prototype, "close").mockImplementation(() => {});
  }

  it("surfaces an ACP refusal as an error before completing the turn", async () => {
    mockKimiSessionStart();
    vi.spyOn(ACPClient.prototype, "prompt").mockResolvedValue({
      stopReason: "refusal",
    });

    const session = await new KimiProvider({
      kimiPath: process.execPath,
    }).startSession({
      cwd: process.cwd(),
      initialMessage: { text: "inspect the project" },
    });

    await expect(session.iterator.next()).resolves.toMatchObject({
      value: { type: "system", subtype: "init" },
    });
    await expect(session.iterator.next()).resolves.toMatchObject({
      value: { type: "user" },
    });
    await expect(session.iterator.next()).resolves.toMatchObject({
      value: {
        type: "error",
        session_id: "session-1",
        error:
          "Kimi did not complete the turn: the response was refused or blocked.",
        errorCode: "kimi.acp.refusal",
        stopReason: "refusal",
      },
    });
    await expect(session.iterator.next()).resolves.toMatchObject({
      value: { type: "result", session_id: "session-1" },
    });

    session.abort();
  });

  it("propagates an ACP prompt rejection through the visible error channel", async () => {
    mockKimiSessionStart();
    vi.spyOn(ACPClient.prototype, "prompt").mockRejectedValue(
      new Error("ACP prompt transport failed"),
    );

    const session = await new KimiProvider({
      kimiPath: process.execPath,
    }).startSession({
      cwd: process.cwd(),
      initialMessage: { text: "inspect the project" },
    });

    await session.iterator.next();
    await session.iterator.next();
    await expect(session.iterator.next()).resolves.toMatchObject({
      value: {
        type: "error",
        error: "ACP prompt transport failed",
      },
    });
    await expect(session.iterator.next()).resolves.toMatchObject({
      done: true,
    });
  });
});

function handleKimiPermissionRequest(
  provider: KimiProvider,
  request: RequestPermissionRequest,
  onToolApproval: NonNullable<StartSessionOptions["onToolApproval"]>,
): Promise<RequestPermissionResponse> {
  return (
    provider as unknown as {
      handlePermissionRequest(
        request: RequestPermissionRequest,
        options: StartSessionOptions,
        permissionMode: "bypassPermissions",
        signal: AbortSignal,
      ): Promise<RequestPermissionResponse>;
    }
  ).handlePermissionRequest(
    request,
    {
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      onToolApproval,
    },
    "bypassPermissions",
    new AbortController().signal,
  );
}

describe("KimiProvider ACP questions", () => {
  const questionRequest: RequestPermissionRequest = {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "0:AskUserQuestion_23",
      title: "AskUserQuestion",
      content: [
        {
          type: "content",
          content: { type: "text", text: "Build and install now?" },
        },
      ],
    },
    options: [
      {
        kind: "allow_once",
        name: "Build and install",
        optionId: "q0_opt_0",
      },
      {
        kind: "allow_once",
        name: "Keep source changes only",
        optionId: "q0_opt_1",
      },
      { kind: "reject_once", name: "Skip", optionId: "q0_skip" },
    ],
  };

  it("surfaces the permission wire shape as a structured question and returns the chosen option", async () => {
    const onToolApproval = vi.fn(async (_toolName: string, input: unknown) => ({
      behavior: "allow" as const,
      updatedInput: {
        ...(input as Record<string, unknown>),
        answers: { "question-0": "q0_opt_1" },
      },
    }));

    await expect(
      handleKimiPermissionRequest(
        new KimiProvider(),
        questionRequest,
        onToolApproval,
      ),
    ).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "q0_opt_1" },
    });

    expect(onToolApproval).toHaveBeenCalledWith(
      "AskUserQuestion",
      expect.objectContaining({
        questions: [
          {
            id: "question-0",
            question: "Build and install now?",
            header: "Question",
            options: [
              {
                label: "Build and install",
                description: "",
                value: "q0_opt_0",
              },
              {
                label: "Keep source changes only",
                description: "",
                value: "q0_opt_1",
              },
            ],
            multiSelect: false,
            custom: false,
            required: true,
          },
        ],
      }),
      expect.objectContaining({ respectProviderDecision: true }),
    );
  });

  it("cancels instead of silently selecting the first option when no answer is returned", async () => {
    const onToolApproval = vi.fn(async () => ({ behavior: "allow" as const }));

    await expect(
      handleKimiPermissionRequest(
        new KimiProvider(),
        questionRequest,
        onToolApproval,
      ),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("KimiProvider ACP updates", () => {
  it("accepts Kimi 0.34 usage_update notifications without transcript noise", () => {
    const notification = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update" as const,
        used: 22_994,
        size: 1_048_576,
      },
    };

    expect(zSessionNotification.safeParse(notification).success).toBe(true);
    expect(
      convertKimiUpdate(new KimiProvider(), notification.update),
    ).toBeNull();
  });

  it("streams cumulative thought snapshots under one stable message id", async () => {
    const provider = new KimiProvider();
    const updateQueue = [kimiThoughtChunk("User")];
    const abortController = new AbortController();
    let finishPrompt: (() => void) | undefined;
    const promptPromise = new Promise<PromptResponse>((resolve) => {
      finishPrompt = () => resolve({ stopReason: "end_turn" });
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

  it("distinguishes AgentSwarm from Agent when both carry subagent_type", () => {
    const provider = new KimiProvider();

    expect(
      convertKimiUpdate(provider, {
        sessionUpdate: "tool_call",
        toolCallId: "swarm-1",
        title: "Dispatching subagents",
        status: "in_progress",
        rawInput: {
          subagent_type: "coder",
          items: [{ task: "one" }, { task: "two" }],
          prompt_template: "Handle {item}",
        },
      }),
    ).toMatchObject({
      message: {
        content: [
          {
            type: "tool_use",
            id: "swarm-1",
            name: "AgentSwarm",
          },
        ],
      },
    });

    expect(
      convertKimiUpdate(provider, {
        sessionUpdate: "tool_call",
        toolCallId: "agent-1",
        title: "Dispatching subagent",
        status: "in_progress",
        rawInput: {
          subagent_type: "explore",
          prompt: "Investigate",
          description: "Read-only research",
        },
      }),
    ).toMatchObject({
      message: {
        content: [
          {
            type: "tool_use",
            id: "agent-1",
            name: "Agent",
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

function buildKimiPromptBlocks(
  provider: KimiProvider,
  message: unknown,
  text: string,
): Promise<ContentBlock[]> {
  return (
    provider as unknown as {
      buildPromptBlocks(
        message: unknown,
        text: string,
      ): Promise<ContentBlock[]>;
    }
  ).buildPromptBlocks(message, text);
}

describe("KimiProvider prompt blocks", () => {
  it("sends text only when the message has no media", async () => {
    const provider = new KimiProvider();

    expect(
      await buildKimiPromptBlocks(
        provider,
        { message: { role: "user", content: "hello" } },
        "hello",
      ),
    ).toEqual([{ type: "text", text: "hello" }]);
  });

  it("forwards inline base64 image blocks as native ACP image blocks", async () => {
    const provider = new KimiProvider();

    const blocks = await buildKimiPromptBlocks(
      provider,
      {
        message: {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "AAAB",
              },
            },
          ],
        },
      },
      "look",
    );

    expect(blocks).toEqual([
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/jpeg", data: "AAAB" },
    ]);
  });

  it("reads image attachments from disk and links other files", async () => {
    const provider = new KimiProvider();
    const dir = await mkdtemp(join(tmpdir(), "kimi-prompt-"));
    const imagePath = join(dir, "shot.png");
    const notePath = join(dir, "note.txt");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(imagePath, bytes);
    await writeFile(notePath, "hi");

    try {
      const blocks = await buildKimiPromptBlocks(
        provider,
        {
          message: { role: "user", content: "check these" },
          attachments: [
            {
              path: imagePath,
              mimeType: "image/png",
              originalName: "shot.png",
            },
            {
              path: notePath,
              mimeType: "text/plain",
              originalName: "note.txt",
            },
          ],
        },
        "check these",
      );

      expect(blocks).toEqual([
        { type: "text", text: "check these" },
        {
          type: "image",
          mimeType: "image/png",
          data: bytes.toString("base64"),
        },
        {
          type: "resource_link",
          uri: pathToFileURL(notePath).href,
          name: "note.txt",
          mimeType: "text/plain",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a resource_link when an image cannot be read", async () => {
    const provider = new KimiProvider();
    const missing = join(tmpdir(), "kimi-missing-image.png");
    const warn = vi.fn();
    (
      provider as unknown as {
        log: { warn: typeof warn };
      }
    ).log = { warn };

    const blocks = await buildKimiPromptBlocks(
      provider,
      {
        message: { role: "user", content: "x" },
        attachments: [
          { path: missing, mimeType: "image/png", originalName: "gone.png" },
        ],
      },
      "x",
    );

    expect(blocks).toEqual([
      { type: "text", text: "x" },
      {
        type: "resource_link",
        uri: pathToFileURL(missing).href,
        name: "gone.png",
        mimeType: "image/png",
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      { errorCode: "ENOENT" },
      "Failed to read image attachment for Kimi prompt",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(missing);
  });

  it("does not send the same image twice when it arrives inline and as an upload", async () => {
    const provider = new KimiProvider();
    const dir = await mkdtemp(join(tmpdir(), "kimi-dedupe-"));
    const imagePath = join(dir, "same.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    await writeFile(imagePath, bytes);

    try {
      const blocks = await buildKimiPromptBlocks(
        provider,
        {
          message: {
            role: "user",
            content: [
              { type: "text", text: "y" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: bytes.toString("base64"),
                },
              },
            ],
          },
          attachments: [
            {
              path: imagePath,
              mimeType: "image/png",
              originalName: "same.png",
            },
          ],
        },
        "y",
      );

      expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveKimiImageSupport", () => {
  const config = `default_model = "custom-kimi/kimi-k3"

[providers.custom-kimi]
type = "openai"

[models."custom-kimi/kimi-k3"]
provider = "custom-kimi"
model = "kimi-k3"
capabilities = [ "thinking", "always_thinking", "tool_use" ]

[models."custom-kimi/kimi-vision"]
provider = "custom-kimi"
model = "kimi-k3"
capabilities = [ "tool_use", "image_in" ]

[models."custom-kimi/kimi-auto"]
provider = "custom-kimi"
model = "kimi-k3"

[thinking]
enabled = true
`;

  it("reports unknown when declared capabilities omit image_in and the catalog does not know the model", () => {
    // kimi-k3 is not in the static prefix table, and `image_in` is not
    // declared. The catalog returns UNKNOWN, so we cannot make an
    // authoritative negative statement — Kimi's own catalog detection
    // (models.dev) may still resolve it.
    expect(resolveKimiImageSupport(config, "custom-kimi/kimi-k3", {})).toBe(
      "unknown",
    );
  });

  it("reports supported when image_in is declared", () => {
    expect(resolveKimiImageSupport(config, "custom-kimi/kimi-vision", {})).toBe(
      "supported",
    );
  });

  it("reports unknown when the model declares no capabilities and the catalog does not know it", () => {
    expect(resolveKimiImageSupport(config, "custom-kimi/kimi-auto", {})).toBe(
      "unknown",
    );
  });

  it("falls back to default_model when the session pins no model", () => {
    expect(resolveKimiImageSupport(config, undefined, {})).toBe("unknown");
  });

  it("does not read a sibling model's capabilities", () => {
    // kimi-auto sits between two models that do declare capabilities.
    expect(
      resolveKimiImageSupport(config, "custom-kimi/kimi-auto", {}),
    ).not.toBe("supported");
  });

  it("reports unknown for an unrecognized model or a missing config", () => {
    expect(resolveKimiImageSupport(config, "who/knows", {})).toBe("unknown");
    expect(resolveKimiImageSupport(null, "custom-kimi/kimi-k3", {})).toBe(
      "unknown",
    );
  });

  it("honours the KIMI_MODEL_* overlay, which defaults to image_in", () => {
    expect(
      resolveKimiImageSupport(config, undefined, { KIMI_MODEL_NAME: "m" }),
    ).toBe("supported");
    // env overlay with no image_in and no detected capability → unknown
    // (the env overlay has no provider type / wire model id, so detected
    // is null and cannot provide an authoritative negative either).
    expect(
      resolveKimiImageSupport(config, undefined, {
        KIMI_MODEL_NAME: "m",
        KIMI_MODEL_CAPABILITIES: "thinking",
      }),
    ).toBe("unknown");
    expect(
      resolveKimiImageSupport(config, undefined, {
        KIMI_MODEL_NAME: "m",
        KIMI_MODEL_CAPABILITIES: "thinking, image_in",
      }),
    ).toBe("supported");
  });

  it("lets an explicit model override the env overlay", () => {
    expect(
      resolveKimiImageSupport(config, "custom-kimi/kimi-vision", {
        KIMI_MODEL_NAME: "m",
        KIMI_MODEL_CAPABILITIES: "thinking",
      }),
    ).toBe("supported");
  });

  describe("catalog detection (declared ∪ detected)", () => {
    const catalogConfig = `default_model = "openai/gpt-4o"

[providers.openai]
type = "openai"

[providers.anthropic]
type = "anthropic"

[providers.google]
type = "google-genai"

[providers.openai-resp]
type = "openai_responses"

[models."openai/gpt-4o"]
provider = "openai"
model = "gpt-4o"
capabilities = [ "tool_use" ]

[models."openai/gpt-4o-no-decl"]
provider = "openai"
model = "gpt-4o"

[models."openai/o3-mini"]
provider = "openai"
model = "o3-mini"

[models."openai/gpt-35-turbo"]
provider = "openai"
model = "gpt-3.5-turbo"

[models."anthropic/claude-3-5-sonnet"]
provider = "anthropic"
model = "claude-3-5-sonnet-20241022"

[models."anthropic/claude-sonnet-4"]
provider = "anthropic"
model = "claude-sonnet-4-20250514"

[models."google/gemini-25-pro"]
provider = "google"
model = "gemini-2.5-pro"

[models."google/gemini-15-flash"]
provider = "google"
model = "gemini-1.5-flash"

[models."openai-resp/gpt-4o-resp"]
provider = "openai-resp"
model = "gpt-4o"
`;

    it("detects gpt-4o as supported even without declared image_in", () => {
      // The gpt-4o prefix is in the OpenAI vision list; declared `tool_use`
      // alone is enough because detected.image_in is true (union semantics).
      expect(resolveKimiImageSupport(catalogConfig, "openai/gpt-4o", {})).toBe(
        "supported",
      );
    });

    it("detects gpt-4o as supported with no capabilities declared at all", () => {
      expect(
        resolveKimiImageSupport(catalogConfig, "openai/gpt-4o-no-decl", {}),
      ).toBe("supported");
    });

    it("detects o3-mini as unsupported (reasoning, no image_in)", () => {
      // o\d+ matches the OpenAI reasoning pattern: image_in: false. No
      // declared image_in either → authoritative negative.
      expect(resolveKimiImageSupport(catalogConfig, "openai/o3-mini", {})).toBe(
        "unsupported",
      );
    });

    it("detects gpt-3.5-turbo as unsupported (text-only, no image_in)", () => {
      expect(
        resolveKimiImageSupport(catalogConfig, "openai/gpt-35-turbo", {}),
      ).toBe("unsupported");
    });

    it("detects claude-3-5-sonnet as supported (anthropic vision prefix)", () => {
      expect(
        resolveKimiImageSupport(
          catalogConfig,
          "anthropic/claude-3-5-sonnet",
          {},
        ),
      ).toBe("supported");
    });

    it("detects claude-sonnet-4 as supported (anthropic thinking vision prefix)", () => {
      expect(
        resolveKimiImageSupport(catalogConfig, "anthropic/claude-sonnet-4", {}),
      ).toBe("supported");
    });

    it("detects gemini-2.5-pro as supported (gemini thinking multimodal)", () => {
      expect(
        resolveKimiImageSupport(catalogConfig, "google/gemini-25-pro", {}),
      ).toBe("supported");
    });

    it("detects gemini-1.5-flash as supported (gemini multimodal)", () => {
      expect(
        resolveKimiImageSupport(catalogConfig, "google/gemini-15-flash", {}),
      ).toBe("supported");
    });

    it("detects gpt-4o over openai_responses wire as supported", () => {
      expect(
        resolveKimiImageSupport(catalogConfig, "openai-resp/gpt-4o-resp", {}),
      ).toBe("supported");
    });

    it("returns unknown when provider type is missing", () => {
      const noTypeConfig = `default_model = "mystery/gpt-4o"

[providers.mystery]

[models."mystery/gpt-4o"]
provider = "mystery"
model = "gpt-4o"
`;
      expect(resolveKimiImageSupport(noTypeConfig, "mystery/gpt-4o", {})).toBe(
        "unknown",
      );
    });

    it("returns unknown when wire model id is missing", () => {
      const noModelConfig = `default_model = "openai/alias-only"

[providers.openai]
type = "openai"

[models."openai/alias-only"]
provider = "openai"
capabilities = [ "tool_use" ]
`;
      expect(
        resolveKimiImageSupport(noModelConfig, "openai/alias-only", {}),
      ).toBe("unknown");
    });

    it("returns unknown for a kimi wire type (catalog returns UNKNOWN)", () => {
      const kimiWireConfig = `default_model = "kimi/native"

[providers.kimi-native]
type = "kimi"

[models."kimi/native"]
provider = "kimi-native"
model = "kimi-k3"
`;
      expect(resolveKimiImageSupport(kimiWireConfig, "kimi/native", {})).toBe(
        "unknown",
      );
    });

    it("declared image_in overrides an unsupported detected catalog entry", () => {
      // Union semantics: declared image_in adds the capability even when
      // the static catalog reports image_in: false for the wire model.
      const overrideConfig = `default_model = "openai/o3-with-vision"

[providers.openai]
type = "openai"

[models."openai/o3-with-vision"]
provider = "openai"
model = "o3-mini"
capabilities = [ "image_in", "tool_use" ]
`;
      expect(
        resolveKimiImageSupport(overrideConfig, "openai/o3-with-vision", {}),
      ).toBe("supported");
    });
  });
});
