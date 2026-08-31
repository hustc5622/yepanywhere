import { describe, expect, it } from "vitest";
import {
  CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE,
  type CodexEventEnvelope,
  createCanonicalCodexSessionState,
  reduceCodexEvent,
  reduceCodexEvents,
} from "../../src/codex-events/index.js";
import { testDraft, testEvent } from "./helpers.js";

describe("canonical Codex event reducer", () => {
  it("projects started/completed lifecycles for every ThreadItem variant", () => {
    const events = Object.keys(CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE).flatMap(
      (nativeType, index) => {
        const itemId = `item-${nativeType}`;
        return [
          testEvent(index * 2 + 1, "item/started", {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { id: itemId, type: nativeType },
            startedAtMs: 10 + index,
          }),
          testEvent(index * 2 + 2, "item/completed", {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { id: itemId, type: nativeType },
            completedAtMs: 20 + index,
          }),
        ];
      },
    );

    const state = reduceCodexEvents(
      createCanonicalCodexSessionState("session-1"),
      events,
    );
    const items = state.threads["thread-1"]?.turns["turn-1"]?.items;

    expect(Object.keys(items ?? {})).toHaveLength(
      Object.keys(CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE).length,
    );
    for (const [nativeType, kind] of Object.entries(
      CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE,
    )) {
      expect(items?.[`item-${nativeType}`]).toMatchObject({
        nativeType,
        kind,
        status: "completed",
        lateDeltaCount: 0,
      });
    }
  });

  it("merges a delta-before-start and rejects a delta-after-completion", () => {
    const events = [
      testEvent(1, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "agent-1",
        delta: "hel",
      }),
      testEvent(2, "item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "agent-1", type: "agentMessage", text: "" },
        startedAtMs: 10,
      }),
      testEvent(3, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "agent-1",
        delta: "lo",
      }),
      testEvent(4, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "agent-1", type: "agentMessage", text: "hello" },
        completedAtMs: 20,
      }),
      testEvent(5, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "agent-1",
        delta: "!",
      }),
    ];

    const state = reduceCodexEvents(
      createCanonicalCodexSessionState("session-1"),
      events,
    );
    const item = state.threads["thread-1"]?.turns["turn-1"]?.items["agent-1"];

    expect(item).toMatchObject({
      nativeType: "agentMessage",
      kind: "assistant_message",
      status: "completed",
      snapshot: { id: "agent-1", type: "agentMessage", text: "hello" },
      stream: { assistantText: "hello" },
      lateDeltaCount: 1,
    });
    expect(state.anomalies.map((anomaly) => anomaly.kind)).toContain(
      "late_delta",
    );
  });

  it("keeps indexed reasoning, command, patch, MCP, and safe terminal streams", () => {
    const events = [
      testEvent(1, "item/reasoning/summaryPartAdded", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 1,
      }),
      testEvent(2, "item/reasoning/summaryTextDelta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 1,
        delta: "summary",
      }),
      testEvent(3, "item/reasoning/textDelta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        contentIndex: 0,
        delta: "detail",
      }),
      testEvent(4, "item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        delta: "stdout",
      }),
      testEvent(5, "item/commandExecution/terminalInteraction", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        processId: "process-1",
        stdin: "secret-input",
      }),
      testEvent(6, "item/fileChange/patchUpdated", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-1",
        changes: [{ path: "a.ts", kind: "update", diff: "+x" }],
      }),
      testEvent(7, "item/mcpToolCall/progress", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "mcp-1",
        message: "working",
      }),
    ];
    const state = reduceCodexEvents(
      createCanonicalCodexSessionState("session-1"),
      events,
    );
    const items = state.threads["thread-1"]?.turns["turn-1"]?.items;

    expect(items?.["reasoning-1"]?.stream).toEqual({
      reasoningSummary: ["", "summary"],
      reasoningContent: ["detail"],
    });
    expect(items?.["command-1"]?.stream).toEqual({
      commandOutput: "stdout",
      terminalInteractions: [{ processId: "process-1" }],
    });
    expect(JSON.stringify(items?.["command-1"]?.stream)).not.toContain(
      "secret-input",
    );
    expect(items?.["patch-1"]?.stream.patchChanges).toEqual([
      { path: "a.ts", kind: "update", diff: "+x" },
    ]);
    expect(items?.["mcp-1"]?.stream.mcpProgress).toEqual(["working"]);
  });

  it("deduplicates by event id and dedupe key", () => {
    const initial = createCanonicalCodexSessionState("session-1");
    const firstEvent = testEvent(
      1,
      "warning",
      { message: "once" },
      { eventId: "same-event", dedupeKey: "same-operation" },
    );
    const first = reduceCodexEvent(initial, firstEvent);
    const duplicateId = reduceCodexEvent(first, {
      ...firstEvent,
      sequence: 2,
    });
    const duplicateKey = reduceCodexEvent(
      first,
      testEvent(
        3,
        "warning",
        { message: "again" },
        { eventId: "new-event", dedupeKey: "same-operation" },
      ),
    );

    expect(duplicateId).toBe(first);
    expect(duplicateKey).toBe(first);
    expect(first.notificationCounts.warning).toBe(1);
  });

  it("records an unknown notification instead of silently dropping it", () => {
    const event = testEvent(1, "future/item/delta", {
      opaque: { value: 1 },
    });
    const state = reduceCodexEvent(
      createCanonicalCodexSessionState("session-1"),
      event,
    );

    expect(state.observations).toHaveLength(1);
    expect(state.unknownEvents).toEqual([
      expect.objectContaining({
        method: "future/item/delta",
        compatibility: "newer_server",
        payload: event.payload,
      }),
    ]);
  });

  it("tracks server-request waiting and resolution without reopening terminal turns", () => {
    const events = [
      testEvent(1, "turn/started", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "inProgress",
          items: [],
          startedAt: 1,
        },
      }),
      testEvent(
        2,
        "item/tool/requestUserInput",
        { threadId: "thread-1", turnId: "turn-1", itemId: "question-1" },
        { direction: "server_request" },
      ),
      testEvent(3, "serverRequest/resolved", {
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: 9,
      }),
      testEvent(4, "turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [],
          completedAt: 2,
        },
      }),
      testEvent(
        5,
        "item/tool/requestUserInput",
        { threadId: "thread-1", turnId: "turn-1", itemId: "question-2" },
        { direction: "server_request" },
      ),
    ];

    const state = reduceCodexEvents(
      createCanonicalCodexSessionState("session-1"),
      events,
    );
    expect(state.threads["thread-1"]?.turns["turn-1"]?.status).toBe(
      "completed",
    );
  });

  it("returns the initial state for an empty event batch", () => {
    const initial = createCanonicalCodexSessionState("session-1");
    const state = reduceCodexEvents(initial, []);
    expect(state).toEqual(initial);
    expect(state.appliedEventIds).toHaveLength(0);
    expect(state.observations).toHaveLength(0);
  });

  it("records an out-of-order anomaly when sequence goes backwards", () => {
    // reduceCodexEvents sorts before applying, so out-of-order can only be
    // observed via the single-event path (reduceCodexEvent) where the caller
    // controls application order.
    const initial = createCanonicalCodexSessionState("session-1");
    const first = reduceCodexEvent(
      initial,
      testEvent(5, "turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 1 },
      }),
    );
    const state = reduceCodexEvent(
      first,
      testEvent(2, "turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [], completedAt: 2 },
      }),
    );
    expect(state.anomalies.map((a) => a.kind)).toContain("out_of_order");
    expect(state.lastSequence).toBe(5);
  });

  it("records a session_mismatch anomaly for a foreign session id", () => {
    const event = testEvent(1, "turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 1 },
    });
    const state = reduceCodexEvent(
      createCanonicalCodexSessionState("session-1"),
      { ...event, sessionId: "session-other" },
    );
    expect(state.anomalies.map((a) => a.kind)).toContain("session_mismatch");
    expect(state.threads).toEqual({});
  });

  it("projects multiple threads and turns independently", () => {
    const events = [
      testEvent(1, "turn/started", {
        threadId: "thread-a",
        turn: { id: "turn-a1", status: "inProgress", items: [], startedAt: 1 },
      }),
      testEvent(2, "turn/started", {
        threadId: "thread-b",
        turn: { id: "turn-b1", status: "inProgress", items: [], startedAt: 1 },
      }),
      testEvent(3, "turn/completed", {
        threadId: "thread-a",
        turn: { id: "turn-a1", status: "completed", items: [], completedAt: 2 },
      }),
    ];
    const state = reduceCodexEvents(
      createCanonicalCodexSessionState("session-1"),
      events,
    );
    expect(state.threadOrder).toEqual(["thread-a", "thread-b"]);
    expect(state.threads["thread-a"]?.turns["turn-a1"]?.status).toBe(
      "completed",
    );
    expect(state.threads["thread-b"]?.turns["turn-b1"]?.status).toBe(
      "in_progress",
    );
  });

  it("reduces a client retry and records its bounded retry status", () => {
    const event: CodexEventEnvelope = {
      ...testDraft(
        "item/tool/requestUserInput",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          retryStatus: {
            state: "retrying",
            category: "overloaded",
            retryable: true,
            attempt: 1,
            nextAttempt: 2,
            maxAttempts: 3,
            retryInMs: 500,
          },
        },
        {
          direction: "client_response",
          phase: "observed",
          requestId: 7,
          clientMessageId: "msg-1",
          correlationId: "client-retry:7",
        },
      ),
      persistedAtMs: 2_001,
      sequence: 1,
    };
    const state = reduceCodexEvents(
      createCanonicalCodexSessionState("session-1"),
      [event],
    );
    expect(state.clientRetries).toHaveLength(1);
    expect(state.clientRetries[0]).toMatchObject({
      state: "retrying",
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
    });
  });

  it("parity: reduceCodexEvent and reduceCodexEvents produce identical state", () => {
    const events = [
      testEvent(1, "turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 1 },
      }),
      testEvent(2, "item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "item-1", type: "agentMessage" },
        startedAtMs: 10,
      }),
      testEvent(3, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "hello",
      }),
      testEvent(4, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "item-1", type: "agentMessage", text: "hello" },
        completedAtMs: 20,
      }),
      testEvent(5, "turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [], completedAt: 2 },
      }),
    ];

    // Batch path
    const batchState = reduceCodexEvents(
      createCanonicalCodexSessionState("session-1"),
      events,
    );
    // Single-event path
    let singleState = createCanonicalCodexSessionState("session-1");
    for (const event of events) {
      singleState = reduceCodexEvent(singleState, event);
    }

    // Both paths must produce identical projection.
    expect(singleState.appliedEventIds).toEqual(batchState.appliedEventIds);
    expect(singleState.lastSequence).toBe(batchState.lastSequence);
    expect(singleState.anomalies).toEqual(batchState.anomalies);
    expect(singleState.observations).toEqual(batchState.observations);
    expect(singleState.clientRetries).toEqual(batchState.clientRetries);
    expect(singleState.unknownEvents).toEqual(batchState.unknownEvents);
    expect(JSON.stringify(singleState.threads)).toBe(
      JSON.stringify(batchState.threads),
    );
  });

  describe("thread/goal/updated", () => {
    it("stores the latest goal snapshot on the thread", () => {
      const events = [
        testEvent(1, "thread/goal/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            threadId: "thread-1",
            objective: "Ship the feature",
            status: "active",
            tokenBudget: 100000,
            tokensUsed: 500,
            timeUsedSeconds: 30,
            createdAt: 1000,
            updatedAt: 2000,
          },
        }),
        testEvent(2, "thread/goal/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            threadId: "thread-1",
            objective: "Ship the feature",
            status: "complete",
            tokenBudget: 100000,
            tokensUsed: 5000,
            timeUsedSeconds: 120,
            createdAt: 1000,
            updatedAt: 3000,
          },
        }),
      ];

      const state = reduceCodexEvents(
        createCanonicalCodexSessionState("session-1"),
        events,
      );
      const thread = state.threads["thread-1"];
      expect(thread?.goal).toMatchObject({
        objective: "Ship the feature",
        status: "complete",
        tokensUsed: 5000,
        timeUsedSeconds: 120,
      });
      expect(thread?.goalSequence).toBe(2);
      expect(thread?.goalUpdatedAtMs).toBeDefined();
    });

    it("records a missing_identity anomaly when goal payload is absent", () => {
      const events = [
        testEvent(1, "thread/goal/updated", {
          threadId: "thread-1",
        }),
      ];

      const state = reduceCodexEvents(
        createCanonicalCodexSessionState("session-1"),
        events,
      );
      expect(state.threads["thread-1"]?.goal).toBeUndefined();
      expect(state.anomalies).toHaveLength(1);
      expect(state.anomalies[0]?.kind).toBe("missing_identity");
    });
  });

  describe("thread/goal/cleared", () => {
    it("removes the goal from the thread", () => {
      const events = [
        testEvent(1, "thread/goal/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            threadId: "thread-1",
            objective: "Ship the feature",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1000,
            updatedAt: 2000,
          },
        }),
        testEvent(2, "thread/goal/cleared", {
          threadId: "thread-1",
        }),
      ];

      const state = reduceCodexEvents(
        createCanonicalCodexSessionState("session-1"),
        events,
      );
      expect(state.threads["thread-1"]?.goal).toBeUndefined();
      expect(state.threads["thread-1"]?.goalSequence).toBe(2);
    });
  });

  describe("turn/plan/updated", () => {
    it("stores the full plan payload including explanation", () => {
      const events = [
        testEvent(1, "turn/plan/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: "Breaking down the work",
          plan: [
            { step: "Read the file", status: "completed" },
            { step: "Write tests", status: "inProgress" },
            { step: "Run tests", status: "pending" },
          ],
        }),
      ];

      const state = reduceCodexEvents(
        createCanonicalCodexSessionState("session-1"),
        events,
      );
      const turn = state.threads["thread-1"]?.turns["turn-1"];
      expect(turn?.plan).toMatchObject({
        explanation: "Breaking down the work",
        plan: [
          { step: "Read the file", status: "completed" },
          { step: "Write tests", status: "inProgress" },
          { step: "Run tests", status: "pending" },
        ],
      });
      expect(turn?.planSequence).toBe(1);
    });

    it("overwrites the plan on subsequent updates", () => {
      const events = [
        testEvent(1, "turn/plan/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          plan: [{ step: "Step A", status: "pending" }],
        }),
        testEvent(2, "turn/plan/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          plan: [{ step: "Step A", status: "completed" }],
        }),
      ];

      const state = reduceCodexEvents(
        createCanonicalCodexSessionState("session-1"),
        events,
      );
      const plan = state.threads["thread-1"]?.turns["turn-1"]?.plan;
      expect(state.threads["thread-1"]?.turns["turn-1"]?.planSequence).toBe(2);
      const planArray = (plan as { plan?: unknown[] } | undefined)?.plan;
      expect(planArray?.[0]).toMatchObject({
        step: "Step A",
        status: "completed",
      });
    });
  });
});
