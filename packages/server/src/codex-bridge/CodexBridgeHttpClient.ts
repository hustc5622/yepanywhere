import type { ContextUsage } from "@yep-anywhere/shared";
import {
  BridgeHttpClient,
  type BridgeHttpClientOptions,
  type BridgePollEntry,
  type BridgePollState,
} from "../bridge-common/BridgeHttpClient.js";
import type { BridgePendingInputBinding } from "../bridge-common/types.js";
import { resolveCodexBridgeJournalMode } from "./journal-policy.js";
import { emptyCodexBridgeMetricsSnapshot } from "./metrics.js";
import { isLiveBridgeSession } from "./session-state.js";
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

export class CodexBridgeHttpClient
  extends BridgeHttpClient<
    CodexBridgeStatus,
    CodexBridgeSession,
    CodexSessionPollState
  >
  implements CodexBridgeController
{
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

  protected async collectPollEntries(): Promise<
    BridgePollEntry<CodexSessionPollState>[]
  > {
    const [sessionsData, viewsData] = await Promise.all([
      this.fetchJson<{ sessions?: CodexBridgeSession[] }>("/sessions"),
      this.fetchJson<{ sessions?: CodexBridgeSessionView[] }>("/session-views"),
    ]);
    if (!sessionsData || !viewsData) {
      return Array.from(this.knownSessions.entries()).map(([id, state]) => ({
        id,
        view: state.view,
        state,
      }));
    }
    const sessions = sessionsData.sessions ?? [];
    const views = (viewsData.sessions ?? [])
      .filter((view) =>
        this.isDisplayableBridgeSession(view.session, {
          activity: view.activity,
          pendingInputType: view.pendingInputType,
        }),
      )
      .map((view) => this.normalizeSessionView(view));
    const viewsById = new Map(views.map((view) => [view.session.id, view]));

    const entries: BridgePollEntry<CodexSessionPollState>[] = [];
    for (const session of sessions) {
      const view = viewsById.get(session.id);
      if (!view) continue;
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
          activity: session.activity,
          pendingInputType: session.pendingInputType,
          pendingInputRequestId: view.pendingInputRequestId,
          active: isLiveBridgeSession(session),
          lastTurnStatus: session.lastTurnStatus,
          lastErrorMessage: session.lastErrorMessage,
        },
      });
    }
    return entries;
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
