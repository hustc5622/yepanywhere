import {
  type SessionDisplaySnapshot,
  SessionDisplaySnapshotSchema,
  applySessionDisplayPatch,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  SessionDisplayReducer,
  displayToolId,
} from "../../src/display/SessionDisplayReducer.js";
import { compactDisplayMessage } from "../../src/display/SessionDisplayService.js";
import type { Message } from "../../src/supervisor/types.js";
const view = { sessionId: "session", branchScopeId: "active", epoch: "epoch" };
const prompt = {
  uuid: "user",
  type: "user",
  codexTurnId: "turn",
  message: { role: "user", content: "Run checks" },
};
const tool = (id: string) => ({
  uuid: `${id}-turn`,
  type: "assistant",
  codexTurnId: "turn",
  message: {
    role: "assistant",
    content: [
      { type: "tool_use", id, name: "Bash", input: { command: "pnpm test" } },
    ],
  },
});
const result = (id: string, text = "passed") => ({
  uuid: `${id}-result`,
  type: "user",
  codexTurnId: "turn",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: text }],
  },
});
const reply = (id: string, text: string, phase = "commentary") => ({
  uuid: `${id}-turn`,
  type: "assistant",
  codexTurnId: "turn",
  codexCorrelationKey: `codex:turn:agent-message:${id}`,
  codexMessagePhase: phase,
  message: { role: "assistant", content: text },
});
const terminal = {
  uuid: "terminal",
  type: "system",
  subtype: "turn_complete",
  codexTurnId: "turn",
  turnStatus: "completed",
};
const groups = (snapshot: SessionDisplaySnapshot) =>
  snapshot.nodes.flatMap((node) =>
    node.type === "segment" && node.segment.type === "tool_group"
      ? [node.segment]
      : [],
  );
