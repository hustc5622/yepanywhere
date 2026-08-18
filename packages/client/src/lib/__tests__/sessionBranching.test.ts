import type { SessionBranchState } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  HistoricalEditQueueError,
  canEditPersistedUserPrompt,
  requireStartedHistoricalEdit,
  resolveBranchNavigationFocus,
  resolveBranchNavigationTarget,
  resolveSessionEditSubmission,
  shouldRestoreHistoricalEditAfterFailure,
  supportsHistoricalMessageEditing,
} from "../sessionBranching";

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    return error;
  }
}

describe("provider-specific historical message editing", () => {
  it("uses Pi's persisted entry id as the native edit-fork boundary", () => {
    expect(canEditPersistedUserPrompt("pi", "jsonl")).toBe(true);
    expect(canEditPersistedUserPrompt("pi", "sdk")).toBe(false);
    expect(
      resolveSessionEditSubmission("pi", {
        uuid: "pi-user-entry",
        parentUuid: "pi-parent-entry",
      }),
    ).toEqual({
      kind: "edit-fork",
      resumeSessionAt: "pi-user-entry",
      optimisticTruncate: false,
      refreshSameSessionBranches: false,
    });
  });

  it("keeps Claude parent-boundary and gives Codex source-preserving fork semantics", () => {
    expect(
      resolveSessionEditSubmission("claude", {
        uuid: "user-2",
        parentUuid: "assistant-1",
      }),
    ).toMatchObject({
      kind: "claude-resume",
      resumeSessionAt: "assistant-1",
    });
    expect(
      resolveSessionEditSubmission("claude", {
        uuid: "user-1",
        parentUuid: null,
      }),
    ).toEqual({ kind: "start-new" });
    expect(
      resolveSessionEditSubmission("codex", {
        uuid: "codex-turn",
        parentUuid: null,
        rollbackNumTurns: 2,
      }),
    ).toEqual({
      kind: "codex-fork",
      rollbackNumTurns: 2,
      optimisticTruncate: false,
      refreshSameSessionBranches: false,
    });
  });

  it("only enables native-entry forks after the authoritative disk message arrives", () => {
    expect(canEditPersistedUserPrompt("pi", "jsonl")).toBe(true);
    expect(canEditPersistedUserPrompt("pi", "sdk")).toBe(false);
    expect(canEditPersistedUserPrompt("zcode", "jsonl")).toBe(true);
    expect(canEditPersistedUserPrompt("zcode", "sdk")).toBe(false);
    expect(canEditPersistedUserPrompt("zcode", undefined)).toBe(false);
    expect(canEditPersistedUserPrompt("claude", "sdk")).toBe(true);
  });

  it("resolves ZCode edits to the provider-agnostic fork submission", () => {
    expect(supportsHistoricalMessageEditing("zcode")).toBe(true);
    expect(
      resolveSessionEditSubmission("zcode", {
        uuid: "msg_user_native",
        parentUuid: "not-the-boundary",
      }),
    ).toEqual({
      kind: "edit-fork",
      resumeSessionAt: "msg_user_native",
      optimisticTruncate: false,
      refreshSameSessionBranches: false,
    });
    // Editing the first ZCode prompt is still a fork attempt; the server
    // fails closed when no predecessor exists.
    expect(
      resolveSessionEditSubmission("zcode", {
        uuid: "msg_first_native",
        parentUuid: null,
      }),
    ).toMatchObject({
      kind: "edit-fork",
      resumeSessionAt: "msg_first_native",
    });
  });

  it("does not expose editing for unrelated providers", () => {
    expect(supportsHistoricalMessageEditing("gemini")).toBe(false);
    expect(supportsHistoricalMessageEditing("gemini-acp")).toBe(false);
    expect(supportsHistoricalMessageEditing("codex-oss")).toBe(false);
    expect(supportsHistoricalMessageEditing("claude-ollama")).toBe(false);
    expect(
      resolveSessionEditSubmission("gemini", {
        uuid: "gemini-user",
        parentUuid: "gemini-parent",
      }),
    ).toEqual({ kind: "unsupported" });
  });
});

