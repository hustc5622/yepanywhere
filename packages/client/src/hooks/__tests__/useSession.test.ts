import { getSessionDisplayTitle } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { SessionMetadataChangedEvent } from "../../lib/activityBus";
import { extractSessionIdFromFileEvent } from "../../lib/sessionFile";
import type { Message, Session } from "../../types";
import {
  type PendingMessage,
  buildAgentMappingLoadPlan,
  isCodexHistoryRewriteSnapshotReady,
  isToolUseOnlyAssistantMessage,
  mergeSessionMetadataChange,
  processStateFromProcessEvent,
  reconcilePendingMessagesWithConfirmedMessages,
  sessionTurnHealthFromSession,
  shouldDeferUncorrelatedPersistedSync,
  shouldFetchSessionMetadataForUpdate,
  shouldForceOwnedPersistedDisplayRefresh,
  shouldRefreshFullPersistedSession,
  shouldRefreshSettledAuthoritativeSnapshot,
  shouldWatchOwnedSessionFile,
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
    provider: "pi",
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

describe("shouldRefreshSettledAuthoritativeSnapshot", () => {
  it.each(["pi", "mcode"] as const)(
    "refreshes an owned %s session once its turn becomes idle",
    (provider) => {
      expect(
        shouldRefreshSettledAuthoritativeSnapshot(
          provider,
          "self",
          "idle",
          "ses-current",
          "ses-current",
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["claude", "self", "idle", "ses-current"],
    ["pi", "none", "idle", "ses-current"],
    ["pi", "self", "in-turn", "ses-current"],
    ["pi", "self", "idle", "ses-other"],
  ] as const)(
    "does not refresh for provider=%s owner=%s state=%s eventSession=%s",
    (provider, owner, state, eventSessionId) => {
      expect(
        shouldRefreshSettledAuthoritativeSnapshot(
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

describe("shouldDeferUncorrelatedPersistedSync", () => {
  it.each(["pi", "mcode"] as const)(
    "defers an owned %s snapshot until the turn is idle",
    (provider) => {
      for (const state of [
        "in-turn",
        "waiting-input",
        "hold",
        undefined,
      ] as const) {
        expect(
          shouldDeferUncorrelatedPersistedSync(provider, "self", state),
        ).toBe(true);
      }
    },
  );

  it.each([
    ["mcode", "self", "idle"],
    ["pi", "self", "idle"],
    ["mcode", "none", "in-turn"],
    ["pi", "external", "in-turn"],
    ["claude", "self", "in-turn"],
  ] as const)(
    "does not defer provider=%s owner=%s state=%s",
    (provider, owner, state) => {
      expect(shouldDeferUncorrelatedPersistedSync(provider, owner, state)).toBe(
        false,
      );
    },
  );
});

describe("shouldForceOwnedPersistedDisplayRefresh", () => {
  it.each(["pi", "mcode"] as const)(
    "forces the display refresh for an owned %s session",
    (provider) => {
      expect(
        shouldForceOwnedPersistedDisplayRefresh(provider, "self", true),
      ).toBe(true);
    },
  );

  it.each([
    // Legacy message mode has no display guard to force past.
    ["pi", "self", false],
    // Non-owned sessions already pass the display guard unforced.
    ["pi", "none", true],
    ["pi", "external", true],
    // Other providers can correlate persisted ids and must not be replaced.
    ["codex", "self", true],
    ["claude", "self", true],
  ] as const)(
    "does not force provider=%s owner=%s displayPage=%s",
    (provider, owner, hasDisplayPage) => {
      expect(
        shouldForceOwnedPersistedDisplayRefresh(
          provider,
          owner,
          hasDisplayPage,
        ),
      ).toBe(false);
    },
  );
});

describe("shouldWatchOwnedSessionFile", () => {
  it.each(["pi", "mcode"] as const)(
    "keeps the focused watch for owned %s sessions",
    (provider) => {
      expect(shouldWatchOwnedSessionFile(provider)).toBe(true);
    },
  );

  it.each(["claude", "codex", "codex-oss", "gemini", undefined] as const)(
    "leaves owned %s sessions on their live stream",
    (provider) => {
      expect(shouldWatchOwnedSessionFile(provider)).toBe(false);
    },
  );
});

describe("buildAgentMappingLoadPlan", () => {
  const swarmToolUse: Message = {
    id: "assistant-swarm",
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "AgentSwarm_0",
          name: "AgentSwarm",
          input: {
            description: "inspect in parallel",
            subagent_type: "explore",
            items: ["frontend", "backend"],
            prompt_template: "inspect {{item}}",
          },
        },
      ],
    },
  };
  const swarmResult: Message = {
    id: "user-swarm-result",
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "AgentSwarm_0",
          content:
            '<agent_swarm_result><subagent agent_id="agent-0" outcome="completed"/><subagent agent_id="agent-1" outcome="completed"/></agent_swarm_result>',
        },
      ],
    },
  };

  it("preserves pending-only mapping restoration for other providers", () => {
    expect(
      buildAgentMappingLoadPlan([swarmToolUse], "claude", "session-1")?.tasks,
    ).toHaveLength(1);
    expect(
      buildAgentMappingLoadPlan(
        [swarmToolUse, swarmResult],
        "claude",
        "session-1",
      ),
    ).toBeNull();
  });
});

describe("extractSessionIdFromFileEvent", () => {
  it("extracts Pi's native id from its timestamped JSONL filename", () => {
    expect(
      extractSessionIdFromFileEvent({
        provider: "pi",
        relativePath:
          "--Users-yue-project--/2026-08-15T01-02-03-000Z_186997d7-2289-4e62-993c-c97c703ded86.jsonl",
      }),
    ).toBe("186997d7-2289-4e62-993c-c97c703ded86");
  });

  it("decodes MiniMax Code's base64url session directory", () => {
    expect(
      extractSessionIdFromFileEvent({
        provider: "mcode",
        relativePath:
          "2026/10/20/12-16-57-980-session_bXZzXzA4NDE1OTg0YzNjOTRjOWY4NDc4MWNkY2YzYzQzNDZm/messages.jsonl",
      }),
    ).toBe("mvs_08415984c3c94c9f84781cdcf3c4346f");
  });

  it("uses the session directory for DeepSeek Harness logs", () => {
    expect(
      extractSessionIdFromFileEvent({
        provider: "dsh",
        relativePath:
          "--Users-me-work--/session-846eb2c2-c340-433c-ab4e-508ba45ba257/session.v4.jsonl.zstd",
      }),
    ).toBe("session-846eb2c2-c340-433c-ab4e-508ba45ba257");
  });
});

describe("shouldFetchSessionMetadataForUpdate", () => {
  it("fetches only while the initial session snapshot is absent", () => {
    expect(shouldFetchSessionMetadataForUpdate(null)).toBe(true);
    expect(shouldFetchSessionMetadataForUpdate(session())).toBe(false);
  });
});

describe("shouldRefreshFullPersistedSession", () => {
  it.each(["codex", "codex-oss", "pi", "mcode"] as const)(
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

describe("isToolUseOnlyAssistantMessage", () => {
  it("is true when every content block is a tool_use", () => {
    expect(
      isToolUseOnlyAssistantMessage({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "Bash" }],
        },
      }),
    ).toBe(true);
  });

  it("is false when the message also carries text", () => {
    expect(
      isToolUseOnlyAssistantMessage({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Deciding to improve the design" },
            { type: "tool_use", id: "call_1", name: "Bash" },
          ],
        },
      }),
    ).toBe(false);
  });

  it("is false for string content, empty content, and flushed text messages", () => {
    expect(
      isToolUseOnlyAssistantMessage({
        type: "assistant",
        message: { role: "assistant", content: "just text" },
      }),
    ).toBe(false);
    expect(
      isToolUseOnlyAssistantMessage({
        type: "assistant",
        message: { role: "assistant", content: [] },
      }),
    ).toBe(false);
    expect(
      isToolUseOnlyAssistantMessage({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hmm" }],
        },
      }),
    ).toBe(false);
  });
});
