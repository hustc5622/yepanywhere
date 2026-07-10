import { type ChildProcess, spawn } from "node:child_process";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { basename } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { getCodexSubagentMetadata } from "../codex/subagent.js";
import { encodeProjectId } from "../projects/paths.js";
import { findCodexCliPath } from "../sdk/cli-detection.js";
import type { SessionSummary } from "../supervisor/types.js";
import type { EventBus } from "../watcher/index.js";
import { bridgeOwnership, isLiveBridgeSession } from "./session-state.js";
import type {
  CodexBridgeController,
  CodexBridgeInputResponse,
  CodexBridgeMcpStartupEvent,
  CodexBridgePendingInput,
  CodexBridgeSession,
  CodexBridgeSessionView,
  CodexBridgeStatus,
  CodexBridgeUpstreamProfile,
  JsonRpcId,
  JsonRpcMessage,
} from "./types.js";

interface CodexBridgeServiceOptions {
  enabled: boolean;
  host: string;
  port: number;
  upstreamUrl?: string;
  upstreamStartPort?: number;
  lightUpstreamArgs?: string[];
  clearUpstreamArgs?: string[];
  fullUpstreamArgs?: string[];
  upstreamArgs?: string[];
  codexPath?: string;
  eventBus?: EventBus;
  startupTimeoutMs?: number;
}

interface ClientRequestRecord {
  method: string;
  params?: unknown;
}

interface BridgeConnection {
  id: number;
  profile: CodexBridgeUpstreamProfile;
  downstream: WebSocket;
  upstream: WebSocket | null;
  downstreamQueue: QueuedFrame[];
  pendingClientRequests: Map<string, ClientRequestRecord>;
  pendingServerRequests: Map<string, PendingServerRequest>;
  resolvedServerRequestIds: Set<string>;
  threadIds: Set<string>;
  closed: boolean;
}

interface QueuedFrame {
  data: RawData;
  isBinary: boolean;
}

interface ForwardedFrame {
  data: RawData;
  isBinary: boolean;
}

interface PendingServerRequest {
  inputId: string;
  rpcId: JsonRpcId;
  rpcKey: string;
  requestKey: string;
  method: string;
  params: Record<string, unknown>;
  threadId: string;
  turnId?: string;
  itemId?: string;
  inputRequest: CodexBridgePendingInput["request"];
  pendingInputType: "tool-approval" | "user-question";
  connection: BridgeConnection;
  createdAt: string;
}

interface SessionRecord {
  id: string;
  isSubagent: boolean;
  threadMetadataKnown: boolean;
  parentThreadId?: string;
  agentPath?: string;
  agentNickname?: string;
  agentRole?: string;
  projectId: UrlProjectId;
  projectPath: string;
  projectName: string;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  activity?: "in-turn" | "idle" | "waiting-input";
  pendingInputType?: "tool-approval" | "user-question";
  connectionIds: Set<number>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const JSON_RPC_VERSION = "2.0";
const MAX_MCP_STARTUP_EVENTS = 50;

interface CodexBridgeUpstreamState {
  process: ChildProcess | null;
  url: string | null;
  startPromise: Promise<string> | null;
}

export class CodexBridgeService implements CodexBridgeController {
  private readonly enabled: boolean;
  private readonly host: string;
  private readonly port: number;
  private readonly upstreamUrlOverride?: string;
  private readonly upstreamStartPort?: number;
  private readonly upstreamArgsByProfile: Record<
    CodexBridgeUpstreamProfile,
    string[]
  >;
  private readonly codexPathOverride?: string;
  private readonly eventBus?: EventBus;
  private readonly startupTimeoutMs: number;

  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private listening = false;
  private lastError: string | null = null;
  private nextConnectionId = 1;
  private connections = new Map<number, BridgeConnection>();
  private sessions = new Map<string, SessionRecord>();
  private emittedSessionIds = new Set<string>();
  private pendingByInputId = new Map<string, PendingServerRequest>();
  private pendingIdsByThread = new Map<string, Set<string>>();
  private recentMcpStartupEvents: CodexBridgeMcpStartupEvent[] = [];
  private upstreams = new Map<
    CodexBridgeUpstreamProfile,
    CodexBridgeUpstreamState
  >();
  private reservedUpstreamPorts = new Set<number>();

