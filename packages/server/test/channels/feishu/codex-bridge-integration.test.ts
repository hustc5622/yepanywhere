import { mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { FeishuDurableInbox } from "../../../src/channels/feishu/inbox.js";
import { FeishuInteractionManager } from "../../../src/channels/feishu/interaction-manager.js";
import type { FeishuMessageApi } from "../../../src/channels/feishu/normalization/types.js";
import { FeishuOperationStore } from "../../../src/channels/feishu/operation-store.js";
import type {
  FeishuInteractionApi,
  FeishuOutboundApi,
} from "../../../src/channels/feishu/outbound.js";
import { FeishuReplyManager } from "../../../src/channels/feishu/reply-manager.js";
import { CodexBridgeService } from "../../../src/codex-bridge/CodexBridgeService.js";
import type { JsonRpcMessage } from "../../../src/codex-bridge/types.js";
import { InMemoryCodexEventStore } from "../../../src/codex-events/index.js";
import { InteractionBroker } from "../../../src/interactions/InteractionBroker.js";
import { SessionInteractionService } from "../../../src/interactions/SessionInteractionService.js";
import type { RuntimeController } from "../../../src/runtime/types.js";
import { CodexProvider } from "../../../src/sdk/providers/codex.js";
import type { SDKMessage } from "../../../src/sdk/types.js";
import type { SessionCommandService } from "../../../src/services/SessionCommandService.js";

const THREAD_ID = "thread-feishu-bridge";
const TURN_ID = "turn-live";

describe("CodexBridgeService × Feishu integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(
      cleanups
        .splice(0)
        .reverse()
        .map((cleanup) => cleanup()),
    );
  });

  it("streams real bridge/provider delta, native item and terminal events into a fake Feishu card", async () => {
    const harness = await createBridgeHarness({ streamTurnOnSteer: true });
    cleanups.push(harness.cleanup);
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-bridge-reply-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));

    const { inbox, record } = await createDispatchedInboxRecord(dataDir);
    const eventStore = new InMemoryCodexEventStore();
    const provider = new CodexProvider({
      codexPath: "/path-that-must-not-be-spawned/codex",
      bridgeExecution: {
        mode: "external",
        controlUrl: `http://127.0.0.1:${harness.bridgePort}`,
      },
      eventSpine: { defaultMode: "primary", store: eventStore },
    });

    let emitRuntime: ((eventType: string, data: unknown) => void) | undefined;
    const cleanupSubscription = vi.fn();
    const sessionCommands = {
      subscribe: vi.fn(async (_sessionId, emit) => {
        emitRuntime = emit;
        emit("connected", {
          state: "in-turn",
          processId: "bridge-provider-process",
        });
        return { cleanup: cleanupSubscription };
      }),
    } as unknown as SessionCommandService;
    const api = makeReplyApi();
    const manager = new FeishuReplyManager({
      sessionCommandService: sessionCommands,
      inbox,
      controllerOptions: { throttleMs: 0 },
    });
    cleanups.push(() => manager.shutdown());

    const reply = await manager.startTurn({
      accountId: "team-bot",
      scopeKey: "team-bot:p2p:chat-1",
      projectId: "project-1",
      sessionId: THREAD_ID,
      tempId: record.tempId,
      inboxKeys: [record.key],
      replyMode: "card",
      requesterOpenId: "user-1",
      allowedOperatorOpenIds: ["user-1"],
      api,
      target: {
        chatId: "chat-1",
        replyToMessageId: "message-inbound",
        replyInThread: false,
      },
    });

    const session = await provider.startSession({
      cwd: "/repo",
      resumeSessionId: THREAD_ID,
      initialMessage: {
        text: "continue from Feishu",
        uuid: "feishu-client-message",
        tempId: record.tempId,
      },
      codexEventAccountId: "team-bot",
      codexEventProjectId: "project-1",
    });
    cleanups.push(async () => session.abort());
    await reply.dispatchAccepted(THREAD_ID, {
      processId: "bridge-provider-process",
    });

    const runtimeMessages: SDKMessage[] = [];
    for await (const message of session.iterator) {
      runtimeMessages.push(message);
      emitRuntime?.("message", message);
      if (message.type === "user") {
        emitRuntime?.("status", { state: "in-turn" });
      }
      if (message.type === "result") break;
    }
    emitRuntime?.("status", { state: "idle" });

    await eventually(() =>
      expect(inbox.get(record.key)?.status).toBe("completed"),
    );
    await eventually(() =>
      expect(api.finishStreamingReply).toHaveBeenCalledTimes(1),
    );
    const cardWrites = JSON.stringify([
      ...api.updateStreamingReply.mock.calls,
      ...api.finishStreamingReply.mock.calls,
    ]);
    expect(cardWrites).toContain(
      "Hello from bridge delta at /Users/developer/project/app.ts",
    );
    expect(cardWrites).toContain(
      "Final bridge answer: app.ts（`/Users/developer/project/app.ts:12`）",
    );
    expect(runtimeMessages).toContainEqual(
      expect.objectContaining({
        type: "assistant",
        codexThreadItemLifecycle: "completed",
        codexThreadId: THREAD_ID,
        codexTurnId: TURN_ID,
        codexThreadItemId: "agent-bridge",
        message: expect.objectContaining({
          content:
            "Final bridge answer: [app.ts](/Users/developer/project/app.ts:12)",
        }),
      }),
    );
    expect(
      runtimeMessages.find(
        (message) => message.codexThreadItemId === "agent-bridge",
      ),
    ).not.toHaveProperty("codexThreadItem");
    expect(
      harness.upstreamMessages.some(
        (message) => message.method === "turn/steer",
      ),
    ).toBe(true);
    expect(
      harness.upstreamMessages.some(
        (message) => message.method === "turn/start",
      ),
    ).toBe(false);

    const canonical = await eventStore.replay({ sessionId: THREAD_ID });
    expect(canonical.map((event) => event.method)).toEqual(
      expect.arrayContaining([
        "item/agentMessage/delta",
        "item/completed",
        "turn/completed",
      ]),
    );
    expect(canonical.some((event) => event.accountId === "team-bot")).toBe(
      true,
    );
    expect(JSON.stringify(canonical)).toContain(
      "/Users/developer/project/app.ts",
    );
    expect(harness.bridge.getStatus()).toMatchObject({
      journalMode: "lifecycle",
      metrics: {
        codex_bridge_canonical_ingress_count: 0,
        codex_bridge_delta_frames_total: expect.any(Number),
      },
    });
  });

  it("resolves a bridge-owned approval through a Feishu card and InteractionBroker exactly once", async () => {
    const harness = await createBridgeHarness({ streamTurnOnSteer: false });
    cleanups.push(harness.cleanup);
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-bridge-input-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));

    const approvalId = 900;
    const ownerForward = waitForJson(
      harness.ownerClient,
      (message) => message.id === approvalId,
    );
    harness.ownerUpstream.send(
      JSON.stringify({
        id: approvalId,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "command-1",
          command: "private command must stay off the card",
          cwd: "/private/repo",
          reason: "Needs approval",
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      }),
    );
    await ownerForward;

    const broker = new InteractionBroker();
    cleanups.push(async () => broker.shutdown());
    const runtimeController = {
      getProcessSnapshotForSession: vi.fn(async () => null),
    } as unknown as RuntimeController;
    const interactions = new SessionInteractionService({
      runtimeController,
      codexBridgeService: harness.bridge,
      interactionBroker: broker,
    });
    cleanups.push(async () => interactions.dispose());
    const commands = {
      getPendingInput: interactions.getPendingInput.bind(interactions),
      getInteractionOperation:
        interactions.getInteractionOperation.bind(interactions),
      respondToInput: interactions.respondToInput.bind(interactions),
      terminateInteractionOperations:
        interactions.terminateInteractionOperations.bind(interactions),
    } as unknown as SessionCommandService;
    const store = new FeishuOperationStore({ dataDir });
    await store.initialize();
    const manager = new FeishuInteractionManager({
      sessionCommandService: commands,
      operationStore: store,
    });
    cleanups.push(() => manager.shutdown());
    const api = makeInteractionApi();

    const pending = await interactions.getPendingInput(THREAD_ID);
    expect(pending?.interaction).toMatchObject({ state: "open", version: 0 });
    if (!pending?.interaction) throw new Error("missing broker operation");
    await manager.projectPendingInput(
      {
        accountId: "team-bot",
        sessionId: THREAD_ID,
        chatId: "chat-approval",
        replyToMessageId: "message-approval",
        requesterOpenId: "requester-1",
        allowedOperatorOpenIds: ["requester-1"],
        api,
      },
      pending,
    );
    const cardJson = JSON.stringify(api.createInputCard.mock.calls[0]?.[1]);
    expect(cardJson).toContain(pending.interaction.operationId);
    expect(cardJson).not.toContain("private command must stay off the card");
    expect(cardJson).not.toContain("/private/repo");

    const action = {
      accountId: "team-bot",
      event: {
        messageId: "card-message-approval",
        chatId: "chat-approval",
        operatorOpenId: "requester-1",
        actionTag: "button",
        value: {
          namespace: "yep-feishu",
          operationId: pending.interaction.operationId,
          operationVersion: pending.interaction.version,
          action: "approve",
        },
      },
      api,
    };
    await expect(
      Promise.all([
        manager.acceptCardAction(action),
        manager.acceptCardAction(action),
      ]),
    ).resolves.toEqual(["claimed", "claimed"]);

    await eventually(() => {
      const resolutions = harness.upstreamMessages.filter(
        (message) => message.id === approvalId && message.method === undefined,
      );
      expect(resolutions).toHaveLength(1);
      expect(resolutions[0]).toMatchObject({
        result: { decision: "accept" },
      });
    });
    expect(broker.get(pending.interaction.operationId)?.state).toBe("resolved");
    await expect(manager.acceptCardAction(action)).resolves.toBe(
      "already_processed",
    );
  });
});

