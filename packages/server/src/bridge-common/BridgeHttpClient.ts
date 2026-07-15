import type {
  AgentActivity,
  InputRequest,
  PendingInputType,
  UrlProjectId,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import type { SessionSummary } from "../supervisor/types.js";
import type { EventBus } from "../watcher/index.js";
import { bridgeOwnership, isLiveBridgeSessionView } from "./session-state.js";
import type {
  BridgeController,
  BridgeInputResponse,
  BridgeSessionBase,
  BridgeSessionView,
  BridgeStatusBase,
} from "./types.js";

export interface BridgeHttpClientOptions {
  baseUrl: string;
  eventBus?: EventBus;
  pollIntervalMs?: number;
}

/** State remembered between polls to diff lifecycle changes per session. */
export interface BridgePollState {
  projectId: UrlProjectId;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  active: boolean;
}

/** One session observed during a poll cycle. */
export interface BridgePollEntry<TState extends BridgePollState> {
  id: string;
  view: BridgeSessionView;
  state: TState;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Base class for the main-server side of a bridge sidecar: forwards control
 * calls over HTTP and polls `/session-views`, replaying lifecycle changes
 * (session-created / session-status-changed / process-state-changed) onto the
 * local EventBus so bridge sessions appear alongside owned sessions.
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
  private readonly pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  protected knownSessions = new Map<string, TState>();

  constructor(options: BridgeHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.eventBus = options.eventBus;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Fallback status when the sidecar is unreachable. */
  protected abstract unavailableStatus(): TStatus;

  /** Collect the poll snapshot (implementations differ per provider). */
  protected abstract collectPollEntries(): Promise<BridgePollEntry<TState>[]>;

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
      void this.pollSessions();
    }, this.pollIntervalMs);
    void this.pollSessions();
  }

  shutdown(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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

  async isSessionActive(sessionId: string): Promise<boolean> {
    const [data, view] = await Promise.all([
      this.fetchJson<{ active?: boolean }>(
        `/sessions/${encodeURIComponent(sessionId)}/active`,
      ),
      this.getSessionView(sessionId),
    ]);
    return Boolean(data?.active && view);
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
  ): Promise<boolean> {
    const data = await this.fetchJson<{ accepted?: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/input`,
      {
        method: "POST",
        body: JSON.stringify({ requestId, response, answers }),
      },
    );
    return data?.accepted ?? false;
  }

  protected async fetchJson<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T | null> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...init?.headers,
        },
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  private async pollSessions(): Promise<void> {
    if (!this.eventBus || this.polling) return;
    this.polling = true;
    try {
      const entries = await this.collectPollEntries();
      const nextIds = new Set<string>();

      for (const entry of entries) {
        nextIds.add(entry.id);
        this.emitChanges(entry);
      }

      for (const [sessionId, previous] of this.knownSessions) {
        if (!nextIds.has(sessionId) && previous.active) {
          this.eventBus.emit({
            type: "session-status-changed",
            sessionId,
            projectId: previous.projectId,
            ownership: { owner: "none" },
            timestamp: new Date().toISOString(),
          });
          this.knownSessions.delete(sessionId);
        }
      }
    } finally {
      this.polling = false;
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

    if (
      !previous ||
      previous.activity !== state.activity ||
      previous.pendingInputType !== state.pendingInputType
    ) {
      this.eventBus.emit({
        type: "process-state-changed",
        sessionId: entry.id,
        projectId: state.projectId,
        activity: state.activity ?? "idle",
        pendingInputType: state.pendingInputType,
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
}
