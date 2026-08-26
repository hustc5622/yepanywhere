import type { ContextUsage } from "@yep-anywhere/shared";
import {
  type BridgeChangeSignal,
  BridgeHttpClient,
  type BridgeHttpClientOptions,
  type BridgePollEntry,
  type BridgePollReason,
  type BridgePollState,
} from "../bridge-common/BridgeHttpClient.js";
import { isActiveBridgeSessionView } from "../bridge-common/session-state.js";
import type { BridgePendingInputBinding } from "../bridge-common/types.js";
import { getLogger } from "../logging/logger.js";
import { resolveCodexBridgeJournalMode } from "./journal-policy.js";
import { emptyCodexBridgeMetricsSnapshot } from "./metrics.js";
import type {
  CodexBridgeController,
  CodexBridgeSession,
  CodexBridgeSessionView,
  CodexBridgeStatus,
  CodexUsageRequestOptions,
  CodexUsageResponse,
} from "./types.js";

interface CodexSessionPollState extends BridgePollState {
  view: CodexBridgeSessionView;
  updatedAt: string;
  title: string | null;
  messageCount: number;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  contextUsage?: ContextUsage;
}

export interface CodexBridgePollDebugStats {
  polls: number;
  snapshotBytes: number;
  lastSnapshotBytes: number;
  unchangedPolls: number;
  fullPolls: number;
  targetedPolls: number;
  parsedSessionViews: number;
  reasons: Record<BridgePollReason, number>;
}

const LOG_POLL_PERF = process.env.CODEX_BRIDGE_LOG_POLL_PERF === "true";
const logger = getLogger();

