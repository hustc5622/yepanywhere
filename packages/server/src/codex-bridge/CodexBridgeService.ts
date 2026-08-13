import { type ChildProcess, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { basename, dirname } from "node:path";
import type { UrlProjectId, UserQuestionAnswers } from "@yep-anywhere/shared";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { BridgeEventNotifier } from "../bridge-common/BridgeEventNotifier.js";
import type {
  BridgeInputResolutionContext,
  BridgePendingInputBinding,
} from "../bridge-common/types.js";
import {
  asRecord,
  findAvailablePort,
  isChildRunning,
  isLocalAddress,
  terminateProcessGroup,
  writeJson,
} from "../bridge-common/util.js";
import type { CodexEventStore } from "../codex-events/index.js";
import { classifyCodexError } from "../codex/error-taxonomy.js";
import {
  getCodexMcpAppServerArgs,
  resolveCodexMcpThreadProfile,
} from "../codex/mcp-profile.js";
import { getCodexSubagentMetadata } from "../codex/subagent.js";
import { encodeProjectId } from "../projects/paths.js";
import { ensureRuntimeToken } from "../runtime/token.js";
import { findCodexCliPath } from "../sdk/cli-detection.js";
import { sanitizeManagedAttachmentPrompt } from "../sdk/messageQueue.js";
import { validateQuestionAnswers } from "../sessions/question-answers.js";
import type { SessionSummary } from "../supervisor/types.js";
import type { EventBus } from "../watcher/index.js";
import {
  type CodexBridgeClientRequestScope,
  CodexBridgeEventPersistenceError,
  CodexBridgeEventSpine,
  createCodexBridgeEventIdentity,
  createCodexBridgeEventStore,
} from "./CodexBridgeEventSpine.js";
import { readCodexUsage } from "./CodexUsageService.js";
import {
  type CodexInteractiveMethod,
  buildCodexInteractiveResponse,
  buildCodexPendingInputId,
  idKey,
  isCodexInteractiveMethod,
  toCodexInteractiveRequestView,
} from "./interactions.js";
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
  CodexUsageRequestOptions,
  CodexUsageResponse,
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
  /**
   * When set, session records survive bridge restarts by being persisted to
   * this JSON file (metadata only; live connection state is rebuilt).
   */
  statePath?: string;
  /** Test/custom adapter override. Production derives JSONL from statePath. */
  eventStore?: CodexEventStore;
  eventStorePath?: string;
  /** Bearer accepted when the bridge is exposed beyond loopback. */
  authToken?: string;
  /** Shared runtime control token used by the main-server sidecar client. */
  authTokenFile?: string;
}

interface ClientRequestRecord {
  method: string;
  params?: unknown;
  eventScope: CodexBridgeClientRequestScope;
}

interface BridgeConnection {
  id: number;
  profile: CodexBridgeUpstreamProfile;
  downstream: WebSocket;
  upstream: WebSocket | null;
  downstreamQueue: QueuedFrame[];
  pendingClientRequests: Map<string, ClientRequestRecord>;
  pendingInternalRequests: Map<string, PendingInternalRequest>;
  pendingServerRequests: Map<string, PendingServerRequest>;
  resolvedServerRequestIds: Set<string>;
  threadIds: Set<string>;
  downstreamAttached: boolean;
  closed: boolean;
  eventSpine: CodexBridgeEventSpine;
  upstreamReady: Promise<void> | null;
  clientFrameChain: Promise<void>;
  serverFrameChain: Promise<void>;
  nextInternalRequestId: number;
}

interface QueuedFrame {
  data: RawData;
  isBinary: boolean;
}

interface ForwardedFrame {
  data: RawData;
  isBinary: boolean;
}

interface PendingInternalRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingServerRequest {
  inputId: string;
  rpcId: JsonRpcId;
  rpcKey: string;
  requestKey: string;
  method: CodexInteractiveMethod;
  params: Record<string, unknown>;
  threadId: string;
  turnId?: string;
  itemId?: string;
  inputRequest: CodexBridgePendingInput["request"];
  pendingInputType: "tool-approval" | "user-question";
  connection: BridgeConnection;
  createdAt: string;
  eventSessionId: string;
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
  /**
   * True once a real cwd arrived from thread metadata. Records created from
   * bare threadIds fall back to the bridge process cwd, which must never be
   * exposed as the session's project (it files the session under the wrong
   * project in the UI).
   */
  projectPathKnown: boolean;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  activity?: "in-turn" | "idle" | "waiting-input";
  activityBeforePending?: "in-turn" | "idle";
  /** True while a turn is in progress (turn/started .. turn terminal). */
  turnActive?: boolean;
  /** Terminal status of the most recent turn, from turn/completed. */
  lastTurnStatus?: "completed" | "interrupted" | "failed";
  /** Message of the most recent turn error/`error` notification. */
  lastErrorMessage?: string;
  pendingInputType?: "tool-approval" | "user-question";
  connectionIds: Set<number>;
  completedTurnIds: Set<string>;
}

/** JSON-serializable subset of SessionRecord persisted across bridge restarts. */
interface PersistedSessionRecord {
  id: string;
  isSubagent: boolean;
  threadMetadataKnown: boolean;
  parentThreadId?: string;
  projectPath: string;
  projectPathKnown: boolean;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  lastTurnStatus?: "completed" | "interrupted" | "failed";
  lastErrorMessage?: string;
  completedTurnIds: string[];
  emitted: boolean;
}