interface BridgeHarness {
  bridge: CodexBridgeService;
  bridgePort: number;
  ownerClient: WebSocket;
  ownerUpstream: WebSocket;
  upstreamMessages: JsonRpcMessage[];
  cleanup: () => Promise<void>;
}

async function createBridgeHarness(options: {
  streamTurnOnSteer: boolean;
}): Promise<BridgeHarness> {
  const upstreamServer = createServer();
  const upstreamWss = new WebSocketServer({ server: upstreamServer });
  const upstreamSockets: WebSocket[] = [];
  const upstreamMessages: JsonRpcMessage[] = [];
  upstreamWss.on("connection", (socket) => {
    upstreamSockets.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as JsonRpcMessage;
      upstreamMessages.push(message);
      if (!message.method) return;
      if (message.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { userAgent: "fake-codex" },
          }),
        );
        return;
      }
      if (message.method === "config/read") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { config: { mcp_servers: {} }, origins: {} },
          }),
        );
        return;
      }
      if (message.method === "thread/read") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { thread: { id: THREAD_ID, cwd: "/repo" } },
          }),
        );
        return;
      }
      if (message.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: resumeResponse(),
          }),
        );
        return;
      }
      if (message.method === "turn/steer") {
        socket.send(
          JSON.stringify({ id: message.id, result: { turnId: TURN_ID } }),
        );
        if (options.streamTurnOnSteer) {
          setTimeout(() => streamCompletedTurn(socket), 0);
        }
      }
    });
  });
  await listen(upstreamServer);
  const upstreamPort = (upstreamServer.address() as AddressInfo).port;
  const bridgePort = await availablePort();
  const bridge = new CodexBridgeService({
    enabled: true,
    host: "127.0.0.1",
    port: bridgePort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    journalMode: "lifecycle",
  });
  await bridge.start();
  const ownerClient = await connect(`ws://127.0.0.1:${bridgePort}`);
  await eventually(() => expect(upstreamSockets.length).toBe(1));
  const ownerUpstream = upstreamSockets[0];
  if (!ownerUpstream) throw new Error("missing owner upstream");
  await sendRequest(ownerClient, 1, "initialize", {
    clientInfo: { name: "codex-tui", version: "test" },
    capabilities: { experimentalApi: true },
  });
  await sendRequest(ownerClient, 2, "thread/resume", { threadId: THREAD_ID });
  await eventually(() => expect(bridge.isSessionActive(THREAD_ID)).toBe(true));

  return {
    bridge,
    bridgePort,
    ownerClient,
    ownerUpstream,
    upstreamMessages,
    cleanup: async () => {
      ownerClient.close();
      await bridge.shutdown();
      for (const socket of upstreamWss.clients) socket.terminate();
      await closeWebSocketServer(upstreamWss);
      await closeServer(upstreamServer);
    },
  };
}

