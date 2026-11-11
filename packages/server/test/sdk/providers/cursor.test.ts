import type {
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACPClient } from "../../../src/sdk/providers/acp/client.js";
import { loadCursorModelCatalog } from "../../../src/sdk/providers/cursor-models.js";
import {
  prepareCursorSession,
  resetCursorPrepareStateForTests,
  warmCursorAuth,
} from "../../../src/sdk/providers/cursor-prepare.js";
import {
  CursorProvider,
  resetCursorModelCacheForTests,
} from "../../../src/sdk/providers/cursor.js";
import type {
  AgentSession,
  StartSessionOptions,
} from "../../../src/sdk/providers/types.js";
import { Process } from "../../../src/supervisor/Process.js";

vi.mock("../../../src/sdk/providers/cursor-cli.js", () => ({
  findCursorAgentPath: async () => "/test/agent",
}));
vi.mock("../../../src/sdk/providers/cursor-models.js", () => ({
  loadCursorModelCatalog: vi.fn(async () => [{ id: "auto", name: "Auto" }]),
}));
let update: (notification: SessionNotification) => void;
let permission: (request: RequestPermissionRequest) => Promise<unknown>;
let extension: (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
const sessions: AgentSession[] = [];
const processes: Process[] = [];

beforeEach(() => {
  vi.spyOn(ACPClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(ACPClient.prototype, "initialize").mockResolvedValue({
    protocolVersion: 1,
    agentCapabilities: {},
    authMethods: [],
  });
  vi.spyOn(ACPClient.prototype, "authenticate").mockResolvedValue();
  vi.spyOn(ACPClient.prototype, "newSession").mockResolvedValue("cursor-test");
  vi.spyOn(ACPClient.prototype, "setSessionMode").mockResolvedValue();
  const selected = new Map<string, string>();
  vi.spyOn(ACPClient.prototype, "setSessionConfigOption").mockImplementation(
    async (_sessionId, configId, value) => {
      selected.set(configId, value);
      return {
        configOptions: [...selected.entries()].map(([id, currentValue]) => ({
          id,
          name: id,
          type: "select" as const,
          currentValue,
          options: [{ value: currentValue, name: currentValue }],
        })),
      };
    },
  );
  vi.spyOn(ACPClient.prototype, "close").mockImplementation(() => {});
  vi.spyOn(ACPClient.prototype, "cancel").mockResolvedValue();
  vi.spyOn(ACPClient.prototype, "setSessionUpdateCallback").mockImplementation(
    (fn) => {
      update = fn;
    },
  );
  vi.spyOn(
    ACPClient.prototype,
    "setPermissionRequestCallback",
  ).mockImplementation((fn) => {
    permission = fn;
  });
  vi.spyOn(
    ACPClient.prototype,
    "setExtensionRequestCallback",
  ).mockImplementation((fn) => {
    extension = fn;
  });
});
afterEach(async () => {
  for (const session of sessions.splice(0)) session.abort();
  await Promise.all(processes.splice(0).map((process) => process.abort()));
  await resetCursorPrepareStateForTests();
  resetCursorModelCacheForTests();
  vi.restoreAllMocks();
});
async function start(options: Partial<StartSessionOptions> = {}) {
  const session = await new CursorProvider().startSession({
    cwd: "/test",
    initialMessage: { text: "ping" },
    ...options,
  });
  sessions.push(session);
  return session;
}
const sendText = (text: string) =>
  update({
    sessionId: "cursor-test",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });

describe("Cursor ACP lifecycle", () => {
  it("marks Cursor's standalone backend-error text as a failed turn despite end_turn", async () => {
    vi.spyOn(ACPClient.prototype, "prompt").mockImplementation(async () => {
      sendText("\n\nError: RetriableError: [resource_exhausted] Error");
      return { stopReason: "end_turn" };
    });
    const session = await start();
    const messages = [];
    while (true) {
      const next = (await session.iterator.next()).value;
      messages.push(next);
      if (next.type === "result") break;
    }
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "error",
        errorCode: "cursor.resource_exhausted",
      }),
    );
    expect(messages.at(-1)).toMatchObject({
      type: "result",
      turnStatus: "failed",
      is_error: true,
    });
  });
  it("explicitly selects Auto instead of inheriting the CLI's previous model", async () => {
    const session = await start({ model: "auto" });
    await session.iterator.next();
    expect(ACPClient.prototype.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["--model", "auto"]),
      }),
    );
  });
  it("launches a parameterized model by base id and applies each option", async () => {
    const model = "gpt-5.6-sol[context=1m,reasoning=xhigh,fast=true]";
    const session = await start({ model, permissionMode: "plan" });
    expect((await session.iterator.next()).value).toMatchObject({
      type: "system",
      model,
    });
    expect(ACPClient.prototype.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["--model", "gpt-5.6-sol", "acp"]),
      }),
    );
    expect(ACPClient.prototype.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: { subagents: {}, parameterizedModelPicker: true },
      }),
    );
    expect(ACPClient.prototype.setSessionMode).toHaveBeenCalledWith(
      "cursor-test",
      "plan",
    );
    expect(ACPClient.prototype.setSessionConfigOption).toHaveBeenNthCalledWith(
      1,
      "cursor-test",
      "model",
      "gpt-5.6-sol",
    );
    expect(ACPClient.prototype.setSessionConfigOption).toHaveBeenNthCalledWith(
      2,
      "cursor-test",
      "context",
      "1m",
    );
    expect(ACPClient.prototype.setSessionConfigOption).toHaveBeenNthCalledWith(
      4,
      "cursor-test",
      "fast",
      "true",
    );
    expect(ACPClient.prototype.setSessionConfigOption).toHaveBeenCalledTimes(4);
  });
  it("fails startup when Cursor does not keep the selected context window", async () => {
    vi.spyOn(ACPClient.prototype, "setSessionConfigOption").mockResolvedValue({
      configOptions: [
        {
          id: "context",
          name: "Context",
          type: "select",
          currentValue: "256k",
          options: [{ value: "256k", name: "256k" }],
        },
      ],
    });
    const session = await start({
      model: "grok-4.7[context=500k,reasoning_effort=high,fast=false]",
    });
    expect((await session.iterator.next()).value).toMatchObject({
      type: "error",
      error: expect.stringContaining("context=500k"),
    });
  });
  it("applies selected parameters on a prepared session before the first prompt", async () => {
    const model = "grok-4.7[context=500k,reasoning_effort=high,fast=false]";
    await prepareCursorSession({ cwd: "/test", model });
    expect(ACPClient.prototype.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["--model", "grok-4.7", "acp"]),
      }),
    );
    expect(ACPClient.prototype.newSession).toHaveBeenCalledTimes(1);
    vi.mocked(ACPClient.prototype.setSessionConfigOption).mockClear();
    const session = await start({ model });
    expect((await session.iterator.next()).value).toMatchObject({
      type: "system",
      model,
    });
    expect(ACPClient.prototype.newSession).toHaveBeenCalledTimes(1);
    expect(ACPClient.prototype.setSessionConfigOption).toHaveBeenCalledWith(
      "cursor-test",
      "context",
      "500k",
    );
    expect(ACPClient.prototype.setSessionConfigOption).toHaveBeenCalledWith(
      "cursor-test",
      "fast",
      "false",
    );
  });
  it("streams cumulative text before completion and emits one terminal result", async () => {
    let finish!: () => void;
    vi.spyOn(ACPClient.prototype, "prompt").mockImplementation(async () => {
      sendText("hello");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      sendText(" world");
      return { stopReason: "end_turn" };
    });
    const session = await start();
    expect((await session.iterator.next()).value.type).toBe("system");
    expect((await session.iterator.next()).value.type).toBe("user");
    const first = (await session.iterator.next()).value;
    expect(first).toMatchObject({
      type: "assistant",
      _isStreaming: true,
      cursorTurnIndex: 1,
      message: { content: "hello" },
    });
    finish();
    const messages = [];
    while (true) {
      const next = (await session.iterator.next()).value;
      messages.push(next);
      if (next.type === "result") break;
    }
    expect(messages.filter((m) => m.type === "result")).toHaveLength(1);
    expect(messages.filter((m) => m.type === "assistant").at(-1)).toMatchObject(
      {
        uuid: first.uuid,
        _isStreaming: false,
        message: { content: "hello world" },
      },
    );
  });
  it("returns the supervisor to idle after success and after cancellation", async () => {
    vi.spyOn(ACPClient.prototype, "prompt")
      .mockResolvedValueOnce({ stopReason: "end_turn" })
      .mockResolvedValueOnce({ stopReason: "cancelled" });
    const session = await start();
    const process = new Process(session.iterator, {
      projectPath: "/test",
      projectId: "test",
      sessionId: "temp",
      provider: "cursor",
      queue: session.queue,
      abortFn: session.abort,
    });
    processes.push(process);
    await vi.waitFor(() => expect(process.state.type).toBe("idle"));
    await process.queueMessage({ text: "second" });
    await vi.waitFor(() => expect(process.state.type).toBe("idle"));
    expect(ACPClient.prototype.prompt).toHaveBeenCalledTimes(2);
  });
  it("surfaces prompt failure and still closes the turn", async () => {
    vi.spyOn(ACPClient.prototype, "prompt").mockRejectedValue(
      new Error("request failed"),
    );
    const session = await start();
    const messages = [];
    while (true) {
      const next = (await session.iterator.next()).value;
      messages.push(next);
      if (next.type === "result") break;
    }
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "error", error: "request failed" }),
    );
    expect(messages.at(-1)).toMatchObject({
      type: "result",
      turnStatus: "failed",
      is_error: true,
    });
  });
  it("maps question values and plan approval into the native extension response", async () => {
    const approval = vi
      .fn()
      .mockResolvedValueOnce({
        behavior: "allow",
        updatedInput: { answers: { q1: ["b"] } },
      })
      .mockResolvedValueOnce({ behavior: "deny", message: "Revise the plan" });
    const session = await start({ onToolApproval: approval });
    await session.iterator.next();
    const answer = await extension("cursor/ask_question", {
      questions: [
        {
          id: "q1",
          prompt: "Choose",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          allowMultiple: true,
        },
      ],
    });
    expect(answer).toEqual({
      outcome: {
        outcome: "answered",
        answers: [{ questionId: "q1", selectedOptionIds: ["b"] }],
      },
    });
    expect(approval.mock.calls[0]?.[1]).toMatchObject({
      questions: [{ id: "q1", multiSelect: true, custom: false }],
    });
    expect(
      await extension("cursor/create_plan", { plan: "Test plan" }),
    ).toEqual({ outcome: { outcome: "rejected", reason: "Revise the plan" } });
    expect(approval).toHaveBeenLastCalledWith(
      "ExitPlanMode",
      expect.objectContaining({ plan: "Test plan" }),
      expect.objectContaining({ respectProviderDecision: true }),
    );
  });
  it("does not turn one-shot approvals into persistent grants", async () => {
    const approval = vi
      .fn()
      .mockResolvedValueOnce({ behavior: "allow" })
      .mockResolvedValueOnce({ behavior: "allow", approvalScope: "always" })
      .mockResolvedValueOnce({ behavior: "deny" });
    const session = await start({ onToolApproval: approval });
    await session.iterator.next();
    const req: RequestPermissionRequest = {
      sessionId: "cursor-test",
      toolCall: {
        toolCallId: "tool",
        kind: "execute",
        title: "printf test",
        rawInput: { command: "printf test" },
      },
      options: [
        { optionId: "persistent", name: "Always", kind: "allow_always" },
        { optionId: "once", name: "Once", kind: "allow_once" },
        { optionId: "no", name: "Deny", kind: "reject_once" },
      ],
    };
    expect(await permission(req)).toMatchObject({
      outcome: { optionId: "once" },
    });
    expect(await permission(req)).toMatchObject({
      outcome: { optionId: "persistent" },
    });
    expect(await permission(req)).toMatchObject({
      outcome: { optionId: "no" },
    });
    expect(approval.mock.calls[0]?.[1]).toMatchObject({
      command: "printf test",
      approvalKind: "acp_tool_call",
      acpPermissionOptions: req.options,
    });
  });

  it("preserves a title-only command and refuses an unoffered persistent grant", async () => {
    const approval = vi.fn(async () => ({
      behavior: "allow" as const,
      approvalScope: "always" as const,
    }));
    const session = await start({ onToolApproval: approval });
    await session.iterator.next();
    expect(
      await permission({
        sessionId: "cursor-test",
        toolCall: {
          toolCallId: "t",
          kind: "execute",
          title: "`node probe.js`",
        },
        options: [{ optionId: "one", kind: "allow_once", name: "Once" }],
      }),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(approval).toHaveBeenCalledWith(
      "Bash",
      expect.objectContaining({ command: "node probe.js" }),
      expect.objectContaining({
        respectProviderDecision: true,
        requestMethod: "session/request_permission",
      }),
    );
  });

  it("retains the previous approval policy if native mode switching fails", async () => {
    const approval = vi.fn(async () => ({ behavior: "deny" as const }));
    const session = await start({
      permissionMode: "default",
      onToolApproval: approval,
    });
    await session.iterator.next();
    vi.mocked(ACPClient.prototype.setSessionMode).mockRejectedValueOnce(
      new Error("mode unavailable"),
    );
    await expect(
      session.setPermissionMode?.("bypassPermissions"),
    ).rejects.toThrow("mode unavailable");
    await permission({
      sessionId: "cursor-test",
      toolCall: { toolCallId: "t", kind: "execute", title: "`node probe.js`" },
      options: [{ optionId: "no", kind: "reject_once", name: "No" }],
    });
    expect(approval).toHaveBeenLastCalledWith(
      "Bash",
      expect.anything(),
      expect.objectContaining({ respectProviderDecision: true }),
    );
  });

  it("auto-approves once, restores asking when switched back, and still asks for plans", async () => {
    vi.spyOn(ACPClient.prototype, "prompt").mockResolvedValue({
      stopReason: "end_turn",
    });
    const session = await start({
      permissionMode: "bypassPermissions",
      onToolApproval: (name, input, options) =>
        process.handleToolApproval(name, input, options),
    });
    const process = new Process(session.iterator, {
      projectPath: "/test",
      projectId: "test",
      sessionId: "temp",
      provider: "cursor",
      permissionMode: "bypassPermissions",
      queue: session.queue,
      abortFn: session.abort,
      setPermissionModeFn: session.setPermissionMode,
    });
    processes.push(process);
    await vi.waitFor(() => expect(process.state.type).toBe("idle"));
    const req: RequestPermissionRequest = {
      sessionId: "cursor-test",
      toolCall: { toolCallId: "t", kind: "execute", title: "`node probe.js`" },
      options: [
        { optionId: "one", kind: "allow_once", name: "Once" },
        { optionId: "rule", kind: "allow_always", name: "Always" },
        { optionId: "no", kind: "reject_once", name: "No" },
      ],
    };
    expect(await permission(req)).toEqual({
      outcome: { outcome: "selected", optionId: "one" },
    });
    expect(process.getPendingInputRequest()).toBeNull();

    await process.syncPermissionMode("default");
    const pending = permission(req);
    await vi.waitFor(() =>
      expect(process.getPendingInputRequest()?.toolName).toBe("Bash"),
    );
    const request = process.getPendingInputRequest();
    if (!request) throw new Error("Missing approval");
    process.respondToInput(request.id, "approve_always");
    expect(await pending).toEqual({
      outcome: { outcome: "selected", optionId: "rule" },
    });

    await process.syncPermissionMode("bypassPermissions");
    const plan = extension("cursor/create_plan", {
      plan: "Verify plan approval",
    });
    await vi.waitFor(() =>
      expect(process.getPendingInputRequest()?.toolName).toBe("ExitPlanMode"),
    );
    const question = process.getPendingInputRequest();
    if (!question) throw new Error("Missing plan approval");
    process.respondToInput(question.id, "deny");
    expect(await plan).toMatchObject({ outcome: { outcome: "rejected" } });
  });

  it("keeps explicit deny rules active in session auto-approve mode", async () => {
    vi.spyOn(ACPClient.prototype, "prompt").mockResolvedValue({
      stopReason: "end_turn",
    });
    const session = await start({
      permissionMode: "bypassPermissions",
      onToolApproval: (name, input, options) =>
        process.handleToolApproval(name, input, options),
    });
    const process = new Process(session.iterator, {
      projectPath: "/test",
      projectId: "test",
      sessionId: "temp",
      provider: "cursor",
      permissionMode: "bypassPermissions",
      permissions: { deny: ["Bash(node *)"] },
      queue: session.queue,
      abortFn: session.abort,
    });
    processes.push(process);
    await vi.waitFor(() => expect(process.state.type).toBe("idle"));
    expect(
      await permission({
        sessionId: "cursor-test",
        toolCall: {
          toolCallId: "t",
          kind: "execute",
          title: "`node probe.js`",
        },
        options: [
          { optionId: "one", kind: "allow_once", name: "Once" },
          { optionId: "no", kind: "reject_once", name: "No" },
        ],
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  });

  it("prompts a prepared ACP process without connecting again", async () => {
    vi.spyOn(ACPClient.prototype, "prompt").mockImplementation(async () => {
      sendText("pong");
      return { stopReason: "end_turn" };
    });
    await prepareCursorSession({
      cwd: "/test",
      model: "auto",
      permissionMode: "default",
    });
    expect(ACPClient.prototype.connect).toHaveBeenCalledTimes(1);
    expect(ACPClient.prototype.newSession).toHaveBeenCalledTimes(1);
    const session = await start({ model: "auto" });
    const first = await session.iterator.next();
    expect(first.value).toMatchObject({
      type: "system",
      session_id: "cursor-test",
    });
    expect(ACPClient.prototype.newSession).toHaveBeenCalledTimes(1);
  });

  it("resumes on an already authenticated idle process", async () => {
    vi.spyOn(ACPClient.prototype, "loadSession").mockResolvedValue(undefined);
    vi.spyOn(ACPClient.prototype, "prompt").mockResolvedValue({
      stopReason: "end_turn",
    });
    await warmCursorAuth("auto");
    vi.mocked(ACPClient.prototype.connect).mockClear();
    vi.mocked(ACPClient.prototype.authenticate).mockClear();
    const session = await start({
      model: "auto",
      resumeSessionId: "resume-1",
      initialMessage: { text: "continue" },
    });
    await session.iterator.next();
    expect(ACPClient.prototype.loadSession).toHaveBeenCalledWith(
      "resume-1",
      "/test",
    );
    expect(ACPClient.prototype.newSession).not.toHaveBeenCalled();
  });

  it("starts a new session on an already authenticated idle process", async () => {
    vi.spyOn(ACPClient.prototype, "prompt").mockResolvedValue({
      stopReason: "end_turn",
    });
    await warmCursorAuth("auto");
    const session = await start({ model: "auto" });
    expect((await session.iterator.next()).value).toMatchObject({
      type: "system",
      session_id: "cursor-test",
    });
    expect(ACPClient.prototype.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/test" }),
    );
    expect(ACPClient.prototype.newSession).toHaveBeenCalledTimes(1);
    expect(ACPClient.prototype.newSession).toHaveBeenCalledWith("/test");
  });

  it("evicts the default-model idle process when warming a third model", async () => {
    await warmCursorAuth();
    await warmCursorAuth("auto");
    await warmCursorAuth("gpt-5");
    expect(ACPClient.prototype.connect).toHaveBeenCalledTimes(3);
    await vi.waitFor(() =>
      expect(ACPClient.prototype.close).toHaveBeenCalledTimes(1),
    );
  });

  it("returns the cached model list without waiting for a cold catalog", async () => {
    let resolveCatalog: (models: ModelInfo[]) => void = () => {};
    vi.mocked(loadCursorModelCatalog).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCatalog = resolve;
        }),
    );
    const provider = new CursorProvider();
    await expect(
      provider.getAvailableModels({ waitForRefresh: false }),
    ).resolves.toEqual([]);
    const waiting = provider.getAvailableModels();
    resolveCatalog([{ id: "auto", name: "Auto" }]);
    await expect(waiting).resolves.toEqual([{ id: "auto", name: "Auto" }]);
    await expect(
      provider.getAvailableModels({ waitForRefresh: false }),
    ).resolves.toEqual([{ id: "auto", name: "Auto" }]);
  });

  it("shows todo, task, and image notifications as tool cards", async () => {
    vi.spyOn(ACPClient.prototype, "prompt").mockImplementation(async () => {
      await extension("cursor/update_todos", {
        toolCallId: "todo-1",
        merge: false,
        todos: [
          { id: "a", content: "Write tests", status: "completed" },
          { id: "b", content: "Ship", status: "cancelled" },
        ],
      });
      await extension("cursor/task", {
        toolCallId: "task-1",
        description: "Look around",
        prompt: "Find the bug",
        subagentType: "explore",
        model: "auto",
        agentId: "child-should-not-link",
        durationMs: 1200,
      });
      await extension("cursor/generate_image", {
        toolCallId: "img-1",
        description: "A diagram",
        filePath: "/tmp/diagram.png",
      });
      update({
        sessionId: "cursor-test",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "todo-1",
          kind: "other",
          title: "Update todos",
          status: "completed",
        },
      } as SessionNotification);
      return { stopReason: "end_turn" };
    });
    const session = await start();
    const messages = [];
    while (true) {
      const next = (await session.iterator.next()).value;
      messages.push(next);
      if (next.type === "result") break;
    }
    const todo = messages.find(
      (message) => message.uuid === "cursor-tool-todo-1",
    );
    expect(JSON.stringify(todo)).toContain("TodoWrite");
    expect(JSON.stringify(todo)).toContain("Write tests");
    expect(JSON.stringify(todo)).toContain("pending");
    expect(JSON.stringify(todo)).not.toContain("cancelled");
    const task = messages.find(
      (message) => message.uuid === "cursor-tool-task-1",
    );
    expect(JSON.stringify(task)).toContain("Task");
    expect(JSON.stringify(task)).toContain("Look around");
    expect(JSON.stringify(task)).toContain("Find the bug");
    expect(JSON.stringify(task)).not.toContain("child-should-not-link");
    const image = messages.find(
      (message) => message.uuid === "cursor-tool-img-1",
    );
    expect(JSON.stringify(image)).toContain("ViewImage");
    expect(JSON.stringify(image)).toContain("/tmp/diagram.png");
    expect(
      messages.filter((message) => message.uuid === "cursor-tool-todo-1"),
    ).toHaveLength(1);
  });
});
