import { describe, expect, it } from "vitest";
import {
  CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE,
  createCanonicalCodexSessionState,
  reduceCodexEvent,
  reduceCodexEvents,
} from "../../src/codex-events/index.js";
import { testEvent } from "./helpers.js";

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

    expect(Object.keys(items ?? {})).toHaveLength(18);
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
});
