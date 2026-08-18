/**
 * PushNotifier - Sends push notifications when sessions need user input
 *
 * Listens to EventBus for process state changes and sends push notifications
 * when a session enters waiting-input state (tool approval or user question).
 * The service worker on the client handles suppressing notifications when
 * the app is already focused.
 */

import { basename } from "node:path";
import {
  type ProviderName,
  type UrlProjectId,
  getSessionDisplayTitle,
} from "@yep-anywhere/shared";
import {
  type BridgeControllers,
  getAnyBridgePendingInputRequest,
} from "../bridge-common/multi.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/NotificationService.js";
import { decodeProjectId } from "../projects/paths.js";
import type { RuntimeController } from "../runtime/types.js";
import type { ConnectedBrowsersService } from "../services/ConnectedBrowsersService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { InputRequest } from "../supervisor/types.js";
import type {
  BusEvent,
  EventBus,
  ProcessStateEvent,
  ProcessTerminatedEvent,
  SessionSeenEvent,
} from "../watcher/EventBus.js";
import type { NativePushService } from "./NativePushService.js";
import type { PushService } from "./PushService.js";
import type {
  DismissPayload,
  PendingInputPayload,
  SessionHaltedPayload,
} from "./types.js";

export interface PushNotifierOptions {
  eventBus: EventBus;
  pushService: PushService;
  /** Optional native mobile push service (Android FCM). */
  nativePushService?: NativePushService;
  /** Tracks notification-backed badge state. */
  notificationService?: NotificationService;
  /** Durable Yep titles used to keep notification titles provider-agnostic. */
  sessionMetadataService?: Pick<SessionMetadataService, "getMetadata">;
  /** Live process source. RuntimeController is required for external mode. */
  runtimeController?: Pick<RuntimeController, "getProcessSnapshotForSession">;
  /** Backwards-compatible embedded/test process source. */
  supervisor?: Supervisor;
  /** Bridge sessions have no managed process, so pending input comes from here. */
  bridgeControllers?: BridgeControllers;
  /** Optional: skip push for connected browser profiles */
  connectedBrowsers?: ConnectedBrowsersService;
}

interface NotificationProcessView {
  id: string;
  state: string | { type: string; request?: InputRequest };
  pendingInputRequest?: InputRequest | null;
  messageHistory?: Array<{
    type?: string;
    message?: { role?: string; content?: unknown };
  }>;
  getMessageHistory?: () => Array<{
    type?: string;
    message?: { role?: string; content?: unknown };
  }>;
  startedAt?: string | Date;
  provider?: ProviderName;
  model?: string;
  resolvedModel?: string;
  executor?: string;
  permissionMode?: string;
}

interface CachedSessionTitles {
  providerTitle?: string;
  aiTitle?: string;
  customTitle?: string;
}

export class PushNotifier {
  private eventBus: EventBus;
  private pushService: PushService;
  private nativePushService?: NativePushService;
  private notificationService?: NotificationService;
  private sessionMetadataService?: PushNotifierOptions["sessionMetadataService"];
  private runtimeController?: PushNotifierOptions["runtimeController"];
  private supervisor?: Supervisor;
  private bridgeControllers?: BridgeControllers;
  private connectedBrowsers?: ConnectedBrowsersService;
  private unsubscribe: (() => void) | null = null;
  /**
   * Track sessions with delivered or in-flight notifications.
   * In-flight entries let rapid waiting-input -> running transitions wait for
   * delivery before deciding whether a dismiss is needed.
   */
  private sessionsWithNotification = new Map<string, true | Promise<boolean>>();
  /**
   * Session-scoped dedupe state for pending-input pushes.
   *
   * `process-state-changed` re-fires while a session stays in waiting-input
   * (the bridge transport re-emits on turn-status/retry changes), and
   * EventBus fans these out via `void handleProcessStateChange()` — so
   * multiple concurrent handlers can race the first delivery. The state is
   * registered atomically BEFORE awaiting the send result, so a repeat of
   * the same request id is skipped whether the first send is still pending
   * or already delivered.
   *
   * On send failure the state is only cleared when the map still holds the
   * same request id AND the same promise object, so a newer request cannot
   * be wiped out by an older async completion.
   */
  private sessionInputState = new Map<
    string,
    | { kind: "in-flight"; requestId: string; promise: Promise<boolean> }
    | { kind: "delivered"; requestId: string }
  >();
  private sessionsWithHaltedNotification = new Set<string>();
  private sessionTitlesBySessionId = new Map<string, CachedSessionTitles>();

