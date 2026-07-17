import {
  BridgeHttpClient,
  type BridgeHttpClientOptions,
  type BridgePollEntry,
  type BridgePollState,
} from "../bridge-common/BridgeHttpClient.js";
import { isLiveOpenCodeBridgeSessionView } from "./session-state.js";
import type {
  OpenCodeBridgeController,
  OpenCodeBridgeSession,
  OpenCodeBridgeStatus,
} from "./types.js";

export class OpenCodeBridgeHttpClient
  extends BridgeHttpClient<OpenCodeBridgeStatus, OpenCodeBridgeSession>
  implements OpenCodeBridgeController
{
  protected unavailableStatus(): OpenCodeBridgeStatus {
    return {
      enabled: true,
      listening: false,
      host: "127.0.0.1",
      port: 0,
      url: this.baseUrl,
      serverUrl: "",
      opencodeServerUrl: "",
      opencodeServerMode: "managed",
      opencodeServerRunning: false,
      opencodeServerPid: null,
      opencodeConnected: false,
      sessionCount: 0,
      pendingInputCount: 0,
      lastError: "OpenCode CLI bridge sidecar is unavailable",
    };
  }

  /**
   * session-views already contains the full bridge session snapshot. Calling
   * both endpoints makes the sidecar synchronize its OpenCode status twice
   * per poll, which used to manufacture a new updatedAt every second.
   *
   * No session-updated events are emitted here (unlike codex): the sidecar
   * only has a best-effort runtime view of an OpenCode session. In particular,
   * its message count is initialized from the first observed message and is
   * not the persisted session count. Emitting that view as a session-updated
   * event made it race the SQLite reader: the client would first receive the
   * bridge title/count, then replace them with the authoritative database
   * summary on the focused watch refresh. The bridge stays responsible for
   * lifecycle state; persisted content is refreshed by
   * FocusedSessionWatchManager from the selected SQLite session row.
   */
  protected async collectPollEntries(): Promise<
    BridgePollEntry<BridgePollState>[]
  > {
    const views = await this.listSessionViews();
    return views.map((view) => ({
      id: view.session.id,
      view,
      state: {
        projectId: view.session.projectId,
        activity: view.session.activity,
        pendingInputType: view.session.pendingInputType,
        active: isLiveOpenCodeBridgeSessionView(view),
        lastErrorMessage: view.session.lastErrorMessage,
        retryStatus: view.session.retryStatus,
      },
    }));
  }
}