function facts(snapshot: SessionDisplaySnapshot) {
  return JSON.parse(
    JSON.stringify({ ...snapshot, seq: 0 }, (key, value) =>
      key === "version" ? undefined : value,
    ),
  );
}
describe("SessionDisplayReducer", () => {
  it.each(["completed", "failed", "interrupted"])(
    "projects compaction progress and clears it on %s",
    (outcome) => {
      const model = new SessionDisplayReducer(view, "codex");
      model.message(prompt);
      const progress = compactDisplayMessage({
        type: "system",
        subtype: "status",
        status: "compacting",
        uuid: "compact-turn",
        codexTurnId: "turn",
      });
      model.message(progress);
      expect(model.snapshot().activity).toMatchObject({
        state: "running",
        isCompacting: true,
      });
      expect(
        SessionDisplaySnapshotSchema.safeParse(model.snapshot()).success,
      ).toBe(true);
      const replay = new SessionDisplayReducer(view, "codex");
      replay.restore([prompt, progress] as Message[]);
      expect(replay.snapshot().activity.isCompacting).toBe(true);
      if (outcome === "completed") {
        model.message({
          type: "system",
          subtype: "compact_boundary",
          uuid: "compact-turn",
          codexTurnId: "turn",
          content: "Context compacted",
        });
        expect(model.snapshot().activity.isCompacting).not.toBe(true);
        expect(model.snapshot().nodes).toContainEqual(
          expect.objectContaining({
            type: "segment",
            segment: expect.objectContaining({
              type: "notice",
              kind: "compaction",
            }),
          }),
        );
      }
      model.message({ ...terminal, turnStatus: outcome });
      model.message({
        type: "result",
        codexTurnId: "turn",
        turnStatus: outcome,
        is_error: outcome === "failed",
      });
      expect(model.snapshot().activity).toMatchObject({ state: outcome });
      expect(model.snapshot().activity.isCompacting).not.toBe(true);
    },
  );

  it("keeps async questions running across replay and allows later tools", () => {
    const question = {
      ...reply("question", "Which address?", "final_answer"),
      codexAsyncMessage: {
        delivery: "async" as const,
        questions: [
          { title: "Which address?", options: ["Production", "Local"] },
        ],
      },
    };
    const model = new SessionDisplayReducer(view, "codex");
    model.setRuntime("running");
    model.message(prompt);
    model.message(question);
    model.setRuntime("running");
    expect(model.snapshot().activity.state).toBe("running");
    expect(model.snapshot().nodes.at(-1)).toMatchObject({
      segment: {
        type: "assistant_text",
        phase: "text",
        asyncMessage: question.codexAsyncMessage,
      },
    });
    expect(
      SessionDisplaySnapshotSchema.safeParse(model.snapshot()).success,
    ).toBe(true);
    const replay = new SessionDisplayReducer(view, "codex");
    replay.restore([prompt, compactDisplayMessage(question)] as Message[]);
    replay.setRuntime("running");
    expect(replay.snapshot().activity.state).toBe("running");
    model.message(tool("after-question"));
    model.message(result("after-question"));
    expect(groups(model.snapshot())).toHaveLength(1);
    model.message(reply("final", "Finished", "final_answer"));
    expect(model.snapshot().activity.state).toBe("finishing");
    model.message(terminal);
    expect(model.snapshot().activity.state).toBe("completed");
  });

  it("preserves text on both sides of a tool across live updates, replay and cold reads", () => {
    const model = new SessionDisplayReducer(view, "claude");
    const message: Message = {
      uuid: "multi-block",
      type: "assistant",
      message: {
        id: "native-message",
        role: "assistant",
        content: [
          { type: "text", text: "Before the tool" },
          {
            type: "tool_use",
            id: "check",
            name: "Bash",
            input: { command: "pwd" },
          },
          { type: "text", text: "After the tool" },
        ],
      },
    };
    model.message({ ...message, _isStreaming: true });
    model.message(message);
    const snapshot = model.snapshot();
    expect(
      snapshot.nodes.map((node) =>
        node.type === "segment" && node.segment.type === "assistant_text"
          ? node.segment.content
          : "tool",
      ),
    ).toEqual(["Before the tool", "tool", "After the tool"]);
    expect(new Set(snapshot.nodes.map((node) => node.id)).size).toBe(3);
    expect(groups(snapshot)[0]?.displayMode).toBe("summary");
    model.message({ ...message, isReplay: true });
    expect(model.snapshot().nodes).toEqual(snapshot.nodes);
    const cold = new SessionDisplayReducer(view, "claude");
    cold.restore([message]);
    expect(cold.snapshot().nodes).toEqual(snapshot.nodes);
  });

  it("keeps indexed text deltas separate and reconciles them with the final message", () => {
    const model = new SessionDisplayReducer(view, "claude");
    model.message({
      type: "stream_event",
      event: { type: "message_start", message: { id: "native-message" } },
    });
    for (const [index, text] of [
      [0, "First"],
      [1, "Second"],
    ] as const) {
      model.message({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text },
        },
      });
    }
    const before = model.snapshot();
    model.message({
      uuid: "persisted-message",
      type: "assistant",
      message: {
        id: "native-message",
        role: "assistant",
        content: [
          { type: "text", text: "First complete" },
          { type: "text", text: "Second complete" },
        ],
      },
    });
    expect(model.snapshot().nodes.map((node) => node.id)).toEqual(
      before.nodes.map((node) => node.id),
    );
    expect(
      model
        .snapshot()
        .nodes.flatMap((node) =>
          node.type === "segment" && node.segment.type === "assistant_text"
            ? [node.segment.content]
            : [],
        ),
    ).toEqual(["First complete", "Second complete"]);
  });

  it("does not reopen a completed run for a repeated tool lifecycle update", () => {
    const model = new SessionDisplayReducer(view, "codex");
    for (const event of [prompt, tool("a"), result("a"), terminal])
      model.message(event);
    model.message(tool("a"));
    expect(model.snapshot().activity.state).toBe("completed");
    expect(groups(model.snapshot())[0]?.displayMode).toBe("summary");
  });
  it("keeps completed latest steps until a committed readable reply, then keeps accepting same-turn tools", () => {
    const model = new SessionDisplayReducer(view, "codex");
    model.setRuntime("running");
    for (const event of [prompt, tool("a"), result("a")]) model.message(event);
    const id = required(groups(model.snapshot())[0]).id;
    expect(groups(model.snapshot())[0]).toMatchObject({
      displayMode: "steps",
      count: 1,
    });
    model.message({ ...reply("progress", "First step"), _isStreaming: true });
    expect(required(groups(model.snapshot())[0]).displayMode).toBe("steps");
    const before = model.snapshot();
    model.message(reply("progress", "First step complete"));
    const patch = required(model.commit(before));
    const applied = required(applySessionDisplayPatch(before, patch));
    expect(groups(applied)[0]).toMatchObject({ id, displayMode: "summary" });
    expect(required(groups(applied)[0]).steps).toBeUndefined();
    expect(required(groups(applied)[0]).toolNames).toEqual([]);
    model.message(tool("b"));
    expect(
      groups(model.snapshot()).map((g) => [g.displayMode, g.count]),
    ).toEqual([
      ["summary", 1],
      ["steps", 1],
    ]);
    expect(model.snapshot().activity.state).toBe("running");
  });
  it("keeps a cross-boundary running tool visible without recounting it", () => {
    const model = new SessionDisplayReducer(view, "codex");
    for (const event of [
      prompt,
      tool("slow"),
      reply("progress", "Still checking"),
      tool("next"),
    ])
      model.message(event);
    const snapshot = model.snapshot();
    expect(groups(snapshot)[0]).toMatchObject({
      count: 1,
      runningCount: 1,
      displayMode: "summary",
    });
    expect(snapshot.activity.tools.map((t) => t.id)).toEqual([
      displayToolId("turn", "slow"),
    ]);
    model.message(result("slow"));
    expect(model.snapshot().activity.tools).toEqual([]);
    expect(required(groups(model.snapshot())[0]).count).toBe(1);
  });
  it("reconstructs the same facts at every entry point and deduplicates replay", () => {
    const events = [
      prompt,
      tool("a"),
      result("a"),
      reply("p1", "Continue"),
      tool("b"),
      reply("p2", "Almost done"),
      result("b"),
      tool("c"),
      result("c"),
      reply("final", "Done", "final_answer"),
      terminal,
    ];
    const uninterrupted = new SessionDisplayReducer(view, "codex");
    uninterrupted.setRuntime("running");
    for (const event of events) uninterrupted.message(event);
    for (let cut = 0; cut <= events.length; cut++) {
      const reopened = new SessionDisplayReducer(view, "codex");
      reopened.setRuntime("running");
      reopened.restore(events.slice(0, cut) as Message[]);
      for (const event of events.slice(cut)) reopened.message(event);
      expect(facts(reopened.snapshot()), `entry at ${cut}`).toEqual(
        facts(uninterrupted.snapshot()),
      );
      const beforeReplay = reopened.snapshot();
      for (const event of events)
        reopened.message({ ...event, isReplay: true });
      expect(facts(reopened.snapshot())).toEqual(facts(beforeReplay));
    }
  });
  it("uses the same native text identity for delta, committed text and a cold snapshot", () => {
    const model = new SessionDisplayReducer(view, "codex");
    model.message(prompt);
    model.message({
      uuid: "p-turn",
      type: "stream_event",
      codexTurnId: "turn",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
    });
    const textId = required(model.snapshot().nodes.at(-1)).id;
    model.message(reply("p", "Hello world"));
    expect(required(model.snapshot().nodes.at(-1)).id).toBe(textId);
    const cold = new SessionDisplayReducer(view, "codex");
    cold.restore([prompt, reply("p", "Hello world")] as Message[]);
    expect(required(cold.snapshot().nodes.at(-1)).id).toBe(textId);
    expect(model.snapshot().nodes).toHaveLength(2);
  });
  it.each(["completed", "interrupted", "failed"] as const)(
    "closes a tool-only turn on a real %s terminal",
    (status) => {
      const model = new SessionDisplayReducer(view, "codex");
      for (const event of [
        prompt,
        tool("a"),
        { ...terminal, turnStatus: status },
      ])
        model.message(event);
      expect(required(groups(model.snapshot())[0]).displayMode).toBe("summary");
      expect(model.snapshot().activity.state).toBe(status);
      expect(model.snapshot().activity.runningCount).toBe(0);
    },
  );
  it("keeps the newest 50 tool indexes output-free", () => {
    const model = new SessionDisplayReducer(view, "codex");
    model.message(prompt);
    for (let i = 0; i < 201; i++) {
      model.message(tool(`a${i}`));
      model.message(result(`a${i}`, "x".repeat(20000)));
    }
    const snapshot = SessionDisplaySnapshotSchema.parse(model.snapshot());
    const group = required(groups(snapshot)[0]);
    expect(group.count).toBe(201);
    expect(group.steps).toHaveLength(50);
    expect(required(required(group.steps)[0]).id).toBe(
      displayToolId("turn", "a151"),
    );
    expect(required(required(group.steps)[0])).toMatchObject({
      summary: "pnpm test",
      preview: "",
    });
    const id = group.id;
    model.message(reply("progress", "Batch complete"));
    expect(required(groups(model.snapshot())[0]).id).toBe(id);
    expect(JSON.stringify(model.snapshot())).not.toContain("xxx");
  });
  it("does not confuse an append with an invalid detail identity", () => {
    const model = new SessionDisplayReducer(view, "codex");
    for (const event of [
      prompt,
      tool("a"),
      result("a"),
      reply("p", "Continue"),
    ])
      model.message(event);
    const groupId = required(groups(model.snapshot())[0]).id;
    for (const event of [tool("b"), result("b"), reply("p2", "More")])
      model.message(event);
    expect(model.groupSteps(groupId)).toHaveLength(1);
    expect(required(required(model.groupSteps(groupId))[0]).id).toBe(
      displayToolId("turn", "a"),
    );
  });
  it("stamps a start time on live steps and never invents one on replay", () => {
    const live = new SessionDisplayReducer(view, "codex");
    live.message(prompt);
    live.message(tool("live"));
    const liveGroupId = required(groups(live.snapshot())[0]).id;
    const liveStep = required(required(live.groupSteps(liveGroupId))[0]);
    expect(liveStep.status).toBe("running");
    expect(Date.parse(required(liveStep.timestamp))).toBeGreaterThan(0);

    const sourced = new SessionDisplayReducer(view, "codex");
    sourced.message(prompt);
    sourced.message({ ...tool("sourced"), timestamp: "2026-01-02T10:00:00Z" });
    const sourcedGroupId = required(groups(sourced.snapshot())[0]).id;
    expect(
      required(required(sourced.groupSteps(sourcedGroupId))[0]).timestamp,
    ).toBe("2026-01-02T10:00:00Z");

    const replay = new SessionDisplayReducer(view, "codex");
    replay.message({ ...prompt, isReplay: true });
    replay.message({ ...tool("replayed"), isReplay: true });
    const replayGroupId = required(groups(replay.snapshot())[0]).id;
    expect(
      required(required(replay.groupSteps(replayGroupId))[0]).timestamp,
    ).toBeUndefined();
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing expected fixture value");
  return value;
}
