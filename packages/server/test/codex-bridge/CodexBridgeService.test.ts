import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { CodexBridgeService } from "../../src/codex-bridge/CodexBridgeService.js";
import type { JsonRpcMessage } from "../../src/codex-bridge/types.js";
import type { EventBus } from "../../src/watcher/index.js";

describe("CodexBridgeService", () => {
  let upstreamServer: Server;
  let upstreamWss: WebSocketServer;
  let upstreamPort: number;
  let bridgePort: number;
  let bridge: CodexBridgeService;
  let upstreamSocket: WebSocket | null;
  let upstreamMessages: JsonRpcMessage[];
  let upstreamIsBinaryFlags: boolean[];
  let emittedEvents: unknown[];

  beforeEach(async () => {
    upstreamMessages = [];
    upstreamIsBinaryFlags = [];
    emittedEvents = [];
    upstreamSocket = null;

    upstreamPort = await findAvailablePort();
    upstreamServer = createServer();
    upstreamWss = new WebSocketServer({ server: upstreamServer });
    upstreamWss.on("connection", (ws) => {
      upstreamSocket = ws;
      ws.on("message", (data, isBinary) => {
        upstreamIsBinaryFlags.push(isBinary);
        upstreamMessages.push(JSON.parse(data.toString()) as JsonRpcMessage);
      });
    });
    await listen(upstreamServer, upstreamPort);

    bridgePort = await findAvailablePort();
    const eventBus = {
      emit: vi.fn((event) => emittedEvents.push(event)),
      subscribe: vi.fn(),
      subscriberCount: 0,
    } as unknown as EventBus;
    bridge = new CodexBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      eventBus,
    });
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.shutdown();
    await closeWebSocketServer(upstreamWss);
    await closeServer(upstreamServer);
  });

  it("proxies JSON-RPC and records thread sessions", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      const clientMessagePromise = waitForJsonFrame(client);
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/start",
          params: { cwd: join(tmpdir(), "codex-bridge-test") },
        }),
      );

      await waitFor(() => upstreamMessages.length === 1);
      expect(upstreamMessages[0]).toMatchObject({
        id: 1,
        method: "thread/start",
      });
      expect(upstreamIsBinaryFlags[0]).toBe(false);

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-a",
            thread: {
              id: "thread-a",
              preview: "Build the thing",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-a",
              status: { type: "idle" },
              turns: [],
            },
          },
        }),
      );

      const clientFrame = await clientMessagePromise;
      expect(clientFrame.isBinary).toBe(false);
      const sessions = bridge.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: "thread-a",
        title: "Build the thing",
        projectPath: "/tmp/project-a",
        model: "gpt-5.3-codex",
      });
      expect(bridge.getStatus()).toMatchObject({
        listening: true,
        connectionCount: 1,
        sessionCount: 1,
      });
    } finally {
      client.close();
    }
  });

  it("does not record thread.modelProvider as the session model", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "thread-provider-only" },
        }),
      );

      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            cwd: "/tmp/project-provider-only",
            thread: {
              id: "thread-provider-only",
              modelProvider: "openai",
              preview: "Provider should not become model",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-provider-only",
              status: { type: "idle" },
              turns: [],
            },
          },
        }),
      );

      await waitFor(() => bridge.listSessions().length === 1);
      expect(bridge.listSessions()[0]?.model).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it("records and suppresses MCP startup notifications", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);

      let forwarded = false;
      const onMessage = () => {
        forwarded = true;
      };
      client.on("message", onMessage);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "mcpServer/startupStatus/updated",
          params: {
            threadId: "thread-mcp-startup",
            name: "feishu-mcp",
            status: "ready",
            error: null,
          },
        }),
      );

      await delay(100);
      client.off("message", onMessage);
      expect(forwarded).toBe(false);

      await waitFor(
        () => bridge.getStatus().recentMcpStartupEvents.length === 1,
      );
      expect(bridge.getStatus().recentMcpStartupEvents[0]).toMatchObject({
        profile: "light",
        threadId: "thread-mcp-startup",
        name: "feishu-mcp",
        status: "ready",
        error: null,
      });
    } finally {
      client.close();
    }
  });

  it("filters MCP startup notifications from batched server frames", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);

      const forwardedFrame = waitForJsonFrame(client);
      upstreamSocket?.send(
        JSON.stringify([
          {
            jsonrpc: "2.0",
            method: "mcpServer/startupStatus/updated",
            params: {
              threadId: "thread-mcp-startup",
              name: "feishu-mcp",
              status: "ready",
              error: null,
            },
          },
          {
            jsonrpc: "2.0",
            method: "thread/name/updated",
            params: {
              threadId: "thread-mcp-startup",
              threadName: "Ready thread",
            },
          },
        ]),
      );

      expect((await forwardedFrame).message).toEqual([
        {
          jsonrpc: "2.0",
          method: "thread/name/updated",
          params: {
            threadId: "thread-mcp-startup",
            threadName: "Ready thread",
          },
        },
      ]);
      await waitFor(
        () => bridge.getStatus().recentMcpStartupEvents.length === 1,
      );
    } finally {
      client.close();
    }
  });

  it("keeps idle empty thread records out of displayable session views", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "empty-thread" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-empty",
            thread: {
              id: "empty-thread",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-empty",
              status: { type: "idle" },
              turns: [],
            },
          },
        }),
      );

      await waitFor(() => bridge.listSessions().length === 1);
      expect(bridge.isSessionActive("empty-thread")).toBe(true);
      expect(bridge.listSessionViews()).toEqual([]);
      expect(bridge.getSessionView("empty-thread")).toBeNull();
      expect(
        emittedEvents.some(
          (event) =>
            (event as { type?: string; session?: { id?: string } }).type ===
              "session-created" &&
            (event as { session?: { id?: string } }).session?.id ===
              "empty-thread",
        ),
      ).toBe(false);

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId: "empty-thread" },
        }),
      );

      await waitFor(() => bridge.listSessionViews().length === 1);
      expect(bridge.isSessionActive("empty-thread")).toBe(true);
      expect(bridge.getSessionView("empty-thread")).toMatchObject({
        session: {
          id: "empty-thread",
          messageCount: 0,
          ownership: { owner: "external" },
        },
        activity: "in-turn",
      });
      expect(
        emittedEvents.some(
          (event) =>
            (event as { type?: string; session?: { id?: string } }).type ===
              "session-created" &&
            (event as { session?: { id?: string } }).session?.id ===
              "empty-thread",
        ),
      ).toBe(true);

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId: "empty-thread" },
        }),
      );

      await waitFor(() => {
        const view = bridge.getSessionView("empty-thread");
        return view?.session.messageCount === 1 && view.activity === "idle";
      });
      expect(bridge.getSessionView("empty-thread")).toMatchObject({
        session: {
          id: "empty-thread",
          messageCount: 1,
          ownership: { owner: "external" },
        },
        activity: "idle",
      });
      client.close();
      await waitFor(() => bridge.isSessionActive("empty-thread") === false);
      expect(bridge.getSessionView("empty-thread")).toMatchObject({
        session: {
          id: "empty-thread",
          messageCount: 1,
          ownership: { owner: "none" },
        },
        activity: "idle",
      });
    } finally {
      client.close();
    }
  });

  it("keeps collaboration child threads under their parent session", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);
      const parentThreadId = "parent-thread";
      const childThreadId = "child-review-runtime";

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "thread/started",
          params: {
            thread: {
              id: parentThreadId,
              preview: "Review current changes",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-collaboration",
              source: "vscode",
              threadSource: "user",
              status: { type: "active", activeFlags: [] },
              turns: [],
            },
          },
        }),
      );
      await waitFor(() => bridge.listSessionViews().length === 1);

      // Child turn notifications may race ahead of the parent's collaboration
      // item. Unknown records must remain private until metadata arrives.
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId: childThreadId },
        }),
      );
      await delay(20);
      expect(bridge.listSessions().map((session) => session.id)).toEqual([
        parentThreadId,
      ]);

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            threadId: parentThreadId,
            turnId: "turn-parent",
            item: {
              type: "collabAgentToolCall",
              id: "spawn-review-runtime",
              tool: "spawnAgent",
              status: "completed",
              senderThreadId: parentThreadId,
              receiverThreadIds: [childThreadId],
              agentsStates: {},
            },
          },
        }),
      );
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            threadId: parentThreadId,
            turnId: "turn-parent",
            item: {
              type: "subAgentActivity",
              id: "activity-review-runtime",
              kind: "started",
              agentThreadId: childThreadId,
              agentPath: "/root/review_runtime",
            },
          },
        }),
      );
      await delay(20);

      expect(bridge.listSessions().map((session) => session.id)).toEqual([
        parentThreadId,
      ]);
      expect(bridge.listSessionViews()).toHaveLength(1);
      expect(bridge.getSessionView(childThreadId)).toBeNull();
      expect(bridge.isSessionActive(childThreadId)).toBe(false);
      expect(bridge.getStatus().sessionCount).toBe(1);
      expect(
        emittedEvents.some(
          (event) =>
            [
              "session-created",
              "session-status-changed",
              "process-state-changed",
              "session-updated",
            ].includes((event as { type?: string }).type ?? "") &&
            ((event as { session?: { id?: string } }).session?.id ===
              childThreadId ||
              (event as { sessionId?: string }).sessionId === childThreadId),
        ),
      ).toBe(false);

      const forwardedApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "child-approval",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: childThreadId,
            turnId: "turn-child",
            itemId: "item-child",
            command: "pnpm test",
            cwd: "/tmp/project-collaboration",
            reason: "Run focused tests",
          },
        }),
      );
      expect(await forwardedApproval).toMatchObject({
        id: "child-approval",
        method: "item/commandExecution/requestApproval",
      });

      const pending = bridge.getPendingInputRequest(parentThreadId);
      expect(pending).toMatchObject({
        sessionId: parentThreadId,
        type: "tool-approval",
      });
      expect(bridge.getSessionView(parentThreadId)).toMatchObject({
        pendingInputType: "tool-approval",
        session: { pendingInputType: "tool-approval" },
      });

      const upstreamMessageCount = upstreamMessages.length;
      expect(
        bridge.respondToInput(parentThreadId, pending?.id ?? "", "approve"),
      ).toBe(true);
      await waitFor(() => upstreamMessages.length === upstreamMessageCount + 1);
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "child-approval",
        result: { decision: "accept" },
      });
    } finally {
      client.close();
    }
  });

  it("distinguishes app-server subagents from ordinary user forks", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "thread/started",
          params: {
            thread: {
              id: "user-fork",
              forkedFromId: "original-thread",
              parentThreadId: null,
              preview: "User-created fork",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-fork",
              source: "vscode",
              threadSource: "user",
              status: { type: "active", activeFlags: [] },
              turns: [],
            },
          },
        }),
      );
      await waitFor(() => bridge.listSessionViews().length === 1);

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "thread/started",
          params: {
            thread: {
              id: "direct-child",
              parentThreadId: "user-fork",
              preview: "Internal review worker",
              createdAt: 1_780_000_002,
              updatedAt: 1_780_000_003,
              cwd: "/tmp/project-fork",
              source: {
                subAgent: {
                  thread_spawn: {
                    parent_thread_id: "user-fork",
                    depth: 1,
                    agent_path: "/root/review",
                    agent_nickname: "Noether",
                    agent_role: "reviewer",
                  },
                },
              },
              threadSource: "subagent",
              status: { type: "active", activeFlags: [] },
              turns: [],
            },
          },
        }),
      );
      await delay(20);

      expect(bridge.listSessions().map((session) => session.id)).toEqual([
        "user-fork",
      ]);
      expect(bridge.getSessionView("direct-child")).toBeNull();
      expect(bridge.isSessionActive("direct-child")).toBe(false);
      expect(
        emittedEvents.some(
          (event) =>
            (event as { session?: { id?: string } }).session?.id ===
              "direct-child" ||
            (event as { sessionId?: string }).sessionId === "direct-child",
        ),
      ).toBe(false);
    } finally {
      client.close();
    }
  });

  it("reports idle bridge sessions with open connections as external", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "idle-thread" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-idle",
            thread: {
              id: "idle-thread",
              preview: "Idle but has history",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-idle",
              status: { type: "idle" },
              turns: [{}],
            },
          },
        }),
      );

      await waitFor(() => bridge.listSessionViews().length === 1);
      expect(bridge.isSessionActive("idle-thread")).toBe(true);
      expect(bridge.getSessionView("idle-thread")).toMatchObject({
        session: {
          id: "idle-thread",
          messageCount: 1,
          ownership: { owner: "external" },
        },
        activity: "idle",
      });
      client.close();
      await waitFor(() => bridge.isSessionActive("idle-thread") === false);
      expect(bridge.getSessionView("idle-thread")).toMatchObject({
        session: {
          id: "idle-thread",
          messageCount: 1,
          ownership: { owner: "none" },
        },
        activity: "idle",
      });
    } finally {
      client.close();
    }
  });

  it("records approval requests and answers them from Yep", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "thread-b" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-b",
            thread: {
              id: "thread-b",
              preview: "Needs approval",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-b",
              status: { type: "active", activeFlags: ["waitingOnApproval"] },
              turns: [],
            },
          },
        }),
      );
      await waitFor(() => bridge.listSessions().length === 1);

      const forwardedApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-b",
            turnId: "turn-1",
            itemId: "item-1",
            startedAtMs: Date.now(),
            command: "ls -la",
            cwd: "/tmp/project-b",
            reason: "Need to inspect files",
          },
        }),
      );

      expect(await forwardedApproval).toMatchObject({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
      });
      const pending = bridge.getPendingInputRequest("thread-b");
      expect(pending).toMatchObject({
        sessionId: "thread-b",
        type: "tool-approval",
        toolName: "Bash",
      });
      expect(bridge.listSessions()[0]?.pendingInputType).toBe("tool-approval");

      const beforeResponseCount = upstreamMessages.length;
      const accepted = bridge.respondToInput(
        "thread-b",
        pending?.id ?? "",
        "approve",
      );
      expect(accepted).toBe(true);
      await waitFor(() => upstreamMessages.length === beforeResponseCount + 1);
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "approval-1",
        result: { decision: "accept" },
      });
      expect(bridge.getPendingInputRequest("thread-b")).toBeNull();

      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-1",
          result: { decision: "accept" },
        }),
      );
      await delay(100);
      expect(upstreamMessages.length).toBe(beforeResponseCount + 1);
      expect(
        emittedEvents.some(
          (event) =>
            (event as { type?: string; activity?: string }).type ===
              "process-state-changed" &&
            (event as { activity?: string }).activity === "waiting-input",
        ),
      ).toBe(true);
    } finally {
      client.close();
    }
  });

  it("serves sidecar HTTP control API", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "thread-http" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-http",
            thread: {
              id: "thread-http",
              preview: "HTTP control",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-http",
              status: { type: "active", activeFlags: ["waitingOnApproval"] },
              turns: [],
            },
          },
        }),
      );
      await waitFor(() => bridge.listSessions().length === 1);

      const forwardedApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-http",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-http",
            turnId: "turn-1",
            itemId: "item-1",
            startedAtMs: Date.now(),
            command: "pwd",
            cwd: "/tmp/project-http",
          },
        }),
      );
      expect(await forwardedApproval).toMatchObject({
        id: "approval-http",
        method: "item/commandExecution/requestApproval",
      });

      const baseUrl = `http://127.0.0.1:${bridgePort}`;
      const sessions = await fetchJson<{ sessions: unknown[] }>(
        `${baseUrl}/sessions`,
      );
      expect(sessions.sessions).toHaveLength(1);

      const sessionViews = await fetchJson<{ sessions: unknown[] }>(
        `${baseUrl}/session-views`,
      );
      expect(sessionViews.sessions).toHaveLength(1);

      const pending = await fetchJson<{
        request: { id: string; sessionId: string; toolName: string } | null;
      }>(`${baseUrl}/sessions/thread-http/pending-input`);
      expect(pending.request).toMatchObject({
        sessionId: "thread-http",
        toolName: "Bash",
      });

      const beforeResponseCount = upstreamMessages.length;
      const response = await fetchJson<{ accepted: boolean }>(
        `${baseUrl}/sessions/thread-http/input`,
        {
          method: "POST",
          body: JSON.stringify({
            requestId: pending.request?.id,
            response: "approve",
          }),
        },
      );
      expect(response.accepted).toBe(true);
      await waitFor(() => upstreamMessages.length === beforeResponseCount + 1);
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "approval-http",
        result: { decision: "accept" },
      });
    } finally {
      client.close();
    }
  });

  it("surfaces queued command approvals and accepts Codex policy amendments", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "thread-c" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-c",
            thread: {
              id: "thread-c",
              preview: "Queued approvals",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-c",
              status: { type: "active", activeFlags: ["waitingOnApproval"] },
              turns: [],
            },
          },
        }),
      );
      await waitFor(() => bridge.listSessions().length === 1);

      const forwardedFirstApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-c",
            turnId: "turn-1",
            itemId: "item-1",
            startedAtMs: Date.now(),
            command: "mdfind -name 'cuijie'",
            cwd: "/tmp/project-c",
            availableDecisions: [
              "accept",
              {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: ["mdfind", "-name", "cuijie"],
                },
              },
              "cancel",
            ],
            proposedExecpolicyAmendment: ["mdfind", "-name", "cuijie"],
          },
        }),
      );
      expect(await forwardedFirstApproval).toMatchObject({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
      });

      const forwardedSecondApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-2",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-c",
            turnId: "turn-1",
            itemId: "item-2",
            startedAtMs: Date.now(),
            command: "find / -iname '*cuijie*' -print",
            cwd: "/tmp/project-c",
          },
        }),
      );
      expect(await forwardedSecondApproval).toMatchObject({
        id: "approval-2",
        method: "item/commandExecution/requestApproval",
      });

      const firstPending = bridge.getPendingInputRequest("thread-c");
      expect(firstPending?.toolInput).toMatchObject({
        command: "mdfind -name 'cuijie'",
      });

      const beforePersistentResponseCount = upstreamMessages.length;
      const acceptedPersistent = bridge.respondToInput(
        "thread-c",
        firstPending?.id ?? "",
        "approve_accept_edits",
      );
      expect(acceptedPersistent).toBe(true);
      await waitFor(
        () => upstreamMessages.length === beforePersistentResponseCount + 1,
      );
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "approval-1",
        result: {
          decision: {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["mdfind", "-name", "cuijie"],
            },
          },
        },
      });

      const secondPending = bridge.getPendingInputRequest("thread-c");
      expect(secondPending?.toolInput).toMatchObject({
        command: "find / -iname '*cuijie*' -print",
      });

      const beforeSecondResponseCount = upstreamMessages.length;
      const acceptedSecond = bridge.respondToInput(
        "thread-c",
        secondPending?.id ?? "",
        "approve",
      );
      expect(acceptedSecond).toBe(true);
      await waitFor(
        () => upstreamMessages.length === beforeSecondResponseCount + 1,
      );
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "approval-2",
        result: { decision: "accept" },
      });
      expect(bridge.getPendingInputRequest("thread-c")).toBeNull();
    } finally {
      client.close();
    }
  });

  it("maps MCP tool approval elicitations to scoped tool approvals", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "thread-mcp" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            model: "gpt-5.3-codex",
            cwd: "/tmp/project-mcp",
            thread: {
              id: "thread-mcp",
              preview: "MCP approval",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-mcp",
              status: { type: "active", activeFlags: ["waitingOnApproval"] },
              turns: [],
            },
          },
        }),
      );
      await waitFor(() => bridge.listSessions().length === 1);

      const forwardedApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "mcp-approval-1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-mcp",
            turnId: "turn-1",
            serverName: "chrome-devtools",
            mode: "form",
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              persist: ["session", "always"],
              tool_description: "Open a new tab.",
              tool_params: {
                timeout: 10000,
                url: "http://127.0.0.1:5180/vibe/prompts/slash/kb-ingest-mrs/flow",
              },
              tool_params_display: [
                { name: "timeout", value: 10000, display_name: "timeout" },
                {
                  name: "url",
                  value:
                    "http://127.0.0.1:5180/vibe/prompts/slash/kb-ingest-mrs/flow",
                  display_name: "url",
                },
              ],
            },
            message:
              'Allow the chrome-devtools MCP server to run tool "new_page"?',
            requestedSchema: { type: "object", properties: {} },
          },
        }),
      );
      expect(await forwardedApproval).toMatchObject({
        id: "mcp-approval-1",
        method: "mcpServer/elicitation/request",
      });

      const pending = bridge.getPendingInputRequest("thread-mcp");
      expect(pending).toMatchObject({
        sessionId: "thread-mcp",
        type: "tool-approval",
        prompt: 'Allow the chrome-devtools MCP server to run tool "new_page"?',
        toolName: "MCP",
        toolInput: {
          approvalKind: "mcp_tool_call",
          approvalPrompt:
            'Allow the chrome-devtools MCP server to run tool "new_page"?',
          serverName: "chrome-devtools",
          mcpToolName: "new_page",
          persistScopes: ["session", "always"],
        },
      });
      expect(bridge.listSessions()[0]?.pendingInputType).toBe("tool-approval");

      const beforeSessionResponseCount = upstreamMessages.length;
      const acceptedForSession = bridge.respondToInput(
        "thread-mcp",
        pending?.id ?? "",
        "approve_for_session",
      );
      expect(acceptedForSession).toBe(true);
      await waitFor(
        () => upstreamMessages.length === beforeSessionResponseCount + 1,
      );
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "mcp-approval-1",
        result: { action: "accept", content: { persist: "session" } },
      });

      const forwardedAlwaysApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "mcp-approval-2",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-mcp",
            turnId: "turn-1",
            serverName: "chrome-devtools",
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              persist: ["session", "always"],
            },
            message:
              'Allow the chrome-devtools MCP server to run tool "new_page"?',
            requestedSchema: { type: "object", properties: {} },
          },
        }),
      );
      expect(await forwardedAlwaysApproval).toMatchObject({
        id: "mcp-approval-2",
      });
      const alwaysPending = bridge.getPendingInputRequest("thread-mcp");
      const beforeAlwaysResponseCount = upstreamMessages.length;
      const acceptedAlways = bridge.respondToInput(
        "thread-mcp",
        alwaysPending?.id ?? "",
        "approve_always",
      );
      expect(acceptedAlways).toBe(true);
      await waitFor(
        () => upstreamMessages.length === beforeAlwaysResponseCount + 1,
      );
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "mcp-approval-2",
        result: { action: "accept", content: { persist: "always" } },
      });

      const forwardedCancelApproval = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "mcp-approval-3",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-mcp",
            turnId: "turn-1",
            serverName: "chrome-devtools",
            _meta: { codex_approval_kind: "mcp_tool_call" },
            message:
              'Allow the chrome-devtools MCP server to run tool "new_page"?',
            requestedSchema: { type: "object", properties: {} },
          },
        }),
      );
      expect(await forwardedCancelApproval).toMatchObject({
        id: "mcp-approval-3",
      });
      const cancelPending = bridge.getPendingInputRequest("thread-mcp");
      const beforeCancelResponseCount = upstreamMessages.length;
      const cancelled = bridge.respondToInput(
        "thread-mcp",
        cancelPending?.id ?? "",
        "deny",
      );
      expect(cancelled).toBe(true);
      await waitFor(
        () => upstreamMessages.length === beforeCancelResponseCount + 1,
      );
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "mcp-approval-3",
        result: { action: "cancel" },
      });
    } finally {
      client.close();
    }
  });
});

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("No port assigned"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function waitForJson(ws: WebSocket): Promise<JsonRpcMessage> {
  return (await waitForJsonFrame(ws)).message;
}

async function waitForJsonFrame(
  ws: WebSocket,
): Promise<{ message: JsonRpcMessage; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 5000);
    const handler = (data: WebSocket.RawData, isBinary: boolean) => {
      clearTimeout(timer);
      ws.off("message", handler);
      resolve({
        message: JSON.parse(data.toString()) as JsonRpcMessage,
        isBinary,
      });
    };
    ws.on("message", handler);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for condition");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}
