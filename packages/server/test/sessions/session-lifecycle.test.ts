import { describe, expect, it } from "vitest";
import {
  LAST_TURN_OUTCOME_GRACE_MS,
  type SessionRuntimeProcess,
  resolveSessionLifecycle,
} from "../../src/sessions/session-lifecycle.js";

const NOW = 10_000_000;

function owned(
  state: SessionRuntimeProcess["state"],
  extra: Partial<SessionRuntimeProcess> = {},
): SessionRuntimeProcess {
  return { id: "process-1", state, ...extra };
}

describe("resolveSessionLifecycle", () => {
  it("never reports an owned idle mid-turn history as unknown", () => {
    // The screenshot case without background work: Yep owns the process, it
    // is idle, and the transcript stops mid-turn.
    const resolved = resolveSessionLifecycle({
      process: owned("idle"),
      persistedLastTurnStatus: "incomplete",
      now: NOW,
    });
    expect(resolved.displayActivity).toBe("incomplete");
    expect(resolved.visibleLastTurnStatus).toBe("incomplete");
    expect(resolved.toolsMayBeActive).toBe(false);
    expect(resolved.runtime).toMatchObject({
      ownership: { owner: "self", processId: "process-1" },
      activity: "idle",
      isBusy: false,
      hasResidentWorker: true,
      canArchive: true,
    });
  });

  it("reports an idle owner holding background work as background", () => {
    // The screenshot case: agy resolved the prompt while a command keeps
    // running in the background.
    const resolved = resolveSessionLifecycle({
      process: owned("idle", { hasPendingBackgroundWork: true }),
      persistedLastTurnStatus: "incomplete",
      now: NOW,
    });
    expect(resolved.displayActivity).toBe("background");
    expect(resolved.visibleLastTurnStatus).toBeUndefined();
    expect(resolved.toolsMayBeActive).toBe(true);
    expect(resolved.runtime).toMatchObject({
      activity: "idle",
      isBusy: true,
      hasPendingBackgroundWork: true,
      canArchive: false,
      archiveBlockCode: "background_work",
    });
  });

  it("ignores background work unless the owner is idle", () => {
    const resolved = resolveSessionLifecycle({
      process: owned("in-turn", { hasPendingBackgroundWork: true }),
      now: NOW,
    });
    expect(resolved.displayActivity).toBe("running");
    expect(resolved.runtime.hasPendingBackgroundWork).toBeUndefined();
    expect(resolved.runtime.archiveBlockCode).toBe("agent_in_turn");
  });

  it("trusts a just-finished turn while the transcript flushes", () => {
    const fresh = resolveSessionLifecycle({
      process: owned("idle", {
        lastTurnOutcome: { status: "completed", endedAt: NOW - 1_000 },
      }),
      persistedLastTurnStatus: "incomplete",
      now: NOW,
    });
    expect(fresh.displayActivity).toBe("completed");
    const stale = resolveSessionLifecycle({
      process: owned("idle", {
        lastTurnOutcome: {
          status: "completed",
          endedAt: NOW - LAST_TURN_OUTCOME_GRACE_MS - 1,
        },
      }),
      persistedLastTurnStatus: "incomplete",
      now: NOW,
    });
    expect(stale.displayActivity).toBe("incomplete");
    // Without any history the process' own outcome is the best record.
    expect(
      resolveSessionLifecycle({
        process: owned("idle", {
          lastTurnOutcome: { status: "failed", endedAt: NOW - 60_000 },
        }),
        now: NOW,
      }).displayActivity,
    ).toBe("failed");
  });

  it("maps owned live states", () => {
    expect(
      resolveSessionLifecycle({ process: owned("in-turn") }).displayActivity,
    ).toBe("running");
    expect(
      resolveSessionLifecycle({ process: owned("hold") }).displayActivity,
    ).toBe("hold");
    expect(
      resolveSessionLifecycle({
        process: owned("in-turn", {
          pendingInputRequest: { type: "tool-approval", id: "r1" },
        }),
      }).displayActivity,
    ).toBe("waiting-input");
    expect(
      resolveSessionLifecycle({ process: owned({ type: "waiting-input" }) })
        .displayActivity,
    ).toBe("waiting-input");
  });

  it("treats an active external agent as a live writer", () => {
    const resolved = resolveSessionLifecycle({
      externalActive: true,
      persistedLastTurnStatus: "incomplete",
    });
    expect(resolved.runtime.ownership).toEqual({ owner: "external" });
    expect(resolved.runtime.archiveBlockCode).toBe("external_active");
    expect(resolved.displayActivity).toBe("running");
    expect(resolved.visibleLastTurnStatus).toBeUndefined();
    expect(
      resolveSessionLifecycle({
        externalActive: true,
        externalActivity: "waiting-input",
      }).displayActivity,
    ).toBe("waiting-input");
  });

  it("shows the persisted outcome when nothing drives the session", () => {
    for (const status of [
      "completed",
      "interrupted",
      "failed",
      "incomplete",
    ] as const) {
      const resolved = resolveSessionLifecycle({
        persistedLastTurnStatus: status,
      });
      expect(resolved.displayActivity).toBe(status);
      expect(resolved.visibleLastTurnStatus).toBe(status);
      expect(resolved.runtime.canArchive).toBe(true);
    }
    // Claude's legacy flag means incomplete.
    expect(
      resolveSessionLifecycle({ persistedInterrupted: true }).displayActivity,
    ).toBe("incomplete");
    // An empty or status-less history is settled, not unknown.
    expect(resolveSessionLifecycle({}).displayActivity).toBe("completed");
  });

  it("reserves unknown for a runtime that could not be inspected", () => {
    const resolved = resolveSessionLifecycle({
      runtimeUnavailable: true,
      persistedLastTurnStatus: "incomplete",
    });
    expect(resolved.displayActivity).toBe("unknown");
    expect(resolved.visibleLastTurnStatus).toBeUndefined();
  });
});
