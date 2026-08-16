import { getSessionDisplayTitle } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { SessionMetadataChangedEvent } from "../../lib/activityBus";
import { extractSessionIdFromFileEvent } from "../../lib/sessionFile";
import type { Message, Session } from "../../types";
import {
  type PendingMessage,
  buildAgentMappingLoadPlan,
  extractKimiAgentIdFromFileEvent,
  hasUnresolvedKimiAgentMappings,
  isCodexHistoryRewriteSnapshotReady,
  isKimiAuthoritativeSnapshotReady,
  isToolUseOnlyAssistantMessage,
  mergeSessionMetadataChange,
  processStateFromProcessEvent,
  reconcilePendingMessagesWithConfirmedMessages,
  sessionTurnHealthFromSession,
  shouldDeferKimiPersistedSync,
  shouldFetchSessionMetadataForUpdate,
  shouldRefreshFullPersistedSession,
  shouldRefreshSettledAuthoritativeSnapshot,
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

describe("shouldRefreshSettledAuthoritativeSnapshot", () => {
  it.each(["opencode", "pi", "kimi"] as const)(
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
    ["opencode", "none", "idle", "ses-current"],
    ["opencode", "self", "in-turn", "ses-current"],
    ["opencode", "self", "idle", "ses-other"],
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

describe("shouldDeferKimiPersistedSync", () => {
  it.each(["in-turn", "waiting-input", "hold", undefined] as const)(
    "defers an owned Kimi snapshot while state=%s",
    (state) => {
      expect(shouldDeferKimiPersistedSync("kimi", "self", state)).toBe(true);
    },
  );

  it.each([
    ["kimi", "self", "idle"],
    ["kimi", "none", "in-turn"],
    ["opencode", "self", "in-turn"],
  ] as const)(
    "does not defer provider=%s owner=%s state=%s",
    (provider, owner, state) => {
      expect(shouldDeferKimiPersistedSync(provider, owner, state)).toBe(false);
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

  it("makes pending Kimi calls eligible (provisional ids) and keeps completed ones", () => {
    // Pending calls are eligible: the server assigns provisional child ids
    // from the on-disk agents/ directory so live activity can be shown.
    const pendingPlan = buildAgentMappingLoadPlan(
      [swarmToolUse],
      "kimi",
      "session-1",
    );
    expect(pendingPlan?.tasks).toEqual([
      expect.objectContaining({
        toolUseId: "AgentSwarm_0",
        resultCount: 0,
        expectedAgentCount: 2,
      }),
    ]);

    const completedPlan = buildAgentMappingLoadPlan(
      [swarmToolUse, swarmResult],
      "kimi",
      "session-1",
    );
    expect(completedPlan?.tasks).toEqual([
      expect.objectContaining({
        toolUseId: "AgentSwarm_0",
        resultCount: 1,
      }),
    ]);
  });

  it("advances the Kimi load key when another result for the call lands", () => {
    const firstPlan = buildAgentMappingLoadPlan(
      [swarmToolUse, swarmResult],
      "kimi",
      "session-1",
    );
    const secondPlan = buildAgentMappingLoadPlan(
      [
        swarmToolUse,
        swarmResult,
        {
          ...swarmResult,
          id: "user-swarm-result-2",
        },
      ],
      "kimi",
      "session-1",
    );

    expect(firstPlan?.loadKey).not.toBe(secondPlan?.loadKey);
    expect(secondPlan?.tasks[0]?.resultCount).toBe(2);
  });

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

describe("hasUnresolvedKimiAgentMappings", () => {
  const swarmTask = {
    toolUseId: "AgentSwarm_0",
    description: "inspect",
    subagentType: "explore",
    resultCount: 0,
    expectedAgentCount: 2,
  };

  it("keeps a pending swarm unresolved until every declared child is mapped", () => {
    expect(
      hasUnresolvedKimiAgentMappings(
        [swarmTask],
        new Map([["AgentSwarm_0", ["agent-0"]]]),
      ),
    ).toBe(true);
    expect(
      hasUnresolvedKimiAgentMappings(
        [swarmTask],
        new Map([["AgentSwarm_0", ["agent-0", "agent-1"]]]),
      ),
    ).toBe(false);
  });

  it("does not retry completed calls", () => {
    expect(
      hasUnresolvedKimiAgentMappings(
        [{ ...swarmTask, resultCount: 1 }],
        new Map(),
      ),
    ).toBe(false);
  });
});

describe("isKimiAuthoritativeSnapshotReady", () => {
  const assistantMessage = (uuid: string, content: string): Message => ({
    type: "assistant",
    uuid,
    message: { role: "assistant", content },
  });

  const current = [
    userMessage({
      uuid: "persisted-user-0",
      message: { role: "user", content: "first question" },
    }),
    assistantMessage("persisted-assistant-0", "first answer"),
    userMessage({
      uuid: "live-user-1",
      message: { role: "user", content: "second question" },
    }),
    assistantMessage("live-assistant-1", "second answer"),
  ];

  it("rejects a wire snapshot that has not persisted the latest prompt", () => {
    expect(isKimiAuthoritativeSnapshotReady(current, current.slice(0, 2))).toBe(
      false,
    );
  });

  it("rejects a wire snapshot missing the current turn's final output", () => {
    expect(
      isKimiAuthoritativeSnapshotReady(current, [
        ...current.slice(0, 2),
        userMessage({
          uuid: "session-user-1",
          message: { role: "user", content: "second question" },
        }),
      ]),
    ).toBe(false);
  });

  it("accepts the complete persisted turn despite different message ids", () => {
    expect(
      isKimiAuthoritativeSnapshotReady(current, [
        ...current.slice(0, 2),
        userMessage({
          uuid: "session-user-1",
          message: { role: "user", content: "second question" },
        }),
        assistantMessage("session-assistant-1", "second answer"),
      ]),
    ).toBe(true);
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

  it("extracts Kimi's session directory instead of the wire.jsonl basename", () => {
    expect(
      extractSessionIdFromFileEvent({
        provider: "kimi",
        relativePath:
          "wd_example/session_186997d7-2289-4e62-993c-c97c703ded86/agents/main/wire.jsonl",
      }),
    ).toBe("session_186997d7-2289-4e62-993c-c97c703ded86");
  });
});

describe("extractKimiAgentIdFromFileEvent", () => {
  it("extracts child ids from Kimi agent wire paths", () => {
    expect(
      extractKimiAgentIdFromFileEvent({
        provider: "kimi",
        relativePath: "wd_example/session_123/agents/agent-6/wire.jsonl",
      }),
    ).toBe("agent-6");
  });

  it("ignores the main Kimi wire and other providers", () => {
    expect(
      extractKimiAgentIdFromFileEvent({
        provider: "kimi",
        relativePath: "wd_example/session_123/agents/main/wire.jsonl",
      }),
    ).toBeNull();
    expect(
      extractKimiAgentIdFromFileEvent({
        provider: "claude",
        relativePath: "projects/example/agent-6.jsonl",
      }),
    ).toBeNull();
  });
});

describe("shouldFetchSessionMetadataForUpdate", () => {
  it("fetches only while the initial session snapshot is absent", () => {
    expect(shouldFetchSessionMetadataForUpdate(null)).toBe(true);
    expect(shouldFetchSessionMetadataForUpdate(session())).toBe(false);
  });
});

describe("shouldRefreshFullPersistedSession", () => {
  it.each(["codex", "codex-oss", "opencode", "pi", "kimi"] as const)(
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
