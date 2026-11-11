import {
  type SessionDisplaySnapshot,
  SessionDisplaySnapshotSchema,
  applySessionDisplayPatch,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
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
  it.each([false, true])(
    "splits recovered Cursor tools at thinking boundaries (reverse recovery: %s)",
    (reverse) => {
      const withTurn = (message: Record<string, unknown>) => ({
        ...message,
        codexTurnId: undefined,
        turnId: "cursor-turn-1",
        cursorTurnIndex: 1,
      });
      const thought = (id: string, callId: string) =>
        withTurn({
          uuid: id,
          type: "assistant",
          cursorThinkingBefore: { toolId: callId },
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: `Inspect ${callId}` }],
          },
        });
      const thoughts = [
        thought("thought-b", "b"),
        thought("thought-d", "d"),
      ] as const;
      const native = [
        withTurn(prompt),
        ...["a", "b", "c", "d", "e"].flatMap((id) => [
          withTurn(tool(id)),
          withTurn(result(id)),
        ]),
        withTurn(reply("answer", "Done")),
      ];
      const model = new SessionDisplayReducer(view, "cursor");
      model.restore(native as Message[]);
      expect(groups(model.snapshot()).map((group) => group.count)).toEqual([5]);
      for (const message of reverse ? [...thoughts].reverse() : thoughts)
        model.message(message);
      const snapshot = model.snapshot();
      expect(SessionDisplaySnapshotSchema.safeParse(snapshot).success).toBe(
        true,
      );
      expect(
        snapshot.nodes.map((node) =>
          node.type === "segment" ? node.segment.type : node.type,
        ),
      ).toEqual([
        "question",
        "tool_group",
        "thinking",
        "tool_group",
        "thinking",
        "tool_group",
        "assistant_text",
      ]);
      const actualGroups = groups(snapshot);
      expect(actualGroups.map((group) => group.count)).toEqual([1, 2, 2]);
      expect(
        actualGroups.map((group) =>
          model.groupSteps(group.id)?.map((step) => step.id),
        ),
      ).toEqual(
        [["a"], ["b", "c"], ["d", "e"]].map((ids) =>
          ids.map((id) => displayToolId("cursor-turn-1", id)),
        ),
      );
      for (const group of actualGroups) {
        expect(group.displayMode).toBe("summary");
        expect(
          model
            .groupSteps(group.id)
            ?.every((step) => step.groupId === group.id),
        ).toBe(true);
      }
      // The same boundaries encountered live choose the same group identities.
      const live = new SessionDisplayReducer(view, "cursor");
      for (const message of native) {
        if (message.uuid === "b-turn") live.message(thoughts[0]);
        if (message.uuid === "d-turn") live.message(thoughts[1]);
        live.message(message);
      }
      expect(groups(live.snapshot()).map((group) => group.id)).toEqual(
        actualGroups.map((group) => group.id),
      );
      // A later chunk updates its row; a late result updates its new group.
      model.message({
        ...thoughts[0],
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Inspect b in more detail" }],
        },
      });
      model.message(
        withTurn({
          ...result("c"),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "c",
                content: "Failed",
                is_error: true,
              },
            ],
          },
        }),
      );
      expect(
        groups(model.snapshot()).map((group) => group.failedCount),
      ).toEqual([0, 1, 0]);
      expect(
        model
          .snapshot()
          .nodes.filter(
            (node) =>
              node.type === "segment" && node.segment.type === "thinking",
          ),
      ).toHaveLength(2);
      const patch = model.commit(snapshot);
      expect(patch).not.toBeNull();
      if (!patch) throw new Error("Expected a display patch");
      expect(applySessionDisplayPatch(snapshot, patch)).toEqual(
        model.snapshot(),
      );
    },
  );

  it("allows providers without native turn ids to stream again after a result", () => {
    const model = new SessionDisplayReducer(view, "claude");
    const text = (id: string) =>
      model.message({
        uuid: id,
        type: "assistant",
        _isStreaming: true,
        _isStreamingPlaceholder: true,
        message: { role: "assistant", content: id },
      });
    text("first");
    model.message({ type: "result", uuid: "result" });
    model.message({
      type: "user",
      uuid: "next-question",
      message: { role: "user", content: "Next" },
    });
    text("second");
    const texts = model
      .snapshot()
      .nodes.flatMap((n) =>
        n.type === "segment" && n.segment.type === "assistant_text"
          ? [n.segment]
          : [],
      );
    expect(texts).toMatchObject([
      { content: "first", streaming: false },
      { content: "second", streaming: true },
    ]);
  });

  it.each(["followup_task", "send_message"])(
    "retains %s identity through compact live messages and a cold restore",
    (operation) => {
      const call = {
        ...tool("call-1"),
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: `collaboration.${operation}`,
              input: { target: "review", message: "Check this" },
            },
          ],
        },
      };
      const activity = {
        uuid: "activity",
        type: "system",
        subtype: "codex_native_item",
        codexTurnId: "turn",
        codexThreadItem: {
          type: "subAgentActivity",
          id: "call-1",
          kind: "interacted",
          agentThreadId: "child",
          agentPath: "/root/review",
        },
      };
      const live = new SessionDisplayReducer(view, "codex");
      for (const message of [prompt, call, activity])
        live.message(compactDisplayMessage(message));
      const cold = new SessionDisplayReducer(view, "codex");
      cold.restore([prompt, call, activity] as Message[]);
      for (const model of [live, cold]) {
        const notice = model
          .snapshot()
          .nodes.find(
            (node) => node.type === "segment" && node.segment.type === "notice",
          );
        expect(notice).toMatchObject({
          segment: {
            kind: "subagent",
            subagent: { operation, kind: "interacted" },
          },
        });
      }
    },
  );

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

  it("does not leave a Pi tool call abandoned by a broken stream as running", () => {
    // Pi has no turn ids, so every run lands on "session" and only a
    // tool_result can close a step while the session keeps working. The
    // conversion layer synthesizes that result; this pins the display effect.
    const model = new SessionDisplayReducer(view, "pi");
    model.message({
      uuid: "user",
      type: "user",
      message: { role: "user", content: "edit the changelog" },
    });
    model.message({
      uuid: "assistant-broken",
      type: "assistant",
      stopReason: "error",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call-dead", name: "Edit", input: {} },
        ],
      },
    });
    expect(model.snapshot().activity.runningCount).toBe(1);

    model.message({
      uuid: "assistant-broken:abandoned-tool:call-dead",
      type: "user",
      tool_use_id: "call-dead",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-dead",
            content: "Tool call was abandoned",
            is_error: true,
          },
        ],
      },
    });
    const snapshot = model.snapshot();
    expect(snapshot.activity.runningCount).toBe(0);
    expect(snapshot.activity.tools).toHaveLength(0);
    expect(
      groups(snapshot).flatMap((group) => group.steps ?? []),
    ).toMatchObject([{ name: "Edit", status: "failed" }]);
  });

  it("retires a stranded tool call once a later sequential batch settles", () => {
    // Safety net for a sequential provider that cannot close on its own: a
    // stream that dies mid tool call leaves a step nothing will ever answer.
    const call = (uuid: string, ids: string[]) => ({
      uuid,
      type: "assistant",
      message: {
        role: "assistant",
        content: ids.map((id) => ({
          type: "tool_use",
          id,
          name: "Bash",
          input: { command: `run ${id}` },
        })),
      },
    });
    const answer = (id: string) => ({
      uuid: `${id}-result`,
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
      },
    });
    const statuses = (model: SessionDisplayReducer) => {
      // Retirement is decided when a snapshot is produced, which is the single
      // place both live patches and cold reads go through.
      model.snapshot();
      return [...model.tools.values()].map((tool) => [
        tool.rawId,
        tool.step.status,
      ]);
    };

    const model = new SessionDisplayReducer(view, "claude");
    model.message(call("a", ["stranded"]));
    model.message(call("b", ["next"]));
    expect(model.snapshot().activity.runningCount).toBe(2);

    model.message(answer("next"));
    expect(statuses(model)).toEqual([
      ["stranded", "unknown"],
      ["next", "completed"],
    ]);

    // A late result still wins: retiring the step is a display decision, not a
    // refusal to accept the real outcome.
    model.message(answer("stranded"));
    expect(statuses(model)).toEqual([
      ["stranded", "completed"],
      ["next", "completed"],
    ]);
  });

  it.each(["codex", "codex-oss"])(
    "keeps %s background commands running across later completed batches and history reads",
    (provider) => {
      const events = [prompt, tool("slow"), tool("fast"), result("fast")];
      for (const replay of [false, true]) {
        const model = new SessionDisplayReducer(view, provider);
        if (replay) model.restore(events as Message[]);
        else for (const event of events) model.message(event);
        expect(model.snapshot().activity.runningCount).toBe(1);
        expect(
          model.tools.get(displayToolId("turn", "slow"))?.step,
        ).toMatchObject({ name: "Bash", status: "running" });
        model.message(result("slow"));
        expect(model.snapshot().activity.runningCount).toBe(0);
        expect(
          model.tools.get(displayToolId("turn", "slow"))?.step.status,
        ).toBe("completed");
      }
    },
  );

  it.each(["completed", "failed", "interrupted"])(
    "settles an unfinished Codex background command when its turn is %s",
    (turnStatus) => {
      const model = new SessionDisplayReducer(view, "codex");
      for (const event of [prompt, tool("slow"), tool("fast"), result("fast")])
        model.message(event);
      expect(model.snapshot().activity.runningCount).toBe(1);
      model.message({ ...terminal, turnStatus });
      expect(model.snapshot().activity.runningCount).toBe(0);
      expect(model.tools.get(displayToolId("turn", "slow"))?.step.status).toBe(
        turnStatus === "interrupted" ? "interrupted" : "unknown",
      );
    },
  );

  it("leaves a parallel batch alone while only part of it has answered", () => {
    // Calls issued together may answer in any order, so a settled sibling says
    // nothing about the ones still working.
    const model = new SessionDisplayReducer(view, "claude");
    model.message({
      uuid: "batch",
      type: "assistant",
      message: {
        role: "assistant",
        content: ["one", "two", "three"].map((id) => ({
          type: "tool_use",
          id,
          name: "Bash",
          input: { command: `run ${id}` },
        })),
      },
    });
    model.message({
      uuid: "two-result",
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "two", content: "ok" }],
      },
    });
    expect(model.snapshot().activity.runningCount).toBe(2);
    expect([...model.tools.values()].map((tool) => tool.step.status)).toEqual([
      "running",
      "completed",
      "running",
    ]);
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
    // Live steps without a source timestamp take their start from the wall
    // clock. A millisecond boundary otherwise gives one entry point a duration
    // the uninterrupted snapshot does not have.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
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
    } finally {
      vi.useRealTimers();
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
  it("reports cumulative timing for parallel calls even after the group is collapsed", () => {
    const model = new SessionDisplayReducer(view, "codex");
    model.message(prompt, true);
    for (const id of ["a", "b"])
      model.message({ ...tool(id), timestamp: "2026-01-01T00:00:00Z" }, true);
    model.message({ ...result("a"), timestamp: "2026-01-01T00:00:10Z" }, true);
    model.message({ ...result("b"), timestamp: "2026-01-01T00:00:20Z" }, true);
    model.message(reply("done", "Done", "final_answer"), true);
    expect(groups(model.snapshot())[0]).toMatchObject({
      count: 2,
      durationMs: 30_000,
      timedCount: 2,
      displayMode: "summary",
    });
    expect(groups(model.snapshot())[0]).not.toHaveProperty("steps");
  });

  it("aggregates native durations beyond the visible step limit and reports partial coverage", () => {
    const model = new SessionDisplayReducer(view, "codex");
    model.message(prompt, true);
    for (let i = 0; i < 55; i++) {
      const id = `timed-${i}`;
      model.message(tool(id), true);
      const r = result(id);
      model.message(
        compactDisplayMessage({
          ...r,
          message: {
            ...r.message,
            content: [
              {
                ...required(r.message.content[0]),
                durationMs: i === 0 ? 0 : 100,
              },
            ],
          },
        }),
        true,
      );
    }
    model.message(tool("no-timing"), true);
    model.message(result("no-timing"), true);
    expect(groups(model.snapshot())[0]).toMatchObject({
      count: 56,
      durationMs: 5400,
      timedCount: 55,
    });
    expect(groups(model.snapshot())[0]?.steps).toHaveLength(50);
    model.message(reply("done", "Done", "final_answer"), true);
    expect(groups(model.snapshot())[0]).toMatchObject({
      durationMs: 5400,
      timedCount: 55,
      displayMode: "summary",
    });
  });

  it("retains each call's own completion time across replay and duplicate results", () => {
    const events = [
      prompt,
      { ...tool("slow"), timestamp: "2026-01-02T10:00:00Z" },
      { ...tool("fast"), timestamp: "2026-01-02T10:00:01Z" },
      { ...result("fast"), timestamp: "2026-01-02T10:00:03Z" },
      { ...result("slow"), timestamp: "2026-01-02T10:00:12Z" },
    ];
    for (const replay of [false, true]) {
      const model = new SessionDisplayReducer(view, "codex");
      for (const event of events)
        model.message(compactDisplayMessage(event), replay);
      const groupId = required(groups(model.snapshot())[0]).id;
      expect(
        model.groupSteps(groupId)?.map((s) => [s.timestamp, s.completedAt]),
      ).toEqual([
        ["2026-01-02T10:00:00Z", "2026-01-02T10:00:12Z"],
        ["2026-01-02T10:00:01Z", "2026-01-02T10:00:03Z"],
      ]);
      model.message({
        ...result("slow"),
        timestamp: "2026-01-02T10:01:00Z",
        isReplay: true,
      });
      expect(model.groupSteps(groupId)?.[0]?.completedAt).toBe(
        "2026-01-02T10:00:12Z",
      );
      expect(
        SessionDisplaySnapshotSchema.safeParse(model.snapshot()).success,
      ).toBe(true);
    }
  });

  it("keeps failure timing and does not invent timing for orphan or untimed historical results", () => {
    const model = new SessionDisplayReducer(view, "claude");
    model.message(prompt, true);
    model.message(
      { ...tool("failed"), timestamp: "2026-01-02T10:00:00Z" },
      true,
    );
    const failed = result("failed");
    failed.message.content[0] = {
      ...required(failed.message.content[0]),
      is_error: true,
    } as (typeof failed.message.content)[0];
    model.message({ ...failed, timestamp: "2026-01-02T10:00:03Z" }, true);
    model.message(
      { ...result("orphan"), timestamp: "2026-01-02T10:00:05Z" },
      true,
    );
    model.message(tool("untimed"), true);
    model.message(result("untimed"), true);
    const steps = [...model.tools.values()].map((t) => t.step);
    expect(steps[0]).toMatchObject({
      status: "failed",
      completedAt: "2026-01-02T10:00:03Z",
    });
    expect(steps[1]?.timestamp).toBeUndefined();
    expect(steps[1]?.completedAt).toBeUndefined();
    expect(steps[2]?.completedAt).toBeUndefined();
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

  it("keeps Cursor progress text that shares a message with its tool calls", () => {
    const model = new SessionDisplayReducer(view, "cursor");
    model.message({
      uuid: "user",
      type: "user",
      turnId: "cursor-turn-1",
      cursorTurnIndex: 1,
      message: { role: "user", content: "下一问" },
    });
    model.message({
      uuid: "step",
      type: "assistant",
      turnId: "cursor-turn-1",
      cursorTurnIndex: 1,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Check epoch first" },
          { type: "text", text: "先确认 8090 自己会不会核对" },
          {
            type: "tool_use",
            id: "read-a",
            name: "Read",
            input: { path: "a.ts" },
          },
          {
            type: "tool_use",
            id: "read-b",
            name: "Read",
            input: { path: "b.ts" },
          },
        ],
      },
    });
    expect(
      model
        .snapshot()
        .nodes.map((node) =>
          node.type === "segment" ? node.segment.type : node.type,
        ),
    ).toEqual(["question", "thinking", "assistant_text", "tool_group"]);
  });

  it("does not turn equal Cursor start and end times into a group total", () => {
    const model = new SessionDisplayReducer(view, "cursor");
    model.message({
      uuid: "user",
      type: "user",
      turnId: "cursor-turn-1",
      message: { role: "user", content: "Run" },
    });
    model.message({
      ...tool("same"),
      turnId: "cursor-turn-1",
      codexTurnId: undefined,
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    model.message({
      ...result("same"),
      turnId: "cursor-turn-1",
      codexTurnId: undefined,
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    expect(groups(model.snapshot())[0]).toMatchObject({ count: 1 });
    expect(groups(model.snapshot())[0]).not.toHaveProperty("durationMs");
  });

  it("places a short Cursor thought before the reply it names", () => {
    const model = new SessionDisplayReducer(view, "cursor");
    model.message({
      uuid: "user",
      type: "user",
      turnId: "cursor-turn-1",
      message: { role: "user", content: "问" },
    });
    model.message({
      uuid: "answer",
      type: "assistant",
      turnId: "cursor-turn-1",
      message: {
        role: "assistant",
        content: "先确认 8090 自己会不会核对两侧 epoch",
      },
    });
    model.message({
      uuid: "thought",
      type: "assistant",
      turnId: "cursor-turn-1",
      cursorThinkingBefore: { text: "先确认 8090" },
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Look at the yellow note" }],
      },
    });
    expect(
      model
        .snapshot()
        .nodes.map((node) =>
          node.type === "segment" ? node.segment.type : node.type,
        ),
    ).toEqual(["question", "thinking", "assistant_text"]);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing expected fixture value");
  return value;
}