  constructor(options: PushNotifierOptions) {
    this.eventBus = options.eventBus;
    this.pushService = options.pushService;
    this.nativePushService = options.nativePushService;
    this.notificationService = options.notificationService;
    this.sessionMetadataService = options.sessionMetadataService;
    this.runtimeController = options.runtimeController;
    this.supervisor = options.supervisor;
    this.bridgeControllers = options.bridgeControllers;
    this.connectedBrowsers = options.connectedBrowsers;

    // Subscribe to EventBus for process state changes
    this.unsubscribe = this.eventBus.subscribe((event: BusEvent) => {
      if (event.type === "process-state-changed") {
        void this.handleProcessStateChange(event);
      } else if (event.type === "process-terminated") {
        void this.handleProcessTerminated(event);
      } else if (event.type === "session-seen") {
        void this.handleSessionSeen(event);
      } else if (event.type === "session-created") {
        this.cacheSessionTitle(
          event.session.id,
          "providerTitle",
          event.session.title,
        );
        this.cacheSessionTitle(
          event.session.id,
          "aiTitle",
          event.session.aiTitle,
        );
        this.cacheSessionTitle(
          event.session.id,
          "customTitle",
          event.session.customTitle,
        );
      } else if (event.type === "session-updated") {
        this.cacheSessionTitle(event.sessionId, "providerTitle", event.title, {
          preserveOnEmpty: true,
        });
      } else if (event.type === "session-metadata-changed") {
        if (event.title !== undefined) {
          this.cacheSessionTitle(event.sessionId, "customTitle", event.title);
        }
        if (event.aiTitle !== undefined) {
          this.cacheSessionTitle(event.sessionId, "aiTitle", event.aiTitle);
        }
        this.syncMetadataTitles(event.sessionId);
      }
    });
  }

