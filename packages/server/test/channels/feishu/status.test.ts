import { describe, expect, it } from "vitest";
import { FeishuStatusRegistry } from "../../../src/channels/feishu/status.js";

describe("FeishuStatusRegistry", () => {
  it("tracks connection and event timestamps without retaining raw errors", () => {
    const statuses = new FeishuStatusRegistry();
    statuses.ensure("team-bot", "connecting");
    statuses.transition("team-bot", "connected", {
      now: new Date("2026-08-07T01:00:00.000Z"),
    });
    statuses.markEvent("team-bot", new Date("2026-08-07T01:01:00.000Z"));
    statuses.markApiSuccess("team-bot", new Date("2026-08-07T01:01:30.000Z"));
    const degraded = statuses.transition("team-bot", "degraded", {
      errorCode: "socket reset: secret=do-not-store",
      now: new Date("2026-08-07T01:02:00.000Z"),
    });

    expect(degraded).toMatchObject({
      accountId: "team-bot",
      state: "degraded",
      updatedAt: "2026-08-07T01:02:00.000Z",
      connectedAt: "2026-08-07T01:00:00.000Z",
      lastEventAt: "2026-08-07T01:01:00.000Z",
      lastApiSuccessAt: "2026-08-07T01:01:30.000Z",
      lastErrorCode: "UNKNOWN",
      metrics: {
        eventsReceived: 1,
        messagesReceived: 1,
      },
    });
    expect(JSON.stringify(degraded)).not.toContain("do-not-store");
  });

  it("tracks only numeric message, media, reply and input metrics", () => {
    const statuses = new FeishuStatusRegistry();
    statuses.recordInbound("team-bot", "accepted");
    statuses.recordInbound("team-bot", "failed", "RUNTIME_FAILED");
    statuses.recordInbound("team-bot", "duplicate");
    statuses.recordNormalization("team-bot", {
      durationMs: 12.4,
      forwardedItems: 29,
    });
    statuses.recordMedia("team-bot", {
      succeeded: 2,
      failed: 1,
      bytes: 1_024,
    });
    statuses.recordReply("team-bot", "started");
    statuses.recordReply("team-bot", "card_updated");
    statuses.recordReply("team-bot", "first_token", 34.8);
    statuses.recordInput("team-bot", "accepted");
    statuses.setPendingApprovals("team-bot", 3);
    statuses.setScopeQueueDepth("team-bot", 2);

    expect(statuses.get("team-bot")?.metrics).toMatchObject({
      messagesAccepted: 1,
      messagesDuplicateDropped: 1,
      messagesFailed: 1,
      mergeForwardExpanded: 1,
      mergeForwardItems: 29,
      lastMergeForwardDurationMs: 12,
      mediaDownloadsSucceeded: 2,
      mediaDownloadsFailed: 1,
      mediaBytes: 1_024,
      repliesStarted: 1,
      cardUpdates: 1,
      lastFirstTokenDurationMs: 35,
      approvalsAccepted: 1,
      pendingApprovals: 3,
      scopeQueueDepth: 2,
    });
  });

  it("returns defensive copies", () => {
    const statuses = new FeishuStatusRegistry();
    statuses.ensure("team-bot");
    const status = statuses.get("team-bot");
    if (!status) throw new Error("missing status");
    status.state = "connected";

    expect(statuses.get("team-bot")?.state).toBe("stopped");
  });
});