  constructor(options: CodexBridgeServiceOptions) {
    this.enabled = options.enabled;
    this.host = options.host;
    this.port = options.port;
    this.upstreamUrlOverride = options.upstreamUrl;
    this.upstreamStartPort = options.upstreamStartPort;
    this.upstreamArgsByProfile = {
      clear: options.clearUpstreamArgs ?? [],
      light: options.lightUpstreamArgs ?? options.upstreamArgs ?? [],
      full: options.fullUpstreamArgs ?? [],
    };
    this.codexPathOverride = options.codexPath;
    this.eventBus = options.eventBus;
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (!this.enabled || this.server) {
      return;
    }

    const server = createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      });
    });
    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.server = server;
    this.wss = wss;

    await new Promise<void>((resolve) => {
      const onError = (error: Error) => {
        this.lastError = error.message;
        this.listening = false;
        this.server = null;
        this.wss = null;
        wss.close();
        console.warn(
          `[CodexBridge] Failed to listen on ws://${this.host}:${this.port}: ${error.message}`,
        );
        cleanup();
        resolve();
      };
      const onListening = () => {
        this.listening = true;
        this.lastError = null;
        console.log(
          `[CodexBridge] Listening on ws://${this.host}:${this.port}`,
        );
        cleanup();
        resolve();
      };
      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, this.host);
    });

    server.on("error", (error) => {
      this.lastError = error.message;
      console.warn(`[CodexBridge] Server error: ${error.message}`);
    });
  }

  async shutdown(): Promise<void> {
    for (const connection of this.connections.values()) {
      this.closeConnection(connection, "shutdown");
    }
    this.connections.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
      this.wss = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
    this.listening = false;
    await this.stopManagedUpstream();
  }

  getStatus(): CodexBridgeStatus {
    return {
      enabled: this.enabled,
      listening: this.listening,
      host: this.host,
      port: this.port,
      url: `ws://${this.host}:${this.port}`,
      upstreamUrl: this.upstreamUrlOverride ?? this.getManagedUpstreamUrl(),
      upstreamRunning: this.isAnyManagedUpstreamRunning(),
      upstreamMode: this.upstreamUrlOverride ? "external" : "managed",
      upstreams: {
        clear: this.getUpstreamStatus("clear"),
        light: this.getUpstreamStatus("light"),
        full: this.getUpstreamStatus("full"),
      },
      connectionCount: this.connections.size,
      sessionCount: Array.from(this.sessions.values()).filter((record) =>
        this.isTopLevelSessionRecord(record),
      ).length,
      pendingInputCount: this.pendingByInputId.size,
      recentMcpStartupEvents: this.recentMcpStartupEvents.map((event) => ({
        ...event,
      })),
      lastError: this.lastError,
    };
  }

  listSessionViews(): CodexBridgeSessionView[] {
    return this.listSessions()
      .filter((session) => this.isDisplayableBridgeSession(session))
      .map((session) => ({
        session: this.toSessionSummary(session),
        projectName: session.projectName,
        activity: session.activity,
        pendingInputType: session.pendingInputType,
      }));
  }

  listSessions(): CodexBridgeSession[] {
    return Array.from(this.sessions.values())
      .filter((record) => this.isTopLevelSessionRecord(record))
      .map((record) => this.toBridgeSession(record))
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
  }

  getSessionView(sessionId: string): CodexBridgeSessionView | null {
    const record = this.sessions.get(sessionId);
    if (!record || !this.isTopLevelSessionRecord(record)) return null;
    const session = this.toBridgeSession(record);
    if (!this.isDisplayableBridgeSession(session)) return null;
    return {
      session: this.toSessionSummary(session),
      projectName: session.projectName,
      activity: session.activity,
      pendingInputType: session.pendingInputType,
    };
  }

  isSessionActive(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    return (
      !!record &&
      this.isTopLevelSessionRecord(record) &&
      isLiveBridgeSession(this.toBridgeSession(record))
    );
  }

  getPendingInputRequest(
    sessionId: string,
  ): CodexBridgePendingInput["request"] | null {
    const pending = this.findPendingForVisibleSession(sessionId);
    if (!pending) return null;
    return {
      ...pending.inputRequest,
      sessionId: this.getTopLevelSessionId(pending.threadId),
    };
  }

  respondToInput(
    sessionId: string,
    requestId: string,
    response: CodexBridgeInputResponse,
    answers?: Record<string, string>,
  ): boolean {
    const pending = this.pendingByInputId.get(requestId);
    if (
      !pending ||
      (pending.threadId !== sessionId &&
        this.getTopLevelSessionId(pending.threadId) !== sessionId)
    ) {
      return false;
    }
    if (
      !pending.connection.upstream ||
      pending.connection.upstream.readyState !== WebSocket.OPEN
    ) {
      return false;
    }

    const result = this.buildServerRequestResponse(pending, response, answers);
    const message: JsonRpcMessage = {
      jsonrpc: JSON_RPC_VERSION,
      id: pending.rpcId,
      result,
    };
    pending.connection.upstream.send(JSON.stringify(message));
    pending.connection.resolvedServerRequestIds.add(pending.rpcKey);
    this.resolvePendingRequest(pending, "yep");
    return true;
  }

  private getTopLevelSessionId(threadId: string): string {
    let currentId = threadId;
    const visited = new Set<string>();

    while (!visited.has(currentId)) {
      visited.add(currentId);
      const record = this.sessions.get(currentId);
      if (!record?.isSubagent || !record.parentThreadId) {
        return currentId;
      }
      currentId = record.parentThreadId;
    }

    return threadId;
  }

  private findPendingForVisibleSession(
    sessionId: string,
  ): PendingServerRequest | null {
    for (const pending of this.pendingByInputId.values()) {
      if (
        pending.threadId === sessionId ||
        this.getTopLevelSessionId(pending.threadId) === sessionId
      ) {
        return pending;
      }
    }
    return null;
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathParts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));

    if (req.method === "GET" && url.pathname === "/readyz") {
      this.writeJson(res, 200, this.getStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      this.writeJson(res, 200, this.getStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/sessions") {
      this.writeJson(res, 200, { sessions: this.listSessions() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/session-views") {
      this.writeJson(res, 200, { sessions: this.listSessionViews() });
      return;
    }

    if (pathParts[0] === "sessions" && pathParts[1]) {
      const sessionId = pathParts[1];
      if (req.method === "GET" && pathParts.length === 2) {
        const session =
          this.listSessions().find((candidate) => candidate.id === sessionId) ??
          null;
        this.writeJson(res, 200, { session });
        return;
      }
      if (req.method === "GET" && pathParts[2] === "view") {
        this.writeJson(res, 200, {
          sessionView: this.getSessionView(sessionId),
        });
        return;
      }
      if (req.method === "GET" && pathParts[2] === "active") {
        this.writeJson(res, 200, {
          active: this.isSessionActive(sessionId),
        });
        return;
      }
      if (req.method === "GET" && pathParts[2] === "pending-input") {
        this.writeJson(res, 200, {
          request: this.getPendingInputRequest(sessionId),
        });
        return;
      }
      if (req.method === "POST" && pathParts[2] === "input") {
        const body = await readJsonBody(req);
        const requestId =
          body && typeof body.requestId === "string" ? body.requestId : null;
        const response = parseBridgeInputResponse(body?.response);
        const answers =
          body && typeof body.answers === "object" && body.answers !== null
            ? (body.answers as Record<string, string>)
            : undefined;

        if (!requestId || !response) {
          this.writeJson(res, 400, {
            error: "requestId and response are required",
          });
          return;
        }

        this.writeJson(res, 200, {
          accepted: this.respondToInput(
            sessionId,
            requestId,
            response,
            answers,
          ),
        });
        return;
      }
    }

    this.writeJson(res, 404, { error: "Not found" });
  }

  private writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private handleConnection(downstream: WebSocket, req: IncomingMessage): void {
    const remoteAddress = req.socket.remoteAddress ?? "";
    if (!this.isLocalAddress(remoteAddress)) {
      downstream.close(1008, "Codex bridge only accepts local connections");
      return;
    }

    const profile = parseMcpProfile(req.url, req.headers.authorization);
    const connection: BridgeConnection = {
      id: this.nextConnectionId++,
      profile,
      downstream,
      upstream: null,
      downstreamQueue: [],
      pendingClientRequests: new Map(),
      pendingServerRequests: new Map(),
      resolvedServerRequestIds: new Set(),
      threadIds: new Set(),
      closed: false,
    };
    this.connections.set(connection.id, connection);
    console.log(
      `[CodexBridge] Connection ${connection.id} profile=${profile} request=${req.url ?? "/"}`,
    );

    downstream.on("message", (data, isBinary) => {
      if (!this.observeClientData(connection, data)) {
        return;
      }
      if (connection.upstream?.readyState === WebSocket.OPEN) {
        sendFrame(connection.upstream, data, isBinary);
      } else {
        connection.downstreamQueue.push({ data, isBinary });
      }
    });
    downstream.on("close", () => this.closeConnection(connection, "client"));
    downstream.on("error", (error) => {
      this.lastError = error.message;
      this.closeConnection(connection, "client-error");
    });

    this.connectUpstream(connection).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      console.warn(`[CodexBridge] Upstream connection failed: ${message}`);
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.close(1011, "Failed to connect Codex app-server");
      }
      this.closeConnection(connection, "upstream-connect-error");
    });
  }

  private async connectUpstream(connection: BridgeConnection): Promise<void> {
    const upstreamUrl = await this.ensureUpstreamUrl(connection.profile);
    if (connection.closed) return;

    await new Promise<void>((resolve, reject) => {
      const upstream = new WebSocket(upstreamUrl);
      connection.upstream = upstream;

      upstream.on("open", () => {
        console.log(
          `[CodexBridge] Connection ${connection.id} profile=${connection.profile} upstream=${upstreamUrl}`,
        );
        while (
          connection.downstreamQueue.length > 0 &&
          upstream.readyState === WebSocket.OPEN
        ) {
          const frame = connection.downstreamQueue.shift();
          if (frame !== undefined) {
            sendFrame(upstream, frame.data, frame.isBinary);
          }
        }
        resolve();
      });

      upstream.on("message", (data, isBinary) => {
        const forwardedFrame = this.observeServerData(
          connection,
          data,
          isBinary,
        );
        if (connection.downstream.readyState === WebSocket.OPEN) {
          if (forwardedFrame) {
            sendFrame(
              connection.downstream,
              forwardedFrame.data,
              forwardedFrame.isBinary,
            );
          }
        }
      });

      upstream.on("close", () => this.closeConnection(connection, "upstream"));
      upstream.on("error", (error) => {
        this.lastError = error.message;
        reject(error);
      });
    });
  }

  private closeConnection(connection: BridgeConnection, reason: string): void {
    if (connection.closed) return;
    connection.closed = true;

    this.connections.delete(connection.id);
    for (const pending of connection.pendingServerRequests.values()) {
      this.resolvePendingRequest(pending, reason);
    }
    connection.pendingServerRequests.clear();

    if (connection.downstream.readyState === WebSocket.OPEN) {
      connection.downstream.close();
    }
    if (connection.upstream?.readyState === WebSocket.OPEN) {
      connection.upstream.close();
    }

    for (const threadId of connection.threadIds) {
      const record = this.sessions.get(threadId);
      if (!record) continue;
      record.connectionIds.delete(connection.id);
      record.updatedAt = new Date().toISOString();
      if (record.connectionIds.size === 0) {
        record.activity = "idle";
        record.pendingInputType = undefined;
        this.emitSessionStatus(record, { owner: "none" });
        this.emitProcessState(record, "idle");
      }
    }
  }

  private observeClientData(
    connection: BridgeConnection,
    data: RawData,
  ): boolean {
    const messages = parseJsonRpcData(data);
    if (!messages) {
      return true;
    }

    let shouldForward = true;
    for (const message of messages) {
      if (message.method && message.id !== undefined) {
        connection.pendingClientRequests.set(idKey(message.id), {
          method: message.method,
          params: message.params,
        });
        continue;
      }

      if (!message.method && message.id !== undefined) {
        const key = idKey(message.id);
        const pending = this.findPendingByConnectionAndRpcId(
          connection,
          message.id,
        );
        if (pending) {
          this.resolvePendingRequest(pending, "tui");
        }
        if (connection.resolvedServerRequestIds.has(key)) {
          shouldForward = false;
        }
      }
    }

    return shouldForward;
  }

  private observeServerData(
    connection: BridgeConnection,
    data: RawData,
    isBinary: boolean,
  ): ForwardedFrame | null {
    const envelope = parseJsonRpcEnvelope(data);
    const messages = envelope?.messages;
    if (!messages) {
      return { data, isBinary };
    }

    const messagesToForward: JsonRpcMessage[] = [];
    for (const message of messages) {
      if (message.method && message.id !== undefined) {
        this.recordServerRequest(connection, message);
        messagesToForward.push(message);
        continue;
      }

      if (message.method) {
        this.handleServerNotification(
          connection,
          message.method,
          message.params,
        );
        if (message.method !== "mcpServer/startupStatus/updated") {
          messagesToForward.push(message);
        }
        continue;
      }

      if (message.id !== undefined) {
        const request = connection.pendingClientRequests.get(idKey(message.id));
        if (request) {
          connection.pendingClientRequests.delete(idKey(message.id));
          this.handleClientRequestResponse(connection, request, message);
        }
      }
      messagesToForward.push(message);
    }

    if (messagesToForward.length === messages.length) {
      return { data, isBinary };
    }

    if (messagesToForward.length === 0) {
      return null;
    }

    return {
      data: Buffer.from(
        JSON.stringify(
          envelope.isBatch ? messagesToForward : messagesToForward[0],
        ),
      ),
      isBinary: false,
    };
  }

  private handleClientRequestResponse(
    connection: BridgeConnection,
    request: ClientRequestRecord,
    response: JsonRpcMessage,
  ): void {
    if (
      request.method !== "thread/start" &&
      request.method !== "thread/resume" &&
      request.method !== "thread/fork" &&
      request.method !== "thread/read"
    ) {
      return;
    }

    const result = asRecord(response.result);
    if (!result) return;
    const thread = asRecord(result.thread);
    if (!thread) return;

    this.upsertThread(connection, thread, {
      cwd: getString(result.cwd) ?? getString(thread.cwd),
      model: getString(result.model),
      reasoningEffort: getString(result.reasoningEffort),
      serviceTier: getString(result.serviceTier),
    });
  }

  private handleServerNotification(
    connection: BridgeConnection,
    method: string,
    params: unknown,
  ): void {
    const p = asRecord(params);
    switch (method) {
      case "item/started":
      case "item/completed": {
        this.recordCollaborationThreadMetadata(p);
        break;
      }
      case "thread/started": {
        const thread = asRecord(p?.thread);
        if (thread) {
          this.upsertThread(connection, thread, {
            cwd: getString(thread.cwd),
            model: getString(thread.model),
          });
        }
        break;
      }
      case "thread/status/changed": {
        const threadId = getString(p?.threadId);
        if (!threadId) break;
        this.trackThreadConnection(connection, threadId);
        const record = this.ensureSessionRecord(threadId, {});
        const activity = this.activityFromThreadStatus(p?.status);
        record.activity = activity;
        if (activity !== "waiting-input") {
          record.pendingInputType = undefined;
        }
        record.updatedAt = new Date().toISOString();
        this.emitSessionStatus(
          record,
          bridgeOwnership(this.isSessionActive(threadId)),
        );
        this.emitProcessState(record, activity, record.pendingInputType);
        break;
      }
      case "thread/name/updated": {
        const threadId = getString(p?.threadId);
        if (!threadId) break;
        const record = this.sessions.get(threadId);
        if (!record) break;
        const name = getString(p?.threadName);
        if (name) {
          record.title = name;
          record.fullTitle = name;
          record.updatedAt = new Date().toISOString();
          this.emitSessionUpdated(record);
        }
        break;
      }
      case "turn/started": {
        const threadId = getString(p?.threadId);
        if (!threadId) break;
        this.trackThreadConnection(connection, threadId);
        const record = this.ensureSessionRecord(threadId, {});
        record.activity = "in-turn";
        record.updatedAt = new Date().toISOString();
        this.emitSessionCreated(record);
        this.emitSessionStatus(record, { owner: "external" });
        this.emitProcessState(record, "in-turn");
        break;
      }
      case "turn/completed": {
        const threadId = getString(p?.threadId);
        if (!threadId) break;
        const record = this.sessions.get(threadId);
        if (!record) break;
        record.messageCount += 1;
        record.activity = "idle";
        record.pendingInputType = undefined;
        record.updatedAt = new Date().toISOString();
        this.emitSessionCreated(record);
        this.emitSessionUpdated(record);
        this.emitSessionStatus(
          record,
          bridgeOwnership(this.isSessionActive(threadId)),
        );
        this.emitProcessState(record, "idle");
        break;
      }
      case "serverRequest/resolved": {
        const threadId = getString(p?.threadId);
        const requestId = p?.requestId as JsonRpcId | undefined;
        if (!threadId || requestId === undefined) break;
        const pending = this.findPendingByThreadAndRpcId(threadId, requestId);
        if (pending) {
          pending.connection.resolvedServerRequestIds.add(pending.requestKey);
          this.resolvePendingRequest(pending, "server");
        }
        break;
      }
      case "mcpServer/startupStatus/updated": {
        this.recordMcpStartupStatus(connection, p);
        break;
      }
    }
  }

  private recordCollaborationThreadMetadata(
    params: Record<string, unknown> | null,
  ): void {
    const item = asRecord(params?.item);
    if (!item) return;

    const itemType = getString(item.type);
    if (itemType === "subAgentActivity") {
      const parentThreadId = getString(params?.threadId);
      const agentThreadId = getString(item.agentThreadId);
      if (!parentThreadId || !agentThreadId) return;
      this.registerSubagentThread(parentThreadId, agentThreadId, {
        agentPath: getString(item.agentPath),
        activityKind: getString(item.kind),
      });
      return;
    }

    if (
      itemType !== "collabAgentToolCall" ||
      getString(item.tool) !== "spawnAgent"
    ) {
      return;
    }

    const parentThreadId =
      getString(item.senderThreadId) ?? getString(params?.threadId);
    if (!parentThreadId || !Array.isArray(item.receiverThreadIds)) return;

    for (const receiverThreadId of item.receiverThreadIds) {
      if (typeof receiverThreadId !== "string") continue;
      this.registerSubagentThread(parentThreadId, receiverThreadId);
    }
  }

  private registerSubagentThread(
    parentThreadId: string,
    threadId: string,
    metadata: { agentPath?: string; activityKind?: string } = {},
  ): void {
    const parent = this.sessions.get(parentThreadId);
    const record = this.ensureSessionRecord(threadId, {
      cwd: parent?.projectPath,
      isSubagent: true,
      threadMetadataKnown: true,
      parentThreadId,
      agentPath: metadata.agentPath,
    });

    if (
      metadata.activityKind === "started" ||
      metadata.activityKind === "interacted"
    ) {
      record.activity = "in-turn";
    } else if (metadata.activityKind === "interrupted") {
      record.activity = "idle";
    }
    record.updatedAt = new Date().toISOString();
  }

  private recordMcpStartupStatus(
    connection: BridgeConnection,
    params: Record<string, unknown> | null,
  ): void {
    const event: CodexBridgeMcpStartupEvent = {
      timestamp: new Date().toISOString(),
      profile: connection.profile,
      connectionId: connection.id,
      error: formatDiagnosticValue(params?.error),
    };
    const threadId = getString(params?.threadId);
    const name = getString(params?.name);
    const status = getString(params?.status);
    if (threadId) event.threadId = threadId;
    if (name) event.name = name;
    if (status) event.status = status;

    this.recentMcpStartupEvents.push(event);
    if (this.recentMcpStartupEvents.length > MAX_MCP_STARTUP_EVENTS) {
      this.recentMcpStartupEvents.splice(
        0,
        this.recentMcpStartupEvents.length - MAX_MCP_STARTUP_EVENTS,
      );
    }

    console.log(
      [
        "[CodexBridge] MCP startup",
        `profile=${event.profile}`,
        `connection=${event.connectionId}`,
        event.threadId ? `thread=${event.threadId}` : null,
        event.name ? `server=${event.name}` : null,
        event.status ? `status=${event.status}` : null,
        event.error ? `error=${event.error}` : null,
      ]
        .filter((part): part is string => typeof part === "string")
        .join(" "),
    );
  }

  private recordServerRequest(
    connection: BridgeConnection,
    message: JsonRpcMessage,
  ): void {
    if (message.id === undefined || !message.method) return;
    if (!isUserResolvableServerRequest(message.method)) return;

    const params = asRecord(message.params) ?? {};
    const threadId = getString(params.threadId);
    if (!threadId) return;

    this.trackThreadConnection(connection, threadId);

    const rpcKey = idKey(message.id);
    const requestKey = this.buildPendingInputId(message, threadId, params);
    connection.resolvedServerRequestIds.delete(rpcKey);
    const createdAt = new Date().toISOString();
    const inputRequest = this.toInputRequest(
      requestKey,
      message.method,
      threadId,
      params,
      createdAt,
    );
    const pendingInputType =
      inputRequest.type === "tool-approval" ? "tool-approval" : "user-question";
    const pending: PendingServerRequest = {
      inputId: requestKey,
      rpcId: message.id,
      rpcKey,
      requestKey,
      method: message.method,
      params,
      threadId,
      turnId: getString(params.turnId),
      itemId: getString(params.itemId),
      inputRequest,
      pendingInputType,
      connection,
      createdAt,
    };

    connection.pendingServerRequests.set(requestKey, pending);
    this.pendingByInputId.set(requestKey, pending);
    let ids = this.pendingIdsByThread.get(threadId);
    if (!ids) {
      ids = new Set();
      this.pendingIdsByThread.set(threadId, ids);
    }
    ids.add(requestKey);

    const cwd = getString(params.cwd);
    const record = this.ensureSessionRecord(threadId, cwd ? { cwd } : {});
    record.activity = "waiting-input";
    record.pendingInputType = pendingInputType;
    record.updatedAt = createdAt;

    const visibleRecord =
      this.sessions.get(this.getTopLevelSessionId(threadId)) ?? record;
    if (visibleRecord !== record) {
      visibleRecord.activity = "waiting-input";
      visibleRecord.pendingInputType = pendingInputType;
      visibleRecord.updatedAt = createdAt;
    }
    this.emitSessionCreated(visibleRecord);
    this.emitSessionStatus(visibleRecord, { owner: "external" });
    this.emitProcessState(visibleRecord, "waiting-input", pendingInputType);
  }

  private toInputRequest(
    id: string,
    method: string,
    threadId: string,
    params: Record<string, unknown>,
    timestamp: string,
  ): CodexBridgePendingInput["request"] {
    if (method === "item/tool/requestUserInput") {
      const questions = normalizeCodexQuestions(params.questions);
      return {
        id,
        sessionId: threadId,
        type: "question",
        prompt: questions[0]?.question ?? "Codex needs input",
        toolName: "AskUserQuestion",
        toolInput: { questions, codexQuestions: params.questions ?? [] },
        timestamp,
      };
    }

    if (method === "mcpServer/elicitation/request") {
      if (isMcpToolApprovalElicitation(params)) {
        const meta = getElicitationMeta(params);
        const prompt = getString(params.message) ?? "Allow MCP tool execution?";
        const serverName =
          getString(params.serverName) ??
          getString(meta?.connector_name) ??
          getString(meta?.connector_id);
        const mcpToolName =
          getString(meta?.tool_name) ?? parseMcpToolNameFromPrompt(prompt);
        const toolTitle = getString(meta?.tool_title) ?? mcpToolName;

        return {
          id,
          sessionId: threadId,
          type: "tool-approval",
          prompt,
          toolName: "MCP",
          toolInput: {
            approvalKind: "mcp_tool_call",
            approvalPrompt: prompt,
            serverName,
            mcpToolName,
            toolTitle,
            toolDescription: meta?.tool_description,
            toolParams: meta?.tool_params,
            toolParamsDisplay: meta?.tool_params_display,
            persistScopes: normalizeMcpPersistScopes(meta?.persist),
            threadId,
            turnId: params.turnId,
            raw: params,
          },
          timestamp,
        };
      }

      return {
        id,
        sessionId: threadId,
        type: "question",
        prompt: getString(params.message) ?? "Codex needs MCP input",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            {
              question: getString(params.message) ?? "Response",
              options: [],
            },
          ],
          raw: params,
        },
        timestamp,
      };
    }

    if (method === "item/permissions/requestApproval") {
      return {
        id,
        sessionId: threadId,
        type: "tool-approval",
        prompt: getString(params.reason) ?? "Allow requested permissions?",
        toolName: "Permissions",
        toolInput: {
          cwd: params.cwd,
          reason: params.reason,
          permissions: params.permissions,
          environmentId: params.environmentId,
          threadId,
          turnId: params.turnId,
          itemId: params.itemId,
        },
        timestamp,
      };
    }

    if (
      method === "item/fileChange/requestApproval" ||
      method === "applyPatchApproval"
    ) {
      return {
        id,
        sessionId: threadId,
        type: "tool-approval",
        prompt: "Allow file changes?",
        toolName: "Edit",
        toolInput: {
          reason: params.reason,
          grantRoot: params.grantRoot,
          fileChanges: params.fileChanges,
          threadId,
          turnId: params.turnId,
          itemId: params.itemId,
        },
        timestamp,
      };
    }

    return {
      id,
      sessionId: threadId,
      type: "tool-approval",
      prompt: "Allow command?",
      toolName: "Bash",
      toolInput: {
        command: params.command,
        cwd: params.cwd,
        reason: params.reason,
        commandActions: params.commandActions,
        additionalPermissions: params.additionalPermissions,
        availableDecisions: params.availableDecisions,
        networkApprovalContext: params.networkApprovalContext,
        proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
        proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
        threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        approvalId: params.approvalId,
      },
      timestamp,
    };
  }

  private buildServerRequestResponse(
    pending: PendingServerRequest,
    response: CodexBridgeInputResponse,
    answers?: Record<string, string>,
  ): unknown {
    const approved = response !== "deny";
    const approveForSession =
      response === "approve_accept_edits" || response === "approve_for_session";
    const approveAlways = response === "approve_always";

    switch (pending.method) {
      case "item/commandExecution/requestApproval":
        return {
          decision: approved
            ? approveForSession
              ? this.getCommandPersistentApprovalDecision(pending.params)
              : "accept"
            : "decline",
        };
      case "item/fileChange/requestApproval":
        return {
          decision: approved
            ? approveForSession
              ? "acceptForSession"
              : "accept"
            : "decline",
        };
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: approved ? "approved" : "denied" };
      case "item/permissions/requestApproval": {
        if (!approved) {
          return { permissions: {}, scope: "turn" };
        }
        const requested = asRecord(pending.params.permissions);
        const granted: Record<string, unknown> = {};
        const network = requested ? requested.network : undefined;
        const fileSystem = requested ? requested.fileSystem : undefined;
        if (network !== null && network !== undefined)
          granted.network = network;
        if (fileSystem !== null && fileSystem !== undefined)
          granted.fileSystem = fileSystem;
        return {
          permissions: granted,
          scope: approveForSession ? "session" : "turn",
        };
      }
      case "item/tool/requestUserInput":
        return {
          answers: buildCodexUserInputAnswers(
            pending.params.questions,
            answers,
          ),
        };
      case "mcpServer/elicitation/request":
        if (isMcpToolApprovalElicitation(pending.params)) {
          if (!approved) {
            return { action: "cancel" };
          }
          const content: Record<string, unknown> = {};
          if (approveForSession) content.persist = "session";
          if (approveAlways) content.persist = "always";
          return Object.keys(content).length > 0
            ? { action: "accept", content }
            : { action: "accept" };
        }
        return approved ? { values: answers ?? {} } : { values: {} };
      default:
        return {};
    }
  }

  private resolvePendingRequest(
    pending: PendingServerRequest,
    _source: string,
  ): void {
    this.pendingByInputId.delete(pending.inputId);
    pending.connection.pendingServerRequests.delete(pending.requestKey);
    const ids = this.pendingIdsByThread.get(pending.threadId);
    if (ids) {
      ids.delete(pending.inputId);
      if (ids.size === 0) {
        this.pendingIdsByThread.delete(pending.threadId);
      }
    }

    const record = this.sessions.get(pending.threadId);
    if (!record) return;

    this.updatePendingState(
      record,
      this.findPendingForThread(pending.threadId),
    );

    const visibleRecord = this.sessions.get(
      this.getTopLevelSessionId(pending.threadId),
    );
    if (visibleRecord && visibleRecord !== record) {
      this.updatePendingState(
        visibleRecord,
        this.findPendingForVisibleSession(visibleRecord.id),
      );
    }
  }

  private findPendingForThread(threadId: string): PendingServerRequest | null {
    const ids = this.pendingIdsByThread.get(threadId);
    if (!ids) return null;
    for (const id of ids) {
      const pending = this.pendingByInputId.get(id);
      if (pending) return pending;
    }
    return null;
  }

  private updatePendingState(
    record: SessionRecord,
    pending: PendingServerRequest | null,
  ): void {
    record.updatedAt = new Date().toISOString();
    if (pending) {
      record.activity = "waiting-input";
      record.pendingInputType = pending.pendingInputType;
      this.emitProcessState(record, "waiting-input", record.pendingInputType);
      return;
    }

    record.pendingInputType = undefined;
    if (record.activity === "waiting-input") {
      record.activity = "in-turn";
      this.emitProcessState(record, "in-turn");
    }
  }

  private findPendingByThreadAndRpcId(
    threadId: string,
    rpcId: JsonRpcId,
  ): PendingServerRequest | null {
    const ids = this.pendingIdsByThread.get(threadId);
    if (!ids) return null;
    const key = idKey(rpcId);
    for (const id of ids) {
      const pending = this.pendingByInputId.get(id);
      if (pending?.rpcKey === key) return pending;
    }
    return null;
  }

  private findPendingByConnectionAndRpcId(
    connection: BridgeConnection,
    rpcId: JsonRpcId,
  ): PendingServerRequest | null {
    const key = idKey(rpcId);
    for (const pending of connection.pendingServerRequests.values()) {
      if (pending.rpcKey === key) return pending;
    }
    return null;
  }

  private buildPendingInputId(
    message: JsonRpcMessage,
    threadId: string,
    params: Record<string, unknown>,
  ): string {
    return [
      idKey(message.id as JsonRpcId),
      message.method,
      threadId,
      getString(params.turnId),
      getString(params.itemId),
      getString(params.approvalId),
    ]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join("|");
  }

  private getCommandPersistentApprovalDecision(
    params: Record<string, unknown>,
  ): unknown {
    const availableDecisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : [];
    const offeredPersistentDecision = availableDecisions.find(
      isPersistentCommandDecision,
    );
    if (offeredPersistentDecision) {
      return offeredPersistentDecision;
    }

    const execpolicyAmendment = params.proposedExecpolicyAmendment;
    if (Array.isArray(execpolicyAmendment)) {
      return {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: execpolicyAmendment,
        },
      };
    }

    const networkAmendments = Array.isArray(
      params.proposedNetworkPolicyAmendments,
    )
      ? params.proposedNetworkPolicyAmendments
      : [];
    const networkAmendment = networkAmendments.find(
      (value) => asRecord(value) !== null,
    );
    if (networkAmendment) {
      return {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: networkAmendment,
        },
      };
    }

    return availableDecisions.includes("acceptForSession")
      ? "acceptForSession"
      : "accept";
  }

  private upsertThread(
    connection: BridgeConnection,
    thread: Record<string, unknown>,
    extra: {
      cwd?: string;
      model?: string;
      reasoningEffort?: string;
      serviceTier?: string;
    },
  ): void {
    const id = getString(thread.id);
    if (!id) return;

    const cwd = extra.cwd ?? getString(thread.cwd);
    const subagent = getCodexSubagentMetadata(thread);
    const record = this.ensureSessionRecord(id, {
      cwd,
      isSubagent: subagent.isSubagent,
      parentThreadId: subagent.parentThreadId,
      agentPath: subagent.agentPath,
      agentNickname: subagent.agentNickname,
      agentRole: subagent.agentRole,
      model: extra.model ?? getString(thread.model),
      reasoningEffort: extra.reasoningEffort,
      serviceTier: extra.serviceTier,
      title: getString(thread.name) ?? getString(thread.preview),
      createdAt: timestampFromThreadValue(thread.createdAt),
      updatedAt: timestampFromThreadValue(thread.updatedAt),
      messageCount: Array.isArray(thread.turns)
        ? thread.turns.length
        : undefined,
    });
    this.trackThreadConnection(connection, id);

    const status = asRecord(thread.status);
    if (status) {
      record.activity = this.activityFromThreadStatus(status);
      if (record.activity !== "waiting-input") {
        record.pendingInputType = undefined;
      }
    }

    this.emitSessionCreated(record);
    this.emitSessionStatus(record, bridgeOwnership(this.isSessionActive(id)));
    if (record.activity) {
      this.emitProcessState(record, record.activity, record.pendingInputType);
    }
  }

  private ensureSessionRecord(
    threadId: string,
    values: {
      cwd?: string;
      isSubagent?: boolean;
      threadMetadataKnown?: boolean;
      parentThreadId?: string;
      agentPath?: string;
      agentNickname?: string;
      agentRole?: string;
      model?: string;
      reasoningEffort?: string;
      serviceTier?: string;
      title?: string | null;
      createdAt?: string;
      updatedAt?: string;
      messageCount?: number;
    },
  ): SessionRecord {
    const existing = this.sessions.get(threadId);
    const now = new Date().toISOString();
    const projectPath = values.cwd ?? existing?.projectPath ?? process.cwd();
    const record: SessionRecord = existing ?? {
      id: threadId,
      isSubagent: values.isSubagent ?? false,
      threadMetadataKnown:
        values.threadMetadataKnown ?? values.isSubagent !== undefined,
      parentThreadId: values.parentThreadId,
      agentPath: values.agentPath,
      agentNickname: values.agentNickname,
      agentRole: values.agentRole,
      projectId: encodeProjectId(projectPath),
      projectPath,
      projectName: basename(projectPath),
      title: null,
      fullTitle: null,
      createdAt: values.createdAt ?? now,
      updatedAt: values.updatedAt ?? now,
      messageCount: 0,
      activity: "idle",
      connectionIds: new Set(),
    };

    if (values.cwd && values.cwd !== record.projectPath) {
      record.projectPath = values.cwd;
      record.projectId = encodeProjectId(values.cwd);
      record.projectName = basename(values.cwd);
    }
    // Classification is monotonic: once Codex identifies a child thread, a
    // later partial notification must not promote it back to a root session.
    if (values.isSubagent === true) {
      record.isSubagent = true;
    } else if (values.isSubagent === false && !record.threadMetadataKnown) {
      record.isSubagent = false;
    }
    if (values.threadMetadataKnown || values.isSubagent !== undefined) {
      record.threadMetadataKnown = true;
    }
    if (values.parentThreadId) record.parentThreadId = values.parentThreadId;
    if (values.agentPath) record.agentPath = values.agentPath;
    if (values.agentNickname) record.agentNickname = values.agentNickname;
    if (values.agentRole) record.agentRole = values.agentRole;
    if (values.model) record.model = values.model;
    if (values.reasoningEffort) {
      record.reasoningEffort = values.reasoningEffort;
    }
    if (values.serviceTier) record.serviceTier = values.serviceTier;
    if (values.title !== undefined) {
      record.title = values.title;
      record.fullTitle = values.title;
    }
    if (values.createdAt) record.createdAt = values.createdAt;
    if (values.updatedAt) record.updatedAt = values.updatedAt;
    if (values.messageCount !== undefined) {
      record.messageCount = Math.max(record.messageCount, values.messageCount);
    }

    this.sessions.set(threadId, record);
    return record;
  }

  private trackThreadConnection(
    connection: BridgeConnection,
    threadId: string,
  ): void {
    connection.threadIds.add(threadId);
    const record = this.ensureSessionRecord(threadId, {});
    record.connectionIds.add(connection.id);
  }

  private activityFromThreadStatus(
    status: unknown,
  ): "in-turn" | "idle" | "waiting-input" {
    const s = asRecord(status);
    if (!s) return "idle";
    const type = getString(s.type);
    if (type !== "active") return "idle";
    const flags = Array.isArray(s.activeFlags)
      ? s.activeFlags.filter((flag): flag is string => typeof flag === "string")
      : [];
    if (
      flags.includes("waitingOnApproval") ||
      flags.includes("waitingOnUserInput")
    ) {
      return "waiting-input";
    }
    return "in-turn";
  }

  private isTopLevelSessionRecord(record: SessionRecord): boolean {
    return record.threadMetadataKnown && !record.isSubagent;
  }

  private emitSessionCreated(record: SessionRecord): void {
    if (!this.isTopLevelSessionRecord(record)) return;
    const session = this.toBridgeSession(record);
    if (!this.isDisplayableBridgeSession(session)) {
      return;
    }
    if (this.emittedSessionIds.has(record.id)) {
      return;
    }
    this.emittedSessionIds.add(record.id);
    this.eventBus?.emit({
      type: "session-created",
      session: this.toSessionSummary(session),
      timestamp: new Date().toISOString(),
    });
  }

  private emitSessionStatus(
    record: SessionRecord,
    ownership: SessionSummary["ownership"],
  ): void {
    if (!this.isTopLevelSessionRecord(record)) return;
    this.eventBus?.emit({
      type: "session-status-changed",
      sessionId: record.id,
      projectId: record.projectId,
      ownership,
      timestamp: new Date().toISOString(),
    });
  }

  private emitProcessState(
    record: SessionRecord,
    activity: "in-turn" | "idle" | "waiting-input",
    pendingInputType?: "tool-approval" | "user-question",
  ): void {
    if (!this.isTopLevelSessionRecord(record)) return;
    this.eventBus?.emit({
      type: "process-state-changed",
      sessionId: record.id,
      projectId: record.projectId,
      activity,
      pendingInputType,
      timestamp: new Date().toISOString(),
    });
  }

  private emitSessionUpdated(record: SessionRecord): void {
    if (!this.isTopLevelSessionRecord(record)) return;
    this.eventBus?.emit({
      type: "session-updated",
      sessionId: record.id,
      projectId: record.projectId,
      title: record.title,
      messageCount: record.messageCount,
      updatedAt: record.updatedAt,
      model: record.model,
      reasoningEffort: record.reasoningEffort,
      serviceTier: record.serviceTier,
      timestamp: new Date().toISOString(),
    });
  }

  private toBridgeSession(record: SessionRecord): CodexBridgeSession {
    return {
      id: record.id,
      projectId: record.projectId,
      projectPath: record.projectPath,
      projectName: record.projectName,
      title: record.title,
      fullTitle: record.fullTitle,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: record.messageCount,
      provider: "codex",
      model: record.model,
      reasoningEffort: record.reasoningEffort,
      serviceTier: record.serviceTier,
      activity: record.activity,
      pendingInputType: record.pendingInputType,
      connectionIds: Array.from(record.connectionIds),
    };
  }

  private toSessionSummary(session: CodexBridgeSession): SessionSummary {
    return {
      id: session.id,
      projectId: session.projectId,
      title: session.title,
      fullTitle: session.fullTitle,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      ownership: bridgeOwnership(isLiveBridgeSession(session)),
      pendingInputType: session.pendingInputType,
      provider: "codex",
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      serviceTier: session.serviceTier,
      originator: "Yep Codex Bridge",
      createdBy: "external",
      source: "codex-bridge",
    };
  }

  private isDisplayableBridgeSession(session: CodexBridgeSession): boolean {
    return (
      session.messageCount > 0 ||
      session.activity === "in-turn" ||
      session.activity === "waiting-input" ||
      !!session.pendingInputType
    );
  }

  private async ensureUpstreamUrl(
    profile: CodexBridgeUpstreamProfile,
  ): Promise<string> {
    if (this.upstreamUrlOverride) return this.upstreamUrlOverride;
    const state = this.getUpstreamState(profile);
    if (state.url && this.isManagedUpstreamRunning(profile)) {
      return state.url;
    }
    if (state.startPromise) {
      return state.startPromise;
    }

    state.startPromise = this.startManagedUpstream(profile).finally(() => {
      state.startPromise = null;
    });
    return state.startPromise;
  }

  private async startManagedUpstream(
    profile: CodexBridgeUpstreamProfile,
  ): Promise<string> {
    const codexPath = this.codexPathOverride ?? (await findCodexCliPath());
    if (!codexPath) {
      throw new Error("Codex CLI not found");
    }

    const startPort = this.upstreamStartPort ?? this.port + 1;
    const port = await this.findAvailableManagedPort(startPort);
    const url = `ws://127.0.0.1:${port}`;
    const state = this.getUpstreamState(profile);
    const args = this.upstreamArgsByProfile[profile];
    const spawnArgs = ["app-server", ...args, "--listen", url];
    console.log(
      `[CodexBridge] Starting managed Codex app-server profile=${profile} path=${codexPath} args=${JSON.stringify(spawnArgs)}`,
    );
    const child = spawn(codexPath, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: process.env,
    });
    state.process = child;
    state.url = url;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.debug(`[CodexBridge upstream:${profile}] ${text}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.debug(`[CodexBridge upstream:${profile}] ${text}`);
    });
    child.once("exit", (code, signal) => {
      this.reservedUpstreamPorts.delete(port);
      if (state.process === child) {
        state.process = null;
        state.url = null;
      }
      console.log(
        `[CodexBridge] Managed app-server profile=${profile} exited code=${String(code)} signal=${String(signal)}`,
      );
    });

    try {
      await waitForWebSocket(url, this.startupTimeoutMs);
    } catch (error) {
      this.reservedUpstreamPorts.delete(port);
      if (state.process === child) {
        state.process = null;
        state.url = null;
      }
      if (child.pid && child.exitCode === null && !child.killed) {
        try {
          process.kill(process.platform !== "win32" ? -child.pid : child.pid);
        } catch {}
      }
      throw error;
    }

    console.log(
      `[CodexBridge] Managed Codex app-server profile=${profile} ready at ${url}`,
    );
    return url;
  }

  private async stopManagedUpstream(): Promise<void> {
    await Promise.all(
      Array.from(this.upstreams.values()).map((state) =>
        this.stopManagedUpstreamState(state),
      ),
    );
    this.reservedUpstreamPorts.clear();
  }

  private async stopManagedUpstreamState(
    state: CodexBridgeUpstreamState,
  ): Promise<void> {
    const child = state.process;
    state.process = null;
    state.url = null;
    state.startPromise = null;
    if (!child?.pid || child.exitCode !== null || child.killed) {
      return;
    }

    const pid = process.platform !== "win32" ? -child.pid : child.pid;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private getUpstreamState(
    profile: CodexBridgeUpstreamProfile,
  ): CodexBridgeUpstreamState {
    let state = this.upstreams.get(profile);
    if (!state) {
      state = { process: null, url: null, startPromise: null };
      this.upstreams.set(profile, state);
    }
    return state;
  }

  private async findAvailableManagedPort(startPort: number): Promise<number> {
    for (let port = Math.max(1, startPort); port < startPort + 100; port++) {
      if (this.reservedUpstreamPorts.has(port)) continue;
      this.reservedUpstreamPorts.add(port);
      const available = await isPortAvailable("127.0.0.1", port);
      if (available) {
        return port;
      }
      this.reservedUpstreamPorts.delete(port);
    }
    throw new Error(`No available port found near ${startPort}`);
  }

  private getManagedUpstreamUrl(): string | null {
    return (
      this.upstreams.get("clear")?.url ??
      this.upstreams.get("light")?.url ??
      this.upstreams.get("full")?.url ??
      null
    );
  }

  private getUpstreamStatus(profile: CodexBridgeUpstreamProfile) {
    const state = this.upstreams.get(profile);
    const process = state?.process ?? null;
    const running = this.isManagedUpstreamRunning(profile);
    return {
      profile,
      url: this.upstreamUrlOverride ?? state?.url ?? null,
      running: this.upstreamUrlOverride ? false : running,
      starting: this.upstreamUrlOverride
        ? false
        : !!state?.startPromise && !running,
      pid: this.upstreamUrlOverride ? null : (process?.pid ?? null),
      args: [...this.upstreamArgsByProfile[profile]],
    };
  }

  private isManagedUpstreamRunning(
    profile: CodexBridgeUpstreamProfile,
  ): boolean {
    const child = this.upstreams.get(profile)?.process;
    return !!child && !child.killed && child.exitCode === null;
  }

  private isAnyManagedUpstreamRunning(): boolean {
    return (
      this.isManagedUpstreamRunning("light") ||
      this.isManagedUpstreamRunning("full")
    );
  }

  private isLocalAddress(address: string): boolean {
    return (
      address === "127.0.0.1" ||
      address === "::1" ||
      address === "::ffff:127.0.0.1" ||
      address === "localhost"
    );
  }
}

interface JsonRpcEnvelope {
  messages: JsonRpcMessage[];
  isBatch: boolean;
}

function parseJsonRpcData(data: RawData): JsonRpcMessage[] | null {
  return parseJsonRpcEnvelope(data)?.messages ?? null;
}

function parseJsonRpcEnvelope(data: RawData): JsonRpcEnvelope | null {
  try {
    const parsed = JSON.parse(rawDataToString(data)) as unknown;
    if (Array.isArray(parsed)) {
      return { messages: parsed.filter(isJsonRpcMessage), isBatch: true };
    }
    return isJsonRpcMessage(parsed)
      ? { messages: [parsed], isBatch: false }
      : null;
  } catch {
    return null;
  }
}

function parseMcpProfile(
  url: string | undefined,
  authorization: string | undefined,
): CodexBridgeUpstreamProfile {
  const token = authorization
    ?.replace(/^Bearer\s+/i, "")
    .trim()
    .toLowerCase();
  if (token) {
    if (token === "full" || token === "mcp=full" || token === "profile:full") {
      return "full";
    }
    if (
      token === "clear" ||
      token === "mcp=clear" ||
      token === "profile:clear"
    ) {
      return "clear";
    }
  }

  const requested = new URL(url ?? "/", "http://127.0.0.1").searchParams
    .getAll("mcp")
    .at(-1)
    ?.trim()
    .toLowerCase();
  if (requested === "full") return "full";
  if (requested === "clear") return "clear";
  return "light";
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;

  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseBridgeInputResponse(
  value: unknown,
): CodexBridgeInputResponse | null {
  return value === "approve" ||
    value === "approve_accept_edits" ||
    value === "approve_for_session" ||
    value === "approve_always" ||
    value === "deny"
    ? value
    : null;
}

function sendFrame(ws: WebSocket, data: RawData, isBinary: boolean): void {
  ws.send(data, { binary: isBinary });
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return !!value && typeof value === "object";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatDiagnosticValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;

  const record = asRecord(value);
  const message = getString(record?.message);
  if (message) return message;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getElicitationMeta(
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  return asRecord(params._meta) ?? asRecord(params.meta);
}

function isMcpToolApprovalElicitation(
  params: Record<string, unknown>,
): boolean {
  const meta = getElicitationMeta(params);
  return getString(meta?.codex_approval_kind) === "mcp_tool_call";
}

function normalizeMcpPersistScopes(value: unknown): string[] {
  const rawScopes = Array.isArray(value) ? value : [value];
  const scopes = rawScopes.filter(
    (scope): scope is string => scope === "session" || scope === "always",
  );
  return Array.from(new Set(scopes));
}

function parseMcpToolNameFromPrompt(prompt: string): string | undefined {
  return /run tool "([^"]+)"/.exec(prompt)?.[1];
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isPersistentCommandDecision(value: unknown): boolean {
  const decision = asRecord(value);
  return (
    !!asRecord(decision?.acceptWithExecpolicyAmendment) ||
    !!asRecord(decision?.applyNetworkPolicyAmendment)
  );
}

function isUserResolvableServerRequest(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "item/tool/requestUserInput" ||
    method === "mcpServer/elicitation/request" ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval"
  );
}

function normalizeCodexQuestions(
  value: unknown,
): Array<{ question: string; options: string[] }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const question = asRecord(raw);
      if (!question) return null;
      const prompt = getString(question.question) ?? getString(question.header);
      if (!prompt) return null;
      const options = Array.isArray(question.options)
        ? question.options
            .map((option) =>
              typeof option === "string"
                ? option
                : getString(asRecord(option)?.label),
            )
            .filter((option): option is string => !!option)
        : [];
      return { question: prompt, options };
    })
    .filter(
      (question): question is { question: string; options: string[] } =>
        !!question,
    );
}

function buildCodexUserInputAnswers(
  questionsValue: unknown,
  answers: Record<string, string> | undefined,
): Record<string, { answers: string[] }> {
  const result: Record<string, { answers: string[] }> = {};
  if (!Array.isArray(questionsValue)) return result;

  for (const raw of questionsValue) {
    const question = asRecord(raw);
    const id = getString(question?.id);
    if (!id) continue;
    const prompt = getString(question?.question) ?? getString(question?.header);
    const answer =
      (prompt ? answers?.[prompt] : undefined) ?? answers?.[id] ?? "";
    result[id] = { answers: answer ? [answer] : [] };
  }
  return result;
}

function timestampFromThreadValue(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const ms = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(ms).toISOString();
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function waitForWebSocket(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await openAndCloseWebSocket(url);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await delay(150);
    }
  }

  throw new Error(
    `Timed out waiting for Codex app-server at ${url}: ${lastError?.message ?? "unknown error"}`,
  );
}

async function openAndCloseWebSocket(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("connect timeout"));
    }, 1000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