  /**
   * Handle process state change events.
   * Sends push notification when entering waiting-input state.
   * Sends dismiss when leaving waiting-input state (if we sent a notification).
   */
  private async handleProcessStateChange(
    event: ProcessStateEvent,
  ): Promise<void> {
    const process = await this.getProcess(event.sessionId);
    this.cacheProcessSessionTitle(event.sessionId, process);

    // Send dismiss when leaving waiting-input (if we sent a notification for it)
    if (event.activity !== "waiting-input") {
      // Clear the dedupe state so a stale async completion cannot revive it
      // or overwrite a newer request's state.
      this.sessionInputState.delete(event.sessionId);
      const notificationState = this.sessionsWithNotification.get(
        event.sessionId,
      );
      if (notificationState) {
        const wasSent =
          notificationState === true ? true : await notificationState;
        if (wasSent) {
          await this.sendDismiss(event.sessionId);
        }
        this.sessionsWithNotification.delete(event.sessionId);
      }
      if (event.activity === "in-turn") {
        this.sessionsWithHaltedNotification.delete(event.sessionId);
        try {
          await this.notificationService?.clearSessionNeedsReview(
            event.sessionId,
          );
        } catch (error) {
          console.error("[PushNotifier] Failed to clear badge state:", error);
        }
      }
      if (event.activity === "idle") {
        await this.sendSessionHalted(event, "completed");
      }
      return;
    }

    this.sessionsWithHaltedNotification.delete(event.sessionId);

    // Check if there are any subscriptions
    if (
      this.pushService.getSubscriptionCount() === 0 &&
      (this.nativePushService?.getSubscriptionCount() ?? 0) === 0
    ) {
      return;
    }

    // Resolve the pending input request, preferring the owned runtime process
    // when it actually carries one, and falling back to the bridge sidecar
    // otherwise. The bridge is consulted even when a process owns the
    // session, because the process can be `in-turn` (no pending request of
    // its own) while the bridge's long connection still holds a tool
    // approval that Yep must surface. Without this fallback, mobile push
    // was never sent for bridge-held approvals on owned sessions.
    let request: InputRequest | null = null;
    if (process) {
      // Only short-circuit when the owned process is itself waiting for
      // input AND carries a request. An in-turn process with no pending
      // request must still fall through to the bridge.
      if (this.getProcessActivity(process) === "waiting-input") {
        request = this.getPendingInputRequest(process);
      }
    }
    // When the owned process has no pending request, consult the bridge
    // sidecar too. The bridge is consulted even when a process owns the
    // session, because the process can be `in-turn` (no pending request of
    // its own) while the bridge's long connection still holds a tool
    // approval that Yep must surface. Without this fallback, mobile push
    // was never sent for bridge-held approvals on owned sessions.
    // `request` is null at this point (checked above), so the bridge result
    // does not collide with a process request id; when a process request
    // existed, the branch above already set `request` and we skip the
    // bridge.
    if (!request && this.bridgeControllers) {
      request = await getAnyBridgePendingInputRequest(
        this.bridgeControllers,
        event.sessionId,
      );
    }
    if (!request) return;

    // Dedupe by request id across concurrent handlers. The state is read
    // and written synchronously below, so a repeat of the same request id
    // that arrives while the first send is still in-flight is skipped
    // before it can call sendToAll.
    const existing = this.sessionInputState.get(event.sessionId);
    if (existing && existing.requestId === request.id) {
      return;
    }
    const inputType =
      request.type === "tool-approval" ? "tool-approval" : "user-question";

    // Check if this notification type is enabled in settings
    const settingKey =
      inputType === "tool-approval" ? "toolApproval" : "userQuestion";
    if (!this.pushService.isNotificationTypeEnabled(settingKey)) {
      return;
    }

    const projectName = this.getProjectName(event.projectId);
    const summary = this.buildSummary(request);

    const payload: PendingInputPayload = {
      type: "pending-input",
      sessionId: event.sessionId,
      projectId: event.projectId,
      projectName,
      sessionTitle: this.getPreferredSessionTitle(
        event.sessionId,
        process ? this.getSessionTitle(process) : undefined,
      ),
      inputType,
      summary,
      // Question notifications must route into the session UI. Omitting the
      // request id prevents old notification clients from treating them as a
      // one-tap approval that would submit no answers.
      requestId: inputType === "tool-approval" ? request.id : undefined,
      timestamp: event.timestamp,
    };

    // Skip push for browser profiles that are already connected
    const connectedIds =
      this.connectedBrowsers?.getConnectedBrowserProfileIds() ?? [];
    const sendPromise = this.sendPendingInput(payload, connectedIds);

    // Atomically register the in-flight state BEFORE awaiting so concurrent
    // repeats of the same request id are deduped while this send is pending.
    const inFlightEntry = {
      kind: "in-flight" as const,
      requestId: request.id,
      promise: sendPromise,
    };
    this.sessionInputState.set(event.sessionId, inFlightEntry);
    this.sessionsWithNotification.set(event.sessionId, sendPromise);

    const sent = await sendPromise;
    const current = this.sessionInputState.get(event.sessionId);
    if (sent) {
      // Only promote to delivered when the state still refers to this same
      // request. A newer request could have replaced it in the meantime.
      if (
        current &&
        current.kind === "in-flight" &&
        current.requestId === request.id &&
        current.promise === sendPromise
      ) {
        this.sessionInputState.set(event.sessionId, {
          kind: "delivered",
          requestId: request.id,
        });
      }
      this.sessionsWithNotification.set(event.sessionId, true);
    } else if (
      current &&
      current.kind === "in-flight" &&
      current.requestId === request.id &&
      current.promise === sendPromise
    ) {
      // Send failed and the state still points at this attempt: clear it so
      // the same request can be retried. A newer request's state is left
      // untouched.
      this.sessionInputState.delete(event.sessionId);
    }
    // When the state was replaced by a newer request, leave it as-is so the
    // newer request's in-flight/delivered record survives this completion.
  }

  private async sendPendingInput(
    payload: PendingInputPayload,
    connectedIds: string[],
  ): Promise<boolean> {
    try {
      if (connectedIds.length > 0) {
        console.log(
          `[PushNotifier] Skipping push for ${connectedIds.length} connected browser profile(s)`,
        );
      }

      const results = await this.pushService.sendToAll(payload, {
        excludeBrowserProfileIds: connectedIds,
      });
      const nativeResults =
        (await this.nativePushService?.sendToAll(payload, {
          excludeBrowserProfileIds: connectedIds,
        })) ?? [];
      const successCount = [...results, ...nativeResults].filter(
        (r) => r.success,
      ).length;
      const totalCount = results.length + nativeResults.length;
      if (successCount > 0) {
        console.log(
          `[PushNotifier] Sent pending-input notification to ${successCount}/${totalCount} devices`,
        );
        return true;
      }
      return false;
    } catch (error) {
      console.error("[PushNotifier] Failed to send push notification:", error);
      return false;
    }
  }

