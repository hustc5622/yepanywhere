import {
  type SessionDisplayNode,
  type SessionDisplaySnapshot,
  SessionDisplaySnapshotSchema,
  applySessionDisplayPatch,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { SessionDisplayReducer } from "../../src/display/SessionDisplayReducer.js";
import type { Message } from "../../src/supervisor/types.js";

const view = { sessionId: "session", branchScopeId: "active", epoch: "epoch" };
const at = (second: number) =>
  `2026-01-02T10:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;

function codex(turn: string) {
  return {
    prompt: (text: string, second: number) => ({
      uuid: `${turn}-user`,
      type: "user",
      codexTurnId: turn,
      timestamp: at(second),
      message: { role: "user", content: text },
    }),
    tool: (id: string, second: number) => ({
      uuid: `${id}-${turn}`,
      type: "assistant",
      codexTurnId: turn,
      timestamp: at(second),
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id,
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
      },
    }),
    result: (id: string, second: number, isError = false) => ({
      uuid: `${id}-result-${turn}`,
      type: "user",
      codexTurnId: turn,
      timestamp: at(second),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: "passed",
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    }),
    reply: (
      id: string,
      text: string,
      second: number,
      phase = "commentary",
      extra: Record<string, unknown> = {},
    ) => ({
      uuid: `${id}-${turn}`,
      type: "assistant",
      codexTurnId: turn,
      timestamp: at(second),
      codexCorrelationKey: `codex:${turn}:agent-message:${id}`,
      codexMessagePhase: phase,
      message: { role: "assistant", content: text },
      ...extra,
    }),
    complete: (status = "completed") => ({
      uuid: `${turn}-terminal`,
      type: "system",
      subtype: "turn_complete",
      codexTurnId: turn,
      turnStatus: status,
    }),
  };
}

function labels(nodes: readonly SessionDisplayNode[]): string[] {
  return nodes.map((node) => {
    if (node.type === "question") return "question";
    const segment = node.segment;
    if (segment.type === "assistant_text")
      return `${segment.asyncMessage ? "async" : segment.phase}:${segment.content}`;
    if (segment.type === "process") return `process:${segment.status}`;
    return segment.type;
  });
}

function processes(snapshot: SessionDisplaySnapshot) {
  return snapshot.nodes.flatMap((node) =>
    node.type === "segment" && node.segment.type === "process"
      ? [node.segment]
      : [],
  );
}

function completedTurn(turn: string, offset: number): Message[] {
  const t = codex(turn);
  return [
    t.prompt("Fix it", offset),
    t.reply("progress", "Checking first", offset + 2),
    t.tool(`${turn}-a`, offset + 3),
    t.result(`${turn}-a`, offset + 10),
    t.tool(`${turn}-b`, offset + 11),
    t.result(`${turn}-b`, offset + 20, true),
    t.reply("final", "All fixed", offset + 68, "final_answer"),
  ] as Message[];
}

describe("SessionDisplayReducer process folding", () => {
  it("folds the working steps of a completed answer behind one summary", () => {
    const model = new SessionDisplayReducer(view, "codex", {
      foldSettled: true,
    });
    model.restore(completedTurn("turn-1", 0), { "turn-1": "completed" });
    model.setRuntime("completed");
    const snapshot = model.snapshot();
    expect(SessionDisplaySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(labels(snapshot.nodes)).toEqual([
      "question",
      "process:completed",
      "final:All fixed",
    ]);
    const [fold] = processes(snapshot);
    expect(fold).toMatchObject({
      stepCount: 2,
      toolCount: 2,
      failedToolCount: 1,
      thinkingCount: 0,
      updateCount: 1,
      startedAt: at(0),
      endedAt: at(68),
    });
    // The default snapshot never carries the folded bodies.
    expect(JSON.stringify(snapshot)).not.toContain("Checking first");
    const members = model.processNodes(fold?.id ?? "");
    expect(labels(members ?? [])).toEqual([
      "progress:Checking first",
      "tool_group",
    ]);
    expect(model.hasNode(fold?.id ?? "")).toBe(true);
  });

  it("records source message ids so content search can find text segments", () => {
    const model = new SessionDisplayReducer(view, "codex", {
      foldSettled: true,
    });
    model.restore(completedTurn("turn-1", 0), { "turn-1": "completed" });
    model.setRuntime("completed");
    const snapshot = model.snapshot();
    expect(SessionDisplaySnapshotSchema.safeParse(snapshot).success).toBe(true);
    const answer = snapshot.nodes.find(
      (node) =>
        node.type === "segment" && node.segment.type === "assistant_text",
    );
    expect(answer?.type === "segment" && answer.segment).toMatchObject({
      type: "assistant_text",
      messageId: "final-turn-1",
    });
    // Hidden progress text stays reachable through its fold.
    expect(processes(snapshot)[0]?.messageIds).toEqual(["progress-turn-1"]);
  });

  it("keeps the running answer expanded while folding earlier answers", () => {
    const model = new SessionDisplayReducer(view, "codex", {
      foldSettled: true,
    });
    model.restore(completedTurn("turn-1", 0), { "turn-1": "completed" });
    const t = codex("turn-2");
    model.message(t.prompt("Next", 100));
    model.message(t.reply("progress", "Working on it", 101));
    model.message(t.tool("turn-2-a", 102));
    model.setRuntime("running");
    expect(labels(model.snapshot().nodes)).toEqual([
      "question",
      "process:completed",
      "final:All fixed",
      "question",
      "progress:Working on it",
      "tool_group",
    ]);
  });

  it("folds the latest answer once its run settles and patches the transition", () => {
    const model = new SessionDisplayReducer(view, "codex", {
      foldSettled: true,
    });
    const t = codex("turn-1");
    model.message(t.prompt("Fix it", 0));
    model.message(t.reply("progress", "Checking first", 2));
    model.message(t.tool("a", 3));
    model.setRuntime("running");
    const running = model.snapshot();
    expect(processes(running)).toHaveLength(0);
    model.message(t.result("a", 9));
    model.message(t.reply("final", "Done", 12, "final_answer"));
    model.message(t.complete());
    const patch = model.commit(running);
    expect(patch).not.toBeNull();
    const next = model.snapshot();
    expect(labels(next.nodes)).toEqual([
      "question",
      "process:completed",
      "final:Done",
    ]);
    const applied = applySessionDisplayPatch(running, patch ?? ({} as never));
    expect(applied?.nodes).toEqual(next.nodes);
  });

  it("keeps async questions visible and splits the work around them", () => {
    const model = new SessionDisplayReducer(view, "codex", {
      foldSettled: true,
    });
    const t = codex("turn-1");
    model.restore(
      [
        t.prompt("Investigate", 0),
        t.tool("a", 1),
        t.result("a", 5),
        t.reply("ask", "Where is the key?", 6, "commentary", {
          codexAsyncMessage: {
            delivery: "async",
            questions: [{ title: "Key path?" }],
          },
        }),
        t.tool("b", 8),
        t.result("b", 9),
        t.reply("final", "Found it", 15, "final_answer"),
      ] as Message[],
      { "turn-1": "completed" },
    );
    const snapshot = model.snapshot();
    expect(labels(snapshot.nodes)).toEqual([
      "question",
      "process:unknown",
      "async:Where is the key?",
      "process:completed",
      "final:Found it",
    ]);
    const [before, after] = processes(snapshot);
    expect(before).toMatchObject({ startedAt: at(0), endedAt: at(5) });
    expect(after).toMatchObject({ startedAt: at(6), endedAt: at(15) });
    expect(before?.id).not.toBe(after?.id);
  });

  it("labels interrupted work without a reply and keeps errors visible", () => {
    const model = new SessionDisplayReducer(view, "codex", {
      foldSettled: true,
    });
    const t = codex("turn-1");
    model.restore(
      [
        t.prompt("Run", 0),
        t.reply("progress", "Starting", 1),
        t.tool("a", 2),
        t.result("a", 4),
      ] as Message[],
      { "turn-1": "interrupted" },
    );
    expect(labels(model.snapshot().nodes)).toEqual([
      "question",
      "process:interrupted",
    ]);

    const failed = new SessionDisplayReducer(view, "codex", {
      foldSettled: true,
    });
    failed.restore([
      t.prompt("Run", 0),
      t.tool("a", 2),
      t.result("a", 4),
      {
        uuid: "error",
        type: "error",
        codexTurnId: "turn-1",
        error: "Rate limited",
      },
    ] as Message[]);
    expect(labels(failed.snapshot().nodes)).toEqual([
      "question",
      "process:failed",
      "error",
    ]);
  });

  it("treats the trailing text as the answer for providers without phases", () => {
    const model = new SessionDisplayReducer(view, "claude", {
      foldSettled: true,
    });
    const text = (uuid: string, content: string) => ({
      uuid,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: content }],
      },
    });
    model.restore([
      {
        uuid: "user",
        type: "user",
        message: { role: "user", content: "Fix" },
      },
      text("a1", "Let me look"),
      {
        uuid: "a2",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { path: "x" } },
          ],
        },
      },
      {
        uuid: "r1",
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      },
      text("a3", "Here is the fix"),
      text("a4", "Anything else?"),
    ] as Message[]);
    model.setRuntime("completed");
    expect(labels(model.snapshot().nodes)).toEqual([
      "question",
      "process:completed",
      "text:Here is the fix",
      "text:Anything else?",
    ]);
  });

  it("keeps a compaction after the answer it followed and out of its duration", () => {
    const user = (uuid: string, content: string, second: number) => ({
      uuid,
      type: "user",
      timestamp: at(second),
      message: { role: "user", content },
    });
    const messages = [
      user("u1", "Continue", 0),
      {
        uuid: "a1",
        type: "assistant",
        timestamp: at(5),
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { path: "x" } },
          ],
        },
      },
      {
        uuid: "r1",
        type: "user",
        timestamp: at(9),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      },
      {
        uuid: "a2",
        type: "assistant",
        timestamp: at(30),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Half done" }],
        },
      },
      {
        uuid: "compaction",
        type: "system",
        subtype: "compact_boundary",
        timestamp: at(600),
        content: "Summary",
      },
    ] as Message[];

    // Persisted Pi history: the compaction entry follows the last answer.
    const restored = new SessionDisplayReducer(view, "pi", {
      foldSettled: true,
    });
    restored.restore(messages);
    restored.setRuntime("completed");
    const snapshot = restored.snapshot();
    expect(labels(snapshot.nodes)).toEqual([
      "question",
      "process:completed",
      "text:Half done",
      "notice",
    ]);
    expect(processes(snapshot)[0]).toMatchObject({
      startedAt: at(0),
      endedAt: at(30),
    });

    // Live: the manual compaction runs as its own busy period whose result
    // closes the generic run long after the answer.
    const live = new SessionDisplayReducer(view, "pi", { foldSettled: true });
    for (const message of messages.slice(0, 4)) live.message(message);
    live.message({ type: "result", timestamp: at(31) });
    live.message({ type: "system", subtype: "status", status: "compacting" });
    live.message(messages[4] as Message);
    live.message({ type: "system", subtype: "status", status: null });
    live.message({ type: "result", timestamp: at(601) });
    const settled = live.snapshot();
    expect(labels(settled.nodes)).toEqual([
      "question",
      "process:completed",
      "text:Half done",
      "notice",
    ]);
    expect(processes(settled)[0]).toMatchObject({ endedAt: at(30) });
  });

  it("leaves projections unfolded unless enabled and while waiting for input", () => {
    const plain = new SessionDisplayReducer(view, "codex");
    plain.restore(completedTurn("turn-1", 0), { "turn-1": "completed" });
    expect(processes(plain.snapshot())).toHaveLength(0);

    const waiting = new SessionDisplayReducer(view, "codex", {
      foldSettled: true,
    });
    const t = codex("turn-1");
    waiting.restore([
      t.prompt("Run", 0),
      t.tool("a", 1),
      t.result("a", 2),
      t.reply("progress", "Need approval", 3),
    ] as Message[]);
    waiting.setRuntime("waiting-input");
    expect(processes(waiting.snapshot())).toHaveLength(0);
  });

  it("records the older page cursor on folds so members can be rebuilt", () => {
    const model = new SessionDisplayReducer(view, "codex", {
      foldSettled: true,
    });
    model.restore(completedTurn("turn-1", 0), { "turn-1": "completed" });
    const [fold] = processes(model.snapshot("older", "page-cursor"));
    expect(fold?.pageCursor).toBe("page-cursor");
  });

  it("uses native turn completion when every item carries the turn start", () => {
    const model = new SessionDisplayReducer(view, "codex", {
      foldSettled: true,
    });
    const t = codex("turn-1");
    model.restore(
      [
        t.prompt("Fix it", 0),
        t.reply("progress", "Checking", 0),
        t.tool("a", 0),
        t.result("a", 0),
        t.reply("final", "Done", 0, "final_answer"),
      ] as Message[],
      { "turn-1": "completed" },
      { "turn-1": at(95) },
    );
    expect(processes(model.snapshot())[0]).toMatchObject({
      status: "completed",
      startedAt: at(0),
      endedAt: at(95),
    });
  });

  it("keeps the last Cursor answer outside the fold when a thought follows it", () => {
    const model = new SessionDisplayReducer(view, "cursor", {
      foldSettled: true,
    });
    const turn = "cursor-turn-1";
    const withTurn = (message: Record<string, unknown>) => ({
      ...message,
      turnId: turn,
      cursorTurnIndex: 1,
    });
    model.restore(
      [
        withTurn({
          uuid: "user",
          type: "user",
          message: { role: "user", content: "开始吧" },
        }),
        withTurn({
          uuid: "progress",
          type: "assistant",
          message: { role: "assistant", content: "先看一下" },
        }),
        withTurn({
          uuid: "tool",
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "read-1",
                name: "Read",
                input: { path: "a.ts" },
              },
            ],
          },
        }),
        withTurn({
          uuid: "result",
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "read-1", content: "ok" },
            ],
          },
        }),
        withTurn({
          uuid: "answer",
          type: "assistant",
          message: { role: "assistant", content: "这条黄字是核对说明" },
        }),
        withTurn({
          uuid: "late-thought",
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "The user wants the epoch check" },
            ],
          },
        }),
      ] as Message[],
      { [turn]: "completed" },
    );
    model.setRuntime("completed");
    expect(labels(model.snapshot().nodes)).toEqual([
      "question",
      "process:completed",
      "text:这条黄字是核对说明",
    ]);
  });
});
