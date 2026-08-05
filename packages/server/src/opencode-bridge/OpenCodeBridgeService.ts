import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type {
  AgentActivity,
  InputRequest,
  OpenCodeSessionConfig,
  PendingInputType,
  SessionLastTurnStatus,
  UrlProjectId,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { BridgeEventNotifier } from "../bridge-common/BridgeEventNotifier.js";
import {
  asRecord,
  findAvailablePort,
  isChildRunning,
  isLocalAddress,
  terminateProcessGroup,
  writeJson,
} from "../bridge-common/util.js";
import {
  OPENCODE_ACTIVE_RECONCILE_INTERVAL_MS,
  OPENCODE_IDLE_QUIET_WINDOW_MS,
  OPENCODE_STATUS_FAILURE_GRACE_MS,
  createOpenCodeLifecycleState,
  isOpenCodeToolPartPending,
  parseOpenCodeUpstreamStatus,
  projectOpenCodeLifecycle,
  readOpenCodeAssistantTerminalEvidence,
  readOpenCodeSessionStatus,
  reduceOpenCodeLifecycle,
} from "../opencode-lifecycle/index.js";
import type {
  OpenCodeAssistantTerminalEvidence,
  OpenCodeLifecycleAction,
  OpenCodeLifecycleState,
} from "../opencode-lifecycle/index.js";
import {
  buildOpenCodeQuestionAnswers,
  normalizeOpenCodeQuestions,
} from "../opencode/questions.js";
import { encodeProjectId } from "../projects/paths.js";
import { normalizeProviderGeneratedTitle } from "../sessions/provider-title-quality.js";
import { validateQuestionAnswers } from "../sessions/question-answers.js";
import type { SessionSummary } from "../supervisor/types.js";
import {
  type OpenCodeGatewayConfig,
  buildUserConfiguredOpenCodeEnv,
  gatewayResponseNeedsBuffering,
} from "./gateway-config.js";
import {
  isLiveOpenCodeBridgeSession,
  isLiveOpenCodeBridgeSessionView,
  opencodeBridgeOwnership,
} from "./session-state.js";
import type {
  ExternalOpenCodeDecision,
  OpenCodeApprovalProtocol,
  OpenCodeBridgeController,
  OpenCodeBridgeInputResponse,
  OpenCodeBridgePendingInput,
  OpenCodeBridgeSession,
  OpenCodeBridgeSessionView,
  OpenCodeBridgeStatus,
} from "./types.js";

/** External instances silent for longer than this are considered gone. */
const EXTERNAL_INSTANCE_STALE_MS = 90_000;
/** Stale external instances are forgotten entirely after this long. */
const EXTERNAL_INSTANCE_FORGET_MS = 10 * 60_000;
/** Upper bound for the plugin decision long-poll. */
const EXTERNAL_DECISION_MAX_WAIT_MS = 25_000;

type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "auto";

type InputResponse = OpenCodeBridgeInputResponse;

interface OpenCodeBridgeServiceOptions {
  enabled: boolean;
  host: string;
  port: number;
  serverUrl: string;
  opencodeServerUrl?: string;
  opencodeStartPort?: number;
  opencodePath?: string;
  startupTimeoutMs?: number;
  desktopToken?: string;
  gatewayConfig?: OpenCodeGatewayConfig | null;
  lifecycle?: {
    quietWindowMs?: number;
    reconcileIntervalMs?: number;
    statusFailureGraceMs?: number;
  };
  /**
   * Freshness window for read-triggered runtime reconciliation. Reads served
   * inside the window reuse the in-memory snapshot instead of hitting the
   * upstream OpenCode server again. Primarily an escape hatch for tests.
   */
  runtimeSyncMinIntervalMs?: number;
  /**
   * Safety-net sweep interval for directories whose sessions are all settled.
   * Primarily an escape hatch for tests.
   */
  idleDirectorySyncIntervalMs?: number;
  /**
   * When set, session records survive bridge restarts by being persisted to
   * this JSON file (metadata only; live runtime state is rebuilt).
   */
  statePath?: string;
}

interface SessionRecord {
  id: string;
  parentSessionId?: string;
  projectId: UrlProjectId;
  cwd: string;
  serverUrl: string;
  desktopToken?: string;
  createdAt: string;
  updatedAt: string;
  processId?: string;
  model?: string;
  reasoningEffort?: string;
  mode?: PermissionMode;
  title?: string | null;
  messageCount?: number;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  active?: boolean;
  /** Terminal status of the most recent turn, aligned with codex-bridge. */
  lastTurnStatus?: SessionLastTurnStatus;
  /** Most recent session.error message, cleared when a new turn starts. */
  lastErrorMessage?: string;
  /** Present while OpenCode is retrying a failed provider request. */
  retryStatus?: {
    attempt?: number;
    message?: string;
    /** Epoch ms of the next retry attempt. */
    next?: number;
    actionLabel?: string;
    actionLink?: string;
  };
  /**
   * Present when the session lives in an external OpenCode instance (default
   * `opencode` TUI etc.) observed via the Yep forwarder plugin rather than
   * the bridge-managed server.
   */
  instanceId?: string;
}

/**
 * JSON-serializable subset of SessionRecord persisted across bridge restarts.
 * Live runtime fields (activity, pendingInputType, active, retryStatus,
 * instanceId) are intentionally dropped: a restarted bridge has no live
 * connection, so restored sessions always come back idle.
 */
interface PersistedSessionRecord {
  id: string;
  parentSessionId?: string;
  cwd: string;
  serverUrl: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: string;
  mode?: PermissionMode;
  title?: string | null;
  messageCount?: number;
  lastTurnStatus?: SessionLastTurnStatus;
  lastErrorMessage?: string;
}

function retryStatusEquals(
  a: SessionRecord["retryStatus"],
  b: SessionRecord["retryStatus"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.attempt === b.attempt &&
    a.message === b.message &&
    a.next === b.next &&
    a.actionLabel === b.actionLabel &&
    a.actionLink === b.actionLink
  );
}

/**
 * An external OpenCode instance (default TUI / `opencode run` / standalone
 * serve) connected through the Yep forwarder plugin. The plugin pushes events
 * to the bridge and long-polls for user decisions; `lastSeenAt` doubles as a
 * liveness heartbeat since these instances have no reachable HTTP server.
 */
interface ExternalOpenCodeInstance {
  id: string;
  directory: string;
  lastSeenAt: number;
  /** Unacknowledged decisions. Entries remain available across long-polls. */
  decisions: Map<string, ExternalOpenCodeDecision>;
  waiters: Array<() => void>;
}

interface ExternalDecisionWaiter {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface StartSessionResponse {
  sessionId?: string;
  processId?: string;
  reasoningEffort?: string;
  queued?: boolean;
  queueId?: string;
  position?: number;
}

interface QueueMessageResponse {
  queued: boolean;
  restarted?: boolean;
  processId?: string;
}

interface ProcessInfoResponse {
  process: { id: string; state: string } | null;
}

interface InputRequestBody {
  requestId?: string;
  response?: InputResponse;
  answers?: UserQuestionAnswers;
  feedback?: string;
}

interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

interface ClientConfig {
  serverUrl: string;
  desktopToken?: string;
}

interface OpenCodeEvent {
  type?: unknown;
  properties?: unknown;
}

interface OpenCodeEventOrigin {
  instanceId?: string;
  directory?: string;
}

interface OpenCodeBridgeLifecycle {
  state: OpenCodeLifecycleState;
  timer: ReturnType<typeof setTimeout> | null;
  reconcilePromise: Promise<void> | null;
  unsettledToolParts: Set<string>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const GATEWAY_PATH_PREFIX = "/gateway/v1";
const EXTERNAL_DECISION_CONFIRM_TIMEOUT_MS = 30_000;
/**
 * Freshness window for reconciliations triggered by inbound bridge HTTP reads.
 * The main server polls `/session-views` on every push notification (~20/s
 * during a busy turn); without this floor each poll fanned out
 * 3 endpoints x N directories of upstream requests, which exhausted the
 * machine's ephemeral ports with TIME_WAIT sockets.
 */
const RUNTIME_SYNC_MIN_INTERVAL_MS = 750;
/**
 * Directories whose sessions are all settled are reconciled at most this
 * often. They cannot change without an upstream event, so the sweep is only a
 * safety net against missed events / externally started sessions.
 */
const IDLE_DIRECTORY_SYNC_INTERVAL_MS = 5_000;
/** A directory stays in the fast lane for this long after its last activity. */
const DIRECTORY_ACTIVE_WINDOW_MS = 15_000;

export class OpenCodeBridgeService implements OpenCodeBridgeController {
  private readonly enabled: boolean;
  private readonly host: string;
  private readonly port: number;
  private readonly defaultServerUrl: string;
  private readonly opencodeServerUrlOverride?: string;
  private readonly opencodeStartPort: number;
  private readonly opencodePath: string;
  private readonly startupTimeoutMs: number;
  private readonly defaultDesktopToken?: string;
  private readonly gatewayConfig?: OpenCodeGatewayConfig | null;
  private readonly lifecycleQuietWindowMs: number;
  private readonly lifecycleReconcileIntervalMs: number;
  private readonly lifecycleStatusFailureGraceMs: number;
  private readonly runtimeSyncMinIntervalMs: number;
  private readonly idleDirectorySyncIntervalMs: number;

  private server: Server | null = null;
  private listening = false;
  private opencodeConnected = false;
  private opencodeProcess: ChildProcess | null = null;
  private opencodeServerUrl: string | null = null;
  private opencodeStartPromise: Promise<string> | null = null;
  private lastError: string | null = null;
  private sessions = new Map<string, SessionRecord>();
  private lifecycles = new Map<string, OpenCodeBridgeLifecycle>();
  private pendingInputs = new Map<string, OpenCodeBridgePendingInput>();
  private externalInstances = new Map<string, ExternalOpenCodeInstance>();
  private externalDecisionWaiters = new Map<string, ExternalDecisionWaiter>();
  private readonly eventNotifier = new BridgeEventNotifier();
  private inputResponses = new Map<string, Promise<boolean>>();
  private eventAbortController: AbortController | null = null;
  private eventReconnectTimer: NodeJS.Timeout | null = null;
  /**
   * In-flight read-triggered reconciliation per managed directory, so that
   * concurrent bridge reads join one upstream fan-out instead of each starting
   * their own (single-flight).
   */
  private directorySyncInFlight = new Map<string, Promise<void>>();
  /** Last time each managed directory finished a reconciliation. */
  private directorySyncedAt = new Map<string, number>();
  private readonly statePath?: string;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes atomic writes so concurrent state changes cannot race on .tmp. */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: OpenCodeBridgeServiceOptions) {
    this.enabled = options.enabled;
    this.host = options.host;
    this.port = options.port;
    this.defaultServerUrl = normalizeUrl(options.serverUrl);
    this.opencodeServerUrlOverride = options.opencodeServerUrl
      ? normalizeUrl(options.opencodeServerUrl)
      : undefined;
    this.opencodeStartPort = options.opencodeStartPort ?? options.port + 1;
    this.opencodePath = options.opencodePath ?? "opencode";
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.defaultDesktopToken = options.desktopToken;
    this.gatewayConfig = options.gatewayConfig;
    this.statePath = options.statePath;
    this.lifecycleQuietWindowMs =
      options.lifecycle?.quietWindowMs ?? OPENCODE_IDLE_QUIET_WINDOW_MS;
    this.lifecycleReconcileIntervalMs =
      options.lifecycle?.reconcileIntervalMs ??
      OPENCODE_ACTIVE_RECONCILE_INTERVAL_MS;
    this.lifecycleStatusFailureGraceMs =
      options.lifecycle?.statusFailureGraceMs ??
      OPENCODE_STATUS_FAILURE_GRACE_MS;
    this.runtimeSyncMinIntervalMs =
      options.runtimeSyncMinIntervalMs ?? RUNTIME_SYNC_MIN_INTERVAL_MS;
    this.idleDirectorySyncIntervalMs =
      options.idleDirectorySyncIntervalMs ?? IDLE_DIRECTORY_SYNC_INTERVAL_MS;
  }

  async start(): Promise<void> {
    if (!this.enabled || this.server) return;

    await this.restorePersistedSessions();

    const server = createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        writeJson(res, 500, { error: message });
      });
    });

    this.server = server;
    await new Promise<void>((resolve) => {
      const onError = (error: Error) => {
        this.lastError = error.message;
        this.listening = false;
        this.server = null;
        console.warn(
          `[OpenCodeBridge] Failed to listen on http://${this.host}:${this.port}: ${error.message}`,
        );
        cleanup();
        resolve();
      };
      const onListening = () => {
        this.listening = true;
        this.lastError = null;
        console.log(
          `[OpenCodeBridge] Listening on http://${this.host}:${this.port}`,
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
      console.warn(`[OpenCodeBridge] Server error: ${error.message}`);
    });

    if (this.listening) {
      this.startOpenCodeEventStream();
    }
  }

  async shutdown(): Promise<void> {
    this.eventNotifier.close();
    for (const lifecycle of this.lifecycles.values()) {
      if (lifecycle.timer) clearTimeout(lifecycle.timer);
    }
    this.lifecycles.clear();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persistSessions();
    for (const instance of this.externalInstances.values()) {
      for (const waiter of instance.waiters.splice(0)) waiter();
    }
    for (const [decisionId, waiter] of this.externalDecisionWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error(`OpenCode bridge stopped before confirming ${decisionId}`),
      );
    }
    this.externalDecisionWaiters.clear();
    this.stopOpenCodeEventStream();
    if (this.server) {
      const server = this.server;
      // server.close() stops new TCP connections but waits for existing
      // keep-alive sockets. External OpenCode plugins immediately issue their
      // next decision long-poll on the same socket, which can otherwise keep a
      // LaunchAgent shutdown parked forever. Stop accepting first, then tear
      // down the remaining sockets so the managed child can be terminated.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      this.server = null;
    }
    this.listening = false;
    await this.stopManagedOpenCodeServer("shutdown");
  }

  getStatus(): OpenCodeBridgeStatus {
    return {
      enabled: this.enabled,
      listening: this.listening,
      host: this.host,
      port: this.port,
      url: `http://${this.host}:${this.port}`,
      serverUrl: this.defaultServerUrl,
      opencodeServerUrl: this.getOpenCodeServerStatusUrl(),
      opencodeServerMode: this.opencodeServerUrlOverride
        ? "external"
        : "managed",
      opencodeServerRunning: this.isManagedOpenCodeServerRunning(),
      opencodeServerPid: this.opencodeServerUrlOverride
        ? null
        : (this.opencodeProcess?.pid ?? null),
      opencodeConnected: this.opencodeConnected,
      sessionCount: Array.from(this.sessions.values()).filter(
        (session) => !session.parentSessionId,
      ).length,
      pendingInputCount: this.pendingInputs.size,
      lastError: this.lastError,
    };
  }

  listSessions(): OpenCodeBridgeSession[] {
    return Array.from(this.sessions.values())
      .filter((session) => !session.parentSessionId)
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .map((session) => this.toBridgeSession(session));
  }

  listSessionViews(): OpenCodeBridgeSessionView[] {
    return this.listSessions().map((session) => this.toSessionView(session));
  }

  getSessionView(sessionId: string): OpenCodeBridgeSessionView | null {
    const record = this.sessions.get(sessionId);
    return record ? this.toSessionView(this.toBridgeSession(record)) : null;
  }

  isSessionActive(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    return record
      ? isLiveOpenCodeBridgeSession(this.toBridgeSession(record))
      : false;
  }

  /**
   * Stop bridge reconciliation immediately when the owned provider reaches a
   * terminal state. OpenCode does not always emit session.error if the
   * upstream session has already become idle, so relying on provider events
   * alone can leave a stale lifecycle timer running indefinitely.
   */
  private finishSessionLifecycle(
    sessionId: string,
    kind: "failed" | "interrupted",
    error?: string,
  ): boolean {
    if (!this.isSessionActive(sessionId)) return false;

    const pending = this.pendingInputs.get(sessionId);
    this.pendingInputs.delete(sessionId);
    this.dispatchOpenCodeLifecycle(sessionId, {
      type: "terminal",
      now: Date.now(),
      kind,
    });
    this.updateSessionState(sessionId, {
      activity: "idle",
      pendingInputType: undefined,
      active: false,
      lastTurnStatus: kind,
      lastErrorMessage:
        kind === "failed" ? (error ?? "OpenCode reported an error") : undefined,
      retryStatus: undefined,
    });
    this.discardExternalDecision(
      pending,
      new Error(
        error ??
          `OpenCode session ${sessionId} was ${
            kind === "failed" ? "failed" : "interrupted"
          }`,
      ),
    );
    this.refreshRootPendingProjection(sessionId);
    return true;
  }

  getPendingInputRequest(sessionId: string): InputRequest | null {
    const direct = this.pendingInputs.get(sessionId);
    if (direct) return direct.request;
    // A subagent (child session) request is projected onto its root session so
    // the parent enters needs-attention; the child never appears in the top
    // level list but its blocker surfaces on the root.
    const record = this.sessions.get(sessionId);
    if (record && !record.parentSessionId) {
      const projected = this.projectedPendingForRoot(sessionId);
      if (projected) return this.projectPendingRequest(projected, sessionId);
    }
    return null;
  }

  /**
   * Resolve the top-most ancestor session id by walking parentSessionId. A
   * missing/unknown parent stops the walk, so an orphaned child resolves to
   * itself. Guarded against cycles/deep chains.
   */
  private resolveRootSessionId(sessionId: string): string {
    let current = sessionId;
    const seen = new Set<string>();
    for (let depth = 0; depth < 16; depth += 1) {
      if (seen.has(current)) break;
      seen.add(current);
      const record = this.sessions.get(current);
      const parent = record?.parentSessionId;
      if (!parent || parent === current) break;
      current = parent;
    }
    return current;
  }

  /**
   * Oldest pending input among a root session and all of its descendants,
   * forming a stable FIFO queue head. Returns null when nothing is pending in
   * that tree.
   */
  private projectedPendingForRoot(
    rootSessionId: string,
  ): OpenCodeBridgePendingInput | null {
    let head: OpenCodeBridgePendingInput | null = null;
    for (const pending of this.pendingInputs.values()) {
      if (
        this.resolveRootSessionId(pending.request.sessionId) !== rootSessionId
      ) {
        continue;
      }
      if (!head || pending.createdAt < head.createdAt) {
        head = pending;
      }
    }
    return head;
  }

  /**
   * Clone a descendant's request so it points at the root session while
   * preserving the child provenance (origin session id/title/agent) and the
   * original OpenCode request id used for the reply.
   */
  private projectPendingRequest(
    pending: OpenCodeBridgePendingInput,
    rootSessionId: string,
  ): InputRequest {
    const request = pending.request;
    if (request.sessionId === rootSessionId) return request;
    const origin = this.sessions.get(request.sessionId);
    const baseInput =
      request.toolInput && typeof request.toolInput === "object"
        ? (request.toolInput as Record<string, unknown>)
        : {};
    return {
      ...request,
      sessionId: rootSessionId,
      toolInput: {
        ...baseInput,
        originSessionId: request.sessionId,
        parentSessionId: origin?.parentSessionId,
        ...(origin?.title ? { originSessionTitle: origin.title } : {}),
      },
    };
  }

  /**
   * Find a pending input by its OpenCode request id anywhere in a root
   * session's descendant tree. Used to route a root-targeted response back to
   * the child session that actually owns the request.
   */
  private findPendingByRequestIdForRoot(
    rootSessionId: string,
    requestId: string,
  ): OpenCodeBridgePendingInput | null {
    for (const pending of this.pendingInputs.values()) {
      if (pending.request.id !== requestId) continue;
      if (
        this.resolveRootSessionId(pending.request.sessionId) === rootSessionId
      ) {
        return pending;
      }
    }
    return null;
  }

  /**
   * Recompute a root session's blocker state after a descendant's pending
   * input changed. Keeps the root in needs-attention while any descendant is
   * waiting, and returns it to an active turn once the tree is clear.
   */
  private refreshRootPendingProjection(sessionId: string): void {
    const root = this.resolveRootSessionId(sessionId);
    if (root === sessionId) return; // direct-session path handles itself.
    if (this.pendingInputs.has(root)) return; // root's own pending wins.
    const projected = this.projectedPendingForRoot(root);
    if (projected) {
      this.updateSessionState(root, {
        activity: "waiting-input",
        pendingInputType:
          projected.request.type === "tool-approval"
            ? "tool-approval"
            : "user-question",
        active: true,
      });
      return;
    }
    // No descendant remains blocked. The parent turn is still running while its
    // subagent continues; its own idle status reconciliation settles it later.
    this.updateSessionState(root, {
      activity: "in-turn",
      pendingInputType: undefined,
      active: true,
    });
  }

  /**
   * Whether this bridge already holds `requestId` for the session (directly,
   * or projected from a descendant subagent), or is mid-flight answering it.
   * Used to skip a full runtime reconciliation on the approval hot path.
   */
  private hasKnownPendingInput(sessionId: string, requestId: string): boolean {
    if (this.pendingInputs.get(sessionId)?.request.id === requestId) {
      return true;
    }
    const origin = this.findPendingByRequestIdForRoot(sessionId, requestId);
    if (origin) return true;
    // In-flight replies are keyed by the session that owns the pending input,
    // which for a projected subagent request is the child, not the root.
    return (
      this.inputResponses.has(`${sessionId}\0${requestId}`) ||
      this.hasInFlightInputResponse(requestId)
    );
  }

  private hasInFlightInputResponse(requestId: string): boolean {
    const suffix = `\0${requestId}`;
    for (const key of this.inputResponses.keys()) {
      if (key.endsWith(suffix)) return true;
    }
    return false;
  }

  async respondToInput(
    requestedSessionId: string,
    requestId: string,
    response: OpenCodeBridgeInputResponse,
    answers?: UserQuestionAnswers,
  ): Promise<boolean> {
    // A response may target a root session for a projected subagent request.
    // Resolve it to the real child session that owns the pending input so the
    // reply reaches the correct OpenCode request.
    let sessionId = requestedSessionId;
    let pending = this.pendingInputs.get(sessionId);
    if (!pending || pending.request.id !== requestId) {
      const origin = this.findPendingByRequestIdForRoot(sessionId, requestId);
      if (origin) {
        sessionId = origin.request.sessionId;
        pending = origin;
      }
    }

    const responseKey = `${sessionId}\0${requestId}`;
    const existingResponse = this.inputResponses.get(responseKey);
    if (existingResponse) return existingResponse;

    if (!pending || pending.request.id !== requestId) return false;
    if (response !== "deny") {
      const validation = validateQuestionAnswers(pending.request, answers);
      if (!validation.valid) return false;
    }

    // Requests from external OpenCode instances (default TUI etc.) have no
    // reachable HTTP server. Queue the decision for the forwarder plugin,
    // which applies it through its in-process SDK client; the resulting
    // permission.replied/question.replied event closes the loop.
    const externalInstanceId = pending.instanceId;
    if (externalInstanceId) {
      const decisionId =
        pending.externalDecisionId ??
        `${pending.protocol}:${pending.kind}:${sessionId}:${requestId}`;
      pending.externalDecisionId = decisionId;
      const decision: ExternalOpenCodeDecision =
        pending.kind === "permission"
          ? {
              id: decisionId,
              kind: "permission",
              protocol: pending.protocol,
              requestId,
              sessionId,
              reply:
                response === "deny"
                  ? "reject"
                  : response === "approve_always"
                    ? "always"
                    : "once",
            }
          : response === "deny"
            ? {
                id: decisionId,
                kind: "question",
                protocol: pending.protocol,
                requestId,
                sessionId,
                action: "reject",
              }
            : {
                id: decisionId,
                kind: "question",
                protocol: pending.protocol,
                requestId,
                sessionId,
                action: "reply",
                answers: buildOpenCodeQuestionAnswersFromRequest(
                  pending.request,
                  answers,
                ),
              };
      const operation = (async () => {
        // Register the waiter before waking a parked long-poll. A fast plugin
        // can apply the decision and echo the reply in the same event loop.
        const confirmation =
          this.waitForExternalDecisionConfirmation(decisionId);
        this.enqueueExternalDecision(externalInstanceId, decision);
        await confirmation;
        return true;
      })();
      this.inputResponses.set(responseKey, operation);
      try {
        return await operation;
      } finally {
        if (this.inputResponses.get(responseKey) === operation) {
          this.inputResponses.delete(responseKey);
        }
      }
    }

    const operation = (async () => {
      if (pending.kind === "permission") {
        const reply =
          response === "deny"
            ? "reject"
            : response === "approve_always"
              ? "always"
              : "once";
        await this.postOpenCodeJson(
          pending.protocol === "v2"
            ? `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`
            : `/permission/${encodeURIComponent(requestId)}/reply`,
          { reply },
          this.sessions.get(sessionId)?.cwd,
        );
      } else {
        const questionPath =
          pending.protocol === "v2"
            ? `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}`
            : `/question/${encodeURIComponent(requestId)}`;
        if (response === "deny") {
          await this.postOpenCodeJson(
            `${questionPath}/reject`,
            undefined,
            this.sessions.get(sessionId)?.cwd,
          );
        } else {
          await this.postOpenCodeJson(
            `${questionPath}/reply`,
            {
              answers: buildOpenCodeQuestionAnswersFromRequest(
                pending.request,
                answers,
              ),
            },
            this.sessions.get(sessionId)?.cwd,
          );
        }
      }

      // The reply can synchronously unblock OpenCode and produce the next input
      // request before this HTTP response completes. Only consume the request
      // we actually answered; never delete a newer request for the session.
      if (this.pendingInputs.get(sessionId) === pending) {
        this.pendingInputs.delete(sessionId);
        this.dispatchOpenCodeLifecycle(sessionId, {
          type: "pending-input",
          now: Date.now(),
          pending: false,
        });
        this.updateSessionState(sessionId, { pendingInputType: undefined });
        this.refreshRootPendingProjection(sessionId);
        if (this.enabled) void this.reconcileOpenCodeLifecycle(sessionId);
      }
      return true;
    })();
    this.inputResponses.set(responseKey, operation);
    try {
      return await operation;
    } finally {
      if (this.inputResponses.get(responseKey) === operation) {
        this.inputResponses.delete(responseKey);
      }
    }
  }

  private touchExternalInstance(
    instanceId: string,
    directory?: string,
  ): ExternalOpenCodeInstance {
    let instance = this.externalInstances.get(instanceId);
    if (!instance) {
      instance = {
        id: instanceId,
        directory: directory ?? process.cwd(),
        lastSeenAt: Date.now(),
        decisions: new Map(),
        waiters: [],
      };
      this.externalInstances.set(instanceId, instance);
      return instance;
    }
    instance.lastSeenAt = Date.now();
    if (directory) instance.directory = directory;
    return instance;
  }

  private enqueueExternalDecision(
    instanceId: string,
    decision: ExternalOpenCodeDecision,
  ): void {
    const instance = this.touchExternalInstance(instanceId);
    if (instance.decisions.has(decision.id)) return;
    instance.decisions.set(decision.id, decision);
    const waiters = instance.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private acknowledgeExternalDecision(
    instanceId: string,
    decisionId: string,
  ): void {
    const instance = this.externalInstances.get(instanceId);
    if (!instance) return;
    instance.lastSeenAt = Date.now();
    instance.decisions.delete(decisionId);
  }

  private waitForExternalDecisionConfirmation(
    decisionId: string,
  ): Promise<void> {
    const existing = this.externalDecisionWaiters.get(decisionId);
    if (existing) return existing.promise;

    let resolveWaiter!: () => void;
    let rejectWaiter!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    const timer = setTimeout(() => {
      if (this.externalDecisionWaiters.get(decisionId)?.timer !== timer) return;
      this.externalDecisionWaiters.delete(decisionId);
      rejectWaiter(
        new Error(
          `OpenCode did not confirm decision ${decisionId}; it remains pending for retry`,
        ),
      );
    }, EXTERNAL_DECISION_CONFIRM_TIMEOUT_MS);
    timer.unref?.();
    this.externalDecisionWaiters.set(decisionId, {
      promise,
      resolve: resolveWaiter,
      reject: rejectWaiter,
      timer,
    });
    return promise;
  }

  private settleExternalDecision(
    decisionId: string | undefined,
    error?: Error,
  ): void {
    if (!decisionId) return;
    const waiter = this.externalDecisionWaiters.get(decisionId);
    if (!waiter) return;
    this.externalDecisionWaiters.delete(decisionId);
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  private discardExternalDecision(
    pending: OpenCodeBridgePendingInput | undefined,
    error?: Error,
  ): void {
    const decisionId = pending?.externalDecisionId;
    if (!decisionId) return;
    if (pending.instanceId) {
      this.externalInstances
        .get(pending.instanceId)
        ?.decisions.delete(decisionId);
    }
    this.settleExternalDecision(decisionId, error);
  }

  private confirmExternalDecision(pending: OpenCodeBridgePendingInput): void {
    const decisionId = pending.externalDecisionId;
    if (decisionId && pending.instanceId) {
      const decision = this.externalInstances
        .get(pending.instanceId)
        ?.decisions.get(decisionId);
      if (decision) decision.confirmed = true;
    }
    this.settleExternalDecision(decisionId);
  }

  /**
   * Long-poll endpoint body: waits up to `waitMs` for queued decisions. The
   * poll doubles as the instance liveness heartbeat.
   */
  private async collectExternalDecisions(
    instanceId: string,
    waitMs: number,
  ): Promise<ExternalOpenCodeDecision[]> {
    const instance = this.touchExternalInstance(instanceId);
    if (instance.decisions.size > 0) {
      return [...instance.decisions.values()];
    }
    const boundedWait = Math.min(
      Math.max(waitMs, 0),
      EXTERNAL_DECISION_MAX_WAIT_MS,
    );
    if (boundedWait === 0) return [];
    return await new Promise<ExternalOpenCodeDecision[]>((resolve) => {
      const timer = setTimeout(() => {
        const index = instance.waiters.indexOf(waiter);
        if (index >= 0) instance.waiters.splice(index, 1);
        resolve([]);
      }, boundedWait);
      timer.unref?.();
      const waiter = () => {
        clearTimeout(timer);
        this.touchExternalInstance(instanceId);
        resolve([...instance.decisions.values()]);
      };
      instance.waiters.push(waiter);
    });
  }

  /**
   * External instances cannot be status-polled; their long-poll heartbeat is
   * the only liveness signal. Mark sessions of silent instances idle so they
   * do not stay "running" forever after the terminal exits.
   */
  private sweepExternalInstances(): void {
    const now = Date.now();
    for (const [instanceId, instance] of this.externalInstances) {
      const age = now - instance.lastSeenAt;
      if (age < EXTERNAL_INSTANCE_STALE_MS) continue;
      for (const [sessionId, record] of this.sessions) {
        if (record.instanceId !== instanceId) continue;
        const pending = this.pendingInputs.get(sessionId);
        if (pending?.instanceId === instanceId) {
          this.pendingInputs.delete(sessionId);
          this.discardExternalDecision(
            pending,
            new Error(`External OpenCode instance ${instanceId} disconnected`),
          );
        }
        if (record.activity !== "idle" || record.active) {
          const wasMidTurn =
            record.activity === "in-turn" ||
            record.activity === "waiting-input";
          this.updateSessionState(sessionId, {
            activity: "idle",
            pendingInputType: undefined,
            active: false,
            retryStatus: undefined,
            // The terminal vanished mid-turn; the turn did not complete.
            ...(wasMidTurn ? { lastTurnStatus: "interrupted" as const } : {}),
          });
        }
      }
      if (age > EXTERNAL_INSTANCE_FORGET_MS) {
        this.externalInstances.delete(instanceId);
      }
    }
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!isLocalAddress(req.socket.remoteAddress ?? "")) {
      writeJson(res, 403, {
        error: "OpenCode bridge only accepts local connections",
      });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith(`${GATEWAY_PATH_PREFIX}/`)) {
      await this.proxyGatewayRequest(req, res, url);
      return;
    }
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));

    if (req.method === "GET" && url.pathname === "/readyz") {
      await this.syncOpenCodeRuntimeStateForRequest();
      writeJson(res, 200, this.getStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      await this.syncOpenCodeRuntimeStateForRequest();
      writeJson(res, 200, this.getStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      // SSE change signal for the main server's poll-on-push subscription.
      this.eventNotifier.attach(res);
      return;
    }

    // External instance API: used by the Yep forwarder plugin running inside
    // default `opencode` TUI / `opencode run` processes (which expose no
    // HTTP server of their own).
    if (req.method === "POST" && url.pathname === "/external/instances") {
      const body = asRecord(await readJsonBody(req));
      const instanceId = readString(body, "instanceId");
      const directory = readString(body, "directory") ?? undefined;
      if (!instanceId) {
        writeJson(res, 400, { error: "instanceId is required" });
        return;
      }
      this.touchExternalInstance(instanceId, directory);
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/external/events") {
      const body = asRecord(await readJsonBody(req));
      const instanceId = readString(body, "instanceId");
      const directory = readString(body, "directory") ?? undefined;
      const event = asRecord(body?.event);
      if (!instanceId || !event) {
        writeJson(res, 400, { error: "instanceId and event are required" });
        return;
      }
      this.touchExternalInstance(instanceId, directory);
      this.handleOpenCodeEvent(event as OpenCodeEvent, {
        instanceId,
        directory,
      });
      writeJson(res, 200, { ok: true });
      return;
    }
    if (
      req.method === "POST" &&
      parts[0] === "external" &&
      parts[1] === "instances" &&
      parts[2] &&
      parts[3] === "decisions" &&
      parts[4] &&
      parts[5] === "ack"
    ) {
      this.acknowledgeExternalDecision(parts[2], parts[4]);
      writeJson(res, 200, { ok: true });
      return;
    }
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/external/instances/") &&
      url.pathname.endsWith("/decisions")
    ) {
      const instanceId = decodeURIComponent(
        url.pathname.slice("/external/instances/".length, -"/decisions".length),
      );
      if (!instanceId) {
        writeJson(res, 400, { error: "instanceId is required" });
        return;
      }
      const waitMs = Number.parseInt(url.searchParams.get("waitMs") ?? "0", 10);
      const decisions = await this.collectExternalDecisions(
        instanceId,
        Number.isFinite(waitMs) ? waitMs : 0,
      );
      writeJson(res, 200, { decisions });
      return;
    }
    if (req.method === "GET" && url.pathname === "/sessions") {
      await this.syncOpenCodeRuntimeStateForRequest();
      writeJson(res, 200, { sessions: this.listSessions() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/session-views") {
      await this.syncOpenCodeRuntimeStateForRequest();
      writeJson(res, 200, { sessions: this.listSessionViews() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = await readJsonBody(req);
      const request = parseSessionRequest(body);
      if (!request.message) {
        writeJson(res, 400, { error: "message is required" });
        return;
      }
      const client = this.createClient(req, body);
      const projectId = encodeProjectId(request.cwd);
      const response = await client.startSession(projectId, request.message, {
        mode: request.mode,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        opencodeConfig: request.opencodeConfig,
      });
      if (response.sessionId) {
        this.recordSession(
          response.sessionId,
          projectId,
          request.cwd,
          this.getClientConfig(req, body),
          {
            processId: response.processId,
            model: request.model,
            reasoningEffort:
              response.reasoningEffort ?? request.reasoningEffort,
            mode: request.mode,
          },
        );
      }
      writeJson(res, response.queued ? 202 : 200, response);
      return;
    }

    if (parts[0] === "sessions" && parts[1]) {
      const sessionId = parts[1];
      if (req.method === "POST" && parts[2] === "terminal") {
        const body = asRecord(await readJsonBody(req));
        const kind = readString(body, "kind");
        if (kind !== "failed" && kind !== "interrupted") {
          writeJson(res, 400, {
            error: "kind must be failed or interrupted",
          });
          return;
        }
        writeJson(res, 200, {
          terminal: this.finishSessionLifecycle(
            sessionId,
            kind,
            readString(body, "error") ?? undefined,
          ),
        });
        return;
      }

      if (req.method === "GET" && parts[2] === "view") {
        await this.syncOpenCodeRuntimeStateForRequest(sessionId);
        writeJson(res, 200, {
          sessionView: this.getSessionView(sessionId),
        });
        return;
      }

      if (req.method === "GET" && parts[2] === "active") {
        await this.syncOpenCodeRuntimeStateForRequest(sessionId);
        writeJson(res, 200, {
          active: this.isSessionActive(sessionId),
        });
        return;
      }

      if (req.method === "GET" && parts.length === 2) {
        const { client, projectId, cwd } = this.resolveSessionTarget(
          sessionId,
          url,
          req,
        );
        const detail = await client.getSession(projectId, sessionId);
        this.recordSession(
          sessionId,
          projectId,
          cwd,
          this.getClientConfig(req, undefined, this.sessions.get(sessionId)),
          {},
        );
        writeJson(res, 200, detail);
        return;
      }

      if (req.method === "GET" && parts[2] === "process") {
        const client = this.resolveClient(sessionId, req);
        writeJson(res, 200, await client.getProcessInfo(sessionId));
        return;
      }

      if (req.method === "GET" && parts[2] === "pending-input") {
        await this.syncOpenCodeRuntimeStateForRequest(sessionId);
        writeJson(res, 200, {
          request: this.getPendingInputRequest(sessionId),
        });
        return;
      }

      if (req.method === "POST" && parts[2] === "resume") {
        const body = await readJsonBody(req);
        const request = parseSessionRequest(body);
        if (!request.message) {
          writeJson(res, 400, { error: "message is required" });
          return;
        }
        const client = this.createClient(req, body);
        const projectId = encodeProjectId(request.cwd);
        const response = await client.resumeSession(
          projectId,
          sessionId,
          request.message,
          {
            mode: request.mode,
            model: request.model,
            reasoningEffort: request.reasoningEffort,
            opencodeConfig: request.opencodeConfig,
            resumeSessionAt: request.resumeSessionAt,
          },
        );
        const responseSessionId = response.sessionId ?? sessionId;
        this.recordSession(
          responseSessionId,
          projectId,
          request.cwd,
          this.getClientConfig(req, body),
          {
            processId: response.processId,
            model: request.model,
            reasoningEffort:
              response.reasoningEffort ?? request.reasoningEffort,
            mode: request.mode,
          },
        );
        writeJson(res, response.queued ? 202 : 200, response);
        return;
      }

      if (req.method === "POST" && parts[2] === "messages") {
        const body = await readJsonBody(req);
        const request = parseSessionRequest(body);
        if (!request.message) {
          writeJson(res, 400, { error: "message is required" });
          return;
        }
        const client = this.createClient(req, body);
        const response = await client.queueMessage(sessionId, request.message, {
          mode: request.mode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          opencodeConfig: request.opencodeConfig,
        });
        this.touchSession(sessionId, {
          processId: response.processId,
          reasoningEffort: request.reasoningEffort,
        });
        writeJson(res, 200, response);
        return;
      }

      if (req.method === "POST" && parts[2] === "input") {
        const body = (await readJsonBody(req)) as InputRequestBody | null;
        const response = parseOpenCodeBridgeInputResponse(body?.response);
        if (!body?.requestId || !response) {
          writeJson(res, 400, {
            error: "requestId and response are required",
          });
          return;
        }
        // Reply verbs are validated instead of trusted: `respondToInput`
        // treats everything that is not "deny" as an approval, so an unknown
        // string used to silently approve.
        if (!this.hasKnownPendingInput(sessionId, body.requestId)) {
          // The request is unknown here, so the SSE stream may have missed it.
          // Only then is the unthrottled full reconciliation worth its cost;
          // an already-known request must not trigger a fan-out across every
          // managed directory on each approval click.
          await this.syncOpenCodeRuntimeState();
        }
        const accepted = await this.respondToInput(
          sessionId,
          body.requestId,
          response,
          body.answers,
        );
        if (accepted) {
          writeJson(res, 200, {
            accepted,
          });
          return;
        }
        // Loop guard: the main server proxies bridge approvals to this
        // sidecar with the x-yep-anywhere marker (YepApiClient). Its own
        // /input route falls back to bridges when no process owns the
        // session, so bouncing an unknown requestId back would ping-pong
        // between the two servers until one gave up.
        if (readHeader(req, "x-yep-anywhere")) {
          writeJson(res, 200, { accepted: false });
          return;
        }
        const client = this.createClient(req, body);
        writeJson(res, 200, {
          accepted: (
            await client.respondToInput(
              sessionId,
              body.requestId,
              response,
              body.answers,
              body.feedback,
            )
          ).accepted,
        });
        return;
      }
    }

    writeJson(res, 404, { error: "Not found" });
  }

  private createClient(req?: IncomingMessage, raw?: unknown): YepApiClient {
    const config = this.getClientConfig(req, raw);
    return new YepApiClient(config.serverUrl, config.desktopToken);
  }

  private resolveClient(sessionId: string, req: IncomingMessage): YepApiClient {
    const record = this.sessions.get(sessionId);
    const config = this.getClientConfig(req, undefined, record);
    return new YepApiClient(config.serverUrl, config.desktopToken);
  }

  private getClientConfig(
    req?: IncomingMessage,
    raw?: unknown,
    fallback?: ClientConfig,
  ): ClientConfig {
    const body = asRecord(raw);
    const headerServerUrl = readHeader(req, "x-yep-server-url");
    const headerDesktopToken = readHeader(req, "x-desktop-token");
    const serverUrl =
      typeof body?.serverUrl === "string"
        ? body.serverUrl
        : (headerServerUrl ?? fallback?.serverUrl ?? this.defaultServerUrl);
    const desktopToken =
      typeof body?.desktopToken === "string"
        ? body.desktopToken
        : (headerDesktopToken ??
          fallback?.desktopToken ??
          this.defaultDesktopToken);
    return { serverUrl, desktopToken };
  }

  private resolveSessionTarget(
    sessionId: string,
    url: URL,
    req: IncomingMessage,
  ): { client: YepApiClient; projectId: UrlProjectId; cwd: string } {
    const record = this.sessions.get(sessionId);
    const cwd = url.searchParams.get("cwd") ?? record?.cwd ?? process.cwd();
    const projectId =
      (url.searchParams.get("projectId") as UrlProjectId | null) ??
      record?.projectId ??
      encodeProjectId(cwd);
    const config = this.getClientConfig(req, undefined, record);
    return {
      client: new YepApiClient(config.serverUrl, config.desktopToken),
      projectId,
      cwd,
    };
  }

  private recordSession(
    sessionId: string,
    projectId: UrlProjectId,
    cwd: string,
    clientConfig: ClientConfig,
    metadata: {
      processId?: string;
      model?: string;
      reasoningEffort?: string;
      mode?: PermissionMode;
    },
  ): void {
    const now = new Date().toISOString();
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      id: sessionId,
      parentSessionId: existing?.parentSessionId,
      projectId,
      cwd,
      serverUrl: clientConfig.serverUrl,
      desktopToken: clientConfig.desktopToken,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      processId: metadata.processId ?? existing?.processId,
      model: metadata.model ?? existing?.model,
      reasoningEffort: metadata.reasoningEffort ?? existing?.reasoningEffort,
      mode: metadata.mode ?? existing?.mode,
      title: existing?.title,
      messageCount: existing?.messageCount,
      activity: existing?.activity,
      pendingInputType: existing?.pendingInputType,
      active: existing?.active,
    });
    this.schedulePersist();
  }

  private touchSession(
    sessionId: string,
    metadata: { processId?: string; reasoningEffort?: string },
  ): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    existing.updatedAt = new Date().toISOString();
    existing.processId = metadata.processId ?? existing.processId;
    existing.reasoningEffort =
      metadata.reasoningEffort ?? existing.reasoningEffort;
  }

  private updateSessionState(
    sessionId: string,
    state: Partial<
      Pick<
        SessionRecord,
        | "title"
        | "parentSessionId"
        | "messageCount"
        | "activity"
        | "pendingInputType"
        | "active"
        | "updatedAt"
        | "lastTurnStatus"
        | "lastErrorMessage"
        | "retryStatus"
      >
    >,
    origin?: OpenCodeEventOrigin,
  ): void {
    // OpenCode continues to report the underlying turn as busy while a tool
    // permission or question is blocking it. Keep the more specific
    // waiting-input state until a reply/error path explicitly clears the
    // pending input; otherwise the main server sees in-turn + pendingInputType
    // and focused clients do not know that they should fetch the prompt.
    const pendingInput = this.pendingInputs.get(sessionId);
    const updatesRuntimeState =
      state.activity !== undefined ||
      state.active !== undefined ||
      Object.prototype.hasOwnProperty.call(state, "pendingInputType");
    const effectiveState =
      pendingInput && updatesRuntimeState
        ? {
            ...state,
            activity: "waiting-input" as const,
            pendingInputType:
              pendingInput.request.type === "tool-approval"
                ? ("tool-approval" as const)
                : ("user-question" as const),
            active: true,
          }
        : state;
    const existing = this.sessions.get(sessionId);
    const now = new Date().toISOString();
    if (existing) {
      // A late origin can still improve attribution (e.g. the session was
      // first observed through a path that had to guess the cwd).
      let attributionChanged = false;
      if (origin?.instanceId && !existing.instanceId) {
        existing.instanceId = origin.instanceId;
        attributionChanged = true;
      }
      if (origin?.directory && existing.cwd !== origin.directory) {
        existing.cwd = origin.directory;
        existing.projectId = encodeProjectId(origin.directory);
        attributionChanged = true;
      }
      const stateChanged = Object.entries(effectiveState).some(
        ([key, value]) => {
          if (key === "retryStatus") {
            return !retryStatusEquals(
              existing.retryStatus,
              value as SessionRecord["retryStatus"],
            );
          }
          return existing[key as keyof SessionRecord] !== value;
        },
      );
      if (!stateChanged && !attributionChanged) return;

      // Runtime status polling is not session content. Preserve the timestamp
      // supplied by OpenCode and do not manufacture a fresh updatedAt merely
      // because a repeated busy/idle poll arrived.
      Object.assign(existing, effectiveState);
      this.eventNotifier.notify();
      this.schedulePersist();
      return;
    }

    // External instances report their real working directory; without one we
    // can only guess the bridge process cwd (legacy behavior).
    const cwd = origin?.directory ?? process.cwd();
    this.sessions.set(sessionId, {
      id: sessionId,
      parentSessionId: effectiveState.parentSessionId,
      projectId: encodeProjectId(cwd),
      cwd,
      serverUrl: this.defaultServerUrl,
      desktopToken: this.defaultDesktopToken,
      createdAt: now,
      updatedAt: effectiveState.updatedAt ?? now,
      title: effectiveState.title,
      messageCount: effectiveState.messageCount,
      activity: effectiveState.activity,
      pendingInputType: effectiveState.pendingInputType,
      active: effectiveState.active,
      lastTurnStatus: effectiveState.lastTurnStatus,
      lastErrorMessage: effectiveState.lastErrorMessage,
      retryStatus: effectiveState.retryStatus,
      instanceId: origin?.instanceId,
    });
    this.eventNotifier.notify();
    this.schedulePersist();
  }

  private getOpenCodeLifecycle(sessionId: string): OpenCodeBridgeLifecycle {
    const existing = this.lifecycles.get(sessionId);
    if (existing) return existing;

    const record = this.sessions.get(sessionId);
    let state = createOpenCodeLifecycleState();
    if (
      record?.active ||
      record?.activity === "in-turn" ||
      record?.activity === "waiting-input"
    ) {
      state = reduceOpenCodeLifecycle(state, {
        type: "start-turn",
        now: Date.now(),
      });
      if (record.activity === "waiting-input") {
        state = reduceOpenCodeLifecycle(state, {
          type: "pending-input",
          now: Date.now(),
          pending: true,
        });
      }
    }
    const lifecycle: OpenCodeBridgeLifecycle = {
      state,
      timer: null,
      reconcilePromise: null,
      unsettledToolParts: new Set(),
    };
    this.lifecycles.set(sessionId, lifecycle);
    return lifecycle;
  }

  private dispatchOpenCodeLifecycle(
    sessionId: string,
    action: OpenCodeLifecycleAction,
    origin?: OpenCodeEventOrigin,
  ): OpenCodeLifecycleState {
    const lifecycle = this.getOpenCodeLifecycle(sessionId);
    const previous = lifecycle.state;
    const next = reduceOpenCodeLifecycle(previous, action);
    if (next === previous) {
      if (action.type === "terminal" && previous.phase === "terminal") {
        console.debug("[OpenCodeBridge] lifecycle", {
          event: "opencode_terminal_duplicate_ignored",
          sessionId,
          turnGeneration: previous.generation,
          eventSequence: previous.sequence,
        });
      }
      return previous;
    }
    lifecycle.state = next;

    const projection = projectOpenCodeLifecycle(next);
    const becameActive =
      !projectOpenCodeLifecycle(previous).active && projection.active;
    this.updateSessionState(
      sessionId,
      {
        activity: projection.activity,
        active: projection.active,
        retryStatus: projection.retryStatus,
        ...(becameActive
          ? { lastTurnStatus: undefined, lastErrorMessage: undefined }
          : {}),
        ...(projection.terminal && projection.terminalKind
          ? {
              lastTurnStatus:
                projection.terminalKind === "completed"
                  ? ("completed" as const)
                  : projection.terminalKind,
            }
          : {}),
      },
      origin,
    );

    if (
      next.phase !== previous.phase ||
      next.waitingInput !== previous.waitingInput
    ) {
      console.debug("[OpenCodeBridge] lifecycle", {
        event: "opencode_lifecycle_transition",
        sessionId,
        turnGeneration: next.generation,
        previousPhase: previous.phase,
        nextPhase: next.phase,
        source: action.type,
        eventSequence: next.sequence,
      });
    }
    if (!previous.idleCandidate && next.idleCandidate) {
      console.debug("[OpenCodeBridge] lifecycle", {
        event: "opencode_idle_candidate_created",
        sessionId,
        turnGeneration: next.generation,
        eventSequence: next.sequence,
      });
    } else if (
      previous.idleCandidate &&
      !next.idleCandidate &&
      next.phase !== "terminal"
    ) {
      const upstreamStatus =
        action.type === "status-event" || action.type === "status-reconciled"
          ? action.status.type
          : undefined;
      console.debug("[OpenCodeBridge] lifecycle", {
        event:
          upstreamStatus === "busy" || upstreamStatus === "retry"
            ? "opencode_idle_suppressed_by_busy"
            : "opencode_idle_candidate_cancelled",
        sessionId,
        turnGeneration: next.generation,
        eventSequence: next.sequence,
        upstreamStatus,
        candidateAgeMs: action.now - previous.idleCandidate.startedAt,
      });
    }

    if (projection.active && this.enabled) {
      this.scheduleOpenCodeLifecycleReconcile(sessionId);
    } else if (lifecycle.timer) {
      clearTimeout(lifecycle.timer);
      lifecycle.timer = null;
    }
    return next;
  }

  private scheduleOpenCodeLifecycleReconcile(sessionId: string): void {
    if (!this.enabled) return;
    const lifecycle = this.getOpenCodeLifecycle(sessionId);
    if (lifecycle.timer || !projectOpenCodeLifecycle(lifecycle.state).active) {
      return;
    }
    const record = this.sessions.get(sessionId);
    // External plugin instances cannot be queried through the managed HTTP
    // server. Reconcile only an idle candidate produced by their own events;
    // never manufacture idle merely because a heartbeat-only session exists.
    if (record?.instanceId && !lifecycle.state.idleCandidate) return;

    const candidate = lifecycle.state.idleCandidate;
    const initialCandidateDelay = candidate
      ? Math.max(
          0,
          candidate.startedAt + this.lifecycleQuietWindowMs - Date.now(),
        )
      : null;
    const delay =
      candidate && candidate.idleSamples === 1
        ? initialCandidateDelay
        : this.lifecycleReconcileIntervalMs;
    lifecycle.timer = setTimeout(() => {
      lifecycle.timer = null;
      void this.reconcileOpenCodeLifecycle(sessionId);
    }, delay ?? this.lifecycleReconcileIntervalMs);
    lifecycle.timer.unref?.();
  }

  private async reconcileOpenCodeLifecycle(sessionId: string): Promise<void> {
    const lifecycle = this.getOpenCodeLifecycle(sessionId);
    if (lifecycle.reconcilePromise) return lifecycle.reconcilePromise;

    const reconcile = this.performOpenCodeLifecycleReconcile(
      sessionId,
      lifecycle,
    ).finally(() => {
      lifecycle.reconcilePromise = null;
      if (projectOpenCodeLifecycle(lifecycle.state).active) {
        this.scheduleOpenCodeLifecycleReconcile(sessionId);
      }
    });
    lifecycle.reconcilePromise = reconcile;
    return reconcile;
  }

  private async performOpenCodeLifecycleReconcile(
    sessionId: string,
    lifecycle: OpenCodeBridgeLifecycle,
  ): Promise<void> {
    const expectedSequence = lifecycle.state.sequence;
    const record = this.sessions.get(sessionId);
    if (!record) return;

    // An external instance has no queryable status endpoint. Its own idle
    // event may still be confirmed after the quiet window, but an active turn
    // must wait for plugin events instead of being projected idle here.
    if (record.instanceId && !lifecycle.state.idleCandidate) return;

    try {
      const status = record.instanceId
        ? ({ type: "idle" } as const)
        : await this.fetchOpenCodeSessionStatus(sessionId, record.cwd);
      if (lifecycle.state.sequence !== expectedSequence) return;

      if (status.type === "idle" && !record.instanceId) {
        const evidence = await this.loadOpenCodeTerminalEvidence(
          sessionId,
          record.cwd,
        );
        if (lifecycle.state.sequence !== expectedSequence) return;
        if (evidence?.assistantEvidence) {
          this.dispatchOpenCodeLifecycle(sessionId, {
            type: "assistant-evidence",
            now: Date.now(),
            evidence: evidence.assistantEvidence,
          });
        }
        if (evidence) {
          this.dispatchOpenCodeLifecycle(sessionId, {
            type: "unsettled-tools",
            now: Date.now(),
            count: evidence.unsettledTools,
          });
        }
      }

      const next = this.dispatchOpenCodeLifecycle(sessionId, {
        type: "status-reconciled",
        now: Date.now(),
        status,
        expectedSequence: lifecycle.state.sequence,
        quietWindowMs: this.lifecycleQuietWindowMs,
      });
      if (next.phase === "terminal" && next.terminalKind === "completed") {
        console.debug("[OpenCodeBridge] lifecycle", {
          event: "opencode_idle_confirmed",
          sessionId,
          turnGeneration: next.generation,
          eventSequence: next.sequence,
        });
      }
    } catch (error) {
      if (lifecycle.state.sequence !== expectedSequence) return;
      const next = this.dispatchOpenCodeLifecycle(sessionId, {
        type: "reconcile-failed",
        now: Date.now(),
        expectedSequence,
        graceMs: this.lifecycleStatusFailureGraceMs,
      });
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn("[OpenCodeBridge] lifecycle reconcile failed", {
        event: "opencode_status_reconcile_failed",
        sessionId,
        turnGeneration: next.generation,
        eventSequence: next.sequence,
        error: this.lastError,
      });
      if (next.phase === "terminal" && next.terminalKind === "interrupted") {
        this.updateSessionState(sessionId, {
          activity: "idle",
          active: false,
          lastTurnStatus: "interrupted",
          lastErrorMessage:
            "OpenCode lifecycle status remained unavailable after the active grace period",
          retryStatus: undefined,
        });
      }
    }
  }

  private async fetchOpenCodeSessionStatus(
    sessionId: string,
    directory?: string,
  ) {
    const baseUrl = await this.ensureOpenCodeServerUrl();
    const response = await fetch(
      openCodeInstanceUrl(baseUrl, "/session/status", directory),
      {
        headers: openCodeDirectoryHeaders(directory),
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) {
      throw new Error(`OpenCode status returned ${response.status}`);
    }
    return readOpenCodeSessionStatus(await response.json(), sessionId);
  }

  private async loadOpenCodeTerminalEvidence(
    sessionId: string,
    directory?: string,
  ): Promise<{
    assistantEvidence?: OpenCodeAssistantTerminalEvidence;
    unsettledTools: number;
  } | null> {
    try {
      const baseUrl = await this.ensureOpenCodeServerUrl();
      const url = new URL(
        openCodeInstanceUrl(
          baseUrl,
          `/session/${encodeURIComponent(sessionId)}/message`,
          directory,
        ),
      );
      url.searchParams.set("limit", "20");
      const response = await fetch(url, {
        headers: openCodeDirectoryHeaders(directory),
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return null;
      const payload = await response.json();
      if (!Array.isArray(payload)) return null;
      for (let index = payload.length - 1; index >= 0; index -= 1) {
        const message = payload[index];
        const assistantEvidence =
          readOpenCodeAssistantTerminalEvidence(message);
        if (!assistantEvidence) continue;
        const item = asRecord(message);
        const parts = Array.isArray(item?.parts) ? item.parts : [];
        return {
          assistantEvidence,
          unsettledTools: parts.filter(
            (part) => isOpenCodeToolPartPending(part) === true,
          ).length,
        };
      }
      return { unsettledTools: 0 };
    } catch {
      return null;
    }
  }

  /**
   * Debounced persistence of session metadata. The bridge previously kept all
   * session state in memory only, so a 4520 restart forgot every observed
   * session (and its title/model/error state) until OpenCode replayed events.
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
      // Sessions attributed to the bridge process cwd were guessed, not
      // observed; restoring them would file sessions under the wrong project.
      .filter((record) => record.cwd !== process.cwd())
      .map((record) => ({
        id: record.id,
        parentSessionId: record.parentSessionId,
        cwd: record.cwd,
        serverUrl: record.serverUrl,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        model: record.model,
        reasoningEffort: record.reasoningEffort,
        mode: record.mode,
        title: record.title,
        messageCount: record.messageCount,
        lastTurnStatus: record.lastTurnStatus,
        lastErrorMessage: record.lastErrorMessage,
      }));
    const payload = JSON.stringify({ version: 1, sessions: records });
    const writeSnapshot = async (): Promise<void> => {
      try {
        await mkdir(path.dirname(statePath), { recursive: true });
        const tmpPath = `${statePath}.tmp`;
        await writeFile(tmpPath, payload, "utf8");
        await rename(tmpPath, statePath);
      } catch (error) {
        console.warn(
          `[OpenCodeBridge] Failed to persist session state: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
    for (const stored of parsed.sessions) {
      if (!stored || typeof stored.id !== "string" || !stored.cwd) {
        continue;
      }
      if (this.sessions.has(stored.id)) continue;
      // A prior regression persisted message parentIDs (msg_*) as the session
      // parent, which incorrectly hid root sessions from listSessions(). Only
      // restore a parent that is a real session id.
      const restoredParent =
        typeof stored.parentSessionId === "string" &&
        stored.parentSessionId.startsWith("ses_")
          ? stored.parentSessionId
          : undefined;
      this.sessions.set(stored.id, {
        id: stored.id,
        parentSessionId: restoredParent,
        projectId: encodeProjectId(stored.cwd),
        cwd: stored.cwd,
        serverUrl: stored.serverUrl || this.defaultServerUrl,
        desktopToken: this.defaultDesktopToken,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        model: stored.model,
        reasoningEffort: stored.reasoningEffort,
        mode: stored.mode,
        title: stored.title,
        messageCount: stored.messageCount,
        // Restored sessions have no live runtime; they are idle until
        // OpenCode reports fresh status.
        activity: "idle",
        active: false,
        lastTurnStatus: stored.lastTurnStatus,
        lastErrorMessage: stored.lastErrorMessage,
      });
    }
  }

  private toBridgeSession(record: SessionRecord): OpenCodeBridgeSession {
    const projectName = path.basename(record.cwd) || record.cwd;
    return {
      id: record.id,
      parentSessionId: record.parentSessionId,
      projectId: record.projectId,
      projectPath: record.cwd,
      projectName,
      title: record.title ?? null,
      fullTitle: record.title ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: record.messageCount ?? 1,
      provider: "opencode",
      model: record.model,
      reasoningEffort: record.reasoningEffort,
      activity: record.activity,
      pendingInputType: record.pendingInputType,
      lastTurnStatus: record.lastTurnStatus,
      lastErrorMessage: record.lastErrorMessage,
      retryStatus: record.retryStatus,
      active:
        record.active ??
        (record.activity === "in-turn" || record.activity === "waiting-input"),
    };
  }

  private toSessionView(
    session: OpenCodeBridgeSession,
  ): OpenCodeBridgeSessionView {
    const view: OpenCodeBridgeSessionView = {
      session: {
        id: session.id,
        parentSessionId: session.parentSessionId,
        projectId: session.projectId,
        title: session.title,
        fullTitle: session.fullTitle,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messageCount,
        ownership: opencodeBridgeOwnership(
          isLiveOpenCodeBridgeSession(session),
        ),
        pendingInputType: session.pendingInputType,
        activity: session.activity,
        provider: "opencode",
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        lastTurnStatus: session.lastTurnStatus,
        lastErrorMessage: session.lastErrorMessage,
        retryStatus: session.retryStatus,
        source: "opencode-bridge",
      } satisfies SessionSummary,
      projectName: session.projectName,
      activity: session.activity,
      pendingInputType: session.pendingInputType,
      // Published so the main server can answer liveness for a whole list from
      // this snapshot instead of probing /active per session.
      active: isLiveOpenCodeBridgeSession(session),
    };
    return {
      ...view,
      session: {
        ...view.session,
        ownership: opencodeBridgeOwnership(
          isLiveOpenCodeBridgeSessionView(view),
        ),
      },
    };
  }

  private startOpenCodeEventStream(): void {
    if (!this.enabled || this.eventAbortController) return;
    this.eventAbortController = new AbortController();
    void this.consumeOpenCodeEvents(this.eventAbortController.signal);
  }

  private stopOpenCodeEventStream(): void {
    if (this.eventReconnectTimer) {
      clearTimeout(this.eventReconnectTimer);
      this.eventReconnectTimer = null;
    }
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    this.opencodeConnected = false;
  }

  private scheduleOpenCodeEventReconnect(): void {
    if (!this.enabled || this.eventAbortController?.signal.aborted) return;
    if (this.eventReconnectTimer) return;
    this.eventReconnectTimer = setTimeout(() => {
      this.eventReconnectTimer = null;
      const controller = this.eventAbortController;
      if (!controller || controller.signal.aborted) return;
      void this.consumeOpenCodeEvents(controller.signal);
    }, 1_000);
  }

  private async consumeOpenCodeEvents(signal: AbortSignal): Promise<void> {
    try {
      const opencodeServerUrl = await this.ensureOpenCodeServerUrl();
      if (signal.aborted) return;
      const response = await fetch(`${opencodeServerUrl}/global/event`, {
        headers: { accept: "text/event-stream" },
        signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`OpenCode event stream returned ${response.status}`);
      }

      this.opencodeConnected = true;
      this.lastError = null;
      await this.syncOpenCodeRuntimeState(opencodeServerUrl);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          this.handleSseLine(line);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.opencodeConnected = false;
      if (!signal.aborted) this.scheduleOpenCodeEventReconnect();
    }
  }

  private handleSseLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") return;
    try {
      const envelope = unwrapOpenCodeEvent(JSON.parse(data));
      if (envelope) {
        this.handleOpenCodeEvent(envelope.event, envelope.origin);
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private handleOpenCodeEvent(
    event: OpenCodeEvent,
    origin?: OpenCodeEventOrigin,
  ): void {
    const type = typeof event.type === "string" ? event.type : "";
    const properties = asRecord(event.properties);
    const info = asRecord(properties?.info);
    const part = asRecord(properties?.part);
    const sessionId =
      readString(properties, "sessionID") ??
      readString(properties, "sessionId") ??
      readString(info, "sessionID") ??
      readString(part, "sessionID") ??
      (type.startsWith("session.") ? readString(info, "id") : null);

    // session.error may arrive without a sessionID for server-level failures.
    if (type === "session.error") {
      const message = readOpenCodeErrorMessage(properties?.error);
      if (sessionId && this.sessions.has(sessionId)) {
        // User-initiated aborts terminate the turn without a failure; align
        // with codex-bridge's interrupted/failed distinction. The client
        // renders any lastErrorMessage as "Failed", so aborts must not
        // carry one.
        const aborted = isOpenCodeAbortError(properties?.error);
        // A cleanup abort may arrive after Yep already finalized the turn.
        // Never overwrite that terminal projection with a late interruption.
        if (aborted && !this.isSessionActive(sessionId)) return;
        const pending = this.pendingInputs.get(sessionId);
        this.pendingInputs.delete(sessionId);
        this.dispatchOpenCodeLifecycle(
          sessionId,
          {
            type: "terminal",
            now: Date.now(),
            kind: aborted ? "interrupted" : "failed",
          },
          origin,
        );
        this.updateSessionState(
          sessionId,
          {
            activity: "idle",
            pendingInputType: undefined,
            active: false,
            lastTurnStatus: aborted ? "interrupted" : "failed",
            lastErrorMessage: aborted
              ? undefined
              : (message ?? "OpenCode reported an error"),
            retryStatus: undefined,
          },
          origin,
        );
        this.discardExternalDecision(
          pending,
          new Error(message ?? "OpenCode reported an error"),
        );
        this.refreshRootPendingProjection(sessionId);
      } else if (message) {
        this.lastError = message;
      }
      return;
    }

    if (!sessionId) return;

    if (type === "session.deleted") {
      const pending = this.pendingInputs.get(sessionId);
      const lifecycle = this.lifecycles.get(sessionId);
      if (lifecycle?.timer) clearTimeout(lifecycle.timer);
      this.lifecycles.delete(sessionId);
      this.sessions.delete(sessionId);
      this.pendingInputs.delete(sessionId);
      this.discardExternalDecision(
        pending,
        new Error(`OpenCode session ${sessionId} was deleted`),
      );
      this.refreshRootPendingProjection(sessionId);
      this.eventNotifier.notify();
      this.schedulePersist();
      return;
    }

    // Deprecated upstream in favor of session.status(type=idle); kept for
    // compatibility with older OpenCode servers.
    if (type === "session.idle") {
      this.dispatchOpenCodeLifecycle(
        sessionId,
        {
          type: "status-event",
          now: Date.now(),
          status: { type: "idle" },
        },
        origin,
      );
      return;
    }

    if (type === "session.status") {
      const status = parseOpenCodeUpstreamStatus(properties?.status);
      if (!status) return;
      this.dispatchOpenCodeLifecycle(
        sessionId,
        {
          type: "status-event",
          now: Date.now(),
          status,
        },
        origin,
      );
      return;
    }

    if (type === "message.updated") {
      this.recordOpenCodeSessionEvent(
        sessionId,
        properties,
        { implyActive: false },
        origin,
      );
      const evidence = readOpenCodeAssistantTerminalEvidence({ info });
      const lifecycle = this.getOpenCodeLifecycle(sessionId);
      if (
        evidence &&
        (evidence === "nonterminal" ||
          projectOpenCodeLifecycle(lifecycle.state).active)
      ) {
        this.dispatchOpenCodeLifecycle(
          sessionId,
          { type: "assistant-evidence", now: Date.now(), evidence },
          origin,
        );
      }
      return;
    }

    if (type === "session.created" || type === "session.updated") {
      this.recordOpenCodeSessionEvent(
        sessionId,
        properties,
        { implyActive: false, sessionEvent: true },
        origin,
      );
      return;
    }

    if (type === "message.part.updated" || type === "message.part.delta") {
      this.recordOpenCodeSessionEvent(
        sessionId,
        properties,
        { implyActive: false },
        origin,
      );
      this.dispatchOpenCodeLifecycle(
        sessionId,
        { type: "activity", now: Date.now() },
        origin,
      );
      if (type === "message.part.updated" && part) {
        const pending = isOpenCodeToolPartPending(part);
        if (pending !== null) {
          const lifecycle = this.getOpenCodeLifecycle(sessionId);
          const partId = readString(part, "id");
          if (partId) {
            if (pending) lifecycle.unsettledToolParts.add(partId);
            else lifecycle.unsettledToolParts.delete(partId);
          }
          this.dispatchOpenCodeLifecycle(
            sessionId,
            {
              type: "unsettled-tools",
              now: Date.now(),
              count: lifecycle.unsettledToolParts.size,
            },
            origin,
          );
        }
      }
      return;
    }

    if (type === "permission.asked" || type === "permission.v2.asked") {
      this.recordOpenCodePermissionRequest(
        sessionId,
        properties,
        type === "permission.v2.asked" ? "v2" : "v1",
        origin,
      );
      this.dispatchOpenCodeLifecycle(
        sessionId,
        { type: "pending-input", now: Date.now(), pending: true },
        origin,
      );
      return;
    }

    if (type === "permission.replied" || type === "permission.v2.replied") {
      this.clearOpenCodePendingInput(sessionId, properties, origin);
      return;
    }

    if (type === "question.asked" || type === "question.v2.asked") {
      this.recordOpenCodeQuestionRequest(
        sessionId,
        properties,
        type === "question.v2.asked" ? "v2" : "v1",
        origin,
      );
      this.dispatchOpenCodeLifecycle(
        sessionId,
        { type: "pending-input", now: Date.now(), pending: true },
        origin,
      );
      return;
    }

    if (
      type === "question.replied" ||
      type === "question.rejected" ||
      type === "question.v2.replied" ||
      type === "question.v2.rejected"
    ) {
      this.clearOpenCodePendingInput(sessionId, properties, origin);
    }
  }

  private recordOpenCodeSessionEvent(
    sessionId: string,
    properties: Record<string, unknown> | null,
    options: { implyActive?: boolean; sessionEvent?: boolean } = {},
    origin?: OpenCodeEventOrigin,
  ): void {
    const implyActive = options.implyActive ?? true;
    const info = asRecord(properties?.info);
    const title = normalizeProviderGeneratedTitle(readString(info, "title"));
    // Only authoritative session lifecycle events (session.created /
    // session.updated) carry a real session parent. message.updated.info
    // .parentID is a *message* id (msg_*), never a session parent, so it must
    // never be written to SessionRecord.parentSessionId. On a session event we
    // also clear any previously mis-recorded msg_* parent by projecting the
    // authoritative (possibly undefined) value.
    const rawParent = options.sessionEvent
      ? readString(info, "parentID")
      : undefined;
    const parentSessionId = rawParent?.startsWith("ses_")
      ? rawParent
      : undefined;
    const updatedAt =
      readOpenCodeUpdatedAt(info) ??
      readString(info, "updatedAt") ??
      readString(properties, "updatedAt");
    const messageCount = readNumber(info, "messageCount");
    this.updateSessionState(
      sessionId,
      {
        // Message events do not include a session title. Avoid replacing the
        // title recorded from session.created with undefined in that case.
        ...(title ? { title } : {}),
        ...(options.sessionEvent ? { parentSessionId } : {}),
        ...(messageCount !== undefined ? { messageCount } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(implyActive
          ? {
              activity: "in-turn" as const,
              active: true,
              retryStatus: undefined,
              lastTurnStatus: undefined,
            }
          : {}),
      },
      origin,
    );
  }

  private recordOpenCodePermissionRequest(
    sessionId: string,
    properties: Record<string, unknown> | null,
    protocol: OpenCodeApprovalProtocol = "v1",
    origin?: OpenCodeEventOrigin,
  ): void {
    const requestId =
      readString(properties, "id") ?? readString(properties, "requestID");
    if (!requestId) return;
    const permission =
      readString(properties, protocol === "v2" ? "action" : "permission") ??
      "permission";
    const patterns = readStringArray(
      properties?.[protocol === "v2" ? "resources" : "patterns"],
    );
    const persistentPatterns = readStringArray(
      properties?.[protocol === "v2" ? "save" : "always"],
    );
    const supportsPersistentApproval = persistentPatterns.length > 0;
    const prompt = `Allow ${permission}${patterns.length ? ` ${patterns.join(", ")}` : ""}?`;
    const timestamp = new Date().toISOString();
    const previous = this.pendingInputs.get(sessionId);
    const sameRequest =
      previous?.requestId === requestId &&
      previous.kind === "permission" &&
      previous.protocol === protocol &&
      previous.instanceId === origin?.instanceId;
    if (previous && !sameRequest) {
      this.discardExternalDecision(
        previous,
        new Error(`OpenCode replaced pending request ${previous.requestId}`),
      );
    }
    this.pendingInputs.set(sessionId, {
      requestId,
      kind: "permission",
      protocol,
      raw: properties,
      createdAt: sameRequest ? previous.createdAt : timestamp,
      instanceId:
        origin?.instanceId ?? (sameRequest ? previous.instanceId : undefined),
      externalDecisionId: sameRequest ? previous.externalDecisionId : undefined,
      request: {
        id: requestId,
        sessionId,
        type: "tool-approval",
        prompt,
        options: supportsPersistentApproval
          ? ["Approve", "Approve always", "Deny"]
          : ["Approve", "Deny"],
        toolName: "OpenCode",
        toolInput: {
          approvalKind: "opencode_permission",
          approvalProtocol: protocol,
          availableDecisions: supportsPersistentApproval
            ? ["once", "always", "reject"]
            : ["once", "reject"],
          permission,
          patterns,
          persistentPatterns,
          metadata: properties?.metadata,
          raw: properties,
        },
        timestamp,
        source: "opencode-bridge",
      },
    });
    this.updateSessionState(
      sessionId,
      {
        activity: "waiting-input",
        pendingInputType: "tool-approval",
        active: true,
      },
      origin,
    );
    this.refreshRootPendingProjection(sessionId);
  }

  private recordOpenCodeQuestionRequest(
    sessionId: string,
    properties: Record<string, unknown> | null,
    protocol: OpenCodeApprovalProtocol = "v1",
    origin?: OpenCodeEventOrigin,
  ): void {
    const requestId =
      readString(properties, "id") ?? readString(properties, "requestID");
    const questions = normalizeOpenCodeQuestions(properties?.questions);
    if (!requestId || questions.length === 0) return;
    const timestamp = new Date().toISOString();
    const previous = this.pendingInputs.get(sessionId);
    const sameRequest =
      previous?.requestId === requestId &&
      previous.kind === "question" &&
      previous.protocol === protocol &&
      previous.instanceId === origin?.instanceId;
    if (previous && !sameRequest) {
      this.discardExternalDecision(
        previous,
        new Error(`OpenCode replaced pending request ${previous.requestId}`),
      );
    }
    this.pendingInputs.set(sessionId, {
      requestId,
      kind: "question",
      protocol,
      raw: properties,
      createdAt: sameRequest ? previous.createdAt : timestamp,
      instanceId:
        origin?.instanceId ?? (sameRequest ? previous.instanceId : undefined),
      externalDecisionId: sameRequest ? previous.externalDecisionId : undefined,
      request: {
        id: requestId,
        sessionId,
        type: "question",
        prompt: questions[0]?.question ?? "Question",
        toolName: "AskUserQuestion",
        toolInput: {
          questions,
          opencodeQuestions: properties?.questions,
          raw: properties,
        },
        timestamp,
        source: "opencode-bridge",
      },
    });
    this.updateSessionState(
      sessionId,
      {
        activity: "waiting-input",
        pendingInputType: "user-question",
        active: true,
      },
      origin,
    );
    this.refreshRootPendingProjection(sessionId);
  }

  private clearOpenCodePendingInput(
    sessionId: string,
    properties: Record<string, unknown> | null,
    origin?: OpenCodeEventOrigin,
  ): void {
    const requestId =
      readString(properties, "requestID") ??
      readString(properties, "permissionID") ??
      readString(properties, "id");
    if (!requestId) return;
    const pending = this.pendingInputs.get(sessionId);
    if (pending) {
      if (pending.requestId !== requestId) return;
      this.pendingInputs.delete(sessionId);
      // A terminal OpenCode event proves the decision was applied (including
      // the race where the user answered in the TUI first). Keep it queued as
      // confirmed until the plugin ACKs, but tell the plugin not to reapply it.
      this.confirmExternalDecision(pending);
    }
    this.dispatchOpenCodeLifecycle(
      sessionId,
      {
        type: "pending-input",
        now: Date.now(),
        pending: false,
      },
      origin,
    );
    this.updateSessionState(sessionId, { pendingInputType: undefined }, origin);
    this.refreshRootPendingProjection(sessionId);
    if (this.enabled) void this.reconcileOpenCodeLifecycle(sessionId);
  }

  private async postOpenCodeJson(
    pathname: string,
    body?: unknown,
    directory?: string,
  ): Promise<void> {
    const opencodeServerUrl = await this.ensureOpenCodeServerUrl();
    const response = await fetch(
      openCodeInstanceUrl(opencodeServerUrl, pathname, directory),
      {
        method: "POST",
        headers: {
          ...openCodeDirectoryHeaders(directory),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const body = await readResponseBody(response);
      const message = formatApiError(response.status, body);
      throw new Error(message);
    }
  }

  /**
   * Full reconciliation across every managed directory. Used when state may
   * have drifted arbitrarily (event stream (re)connect, approval replies) and
   * therefore deliberately unthrottled.
   */
  private async syncOpenCodeRuntimeState(baseUrl?: string): Promise<void> {
    this.sweepExternalInstances();
    const directories = this.managedOpenCodeDirectories();
    await this.runOpenCodeRuntimeSync(directories, baseUrl);
  }

  /**
   * Reconciliation for inbound bridge HTTP reads (`/status`, `/session-views`,
   * `/sessions/:id/view`, ...).
   *
   * The main server reads those endpoints on every push notification, so this
   * path is the hot one and must stay cheap:
   * - single-flight per directory: concurrent reads join the in-flight
   *   fan-out instead of each starting their own;
   * - a finished reconciliation is reused for `runtimeSyncMinIntervalMs`;
   * - only directories with unsettled sessions are reconciled every window,
   *   settled ones fall back to the slow safety-net sweep;
   * - per-session reads (`sessionId` given) only reconcile that session's own
   *   directory, never all managed ones.
   *
   * This is a safety net, not the primary state source: the upstream SSE
   * stream (`/global/event`) keeps the in-memory view current, so serving
   * state that is up to `runtimeSyncMinIntervalMs` behind the reconciler is
   * not observable in the UI.
   */
  private async syncOpenCodeRuntimeStateForRequest(
    sessionId?: string,
  ): Promise<void> {
    this.sweepExternalInstances();
    const now = Date.now();
    const candidates =
      sessionId === undefined
        ? this.openCodeDirectoriesForSweep()
        : this.openCodeDirectoriesForSession(sessionId);
    const due = candidates.filter((directory) =>
      this.isDirectorySyncDue(directory, now),
    );
    if (due.length === 0) return;

    const joined: Promise<void>[] = [];
    const fresh: string[] = [];
    for (const directory of due) {
      const inFlight = this.directorySyncInFlight.get(directory);
      if (inFlight) {
        joined.push(inFlight);
        continue;
      }
      fresh.push(directory);
    }

    if (fresh.length > 0) {
      // runOpenCodeRuntimeSync never rejects (it records lastError instead), so
      // a failed cycle cannot leave a rejected promise pinned in the map. The
      // finally block clears it either way, and directorySyncedAt is advanced
      // so the next window retries rather than hammering a broken upstream.
      const run = this.runOpenCodeRuntimeSync(fresh);
      for (const directory of fresh) {
        this.directorySyncInFlight.set(directory, run);
      }
      joined.push(
        run.finally(() => {
          for (const directory of fresh) {
            if (this.directorySyncInFlight.get(directory) === run) {
              this.directorySyncInFlight.delete(directory);
            }
          }
        }),
      );
    }

    await Promise.all(joined);
  }

  private async runOpenCodeRuntimeSync(
    directories: string[],
    baseUrl?: string,
  ): Promise<void> {
    try {
      const opencodeServerUrl =
        baseUrl ?? (await this.ensureOpenCodeServerUrl());
      await Promise.all([
        this.syncOpenCodeSessionStatus(opencodeServerUrl, directories),
        this.syncOpenCodePendingQuestions(opencodeServerUrl, directories),
        this.syncOpenCodePendingPermissions(opencodeServerUrl, directories),
      ]);
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      // Stamped on completion (not on entry) so a slow cycle cannot make the
      // freshness window look newer than the data it actually produced.
      const syncedAt = Date.now();
      for (const directory of directories) {
        this.directorySyncedAt.set(directory, syncedAt);
      }
    }
  }

  private async syncOpenCodeSessionStatus(
    baseUrl?: string,
    directories?: string[],
  ): Promise<void> {
    const opencodeServerUrl = baseUrl ?? (await this.ensureOpenCodeServerUrl());
    await Promise.all(
      (directories ?? this.managedOpenCodeDirectories()).map((directory) =>
        this.syncOpenCodeDirectoryStatus(opencodeServerUrl, directory),
      ),
    );
  }

  private managedOpenCodeDirectories(): string[] {
    const directories = new Set<string>([process.cwd()]);
    for (const record of this.sessions.values()) {
      if (!record.instanceId) directories.add(record.cwd);
    }
    return Array.from(directories);
  }

  /**
   * Sweep scope for list-shaped reads: every managed directory. Also forgets
   * bookkeeping for directories that no longer have sessions.
   */
  private openCodeDirectoriesForSweep(): string[] {
    const managed = this.managedOpenCodeDirectories();
    const known = new Set(managed);
    for (const directory of this.directorySyncedAt.keys()) {
      if (!known.has(directory)) this.directorySyncedAt.delete(directory);
    }
    return managed;
  }

  /**
   * Sweep scope for a per-session read: only the directory that session lives
   * in. Sessions driven by an external OpenCode instance have no directory we
   * can reconcile over HTTP - their state arrives through the forwarder plugin
   * - so those reads are served purely from memory.
   */
  private openCodeDirectoriesForSession(sessionId: string): string[] {
    const record = this.sessions.get(sessionId);
    if (!record || record.instanceId) return [];
    return [record.cwd];
  }

  /**
   * Whether a directory may be reconciled again: never inside the freshness
   * window, then every window while it holds an unsettled session, otherwise
   * only when the slow safety-net sweep is due.
   */
  private isDirectorySyncDue(directory: string, now: number): boolean {
    const age = now - (this.directorySyncedAt.get(directory) ?? 0);
    if (age < this.runtimeSyncMinIntervalMs) return false;
    if (this.hasUnsettledOpenCodeSession(directory, now)) return true;
    return age >= this.idleDirectorySyncIntervalMs;
  }

  /**
   * True when a directory still holds a session whose lifecycle could be
   * corrected by reconciliation: a live/retrying/idle-candidate turn, a
   * pending approval, or a turn that ended so recently that trailing status
   * reads still matter. Settled sessions can only change through an upstream
   * event, which arrives on the SSE stream.
   */
  private hasUnsettledOpenCodeSession(directory: string, now: number): boolean {
    for (const [sessionId, record] of this.sessions) {
      if (record.instanceId || record.cwd !== directory) continue;
      if (this.pendingInputs.has(sessionId)) return true;
      const lifecycle = this.lifecycles.get(sessionId);
      if (!lifecycle) {
        // No lifecycle observed yet: trust the persisted record.
        if (
          record.active ||
          record.activity === "in-turn" ||
          record.activity === "waiting-input"
        ) {
          return true;
        }
        continue;
      }
      const { state } = lifecycle;
      if (state.phase !== "idle" && state.phase !== "terminal") return true;
      if (state.waitingInput) return true;
      if (now - state.lastActivityAt < DIRECTORY_ACTIVE_WINDOW_MS) return true;
    }
    return false;
  }

  private async syncOpenCodeDirectoryStatus(
    opencodeServerUrl: string,
    directory: string,
  ): Promise<void> {
    const expectedSequences = new Map<string, number>();
    for (const [sessionId, record] of this.sessions) {
      if (record.instanceId || record.cwd !== directory) continue;
      expectedSequences.set(
        sessionId,
        this.getOpenCodeLifecycle(sessionId).state.sequence,
      );
    }
    const response = await fetch(
      openCodeInstanceUrl(opencodeServerUrl, "/session/status", directory),
      {
        headers: openCodeDirectoryHeaders(directory),
      },
    );
    if (!response.ok) {
      const body = await readResponseBody(response);
      throw new Error(formatApiError(response.status, body));
    }

    const body = await response.json();
    const activeStatus = asRecord(body) ?? {};
    const activeSessionIds = new Set(Object.keys(activeStatus));
    for (const sessionId of activeSessionIds) {
      const status = parseOpenCodeUpstreamStatus(activeStatus[sessionId]);
      if (!status) continue;
      this.dispatchOpenCodeLifecycle(
        sessionId,
        {
          type: "status-reconciled",
          now: Date.now(),
          status,
          expectedSequence: expectedSequences.get(sessionId),
        },
        { directory },
      );
    }

    for (const [sessionId, record] of this.sessions) {
      if (activeSessionIds.has(sessionId)) continue;
      // External-instance sessions are invisible to the managed server's
      // status endpoint; their liveness comes from the plugin heartbeat.
      if (record.instanceId || record.cwd !== directory) continue;
      this.dispatchOpenCodeLifecycle(
        sessionId,
        {
          type: "status-reconciled",
          now: Date.now(),
          status: { type: "idle" },
          expectedSequence: expectedSequences.get(sessionId),
          quietWindowMs: this.lifecycleQuietWindowMs,
        },
        { directory },
      );
    }
  }

  private async syncOpenCodePendingQuestions(
    baseUrl?: string,
    directories?: string[],
  ): Promise<void> {
    const opencodeServerUrl = baseUrl ?? (await this.ensureOpenCodeServerUrl());
    await Promise.all(
      (directories ?? this.managedOpenCodeDirectories()).map((directory) =>
        this.syncOpenCodeDirectoryPendingQuestions(
          opencodeServerUrl,
          directory,
        ),
      ),
    );
  }

  private async syncOpenCodeDirectoryPendingQuestions(
    opencodeServerUrl: string,
    directory: string,
  ): Promise<void> {
    const response = await fetch(
      openCodeInstanceUrl(opencodeServerUrl, "/question", directory),
      {
        headers: openCodeDirectoryHeaders(directory),
      },
    );
    if (!response.ok) {
      const body = await readResponseBody(response);
      throw new Error(formatApiError(response.status, body));
    }

    const body = await response.json();
    const bodyRecord = asRecord(body);
    const requests: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray(bodyRecord?.data)
        ? bodyRecord.data
        : [];
    const seen = new Set<string>();
    for (const item of requests) {
      const record = asRecord(item);
      const sessionId =
        readString(record, "sessionID") ?? readString(record, "sessionId");
      const requestId =
        readString(record, "id") ?? readString(record, "requestID");
      if (!sessionId || !requestId) continue;
      this.recordOpenCodeQuestionRequest(
        sessionId,
        {
          ...record,
          id: requestId,
        },
        "v1",
        { directory },
      );
      seen.add(`${sessionId}:${requestId}`);
    }

    for (const [sessionId, pending] of this.pendingInputs) {
      // The snapshot only covers the managed OpenCode server. Questions from
      // external instances (forwarder plugin) are invisible to it and must
      // not be swept here; their lifecycle is closed by plugin events or the
      // external-instance staleness sweep.
      if (pending.instanceId) continue;
      if (this.sessions.get(sessionId)?.cwd !== directory) continue;
      if (
        pending.kind === "question" &&
        !seen.has(`${sessionId}:${pending.requestId}`)
      ) {
        this.clearOpenCodePendingInput(
          sessionId,
          { requestID: pending.requestId },
          { directory },
        );
      }
    }
  }

  /**
   * Reconcile permission pendings against the managed server's live list
   * (`GET /permission`, upstream `permission.list`). Without this, a
   * permission answered in the TUI while the bridge's SSE stream was down
   * stayed pending forever and the session stuck in waiting-input. Mirrors
   * syncOpenCodePendingQuestions, including the external-instance exclusion.
   */
  private async syncOpenCodePendingPermissions(
    baseUrl?: string,
    directories?: string[],
  ): Promise<void> {
    const opencodeServerUrl = baseUrl ?? (await this.ensureOpenCodeServerUrl());
    await Promise.all(
      (directories ?? this.managedOpenCodeDirectories()).map((directory) =>
        this.syncOpenCodeDirectoryPendingPermissions(
          opencodeServerUrl,
          directory,
        ),
      ),
    );
  }

  private async syncOpenCodeDirectoryPendingPermissions(
    opencodeServerUrl: string,
    directory: string,
  ): Promise<void> {
    const response = await fetch(
      openCodeInstanceUrl(opencodeServerUrl, "/permission", directory),
      {
        headers: openCodeDirectoryHeaders(directory),
      },
    );
    if (!response.ok) {
      // Older OpenCode servers predate the experimental /permission list
      // route; treat its absence as "nothing to reconcile" rather than an
      // error that would mask the other sync results.
      if (response.status === 404) return;
      const body = await readResponseBody(response);
      throw new Error(formatApiError(response.status, body));
    }

    const body = await response.json();
    const bodyRecord = asRecord(body);
    const requests: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray(bodyRecord?.data)
        ? bodyRecord.data
        : [];
    const seen = new Set<string>();
    for (const item of requests) {
      const record = asRecord(item);
      const sessionId =
        readString(record, "sessionID") ?? readString(record, "sessionId");
      const requestId =
        readString(record, "id") ?? readString(record, "requestID");
      if (!sessionId || !requestId) continue;
      this.recordOpenCodePermissionRequest(
        sessionId,
        {
          ...record,
          id: requestId,
        },
        "v1",
        { directory },
      );
      seen.add(`${sessionId}:${requestId}`);
    }

    for (const [sessionId, pending] of this.pendingInputs) {
      if (pending.instanceId) continue;
      if (this.sessions.get(sessionId)?.cwd !== directory) continue;
      if (
        pending.kind === "permission" &&
        !seen.has(`${sessionId}:${pending.requestId}`)
      ) {
        this.clearOpenCodePendingInput(
          sessionId,
          { requestID: pending.requestId },
          { directory },
        );
      }
    }
  }

  private async ensureOpenCodeServerUrl(): Promise<string> {
    if (this.opencodeServerUrlOverride) return this.opencodeServerUrlOverride;
    if (this.opencodeServerUrl && this.isManagedOpenCodeServerRunning()) {
      return this.opencodeServerUrl;
    }
    if (this.opencodeStartPromise) {
      return this.opencodeStartPromise;
    }

    this.opencodeStartPromise = this.startManagedOpenCodeServer().finally(
      () => {
        this.opencodeStartPromise = null;
      },
    );
    return this.opencodeStartPromise;
  }

  private async startManagedOpenCodeServer(): Promise<string> {
    const port = await findAvailablePort(this.opencodeStartPort);
    const url = `http://127.0.0.1:${port}`;
    const spawnArgs = [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--print-logs",
    ];
    console.log(
      `[OpenCodeBridge] Starting managed OpenCode server path=${this.opencodePath} args=${JSON.stringify(spawnArgs)}`,
    );
    const child = spawn(this.opencodePath, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: {
        // Attached CLI sessions consume the user's normal opencode.json, so
        // keep its environment references available in this shared server.
        ...buildUserConfiguredOpenCodeEnv(process.env, this.gatewayConfig, {
          gatewayProxyBaseURL:
            this.gatewayConfig && this.listening
              ? `http://${this.host}:${this.port}${GATEWAY_PATH_PREFIX}`
              : undefined,
        }),
        // Runtime config patches for Yep-created managed models reference this
        // stable env name. The shared server must expose it just like the old
        // per-session server did.
        ...(this.gatewayConfig
          ? { YEP_OPENCODE_LLM_API_KEY: this.gatewayConfig.apiKey }
          : {}),
        // The Yep forwarder plugin (installed globally in
        // ~/.config/opencode/plugin) must stay inert inside Yep-managed
        // servers: their events already reach the bridge via /global/event.
        // Pair the bootstrap marker with the exact serve port so a nested
        // opencode process cannot inherit the managed-server identity.
        YEP_MANAGED_OPENCODE: "1",
        YEP_MANAGED_OPENCODE_SERVER_PORT: String(port),
      },
    });
    this.opencodeProcess = child;
    this.opencodeServerUrl = url;
    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        reject(
          new Error(
            `Failed to start OpenCode server with ${this.opencodePath}: ${error.message}`,
          ),
        );
      });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.debug(`[OpenCodeBridge upstream] ${text}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.debug(`[OpenCodeBridge upstream] ${text}`);
    });
    child.once("exit", (code, signal) => {
      if (this.opencodeProcess === child) {
        this.opencodeProcess = null;
        this.opencodeServerUrl = null;
      }
      console.log(
        `[OpenCodeBridge] Managed OpenCode server exited code=${String(code)} signal=${String(signal)}`,
      );
    });

    try {
      await Promise.race([
        waitForOpenCodeHealth(url, this.startupTimeoutMs),
        spawnErrorPromise,
      ]);
    } catch (error) {
      if (this.opencodeProcess === child) {
        this.opencodeProcess = null;
        this.opencodeServerUrl = null;
      }
      if (child.pid && child.exitCode === null && !child.killed) {
        try {
          console.warn(
            `[OpenCodeBridge] Stopping managed OpenCode server reason=startup-failed pid=${child.pid}`,
          );
          process.kill(process.platform !== "win32" ? -child.pid : child.pid);
        } catch {}
      }
      throw error;
    }

    this.lastError = null;
    console.log(`[OpenCodeBridge] Managed OpenCode server ready at ${url}`);
    return url;
  }

  private async proxyGatewayRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const gateway = this.gatewayConfig;
    if (!gateway) {
      writeJson(res, 503, {
        error: "OpenCode model gateway is not configured",
      });
      return;
    }

    const suffix = url.pathname.slice(GATEWAY_PATH_PREFIX.length);
    const upstreamUrl = `${gateway.apiBase}${suffix}${url.search}`;
    const requestBody = await readRequestBody(req);
    const forwardedBody = sanitizeAnthropicGatewayToolSchemas(
      requestBody,
      suffix,
    );
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        value === undefined ||
        name === "host" ||
        name === "connection" ||
        name === "content-length" ||
        name === "accept-encoding"
      ) {
        continue;
      }
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    if (gateway.subModule) {
      headers.set("X-Sub-Module", gateway.subModule);
    }
    if (process.env.YEP_OPENCODE_GATEWAY_DEBUG === "true") {
      console.log(
        "[OpenCodeBridge gateway]",
        JSON.stringify({
          ...summarizeGatewayBody(forwardedBody.body),
          method: req.method,
          path: suffix,
          hasAuthorization: headers.has("authorization"),
          sanitizedToolSchemas: forwardedBody.sanitizedToolSchemas,
          subModule: headers.get("x-sub-module"),
        }),
      );
    }

    try {
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body:
          forwardedBody.body.length > 0
            ? forwardedBody.body.toString("utf-8")
            : undefined,
      });

      const contentType =
        upstream.headers.get("content-type") ?? "application/json";

      // GLM's Chat Completions stream is valid SSE, but its very small chunks
      // trigger an OpenCode AI SDK decoding bug around tool calls. Buffer only
      // those responses so the exact SSE payload is presented as one coherent
      // body; every other model is streamed through untouched so first-byte
      // latency and memory stay proportional to the payload instead of the
      // whole completion.
      const model = readModelFromBody(forwardedBody.body);
      if (gatewayResponseNeedsBuffering(model)) {
        const responseBody = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { "content-type": contentType });
        res.end(responseBody);
        return;
      }

      const streamHeaders: Record<string, string> = {
        "content-type": contentType,
      };
      // Preserve SSE-friendly hints so intermediaries do not buffer the stream.
      const cacheControl = upstream.headers.get("cache-control");
      if (cacheControl) streamHeaders["cache-control"] = cacheControl;
      res.writeHead(upstream.status, streamHeaders);

      if (!upstream.body) {
        res.end();
        return;
      }

      try {
        await pipeline(
          Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>),
          res,
        );
      } catch (streamError) {
        // Client disconnects and upstream aborts surface here. The headers are
        // already sent, so just tear down the response instead of writing a
        // 502 body into a partially streamed reply.
        if (!res.writableEnded) {
          res.destroy(
            streamError instanceof Error
              ? streamError
              : new Error(String(streamError)),
          );
        }
      }
    } catch (error) {
      writeJson(res, 502, {
        error: `OpenCode model gateway request failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async stopManagedOpenCodeServer(reason: string): Promise<void> {
    this.opencodeStartPromise = null;
    if (this.opencodeServerUrlOverride) return;

    const child = this.opencodeProcess;
    this.opencodeProcess = null;
    this.opencodeServerUrl = null;
    if (!child?.pid || child.exitCode !== null || child.killed) {
      return;
    }

    console.log(
      `[OpenCodeBridge] Stopping managed OpenCode server reason=${reason} pid=${child.pid}`,
    );
    await terminateProcessGroup(child);
  }

  private isManagedOpenCodeServerRunning(): boolean {
    if (this.opencodeServerUrlOverride) return false;
    return isChildRunning(this.opencodeProcess);
  }

  private getOpenCodeServerStatusUrl(): string {
    return (
      this.opencodeServerUrlOverride ??
      this.opencodeServerUrl ??
      `http://127.0.0.1:${this.opencodeStartPort}`
    );
  }
}

function readModelFromBody(body: Buffer): string | undefined {
  if (body.length === 0) return undefined;
  try {
    const parsed = JSON.parse(body.toString("utf-8")) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function summarizeGatewayBody(body: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body.toString("utf-8")) as Record<
      string,
      unknown
    >;
    return {
      model: parsed.model,
      stream: parsed.stream,
      maxTokens: parsed.max_tokens,
      messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
      toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      toolChoice: parsed.tool_choice,
      requestKeys: Object.keys(parsed).sort(),
    };
  } catch {
    return { invalidJsonBody: true };
  }
}

interface SanitizedGatewayBody {
  body: Buffer;
  sanitizedToolSchemas: number;
}

/**
 * Bedrock rejects custom-tool input schemas whose root contains `anyOf`,
 * `oneOf`, or `allOf`. OpenCode still owns the original schema and validates
 * tool arguments locally, so the transport copy can safely lower only those
 * root combiners while preserving nested property schemas.
 */
function sanitizeAnthropicGatewayToolSchemas(
  body: Buffer,
  suffix: string,
): SanitizedGatewayBody {
  if (body.length === 0 || !suffix.endsWith("/messages")) {
    return { body, sanitizedToolSchemas: 0 };
  }

  try {
    const parsed = asRecord(JSON.parse(body.toString("utf-8")));
    if (!parsed || !Array.isArray(parsed.tools)) {
      return { body, sanitizedToolSchemas: 0 };
    }

    let sanitizedToolSchemas = 0;
    const tools = parsed.tools.map((value) => {
      const tool = asRecord(value);
      const inputSchema = asRecord(tool?.input_schema);
      if (!tool || !inputSchema) return value;

      const lowered = lowerTopLevelToolSchemaComposition(inputSchema);
      if (lowered === inputSchema) return value;
      sanitizedToolSchemas += 1;
      return { ...tool, input_schema: lowered };
    });

    if (sanitizedToolSchemas === 0) {
      return { body, sanitizedToolSchemas: 0 };
    }
    return {
      body: Buffer.from(JSON.stringify({ ...parsed, tools })),
      sanitizedToolSchemas,
    };
  } catch {
    return { body, sanitizedToolSchemas: 0 };
  }
}

function lowerTopLevelToolSchemaComposition(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const compositionKeys = ["anyOf", "oneOf", "allOf"] as const;
  if (!compositionKeys.some((key) => Array.isArray(schema[key]))) {
    return schema;
  }

  const properties = { ...(asRecord(schema.properties) ?? {}) };
  for (const key of compositionKeys) {
    const members = schema[key];
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      const memberProperties = asRecord(asRecord(member)?.properties);
      if (!memberProperties) continue;
      for (const [name, property] of Object.entries(memberProperties)) {
        if (!(name in properties)) properties[name] = property;
      }
    }
  }

  const lowered: Record<string, unknown> = {
    ...schema,
    type: "object",
    properties,
  };
  for (const key of compositionKeys) delete lowered[key];
  return lowered;
}

class YepApiClient {
  constructor(
    private readonly serverUrl: string,
    private readonly desktopToken: string | undefined,
  ) {}

  startSession(
    projectId: string,
    message: string,
    options: {
      mode?: PermissionMode;
      model?: string;
      reasoningEffort?: string;
      opencodeConfig?: OpenCodeSessionConfig;
    },
  ): Promise<StartSessionResponse> {
    return this.request(`/api/projects/${projectId}/sessions`, {
      method: "POST",
      body: {
        message,
        mode: options.mode,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        opencodeConfig: options.opencodeConfig,
        provider: "opencode",
      },
    });
  }

  async resumeSession(
    projectId: string,
    sessionId: string,
    message: string,
    options: {
      mode?: PermissionMode;
      model?: string;
      reasoningEffort?: string;
      opencodeConfig?: OpenCodeSessionConfig;
      resumeSessionAt?: string;
    },
  ): Promise<StartSessionResponse> {
    const response = await this.request<StartSessionResponse>(
      `/api/projects/${projectId}/sessions/${sessionId}/resume`,
      {
        method: "POST",
        body: {
          message,
          mode: options.mode,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          opencodeConfig: options.opencodeConfig,
          resumeSessionAt: options.resumeSessionAt,
          provider: "opencode",
        },
      },
    );
    return { sessionId, ...response };
  }

  getSession(
    projectId: string,
    sessionId: string,
  ): Promise<{ pendingInputRequest?: unknown }> {
    return this.request(`/api/projects/${projectId}/sessions/${sessionId}`);
  }

  getProcessInfo(sessionId: string): Promise<ProcessInfoResponse> {
    return this.request(`/api/sessions/${sessionId}/process`);
  }

  queueMessage(
    sessionId: string,
    message: string,
    options: {
      mode?: PermissionMode;
      model?: string;
      reasoningEffort?: string;
      opencodeConfig?: OpenCodeSessionConfig;
    },
  ): Promise<QueueMessageResponse> {
    return this.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: {
        message,
        mode: options.mode,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        opencodeConfig: options.opencodeConfig,
        provider: "opencode",
      },
    });
  }

  respondToInput(
    sessionId: string,
    requestId: string,
    response: InputResponse,
    answers?: UserQuestionAnswers,
    feedback?: string,
  ): Promise<{ accepted: boolean }> {
    return this.request(`/api/sessions/${sessionId}/input`, {
      method: "POST",
      body: { requestId, response, answers, feedback },
    });
  }

  private async request<T>(
    pathname: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const response = await fetch(`${normalizeUrl(this.serverUrl)}${pathname}`, {
      method: init?.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-yep-anywhere": "true",
        ...(this.desktopToken ? { "x-desktop-token": this.desktopToken } : {}),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (!response.ok) {
      const body = await readResponseBody(response);
      const error = new Error(
        formatApiError(response.status, body),
      ) as ApiError;
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return (await response.json()) as T;
  }
}

function parseSessionRequest(raw: unknown): {
  cwd: string;
  message?: string;
  mode?: PermissionMode;
  model?: string;
  reasoningEffort?: string;
  opencodeConfig?: OpenCodeSessionConfig;
  resumeSessionAt?: string;
} {
  const body = asRecord(raw);
  const cwd =
    typeof body?.cwd === "string" ? path.resolve(body.cwd) : process.cwd();
  const message = typeof body?.message === "string" ? body.message : undefined;
  const mode =
    typeof body?.mode === "string" && isPermissionMode(body.mode)
      ? body.mode
      : undefined;
  const model = typeof body?.model === "string" ? body.model : undefined;
  const reasoningEffort =
    typeof body?.reasoningEffort === "string"
      ? body.reasoningEffort
      : undefined;
  const opencodeConfig = asRecord(body?.opencodeConfig)
    ? (body?.opencodeConfig as OpenCodeSessionConfig)
    : undefined;
  const resumeSessionAt =
    typeof body?.resumeSessionAt === "string"
      ? body.resumeSessionAt
      : undefined;
  return {
    cwd,
    message,
    mode,
    model,
    reasoningEffort,
    opencodeConfig,
    resumeSessionAt,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(req);
  if (body.length === 0) return null;
  const text = body.toString("utf-8");
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function waitForOpenCodeHealth(
  baseUrl: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/global/health`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for OpenCode server at ${baseUrl}: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
  );
}

function formatApiError(status: number, body: unknown): string {
  const record = asRecord(body);
  const message = record?.error;
  return typeof message === "string"
    ? `Yep API error ${status}: ${message}`
    : `Yep API error ${status}`;
}

function isPermissionMode(value: string): value is PermissionMode {
  return (
    value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "plan" ||
    value === "auto"
  );
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function openCodeInstanceUrl(
  baseUrl: string,
  pathname: string,
  directory?: string,
): string {
  const url = new URL(pathname, baseUrl);
  if (directory) url.searchParams.set("directory", directory);
  return url.toString();
}

function openCodeDirectoryHeaders(directory?: string): Record<string, string> {
  return directory ? { "x-opencode-directory": directory } : {};
}

function readHeader(
  req: IncomingMessage | undefined,
  name: string,
): string | null {
  const value = req?.headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

/**
 * Accept only the known reply verbs. `respondToInput` treats anything other
 * than "deny" as an approval, so an unvalidated body could approve a
 * permission through a typo.
 */
function parseOpenCodeBridgeInputResponse(
  value: unknown,
): OpenCodeBridgeInputResponse | null {
  return value === "approve" ||
    value === "approve_accept_edits" ||
    value === "approve_for_session" ||
    value === "approve_strict_auto_review" ||
    value === "approve_always" ||
    value === "deny"
    ? value
    : null;
}

function unwrapOpenCodeEvent(
  value: unknown,
): { event: OpenCodeEvent; origin?: OpenCodeEventOrigin } | null {
  const record = asRecord(value);
  if (!record) return null;
  const payload = asRecord(record.payload);
  const event = payload ?? record;
  if (typeof event.type !== "string") return null;
  const directory = readString(record, "directory") ?? undefined;
  return {
    event: event as OpenCodeEvent,
    origin: directory ? { directory } : undefined,
  };
}

function readString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * OpenCode session events carry their authoritative timestamp in
 * properties.info.time.updated (milliseconds since epoch). Older bridge
 * versions looked for info.updatedAt instead and replaced it with the local
 * clock, causing every runtime status poll to look like new session content.
 */
function readOpenCodeUpdatedAt(
  info: Record<string, unknown> | null,
): string | null {
  const time = asRecord(info?.time);
  const updated = readNumber(time, "updated");
  if (updated === undefined) return null;
  return new Date(updated).toISOString();
}

function readNumber(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Extract a human-readable message from an OpenCode session.error payload.
 * Upstream shape is the assistant error union: `{ name, data: { message } }`.
 */
function readOpenCodeErrorMessage(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return typeof value === "string" ? value : undefined;
  }
  const data = asRecord(record.data);
  return (
    readString(data, "message") ??
    readString(record, "message") ??
    readString(record, "name") ??
    undefined
  );
}

/**
 * OpenCode reports user-initiated aborts through the same session.error
 * channel as real failures, tagged `MessageAbortedError` (see
 * references/opencode/packages/core/src/v1/session.ts).
 */
function isOpenCodeAbortError(value: unknown): boolean {
  return readString(asRecord(value), "name") === "MessageAbortedError";
}

function buildOpenCodeQuestionAnswersFromRequest(
  request: InputRequest,
  answers: UserQuestionAnswers | undefined,
): string[][] {
  const input = asRecord(request.toolInput);
  return buildOpenCodeQuestionAnswers(
    normalizeOpenCodeQuestions(input?.questions),
    answers,
  );
}