  /**
   * Send a dismiss notification to close notifications on all devices.
   */
  private async sendDismiss(sessionId: string): Promise<void> {
    if (
      this.pushService.getSubscriptionCount() === 0 &&
      (this.nativePushService?.getSubscriptionCount() ?? 0) === 0
    ) {
      return;
    }

    const payload: DismissPayload = {
      type: "dismiss",
      sessionId,
      timestamp: new Date().toISOString(),
    };

    try {
      await Promise.all([
        this.pushService.sendToAll(payload),
        this.nativePushService?.sendToAll(payload) ?? Promise.resolve([]),
      ]);
      console.log(`[PushNotifier] Sent dismiss for session ${sessionId}`);
    } catch (error) {
      console.error("[PushNotifier] Failed to send dismiss:", error);
    }
  }

  private async handleProcessTerminated(
    event: ProcessTerminatedEvent,
  ): Promise<void> {
    await this.sendSessionHalted(event, "error");
  }

  private async handleSessionSeen(event: SessionSeenEvent): Promise<void> {
    if (!event.timestamp) {
      return;
    }

    this.sessionsWithNotification.delete(event.sessionId);
    this.sessionInputState.delete(event.sessionId);
    this.sessionsWithHaltedNotification.delete(event.sessionId);
    this.sessionTitlesBySessionId.delete(event.sessionId);
    await this.sendDismiss(event.sessionId);
  }

  private async sendSessionHalted(
    event: Pick<
      ProcessStateEvent | ProcessTerminatedEvent,
      "sessionId" | "projectId" | "timestamp"
    >,
    reason: SessionHaltedPayload["reason"],
  ): Promise<void> {
    if (this.sessionsWithHaltedNotification.has(event.sessionId)) {
      return;
    }
    if (!this.pushService.isNotificationTypeEnabled("sessionHalted")) {
      return;
    }

    const process = await this.getProcess(event.sessionId);
    this.cacheProcessSessionTitle(event.sessionId, process);
    const sessionTitle = this.getPreferredSessionTitle(
      event.sessionId,
      process ? this.getSessionTitle(process) : undefined,
    );
    const projectName = this.getProjectName(event.projectId);
    const payload: SessionHaltedPayload = {
      type: "session-halted",
      sessionId: event.sessionId,
      projectId: event.projectId,
      projectName,
      sessionTitle,
      reason,
      duration: process?.startedAt
        ? Date.now() - new Date(process.startedAt).getTime()
        : 0,
      timestamp: event.timestamp,
    };

    try {
      await this.notificationService?.markSessionNeedsReview(
        event.sessionId,
        event.timestamp,
      );
    } catch (error) {
      console.error("[PushNotifier] Failed to update badge state:", error);
    }
    this.sessionsWithHaltedNotification.add(event.sessionId);

    if (
      this.pushService.getSubscriptionCount() === 0 &&
      (this.nativePushService?.getSubscriptionCount() ?? 0) === 0
    ) {
      return;
    }

    try {
      const connectedIds =
        this.connectedBrowsers?.getConnectedBrowserProfileIds() ?? [];
      const results = await this.pushService.sendToAll(payload, {
        excludeBrowserProfileIds: connectedIds,
      });
      const nativeResults =
        (await this.nativePushService?.sendToAll(payload, {
          excludeBrowserProfileIds: connectedIds,
        })) ?? [];
      const successCount = [...results, ...nativeResults].filter(
        (r) => r.success,
      ).length;
      const totalCount = results.length + nativeResults.length;
      if (successCount > 0) {
        console.log(
          `[PushNotifier] Sent session-halted notification to ${successCount}/${totalCount} devices`,
        );
      }
    } catch (error) {
      console.error(
        "[PushNotifier] Failed to send session-halted notification:",
        error,
      );
    }
  }

  private cacheProcessSessionTitle(
    sessionId: string,
    process: NotificationProcessView | null | undefined,
  ): void {
    if (!process) return;
    this.cacheSessionTitle(
      sessionId,
      "providerTitle",
      this.getSessionTitle(process),
      { preserveOnEmpty: true },
    );
  }

  private cacheSessionTitle(
    sessionId: string,
    field: keyof CachedSessionTitles,
    title: string | null | undefined,
    options: { preserveOnEmpty?: boolean } = {},
  ): void {
    const normalized = normalizeSessionTitle(title);
    if (!normalized && options.preserveOnEmpty) return;

    const cached = this.sessionTitlesBySessionId.get(sessionId) ?? {};
    if (normalized) cached[field] = normalized;
    else delete cached[field];

    if (cached.customTitle || cached.aiTitle || cached.providerTitle) {
      this.sessionTitlesBySessionId.set(sessionId, cached);
    } else {
      this.sessionTitlesBySessionId.delete(sessionId);
    }
  }