function resumeResponse() {
  return {
    thread: {
      id: THREAD_ID,
      cwd: "/repo",
      modelProvider: "openai",
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          id: TURN_ID,
          status: "inProgress",
          items: [],
          error: null,
        },
      ],
      forkedFromId: null,
    },
    model: "gpt-5.5",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/repo",
    reasoningEffort: null,
  };
}

function streamCompletedTurn(socket: WebSocket): void {
  const send = (method: string, params: unknown) =>
    socket.send(JSON.stringify({ method, params }));
  send("turn/started", {
    threadId: THREAD_ID,
    turn: { id: TURN_ID, status: "inProgress", items: [] },
  });
  send("item/started", {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: {
      id: "agent-bridge",
      type: "agentMessage",
      text: "",
      phase: "final_answer",
    },
  });
  send("item/agentMessage/delta", {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: "agent-bridge",
    delta: "Hello from bridge delta at /Users/developer/project/app.ts",
  });
  setTimeout(() => {
    send("item/completed", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: {
        id: "agent-bridge",
        type: "agentMessage",
        text: "Final bridge answer: [app.ts](/Users/developer/project/app.ts:12)",
        phase: "final_answer",
      },
    });
    send("turn/completed", {
      threadId: THREAD_ID,
      turn: {
        id: TURN_ID,
        status: "completed",
        items: [],
        error: null,
      },
    });
  }, 20);
}

