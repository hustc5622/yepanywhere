import type {
  FeishuAccountMetrics,
  FeishuAccountStatus,
  FeishuConnectionState,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";

const logger = getLogger();

export type FeishuInboundMetricOutcome =
  | "accepted"
  | "duplicate"
  | "rejected"
  | "failed";

export type FeishuReplyMetricEvent =
  | "started"
  | "card_updated"
  | "card_degraded"
  | "first_feedback"
  | "first_token"
  | "completed";

export type FeishuInputMetricOutcome = "accepted" | "rejected" | "expired";

export class FeishuStatusRegistry {
  private readonly statuses = new Map<string, FeishuAccountStatus>();

  ensure(accountId: string, state: FeishuConnectionState = "stopped"): void {
    if (!this.statuses.has(accountId)) {
      this.statuses.set(accountId, {
        accountId,
        state,
        updatedAt: new Date().toISOString(),
        metrics: createEmptyMetrics(),
      });
    }
  }

  transition(
    accountId: string,
    state: FeishuConnectionState,
    options: { errorCode?: string; now?: Date } = {},
  ): FeishuAccountStatus {
    const previous = this.statuses.get(accountId);
    const now = (options.now ?? new Date()).toISOString();
    const next: FeishuAccountStatus = {
      ...previous,
      accountId,
      state,
      updatedAt: now,
      metrics: previous?.metrics ?? createEmptyMetrics(),
      connectedAt:
        state === "connected"
          ? (previous?.connectedAt ?? now)
          : previous?.connectedAt,
      lastErrorCode:
        state === "degraded" ? sanitizeErrorCode(options.errorCode) : undefined,
    };
    this.statuses.set(accountId, next);
    logSafeEvent("feishu_account_state_changed", accountId, {
      state,
      ...(next.lastErrorCode ? { errorCode: next.lastErrorCode } : {}),
    });
    return structuredClone(next);
  }

  markEvent(
    accountId: string,
    now = new Date(),
    kind: "message" | "card_action" | "mutation" = "message",
  ): FeishuAccountStatus {
    const status = this.updateMetrics(accountId, now, (metrics) => ({
      ...metrics,
      eventsReceived: metrics.eventsReceived + 1,
      messagesReceived: metrics.messagesReceived + (kind === "message" ? 1 : 0),
      cardActionsReceived:
        metrics.cardActionsReceived + (kind === "card_action" ? 1 : 0),
    }));
    status.lastEventAt = now.toISOString();
    this.statuses.set(accountId, structuredClone(status));
    logSafeEvent("feishu_event_received", accountId, { kind });
    return structuredClone(status);
  }

  markApiSuccess(accountId: string, now = new Date()): FeishuAccountStatus {
    this.ensure(accountId);
    const previous = this.statuses.get(accountId);
    if (!previous) throw new Error("Feishu account status missing");
    const next: FeishuAccountStatus = {
      ...previous,
      updatedAt: now.toISOString(),
      lastApiSuccessAt: now.toISOString(),
    };
    this.statuses.set(accountId, next);
    logSafeEvent("feishu_api_request_succeeded", accountId, {});
    return structuredClone(next);
  }

  recordInbound(
    accountId: string,
    outcome: FeishuInboundMetricOutcome,
    errorCode?: string,
  ): void {
    // An accepted message may later also be recorded as failed. The counters
    // represent lifecycle outcomes rather than mutually exclusive ingress
    // buckets; terminal owners must record `failed` exactly once.
    this.updateMetrics(accountId, new Date(), (metrics) => ({
      ...metrics,
      messagesAccepted:
        metrics.messagesAccepted + (outcome === "accepted" ? 1 : 0),
      messagesDuplicateDropped:
        metrics.messagesDuplicateDropped + (outcome === "duplicate" ? 1 : 0),
      messagesRejected:
        metrics.messagesRejected + (outcome === "rejected" ? 1 : 0),
      messagesFailed: metrics.messagesFailed + (outcome === "failed" ? 1 : 0),
    }));
    logSafeEvent(
      outcome === "duplicate"
        ? "feishu_event_duplicate_dropped"
        : outcome === "rejected"
          ? "feishu_message_policy_denied"
          : outcome === "failed"
            ? "feishu_message_failed"
            : "feishu_message_accepted",
      accountId,
      errorCode ? { errorCode: sanitizeMetricCode(errorCode) } : {},
    );
  }

  recordNormalization(
    accountId: string,
    input: { durationMs: number; forwardedItems?: number; failed?: boolean },
  ): void {
    const durationMs = sanitizeMetricNumber(input.durationMs);
    const isMergeForward = input.forwardedItems !== undefined;
    const forwardedItems = sanitizeMetricNumber(input.forwardedItems ?? 0);
    this.updateMetrics(accountId, new Date(), (metrics) => ({
      ...metrics,
      mergeForwardExpanded:
        metrics.mergeForwardExpanded +
        (isMergeForward && !input.failed ? 1 : 0),
      mergeForwardItems: metrics.mergeForwardItems + forwardedItems,
      mergeForwardFailed:
        metrics.mergeForwardFailed + (input.failed && isMergeForward ? 1 : 0),
      lastNormalizationDurationMs: durationMs,
      ...(isMergeForward ? { lastMergeForwardDurationMs: durationMs } : {}),
    }));
    logSafeEvent(
      input.failed
        ? "feishu_message_normalization_failed"
        : isMergeForward
          ? "feishu_merge_forward_expanded"
          : "feishu_message_normalized",
      accountId,
      { durationMs, count: forwardedItems },
    );
  }

  recordMedia(
    accountId: string,
    input: { succeeded: number; failed: number; bytes: number },
  ): void {
    const succeeded = sanitizeMetricNumber(input.succeeded);
    const failed = sanitizeMetricNumber(input.failed);
    const bytes = sanitizeMetricNumber(input.bytes);
    this.updateMetrics(accountId, new Date(), (metrics) => ({
      ...metrics,
      mediaDownloadsSucceeded: metrics.mediaDownloadsSucceeded + succeeded,
      mediaDownloadsFailed: metrics.mediaDownloadsFailed + failed,
      mediaBytes: metrics.mediaBytes + bytes,
    }));
    logSafeEvent("feishu_media_download_completed", accountId, {
      count: succeeded,
      failed,
      bytes,
    });
  }

  recordReply(
    accountId: string,
    event: FeishuReplyMetricEvent,
    durationMs?: number,
  ): void {
    const duration =
      durationMs === undefined ? undefined : sanitizeMetricNumber(durationMs);
    this.updateMetrics(accountId, new Date(), (metrics) => ({
      ...metrics,
      repliesStarted: metrics.repliesStarted + (event === "started" ? 1 : 0),
      cardUpdates: metrics.cardUpdates + (event === "card_updated" ? 1 : 0),
      cardUpdateDegraded:
        metrics.cardUpdateDegraded + (event === "card_degraded" ? 1 : 0),
      ...(event === "first_feedback" && duration !== undefined
        ? { lastFirstFeedbackDurationMs: duration }
        : {}),
      ...(event === "first_token" && duration !== undefined
        ? { lastFirstTokenDurationMs: duration }
        : {}),
      ...(event === "completed" && duration !== undefined
        ? { lastCompletionDurationMs: duration }
        : {}),
    }));
    logSafeEvent(
      event === "card_degraded"
        ? "feishu_card_update_degraded"
        : event === "card_updated"
          ? "feishu_card_updated"
          : event === "started"
            ? "feishu_card_created"
            : `feishu_reply_${event}`,
      accountId,
      duration === undefined ? {} : { durationMs: duration },
    );
  }

  recordInput(accountId: string, outcome: FeishuInputMetricOutcome): void {
    this.updateMetrics(accountId, new Date(), (metrics) => ({
      ...metrics,
      approvalsAccepted:
        metrics.approvalsAccepted + (outcome === "accepted" ? 1 : 0),
      approvalsRejected:
        metrics.approvalsRejected + (outcome === "rejected" ? 1 : 0),
      approvalsExpired:
        metrics.approvalsExpired + (outcome === "expired" ? 1 : 0),
    }));
    logSafeEvent(`feishu_input_response_${outcome}`, accountId, {});
  }

  setPendingApprovals(accountId: string, count: number): void {
    this.updateMetrics(accountId, new Date(), (metrics) => ({
      ...metrics,
      pendingApprovals: sanitizeMetricNumber(count),
    }));
  }

  setScopeQueueDepth(accountId: string, count: number): void {
    this.updateMetrics(accountId, new Date(), (metrics) => ({
      ...metrics,
      scopeQueueDepth: sanitizeMetricNumber(count),
    }));
  }

  get(accountId: string): FeishuAccountStatus | undefined {
    const status = this.statuses.get(accountId);
    return status ? structuredClone(status) : undefined;
  }

  list(): FeishuAccountStatus[] {
    return [...this.statuses.values()].map((status) => structuredClone(status));
  }

  remove(accountId: string): boolean {
    return this.statuses.delete(accountId);
  }

  private updateMetrics(
    accountId: string,
    now: Date,
    update: (metrics: FeishuAccountMetrics) => FeishuAccountMetrics,
  ): FeishuAccountStatus {
    this.ensure(accountId);
    const previous = this.statuses.get(accountId);
    if (!previous) throw new Error("Feishu account status missing");
    const next: FeishuAccountStatus = {
      ...previous,
      updatedAt: now.toISOString(),
      metrics: update(previous.metrics),
    };
    this.statuses.set(accountId, next);
    return structuredClone(next);
  }
}

function createEmptyMetrics(): FeishuAccountMetrics {
  return {
    eventsReceived: 0,
    messagesReceived: 0,
    cardActionsReceived: 0,
    messagesAccepted: 0,
    messagesDuplicateDropped: 0,
    messagesRejected: 0,
    messagesFailed: 0,
    mergeForwardExpanded: 0,
    mergeForwardItems: 0,
    mergeForwardFailed: 0,
    mediaDownloadsSucceeded: 0,
    mediaDownloadsFailed: 0,
    mediaBytes: 0,
    repliesStarted: 0,
    cardUpdates: 0,
    cardUpdateDegraded: 0,
    pendingApprovals: 0,
    approvalsAccepted: 0,
    approvalsRejected: 0,
    approvalsExpired: 0,
    scopeQueueDepth: 0,
  };
}

function sanitizeMetricNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function sanitizeMetricCode(value: string): string {
  const safe = value.replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
  return safe || "UNKNOWN";
}

function logSafeEvent(
  event: string,
  accountId: string,
  fields: Record<string, string | number>,
): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const message = `[Feishu] event=${event} accountId=${sanitizeMetricCode(accountId.toUpperCase())}${suffix ? ` ${suffix}` : ""}`;
  if (
    event === "feishu_account_state_changed" ||
    event === "feishu_message_failed" ||
    event === "feishu_card_update_degraded"
  ) {
    logger.info(message);
  } else {
    logger.debug(message);
  }
}

function sanitizeErrorCode(errorCode: string | undefined): string | undefined {
  if (!errorCode) return undefined;
  return FEISHU_STATUS_ERROR_CODES.has(errorCode) ? errorCode : "UNKNOWN";
}

const FEISHU_STATUS_ERROR_CODES = new Set([
  "SECRET_MISSING",
  "WS_CONNECT_FAILED",
  "WS_START_FAILED",
  "DUPLICATE_APP_ID",
  "INBOUND_HANDLER_MISSING",
  "BOT_IDENTITY_FAILED",
]);