describe("queued historical edit recovery", () => {
  const queuedResponse = {
    queued: true as const,
    queueId: "queue-1",
    position: 2,
  };

  it("allows retry only after the queued edit is confirmed cancelled", async () => {
    const error = await captureError(
      requireStartedHistoricalEdit(queuedResponse, async () => ({
        cancelled: true,
      })),
    );

    expect(error).toBeInstanceOf(HistoricalEditQueueError);
    expect(error).toMatchObject({ retrySafe: true });
    expect(shouldRestoreHistoricalEditAfterFailure(error, false, true)).toBe(
      true,
    );
  });

  it.each([
    [
      "cancellation request fails",
      async () => Promise.reject(new Error("404")),
    ],
    ["cancellation is not confirmed", async () => ({ cancelled: false })],
  ])("removes retry affordances when %s", async (_label, cancel) => {
    const error = await captureError(
      requireStartedHistoricalEdit(queuedResponse, cancel),
    );

    expect(error).toBeInstanceOf(HistoricalEditQueueError);
    expect(error).toMatchObject({ retrySafe: false });
    expect(shouldRestoreHistoricalEditAfterFailure(error, false, true)).toBe(
      false,
    );
  });

  it("restores only explicit POST failures and pre-POST validation failures", () => {
    const explicitHttpFailure = Object.assign(new Error("Bad request"), {
      status: 400,
    });

    expect(
      shouldRestoreHistoricalEditAfterFailure(explicitHttpFailure, false, true),
    ).toBe(true);
    expect(
      shouldRestoreHistoricalEditAfterFailure(
        new TypeError("Network failed"),
        false,
        true,
      ),
    ).toBe(false);
    expect(
      shouldRestoreHistoricalEditAfterFailure(
        new Error("Invalid boundary"),
        false,
        false,
      ),
    ).toBe(true);
  });

  it("does not restore after the server started the historical edit", () => {
    expect(
      shouldRestoreHistoricalEditAfterFailure(
        new Error("later failure"),
        true,
        true,
      ),
    ).toBe(false);
  });
});

describe("session branch navigation", () => {
  const branchState: SessionBranchState = {
    sessionId: "ses_parent",
    provider: "zcode",
    activeBranchId: "msg_original",
    selectedBranchId: "msg_original",
    branches: [
      {
        id: "msg_original",
        sessionId: "ses_parent",
        parentId: "msg_before",
        prompt: "original",
        title: "original",
        depth: 2,
        index: 1,
        siblingIndex: 1,
        siblingCount: 2,
        isActive: true,
      },
      {
        id: "msg_edited",
        sessionId: "ses_child",
        parentId: "msg_before",
        prompt: "edited",
        title: "edited",
        depth: 2,
        index: 2,
        siblingIndex: 2,
        siblingCount: 2,
        isActive: false,
      },
    ],
  };

  it("targets another native session and carries prompt focus IDs", () => {
    expect(
      resolveBranchNavigationTarget("msg_edited", "ses_parent", branchState),
    ).toEqual({
      branchId: "msg_edited",
      sessionId: "ses_child",
      crossesSession: true,
      focusBranchId: "msg_edited",
      focusMessageId: "msg_edited",
    });
  });

  it("keeps same-session alternatives on the query-only path", () => {
    expect(
      resolveBranchNavigationTarget("msg_original", "ses_parent", branchState),
    ).toMatchObject({
      sessionId: "ses_parent",
      crossesSession: false,
    });
  });

  it("restores branch and message focus from navigation state or the URL", () => {
    expect(
      resolveBranchNavigationFocus(
        {
          targetBranchId: "msg_edited",
          targetMessageId: "msg_edited",
        },
        "stale-query",
      ),
    ).toEqual({ branchId: "msg_edited", messageId: "msg_edited" });
    expect(resolveBranchNavigationFocus(null, "msg_from_query")).toEqual({
      branchId: "msg_from_query",
      messageId: "msg_from_query",
    });
  });
});
