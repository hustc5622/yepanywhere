import type { CodexSessionEntry } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  CodexAgentWaitTracker,
  codexAgentWaitMessage,
} from "../../src/codex/agent-wait.js";
import { mergeCodexInterAgentMessages } from "../../src/codex/inter-agent-message.js";
import { SessionDisplayReducer } from "../../src/display/SessionDisplayReducer.js";
import { compactDisplayMessage } from "../../src/display/SessionDisplayService.js";
import { buildSessionDisplayProjection } from "../../src/sessions/display-projection.js";
import { convertCodexEntries } from "../../src/sessions/normalization.js";

const call = (id = "wait-1") => ({
  type: "response_item",
  timestamp: "2026-10-08T01:00:00.000Z",
  payload: {
    type: "function_call",
    name: "wait_agent",
    namespace: "collaboration",
    call_id: id,
    arguments: '{"timeout_ms":120000}',
    internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
  },
});
const native = (id = "wait-1") => ({
  type: "event_msg",
  timestamp: "2026-10-08T01:00:03.030Z",
  payload: {
    type: "item_completed",
    turn_id: "turn-1",
    started_at_ms: Date.parse("2026-10-08T01:00:00.020Z"),
    completed_at_ms: Date.parse("2026-10-08T01:00:03.020Z"),
    item: {
      type: "CollabAgentToolCall",
      id,
      tool: "wait",
      status: "completed",
      sender_thread_id: "parent",
      receiver_thread_ids: [],
      agents_states: {},
    },
  },
});
const output = (
  message = "Wait completed.",
  timedOut = false,
  id = "wait-1",
) => ({
  type: "response_item",
  timestamp: "2026-10-08T01:00:03.100Z",
  payload: {
    type: "function_call_output",
    call_id: id,
    output: JSON.stringify({ message, timed_out: timedOut }),
    internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
  },
});

describe("Codex mailbox wait projection", () => {
  it("leaves unrelated wait tools in their provider namespace", () => {
    const tracker = new CodexAgentWaitTracker();
    const entry = call();
    for (const [name, namespace] of [
      ["wait_agent", "mcp"],
      ["mcp.wait_agent", undefined],
      ["wait", "functions"],
      ["functions.wait", undefined],
    ]) {
      expect(
        tracker.observe({
          ...entry,
          payload: { ...entry.payload, name, namespace },
        }),
      ).toBeNull();
    }
    expect(tracker.values()).toHaveLength(0);
  });
  it("combines one call, native lifecycle, and output using actual three-second timing", () => {
    const messages = convertCodexEntries(
      [call(), native(), output()] as CodexSessionEntry[],
      "parent",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.codexThreadItem).toEqual({
      type: "agentWait",
      id: "wait-1",
      status: "completed",
      startedAt: "2026-10-08T01:00:00.020Z",
      completedAt: "2026-10-08T01:00:03.020Z",
      durationMs: 3000,
      outcome: "message",
    });
    const compact = compactDisplayMessage(messages[0] ?? {});
    const projection = buildSessionDisplayProjection({
      sessionId: "parent",
      revision: "revision",
      messages: [compact],
      questionCoverage: "complete",
    });
    expect(projection.page.turns[0]?.segments[0]).toMatchObject({
      kind: "agent_wait",
      agentWait: { durationMs: 3000, outcome: "message" },
    });
  });

  it.each([
    ["Wait timed out.", true, "timeout", "completed"],
    ["Wait interrupted by new input.", false, "user_input", "interrupted"],
  ] as const)("distinguishes %s", (message, timedOut, outcome, status) => {
    const tracker = new CodexAgentWaitTracker();
    tracker.observe(call());
    tracker.observe(output(message, timedOut));
    // A delayed native completed event cannot erase the wake reason.
    tracker.observe(native());
    expect(tracker.values()[0]?.item).toMatchObject({ outcome, status });
  });

  it("keeps two real calls and does not create timing from an absent history timestamp", () => {
    const tracker = new CodexAgentWaitTracker();
    const first = native();
    tracker.observe({
      ...first,
      timestamp: undefined,
      payload: {
        ...first.payload,
        started_at_ms: undefined,
        completed_at_ms: undefined,
      },
    });
    tracker.observe({ ...call("wait-2"), timestamp: undefined });
    expect(tracker.values().map((wait) => wait.item)).toEqual([
      {
        type: "agentWait",
        id: "wait-1",
        status: "completed",
        outcome: "unknown",
      },
      { type: "agentWait", id: "wait-2", status: "running" },
    ]);
  });

  it("stops an interrupted wait without fabricating an exact return time", () => {
    const tracker = new CodexAgentWaitTracker();
    tracker.observe(call());
    tracker.observe({
      type: "event_msg",
      timestamp: "2026-10-08T01:00:07.000Z",
      payload: { type: "turn_aborted", turn_id: "turn-1" },
    });
    expect(tracker.values()[0]?.item).toEqual({
      type: "agentWait",
      id: "wait-1",
      status: "interrupted",
      startedAt: "2026-10-08T01:00:00.000Z",
      outcome: "unknown",
    });
  });

  it("enriches canonical native waits in place and does not repeat their tool row", () => {
    const tracker = new CodexAgentWaitTracker();
    for (const entry of [call(), native(), output()]) tracker.observe(entry);
    const snapshot = tracker.values()[0];
    if (!snapshot) throw new Error("missing wait");
    const finished = codexAgentWaitMessage(snapshot, "parent");
    const initial = {
      ...finished,
      codexThreadItem: {
        type: "agentWait",
        id: "wait-1",
        status: "completed",
        outcome: "unknown",
      },
    };
    const merged = mergeCodexInterAgentMessages(
      [initial],
      [{ message: finished, updateOnly: true }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.codexThreadItem).toMatchObject({
      durationMs: 3000,
      outcome: "message",
    });
    const rawTool = {
      type: "assistant",
      uuid: "raw-call",
      codexTurnId: "turn-1",
      content: [
        {
          type: "tool_use",
          id: "wait-1",
          name: "collaboration.wait_agent",
          input: { timeout_ms: 120000 },
        },
      ],
    };
    const projection = buildSessionDisplayProjection({
      sessionId: "parent",
      revision: "revision",
      messages: [rawTool, ...merged],
      questionCoverage: "complete",
    });
    expect(projection.page.turns[0]?.segments).toHaveLength(1);
    const reducer = new SessionDisplayReducer(
      { sessionId: "parent", branchScopeId: "active", epoch: "epoch" },
      "codex",
    );
    reducer.restore([rawTool, ...merged]);
    expect(reducer.snapshot().nodes).toHaveLength(1);
  });
});
