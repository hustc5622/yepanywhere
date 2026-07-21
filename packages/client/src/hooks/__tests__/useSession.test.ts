import { getSessionDisplayTitle } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { SessionMetadataChangedEvent } from "../../lib/activityBus";
import type { Message, Session } from "../../types";
import {
  type PendingMessage,
  isCodexHistoryRewriteSnapshotReady,
  mergeSessionMetadataChange,
  processStateFromProcessEvent,
  reconcilePendingMessagesWithConfirmedMessages,
  sessionTurnHealthFromSession,
  shouldRefreshFullPersistedSession,
  shouldRefreshOpenCodeAuthoritativeSnapshot,
} from "../useSession";

function pending(overrides?: Partial<PendingMessage>): PendingMessage {
  return {
    tempId: "temp-1",
    content: "please do the thing",
    timestamp: "2026-07-06T12:00:00.000Z",
    ...overrides,
  };
}

function userMessage(overrides?: Partial<Message>): Message {
  return {
    type: "user",
    uuid: "msg-1",
    timestamp: "2026-07-06T12:00:01.000Z",
    message: {
      role: "user",
      content: "please do the thing",
    },
    ...overrides,
  };
}

function session(overrides?: Partial<Session>): Session {
  return {
    id: "ses-current",
    projectId: "project" as Session["projectId"],
    title: "Provider fallback",
    fullTitle: "Provider fallback",
    customTitle: undefined,
    aiTitle: undefined,
    createdAt: "2026-07-06T12:00:00.000Z",
    updatedAt: "2026-07-06T12:00:01.000Z",
    messageCount: 2,
    ownership: { owner: "none" },
    provider: "opencode",
    messages: [],
    ...overrides,
  };
}

function metadataEvent(
  overrides?: Partial<SessionMetadataChangedEvent>,
): SessionMetadataChangedEvent {
  return {
    type: "session-metadata-changed",
    sessionId: "ses-current",
    timestamp: "2026-07-06T12:00:02.000Z",
    ...overrides,
  };
}

describe("reconcilePendingMessagesWithConfirmedMessages", () => {
  it("removes a pending message when a confirmed REST user message matches the content", () => {
    const result = reconcilePendingMessagesWithConfirmedMessages(
      [pending()],
      [userMessage({ _source: "jsonl" })],
    );

    expect(result).toEqual([]);
  });

  it("removes a pending message when a streamed user message echoes the temp id", () => {
    const result = reconcilePendingMessagesWithConfirmedMessages(
      [pending()],
      [
        userMessage({
          tempId: "temp-1",
          message: { role: "user", content: "different formatting" },
        } as Partial<Message>),
      ],
    );

    expect(result).toEqual([]);
  });

  it("keeps pending messages when only an older same-content history message exists", () => {
    const item = pending();
    const result = reconcilePendingMessagesWithConfirmedMessages(
      [item],
      [
        userMessage({
          timestamp: "2026-07-06T11:59:00.000Z",
        }),
      ],
    );

    expect(result).toEqual([item]);
  });

  it("matches server-expanded attachment text", () => {
    const result = reconcilePendingMessagesWithConfirmedMessages(
      [pending()],
      [
        userMessage({
          message: {
            role: "user",
            content:
              "please do the thing\n\nUser uploaded files:\n- image.png (1.0 KB, image/png): /tmp/image.png",
          },
        }),
      ],
    );

    expect(result).toEqual([]);
  });
});

describe("isCodexHistoryRewriteSnapshotReady", () => {
  const codexSession = session({
    provider: "codex",
    codexBranchState: {
      sessionId: "ses-current",
      activeBranchId: "branch-new",
      selectedBranchId: "branch-new",
      branches: [
        {
          id: "branch-old",
          sessionId: "ses-current",
          parentId: null,
          prompt: "Original prompt",
          title: "Original prompt",
          depth: 1,
          index: 1,
          siblingIndex: 1,
          siblingCount: 2,
          isActive: false,
        },
        {
          id: "branch-new",
          sessionId: "ses-current",
          parentId: null,
          prompt:
            "Edited prompt\n\nUser uploaded files:\n- image.png: /tmp/image.png",
          title: "Edited prompt",
          depth: 1,
          index: 2,
          siblingIndex: 2,
          siblingCount: 2,
          isActive: true,
        },
      ],
    },
  });

  it("accepts only the new active sibling containing the edited prompt", () => {
    expect(
      isCodexHistoryRewriteSnapshotReady(codexSession, {
        expectedPrompt: "Edited prompt",
        previousActiveBranchId: "branch-old",
      }),
    ).toBe(true);
  });

  it("rejects a snapshot whose active branch has not changed", () => {
    expect(
      isCodexHistoryRewriteSnapshotReady(codexSession, {
        expectedPrompt: "Edited prompt",
        previousActiveBranchId: "branch-new",
      }),
    ).toBe(false);
  });

  it("rejects a changed branch with a different prompt", () => {
    expect(
      isCodexHistoryRewriteSnapshotReady(codexSession, {
        expectedPrompt: "Another edit",
        previousActiveBranchId: "branch-old",
      }),
    ).toBe(false);
  });
});