export class CodexBridgeHttpClient
  extends BridgeHttpClient<
    CodexBridgeStatus,
    CodexBridgeSession,
    CodexSessionPollState
  >
  implements CodexBridgeController
{
  private lastSessionViewsEtag: string | undefined;
  private lastRevision: number | undefined;
  private lastInstanceId: string | undefined;
  private readonly pollDebugStats: CodexBridgePollDebugStats = {
    polls: 0,
    snapshotBytes: 0,
    lastSnapshotBytes: 0,
    unchangedPolls: 0,
    fullPolls: 0,
    targetedPolls: 0,
    parsedSessionViews: 0,
    reasons: {
      startup: 0,
      interval: 0,
      "change-signal": 0,
      queued: 0,
    },
  };

  getPollDebugStats(): CodexBridgePollDebugStats {
    return {
      ...this.pollDebugStats,
      reasons: { ...this.pollDebugStats.reasons },
    };
  }

  override async getStatus(): Promise<CodexBridgeStatus> {
    const status = await super.getStatus();
    return {
      ...status,
      journalMode: resolveCodexBridgeJournalMode(status.journalMode),
      metrics: status.metrics ?? emptyCodexBridgeMetricsSnapshot(),
    };
  }

  async bindPendingInputInteraction(
    sessionId: string,
    requestId: string,
    binding: BridgePendingInputBinding,
  ): Promise<boolean> {
    const data = await this.fetchJson<{ bound?: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/input-binding`,
      {
        method: "POST",
        body: JSON.stringify({ requestId, ...binding }),
      },
    );
    return data?.bound ?? false;
  }

  async getUsage(
    options: CodexUsageRequestOptions = {},
  ): Promise<CodexUsageResponse> {
    const data = await this.fetchJson<CodexUsageResponse>(
      options.fresh ? "/usage?fresh=1" : "/usage",
    );
    return (
      data ?? {
        usage: null,
        error: "Codex bridge sidecar is unavailable",
      }
    );
  }

  protected unavailableStatus(): CodexBridgeStatus {
    const emptyUpstream = (profile: "clear" | "light" | "full") => ({
      profile,
      url: null,
      running: false,
      starting: false,
      pid: null,
      args: [] as string[],
    });
    return {
      enabled: true,
      listening: false,
      host: "127.0.0.1",
      port: 0,
      url: this.baseUrl.replace(/^http:/, "ws:"),
      journalMode: "lifecycle",
      upstreamUrl: null,
      upstreamRunning: false,
      upstreamMode: "managed",
      upstreams: {
        clear: emptyUpstream("clear"),
        light: emptyUpstream("light"),
        full: emptyUpstream("full"),
      },
      connectionCount: 0,
      attachedClientCount: 0,
      detachedConnectionCount: 0,
      sessionCount: 0,
      pendingInputCount: 0,
      recentMcpStartupEvents: [],
      metrics: emptyCodexBridgeMetricsSnapshot(),
      lastError: "Codex bridge sidecar is unavailable",
    };
  }

  protected async collectPollEntries(
    reason: BridgePollReason,
    changeSignal?: BridgeChangeSignal,
  ): Promise<BridgePollEntry<CodexSessionPollState>[]> {
    if (
      changeSignal?.changedSessionIds.length &&
      changeSignal.revision !== undefined &&
      changeSignal.baseRevision !== undefined &&
      changeSignal.baseRevision === this.lastRevision &&
      // A restarted sidecar restarts its revision counter too, so a matching
      // baseRevision across instances would authorize a targeted refresh
      // against a catalog this client has never seen.
      changeSignal.instanceId !== undefined &&
      changeSignal.instanceId === this.lastInstanceId
    ) {
      const targeted = await this.collectTargetedEntries(
        changeSignal.changedSessionIds,
      );
      if (!targeted) return this.knownPollEntries();
      for (const sessionId of targeted.tombstones) {
        this.removeKnownSession(sessionId);
      }
      this.lastRevision = changeSignal.revision;
      // The sidecar snapshot ETag is defined by this same monotonically
      // increasing revision. Advancing both prevents the next interval from
      // re-downloading the full catalog after a successful targeted refresh.
      this.lastSessionViewsEtag = `W/"${changeSignal.instanceId}-${changeSignal.revision}"`;
      this.recordPollSnapshot(
        reason,
        targeted.responseBytes,
        false,
        targeted.entries.length,
        "targeted",
      );
      return targeted.entries;
    }
    if (changeSignal) {
      // A revision gap means at least one SSE frame was missed. Keep stale
      // rows intact; the next interval performs the authoritative ETag
      // snapshot recovery instead of accepting a partial refresh as complete.
      return this.knownPollEntries();
    }

    const response = await this.fetchJsonResponse<{
      instanceId?: string;
      revision?: number;
      sessions?: CodexBridgeSessionView[];
    }>("/session-views", {
      headers: this.lastSessionViewsEtag
        ? { "if-none-match": this.lastSessionViewsEtag }
        : undefined,
    });
    if (!response) {
      this.recordPollSnapshot(reason, 0, true, 0, "full");
      return this.knownPollEntries();
    }
    if (response.etag) this.lastSessionViewsEtag = response.etag;
    if (response.status === 304) {
      this.recordPollSnapshot(reason, 0, true, 0, "full");
      return this.knownPollEntries();
    }
    const viewsData = response.data;
    if (!viewsData) {
      return this.knownPollEntries();
    }
    this.lastRevision = viewsData.revision;
    this.lastInstanceId = viewsData.instanceId;
    const views = this.normalizePollViews(viewsData.sessions ?? []);
    const entries = this.pollEntriesFromViews(views);
    this.recordPollSnapshot(
      reason,
      response.responseBytes,
      false,
      views.length,
      "full",
    );
    return entries;
  }

  private async collectTargetedEntries(sessionIds: string[]): Promise<{
    entries: BridgePollEntry<CodexSessionPollState>[];
    tombstones: string[];
    responseBytes: number;
  } | null> {
    const ids = Array.from(new Set(sessionIds));
    const views: CodexBridgeSessionView[] = [];
    const tombstones: string[] = [];
    let responseBytes = 0;
    let failed = false;
    let nextIndex = 0;
    const workerCount = Math.min(16, ids.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (!failed) {
          const id = ids[nextIndex++];
          if (!id) return;
          const response = await this.fetchJsonResponse<{
            sessionView?: CodexBridgeSessionView | null;
          }>(`/sessions/${encodeURIComponent(id)}/view`);
          if (!response?.data || !("sessionView" in response.data)) {
            failed = true;
            return;
          }
          responseBytes += response.responseBytes;
          const view = response.data.sessionView ?? null;
          if (
            !view ||
            !this.isDisplayableBridgeSession(view.session, {
              activity: view.activity,
              pendingInputType: view.pendingInputType,
            })
          ) {
            tombstones.push(id);
          } else {
            views.push(this.normalizeSessionView(view));
          }
        }
      }),
    );
    if (failed) return null;
    return {
      entries: this.pollEntriesFromViews(views),
      tombstones,
      responseBytes,
    };
  }

  private normalizePollViews(
    input: CodexBridgeSessionView[],
  ): CodexBridgeSessionView[] {
    return input
      .filter((view) =>
        this.isDisplayableBridgeSession(view.session, {
          activity: view.activity,
          pendingInputType: view.pendingInputType,
        }),
      )
      .map((view) => this.normalizeSessionView(view));
  }

  private pollEntriesFromViews(
    views: CodexBridgeSessionView[],
  ): BridgePollEntry<CodexSessionPollState>[] {
    const entries: BridgePollEntry<CodexSessionPollState>[] = [];
    for (const view of views) {
      const session = view.session;
      entries.push({
        id: session.id,
        view,
        state: {
          view,
          projectId: session.projectId,
          updatedAt: session.updatedAt,
          title: session.title,
          messageCount: session.messageCount,
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          serviceTier: session.serviceTier,
          contextUsage: session.contextUsage,
          activity: view.activity ?? session.activity,
          pendingInputType: view.pendingInputType ?? session.pendingInputType,
          pendingInputRequestId: view.pendingInputRequestId,
          active: isActiveBridgeSessionView(view),
          lastTurnStatus: session.lastTurnStatus,
          lastErrorMessage: session.lastErrorMessage,
          retryStatus: session.retryStatus,
        },
      });
    }
    return entries;
  }

  private knownPollEntries(): BridgePollEntry<CodexSessionPollState>[] {
    return Array.from(this.knownSessions.entries()).map(([id, state]) => ({
      id,
      view: state.view,
      state,
    }));
  }

  private recordPollSnapshot(
    reason: BridgePollReason,
    snapshotBytes: number,
    unchanged: boolean,
    parsedSessionViews: number,
    mode: "full" | "targeted",
  ): void {
    this.pollDebugStats.polls += 1;
    this.pollDebugStats.snapshotBytes += snapshotBytes;
    this.pollDebugStats.lastSnapshotBytes = snapshotBytes;
    this.pollDebugStats.reasons[reason] += 1;
    if (unchanged) this.pollDebugStats.unchangedPolls += 1;
    this.pollDebugStats.parsedSessionViews += parsedSessionViews;
    if (mode === "full") this.pollDebugStats.fullPolls += 1;
    else this.pollDebugStats.targetedPolls += 1;

    if (LOG_POLL_PERF) {
      logger.debug(
        {
          reason,
          snapshotBytes,
          unchanged,
          unchangedPolls: this.pollDebugStats.unchangedPolls,
          parsedSessionViews,
          mode,
          pollCount: this.pollDebugStats.polls,
        },
        "Codex bridge poll snapshot collected",
      );
    }
  }

  protected override emitExtraChanges(
    previous: CodexSessionPollState | undefined,
    entry: BridgePollEntry<CodexSessionPollState>,
    timestamp: string,
  ): void {
    if (!this.eventBus) return;
    const { state } = entry;
    if (
      !previous ||
      previous.updatedAt !== state.updatedAt ||
      previous.title !== state.title ||
      previous.messageCount !== state.messageCount ||
      previous.model !== state.model ||
      previous.reasoningEffort !== state.reasoningEffort ||
      previous.serviceTier !== state.serviceTier ||
      previous.contextUsage?.inputTokens !== state.contextUsage?.inputTokens ||
      previous.contextUsage?.percentage !== state.contextUsage?.percentage ||
      previous.contextUsage?.contextWindow !== state.contextUsage?.contextWindow
    ) {
      this.eventBus.emit({
        type: "session-updated",
        sessionId: entry.id,
        projectId: state.projectId,
        title: state.title,
        messageCount: state.messageCount,
        updatedAt: state.updatedAt,
        model: state.model,
        reasoningEffort: state.reasoningEffort,
        serviceTier: state.serviceTier,
        ...(state.contextUsage ? { contextUsage: state.contextUsage } : {}),
        timestamp,
      });
    }
  }
}
