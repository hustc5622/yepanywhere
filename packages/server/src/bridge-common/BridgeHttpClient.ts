import type {
  AgentActivity,
  InputRequest,
  PendingInputType,
  SessionLastTurnStatus,
  SessionRetryStatus,
  UrlProjectId,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { ensureRuntimeToken } from "../runtime/token.js";
import type { SessionSummary } from "../supervisor/types.js";
import type { EventBus } from "../watcher/index.js";
import {
  bridgeOwnership,
  isActiveBridgeSessionView,
  isLiveBridgeSessionView,
} from "./session-state.js";
import type {
  BridgeController,
  BridgeInputResolutionContext,
  BridgeInputResponse,
  BridgeSessionBase,
  BridgeSessionView,
  BridgeStatusBase,
} from "./types.js";

export interface BridgeHttpClientOptions {
  baseUrl: string;
  eventBus?: EventBus;
  pollIntervalMs?: number;
  /** Optional bearer credential for a non-loopback sidecar control plane. */
  authToken?: string;
  /** Existing runtime token file used when no explicit bearer is configured. */
  authTokenFile?: string;
}

/** State remembered between polls to diff lifecycle changes per session. */
export interface BridgePollState {
  projectId: UrlProjectId;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  pendingInputRequestId?: string;
  active: boolean;
  /** Terminal status of the most recent turn (bridge-reported). */
  lastTurnStatus?: SessionLastTurnStatus;
  /** Most recent provider error message, if the last turn failed. */
  lastErrorMessage?: string;
  /** Present while the provider is retrying a failed request. */
  retryStatus?: SessionRetryStatus;
}

/** One session observed during a poll cycle. */
export interface BridgePollEntry<TState extends BridgePollState> {
  id: string;
  view: BridgeSessionView;
  state: TState;
}

export interface BridgeChangeSignal {
  revision?: number;
  baseRevision?: number;
  changedSessionIds: string[];
}

export type BridgePollReason =
  | "startup"
  | "interval"
  | "change-signal"
  | "queued";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const EVENT_STREAM_RETRY_MS = 5_000;
/**
 * Floor between poll cycles. Sidecars debounce their push signal to ~20/s, and
 * each poll costs the sidecar a `/session-views` request plus its upstream
 * reconciliation, so an unthrottled poll-on-push turned a busy turn into
 * hundreds of short-lived TCP connections per second (ephemeral port
 * exhaustion). Pushes arriving inside the window are coalesced into a single
 * trailing poll, so no change signal is dropped.
 */
const MIN_POLL_GAP_MS = 200;

function retryStatusEquals(
  a: SessionRetryStatus | undefined,
  b: SessionRetryStatus | undefined,
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
 * Base class for the main-server side of a bridge sidecar: forwards control
 * calls over HTTP and polls `/session-views`, replaying lifecycle changes
 * (session-created / session-status-changed / process-state-changed) onto the
 * local EventBus so bridge sessions appear alongside owned sessions.
 *
 * Besides interval polling, it subscribes to the sidecar's `/events` SSE
 * change signal and polls immediately on each notification, so bridge state
 * changes (e.g. waiting-input) reach the UI without a full poll interval of
 * latency. Interval polling remains as the fallback when SSE is unavailable.
 *
 * Subclasses supply the status fallback shape, how a poll snapshot is
 * collected, and may emit provider-specific extra events per diff.
 */
export abstract class BridgeHttpClient<
  TStatus extends BridgeStatusBase,
  TSession extends BridgeSessionBase,
  TState extends BridgePollState = BridgePollState,
> implements BridgeController<TStatus, TSession>
{
  protected readonly baseUrl: string;
  protected readonly eventBus?: EventBus;
  private authToken?: string;
  private readonly authTokenFile?: string;
  private authTokenPromise?: Promise<string>;
  private readonly pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private pollQueued = false;
  private pollGapTimer: NodeJS.Timeout | null = null;
  private lastPollStartedAt = 0;
  private eventStreamAbort: AbortController | null = null;
  private pendingChangeSignal: BridgeChangeSignal | null = null;
  protected knownSessions = new Map<string, TState>();
  /**
   * Reports whether a session is currently owned by the local Supervisor.
   * When it returns true, ownership is governed solely by the Supervisor and
   * this client must not emit external/none for that session (see
   * setOwnershipResolver / emitChanges).
   */
  private ownershipResolver?: (sessionId: string) => boolean;

  constructor(options: BridgeHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.eventBus = options.eventBus;
    this.authToken = options.authToken?.trim() || undefined;
    this.authTokenFile = options.authTokenFile;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  setOwnershipResolver(resolver: (sessionId: string) => boolean): void {
    this.ownershipResolver = resolver;
  }

  /**
   * True when the local Supervisor owns the session, i.e. ownership is `self`
   * and this bridge client must stay silent about ownership for it.
   */
  private isOwnedBySupervisor(sessionId: string): boolean {
    return this.ownershipResolver?.(sessionId) ?? false;
  }

  /** Fallback status when the sidecar is unreachable. */
  protected abstract unavailableStatus(): TStatus;

  /** Collect the poll snapshot (implementations differ per provider). */
  protected abstract collectPollEntries(
    reason: BridgePollReason,
    changeSignal?: BridgeChangeSignal,
  ): Promise<BridgePollEntry<TState>[]>;

  /**
   * Hook for provider-specific events beyond the shared lifecycle diff
   * (e.g. codex emits session-updated from bridge metadata).
   */
  protected emitExtraChanges(
    _previous: TState | undefined,
    _entry: BridgePollEntry<TState>,
    _timestamp: string,
  ): void {}

  start(): void {
    if (!this.eventBus || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollSessions("interval");
    }, this.pollIntervalMs);
    void this.pollSessions("startup");
    this.startEventStream();
  }

  shutdown(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pollGapTimer) {
      clearTimeout(this.pollGapTimer);
      this.pollGapTimer = null;
    }
    this.eventStreamAbort?.abort();
    this.eventStreamAbort = null;
  }

  /**
   * Subscribe to the sidecar's `/events` SSE change stream and poll
   * immediately on each signal. Reconnects with a fixed backoff; absence of
   * the endpoint (older sidecar) degrades to interval polling.
   */
  private startEventStream(): void {
    if (this.eventStreamAbort) return;
    const abort = new AbortController();
    this.eventStreamAbort = abort;

    const run = async (): Promise<void> => {
      while (!abort.signal.aborted) {
        try {
          const authorization = await this.authorizationHeader();
          const response = await fetch(`${this.baseUrl}/events`, {
            headers: {
              accept: "text/event-stream",
              ...(authorization ? { authorization } : {}),
            },
            signal: abort.signal,
          });
          if (response.ok && response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (!abort.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder
                .decode(value, { stream: true })
                .replaceAll("\r\n", "\n");
              let frameEnd = buffer.indexOf("\n\n");
              while (frameEnd >= 0) {
                const frame = buffer.slice(0, frameEnd);
                buffer = buffer.slice(frameEnd + 2);
                const parsed = parseBridgeSseFrame(frame);
                if (parsed) this.queueChangeSignal(parsed);
                frameEnd = buffer.indexOf("\n\n");
              }
            }
          }
        } catch {
          // Connection failure - fall through to retry.
        }
        if (abort.signal.aborted) return;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, EVENT_STREAM_RETRY_MS);
          timer.unref?.();
        });
      }
    };
    void run();
  }

  async getStatus(): Promise<TStatus> {
    return (
      (await this.fetchJson<TStatus>("/status")) ?? this.unavailableStatus()
    );
  }

  async listSessions(): Promise<TSession[]> {
    const data = await this.fetchJson<{ sessions?: TSession[] }>("/sessions");
    return data?.sessions ?? [];
  }

  async listSessionViews(): Promise<BridgeSessionView[]> {
    const data = await this.fetchJson<{ sessions?: BridgeSessionView[] }>(
      "/session-views",
    );
    return (data?.sessions ?? [])
      .filter((view) =>
        this.isDisplayableBridgeSession(view.session, {
          activity: view.activity,
          pendingInputType: view.pendingInputType,
        }),
      )
      .map((view) => this.normalizeSessionView(view));
  }

  async getSessionView(sessionId: string): Promise<BridgeSessionView | null> {
    const data = await this.fetchJson<{
      sessionView?: BridgeSessionView | null;
    }>(`/sessions/${encodeURIComponent(sessionId)}/view`);
    const view = data?.sessionView ?? null;
    if (
      view &&
      !this.isDisplayableBridgeSession(view.session, {
        activity: view.activity,
        pendingInputType: view.pendingInputType,
      })
    ) {
      return null;
    }
    return view ? this.normalizeSessionView(view) : null;
  }

  /**
   * Liveness for a single session, at the cost of exactly one sidecar request.
   *
   * This used to fan out to `/sessions/:id/active` *and* `/sessions/:id/view`
   * in parallel, which doubled every liveness probe and - because each sidecar
   * read triggers a runtime reconciliation - doubled the upstream fan-out
   * behind it too.
   *
   * The view alone is sufficient: it ships the sidecar's own `active` verdict,
   * so this keeps the previous `active && displayable` semantics exactly (a
   * missing or undisplayable view reports inactive).
   */
  async isSessionActive(sessionId: string): Promise<boolean> {
    const view = await this.getSessionView(sessionId);
    return view !== null && isActiveBridgeSessionView(view);
  }

  async getPendingInputRequest(
    sessionId: string,
  ): Promise<InputRequest | null> {
    const data = await this.fetchJson<{ request?: InputRequest | null }>(
      `/sessions/${encodeURIComponent(sessionId)}/pending-input`,
    );
    return data?.request ?? null;
  }

  async respondToInput(
    sessionId: string,
    requestId: string,
    response: BridgeInputResponse,
    answers?: UserQuestionAnswers,
    context?: BridgeInputResolutionContext,
  ): Promise<boolean> {
    const data = await this.fetchJson<{ accepted?: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/input`,
      {
        method: "POST",
        body: JSON.stringify({ requestId, response, answers, ...context }),
      },
    );
    return data?.accepted ?? false;
  }

  protected async fetchJson<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T | null> {
    const response = await this.fetchJsonResponse<T>(path, init);
    return response?.data ?? null;
  }

  protected async fetchJsonResponse<T>(
    path: string,
    init?: RequestInit,
  ): Promise<{
    status: number;
    data: T | null;
    etag?: string;
    responseBytes: number;
  } | null> {
    try {
      const authorization = await this.authorizationHeader();
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          // Marks main-server traffic so sidecars can avoid proxying failed
          // calls back to the main server (which would loop through the
          // bridge fallback in /api/sessions/:id/input).
          "x-yep-anywhere": "true",
          ...(authorization ? { authorization } : {}),
          ...init?.headers,
        },
      });
      if (response.status === 304) {
        return {
          status: 304,
          data: null,
          responseBytes: 0,
          ...(response.headers.get("etag")
            ? { etag: response.headers.get("etag") ?? undefined }
            : {}),
        };
      }
      if (!response.ok) return null;
      const body = await response.text();
      return {
        status: response.status,
        data: JSON.parse(body) as T,
        responseBytes: Buffer.byteLength(body, "utf8"),
        ...(response.headers.get("etag")
          ? { etag: response.headers.get("etag") ?? undefined }
          : {}),
      };
    } catch {
      return null;
    }
  }

  private async authorizationHeader(): Promise<string | undefined> {
    if (!this.authToken && this.authTokenFile) {
      this.authTokenPromise ??= ensureRuntimeToken(this.authTokenFile);
      this.authToken = await this.authTokenPromise;
    }
    return this.authToken ? `Bearer ${this.authToken}` : undefined;
  }

  /**
   * Poll now, or schedule a single trailing poll when the previous cycle
   * started less than `MIN_POLL_GAP_MS` ago. Bursty push signals therefore
   * collapse into one poll per window instead of one poll per signal.
   */
  private requestPoll(reason: BridgePollReason): void {
    if (this.pollGapTimer) return;
    const elapsed = Date.now() - this.lastPollStartedAt;
    if (elapsed >= MIN_POLL_GAP_MS) {
      void this.pollSessions(reason);
      return;
    }
    this.pollGapTimer = setTimeout(() => {
      this.pollGapTimer = null;
      void this.pollSessions(reason);
    }, MIN_POLL_GAP_MS - elapsed);
    this.pollGapTimer.unref?.();
  }

  private queueChangeSignal(signal: BridgeChangeSignal): void {
    const pending = this.pendingChangeSignal;
    if (!pending) {
      this.pendingChangeSignal = signal;
    } else {
      const contiguous =
        pending.revision !== undefined &&
        signal.baseRevision !== undefined &&
        pending.revision === signal.baseRevision;
      this.pendingChangeSignal = {
        revision: signal.revision,
        ...(contiguous && pending.baseRevision !== undefined
          ? { baseRevision: pending.baseRevision }
          : {}),
        changedSessionIds: Array.from(
          new Set([...pending.changedSessionIds, ...signal.changedSessionIds]),
        ),
      };
    }
    this.requestPoll("change-signal");
  }

  private async pollSessions(reason: BridgePollReason): Promise<void> {
    if (!this.eventBus) return;
    if (this.polling) {
      // Coalesce push-triggered polls that race an in-flight poll so the
      // final state is always re-read after the current cycle completes.
      this.pollQueued = true;
      return;
    }
    this.polling = true;
    this.lastPollStartedAt = Date.now();
    try {
      const isRecoveryPoll = reason === "startup" || reason === "interval";
      const changeSignal = isRecoveryPoll
        ? undefined
        : (this.pendingChangeSignal ?? undefined);
      this.pendingChangeSignal = null;
      const entries = await this.collectPollEntries(reason, changeSignal);
      const nextIds = new Set<string>();

      for (const entry of entries) {
        nextIds.add(entry.id);
        this.emitChanges(entry);
      }

      // Only a startup/interval request is a complete snapshot. Targeted SSE
      // refreshes intentionally omit the other known rows.
      if (!changeSignal) {
        for (const sessionId of Array.from(this.knownSessions.keys())) {
          if (!nextIds.has(sessionId)) this.removeKnownSession(sessionId);
        }
      }
    } finally {
      this.polling = false;
      if (this.pollQueued) {
        this.pollQueued = false;
        this.requestPoll("queued");
      }
    }
  }

  private emitChanges(entry: BridgePollEntry<TState>): void {
    if (!this.eventBus) return;

    const { state } = entry;
    const previous = this.knownSessions.get(entry.id);
    this.knownSessions.set(entry.id, state);

    const timestamp = new Date().toISOString();
    if (!previous) {
      this.eventBus.emit({
        type: "session-created",
        session: entry.view.session,
        timestamp,
      });
    }

    if (!previous || previous.active !== state.active) {
      // Ownership of Supervisor-owned sessions is governed solely by the
      // Supervisor (owner: "self"). Emitting external/none here would race the
      // Supervisor's ownership events and flip the client into a transient
      // "external session" banner while an owned bridge turn drives the
      // shared upstream server. Only report ownership for sessions we do not
      // own; this mirrors the REST arbitration in deriveSessionRuntime.
      if (!this.isOwnedBySupervisor(entry.id)) {
        this.eventBus.emit({
          type: "session-status-changed",
          sessionId: entry.id,
          projectId: state.projectId,
          ownership: state.active
            ? ({ owner: "external" } as SessionSummary["ownership"])
            : ({ owner: "none" } as SessionSummary["ownership"]),
          timestamp,
        });
      }
    }

    if (
      !previous ||
      previous.activity !== state.activity ||
      previous.pendingInputType !== state.pendingInputType ||
      previous.pendingInputRequestId !== state.pendingInputRequestId ||
      previous.lastTurnStatus !== state.lastTurnStatus ||
      previous.lastErrorMessage !== state.lastErrorMessage ||
      !retryStatusEquals(previous.retryStatus, state.retryStatus)
    ) {
      this.eventBus.emit({
        type: "process-state-changed",
        sessionId: entry.id,
        projectId: state.projectId,
        activity: state.activity ?? "idle",
        pendingInputType: state.pendingInputType,
        lastTurnStatus: state.lastTurnStatus,
        lastErrorMessage: state.lastErrorMessage,
        retryStatus: state.retryStatus,
        timestamp,
      });
    }

    this.emitExtraChanges(previous, entry, timestamp);
  }

  protected isDisplayableBridgeSession(
    session: SessionSummary,
    state?: { activity?: AgentActivity; pendingInputType?: PendingInputType },
  ): boolean {
    return (
      session.messageCount > 0 ||
      state?.activity === "in-turn" ||
      state?.activity === "waiting-input" ||
      !!state?.pendingInputType ||
      !!session.pendingInputType
    );
  }

  protected normalizeSessionView(view: BridgeSessionView): BridgeSessionView {
    return {
      ...view,
      session: {
        ...view.session,
        ownership: bridgeOwnership(isLiveBridgeSessionView(view)),
      },
    };
  }

  /** Remove one targeted row without treating omitted known rows as deleted. */
  protected removeKnownSession(sessionId: string): void {
    const previous = this.knownSessions.get(sessionId);
    if (!previous) return;
    if (
      previous.active &&
      !this.isOwnedBySupervisor(sessionId) &&
      this.eventBus
    ) {
      this.eventBus.emit({
        type: "session-status-changed",
        sessionId,
        projectId: previous.projectId,
        ownership: { owner: "none" },
        timestamp: new Date().toISOString(),
      });
    }
    this.knownSessions.delete(sessionId);
  }
}

function parseBridgeSseFrame(frame: string): BridgeChangeSignal | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (event !== "changed" || data.length === 0) return null;
  try {
    const value = JSON.parse(data.join("\n")) as Record<string, unknown>;
    const changedSessionIds = Array.isArray(value.changedSessionIds)
      ? value.changedSessionIds.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      : [];
    return {
      changedSessionIds,
      ...(typeof value.revision === "number"
        ? { revision: value.revision }
        : {}),
      ...(typeof value.baseRevision === "number"
        ? { baseRevision: value.baseRevision }
        : {}),
    };
  } catch {
    return null;
  }
}