describe("mergeSessionMetadataChange", () => {
  it("ignores metadata events for another session", () => {
    const current = session({ aiTitle: "Existing AI title" });

    const result = mergeSessionMetadataChange(
      current,
      metadataEvent({ sessionId: "ses-other", aiTitle: "Wrong AI title" }),
      "ses-current",
    );

    expect(result).toBe(current);
  });

  it("adds an AI title without replacing the provider fallback", () => {
    const result = mergeSessionMetadataChange(
      session(),
      metadataEvent({ aiTitle: "DeepSeek title" }),
      "ses-current",
    );

    expect(result).toMatchObject({
      title: "Provider fallback",
      aiTitle: "DeepSeek title",
    });
    expect(getSessionDisplayTitle(result)).toBe("DeepSeek title");
  });

  it("keeps custom title above AI title and falls back to AI when custom is cleared", () => {
    const withAi = session({ aiTitle: "DeepSeek title" });
    const withCustom = mergeSessionMetadataChange(
      withAi,
      metadataEvent({ title: "Custom title" }),
      "ses-current",
    );

    expect(withCustom).toMatchObject({
      title: "Provider fallback",
      aiTitle: "DeepSeek title",
      customTitle: "Custom title",
    });
    expect(getSessionDisplayTitle(withCustom)).toBe("Custom title");

    const cleared = mergeSessionMetadataChange(
      withCustom,
      metadataEvent({ title: "  " }),
      "ses-current",
    );

    expect(cleared?.customTitle).toBeUndefined();
    expect(cleared?.aiTitle).toBe("DeepSeek title");
    expect(cleared?.title).toBe("Provider fallback");
    expect(getSessionDisplayTitle(cleared)).toBe("DeepSeek title");
  });
});

describe("shouldRefreshOpenCodeAuthoritativeSnapshot", () => {
  it("refreshes an owned OpenCode session once its turn becomes idle", () => {
    expect(
      shouldRefreshOpenCodeAuthoritativeSnapshot(
        "opencode",
        "self",
        "idle",
        "ses-current",
        "ses-current",
      ),
    ).toBe(true);
  });

  it.each([
    ["claude", "self", "idle", "ses-current"],
    ["opencode", "none", "idle", "ses-current"],
    ["opencode", "self", "in-turn", "ses-current"],
    ["opencode", "self", "idle", "ses-other"],
  ] as const)(
    "does not refresh for provider=%s owner=%s state=%s eventSession=%s",
    (provider, owner, state, eventSessionId) => {
      expect(
        shouldRefreshOpenCodeAuthoritativeSnapshot(
          provider,
          owner,
          state,
          eventSessionId,
          "ses-current",
        ),
      ).toBe(false);
    },
  );
});

describe("shouldRefreshFullPersistedSession", () => {
  it.each(["codex", "codex-oss", "opencode"] as const)(
    "reloads the authoritative window for %s in-place updates",
    (provider) => {
      expect(shouldRefreshFullPersistedSession(provider)).toBe(true);
    },
  );

  it.each(["claude", "gemini", undefined] as const)(
    "keeps incremental fetching for %s",
    (provider) => {
      expect(shouldRefreshFullPersistedSession(provider)).toBe(false);
    },
  );
});

describe("processStateFromProcessEvent", () => {
  it("treats explicit pending input as waiting even while a bridge reports in-turn", () => {
    expect(
      processStateFromProcessEvent({
        activity: "in-turn",
        pendingInputType: "tool-approval",
      }),
    ).toBe("waiting-input");
  });

  it("uses the reported activity when there is no pending input", () => {
    expect(processStateFromProcessEvent({ activity: "in-turn" })).toBe(
      "in-turn",
    );
  });
});

describe("sessionTurnHealthFromSession", () => {
  it("restores retry details from a REST session snapshot", () => {
    expect(
      sessionTurnHealthFromSession(
        session({
          retryStatus: {
            attempt: 3,
            message: "rate limited",
            next: 1_789_000_000_000,
          },
        }),
      ),
    ).toEqual({
      lastTurnStatus: undefined,
      lastErrorMessage: undefined,
      retryStatus: {
        attempt: 3,
        message: "rate limited",
        next: 1_789_000_000_000,
      },
    });
  });

  it("restores failures and clears sessions without health state", () => {
    expect(
      sessionTurnHealthFromSession(
        session({
          lastTurnStatus: "failed",
          lastErrorMessage: "provider unavailable",
        }),
      ),
    ).toMatchObject({
      lastTurnStatus: "failed",
      lastErrorMessage: "provider unavailable",
    });
    expect(sessionTurnHealthFromSession(session())).toBeNull();
  });
});