interface PendingInputBinding extends BridgePendingInputBinding {
  sessionId: string;
  requestId: string;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const MAX_MCP_STARTUP_EVENTS = 50;
const MAX_RESOLVED_SERVER_REQUEST_IDS = 1_000;
const CODEX_USAGE_CACHE_TTL_MS = 30_000;
const INTERNAL_REQUEST_TIMEOUT_MS = 10_000;

function isMcpThreadLifecycleMethod(
  method: string | undefined,
): method is "thread/start" | "thread/resume" | "thread/fork" {
  return (
    method === "thread/start" ||
    method === "thread/resume" ||
    method === "thread/fork"
  );
}

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
  private cachedUsage: {
    response: CodexUsageResponse;
    expiresAt: number;
  } | null = null;
  private usageRequest: Promise<CodexUsageResponse> | null = null;
  private readonly statePath?: string;
  private readonly eventStore: CodexEventStore;
  private readonly remoteAuthToken?: string;
  private controlToken?: string;
  private readonly authTokenFile?: string;
  private readonly requiresAuthentication: boolean;
  private readonly pendingInputBindings = new Map<
    string,
    PendingInputBinding
  >();
  private readonly eventTasks = new Set<Promise<void>>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes atomic writes so concurrent state changes cannot race on .tmp. */
  private persistChain: Promise<void> = Promise.resolve();
  private readonly eventNotifier = new BridgeEventNotifier();

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
    this.statePath = options.statePath;
    this.eventStore = createCodexBridgeEventStore({
      store: options.eventStore,
      eventStorePath: options.eventStorePath,
      statePath: options.statePath,
    });
    this.remoteAuthToken = options.authToken?.trim() || undefined;
    this.authTokenFile = options.authTokenFile;
    this.requiresAuthentication = !isLocalAddress(this.host);
  }

  async start(): Promise<void> {
    if (!this.enabled || this.server) {
      return;
    }

    if (this.authTokenFile) {
      try {
        this.controlToken = await ensureRuntimeToken(this.authTokenFile);
      } catch {
        this.listening = false;
        this.lastError = "Codex bridge bearer authentication is unavailable";
        return;
      }
    }

    if (
      this.requiresAuthentication &&
      !this.remoteAuthToken &&
      !this.controlToken
    ) {
      this.listening = false;
      this.lastError =
        "Refusing non-loopback Codex bridge without explicit bearer authentication";
      return;
    }

    await this.restorePersistedSessions();

    const server = createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((error: unknown) => {
        const diagnostic = projectBridgePublicDiagnostic(error);
        this.lastError = diagnostic.publicMessage;
        console.warn(
          `[CodexBridge] HTTP request failed ${diagnostic.logFields}`,
        );
        writeBridgeHttpError(
          res,
          500,
          "bridge_internal_error",
          "Bridge request failed",
        );
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
        const diagnostic = projectBridgePublicDiagnostic(error);
        this.lastError = diagnostic.publicMessage;
        this.listening = false;
        this.server = null;
        this.wss = null;
        wss.close();
        console.warn(`[CodexBridge] Failed to listen ${diagnostic.logFields}`);
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
      const diagnostic = projectBridgePublicDiagnostic(error);
      this.lastError = diagnostic.publicMessage;
      console.warn(`[CodexBridge] Server error ${diagnostic.logFields}`);
    });
  }

  async shutdown(): Promise<void> {
    for (const connection of this.connections.values()) {
      this.closeConnection(connection, "shutdown");
    }
    this.connections.clear();

    await Promise.allSettled(Array.from(this.eventTasks));

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.eventNotifier.close();
    await this.persistSessions();

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
      upstreamUrl: sanitizeBridgePublicUrl(
        this.upstreamUrlOverride ?? this.getManagedUpstreamUrl(),
      ),
      upstreamRunning: this.isAnyManagedUpstreamRunning(),
      upstreamMode: this.upstreamUrlOverride ? "external" : "managed",
      upstreams: {
        clear: this.getUpstreamStatus("clear"),
        light: this.getUpstreamStatus("light"),
        full: this.getUpstreamStatus("full"),
      },
      connectionCount: this.connections.size,
      attachedClientCount: Array.from(this.connections.values()).filter(
        (connection) => connection.downstreamAttached,
      ).length,
      detachedConnectionCount: Array.from(this.connections.values()).filter(
        (connection) => !connection.downstreamAttached,
      ).length,
      sessionCount: Array.from(this.sessions.values()).filter((record) =>
        this.isTopLevelSessionRecord(record),
      ).length,
      pendingInputCount: this.getLogicalPendingInputCount(),
      recentMcpStartupEvents: this.recentMcpStartupEvents.map((event) => ({
        ...event,
      })),
      lastError: this.lastError,
    };
  }

  async getUsage(
    options: CodexUsageRequestOptions = {},
  ): Promise<CodexUsageResponse> {
    const now = Date.now();
    if (
      !options.fresh &&
      this.cachedUsage &&
      this.cachedUsage.expiresAt > now
    ) {
      return this.cachedUsage.response;
    }
    if (this.usageRequest) return this.usageRequest;

    this.usageRequest = readCodexUsage(this.codexPathOverride)
      .then((usage) => {
        const response: CodexUsageResponse = { usage, error: null };
        this.cachedUsage = {
          response,
          expiresAt: Date.now() + CODEX_USAGE_CACHE_TTL_MS,
        };
        return response;
      })
      .catch((error: unknown) => ({
        usage: null,
        error: projectBridgePublicDiagnostic(error).publicMessage,
      }))
      .finally(() => {
        this.usageRequest = null;
      });

    return this.usageRequest;
  }

  listSessionViews(): CodexBridgeSessionView[] {
    return this.listSessions()
      .filter((session) => this.isDisplayableBridgeSession(session))
      .map((session) => ({
        session: this.toSessionSummary(session),
        projectName: session.projectName,
        activity: session.activity,
        pendingInputType: session.pendingInputType,
        pendingInputRequestId: this.getPendingInputRequest(session.id)?.id,
        // Published so the main server can answer liveness for a whole list
        // from this snapshot instead of probing /active per session.
        active: isLiveBridgeSession(session),
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
      pendingInputRequestId: this.getPendingInputRequest(session.id)?.id,
      active: isLiveBridgeSession(session),
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

  private getSessionExecutionProfile(
    sessionId: string,
  ): CodexBridgeUpstreamProfile | null {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    const candidates = Array.from(record.connectionIds)
      .map((connectionId) => this.connections.get(connectionId))
      .filter((connection): connection is BridgeConnection =>
        Boolean(connection && !connection.closed),
      );
    return (
      candidates.find((connection) => connection.downstreamAttached)?.profile ??
      candidates[0]?.profile ??
      null
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

  bindPendingInputInteraction(
    sessionId: string,
    requestId: string,
    binding: BridgePendingInputBinding,
  ): boolean {
    const pending = this.pendingByInputId.get(requestId);
    if (
      !pending ||
      (pending.threadId !== sessionId &&
        this.getTopLevelSessionId(pending.threadId) !== sessionId) ||
      !isValidOperationId(binding.operationId) ||
      !Number.isSafeInteger(binding.operationVersion) ||
      binding.operationVersion < 0
    ) {
      return false;
    }

    const existing = this.pendingInputBindings.get(requestId);
    // The main server may restart while the sidecar/provider request remains
    // live. A newly authenticated operation may therefore replace the old
    // operation id; versions within one operation must stay monotonic.
    if (
      existing &&
      existing.operationId === binding.operationId &&
      binding.operationVersion < existing.operationVersion
    ) {
      return false;
    }
    this.pendingInputBindings.set(requestId, {
      sessionId,
      requestId,
      operationId: binding.operationId,
      operationVersion: binding.operationVersion,
    });
    return true;
  }

  respondToInput(
    sessionId: string,
    requestId: string,
    response: CodexBridgeInputResponse,
    answers?: UserQuestionAnswers,
    context?: BridgeInputResolutionContext,
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
      pending.connection.upstream.readyState !== WebSocket.OPEN ||
      pending.connection.resolvedServerRequestIds.has(pending.rpcKey)
    ) {
      return false;
    }

    if (response !== "deny") {
      const request = this.getPendingInputRequest(sessionId);
      if (request?.id === requestId) {
        const validation = validateQuestionAnswers(request, answers);
        if (!validation.valid) return false;
      }
    }

    if (context && !this.consumePendingInputBinding(pending, context)) {
      return false;
    }

    const result = buildCodexInteractiveResponse(
      pending.method,
      pending.params,
      response,
      answers,
    );
    const message: JsonRpcMessage = {
      id: pending.rpcId,
      result,
    };
    const upstream = pending.connection.upstream;
    this.markLogicalRequestResolved(pending);
    this.enqueueFrameTask(pending.connection, "client", async () => {
      try {
        await pending.connection.eventSpine.observeServerRequestResolution(
          message,
          {
            method: pending.method,
            sessionId: pending.eventSessionId,
          },
        );
        if (
          !pending.connection.closed &&
          upstream.readyState === WebSocket.OPEN
        ) {
          upstream.send(JSON.stringify(message));
        }
      } finally {
        this.resolveLogicalRequest(pending, "yep");
      }
    });
    return true;
  }

  private consumePendingInputBinding(
    pending: PendingServerRequest,
    context: BridgeInputResolutionContext,
  ): boolean {
    const binding = this.pendingInputBindings.get(pending.inputId);
    if (
      !binding ||
      binding.operationId !== context.operationId ||
      context.operationVersion !== binding.operationVersion + 1 ||
      !isValidResolutionActor(context.actor)
    ) {
      return false;
    }
    this.pendingInputBindings.delete(pending.inputId);
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
    if (!this.isAuthorizedRequest(req)) {
      writeBridgeHttpError(res, 401, "bridge_unauthorized", "Unauthorized");
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathParts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));

    if (req.method === "GET" && url.pathname === "/readyz") {
      writeJson(res, 200, this.getStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      writeJson(res, 200, this.getStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      // SSE change signal for the main server's poll-on-push subscription.
      this.eventNotifier.attach(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/usage") {
      writeJson(
        res,
        200,
        await this.getUsage({ fresh: url.searchParams.get("fresh") === "1" }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/sessions") {
      writeJson(res, 200, { sessions: this.listSessions() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/session-views") {
      writeJson(res, 200, { sessions: this.listSessionViews() });
      return;
    }

    if (pathParts[0] === "sessions" && pathParts[1]) {
      const sessionId = pathParts[1];
      if (req.method === "GET" && pathParts.length === 2) {
        const session =
          this.listSessions().find((candidate) => candidate.id === sessionId) ??
          null;
        writeJson(res, 200, { session });
        return;
      }
      if (req.method === "GET" && pathParts[2] === "view") {
        writeJson(res, 200, {
          sessionView: this.getSessionView(sessionId),
        });
        return;
      }
      if (req.method === "GET" && pathParts[2] === "active") {
        const active = this.isSessionActive(sessionId);
        writeJson(res, 200, {
          active,
          ...(active
            ? { mcpProfile: this.getSessionExecutionProfile(sessionId) }
            : {}),
        });
        return;
      }
      if (req.method === "GET" && pathParts[2] === "pending-input") {
        writeJson(res, 200, {
          request: this.getPendingInputRequest(sessionId),
        });
        return;
      }
      if (
        req.method === "POST" &&
        (pathParts[2] === "input-binding" || pathParts[2] === "input")
      ) {
        if (!this.hasValidControlBearer(req)) {
          writeBridgeHttpError(
            res,
            401,
            "bridge_control_unauthorized",
            "Unauthorized",
          );
          return;
        }
        if (
          req.headers.origin !== undefined ||
          readSingleHeader(req, "x-yep-anywhere") !== "true"
        ) {
          writeBridgeHttpError(
            res,
            403,
            "bridge_control_forbidden",
            "Forbidden",
          );
          return;
        }
      }
      if (req.method === "POST" && pathParts[2] === "input-binding") {
        const body = await readJsonBody(req);
        const requestId = readBodyString(body, "requestId");
        const operationId = readBodyString(body, "operationId");
        const operationVersion = body?.operationVersion;
        if (
          !requestId ||
          !operationId ||
          !isValidOperationId(operationId) ||
          !Number.isSafeInteger(operationVersion) ||
          (operationVersion as number) < 0
        ) {
          writeBridgeHttpError(
            res,
            409,
            "interaction_identity_invalid",
            "Interaction identity is invalid",
          );
          return;
        }
        if (!this.pendingByInputId.has(requestId)) {
          writeBridgeHttpError(
            res,
            404,
            "interaction_not_found",
            "Pending interaction not found",
          );
          return;
        }
        const bound = this.bindPendingInputInteraction(sessionId, requestId, {
          operationId,
          operationVersion: operationVersion as number,
        });
        if (!bound) {
          writeBridgeHttpError(
            res,
            409,
            "interaction_binding_conflict",
            "Interaction binding is stale or conflicts with the pending request",
          );
          return;
        }
        writeJson(res, 200, { bound: true });
        return;
      }
      if (req.method === "POST" && pathParts[2] === "input") {
        const body = await readJsonBody(req);
        const requestId = readBodyString(body, "requestId");
        const response = parseBridgeInputResponse(body?.response);
        const answers =
          body && typeof body.answers === "object" && body.answers !== null
            ? (body.answers as UserQuestionAnswers)
            : undefined;
        const context = parseInputResolutionContext(body);

        if (!requestId || !response) {
          writeJson(res, 400, {
            error: "requestId and response are required",
          });
          return;
        }
        if (!context) {
          writeBridgeHttpError(
            res,
            409,
            "interaction_identity_required",
            "A broker operation identity, claimed version, and actor are required",
          );
          return;
        }
        if (!this.pendingByInputId.has(requestId)) {
          writeBridgeHttpError(
            res,
            404,
            "interaction_not_found",
            "Pending interaction not found",
          );
          return;
        }
        const accepted = this.respondToInput(
          sessionId,
          requestId,
          response,
          answers,
          context,
        );
        if (!accepted) {
          writeBridgeHttpError(
            res,
            409,
            "interaction_resolution_conflict",
            "Interaction is stale, already resolved, or rejected",
          );
          return;
        }
        writeJson(res, 200, { accepted: true });
        return;
      }
    }

    writeJson(res, 404, { error: "Not found" });
  }

  private isAuthorizedRequest(req: IncomingMessage): boolean {
    if (this.requiresAuthentication) return this.hasValidBearer(req);
    return isLocalAddress(req.socket.remoteAddress ?? "");
  }

  private hasValidBearer(req: IncomingMessage): boolean {
    return (
      bearerTokenMatches(req.headers.authorization, this.controlToken) ||
      bearerTokenMatches(req.headers.authorization, this.remoteAuthToken)
    );
  }

  private hasValidControlBearer(req: IncomingMessage): boolean {
    return bearerTokenMatches(
      req.headers.authorization,
      this.controlToken ?? this.remoteAuthToken,
    );
  }

  private handleConnection(downstream: WebSocket, req: IncomingMessage): void {
    if (!this.isAuthorizedRequest(req)) {
      downstream.close(1008, "Codex bridge authentication required");
      return;
    }

    const profile = parseMcpProfile(
      req.url,
      req.headers.authorization,
      readSingleHeader(req, "x-yep-codex-profile"),
      this.requiresAuthentication,
    );
    const connectionId = this.nextConnectionId++;
    const eventIdentity = createCodexBridgeEventIdentity({
      connectionId,
      profile,
    });
    const connection: BridgeConnection = {
      id: connectionId,
      profile,
      downstream,
      upstream: null,
      downstreamQueue: [],
      pendingClientRequests: new Map(),
      pendingInternalRequests: new Map(),
      pendingServerRequests: new Map(),
      resolvedServerRequestIds: new Set(),
      threadIds: new Set(),
      downstreamAttached: true,
      closed: false,
      eventSpine: new CodexBridgeEventSpine({
        store: this.eventStore,
        ...eventIdentity,
        onPersistenceError: (stage) => {
          this.lastError = `Codex event spine ${stage} persistence failed`;
        },
      }),
      upstreamReady: null,
      clientFrameChain: Promise.resolve(),
      serverFrameChain: Promise.resolve(),
      nextInternalRequestId: 1,
    };
    this.connections.set(connection.id, connection);
    console.log(
      `[CodexBridge] Connection ${connection.id} profile=${profile} request=websocket`,
    );

    downstream.on("message", (data, isBinary) => {
      this.enqueueFrameTask(connection, "client", () =>
        this.forwardClientFrame(connection, data, isBinary),
      );
    });
    downstream.on("close", () =>
      this.handleDownstreamClosed(connection, "client"),
    );
    downstream.on("error", (error) => {
      this.lastError = projectBridgePublicDiagnostic(error).publicMessage;
      this.handleDownstreamClosed(connection, "client-error");
    });

    const upstreamReady = this.connectUpstream(connection);
    connection.upstreamReady = upstreamReady;
    upstreamReady.catch((error: unknown) => {
      const diagnostic = projectBridgePublicDiagnostic(error);
      this.lastError = diagnostic.publicMessage;
      console.warn(
        `[CodexBridge] Upstream connection failed ${diagnostic.logFields}`,
      );
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.close(1011, "Failed to connect Codex app-server");
      }
      this.closeConnection(connection, "upstream-connect-error");
    });
  }

  private async forwardClientFrame(
    connection: BridgeConnection,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (connection.closed) return;
    const forwardedFrame = await this.observeClientData(
      connection,
      data,
      isBinary,
    );
    if (!forwardedFrame || connection.closed) return;
    this.sendClientFrameToUpstream(connection, forwardedFrame);
  }

  private sendClientFrameToUpstream(
    connection: BridgeConnection,
    frame: ForwardedFrame,
  ): void {
    if (connection.closed) return;
    if (connection.upstream?.readyState === WebSocket.OPEN) {
      sendFrame(connection.upstream, frame.data, frame.isBinary);
    } else {
      connection.downstreamQueue.push(frame);
    }
  }

  private async connectUpstream(connection: BridgeConnection): Promise<void> {
    const upstreamUrl = await this.ensureUpstreamUrl(connection.profile);
    if (connection.closed) return;

    await new Promise<void>((resolve, reject) => {
      const upstream = new WebSocket(upstreamUrl);
      connection.upstream = upstream;

      upstream.on("open", () => {
        console.log(
          `[CodexBridge] Connection ${connection.id} profile=${connection.profile} upstream=${sanitizeBridgePublicUrl(upstreamUrl) ?? "configured"}`,
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
        this.maybeCloseDetachedConnection(connection, "upstream-open");
        resolve();
      });

      upstream.on("message", (data, isBinary) => {
        this.enqueueFrameTask(connection, "server", async () => {
          if (connection.closed) return;
          const forwardedFrame = await this.observeServerData(
            connection,
            data,
            isBinary,
          );
          if (
            !connection.closed &&
            connection.downstream.readyState === WebSocket.OPEN &&
            forwardedFrame
          ) {
            sendFrame(
              connection.downstream,
              forwardedFrame.data,
              forwardedFrame.isBinary,
            );
          }
          this.maybeCloseDetachedConnection(connection, "server-frame");
        });
      });

      upstream.on("close", () => this.closeConnection(connection, "upstream"));
      upstream.on("error", (error) => {
        this.lastError = projectBridgePublicDiagnostic(error).publicMessage;
        reject(error);
      });
    });
  }

  private handleDownstreamClosed(
    connection: BridgeConnection,
    reason: string,
  ): void {
    if (connection.closed || !connection.downstreamAttached) return;
    connection.downstreamAttached = false;
    if (this.shouldRetainDetachedConnection(connection)) {
      console.log(
        `[CodexBridge] Retaining detached connection ${connection.id} while Codex is active`,
      );
      return;
    }
    this.closeConnection(connection, reason);
  }

  private shouldRetainDetachedConnection(
    connection: BridgeConnection,
  ): boolean {
    if (connection.downstreamAttached || connection.closed) return false;
    if (
      connection.downstreamQueue.length > 0 ||
      connection.pendingClientRequests.size > 0 ||
      connection.pendingInternalRequests.size > 0 ||
      connection.pendingServerRequests.size > 0
    ) {
      return true;
    }
    for (const threadId of connection.threadIds) {
      const activity = this.sessions.get(threadId)?.activity;
      if (activity === "in-turn" || activity === "waiting-input") return true;
    }
    return false;
  }

  private maybeCloseDetachedConnection(
    connection: BridgeConnection,
    reason: string,
  ): void {
    if (
      connection.downstreamAttached ||
      connection.closed ||
      this.shouldRetainDetachedConnection(connection)
    ) {
      return;
    }
    this.closeConnection(connection, reason);
  }

  private closeConnection(connection: BridgeConnection, reason: string): void {
    if (connection.closed) return;
    connection.closed = true;

    this.connections.delete(connection.id);
    for (const pending of connection.pendingInternalRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new Error(
          `Codex bridge connection closed during ${pending.method}: ${reason}`,
        ),
      );
    }
    connection.pendingInternalRequests.clear();
    for (const pending of connection.pendingServerRequests.values()) {
      this.resolvePendingRequest(pending, reason);
    }
    connection.pendingServerRequests.clear();

    if (
      connection.downstream.readyState === WebSocket.OPEN ||
      connection.downstream.readyState === WebSocket.CONNECTING
    ) {
      connection.downstream.close();
    }
    if (
      connection.upstream?.readyState === WebSocket.OPEN ||
      connection.upstream?.readyState === WebSocket.CONNECTING
    ) {
      connection.upstream.close();
    }

    for (const threadId of connection.threadIds) {
      const record = this.sessions.get(threadId);
      if (!record) continue;
      record.connectionIds.delete(connection.id);
      record.updatedAt = new Date().toISOString();
      if (record.connectionIds.size === 0) {
        record.activity = "idle";
        record.turnActive = false;
        record.activityBeforePending = undefined;
        record.pendingInputType = undefined;
        this.emitSessionStatus(record, { owner: "none" });
        this.emitProcessState(record, "idle");
      }
    }
    this.schedulePersist();
  }

  private enqueueFrameTask(
    connection: BridgeConnection,
    direction: "client" | "server",
    operation: () => Promise<void>,
  ): void {
    const previous =
      direction === "client"
        ? connection.clientFrameChain
        : connection.serverFrameChain;
    const task = previous.then(operation).catch((error: unknown) => {
      if (error instanceof CodexBridgeEventPersistenceError) {
        this.lastError = `Codex event spine ${error.stage} persistence failed`;
        console.warn(
          `[CodexBridge] Event spine persistence failed stage=${error.stage} connection=${connection.id}; closing connection`,
        );
        if (connection.downstream.readyState === WebSocket.OPEN) {
          connection.downstream.close(1011, "Codex event persistence failed");
        }
        if (connection.upstream?.readyState === WebSocket.OPEN) {
          connection.upstream.close(1011, "Codex event persistence failed");
        }
        this.closeConnection(connection, "event-spine-persistence-error");
        return;
      }
      const diagnostic = classifyCodexError(error);
      this.lastError = diagnostic.publicMessage;
      console.warn(
        `[CodexBridge] ${direction} frame processing failed connection=${connection.id} code=${diagnostic.code} category=${diagnostic.category} retryable=${String(diagnostic.retryable)}`,
      );
      this.closeConnection(connection, `${direction}-frame-error`);
    });
    if (direction === "client") {
      connection.clientFrameChain = task;
    } else {
      connection.serverFrameChain = task;
    }
    this.eventTasks.add(task);
    void task.then(() => this.eventTasks.delete(task));
  }

  private async observeClientData(
    connection: BridgeConnection,
    data: RawData,
    isBinary: boolean,
  ): Promise<ForwardedFrame | null> {
    const envelope = parseJsonRpcEnvelope(data);
    if (!envelope) return { data, isBinary };

    const messagesToForward: JsonRpcMessage[] = [];
    let modified = false;
    let flushedPrefix = false;
    for (const originalMessage of envelope.messages) {
      if (
        isMcpThreadLifecycleMethod(originalMessage.method) &&
        messagesToForward.length > 0
      ) {
        // config/read must run after earlier protocol messages such as
        // `initialized`. Flush a batch prefix first and rely on WebSocket
        // ordering before issuing the internal request.
        const prefixFrame = serializeJsonRpcEnvelope(
          envelope.isBatch,
          messagesToForward,
        );
        if (prefixFrame) {
          this.sendClientFrameToUpstream(connection, prefixFrame);
        }
        messagesToForward.length = 0;
        flushedPrefix = true;
      }
      const message = await this.applyMcpProfileToClientMessage(
        connection,
        originalMessage,
      );
      if (message !== originalMessage) modified = true;
      if (message.method && message.id !== undefined) {
        const eventScope =
          await connection.eventSpine.observeClientRequest(message);
        if (!eventScope) {
          messagesToForward.push(message);
          continue;
        }
        connection.pendingClientRequests.set(idKey(message.id), {
          method: message.method,
          params: message.params,
          eventScope,
        });
        messagesToForward.push(message);
        continue;
      }

      if (!message.method && message.id !== undefined) {
        const key = idKey(message.id);
        const alreadyResolved = connection.resolvedServerRequestIds.has(key);
        const pending = this.findPendingByConnectionAndRpcId(
          connection,
          message.id,
        );
        if (alreadyResolved) {
          continue;
        }
        await connection.eventSpine.observeServerRequestResolution(message);
        if (pending) {
          this.markLogicalRequestResolved(pending, connection);
          this.resolveLogicalRequest(pending, "tui");
        }
      }
      messagesToForward.push(message);
    }

    if (messagesToForward.length === 0) return null;
    if (
      !modified &&
      !flushedPrefix &&
      messagesToForward.length === envelope.messages.length
    ) {
      return { data, isBinary };
    }
    return serializeJsonRpcEnvelope(envelope.isBatch, messagesToForward);
  }

  private async applyMcpProfileToClientMessage(
    connection: BridgeConnection,
    message: JsonRpcMessage,
  ): Promise<JsonRpcMessage> {
    if (!isMcpThreadLifecycleMethod(message.method)) {
      return message;
    }

    const params = asRecord(message.params) ?? {};
    const existingConfig = asRecord(params.config) ?? {};
    const cwd = await this.resolveMcpConfigCwd(
      connection,
      message.method,
      params,
    );
    const configReadResult = asRecord(
      await this.requestUpstream(connection, "config/read", {
        includeLayers: false,
        ...(cwd ? { cwd } : {}),
      }),
    );
    if (!configReadResult || !("config" in configReadResult)) {
      throw new Error("Codex config/read returned no effective config");
    }
    const mcpMode =
      connection.profile === "light" ? "standard" : connection.profile;
    const mcpProfile = resolveCodexMcpThreadProfile(
      mcpMode,
      configReadResult.config,
      existingConfig,
    );
    return {
      ...message,
      params: {
        ...params,
        config: {
          ...existingConfig,
          mcp_servers: mcpProfile.threadConfig.mcp_servers,
        },
      },
    };
  }

  private async resolveMcpConfigCwd(
    connection: BridgeConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<string | undefined> {
    const explicitCwd = getString(params.cwd);
    if (explicitCwd) return explicitCwd;

    const threadId = getString(params.threadId) ?? getString(params.thread_id);
    if (!threadId) return undefined;
    const known = this.sessions.get(threadId);
    if (known?.projectPathKnown) return known.projectPath;
    if (method === "thread/start") return undefined;

    // Resume/fork requests from some Codex clients omit cwd. Resolve it from
    // persisted thread metadata so project-level MCP config is still applied.
    try {
      const threadRead = asRecord(
        await this.requestUpstream(connection, "thread/read", {
          threadId,
          includeTurns: false,
        }),
      );
      return getString(asRecord(threadRead?.thread)?.cwd);
    } catch (error) {
      const diagnostic = projectBridgePublicDiagnostic(error);
      const safeThreadId = sanitizeBridgeDiagnosticIdentifier(threadId);
      console.debug(
        `[CodexBridge] Could not resolve MCP cwd method=${method}${safeThreadId ? ` thread=${safeThreadId}` : ""} ${diagnostic.logFields}`,
      );
      return undefined;
    }
  }

  private async requestUpstream(
    connection: BridgeConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (connection.upstreamReady) await connection.upstreamReady;
    if (connection.closed) {
      throw new Error("Codex bridge connection closed");
    }
    const upstream = connection.upstream;
    if (!upstream || upstream.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server connection is not ready");
    }

    const id = `yep-internal:${connection.id}:${connection.nextInternalRequestId++}`;
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        connection.pendingInternalRequests.delete(idKey(id));
        reject(
          new Error(
            `Timed out waiting for Codex app-server ${method} after ${INTERNAL_REQUEST_TIMEOUT_MS}ms`,
          ),
        );
      }, INTERNAL_REQUEST_TIMEOUT_MS);
      connection.pendingInternalRequests.set(idKey(id), {
        method,
        resolve,
        reject,
        timeout,
      });
      try {
        upstream.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }),
        );
      } catch (error) {
        clearTimeout(timeout);
        connection.pendingInternalRequests.delete(idKey(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async observeServerData(
    connection: BridgeConnection,
    data: RawData,
    isBinary: boolean,
  ): Promise<ForwardedFrame | null> {
    const envelope = parseJsonRpcEnvelope(data);
    const messages = envelope?.messages;
    if (!messages) {
      return { data, isBinary };
    }

    const messagesToForward: JsonRpcMessage[] = [];
    let modified = false;
    for (const message of messages) {
      if (!message.method && message.id !== undefined) {
        const key = idKey(message.id);
        const internal = connection.pendingInternalRequests.get(key);
        if (internal) {
          modified = true;
          clearTimeout(internal.timeout);
          connection.pendingInternalRequests.delete(key);
          const error = asRecord(message.error);
          if (error) {
            internal.reject(
              new Error(
                getString(error.message) ??
                  `Codex app-server ${internal.method} failed`,
              ),
            );
          } else {
            internal.resolve(message.result);
          }
          continue;
        }
      }

      messagesToForward.push(message);
      if (message.method && message.id !== undefined) {
        const eventSessionId =
          await connection.eventSpine.observeServerRequest(message);
        if (!connection.closed) {
          this.recordServerRequest(
            connection,
            message,
            eventSessionId ?? undefined,
          );
        }
        continue;
      }

      if (message.method) {
        await connection.eventSpine.observeServerNotification(message);
        if (!connection.closed) {
          this.handleServerNotification(
            connection,
            message.method,
            message.params,
          );
        }
        continue;
      }

      if (message.id !== undefined) {
        const request = connection.pendingClientRequests.get(idKey(message.id));
        if (request) {
          await connection.eventSpine.observeClientResponse(
            message,
            request.eventScope,
          );
          connection.pendingClientRequests.delete(idKey(message.id));
          if (!connection.closed) {
            this.handleClientRequestResponse(connection, request, message);
          }
        }
      }
    }
    if (!modified) return { data, isBinary };
    if (messagesToForward.length === 0) return null;
    return serializeJsonRpcEnvelope(envelope.isBatch, messagesToForward);
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
        const pending = this.findPendingForThread(threadId);
        const statusActivity = this.activityFromThreadStatus(p?.status);
        const activity = pending ? "waiting-input" : statusActivity;
        record.turnActive = statusActivity !== "idle";
        if (getString(asRecord(p?.status)?.type) === "systemError") {
          record.lastTurnStatus = "failed";
        }
        record.activityBeforePending = pending
          ? statusActivity === "idle"
            ? "idle"
            : "in-turn"
          : undefined;
        record.activity = activity;
        record.pendingInputType = pending?.pendingInputType;
        record.updatedAt = new Date().toISOString();
        this.emitSessionStatus(
          record,
          bridgeOwnership(this.isSessionActive(threadId)),
        );
        this.emitProcessState(record, activity, record.pendingInputType);
        this.schedulePersist();
        break;
      }
      case "thread/name/updated": {
        const threadId = getString(p?.threadId);
        if (!threadId) break;
        const record = this.sessions.get(threadId);
        if (!record) break;
        const name = sanitizeBridgePublicTitle(getString(p?.threadName));
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
        const pending = this.findPendingForThread(threadId);
        record.turnActive = true;
        record.lastTurnStatus = undefined;
        record.lastErrorMessage = undefined;
        record.activityBeforePending = pending ? "in-turn" : undefined;
        record.activity = pending ? "waiting-input" : "in-turn";
        record.updatedAt = new Date().toISOString();
        this.emitSessionCreated(record);
        this.emitSessionStatus(record, { owner: "external" });
        this.emitProcessState(record, record.activity, record.pendingInputType);
        this.schedulePersist();
        break;
      }
      case "turn/plan/updated": {
        const threadId = getString(p?.threadId);
        if (!threadId) break;
        const record = this.sessions.get(threadId);
        if (!record) break;
        // The code-mode exec call is persisted before update_plan runs. Tell
        // Yep clients to reload that durable message so the nested plan card
        // appears while an external Codex turn is still active.
        record.updatedAt = new Date().toISOString();
        this.emitSessionUpdated(record, "codex-plan-updated");
        break;
      }
      case "turn/completed": {
        const threadId = getString(p?.threadId);
        if (!threadId) break;
        const record = this.sessions.get(threadId);
        if (!record) break;
        const turn = asRecord(p?.turn);
        const turnId = getString(turn?.id);
        if (!turnId || !record.completedTurnIds.has(turnId)) {
          record.messageCount += 1;
          if (turnId) record.completedTurnIds.add(turnId);
        }
        // turn/completed is the terminal notification for every turn; the
        // turn.status field distinguishes completed/interrupted/failed.
        const turnStatus = getString(turn?.status);
        record.lastTurnStatus =
          turnStatus === "failed"
            ? "failed"
            : turnStatus === "interrupted"
              ? "interrupted"
              : "completed";
        record.lastErrorMessage =
          turnStatus === "failed"
            ? sanitizeBridgePublicError(
                turn?.error ?? record.lastErrorMessage ?? "Codex turn failed",
              )
            : undefined;
        this.resolvePendingForThread(threadId, "turn-completed");
        record.turnActive = false;
        record.activity = "idle";
        record.activityBeforePending = undefined;
        record.pendingInputType = undefined;
        record.updatedAt = new Date().toISOString();
        this.emitSessionCreated(record);
        this.emitSessionUpdated(record);
        this.emitSessionStatus(
          record,
          bridgeOwnership(this.isSessionActive(threadId)),
        );
        this.emitProcessState(record, "idle");
        this.schedulePersist();
        break;
      }
      case "error": {
        // Non-retryable errors terminate the active turn. Retryable errors
        // (willRetry=true) keep the turn alive per the app-server contract.
        const threadId = getString(p?.threadId);
        if (!threadId) break;
        const record = this.sessions.get(threadId);
        if (!record) break;
        record.lastErrorMessage = sanitizeBridgePublicError(
          p?.error ?? "Codex reported an error",
        );
        record.updatedAt = new Date().toISOString();
        if (p?.willRetry !== true) {
          record.lastTurnStatus = "failed";
          record.turnActive = false;
          this.resolvePendingForThread(threadId, "turn-error");
          record.activity = "idle";
          record.activityBeforePending = undefined;
          record.pendingInputType = undefined;
          this.emitSessionStatus(
            record,
            bridgeOwnership(this.isSessionActive(threadId)),
          );
          this.emitProcessState(record, "idle");
        }
        this.schedulePersist();
        break;
      }
      case "thread/closed": {
        const threadId = getString(p?.threadId);
        if (!threadId) break;
        this.resolvePendingForThread(threadId, "thread-closed");
        connection.threadIds.delete(threadId);
        const record = this.sessions.get(threadId);
        if (!record) break;
        record.connectionIds.delete(connection.id);
        record.updatedAt = new Date().toISOString();
        if (record.connectionIds.size === 0) {
          record.activity = "idle";
          record.turnActive = false;
          record.activityBeforePending = undefined;
          record.pendingInputType = undefined;
          this.emitSessionStatus(record, { owner: "none" });
          this.emitProcessState(record, "idle");
        }
        this.schedulePersist();
        break;
      }
      case "serverRequest/resolved": {
        const threadId = getString(p?.threadId);
        const requestId = p?.requestId as JsonRpcId | undefined;
        if (!threadId || requestId === undefined) break;
        const rpcKey = idKey(requestId);
        this.addResolvedServerRequestId(connection, rpcKey);
        const pending =
          this.findPendingByConnectionAndRpcId(connection, requestId) ??
          this.findPendingByThreadAndRpcId(threadId, requestId);
        if (pending) {
          this.markLogicalRequestResolved(pending);
          this.resolveLogicalRequest(pending, "server");
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
    const rawError = params?.error;
    const diagnostic =
      rawError === null || rawError === undefined
        ? null
        : projectBridgePublicDiagnostic(rawError);
    const event: CodexBridgeMcpStartupEvent = {
      timestamp: new Date().toISOString(),
      profile: connection.profile,
      connectionId: connection.id,
      error: diagnostic?.publicMessage ?? null,
    };
    const threadId = sanitizeBridgeDiagnosticIdentifier(
      getString(params?.threadId),
    );
    const name = sanitizeBridgeDiagnosticIdentifier(getString(params?.name));
    const status = sanitizeBridgeDiagnosticIdentifier(
      getString(params?.status),
    );
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
        diagnostic ? diagnostic.logFields : null,
      ]
        .filter((part): part is string => typeof part === "string")
        .join(" "),
    );
  }

  private recordServerRequest(
    connection: BridgeConnection,
    message: JsonRpcMessage,
    eventSessionId?: string,
  ): void {
    if (message.id === undefined || !message.method) return;
    if (!isCodexInteractiveMethod(message.method)) return;

    const params = asRecord(message.params) ?? {};
    const threadId =
      getString(params.threadId) ?? getString(params.conversationId);
    if (!threadId) return;

    this.trackThreadConnection(connection, threadId);

    const rpcKey = idKey(message.id);
    const requestKey = buildCodexPendingInputId(
      connection.id,
      message,
      threadId,
      params,
    );
    connection.resolvedServerRequestIds.delete(rpcKey);
    const createdAt = new Date().toISOString();
    const view = toCodexInteractiveRequestView(
      requestKey,
      message.method,
      threadId,
      params,
      createdAt,
    );
    const pending: PendingServerRequest = {
      inputId: requestKey,
      rpcId: message.id,
      rpcKey,
      requestKey,
      method: message.method,
      params,
      threadId,
      turnId: getString(params.turnId),
      itemId: getString(params.itemId) ?? getString(params.callId),
      inputRequest: view.inputRequest,
      pendingInputType: view.pendingInputType,
      connection,
      createdAt,
      eventSessionId: eventSessionId ?? threadId,
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
    if (record.activity !== "waiting-input") {
      record.activityBeforePending =
        getString(params.turnId) ||
        message.method !== "mcpServer/elicitation/request"
          ? "in-turn"
          : record.activity === "in-turn"
            ? "in-turn"
            : "idle";
    }
    record.activity = "waiting-input";
    record.pendingInputType = view.pendingInputType;
    record.updatedAt = createdAt;

    const visibleRecord =
      this.sessions.get(this.getTopLevelSessionId(threadId)) ?? record;
    if (visibleRecord !== record) {
      if (visibleRecord.activity !== "waiting-input") {
        visibleRecord.activityBeforePending =
          visibleRecord.activity === "in-turn" ? "in-turn" : "idle";
      }
      visibleRecord.activity = "waiting-input";
      visibleRecord.pendingInputType = view.pendingInputType;
      visibleRecord.updatedAt = createdAt;
    }
    this.emitSessionCreated(visibleRecord);
    this.emitSessionStatus(visibleRecord, { owner: "external" });
    this.emitProcessState(
      visibleRecord,
      "waiting-input",
      view.pendingInputType,
    );
  }

  private resolvePendingRequest(
    pending: PendingServerRequest,
    _source: string,
  ): void {
    this.pendingByInputId.delete(pending.inputId);
    this.pendingInputBindings.delete(pending.inputId);
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
    this.maybeCloseDetachedConnection(pending.connection, "input-resolved");
  }

  private resolveLogicalRequest(
    pending: PendingServerRequest,
    source: string,
  ): void {
    for (const candidate of this.findLogicalRequests(pending)) {
      this.resolvePendingRequest(candidate, source);
    }
  }

  private resolvePendingForThread(threadId: string, source: string): void {
    const ids = Array.from(this.pendingIdsByThread.get(threadId) ?? []);
    for (const id of ids) {
      const pending = this.pendingByInputId.get(id);
      if (pending) this.resolvePendingRequest(pending, source);
    }
  }

  private findLogicalRequests(
    pending: PendingServerRequest,
  ): PendingServerRequest[] {
    return Array.from(this.pendingByInputId.values()).filter(
      (candidate) =>
        candidate.threadId === pending.threadId &&
        candidate.rpcKey === pending.rpcKey &&
        candidate.method === pending.method &&
        (this.upstreamUrlOverride !== undefined ||
          candidate.connection.profile === pending.connection.profile),
    );
  }

  private getLogicalPendingInputCount(): number {
    const keys = new Set<string>();
    for (const pending of this.pendingByInputId.values()) {
      const upstreamKey = this.upstreamUrlOverride
        ? "external"
        : pending.connection.profile;
      keys.add(
        [upstreamKey, pending.threadId, pending.rpcKey, pending.method].join(
          "|",
        ),
      );
    }
    return keys.size;
  }

  private markLogicalRequestResolved(
    pending: PendingServerRequest,
    exceptConnection?: BridgeConnection,
  ): void {
    for (const candidate of this.findLogicalRequests(pending)) {
      if (candidate.connection === exceptConnection) continue;
      this.addResolvedServerRequestId(candidate.connection, candidate.rpcKey);
    }
  }

  private addResolvedServerRequestId(
    connection: BridgeConnection,
    rpcKey: string,
  ): void {
    connection.resolvedServerRequestIds.add(rpcKey);
    if (
      connection.resolvedServerRequestIds.size > MAX_RESOLVED_SERVER_REQUEST_IDS
    ) {
      const oldest = connection.resolvedServerRequestIds.values().next().value;
      if (typeof oldest === "string") {
        connection.resolvedServerRequestIds.delete(oldest);
      }
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
      // Fall back to the tracked turn state: defaulting to "in-turn" left
      // sessions stuck as "running" when the pending input outlived the turn.
      record.activity =
        record.activityBeforePending ??
        (record.turnActive ? "in-turn" : "idle");
      record.activityBeforePending = undefined;
      this.emitProcessState(record, record.activity);
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
      title: sanitizeBridgePublicTitle(
        getString(thread.name) ?? getString(thread.preview),
      ),
      createdAt: timestampFromThreadValue(thread.createdAt),
      updatedAt: timestampFromThreadValue(thread.updatedAt),
      messageCount: Array.isArray(thread.turns)
        ? thread.turns.length
        : undefined,
    });
    if (Array.isArray(thread.turns)) {
      for (const rawTurn of thread.turns) {
        const turnId = getString(asRecord(rawTurn)?.id);
        if (turnId) record.completedTurnIds.add(turnId);
      }
    }
    this.trackThreadConnection(connection, id);

    const status = asRecord(thread.status);
    if (status) {
      const pending = this.findPendingForThread(id);
      const statusActivity = this.activityFromThreadStatus(status);
      record.activity = pending ? "waiting-input" : statusActivity;
      record.activityBeforePending = pending
        ? statusActivity === "idle"
          ? "idle"
          : "in-turn"
        : undefined;
      record.pendingInputType = pending?.pendingInputType;
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
      projectPathKnown: values.cwd !== undefined,
      title: null,
      fullTitle: null,
      createdAt: values.createdAt ?? now,
      updatedAt: values.updatedAt ?? now,
      messageCount: 0,
      activity: "idle",
      turnActive: false,
      connectionIds: new Set(),
      completedTurnIds: new Set(),
    };

    if (values.cwd && values.cwd !== record.projectPath) {
      record.projectPath = values.cwd;
      record.projectId = encodeProjectId(values.cwd);
      record.projectName = basename(values.cwd);
    }
    if (values.cwd) {
      record.projectPathKnown = true;
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
    this.schedulePersist();
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

  /**
   * Debounced persistence of session metadata. The bridge previously kept all
   * session state in memory only, so a 4510 restart forgot every external
   * session until the TUI reconnected.
   */
  private schedulePersist(): void {
    if (!this.statePath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistSessions();
    }, 500);
    this.persistTimer.unref?.();
  }

  private persistSessions(): Promise<void> {
    const statePath = this.statePath;
    if (!statePath) return Promise.resolve();
    const records: PersistedSessionRecord[] = Array.from(this.sessions.values())
      .filter((record) => !record.isSubagent && record.projectPathKnown)
      .map((record) => ({
        id: record.id,
        isSubagent: record.isSubagent,
        threadMetadataKnown: record.threadMetadataKnown,
        parentThreadId: record.parentThreadId,
        projectPath: record.projectPath,
        projectPathKnown: record.projectPathKnown,
        title: record.title,
        fullTitle: record.fullTitle,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messageCount,
        model: record.model,
        reasoningEffort: record.reasoningEffort,
        serviceTier: record.serviceTier,
        lastTurnStatus: record.lastTurnStatus,
        lastErrorMessage: record.lastErrorMessage,
        completedTurnIds: Array.from(record.completedTurnIds),
        emitted: this.emittedSessionIds.has(record.id),
      }));
    const payload = JSON.stringify({ version: 1, sessions: records });
    const writeSnapshot = async (): Promise<void> => {
      try {
        await mkdir(dirname(statePath), { recursive: true });
        const tmpPath = `${statePath}.tmp`;
        await writeFile(tmpPath, payload, "utf8");
        await rename(tmpPath, statePath);
      } catch (error) {
        const diagnostic = projectBridgePublicDiagnostic(error);
        console.warn(
          `[CodexBridge] Failed to persist session state ${diagnostic.logFields}`,
        );
      }
    };
    this.persistChain = this.persistChain.then(writeSnapshot, writeSnapshot);
    return this.persistChain;
  }

  private async restorePersistedSessions(): Promise<void> {
    if (!this.statePath) return;
    let parsed: { version?: number; sessions?: PersistedSessionRecord[] };
    try {
      parsed = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch {
      return; // No state file yet, or unreadable - start fresh.
    }
    if (!Array.isArray(parsed.sessions)) return;
    let needsSafeRewrite = false;
    for (const stored of parsed.sessions) {
      if (!stored || typeof stored.id !== "string" || !stored.projectPath) {
        continue;
      }
      if (this.sessions.has(stored.id)) continue;
      const restoredTitle = sanitizeBridgePublicTitle(stored.title);
      const restoredFullTitle = sanitizeBridgePublicTitle(stored.fullTitle);
      const restoredLastError =
        typeof stored.lastErrorMessage === "string"
          ? sanitizeBridgePublicError(stored.lastErrorMessage)
          : undefined;
      if (
        restoredTitle !== (stored.title ?? undefined) ||
        restoredFullTitle !== (stored.fullTitle ?? undefined) ||
        restoredLastError !== stored.lastErrorMessage
      ) {
        needsSafeRewrite = true;
      }
      const record: SessionRecord = {
        id: stored.id,
        isSubagent: stored.isSubagent === true,
        threadMetadataKnown: stored.threadMetadataKnown === true,
        parentThreadId: stored.parentThreadId,
        projectId: encodeProjectId(stored.projectPath),
        projectPath: stored.projectPath,
        projectName: basename(stored.projectPath),
        projectPathKnown: stored.projectPathKnown === true,
        title: restoredTitle ?? null,
        fullTitle: restoredFullTitle ?? null,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        messageCount:
          typeof stored.messageCount === "number" ? stored.messageCount : 0,
        model: stored.model,
        reasoningEffort: stored.reasoningEffort,
        serviceTier: stored.serviceTier,
        // Restored sessions have no live connection; they are idle until a
        // TUI reconnects and reports fresh status.
        activity: "idle",
        turnActive: false,
        lastTurnStatus: stored.lastTurnStatus,
        lastErrorMessage: restoredLastError,
        connectionIds: new Set(),
        completedTurnIds: new Set(
          Array.isArray(stored.completedTurnIds) ? stored.completedTurnIds : [],
        ),
      };
      this.sessions.set(record.id, record);
      if (stored.emitted) {
        this.emittedSessionIds.add(record.id);
      }
    }
    if (needsSafeRewrite) {
      await this.persistSessions();
    }
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
    // projectPathKnown gate: sessions created from bare threadIds fall back
    // to the bridge process cwd. Exposing them would file the session under
    // the wrong project, so they stay hidden until thread metadata arrives
    // (thread/start response or thread/started notification carries cwd).
    return (
      record.threadMetadataKnown &&
      !record.isSubagent &&
      record.projectPathKnown
    );
  }

  private emitSessionCreated(record: SessionRecord): void {
    if (!this.isTopLevelSessionRecord(record)) return;
    const session = this.toBridgeSession(record);
    if (!this.isDisplayableBridgeSession(session)) {
      return;
    }
    this.eventNotifier.notify();
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
    this.eventNotifier.notify();
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
    this.eventNotifier.notify();
    this.eventBus?.emit({
      type: "process-state-changed",
      sessionId: record.id,
      projectId: record.projectId,
      activity,
      pendingInputType,
      lastTurnStatus: record.lastTurnStatus,
      lastErrorMessage: record.lastErrorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  private emitSessionUpdated(
    record: SessionRecord,
    trigger?: "codex-plan-updated",
  ): void {
    if (!this.isTopLevelSessionRecord(record)) return;
    this.eventNotifier.notify();
    this.eventBus?.emit({
      type: "session-updated",
      sessionId: record.id,
      projectId: record.projectId,
      ...(trigger ? { trigger } : {}),
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
      lastTurnStatus: record.lastTurnStatus,
      lastErrorMessage: record.lastErrorMessage,
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
      lastTurnStatus: session.lastTurnStatus,
      lastErrorMessage: session.lastErrorMessage,
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
    const state = this.getUpstreamState(profile);
    const mcpMode = profile === "light" ? "standard" : profile;
    const args = getCodexMcpAppServerArgs(
      mcpMode,
      this.upstreamArgsByProfile[profile],
    );
    const port = await this.findAvailableManagedPort(startPort);
    const url = `ws://127.0.0.1:${port}`;
    const spawnArgs = ["app-server", ...args, "--listen", url];
    console.log(
      `[CodexBridge] Starting managed Codex app-server profile=${profile} configuredArgs=${args.length}`,
    );
    const child = spawn(codexPath, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: process.env,
    });
    let rejectChildError: (error: Error) => void = () => undefined;
    const childError = new Promise<never>((_resolve, reject) => {
      rejectChildError = reject;
    });
    child.on("error", (error) => {
      const diagnostic = projectBridgePublicDiagnostic(error);
      this.lastError = diagnostic.publicMessage;
      console.warn(
        `[CodexBridge] Managed app-server profile=${profile} process error ${diagnostic.logFields}`,
      );
      rejectChildError(error);
    });
    state.process = child;
    state.url = url;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        const diagnostic = projectBridgePublicDiagnostic(text);
        console.debug(
          `[CodexBridge upstream:${profile}] stdout ${diagnostic.logFields}`,
        );
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        const diagnostic = projectBridgePublicDiagnostic(text);
        console.debug(
          `[CodexBridge upstream:${profile}] stderr ${diagnostic.logFields}`,
        );
      }
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
      await Promise.race([
        waitForWebSocket(url, this.startupTimeoutMs),
        childError,
      ]);
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
      `[CodexBridge] Managed Codex app-server profile=${profile} ready`,
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
    if (!child) return;
    await terminateProcessGroup(child);
  }

  private getUpstreamState(
    profile: CodexBridgeUpstreamProfile,
  ): CodexBridgeUpstreamState {
    let state = this.upstreams.get(profile);
    if (!state) {
      state = {
        process: null,
        url: null,
        startPromise: null,
      };
      this.upstreams.set(profile, state);
    }
    return state;
  }

  private async findAvailableManagedPort(startPort: number): Promise<number> {
    return findAvailablePort(startPort, {
      reservedPorts: this.reservedUpstreamPorts,
    });
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
      url: sanitizeBridgePublicUrl(
        this.upstreamUrlOverride ?? state?.url ?? null,
      ),
      running: this.upstreamUrlOverride ? false : running,
      starting: this.upstreamUrlOverride
        ? false
        : !!state?.startPromise && !running,
      pid: this.upstreamUrlOverride ? null : (process?.pid ?? null),
      args: summarizeBridgePublicArgs(this.upstreamArgsByProfile[profile]),
    };
  }

  private isManagedUpstreamRunning(
    profile: CodexBridgeUpstreamProfile,
  ): boolean {
    return isChildRunning(this.upstreams.get(profile)?.process ?? null);
  }

  private isAnyManagedUpstreamRunning(): boolean {
    return (
      this.isManagedUpstreamRunning("clear") ||
      this.isManagedUpstreamRunning("light") ||
      this.isManagedUpstreamRunning("full")
    );
  }
}

interface JsonRpcEnvelope {
  messages: JsonRpcMessage[];
  isBatch: boolean;
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

function serializeJsonRpcEnvelope(
  isBatch: boolean,
  messages: JsonRpcMessage[],
): ForwardedFrame | null {
  if (messages.length === 0) return null;
  return {
    data: Buffer.from(JSON.stringify(isBatch ? messages : messages[0]), "utf8"),
    isBinary: false,
  };
}

function parseMcpProfile(
  url: string | undefined,
  authorization: string | undefined,
  profileHeader: string | undefined,
  authenticationRequired: boolean,
): CodexBridgeUpstreamProfile {
  const token = (
    profileHeader ??
    (authenticationRequired
      ? undefined
      : authorization?.replace(/^Bearer\s+/i, ""))
  )
    ?.trim()
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
    value === "approve_strict_auto_review" ||
    value === "approve_always" ||
    value === "deny"
    ? value
    : null;
}

function bearerTokenMatches(
  authorization: string | undefined,
  expected: string | undefined,
): boolean {
  if (!authorization || !expected) return false;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) return false;
  const supplied = Buffer.from(match[1] as string, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function readSingleHeader(
  req: IncomingMessage,
  name: string,
): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function writeBridgeHttpError(
  res: ServerResponse,
  status: 401 | 403 | 404 | 409 | 500,
  code: string,
  error: string,
): void {
  writeJson(res, status, { error, code });
}

function readBodyString(
  body: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = body?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isValidOperationId(value: string): boolean {
  return /^int_[A-Za-z0-9_-]{16,124}$/.test(value);
}

function isValidResolutionActor(
  actor: BridgeInputResolutionContext["actor"],
): boolean {
  return (
    actor.id.length > 0 &&
    actor.id.length <= 512 &&
    (actor.displayName === undefined || actor.displayName.length <= 512) &&
    (actor.channel === "yep" ||
      actor.channel === "feishu" ||
      actor.channel === "provider" ||
      actor.channel === "system")
  );
}

function parseInputResolutionContext(
  body: Record<string, unknown> | null,
): BridgeInputResolutionContext | null {
  const operationId = readBodyString(body, "operationId");
  const operationVersion = body?.operationVersion;
  const actorRecord = asRecord(body?.actor);
  const actorId = getString(actorRecord?.id)?.trim();
  const displayName = getString(actorRecord?.displayName)?.trim();
  const channel = getString(actorRecord?.channel);
  if (
    !operationId ||
    !isValidOperationId(operationId) ||
    !Number.isSafeInteger(operationVersion) ||
    (operationVersion as number) < 1 ||
    !actorId ||
    actorId.length > 512 ||
    (displayName?.length ?? 0) > 512 ||
    (channel !== "yep" &&
      channel !== "feishu" &&
      channel !== "provider" &&
      channel !== "system")
  ) {
    return null;
  }
  return {
    operationId,
    operationVersion: operationVersion as number,
    actor: {
      id: actorId,
      ...(displayName ? { displayName } : {}),
      channel,
    },
  };
}

function sendFrame(ws: WebSocket, data: RawData, isBinary: boolean): void {
  ws.send(data, { binary: isBinary });
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return !!value && typeof value === "object";
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeBridgePublicTitle(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = sanitizeManagedAttachmentPrompt(value).trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeBridgePublicError(error: unknown): string {
  return classifyCodexError(error).publicMessage;
}

function projectBridgePublicDiagnostic(error: unknown): {
  publicMessage: string;
  logFields: string;
} {
  const classified = classifyCodexError(error);
  return {
    publicMessage: classified.publicMessage,
    logFields: `code=${classified.code} category=${classified.category} retryable=${String(classified.retryable)}`,
  };
}

function sanitizeBridgePublicUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "ws:" &&
      parsed.protocol !== "wss:" &&
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return null;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function summarizeBridgePublicArgs(args: readonly string[]): string[] {
  return args.length === 0
    ? []
    : [
        `[${args.length} configured argument${args.length === 1 ? "" : "s"} hidden]`,
      ];
}

function sanitizeBridgeDiagnosticIdentifier(
  value: string | undefined,
): string | undefined {
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : undefined;
}

function timestampFromThreadValue(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const ms = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(ms).toISOString();
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