async function createDispatchedInboxRecord(dataDir: string) {
  const inbox = new FeishuDurableInbox({ dataDir });
  await inbox.initialize();
  const { record } = await inbox.receive({
    accountId: "team-bot",
    eventId: "event-inbound",
    eventType: "im.message.receive_v1",
    messageId: "message-inbound",
    scopeKey: "team-bot:p2p:chat-1",
  });
  await inbox.beginDispatch(record.key, {
    scopeKey: "team-bot:p2p:chat-1",
    sessionId: THREAD_ID,
  });
  await inbox.markDispatched(record.key, { sessionId: THREAD_ID });
  return { inbox, record };
}

function makeReplyApi(): FeishuMessageApi &
  FeishuOutboundApi & {
    createStreamingReply: ReturnType<typeof vi.fn>;
    updateStreamingReply: ReturnType<typeof vi.fn>;
    finishStreamingReply: ReturnType<typeof vi.fn>;
  } {
  return {
    fetchMessageItems: vi.fn(async () => []),
    createStreamingReply: vi.fn(async () => ({
      cardId: "card-reply",
      messageId: "card-message-reply",
    })),
    updateStreamingReply: vi.fn(async () => undefined),
    finishStreamingReply: vi.fn(async () => undefined),
    sendTextReply: vi.fn(async () => ({ messageId: "text-reply" })),
  };
}

function makeInteractionApi(): FeishuMessageApi &
  FeishuInteractionApi & {
    createInputCard: ReturnType<typeof vi.fn>;
    updateInputCard: ReturnType<typeof vi.fn>;
  } {
  return {
    fetchMessageItems: vi.fn(async () => []),
    createInputCard: vi.fn(async () => ({
      cardId: "card-approval",
      messageId: "card-message-approval",
    })),
    updateInputCard: vi.fn(async () => undefined),
  };
}

async function sendRequest(
  socket: WebSocket,
  id: number,
  method: string,
  params: unknown,
): Promise<JsonRpcMessage> {
  const response = waitForJson(socket, (message) => message.id === id);
  socket.send(JSON.stringify({ id, method, params }));
  return await response;
}

function waitForJson(
  socket: WebSocket,
  predicate: (message: JsonRpcMessage) => boolean = () => true,
  timeoutMs = 3_000,
): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for JSON-RPC message"));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as JsonRpcMessage;
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  await closeServer(server);
  return port;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function eventually(
  assertion: () => void,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (caught) {
      error = caught;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw error;
}