  private syncMetadataTitles(sessionId: string): void {
    const metadata = this.sessionMetadataService?.getMetadata(sessionId);
    if (!this.sessionMetadataService) return;
    this.cacheSessionTitle(sessionId, "customTitle", metadata?.customTitle);
    this.cacheSessionTitle(sessionId, "aiTitle", metadata?.aiTitle);
  }

  private getPreferredSessionTitle(
    sessionId: string,
    processTitle?: string,
  ): string | undefined {
    this.syncMetadataTitles(sessionId);
    const cached = this.sessionTitlesBySessionId.get(sessionId);
    const title = getSessionDisplayTitle({
      customTitle: cached?.customTitle,
      aiTitle: cached?.aiTitle,
      title: cached?.providerTitle ?? processTitle,
    });
    return title === "Untitled" ? undefined : title;
  }

  /**
   * Get project name from projectId.
   */
  private getProjectName(projectId: UrlProjectId): string {
    try {
      const projectPath = decodeProjectId(projectId);
      return basename(projectPath);
    } catch {
      return "Unknown Project";
    }
  }

  /**
   * Build a human-readable summary from the InputRequest.
   */
  private buildSummary(request: InputRequest): string {
    const subagentPrefix = this.subagentSummaryPrefix(request);
    if (request.type === "tool-approval") {
      const toolName = request.toolName ?? "Unknown tool";

      if (request.toolInput && typeof request.toolInput === "object") {
        const input = request.toolInput as Record<string, unknown>;

        // For file operations, try to extract the file path
        const filePath = input.file_path ?? input.filePath ?? input.path;
        if (typeof filePath === "string") {
          // Extract just the filename from the path
          const fileName = basename(filePath);
          return `${subagentPrefix}${toolName}: ${fileName}`;
        }
      }

      return `${subagentPrefix}Run: ${toolName}`;
    }

    // Questions require the full Yep UI. Keep the notification generic so it
    // cannot be mistaken for an actionable approval or expose answer details.
    return `${subagentPrefix}Question waiting — open Yep to answer`;
  }

  /**
   * When a request was routed up from a subagent (child session), prefix the
   * summary so the operator knows which subagent needs input. The request
   * itself still targets the parent session for navigation.
   */
  private subagentSummaryPrefix(request: InputRequest): string {
    if (!request.toolInput || typeof request.toolInput !== "object") return "";
    const input = request.toolInput as Record<string, unknown>;
    if (typeof input.originSessionId !== "string") return "";
    const title =
      typeof input.originSessionTitle === "string" && input.originSessionTitle
        ? input.originSessionTitle
        : typeof input.originAgent === "string" && input.originAgent
          ? input.originAgent
          : undefined;
    return title ? `Subagent ${title} — ` : "Subagent — ";
  }

  private getSessionTitle(
    process: NotificationProcessView,
  ): string | undefined {
    const firstUser = this.getMessageHistory(process).find((message) => {
      return (
        message.type === "user" && typeof message.message?.content === "string"
      );
    });
    const content = firstUser?.message?.content;
    if (typeof content !== "string") return undefined;
    const normalized = content.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    return normalized.length <= 120
      ? normalized
      : `${normalized.slice(0, 117)}...`;
  }

  private async getProcess(
    sessionId: string,
  ): Promise<NotificationProcessView | null> {
    if (this.runtimeController) {
      return this.runtimeController.getProcessSnapshotForSession(sessionId);
    }
    return (
      (this.supervisor?.getProcessForSession(sessionId) as
        | NotificationProcessView
        | undefined) ?? null
    );
  }

  private getProcessActivity(process: NotificationProcessView): string {
    return typeof process.state === "string"
      ? process.state
      : process.state.type;
  }

  private getPendingInputRequest(
    process: NotificationProcessView,
  ): InputRequest | null {
    if (process.pendingInputRequest) return process.pendingInputRequest;
    return typeof process.state === "object" &&
      process.state.type === "waiting-input"
      ? (process.state.request ?? null)
      : null;
  }

  private getMessageHistory(process: NotificationProcessView) {
    return process.messageHistory ?? process.getMessageHistory?.() ?? [];
  }

  /**
   * Clean up EventBus subscription.
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

function normalizeSessionTitle(
  title: string | null | undefined,
): string | undefined {
  const normalized = title?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= 120
    ? normalized
    : `${normalized.slice(0, 117)}...`;
}
