import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { deriveCodexBridgeEventStorePath } from "../../src/codex-bridge/CodexBridgeEventSpine.js";
import { CodexBridgeService } from "../../src/codex-bridge/CodexBridgeService.js";
import type { JsonRpcMessage } from "../../src/codex-bridge/types.js";
import {
  type CodexEventAppendResult,
  type CodexEventDraft,
  type CodexEventEnvelope,
  type CodexEventReplayQuery,
  type CodexEventStore,
  InMemoryCodexEventStore,
  JsonlCodexEventStore,
  getCodexEventDiagnostics,
  replayCodexSession,
} from "../../src/codex-events/index.js";
import type { EventBus } from "../../src/watcher/index.js";

const BRIDGE_CONTROL_TOKEN = "codex-bridge-control-test-token";

describe("CodexBridgeService", () => {
  let upstreamServer: Server;
  let upstreamWss: WebSocketServer;
  let upstreamPort: number;
  let bridgePort: number;
  let bridge: CodexBridgeService;
  let upstreamSocket: WebSocket | null;
  let upstreamSockets: WebSocket[];
  let upstreamMessages: JsonRpcMessage[];
  let upstreamIsBinaryFlags: boolean[];
  let emittedEvents: unknown[];
  let eventStore: InspectableCodexEventStore;

  beforeEach(async () => {
    upstreamMessages = [];
    upstreamIsBinaryFlags = [];
    emittedEvents = [];
    eventStore = new InspectableCodexEventStore();
    upstreamSocket = null;
    upstreamSockets = [];

    upstreamPort = await findAvailablePort();
    upstreamServer = createServer();
    upstreamWss = new WebSocketServer({ server: upstreamServer });
    upstreamWss.on("connection", (ws) => {
      upstreamSocket = ws;
      upstreamSockets.push(ws);
      ws.on("message", (data, isBinary) => {
        const message = JSON.parse(data.toString()) as JsonRpcMessage;
        if (message.method === "config/read") {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                config: {
                  mcp_servers: {
                    node_repl: { command: "fake-mcp", enabled: true },
                  },
                },
                origins: {},
              },
            }),
          );
          return;
        }
        upstreamIsBinaryFlags.push(isBinary);
        upstreamMessages.push(message);
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
      eventStore,
      authToken: BRIDGE_CONTROL_TOKEN,
    });
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.shutdown();
    await closeWebSocketServer(upstreamWss);
    await closeServer(upstreamServer);
  });

  it("refuses a non-loopback bind without bearer authentication", async () => {
    const insecure = new CodexBridgeService({
      enabled: true,
      host: "0.0.0.0",
      port: await findAvailablePort(),
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    });
    try {
      await insecure.start();
      expect(insecure.getStatus()).toMatchObject({
        listening: false,
        lastError: expect.stringContaining("Refusing non-loopback"),
      });
    } finally {
      await insecure.shutdown();
    }
  });

  it("requires the configured bearer on non-loopback requests", async () => {
    const port = await findAvailablePort();
    const secured = new CodexBridgeService({
      enabled: true,
      host: "0.0.0.0",
      port,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      authToken: BRIDGE_CONTROL_TOKEN,
    });
    try {
      await secured.start();
      expect(secured.getStatus().listening).toBe(true);

      const unauthenticated = await fetch(`http://127.0.0.1:${port}/status`);
      expect(unauthenticated.status).toBe(401);
      const wrongToken = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { authorization: "Bearer definitely-wrong" },
      });
      expect(wrongToken.status).toBe(401);
      const authenticated = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { authorization: `Bearer ${BRIDGE_CONTROL_TOKEN}` },
      });
      expect(authenticated.status).toBe(200);

      const rejectedSocket = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForClose(rejectedSocket);
      expect(secured.getStatus().connectionCount).toBe(0);
      const authenticatedSocket = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { authorization: `Bearer ${BRIDGE_CONTROL_TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        authenticatedSocket.once("open", resolve);
        authenticatedSocket.once("error", reject);
      });
      await waitFor(() => secured.getStatus().connectionCount === 1);
      authenticatedSocket.close();
    } finally {
      await secured.shutdown();
    }
  });

  it("does not confuse a remote auth bearer with an MCP profile", async () => {
    const port = await findAvailablePort();
    const secured = new CodexBridgeService({
      enabled: true,
      host: "0.0.0.0",
      port,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      authToken: "full",
    });
    const internals = secured as unknown as {
      connections: Map<number, { profile: string }>;
    };
    let client: WebSocket | null = null;
    try {
      await secured.start();
      client = await connect(`ws://127.0.0.1:${port}`, {
        authorization: "Bearer full",
      });
      await waitFor(() => internals.connections.size === 1);
      expect(internals.connections.values().next().value?.profile).toBe(
        "light",
      );
      client.close();
      await waitFor(() => internals.connections.size === 0);

      client = await connect(`ws://127.0.0.1:${port}`, {
        authorization: "Bearer full",
        "x-yep-codex-profile": "full",
      });
      await waitFor(() => internals.connections.size === 1);
      expect(internals.connections.values().next().value?.profile).toBe("full");
    } finally {
      client?.close();
      await secured.shutdown();
    }
  });

  it("returns a typed generic HTTP 500 without exposing handler diagnostics", async () => {
    const bridgeInternals = bridge as unknown as {
      handleHttpRequest: () => Promise<void>;
    };
    const originalHandler = bridgeInternals.handleHttpRequest;
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    bridgeInternals.handleHttpRequest = async () => {
      throw new Error(
        "unauthorized Bearer http-wire-secret at /private/http/config.json",
      );
    };

    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/status`);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Bridge request failed",
        code: "bridge_internal_error",
      });
      expect(bridge.getStatus().lastError).toBe(
        "Codex authentication has expired or is incomplete.",
      );
      const ordinaryLogs = JSON.stringify(warnSpy.mock.calls);
      expect(ordinaryLogs).toContain("code=CODEX_AUTH_REQUIRED");
      expect(ordinaryLogs).not.toContain("http-wire-secret");
      expect(ordinaryLogs).not.toContain("/private/http");
    } finally {
      bridgeInternals.handleHttpRequest = originalHandler;
      warnSpy.mockRestore();
    }
  });

  it("publishes only a safe external upstream origin and argument summary", async () => {
    const diagnosticBridge = new CodexBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: await findAvailablePort(),
      upstreamUrl:
        "ws://provider:upstream-wire-secret@127.0.0.1:4511/private/socket?token=upstream-wire-secret",
      lightUpstreamArgs: [
        "--config=token=upstream-wire-secret,path=/private/upstream/config.json",
      ],
    });

    const status = diagnosticBridge.getStatus();
    expect(status.upstreamUrl).toBe("ws://127.0.0.1:4511");
    expect(status.upstreams.light).toMatchObject({
      url: "ws://127.0.0.1:4511",
      args: ["[1 configured argument hidden]"],
    });
    expect(JSON.stringify(status)).not.toContain("upstream-wire-secret");
    expect(JSON.stringify(status)).not.toContain("/private/upstream");
    await diagnosticBridge.shutdown();
  });

  it("projects managed upstream spawn errors without logging the executable path", async () => {
    const port = await findAvailablePort();
    const codexPath = join(
      tmpdir(),
      "codex-spawn-wire-secret",
      "missing-codex",
    );
    const diagnosticBridge = new CodexBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port,
      codexPath,
      startupTimeoutMs: 500,
    });
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    let client: WebSocket | null = null;
    try {
      await diagnosticBridge.start();
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForClose(client);
      await waitFor(
        () =>
          diagnosticBridge.getStatus().lastError ===
          "The Codex process exited unexpectedly before the task completed.",
      );
      const ordinaryLogs = JSON.stringify(warnSpy.mock.calls);
      expect(ordinaryLogs).toContain("code=CODEX_PROCESS_EXITED");
      expect(ordinaryLogs).not.toContain("codex-spawn-wire-secret");
      expect(ordinaryLogs).not.toContain(codexPath);
      expect(JSON.stringify(diagnosticBridge.getStatus())).not.toContain(
        "codex-spawn-wire-secret",
      );
    } finally {
      client?.close();
      warnSpy.mockRestore();
      await diagnosticBridge.shutdown();
    }
  });

  it("projects frame-processing failures through the public error taxonomy", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      const internals = bridge as unknown as {
        connections: Map<number, unknown>;
        enqueueFrameTask: (
          connection: unknown,
          direction: "client" | "server",
          operation: () => Promise<void>,
        ) => void;
      };
      await waitFor(() => internals.connections.size === 1);
      const connection = internals.connections.values().next().value;
      if (!connection) throw new Error("Expected bridge connection");

      internals.enqueueFrameTask(connection, "client", async () => {
        throw new Error(
          "unauthorized Bearer frame-wire-secret at /private/frame/input.json",
        );
      });

      await waitFor(() =>
        JSON.stringify(warnSpy.mock.calls).includes("code=CODEX_AUTH_REQUIRED"),
      );
      const ordinaryLogs = JSON.stringify(warnSpy.mock.calls);
      expect(ordinaryLogs).toContain("code=CODEX_AUTH_REQUIRED");
      expect(ordinaryLogs).not.toContain("frame-wire-secret");
      expect(ordinaryLogs).not.toContain("/private/frame");
      expect(JSON.stringify(bridge.getStatus())).not.toContain(
        "frame-wire-secret",
      );
      expect(JSON.stringify(bridge.getStatus())).not.toContain(
        "/private/frame",
      );
    } finally {
      client.close();
      warnSpy.mockRestore();
    }
  });

  it("keeps persistence paths out of ordinary bridge logs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-bridge-diagnostic-"));
    const blockingPath = join(tempDir, "persist-wire-secret");
    writeFileSync(blockingPath, "not a directory");
    const diagnosticBridge = new CodexBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: await findAvailablePort(),
      statePath: join(blockingPath, "private-session-state.json"),
    });
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      const internals = diagnosticBridge as unknown as {
        persistSessions: () => Promise<void>;
      };
      await internals.persistSessions();
      const ordinaryLogs = JSON.stringify(warnSpy.mock.calls);
      expect(ordinaryLogs).toContain("code=CODEX_UNKNOWN");
      expect(ordinaryLogs).not.toContain("persist-wire-secret");
      expect(ordinaryLogs).not.toContain("private-session-state.json");
    } finally {
      warnSpy.mockRestore();
      await diagnosticBridge.shutdown();
      rmSync(tempDir, { recursive: true, force: true });
    }
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

  it("persists requests, responses, notifications, and approvals before forwarding or projecting", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);

      const requestGate = eventStore.pauseNextAppend();
      client.send(
        JSON.stringify({
          id: 501,
          method: "turn/start",
          params: {
            threadId: "thread-event-order",
            input: [{ type: "text", text: "start" }],
          },
        }),
      );
      await requestGate.reached;
      await delay(20);
      expect(upstreamMessages).toEqual([]);
      requestGate.release();
      await waitFor(() => upstreamMessages.length === 1);

      const responseGate = eventStore.pauseNextAppend();
      let responseForwarded = false;
      const responseFrame = waitForJson(client).then((message) => {
        responseForwarded = true;
        return message;
      });
      upstreamSocket?.send(
        JSON.stringify({
          id: 501,
          result: {
            turn: {
              id: "turn-event-order",
              status: "inProgress",
              items: [],
            },
          },
        }),
      );
      await responseGate.reached;
      await delay(20);
      expect(responseForwarded).toBe(false);
      responseGate.release();
      expect(await responseFrame).toMatchObject({ id: 501 });

      const notificationGate = eventStore.pauseNextAppend();
      let notificationForwarded = false;
      const notificationFrame = waitForJson(client).then((message) => {
        notificationForwarded = true;
        return message;
      });
      upstreamSocket?.send(
        JSON.stringify({
          method: "thread/started",
          emittedAtMs: 1_800_000_000_001,
          params: {
            thread: {
              id: "thread-event-order",
              cwd: "/tmp/project-event-order",
              name: "Persist first",
            },
          },
        }),
      );
      await notificationGate.reached;
      await delay(20);
      expect(notificationForwarded).toBe(false);
      expect(bridge.listSessions()).toEqual([]);
      notificationGate.release();
      expect(await notificationFrame).toMatchObject({
        method: "thread/started",
      });
      await waitFor(() => bridge.listSessions().length === 1);

      const approvalFrame = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          id: "approval-event-order",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-event-order",
            turnId: "turn-event-order",
            itemId: "command-event-order",
            command: "pnpm test",
            cwd: "/tmp/project-event-order",
          },
        }),
      );
      await approvalFrame;
      const pending = bridge.getPendingInputRequest("thread-event-order");
      const upstreamCount = upstreamMessages.length;
      expect(
        bridge.respondToInput(
          "thread-event-order",
          pending?.id ?? "",
          "approve",
        ),
      ).toBe(true);
      expect(
        bridge.respondToInput(
          "thread-event-order",
          pending?.id ?? "",
          "approve",
        ),
      ).toBe(false);
      await waitFor(() => upstreamMessages.length === upstreamCount + 1);

      const resolvedFrame = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "serverRequest/resolved",
          params: {
            threadId: "thread-event-order",
            requestId: "approval-event-order",
          },
        }),
      );
      await resolvedFrame;

      const request = eventStore.events.find(
        (event) =>
          event.direction === "client_request" && event.requestId === 501,
      );
      const response = eventStore.events.find(
        (event) =>
          event.direction === "client_response" &&
          event.requestId === 501 &&
          event.correlationId.startsWith("client-request:"),
      );
      expect(request).toMatchObject({
        method: "turn/start",
        sessionId: "thread-event-order",
        correlationId: "client-request:number:501",
      });
      expect(response).toMatchObject({
        turnId: "turn-event-order",
        correlationId: "client-request:number:501",
      });

      const serverRequest = eventStore.events.find(
        (event) => event.direction === "server_request",
      );
      const resolution = eventStore.events.find(
        (event) =>
          event.direction === "client_response" &&
          event.correlationId === "server-request:string:approval-event-order",
      );
      const resolved = eventStore.events.find(
        (event) => event.method === "serverRequest/resolved",
      );
      expect(serverRequest).toMatchObject({
        requestId: "approval-event-order",
        turnId: "turn-event-order",
      });
      expect(resolution).toMatchObject({
        phase: "resolved",
        turnId: "turn-event-order",
      });
      expect(resolved).toMatchObject({
        requestId: "approval-event-order",
        turnId: "turn-event-order",
      });
      expect((serverRequest?.sequence ?? 0) < (resolution?.sequence ?? 0)).toBe(
        true,
      );
    } finally {
      client.close();
    }
  });

  it("counts unknown bridge server requests with fingerprint-only diagnostics", async () => {
    const diagnosticsBefore = getCodexEventDiagnostics();
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);
      const requestFrame = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          id: "future-bridge-request",
          method: "future/bridge-request//private/project",
          params: {
            threadId: "thread-future-bridge-request",
            authorization: "Bearer must-not-reach-diagnostics",
          },
        }),
      );
      expect(await requestFrame).toMatchObject({
        id: "future-bridge-request",
        method: "future/bridge-request//private/project",
      });

      client.send(
        JSON.stringify({
          id: "future-bridge-request",
          error: { code: -32601, message: "unsupported" },
        }),
      );
      await waitFor(() =>
        upstreamMessages.some(
          (message) => message.id === "future-bridge-request",
        ),
      );

      const diagnosticsAfter = getCodexEventDiagnostics();
      expect(diagnosticsAfter.unknownServerRequestsTotal).toBe(
        diagnosticsBefore.unknownServerRequestsTotal + 1,
      );
      const serialized = JSON.stringify(diagnosticsAfter);
      expect(serialized).not.toContain(
        "future/bridge-request//private/project",
      );
      expect(serialized).not.toContain("must-not-reach-diagnostics");
      expect(serialized).not.toContain("/private/project");
    } finally {
      client.close();
    }
  });

  it("fails closed without forwarding or projecting frames rejected by the canonical store", async () => {
    const serverFrameClient = await connect(`ws://127.0.0.1:${bridgePort}`);
    const receivedServerFrames: JsonRpcMessage[] = [];
    serverFrameClient.on("message", (data) => {
      receivedServerFrames.push(JSON.parse(data.toString()) as JsonRpcMessage);
    });
    await waitFor(() => upstreamSocket !== null);

    eventStore.rejectNextAppend("storage detail with wire-secret");
    const serverFrameClosed = waitForClose(serverFrameClient);
    upstreamSocket?.send(
      JSON.stringify({
        method: "thread/started",
        params: {
          thread: {
            id: "thread-rejected-server-frame",
            cwd: "/tmp/must-not-project",
            name: "Must not project",
          },
        },
      }),
    );
    await serverFrameClosed;
    await waitFor(() => bridge.getStatus().connectionCount === 0);
    expect(receivedServerFrames).toEqual([]);
    expect(bridge.listSessions()).toEqual([]);
    expect(eventStore.events).toEqual([]);

    const clientFrameClient = await connect(`ws://127.0.0.1:${bridgePort}`);
    await waitFor(() => upstreamSockets.length >= 2);
    eventStore.rejectNextAppend("another storage wire-secret");
    const clientFrameClosed = waitForClose(clientFrameClient);
    clientFrameClient.send(
      JSON.stringify({
        id: 701,
        method: "turn/start",
        params: {
          threadId: "thread-rejected-client-frame",
          input: [{ type: "text", text: "must not forward" }],
        },
      }),
    );
    await clientFrameClosed;
    await delay(20);
    expect(upstreamMessages).toEqual([]);
    expect(eventStore.events).toEqual([]);
    expect(bridge.getStatus().lastError).toBe(
      "Codex event spine client-request persistence failed",
    );
    expect(bridge.getStatus().lastError).not.toContain("wire-secret");
  });

  it("keeps wire payloads transparent while redacting raw reasoning, secrets, and unknown events in the spine", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          id: 601,
          method: "turn/steer",
          params: {
            threadId: "thread-safe-events",
            api_key: "wire-secret",
            input: [{ type: "text", text: "continue" }],
          },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      expect(
        (upstreamMessages[0]?.params as { api_key?: string }).api_key,
      ).toBe("wire-secret");

      const unknownFrame = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "future/thread/telemetry",
          params: {
            threadId: "thread-safe-events",
            authorization: "Bearer visible-only-on-wire",
            value: "future-value",
          },
        }),
      );
      expect(await unknownFrame).toMatchObject({
        method: "future/thread/telemetry",
        params: { authorization: "Bearer visible-only-on-wire" },
      });

      const reasoningFrame = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "item/reasoning/textDelta",
          params: {
            threadId: "thread-safe-events",
            turnId: "turn-safe-events",
            itemId: "reasoning-safe-events",
            delta: "private reasoning visible only on the wire",
          },
        }),
      );
      expect(await reasoningFrame).toMatchObject({
        params: { delta: "private reasoning visible only on the wire" },
      });

      const state = await replayCodexSession(eventStore, "thread-safe-events");
      expect(state.unknownEvents).toHaveLength(1);
      expect(state.unknownEvents[0]).toMatchObject({
        method: "future/thread/telemetry",
        compatibility: "newer_server",
        payload: {
          data: { authorization: "[REDACTED:secret]" },
        },
      });
      const storedRequest = eventStore.events.find(
        (event) => event.method === "turn/steer",
      );
      const storedReasoning = eventStore.events.find(
        (event) => event.method === "item/reasoning/textDelta",
      );
      expect(storedRequest?.payload.data).toMatchObject({
        api_key: "[REDACTED:secret]",
      });
      expect(storedReasoning?.payload.data).toMatchObject({
        delta: expect.stringMatching(/^\[REDACTED:raw-reasoning:/),
      });
      expect(JSON.stringify(eventStore.events)).not.toContain("wire-secret");
      expect(JSON.stringify(eventStore.events)).not.toContain(
        "private reasoning visible only on the wire",
      );
    } finally {
      client.close();
    }
  });

  it("uses a real connection scope before thread/start returns and aliases future events to the provider thread", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          id: 0,
          method: "initialize",
          params: {
            clientInfo: { name: "test", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      const initialized = waitForJson(client);
      upstreamSocket?.send(JSON.stringify({ id: 0, result: {} }));
      await initialized;

      client.send(
        JSON.stringify({
          id: 1,
          method: "thread/start",
          params: { cwd: "/tmp/project-alias" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 2);
      const started = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          id: 1,
          result: {
            thread: {
              id: "thread-real-alias",
              cwd: "/tmp/project-alias",
              turns: [],
            },
          },
        }),
      );
      await started;

      const turnStarted = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "turn/started",
          params: {
            threadId: "thread-real-alias",
            turn: { id: "turn-real-alias" },
          },
        }),
      );
      await turnStarted;

      const startRequest = eventStore.events.find(
        (event) =>
          event.method === "thread/start" &&
          event.direction === "client_request",
      );
      const startResponse = eventStore.events.find(
        (event) =>
          event.method === "thread/start" &&
          event.direction === "client_response",
      );
      const realThreadEvent = eventStore.events.find(
        (event) => event.method === "turn/started",
      );
      expect(startRequest?.sessionId).toMatch(/^bridge-connection:/);
      expect(startResponse?.sessionId).toBe(startRequest?.sessionId);
      expect(startResponse?.payload.data).toMatchObject({
        thread: { id: "thread-real-alias" },
      });
      expect(startRequest?.runtime).toMatchObject({
        profile: "experimental",
        experimentalApi: true,
      });
      const protocolManifest = JSON.parse(
        readFileSync(
          new URL(
            "../../src/sdk/providers/codex-protocol/manifest.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as {
        capabilityProfiles: { experimental: { schemaHash: string } };
      };
      expect(startRequest?.runtime.schemaHash).toBe(
        protocolManifest.capabilityProfiles.experimental.schemaHash,
      );
      expect(realThreadEvent).toMatchObject({
        sessionId: "thread-real-alias",
        threadId: "thread-real-alias",
        turnId: "turn-real-alias",
        runtime: { profile: "experimental", experimentalApi: true },
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

  it("emits a targeted refresh event for external plan updates", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "thread-plan" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            cwd: "/tmp/project-plan",
            thread: {
              id: "thread-plan",
              preview: "Plan test",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-plan",
              status: { type: "working" },
              turns: [],
            },
          },
        }),
      );
      await waitFor(() => bridge.listSessions().length === 1);
      emittedEvents.length = 0;

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "turn/plan/updated",
          params: {
            threadId: "thread-plan",
            turnId: "turn-plan",
            explanation: null,
            plan: [{ step: "Inspect", status: "inProgress" }],
          },
        }),
      );

      await waitFor(() =>
        emittedEvents.some(
          (event) =>
            (event as { type?: string }).type === "session-updated" &&
            (event as { trigger?: string }).trigger === "codex-plan-updated",
        ),
      );
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          type: "session-updated",
          sessionId: "thread-plan",
          trigger: "codex-plan-updated",
        }),
      );
    } finally {
      client.close();
    }
  });

  it("tracks fresh and post-compaction context usage", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/read",
          params: { threadId: "thread-usage" },
        }),
      );
      await waitFor(() => upstreamMessages.length === 1);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            cwd: "/tmp/project-usage",
            thread: {
              id: "thread-usage",
              preview: "Usage test",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_001,
              cwd: "/tmp/project-usage",
              status: { type: "working" },
              turns: [],
            },
          },
        }),
      );
      await waitFor(() => bridge.listSessions().length === 1);

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-usage",
            turnId: "turn-usage",
            tokenUsage: {
              total: { totalTokens: 5000 },
              last: { inputTokens: 4000, totalTokens: 4500 },
              modelContextWindow: 20_000,
            },
          },
        }),
      );
      await waitFor(
        () => bridge.listSessions()[0]?.contextUsage?.inputTokens === 4000,
      );
      expect(bridge.listSessions()[0]?.contextUsage).toEqual({
        inputTokens: 4000,
        percentage: 20,
        contextWindow: 20_000,
      });

      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-usage",
            turnId: "turn-usage",
            tokenUsage: {
              total: { totalTokens: 5000 },
              last: { inputTokens: 0, totalTokens: 1200 },
              modelContextWindow: 20_000,
            },
          },
        }),
      );
      await waitFor(
        () => bridge.listSessions()[0]?.contextUsage?.inputTokens === 1200,
      );
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          type: "session-updated",
          sessionId: "thread-usage",
          contextUsage: {
            inputTokens: 1200,
            percentage: 6,
            contextWindow: 20_000,
          },
        }),
      );
    } finally {
      client.close();
    }
  });

  it("records and transparently forwards MCP startup notifications", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);

      const forwardedFrame = waitForJson(client);
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

      expect(await forwardedFrame).toMatchObject({
        method: "mcpServer/startupStatus/updated",
        params: {
          threadId: "thread-mcp-startup",
          name: "feishu-mcp",
          status: "ready",
        },
      });

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

  it("keeps MCP diagnostic secrets and paths out of status and ordinary logs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    const rawError =
      "unauthorized Bearer mcp-wire-secret at /private/mcp/config.json";
    try {
      await waitFor(() => upstreamSocket !== null);

      const forwardedFrame = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "mcpServer/startupStatus/updated",
          params: {
            threadId: "thread-mcp-secret",
            name: "/private/mcp/config.json:mcp-wire-secret",
            status: "failed",
            error: { message: rawError },
          },
        }),
      );

      expect(await forwardedFrame).toMatchObject({
        params: { error: { message: rawError } },
      });
      await waitFor(
        () => bridge.getStatus().recentMcpStartupEvents.length === 1,
      );
      const status = bridge.getStatus();
      expect(status.recentMcpStartupEvents[0]).toMatchObject({
        profile: "light",
        threadId: "thread-mcp-secret",
        status: "failed",
        error: "Codex authentication has expired or is incomplete.",
      });
      expect(status.recentMcpStartupEvents[0]?.name).toBeUndefined();
      expect(JSON.stringify(status)).not.toContain("mcp-wire-secret");
      expect(JSON.stringify(status)).not.toContain("/private/mcp");
      const ordinaryLogs = JSON.stringify(logSpy.mock.calls);
      expect(ordinaryLogs).toContain("code=CODEX_AUTH_REQUIRED");
      expect(ordinaryLogs).not.toContain("mcp-wire-secret");
      expect(ordinaryLogs).not.toContain("/private/mcp");
    } finally {
      client.close();
      logSpy.mockRestore();
    }
  });

  it("forwards batched server frames byte-for-byte while observing them", async () => {
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
          params: {
            threadId: "empty-thread",
            turn: { id: "empty-turn", status: "completed", items: [] },
          },
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
      upstreamSocket?.send(
        JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: "empty-thread",
            turn: { id: "empty-turn", status: "completed", items: [] },
          },
        }),
      );
      await delay(20);
      expect(bridge.getSessionView("empty-thread")?.session.messageCount).toBe(
        1,
      );
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
      expect(upstreamMessages.at(-1)).not.toHaveProperty("jsonrpc");
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

      client.send(
        JSON.stringify([
          {
            id: "approval-1",
            result: { decision: "accept" },
          },
          {
            method: "bridge/test-notification",
            params: { preserved: true },
          },
        ]),
      );
      await waitFor(() => upstreamMessages.length === beforeResponseCount + 2);
      expect(upstreamMessages.at(-1)).toEqual([
        {
          method: "bridge/test-notification",
          params: { preserved: true },
        },
      ]);
      expect(
        emittedEvents.some(
          (event) =>
            (event as { type?: string; activity?: string }).type ===
              "process-state-changed" &&
            (event as { activity?: string }).activity === "waiting-input",
        ),
      ).toBe(true);

      const forwardedQuestion = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "question-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-b",
            turnId: "turn-1",
            itemId: "item-question-1",
            questions: [
              {
                id: "scope",
                question: "Select scopes",
                header: "Scopes",
                options: [{ label: "Read" }, { label: "Write" }],
              },
            ],
          },
        }),
      );

      expect(await forwardedQuestion).toMatchObject({
        id: "question-1",
        method: "item/tool/requestUserInput",
      });
      const pendingQuestion = bridge.getPendingInputRequest("thread-b");
      expect(pendingQuestion).toMatchObject({
        type: "question",
        toolName: "AskUserQuestion",
      });

      const beforeQuestionResponseCount = upstreamMessages.length;
      expect(
        bridge.respondToInput(
          "thread-b",
          pendingQuestion?.id ?? "",
          "approve",
          { scope: ["Read", "Write"] },
        ),
      ).toBe(true);
      await waitFor(
        () => upstreamMessages.length === beforeQuestionResponseCount + 1,
      );
      expect(upstreamMessages.at(-1)).toMatchObject({
        id: "question-1",
        result: {
          answers: { scope: { answers: ["Read", "Write"] } },
        },
      });
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
      const controlHeaders = {
        authorization: `Bearer ${BRIDGE_CONTROL_TOKEN}`,
        "content-type": "application/json",
        "x-yep-anywhere": "true",
      };
      const unauthenticated = await fetch(
        `${baseUrl}/sessions/thread-http/input`,
        {
          method: "POST",
          body: JSON.stringify({
            requestId: pending.request?.id,
            response: "approve",
          }),
        },
      );
      expect(unauthenticated.status).toBe(401);

      const legacy = await fetch(`${baseUrl}/sessions/thread-http/input`, {
        method: "POST",
        headers: controlHeaders,
        body: JSON.stringify({
          requestId: pending.request?.id,
          response: "approve",
        }),
      });
      expect(legacy.status).toBe(409);
      await expect(legacy.json()).resolves.toMatchObject({
        code: "interaction_identity_required",
      });
      expect(upstreamMessages).toHaveLength(beforeResponseCount);

      const operationId = "int_12345678-1234-4234-8234-123456789abc";
      const csrfAttempt = await fetch(
        `${baseUrl}/sessions/thread-http/input-binding`,
        {
          method: "POST",
          headers: { ...controlHeaders, origin: "https://attacker.test" },
          body: JSON.stringify({
            requestId: pending.request?.id,
            operationId,
            operationVersion: 4,
          }),
        },
      );
      expect(csrfAttempt.status).toBe(403);

      const binding = await fetchJson<{ bound: boolean }>(
        `${baseUrl}/sessions/thread-http/input-binding`,
        {
          method: "POST",
          headers: controlHeaders,
          body: JSON.stringify({
            requestId: pending.request?.id,
            operationId,
            operationVersion: 4,
          }),
        },
      );
      expect(binding.bound).toBe(true);

      const staleResolution = await fetch(
        `${baseUrl}/sessions/thread-http/input`,
        {
          method: "POST",
          headers: controlHeaders,
          body: JSON.stringify({
            requestId: pending.request?.id,
            response: "approve",
            operationId,
            operationVersion: 4,
            actor: { id: "replayed-user", channel: "yep" },
          }),
        },
      );
      expect(staleResolution.status).toBe(409);
      expect(upstreamMessages).toHaveLength(beforeResponseCount);

      const resolutionBody = JSON.stringify({
        requestId: pending.request?.id,
        response: "approve",
        operationId,
        operationVersion: 5,
        actor: { id: "yep-test-user", channel: "yep" },
      });
      const [firstResolution, racedResolution] = await Promise.all([
        fetch(`${baseUrl}/sessions/thread-http/input`, {
          method: "POST",
          headers: controlHeaders,
          body: resolutionBody,
        }),
        fetch(`${baseUrl}/sessions/thread-http/input`, {
          method: "POST",
          headers: controlHeaders,
          body: resolutionBody,
        }),
      ]);
      expect([firstResolution.status, racedResolution.status].sort()).toEqual([
        200, 404,
      ]);
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
        "approve_always",
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
        result: {
          action: "accept",
          content: null,
          _meta: { persist: "session" },
        },
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
        result: {
          action: "accept",
          content: null,
          _meta: { persist: "always" },
        },
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
        result: { action: "cancel", content: null, _meta: null },
      });
    } finally {
      client.close();
    }
  });

  it("keeps the upstream alive after the terminal disconnects until the turn completes", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    client.send(
      JSON.stringify({
        id: 1,
        method: "thread/read",
        params: { threadId: "thread-detached" },
      }),
    );
    await waitFor(() => upstreamMessages.length === 1);
    upstreamSocket?.send(
      JSON.stringify({
        id: 1,
        result: {
          model: "gpt-5.3-codex",
          cwd: "/tmp/project-detached",
          thread: {
            id: "thread-detached",
            preview: "Detached takeover",
            createdAt: 1_780_000_000,
            updatedAt: 1_780_000_001,
            cwd: "/tmp/project-detached",
            status: { type: "active", activeFlags: [] },
            turns: [],
          },
        },
      }),
    );
    await waitFor(() => bridge.isSessionActive("thread-detached"));

    client.close();
    await waitFor(
      () =>
        bridge.getStatus().attachedClientCount === 0 &&
        bridge.getStatus().detachedConnectionCount === 1,
    );

    upstreamSocket?.send(
      JSON.stringify({
        id: "detached-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-detached",
          turnId: "turn-detached",
          itemId: "item-detached",
          command: "pnpm test",
          cwd: "/tmp/project-detached",
        },
      }),
    );
    await waitFor(
      () => bridge.getPendingInputRequest("thread-detached") !== null,
    );
    const pending = bridge.getPendingInputRequest("thread-detached");
    const beforeResponseCount = upstreamMessages.length;
    expect(
      bridge.respondToInput("thread-detached", pending?.id ?? "", "approve"),
    ).toBe(true);
    await waitFor(() => upstreamMessages.length === beforeResponseCount + 1);
    expect(upstreamMessages.at(-1)).toEqual({
      id: "detached-approval",
      result: { decision: "accept" },
    });

    upstreamSocket?.send(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-detached",
          turn: { id: "turn-detached", status: "completed", items: [] },
        },
      }),
    );
    await waitFor(() => bridge.getStatus().connectionCount === 0);
    expect(bridge.getStatus()).toMatchObject({
      attachedClientCount: 0,
      detachedConnectionCount: 0,
      pendingInputCount: 0,
    });
    expect(bridge.isSessionActive("thread-detached")).toBe(false);
  });

  it("deduplicates one app-server request broadcast to multiple clients", async () => {
    const firstClient = await connect(`ws://127.0.0.1:${bridgePort}`);
    const secondClient = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSockets.length === 2);
      const firstForwarded = waitForJson(firstClient);
      const secondForwarded = waitForJson(secondClient);
      const request = {
        id: "broadcast-approval",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-broadcast",
          turnId: "turn-broadcast",
          itemId: "item-broadcast",
          reason: "Apply the generated patch",
          fileChanges: {},
        },
      };
      upstreamSockets[0]?.send(JSON.stringify(request));
      upstreamSockets[1]?.send(JSON.stringify(request));
      await Promise.all([firstForwarded, secondForwarded]);
      expect(bridge.getStatus().pendingInputCount).toBe(1);

      const pending = bridge.getPendingInputRequest("thread-broadcast");
      const beforeResponseCount = upstreamMessages.length;
      expect(
        bridge.respondToInput("thread-broadcast", pending?.id ?? "", "approve"),
      ).toBe(true);
      await waitFor(() => upstreamMessages.length === beforeResponseCount + 1);
      expect(bridge.getStatus().pendingInputCount).toBe(0);

      firstClient.send(
        JSON.stringify({
          id: "broadcast-approval",
          result: { decision: "accept" },
        }),
      );
      secondClient.send(
        JSON.stringify({
          id: "broadcast-approval",
          result: { decision: "accept" },
        }),
      );
      await delay(100);
      expect(upstreamMessages.length).toBe(beforeResponseCount + 1);
    } finally {
      firstClient.close();
      secondClient.close();
    }
  });

  it("keeps timed Codex questions pending after detach until an explicit answer", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    await waitFor(() => upstreamSocket !== null);
    const forwarded = waitForJson(client);
    upstreamSocket?.send(
      JSON.stringify({
        id: "timed-question",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-timed-question",
          turnId: "turn-timed-question",
          itemId: "item-timed-question",
          autoResolutionMs: 100,
          questions: [
            {
              id: "continue",
              header: "Continue",
              question: "Continue automatically?",
              isOther: false,
              isSecret: false,
              options: [{ label: "Wait", description: "Keep waiting" }],
            },
          ],
        },
      }),
    );
    await forwarded;
    client.close();
    await waitFor(() => bridge.getStatus().detachedConnectionCount === 1);
    await delay(150);
    expect(upstreamMessages).toEqual([]);
    const pending = bridge.getPendingInputRequest("thread-timed-question");
    expect(pending).toMatchObject({ type: "question" });
    expect(
      bridge.respondToInput(
        "thread-timed-question",
        pending?.id ?? "",
        "approve",
        { continue: "Wait" },
      ),
    ).toBe(true);
    await waitFor(() => upstreamMessages.length === 1);
    expect(upstreamMessages[0]).toEqual({
      id: "timed-question",
      result: { answers: { continue: { answers: ["Wait"] } } },
    });

    upstreamSocket?.send(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-timed-question",
          turn: {
            id: "turn-timed-question",
            status: "completed",
            items: [],
          },
        },
      }),
    );
    await waitFor(() => bridge.getStatus().connectionCount === 0);
  });

  it("uses serverRequest/resolved to retire pending UI and suppress late replies", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);
      const forwarded = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          id: "resolved-approval",
          method: "item/fileChange/requestApproval",
          params: {
            threadId: "thread-resolved",
            turnId: "turn-resolved",
            itemId: "item-resolved",
            fileChanges: {},
          },
        }),
      );
      await forwarded;
      expect(bridge.getStatus().pendingInputCount).toBe(1);

      const resolvedNotification = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "serverRequest/resolved",
          params: {
            threadId: "thread-resolved",
            requestId: "resolved-approval",
          },
        }),
      );
      await resolvedNotification;
      await waitFor(() => bridge.getStatus().pendingInputCount === 0);

      const beforeLateReply = upstreamMessages.length;
      client.send(
        JSON.stringify({
          id: "resolved-approval",
          result: { decision: "accept" },
        }),
      );
      await delay(50);
      expect(upstreamMessages.length).toBe(beforeLateReply);
    } finally {
      client.close();
    }
  });

  it("marks a session failed-idle on a non-retryable error notification", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);
      const started = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "thread/started",
          params: {
            thread: { id: "thread-err", cwd: "/tmp/project-err" },
          },
        }),
      );
      await started;
      const turnStarted = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "turn/started",
          params: { threadId: "thread-err", turn: { id: "turn-1" } },
        }),
      );
      await turnStarted;
      await waitFor(
        () =>
          bridge.listSessions().find((s) => s.id === "thread-err")?.activity ===
          "in-turn",
      );

      // Retryable error keeps the turn alive.
      const retryable = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "error",
          params: {
            threadId: "thread-err",
            turnId: "turn-1",
            willRetry: true,
            error: { message: "rate limited" },
          },
        }),
      );
      await retryable;
      expect(
        bridge.listSessions().find((s) => s.id === "thread-err")?.activity,
      ).toBe("in-turn");

      // Non-retryable error terminates the turn.
      const fatal = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "error",
          params: {
            threadId: "thread-err",
            turnId: "turn-1",
            willRetry: false,
            error: {
              message:
                "model exploded token=bridge-error-secret at /private/uploads/report.pdf",
            },
          },
        }),
      );
      await fatal;
      await waitFor(
        () =>
          bridge.listSessions().find((s) => s.id === "thread-err")?.activity ===
          "idle",
      );
      const session = bridge.listSessions().find((s) => s.id === "thread-err");
      expect(session?.lastTurnStatus).toBe("failed");
      expect(session?.lastErrorMessage).toBe(
        "Codex encountered an unclassified error before the task completed.",
      );
      expect(JSON.stringify(session)).not.toContain("bridge-error-secret");
      expect(JSON.stringify(session)).not.toContain("/private/uploads");
    } finally {
      client.close();
    }
  });

  it("records interrupted/failed turn status from turn/completed", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);
      const started = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "thread/started",
          params: {
            thread: { id: "thread-int", cwd: "/tmp/project-int" },
          },
        }),
      );
      await started;
      const turnStarted = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "turn/started",
          params: { threadId: "thread-int", turn: { id: "turn-1" } },
        }),
      );
      await turnStarted;
      const completed = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: "thread-int",
            turn: { id: "turn-1", status: "interrupted" },
          },
        }),
      );
      await completed;
      await waitFor(
        () =>
          bridge.listSessions().find((s) => s.id === "thread-int")?.activity ===
          "idle",
      );
      expect(
        bridge.listSessions().find((s) => s.id === "thread-int")
          ?.lastTurnStatus,
      ).toBe("interrupted");
    } finally {
      client.close();
    }
  });

  it("hides sessions until their project path is known", async () => {
    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);
      const turnStarted = waitForJson(client);
      // Bare threadId with no cwd: previously misfiled under process.cwd().
      upstreamSocket?.send(
        JSON.stringify({
          method: "turn/started",
          params: { threadId: "thread-nocwd", turn: { id: "turn-1" } },
        }),
      );
      await turnStarted;
      await delay(50);
      expect(
        bridge.listSessions().find((s) => s.id === "thread-nocwd"),
      ).toBeUndefined();

      const started = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "thread/started",
          params: {
            thread: { id: "thread-nocwd", cwd: "/tmp/project-late" },
          },
        }),
      );
      await started;
      await waitFor(
        () =>
          bridge.listSessions().find((s) => s.id === "thread-nocwd")
            ?.projectPath === "/tmp/project-late",
      );
    } finally {
      client.close();
    }
  });

  it("pushes a changed signal over /events on session state changes", async () => {
    const abort = new AbortController();
    const received: string[] = [];
    const streamReady = (async () => {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/events`, {
        headers: { accept: "text/event-stream" },
        signal: abort.signal,
      });
      expect(response.ok).toBe(true);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("no body");
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const line of buffer.split("\n")) {
          if (line.startsWith("event: ")) {
            received.push(line.slice("event: ".length).trim());
          }
        }
        if (received.includes("changed")) return;
      }
    })();

    const client = await connect(`ws://127.0.0.1:${bridgePort}`);
    try {
      await waitFor(() => upstreamSocket !== null);
      const started = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "thread/started",
          params: {
            thread: { id: "thread-sse", cwd: "/tmp/project-sse" },
          },
        }),
      );
      await started;
      const turnStarted = waitForJson(client);
      upstreamSocket?.send(
        JSON.stringify({
          method: "turn/started",
          params: { threadId: "thread-sse", turn: { id: "turn-1" } },
        }),
      );
      await turnStarted;

      await Promise.race([
        streamReady,
        delay(2000).then(() => {
          throw new Error("timed out waiting for changed signal");
        }),
      ]);
      expect(received).toContain("changed");
    } finally {
      abort.abort();
      client.close();
    }
  });

  it("restores persisted session metadata across bridge restarts", async () => {
    const statePath = join(
      tmpdir(),
      `codex-bridge-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    const portA = await findAvailablePort();
    const first = new CodexBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: portA,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      statePath,
    });
    await first.start();
    const client = await connect(`ws://127.0.0.1:${portA}`);
    try {
      await waitFor(() => upstreamSockets.length >= 1);
      const latestUpstream = upstreamSockets[upstreamSockets.length - 1];
      const started = waitForJson(client);
      latestUpstream?.send(
        JSON.stringify({
          method: "thread/started",
          params: {
            thread: {
              id: "thread-persist",
              cwd: "/tmp/project-persist",
              name: "Persisted session",
            },
          },
        }),
      );
      await started;
      const turnStarted = waitForJson(client);
      latestUpstream?.send(
        JSON.stringify({
          method: "turn/started",
          params: { threadId: "thread-persist", turn: { id: "turn-1" } },
        }),
      );
      await turnStarted;
      const completed = waitForJson(client);
      latestUpstream?.send(
        JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: "thread-persist",
            turn: { id: "turn-1", status: "completed" },
          },
        }),
      );
      await completed;
      const tokenUsage = waitForJson(client);
      latestUpstream?.send(
        JSON.stringify({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-persist",
            turnId: "turn-1",
            tokenUsage: {
              total: { totalTokens: 5000 },
              last: { inputTokens: 3200, totalTokens: 3400 },
              modelContextWindow: 16_000,
            },
          },
        }),
      );
      await tokenUsage;
      await waitFor(
        () =>
          first.listSessions().find((s) => s.id === "thread-persist")
            ?.contextUsage?.inputTokens === 3200,
      );
    } finally {
      client.close();
    }
    await first.shutdown();

    const portB = await findAvailablePort();
    const second = new CodexBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: portB,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      statePath,
    });
    await second.start();
    try {
      const restored = second
        .listSessions()
        .find((s) => s.id === "thread-persist");
      expect(restored).toMatchObject({
        id: "thread-persist",
        projectPath: "/tmp/project-persist",
        title: "Persisted session",
        messageCount: 1,
        activity: "idle",
        contextUsage: {
          inputTokens: 3200,
          percentage: 20,
          contextWindow: 16_000,
        },
      });
    } finally {
      await second.shutdown();
    }
  });
  it("replays the derived durable bridge journal and deduplicates lifecycle events after reconnect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-bridge-events-"));
    const statePath = join(directory, "sessions.json");
    const eventStorePath = deriveCodexBridgeEventStorePath(statePath);
    let first: CodexBridgeService | null = null;
    let second: CodexBridgeService | null = null;
    let firstClient: WebSocket | null = null;
    let secondClient: WebSocket | null = null;
    try {
      const firstPort = await findAvailablePort();
      first = new CodexBridgeService({
        enabled: true,
        host: "127.0.0.1",
        port: firstPort,
        upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
        statePath,
      });
      await first.start();
      firstClient = await connect(`ws://127.0.0.1:${firstPort}`);
      await waitFor(() => upstreamSockets.length >= 1);
      const firstForward = waitForJson(firstClient);
      upstreamSockets.at(-1)?.send(
        JSON.stringify({
          method: "turn/completed",
          emittedAtMs: 1_800_000_000_010,
          params: {
            threadId: "thread-durable-replay",
            turn: {
              id: "turn-durable-replay",
              status: "completed",
              items: [],
            },
          },
        }),
      );
      await firstForward;
      firstClient.close();
      firstClient = null;
      await first.shutdown();
      first = null;

      const secondPort = await findAvailablePort();
      second = new CodexBridgeService({
        enabled: true,
        host: "127.0.0.1",
        port: secondPort,
        upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
        statePath,
      });
      await second.start();
      secondClient = await connect(`ws://127.0.0.1:${secondPort}`);
      await waitFor(() => upstreamSockets.length >= 2);
      const replayForward = waitForJson(secondClient);
      upstreamSockets.at(-1)?.send(
        JSON.stringify({
          method: "turn/completed",
          emittedAtMs: 1_800_000_000_020,
          params: {
            threadId: "thread-durable-replay",
            turn: {
              id: "turn-durable-replay",
              status: "completed",
              items: [],
            },
          },
        }),
      );
      // A replayed wire event is still transparently forwarded to this client.
      await replayForward;
      secondClient.close();
      secondClient = null;
      await second.shutdown();
      second = null;

      const reopened = new JsonlCodexEventStore({ filePath: eventStorePath });
      const events = await reopened.replay({
        sessionId: "thread-durable-replay",
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        sequence: 1,
        method: "turn/completed",
        dedupeKey: "turn/completed:thread-durable-replay:turn-durable-replay",
        source: { replay: false },
      });
      const replayedState = await replayCodexSession(
        reopened,
        "thread-durable-replay",
      );
      expect(replayedState.threads["thread-durable-replay"]).toMatchObject({
        turns: {
          "turn-durable-replay": { status: "completed" },
        },
      });
    } finally {
      firstClient?.close();
      secondClient?.close();
      await first?.shutdown();
      await second?.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

class InspectableCodexEventStore implements CodexEventStore {
  readonly events: CodexEventEnvelope[] = [];
  private readonly inner = new InMemoryCodexEventStore();
  private nextAppendError: Error | undefined;
  private nextGate:
    | {
        reached: () => void;
        released: Promise<void>;
      }
    | undefined;

  pauseNextAppend(): { reached: Promise<void>; release: () => void } {
    if (this.nextGate) throw new Error("An append gate is already active");
    let markReached: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextGate = { reached: markReached, released };
    return { reached, release };
  }

  rejectNextAppend(message = "injected append failure"): void {
    if (this.nextAppendError) {
      throw new Error("An append error is already active");
    }
    this.nextAppendError = new Error(message);
  }

  async append(event: CodexEventDraft): Promise<CodexEventAppendResult> {
    const nextAppendError = this.nextAppendError;
    if (nextAppendError) {
      this.nextAppendError = undefined;
      throw nextAppendError;
    }
    const gate = this.nextGate;
    if (gate) {
      this.nextGate = undefined;
      gate.reached();
      await gate.released;
    }
    const result = await this.inner.append(event);
    if (result.inserted) this.events.push(result.event);
    return result;
  }

  async appendMany(
    events: readonly CodexEventDraft[],
  ): Promise<CodexEventAppendResult[]> {
    const results: CodexEventAppendResult[] = [];
    for (const event of events) {
      results.push(await this.append(event));
    }
    return results;
  }

  replay(query: CodexEventReplayQuery): Promise<CodexEventEnvelope[]> {
    return this.inner.replay(query);
  }

  latestSequence(sessionId: string): Promise<number> {
    return this.inner.latestSequence(sessionId);
  }

  latestEventAtMs(sessionId: string): Promise<number> {
    return this.inner.latestEventAtMs(sessionId);
  }
}

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

async function connect(
  url: string,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
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

async function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => ws.once("close", () => resolve()));
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
