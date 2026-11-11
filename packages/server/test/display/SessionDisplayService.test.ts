import {
  SessionDisplayPatchSchema,
  type SessionDisplaySnapshot,
  SessionDisplaySnapshotSchema,
  applySessionDisplayPatch,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { displayToolId } from "../../src/display/SessionDisplayReducer.js";
import {
  type DisplaySourcePage,
  SessionDisplayService,
  compactDisplayMessage,
} from "../../src/display/SessionDisplayService.js";
import type { Message } from "../../src/supervisor/types.js";
const selection = { projectId: "project", sessionId: "session" };
function displayNodeLabels(snapshot: SessionDisplaySnapshot): string[] {
  return snapshot.nodes.map((node) => {
    if (node.type === "question") return "question";
    if (node.type !== "segment") return node.type;
    if (node.segment.type === "thinking")
      return `thinking:${node.segment.content}`;
    if (node.segment.type === "assistant_text")
      return `text:${node.segment.content}`;
    return node.segment.type;
  });
}
const services: SessionDisplayService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
});
/**
 * Most cases assert the raw projection order. Folding of settled answers is
 * covered by its own cases, which opt in through `foldSettledTurns`.
 */
function fixture(
  pollMs = 60_000,
  options: { foldSettledTurns?: boolean } = { foldSettledTurns: false },
) {
  let push: (type: string, data: unknown) => void = () => {};
  const source = {
    stamp: vi.fn(async () => "1"),
    read: vi.fn(
      async (): Promise<DisplaySourcePage> => ({
        provider: "codex",
        messages: [
          {
            uuid: "u",
            type: "user",
            codexTurnId: "turn",
            message: { role: "user", content: "Run" },
          },
        ] as Message[],
        activity: "running" as const,
        stamp: "1",
      }),
    ),
    detail: vi.fn(async () => [] as Message[]),
  };
  const runtime = {
    getProcessForSession: vi.fn(async () => ({ id: "process" }) as never),
    subscribeSession: vi.fn(async (_id: string, emit: typeof push) => {
      push = emit;
      return { cleanup: vi.fn() };
    }),
  };
  const service = new SessionDisplayService({ runtime, pollMs, ...options });
  service.configureSource(source);
  services.push(service);
  return {
    service,
    source,
    runtime,
    push: (type: string, data: unknown) => push(type, data),
  };
}
describe("SessionDisplayService", () => {
  it("streams and replays Cursor context snapshots even when only usage changes", async () => {
    vi.useFakeTimers();
    const { service, source } = fixture(1_000);
    const initial = {
      ...(await source.read()),
      provider: "cursor",
      contextUsage: {
        inputTokens: 196_533,
        contextWindow: 256_000,
        percentage: 76.8,
      },
    };
    source.read.mockResolvedValue(initial);
    const events = vi.fn();
    const subscription = await service.subscribe(selection, events);
    expect(events).toHaveBeenCalledWith("display-context-usage", {
      sessionId: selection.sessionId,
      contextUsage: initial.contextUsage,
    });
    events.mockClear();
    // The prompt text is unchanged; a new root contains post-compaction usage.
    const contextUsage = {
      inputTokens: 20_000,
      contextWindow: 256_000,
      percentage: 7.8,
    };
    source.stamp.mockResolvedValue("2");
    source.read.mockResolvedValue({ ...initial, stamp: "2", contextUsage });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toHaveBeenCalledWith("display-context-usage", {
      sessionId: selection.sessionId,
      contextUsage,
    });
    events.mockClear();
    source.stamp.mockResolvedValue("3");
    source.read.mockResolvedValue({ ...initial, stamp: "3", contextUsage });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      events.mock.calls.filter(([type]) => type === "display-context-usage"),
    ).toHaveLength(0);
    subscription.cleanup();
    const reconnected = vi.fn();
    await service.subscribe(selection, reconnected);
    expect(reconnected).toHaveBeenCalledWith("display-context-usage", {
      sessionId: selection.sessionId,
      contextUsage,
    });
  });

  it("loads full streamed reasoning from the live body cache without looking up an unrelated native ID", async () => {
    const { service, source, push } = fixture();
    const page = await source.read();
    source.read.mockResolvedValue({ ...page, provider: "cursor" });
    await service.subscribe(selection, vi.fn());
    const content = "A complete streamed thought. ".repeat(80);
    push("message", {
      type: "assistant",
      uuid: "live-thought",
      turnId: "turn",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: content }],
      },
    });
    expect(await service.reasoning(selection, "thinking:live-thought:0")).toBe(
      content,
    );
    push("message", {
      type: "result",
      uuid: "done",
      turnId: "turn",
      turnStatus: "completed",
    });
    expect(await service.reasoning(selection, "thinking:live-thought:0")).toBe(
      content,
    );
  });

  it("recovers Cursor reasoning after a shell restart using the exact journal message identity", async () => {
    const { service, source, runtime } = fixture();
    const page = await source.read();
    source.read.mockResolvedValue({ ...page, provider: "cursor" });
    const replay = vi.fn(async () => [
      {
        type: "message",
        sessionId: "another-session",
        data: {
          uuid: "live",
          message: {
            content: [{ type: "thinking", thinking: "Wrong session" }],
          },
        },
      },
      {
        type: "message",
        sessionId: selection.sessionId,
        data: {
          uuid: "live",
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: "First chunk" }] },
        },
      },
      {
        type: "message",
        sessionId: selection.sessionId,
        data: {
          uuid: "live",
          type: "assistant",
          message: {
            content: [{ type: "thinking", thinking: "Complete body" }],
          },
        },
      },
    ]);
    Object.assign(runtime, { replay });
    expect(await service.reasoning(selection, "thinking:live:0")).toBe(
      "Complete body",
    );
    expect(replay).toHaveBeenCalledWith({
      sessionId: selection.sessionId,
      allProcesses: true,
    });
    expect(await service.reasoning(selection, "thinking:live:0")).toBe(
      "Complete body",
    );
    expect(replay).toHaveBeenCalledOnce();
  });

  it("recovers a Cursor backend error even after hundreds of streamed thinking updates", async () => {
    const { service, source, runtime } = fixture();
    const page = await source.read();
    source.read.mockResolvedValue({ ...page, provider: "cursor" });
    runtime.subscribeSession.mockImplementation(async (_id, emit) => {
      for (let index = 0; index < 600; index++)
        emit("message", {
          isReplay: true,
          type: "assistant",
          uuid: "thought",
          turnId: "turn",
          message: {
            content: [{ type: "thinking", thinking: `Chunk ${index}` }],
          },
        });
      emit("message", {
        isReplay: true,
        type: "assistant",
        uuid: "failure",
        turnId: "turn",
        message: {
          content: "\n\nError: RetriableError: [resource_exhausted] Error",
        },
      });
      emit("message", {
        isReplay: true,
        type: "result",
        uuid: "end",
        turnId: "turn",
        turnStatus: "completed",
      });
      return { cleanup: vi.fn() };
    });
    const snapshot = await service.snapshot(selection);
    expect(JSON.stringify(snapshot)).toContain("resource_exhausted");
    expect(snapshot.activity.state).toBe("failed");
  });
  it("reconciles Cursor replies by native turn without erasing an identical later reply", async () => {
    const { service, source, push } = fixture();
    const first: Message[] = [
      {
        uuid: "disk-user-1",
        type: "user",
        cursorTurnIndex: 1,
        turnId: "cursor-turn-1",
        message: { role: "user", content: "Repeat" },
      },
      {
        uuid: "disk-answer-1",
        type: "assistant",
        cursorTurnIndex: 1,
        turnId: "cursor-turn-1",
        message: { role: "assistant", content: "Same answer" },
      },
    ];
    source.read.mockResolvedValue({
      provider: "cursor",
      messages: first,
      activity: "running",
      stamp: "1",
    });
    await service.subscribe(selection, vi.fn());
    push("message", {
      uuid: "live-user-2",
      type: "user",
      cursorTurnIndex: 2,
      turnId: "cursor-turn-2",
      message: { role: "user", content: "Repeat" },
    });
    push("message", {
      uuid: "live-thought-2",
      type: "assistant",
      cursorTurnIndex: 2,
      turnId: "cursor-turn-2",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Transient thought" }],
      },
    });
    push("message", {
      uuid: "live-answer-2",
      type: "assistant",
      cursorTurnIndex: 2,
      turnId: "cursor-turn-2",
      message: { role: "assistant", content: "Same answer" },
    });
    push("message", {
      uuid: "cursor-result-2",
      type: "result",
      cursorTurnIndex: 2,
      turnId: "cursor-turn-2",
      turnStatus: "completed",
    });
    push("status", { state: "idle" });
    await vi.waitFor(async () => {
      const snapshot = await service.snapshot(selection);
      expect(
        snapshot.nodes.filter(
          (n) => n.type === "segment" && n.segment.type === "assistant_text",
        ),
      ).toHaveLength(2);
    });
    source.read.mockResolvedValue({
      provider: "cursor",
      messages: [
        ...first,
        {
          uuid: "disk-user-2",
          type: "user",
          cursorTurnIndex: 2,
          turnId: "cursor-turn-2",
          message: { role: "user", content: "Repeat" },
        },
        {
          uuid: "disk-answer-2",
          type: "assistant",
          cursorTurnIndex: 2,
          turnId: "cursor-turn-2",
          message: { role: "assistant", content: "Same answer" },
        },
      ],
      activity: "unknown",
      stamp: "2",
    });
    push("status", { state: "idle" });
    await vi.waitFor(async () => {
      const snapshot = await service.snapshot(selection);
      expect(
        snapshot.nodes.filter(
          (n) => n.type === "segment" && n.segment.type === "assistant_text",
        ),
      ).toHaveLength(2);
      expect(JSON.stringify(snapshot)).toContain("disk-answer-2");
      expect(JSON.stringify(snapshot)).not.toContain("live-answer-2");
      expect(JSON.stringify(snapshot)).toContain("Transient thought");
      expect(snapshot.activity.state).toBe("completed");
      const labels = displayNodeLabels(snapshot);
      const thoughtAt = labels.indexOf("thinking:Transient thought");
      const answers = labels.flatMap((label, index) =>
        label === "text:Same answer" ? [index] : [],
      );
      expect(thoughtAt).toBeGreaterThan(answers[0] ?? -1);
      expect(thoughtAt).toBeLessThan(answers[1] ?? -1);
    });
  });
  it("restores Cursor thinking from the runtime journal when native history has none", async () => {
    const { service, source, runtime } = fixture();
    runtime.getProcessForSession.mockResolvedValue(null);
    (runtime as { replay: (query: unknown) => Promise<unknown[]> }).replay =
      vi.fn(async () => [
        {
          type: "message",
          sessionId: selection.sessionId,
          data: {
            type: "assistant",
            uuid: "journal-thought",
            cursorTurnIndex: 1,
            turnId: "cursor-turn-1",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Kept from the journal" },
              ],
            },
          },
        },
      ]);
    source.read.mockResolvedValue({
      provider: "cursor",
      messages: [
        {
          uuid: "disk-user",
          type: "user",
          cursorTurnIndex: 1,
          turnId: "cursor-turn-1",
          message: { role: "user", content: "Explain" },
        },
        {
          uuid: "disk-answer",
          type: "assistant",
          cursorTurnIndex: 1,
          turnId: "cursor-turn-1",
          message: { role: "assistant", content: "The answer" },
        },
      ],
      activity: "unknown",
      stamp: "1",
    });
    await service.subscribe(selection, vi.fn());
    const snapshot = await service.snapshot(selection);
    expect(JSON.stringify(snapshot)).toContain("Kept from the journal");
    expect(JSON.stringify(snapshot)).toContain("The answer");
    const labels = displayNodeLabels(snapshot);
    expect(labels.indexOf("thinking:Kept from the journal")).toBeLessThan(
      labels.indexOf("text:The answer"),
    );
  });
  it("places recovered Cursor thoughts before the reply or tool that followed them", async () => {
    const { service, source, runtime } = fixture();
    runtime.getProcessForSession.mockResolvedValue(null);
    (runtime as { replay: (query: unknown) => Promise<unknown[]> }).replay =
      vi.fn(async () => [
        {
          type: "message",
          sessionId: selection.sessionId,
          data: {
            type: "assistant",
            uuid: "thought-before-tool",
            cursorTurnIndex: 1,
            turnId: "cursor-turn-1",
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: "Before the tool" }],
            },
          },
        },
        {
          type: "message",
          sessionId: selection.sessionId,
          data: {
            type: "assistant",
            uuid: "live-tool",
            cursorTurnIndex: 1,
            turnId: "cursor-turn-1",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-1",
                  name: "Read",
                  input: { path: "README.md" },
                },
              ],
            },
          },
        },
        {
          type: "message",
          sessionId: selection.sessionId,
          data: {
            type: "assistant",
            uuid: "thought-before-answer",
            cursorTurnIndex: 1,
            turnId: "cursor-turn-1",
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: "Before the answer" }],
            },
          },
        },
        {
          type: "message",
          sessionId: selection.sessionId,
          data: {
            type: "assistant",
            uuid: "live-answer",
            cursorTurnIndex: 1,
            turnId: "cursor-turn-1",
            message: { role: "assistant", content: "The answer" },
          },
        },
      ]);
    source.read.mockResolvedValue({
      provider: "cursor",
      messages: [
        {
          uuid: "disk-user",
          type: "user",
          cursorTurnIndex: 1,
          turnId: "cursor-turn-1",
          message: { role: "user", content: "Explain" },
        },
        {
          uuid: "disk-tool",
          type: "assistant",
          cursorTurnIndex: 1,
          turnId: "cursor-turn-1",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { path: "README.md" },
              },
            ],
          },
        },
        {
          uuid: "disk-answer",
          type: "assistant",
          cursorTurnIndex: 1,
          turnId: "cursor-turn-1",
          message: { role: "assistant", content: "The answer" },
        },
      ],
      activity: "unknown",
      stamp: "1",
    });
    await service.subscribe(selection, vi.fn());
    const snapshot = await service.snapshot(selection);
    expect(displayNodeLabels(snapshot)).toEqual([
      "question",
      "thinking:Before the tool",
      "tool_group",
      "thinking:Before the answer",
      "text:The answer",
    ]);
  });
  it("recovers streamed text anchors and interleaves thoughts with their own tool batches", async () => {
    const { service, source, runtime } = fixture();
    const message = (uuid: string, content: unknown, turn = 1) => ({
      type: "assistant",
      uuid,
      cursorTurnIndex: turn,
      turnId: `cursor-turn-${turn}`,
      message: { role: "assistant", content },
    });
    const thinking = (uuid: string, body: string, turn = 1) =>
      message(uuid, [{ type: "thinking", thinking: body }], turn);
    const call = (id: string) => ({
      type: "tool_use",
      id,
      name: "Read",
      input: { file_path: `${id}.txt` },
    });
    const intro = "底部这块没被用上，我先看截图和移动端布局，确认系统安全区。";
    const first = thinking("thought-1", "Check the screenshot");
    const second = thinking("thought-2", "Check the layout\nInspect the CSS.");
    const third = thinking(
      "thought-3",
      "Check the layout\nInspect the viewport.",
    );
    const last = thinking("thought-4", "Explain the result");
    const messages = [
      {
        ...message("native-user", "Optimize the layout"),
        type: "user",
        message: { role: "user", content: "Optimize the layout" },
      },
      message("native-intro", [{ type: "text", text: intro }, call("a")]),
      message("native-b", [call("b"), call("c")]),
      message("native-d", [call("d")]),
      message("native-answer", "The answer"),
    ] as Message[];
    source.read.mockResolvedValue({
      provider: "cursor",
      messages,
      activity: "completed",
      stamp: "1",
    });
    // These are cumulative ACP message shapes, including the two-character
    // first chunk seen in the real session. No precomputed anchors in the input.
    const records = [
      first,
      message("live-intro", "底部"),
      message("live-intro", intro),
      message("live-a", [call("a")]),
      thinking("thought-2", "Check"),
      second,
      message("live-b", [call("b")]),
      message("live-c", [call("c")]),
      third,
      message("live-d", [call("d")]),
      last,
      message("live-answer", "The"),
      message("live-answer", "The answer"),
    ].map((data) => ({
      type: "message",
      sessionId: selection.sessionId,
      data,
    }));
    const replay = vi.fn(async () => records);
    Object.assign(runtime, { replay });
    const snapshot = await service.snapshot(selection);
    expect(replay).toHaveBeenCalledWith({
      sessionId: selection.sessionId,
      allProcesses: true,
    });
    const expected = [
      "question",
      "thinking:Check the screenshot",
      `text:${intro}`,
      "tool_group",
      "thinking:Check the layout\nInspect the CSS.",
      "tool_group",
      "thinking:Check the layout\nInspect the viewport.",
      "tool_group",
      "thinking:Explain the result",
      "text:The answer",
    ];
    expect(displayNodeLabels(snapshot)).toEqual(expected);
    const groups = snapshot.nodes.flatMap((node) =>
      node.type === "segment" && node.segment.type === "tool_group"
        ? [node.segment]
        : [],
    );
    expect(groups.map((group) => group.count)).toEqual([1, 2, 1]);
    expect(
      (await service.group(selection, groups[1]?.id ?? "")).steps.map(
        (step) => step.summary,
      ),
    ).toEqual(["b.txt", "c.txt"]);
    expect(await service.reasoning(selection, "thinking:thought-2:0")).toBe(
      "Check the layout\nInspect the CSS.",
    );
    // A forced native-history refresh must reproduce the same boundaries.
    expect(displayNodeLabels(await service.snapshot(selection, true))).toEqual(
      expected,
    );
  });

  it("recovers earlier thoughts without replaying an old process failure into a resumed turn", async () => {
    const { service, source, runtime } = fixture();
    source.read.mockResolvedValue({
      provider: "cursor",
      messages: [
        {
          type: "user",
          uuid: "user-1",
          turnId: "cursor-turn-1",
          message: { role: "user", content: "First question" },
        },
        {
          type: "assistant",
          uuid: "answer-1",
          turnId: "cursor-turn-1",
          message: { role: "assistant", content: "First answer" },
        },
        {
          type: "user",
          uuid: "user-2",
          turnId: "cursor-turn-2",
          message: { role: "user", content: "Continue" },
        },
      ] as Message[],
      activity: "running",
      stamp: "1",
    });
    Object.assign(runtime, {
      replay: vi.fn(async () =>
        [
          {
            type: "assistant",
            uuid: "thought",
            turnId: "cursor-turn-1",
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: "Earlier thought" }],
            },
          },
          {
            type: "error",
            uuid: "error-1",
            turnId: "cursor-turn-1",
            error: "Old process failed",
          },
          { type: "result", turnId: "cursor-turn-1", is_error: true },
        ].map((data) => ({
          type: "message",
          processId: "old-process",
          sessionId: selection.sessionId,
          data,
        })),
      ),
    });
    const snapshot = await service.snapshot(selection);
    expect(displayNodeLabels(snapshot)).toEqual([
      "question",
      "thinking:Earlier thought",
      "text:First answer",
      "question",
    ]);
    expect(snapshot.activity.state).toBe("running");
  });

  it("keeps an unanchored thought in its own turn during journal recovery", async () => {
    const { service, source, runtime } = fixture();
    const prompt = (turn: number) => ({
      type: "user",
      uuid: `user-${turn}`,
      turnId: `cursor-turn-${turn}`,
      cursorTurnIndex: turn,
      message: { role: "user", content: `Question ${turn}` },
    });
    const answer = (turn: number) => ({
      type: "assistant",
      uuid: `answer-${turn}`,
      turnId: `cursor-turn-${turn}`,
      cursorTurnIndex: turn,
      message: { role: "assistant", content: `Answer ${turn}` },
    });
    source.read.mockResolvedValue({
      provider: "cursor",
      messages: [prompt(1), answer(1), prompt(2), answer(2)] as Message[],
      activity: "completed",
      stamp: "1",
    });
    Object.assign(runtime, {
      replay: vi.fn(async () =>
        [
          {
            ...answer(1),
            uuid: "thought",
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: "Earlier thought" }],
            },
          },
          prompt(2),
          answer(2),
        ].map((data) => ({
          type: "message",
          sessionId: selection.sessionId,
          data,
        })),
      ),
    });
    expect(displayNodeLabels(await service.snapshot(selection))).toEqual([
      "question",
      "thinking:Earlier thought",
      "text:Answer 1",
      "question",
      "text:Answer 2",
    ]);
  });

  it("recovers Cursor call timings without changing native tools or inventing missing intervals", async () => {
    const { service, source, runtime } = fixture();
    const message = (uuid: string, content: unknown[], turn = 1) => ({
      type:
        content[0] && (content[0] as { type: string }).type === "tool_result"
          ? "user"
          : "assistant",
      uuid,
      turnId: `cursor-turn-${turn}`,
      cursorTurnIndex: turn,
      message: { content },
    });
    const call = (id: string) => ({
      type: "tool_use",
      id,
      name: "Bash",
      input: { command: id },
    });
    const result = (id: string) => ({
      type: "tool_result",
      tool_use_id: id,
      content: `Native ${id}`,
      is_error: id === "slow",
    });
    const prompt = (turn: number) => ({
      type: "user",
      uuid: `user-${turn}`,
      turnId: `cursor-turn-${turn}`,
      message: { role: "user", content: `Question ${turn}` },
    });
    source.read.mockResolvedValue({
      provider: "cursor",
      messages: [
        prompt(1),
        ...["fast", "slow", "orphan", "untimed", "combined"].flatMap((id) => [
          message(`native-call-${id}`, [call(id)]),
          message(`native-result-${id}`, [result(id)]),
        ]),
        prompt(2),
        message("native-call-2", [call("fast")], 2),
        message("native-result-2", [result("fast")], 2),
      ] as Message[],
      activity: "completed",
      stamp: "1",
    });
    const at = (seconds: number) =>
      new Date(
        Date.parse("2026-10-20T07:00:00Z") + seconds * 1_000,
      ).toISOString();
    const event = (seconds: number, data: Record<string, unknown>) => ({
      type: "message",
      sessionId: selection.sessionId,
      timestamp: at(seconds),
      data,
    });
    Object.assign(runtime, {
      replay: vi.fn(async () => [
        // The message timestamp wins over a delayed journal write.
        event(10, {
          ...message("live-fast", [{ ...call("fast"), name: "Execute" }]),
          timestamp: at(0),
        }),
        event(0.5, message("live-slow", [call("slow")])),
        // Input updates must not move the start time.
        event(0.8, message("live-fast", [call("fast")])),
        event(1, message("live-result-fast", [result("fast")])),
        event(5, message("live-result-slow", [result("slow")])),
        event(6, message("orphan-result", [result("orphan")])),
        event(7, message("combined", [call("combined"), result("combined")])),
        // Same raw ID in another turn must not borrow the first turn's start.
        event(8, message("result-turn-2", [result("fast")], 2)),
        // A replayed duplicate must not extend the completed interval.
        event(9, message("duplicate-result", [result("fast")])),
      ]),
    });
    const snapshot = await service.snapshot(selection);
    const groups = snapshot.nodes.flatMap((node) =>
      node.type === "segment" && node.segment.type === "tool_group"
        ? [node.segment]
        : [],
    );
    expect(groups[0]).toMatchObject({
      count: 5,
      failedCount: 1,
      timedCount: 2,
      durationMs: 5_500,
    });
    expect(groups[1]?.timedCount).toBeUndefined();
    const steps = (await service.group(selection, groups[0]?.id ?? "")).steps;
    expect(steps[0]).toMatchObject({
      name: "Bash",
      timestamp: at(0),
      completedAt: at(1),
    });
    expect(steps[1]).toMatchObject({
      status: "failed",
      timestamp: at(0.5),
      completedAt: at(5),
    });
    for (const step of steps.slice(2)) {
      expect(step.completedAt).toBeUndefined();
      expect(step.durationMs).toBeUndefined();
    }
    const reset = await service.snapshot(selection, true);
    expect(
      reset.nodes.flatMap((node) =>
        node.type === "segment" && node.segment.type === "tool_group"
          ? [node.segment.timedCount]
          : [],
      ),
    ).toEqual([2, undefined]);
  });

  it("preserves live Cursor timing when untimed native history acknowledges the tool", async () => {
    const { service, source, push } = fixture();
    const nativePrompt = {
      type: "user",
      uuid: "native-user",
      turnId: "cursor-turn-1",
      cursorTurnIndex: 1,
      message: { role: "user", content: "Run" },
    };
    const call = {
      type: "assistant",
      uuid: "live-call",
      turnId: "cursor-turn-1",
      cursorTurnIndex: 1,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "command",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    };
    const result = {
      type: "user",
      uuid: "live-result",
      turnId: "cursor-turn-1",
      cursorTurnIndex: 1,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "command", content: "ok" },
        ],
      },
    };
    source.read.mockResolvedValue({
      provider: "cursor",
      messages: [nativePrompt] as Message[],
      activity: "running",
      stamp: "1",
    });
    await service.subscribe(selection, vi.fn());
    push("message", { ...call, timestamp: "2026-10-20T07:00:00Z" });
    push("message", { ...result, timestamp: "2026-10-20T07:00:03Z" });
    source.read.mockResolvedValue({
      provider: "cursor",
      messages: [
        nativePrompt,
        { ...call, uuid: "native-call" },
        { ...result, uuid: "native-result" },
      ] as Message[],
      activity: "completed",
      stamp: "2",
    });
    push("status", { state: "idle" });
    await vi.waitFor(async () => {
      const snapshot = await service.snapshot(selection);
      expect(snapshot.activity.state).toBe("completed");
      expect(
        snapshot.nodes.find(
          (node) =>
            node.type === "segment" && node.segment.type === "tool_group",
        ),
      ).toMatchObject({
        segment: { count: 1, timedCount: 1, durationMs: 3_000 },
      });
    });
  });

  it("keeps the injected Cursor prompt until native history contains that user query", async () => {
    const { service, source, runtime } = fixture();
    let emit: (type: string, data: unknown) => void = () => {};
    const tool = {
      uuid: "disk-tool",
      type: "assistant",
      cursorTurnIndex: 1,
      turnId: "cursor-turn-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { path: "README.md" },
          },
        ],
      },
    } satisfies Message;
    source.read.mockResolvedValue({
      provider: "cursor",
      messages: [tool],
      activity: "running",
      stamp: "1",
    });
    runtime.subscribeSession.mockImplementation(async (_id, send) => {
      emit = send;
      send("message", {
        isReplay: true,
        type: "user",
        uuid: "live-user",
        message: { role: "user", content: "详细审核一下该项目" },
      });
      return { cleanup: vi.fn() };
    });
    await service.subscribe(selection, vi.fn());
    const first = await service.snapshot(selection);
    const questions = first.nodes.filter((node) => node.type === "question");
    const toolAt = first.nodes.findIndex(
      (node) => node.type === "segment" && node.segment.type === "tool_group",
    );
    expect(questions).toHaveLength(1);
    const question = questions[0];
    if (!question) throw new Error("Expected question node");
    expect(JSON.stringify(question)).toContain("详细审核一下该项目");
    expect(JSON.stringify(question)).toContain("live-user");
    expect(toolAt).toBeGreaterThan(first.nodes.indexOf(question));

    source.read.mockResolvedValue({
      provider: "cursor",
      messages: [
        {
          uuid: "disk-user",
          type: "user",
          cursorTurnIndex: 1,
          turnId: "cursor-turn-1",
          message: { role: "user", content: "详细审核一下该项目" },
        },
        tool,
      ],
      activity: "running",
      stamp: "2",
    });
    emit("status", { state: "idle" });
    await vi.waitFor(async () => {
      const next = await service.snapshot(selection);
      const settled = next.nodes.filter((node) => node.type === "question");
      expect(settled).toHaveLength(1);
      expect(JSON.stringify(settled[0])).toContain("disk-user");
      expect(JSON.stringify(settled)).not.toContain("live-user");
    });
  });
  it.each([
    "tool",
    "progress",
    "retry",
    "idle",
    "hold",
    "waiting-input",
    "completed",
    "failed",
    "interrupted",
  ])(
    "closes transient prose on %s and does not revive it on refresh/reconnect",
    async (boundary) => {
      vi.useFakeTimers();
      const { service, source, push } = fixture(10);
      const initial = await source.read();
      await service.subscribe(selection, vi.fn());
      const delta = (text: string) =>
        push("message", {
          type: "stream_event",
          uuid: "draft-turn",
          codexTurnId: "turn",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          },
        });
      delta("Partial text worth keeping");
      const texts = (snapshot: SessionDisplaySnapshot) =>
        snapshot.nodes.flatMap((n) =>
          n.type === "segment" && n.segment.type === "assistant_text"
            ? [n.segment]
            : [],
        );
      expect(texts(await service.snapshot(selection))[0]?.streaming).toBe(true);
      if (boundary === "tool")
        push("message", {
          type: "assistant",
          uuid: "tool-turn",
          codexTurnId: "turn",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call",
                name: "Bash",
                input: { command: "pwd" },
              },
            ],
          },
        });
      else if (boundary === "progress")
        push("message", {
          type: "assistant",
          uuid: "next-turn",
          codexTurnId: "turn",
          codexMessagePhase: "commentary",
          message: { role: "assistant", content: "Replacement progress" },
        });
      else if (boundary === "retry")
        push("retry-status", {
          retryStatus: { attempt: 1, message: "Retrying" },
        });
      else if (["idle", "hold", "waiting-input"].includes(boundary))
        push("status", { state: boundary });
      else
        push("message", {
          type: "system",
          subtype: "turn_complete",
          codexTurnId: "turn",
          turnStatus: boundary,
        });
      delta(" late token");
      expect(texts(await service.snapshot(selection))[0]).toMatchObject({
        content: "Partial text worth keeping",
        streaming: false,
      });
      source.read.mockResolvedValue({ ...initial, stamp: "2" });
      source.stamp.mockResolvedValue("2");
      await vi.advanceTimersByTimeAsync(25);
      const reconnect = vi.fn();
      await service.subscribe(selection, reconnect);
      const snapshot = reconnect.mock.calls.find(
        ([type]) => type === "display-snapshot",
      )?.[1];
      expect(texts(snapshot)[0]).toMatchObject({
        content: "Partial text worth keeping",
        streaming: false,
      });
    },
  );

  it("keeps stream blocks separate and closes each block without waiting for the assistant commit", async () => {
    const { service, source, push } = fixture();
    source.read.mockResolvedValue({
      ...(await source.read()),
      provider: "claude",
    });
    await service.subscribe(selection, vi.fn());
    const emit = (event: Record<string, unknown>) =>
      push("message", { type: "stream_event", uuid: "event", event });
    emit({ type: "message_start", message: { id: "claude-message" } });
    for (const [index, text] of ["First", "Second"].entries()) {
      emit({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      emit({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text },
      });
      emit({ type: "content_block_stop", index });
    }
    emit({ type: "message_stop" });
    const texts = (await service.snapshot(selection)).nodes.flatMap((n) =>
      n.type === "segment" && n.segment.type === "assistant_text"
        ? [n.segment]
        : [],
    );
    expect(texts).toMatchObject([
      { content: "First", streaming: false },
      { content: "Second", streaming: false },
    ]);
  });

  it("keeps a newer turn streaming when a late terminal event or delta arrives for the old turn", async () => {
    const { service, push } = fixture();
    await service.subscribe(selection, vi.fn());
    const delta = (turn: string, id: string) =>
      push("message", {
        type: "stream_event",
        uuid: `${id}-${turn}`,
        codexTurnId: turn,
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: id },
        },
      });
    delta("turn", "old");
    push("message", {
      type: "system",
      subtype: "turn_complete",
      codexTurnId: "turn",
      turnStatus: "interrupted",
    });
    delta("new-turn", "new");
    push("message", {
      type: "system",
      subtype: "turn_complete",
      codexTurnId: "turn",
      turnStatus: "interrupted",
    });
    delta("turn", "unknown-late-item");
    const texts = (await service.snapshot(selection)).nodes.flatMap((n) =>
      n.type === "segment" && n.segment.type === "assistant_text"
        ? [n.segment]
        : [],
    );
    expect(texts).toMatchObject([
      { content: "old", streaming: false },
      { content: "new", streaming: true },
    ]);
  });

  it("retires a superseded draft once its replacement progress is persisted, while the turn is still running", async () => {
    vi.useFakeTimers();
    const { service, source, push } = fixture(10);
    const initial = await source.read();
    await service.subscribe(selection, vi.fn());
    push("message", {
      type: "stream_event",
      uuid: "draft-turn",
      codexTurnId: "turn",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Abandoned wording" },
      },
    });
    const replacement: Message = {
      type: "assistant",
      uuid: "replacement-turn",
      codexTurnId: "turn",
      codexCorrelationKey: "codex:turn:agent-message:replacement",
      codexMessagePhase: "commentary",
      message: { role: "assistant", content: "Actual progress" },
    };
    push("message", replacement);
    expect(JSON.stringify((await service.snapshot(selection)).nodes)).toContain(
      "Abandoned wording",
    );
    source.read.mockResolvedValue({
      ...initial,
      messages: [...initial.messages, replacement],
      stamp: "2",
    });
    source.stamp.mockResolvedValue("2");
    await vi.advanceTimersByTimeAsync(25);
    const snapshot = await service.snapshot(selection);
    expect(snapshot.activity.state).toBe("running");
    expect(JSON.stringify(snapshot.nodes)).not.toContain("Abandoned wording");
    expect(JSON.stringify(snapshot.nodes)).toContain("Actual progress");
  });

  it("ignores stale catch-up text after a live stop or a persisted completion", async () => {
    const { service, source, push } = fixture();
    source.read.mockResolvedValue({
      ...(await source.read()),
      messages: [
        {
          uuid: "persisted-turn",
          type: "assistant",
          codexTurnId: "turn",
          codexCorrelationKey: "codex:turn:agent-message:persisted",
          message: { role: "assistant", content: "Final" },
        },
      ] as Message[],
    });
    await service.subscribe(selection, vi.fn());
    push("display-text-catchup", {
      messageId: "persisted-turn",
      text: "Partial",
    });
    push("message", {
      type: "stream_event",
      uuid: "draft-turn",
      codexTurnId: "turn",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Draft" },
      },
    });
    push("status", { state: "hold" });
    push("display-text-catchup", { messageId: "draft-turn", text: "Draft" });
    const texts = (await service.snapshot(selection)).nodes.flatMap((n) =>
      n.type === "segment" && n.segment.type === "assistant_text"
        ? [n.segment]
        : [],
    );
    expect(texts).toMatchObject([
      { content: "Final", streaming: false },
      { content: "Draft", streaming: false },
    ]);
  });

  it.each(["interAgentMessage", "subAgentActivity"])(
    "acknowledges persisted %s despite different live and rollout message ids",
    async (itemType) => {
      vi.useFakeTimers();
      const { service, source, push } = fixture(10);
      const initial = await source.read();
      await service.subscribe(selection, vi.fn());
      const native: Message = {
        uuid: "live-native",
        type: "system",
        subtype: "codex_native_item",
        codexThreadId: "session",
        codexTurnId: "turn",
        codexThreadItemLifecycle: "completed",
        codexThreadItem:
          itemType === "interAgentMessage"
            ? {
                type: itemType,
                id: "mail-id",
                kind: "result",
                sender: "/root/review",
                recipient: "/root",
                text: "Review complete",
                encrypted: false,
              }
            : {
                type: itemType,
                id: "child-complete",
                kind: "completed",
                agentThreadId: "child",
                agentPath: "/root/review",
              },
      };
      push("message", native);
      expect(
        (await service.snapshot(selection)).nodes.filter(
          (node) => node.type === "segment",
        ),
      ).toHaveLength(1);
      source.read.mockResolvedValue({
        ...initial,
        messages: [...initial.messages, { ...native, uuid: "rollout-native" }],
        stamp: "2",
      });
      source.stamp.mockResolvedValue("2");
      await vi.advanceTimersByTimeAsync(30);
      expect(
        (await service.snapshot(selection)).nodes.filter(
          (node) => node.type === "segment",
        ),
      ).toHaveLength(1);
      // A later history rewrite must not resurrect the acknowledged overlay.
      source.read.mockResolvedValue({ ...initial, stamp: "3" });
      source.stamp.mockResolvedValue("3");
      await vi.advanceTimersByTimeAsync(30);
      expect(
        (await service.snapshot(selection)).nodes.filter(
          (node) => node.type === "segment",
        ),
      ).toHaveLength(0);
    },
  );

  it.each(["completed", "failed", "interrupted"] as const)(
    "retains an id-less Codex %s notification while history lags",
    async (outcome) => {
      vi.useFakeTimers();
      const { service, source, push } = fixture(10);
      const initial = await source.read();
      await service.subscribe(selection, vi.fn());
      const answer: Message = {
        type: "assistant",
        uuid: "answer-turn",
        codexTurnId: "turn",
        codexMessagePhase: "final_answer",
        message: { role: "assistant", content: "Done" },
      };
      push("message", answer);
      expect((await service.snapshot(selection)).activity.state).toBe(
        "finishing",
      );
      push("message", {
        type: "system",
        subtype: "turn_complete",
        codexTurnId: "turn",
        turnStatus: outcome,
      });
      await vi.advanceTimersByTimeAsync(30);
      expect((await service.snapshot(selection)).activity.state).toBe(outcome);

      // Completion timing may reach history before the runtime idle snapshot.
      source.read.mockResolvedValue({
        ...initial,
        messages: [...initial.messages, answer],
        turnStatuses: { turn: outcome },
        activity: "running",
        stamp: "2",
      });
      source.stamp.mockResolvedValue("2");
      await vi.advanceTimersByTimeAsync(30);
      expect((await service.snapshot(selection)).activity.state).toBe(outcome);
      const reconnect = vi.fn();
      await service.subscribe(selection, reconnect);
      expect(
        reconnect.mock.calls.find(([type]) => type === "display-snapshot")?.[1]
          .activity.state,
      ).toBe(outcome);

      // A new turn can be live before it is in the history page.
      push("status", { state: "in-turn" });
      push("message", {
        type: "user",
        uuid: "next-question",
        codexTurnId: "next-turn",
        message: { role: "user", content: "Continue" },
      });
      push("message", {
        type: "assistant",
        uuid: "next-answer",
        codexTurnId: "next-turn",
        codexMessagePhase: "commentary",
        message: { role: "assistant", content: "Working" },
      });
      // Force a source refresh while the old completion is still retained.
      push("status", { state: "idle" });
      await vi.advanceTimersByTimeAsync(30);
      expect((await service.snapshot(selection)).activity.state).toBe(
        "running",
      );
    },
  );

  it.each(["codex", "codex-oss"])(
    "retires abandoned %s retry text only after the completed answer reaches history",
    async (provider) => {
      vi.useFakeTimers();
      const { service, source, push } = fixture(10);
      const initial = { ...(await source.read()), provider };
      source.read.mockResolvedValue(initial);
      let live: SessionDisplaySnapshot | undefined;
      await service.subscribe(selection, (type, data) => {
        if (type === "display-snapshot")
          live = SessionDisplaySnapshotSchema.parse(data);
        if (type === "display-patch" && live) {
          const next = applySessionDisplayPatch(
            live,
            SessionDisplayPatchSchema.parse(data),
          );
          if (!next) throw new Error("Expected applicable patch");
          live = next;
        }
      });
      const texts = (snapshot: SessionDisplaySnapshot | undefined) =>
        snapshot?.nodes.flatMap((node) =>
          node.type === "segment" && node.segment.type === "assistant_text"
            ? [
                {
                  content: node.segment.content,
                  streaming: node.segment.streaming,
                },
              ]
            : [],
        );
      const delta = (item: string, turn: string, text: string) =>
        push("message", {
          type: "stream_event",
          uuid: `${item}-${turn}`,
          codexTurnId: turn,
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        });
      delta("abandoned", "turn", "Original answer cut off");
      const answer: Message = {
        type: "assistant",
        uuid: "replacement-turn",
        codexTurnId: "turn",
        codexCorrelationKey: "codex:turn:agent-message:replacement",
        codexMessagePhase: "final_answer",
        message: { role: "assistant", content: "Complete retry answer" },
      };
      push("message", answer);
      push("message", {
        type: "system",
        subtype: "turn_complete",
        codexTurnId: "turn",
        turnStatus: "completed",
      });
      // The completion event can precede the source's final persisted page.
      await vi.advanceTimersByTimeAsync(11);
      expect(texts(await service.snapshot(selection))).toContainEqual({
        content: "Original answer cut off",
        streaming: false,
      });

      delta("next", "next-turn", "Next turn in progress");
      const unpersisted: Message = {
        ...answer,
        uuid: "progress-turn",
        codexCorrelationKey: "codex:turn:agent-message:progress",
        codexMessagePhase: "commentary",
        message: { role: "assistant", content: "Completed live progress" },
      };
      push("message", unpersisted);
      source.read.mockResolvedValue({
        ...initial,
        messages: [...initial.messages, answer],
        turnStatuses: { turn: "completed" },
        // A newer turn can already be running when the old turn is persisted.
        activity: "running",
        stamp: "2",
      });
      source.stamp.mockResolvedValue("2");
      await vi.advanceTimersByTimeAsync(11);
      const snapshot = await service.snapshot(selection);
      const expected = [
        { content: "Complete retry answer", streaming: false },
        { content: "Next turn in progress", streaming: true },
        { content: "Completed live progress", streaming: false },
      ];
      expect(texts(snapshot)).toEqual(expected);
      expect(texts(live)).toEqual(expected);

      const reconnect = vi.fn();
      await service.subscribe(selection, reconnect);
      expect(
        texts(
          reconnect.mock.calls.find(
            ([type]) => type === "display-snapshot",
          )?.[1],
        ),
      ).toEqual(expected);
      // Subsequent history refreshes must not resurrect the old overlay.
      source.stamp.mockResolvedValue("3");
      await vi.advanceTimersByTimeAsync(11);
      expect(texts(await service.snapshot(selection))).toEqual(expected);
    },
  );

  it.each([
    { status: "running", final: true },
    { status: undefined, final: true },
    { status: "completed", final: false },
    { status: "failed", final: false },
    { status: "interrupted", final: false },
  ] as const)(
    "preserves unmatched text without a persisted completed answer ($status, final=$final)",
    async ({ status, final }) => {
      vi.useFakeTimers();
      const { service, source, push } = fixture(10);
      const initial = await source.read();
      await service.subscribe(selection, vi.fn());
      push("message", {
        type: "stream_event",
        uuid: "draft-turn",
        codexTurnId: "turn",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Only available partial answer" },
        },
      });
      source.read.mockResolvedValue({
        ...initial,
        messages: [
          ...initial.messages,
          {
            type: "assistant",
            uuid: "persisted-turn",
            codexTurnId: "turn",
            codexMessagePhase: final ? "final_answer" : "commentary",
            message: { role: "assistant", content: "Persisted text" },
          },
        ],
        ...(status ? { turnStatuses: { turn: status } } : {}),
        // Session-wide completion alone is not proof about this native turn.
        activity: "completed",
        stamp: "2",
      });
      source.stamp.mockResolvedValue("2");
      await vi.advanceTimersByTimeAsync(11);
      expect(
        JSON.stringify((await service.snapshot(selection)).nodes),
      ).toContain("Only available partial answer");
    },
  );

  it("keeps a Pi compaction spinner across source refreshes until it closes", async () => {
    const { service, source, push } = fixture();
    const page: DisplaySourcePage = {
      provider: "pi",
      messages: [
        {
          uuid: "u",
          type: "user",
          message: { role: "user", content: "Run" },
        },
      ] as Message[],
      activity: "completed",
      stamp: "1",
    };
    source.read.mockResolvedValue(page);
    await service.subscribe(selection, vi.fn());
    push("message", {
      type: "system",
      subtype: "status",
      status: "compacting",
      uuid: "pi-compaction-status-1",
    });
    expect((await service.snapshot(selection)).activity.isCompacting).toBe(
      true,
    );
    // The resumed process reports idle before the compaction job starts its
    // busy period; the resulting history refresh must not drop the spinner.
    source.read.mockResolvedValue({ ...page, stamp: "2" });
    source.stamp.mockResolvedValue("2");
    push("status", { state: "idle" });
    await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      expect((await service.snapshot(selection)).activity).toMatchObject({
        state: "running",
        isCompacting: true,
      });
    });
    push("message", {
      type: "system",
      subtype: "status",
      status: null,
      uuid: "pi-compaction-status-1",
    });
    source.read.mockResolvedValue({ ...page, stamp: "3" });
    source.stamp.mockResolvedValue("3");
    push("status", { state: "idle" });
    await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(3));
    await vi.waitFor(async () => {
      expect(
        (await service.snapshot(selection)).activity.isCompacting,
      ).not.toBe(true);
    });
  });

  it.each(["completed", "failed", "interrupted"])(
    "does not replay compaction progress after a %s turn",
    async (outcome) => {
      const { service, source, push } = fixture();
      await service.subscribe(selection, vi.fn());
      push("message", {
        type: "system",
        subtype: "status",
        status: "compacting",
        uuid: "compact-turn",
        codexTurnId: "turn",
      });
      expect((await service.snapshot(selection)).activity.isCompacting).toBe(
        true,
      );
      source.read.mockResolvedValue({
        provider: "codex",
        messages: [],
        activity: outcome as "completed" | "failed" | "interrupted",
        stamp: "2",
        turnStatuses: {
          turn: outcome as "completed" | "failed" | "interrupted",
        },
      });
      source.stamp.mockResolvedValue("2");
      push("message", {
        type: "system",
        subtype: "turn_complete",
        codexTurnId: "turn",
        turnStatus: outcome,
      });
      await vi.waitFor(async () => {
        expect(
          (await service.snapshot(selection)).activity.isCompacting,
        ).not.toBe(true);
      });
      const emit = vi.fn();
      await service.subscribe(selection, emit);
      expect(
        emit.mock.calls.some(
          ([type, data]) => type === "message" && data.status === "compacting",
        ),
      ).toBe(false);
    },
  );

  it.each([11, 55])(
    "reads all %i closed-group steps from the displayed index despite reordered history",
    async (count) => {
      const { service, source, push } = fixture();
      await service.subscribe(selection, vi.fn());
      const invocation = (id: string): Message => ({
        uuid: `${id}-turn`,
        type: "assistant",
        codexTurnId: "turn",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id,
              name: "Bash",
              input: { command: `run ${id}` },
            },
          ],
        },
      });
      const result = (id: string): Message => ({
        uuid: `${id}-result`,
        type: "user",
        codexTurnId: "turn",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              content: "RESULT_BODY_SHOULD_STAY_LAZY",
            },
          ],
        },
      });
      const progress: Message = {
        uuid: "progress-turn",
        type: "assistant",
        codexTurnId: "turn",
        codexMessagePhase: "commentary",
        message: { role: "assistant", content: "Checking progress" },
      };
      const fastCalls = Array.from({ length: count - 1 }, (_, i) =>
        invocation(`fast-${i}`),
      );
      push("message", invocation("slow"));
      for (const [index, call] of fastCalls.entries()) {
        push("message", call);
        push("message", result(`fast-${index}`));
      }
      push("message", progress);
      push("message", invocation("later"));
      // Persisted completion order moves the group's first tool past progress
      // and into another group. Reconstructing the displayed group loses its ID.
      source.detail.mockResolvedValue([
        ...fastCalls,
        progress,
        invocation("later"),
        invocation("slow"),
        result("slow"),
      ]);
      const groupId = displayToolId("turn", "slow").replace("dt2.", "dg2.");
      const snapshot = await service.snapshot(selection);
      // A Codex command can remain in the background across later batches.
      // It stays in its original group until its own result arrives.
      expect(snapshot.nodes.find((node) => node.id === groupId)).toMatchObject({
        segment: {
          count,
          displayMode: "summary",
          runningCount: 1,
          unknownCount: 0,
        },
      });
      const first = await service.group(selection, groupId);
      expect(first.total).toBe(count);
      expect(first.steps).toHaveLength(Math.min(50, count));
      const earlier = first.nextCursor
        ? await service.group(selection, groupId, first.nextCursor)
        : undefined;
      const steps = [...(earlier?.steps ?? []), ...first.steps];
      expect(steps.map((step) => step.id)).toEqual([
        displayToolId("turn", "slow"),
        ...fastCalls.map((_, i) => displayToolId("turn", `fast-${i}`)),
      ]);
      expect(steps.every((step) => step.groupId === groupId)).toBe(true);
      expect(steps[0]).toMatchObject({
        status: "running",
        summary: "run slow",
      });
      expect(earlier?.nextCursor).toBeUndefined();
      expect(JSON.stringify(steps)).not.toContain(
        "RESULT_BODY_SHOULD_STAY_LAZY",
      );

      push("message", result("slow"));
      const updated = await service.group(
        selection,
        groupId,
        String(count > 50 ? 5 : count),
      );
      // Completion updates the same group even after it has collapsed.
      expect(updated.steps[0]).toMatchObject({ status: "completed" });
      expect(updated.total).toBe(count);
      expect(source.detail).not.toHaveBeenCalled();
      expect(source.read).toHaveBeenCalledTimes(1);
    },
  );
  it("loads a group outside the current projection from history and paginates it", async () => {
    const { service, source } = fixture();
    const messages = Array.from(
      { length: 55 },
      (_, i): Message => ({
        uuid: `old-${i}`,
        type: "assistant",
        codexTurnId: "older-turn",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `old-${i}`,
              name: "Bash",
              input: { command: `old ${i}` },
            },
          ],
        },
      }),
    );
    source.detail.mockResolvedValue(messages);
    const groupId = displayToolId("older-turn", "old-0").replace(
      "dt2.",
      "dg2.",
    );
    const page = await service.group(selection, groupId);
    expect(page).toMatchObject({ total: 55, nextCursor: "5" });
    expect(page.steps).toHaveLength(50);
    const earlier = await service.group(selection, groupId, page.nextCursor);
    expect(earlier.steps).toHaveLength(5);
    expect(earlier.steps[0]?.id).toBe(displayToolId("older-turn", "old-0"));
    expect(earlier.nextCursor).toBeUndefined();
    expect(source.detail).toHaveBeenCalledWith(selection, "older-turn");
  });
  it.each([
    ["Bash", false],
    ["Bash", true],
    ["CodexExec", false],
  ] as const)(
    "preserves %s invocation metadata across output deltas and source refreshes (replay=%s)",
    async (name, isReplay) => {
      vi.useFakeTimers();
      const { service, source, push } = fixture(10);
      const initial = await source.read();
      const script = 'text(await tools.exec_command({cmd:"pnpm test"}));';
      const input = name === "Bash" ? { command: "pnpm test" } : { script };
      const invocation = {
        uuid: "command-turn",
        type: "assistant",
        codexTurnId: "turn",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "command",
              name,
              input,
              status: "in_progress",
            },
          ],
        },
      };
      await service.subscribe(selection, vi.fn());
      push("message", { ...invocation, isReplay });
      push("message", {
        ...invocation,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "command", partialOutput: "first output" },
          ],
        },
      });
      source.read.mockResolvedValue({ ...initial, stamp: "2" });
      source.stamp.mockResolvedValue("2");
      await vi.advanceTimersByTimeAsync(25);
      expect(source.read).toHaveBeenCalledTimes(3);
      const snapshot = await service.snapshot(selection);
      const groupId = displayToolId("turn", "command").replace("dt2.", "dg2.");
      expect(snapshot.activity.runningCount).toBe(1);
      expect((await service.group(selection, groupId)).steps).toMatchObject([
        {
          name,
          status: "running",
          summary: name === "Bash" ? "pnpm test" : script,
        },
      ]);
      expect(
        await service.output(selection, displayToolId("turn", "command")),
      ).toMatchObject({
        status: "running",
        output: "first output",
      });
      const detail = await service.detail(
        selection,
        displayToolId("turn", "command"),
      );
      expect(detail.messages[0]?.message?.content).toMatchObject([
        { type: "tool_use", name, input, status: "in_progress" },
      ]);
    },
  );

  it("reports unavailable tool details instead of returning a blank successful response", async () => {
    const { service } = fixture();
    await expect(
      service.detail(selection, displayToolId("turn", "missing")),
    ).rejects.toThrow("Tool invocation is unavailable");
  });

  it("retains per-call image previews in the compact live tool replay", () => {
    const message = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "image",
            name: "ViewImage",
            input: {
              path: "/tmp/phone.png",
              snapshotUrl: "/api/sessions/session/codex-images/image",
            },
          },
        ],
      },
    };
    expect(compactDisplayMessage(message).message).toMatchObject(
      message.message,
    );
  });
  it("conditionally reads only the bounded in-memory tail without revisiting history", async () => {
    const { service, source, push } = fixture();
    await service.subscribe(selection, vi.fn());
    const toolId = displayToolId("turn", "output-command");
    const emitOutput = (partialOutput: string) =>
      push("message", {
        uuid: "output-command-turn",
        type: "assistant",
        codexTurnId: "turn",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "output-command",
              name: "Bash",
              input: { command: "pnpm test", longInput: "x".repeat(140_000) },
              partialOutput,
            },
          ],
        },
      });
    emitOutput(`${"x".repeat(3_000)}first`);
    await service.snapshot(selection);
    const first = await service.output(selection, toolId);
    expect(first.output).toHaveLength(2_048);
    expect(first.output).toMatch(/first$/);
    for (let i = 0; i < 3; i++) {
      const unchanged = await service.output(selection, toolId, first.revision);
      expect(unchanged).toEqual({
        revision: first.revision,
        status: "running",
      });
      expect(Buffer.byteLength(JSON.stringify(unchanged))).toBeLessThan(100);
    }
    emitOutput(`${"x".repeat(3_000)}later`);
    await service.snapshot(selection);
    const changed = await service.output(selection, toolId, first.revision);
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.output).toMatch(/later$/);
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(source.detail).not.toHaveBeenCalled();
    push("message", {
      uuid: "output-result",
      type: "user",
      codexTurnId: "turn",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "output-command",
            content: "all passed",
          },
        ],
      },
    });
    await service.snapshot(selection);
    expect(
      await service.output(selection, toolId, changed.revision),
    ).toMatchObject({
      status: "completed",
      output: "",
    });
    expect(source.detail).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves the latest running output when persisted detail has none (paged: %s)",
    async (paged) => {
      const { service, source, push } = fixture();
      await service.subscribe(selection, vi.fn());
      const invocation: Message = {
        uuid: "command-turn",
        type: "assistant",
        codexTurnId: "turn",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "command",
              name: "Bash",
              input: { command: paged ? "x".repeat(140_000) : "pnpm test" },
            },
          ],
        },
      };
      source.detail.mockResolvedValue([invocation]);
      push("message", invocation);
      push("message", {
        uuid: "command-turn",
        type: "assistant",
        codexTurnId: "turn",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "command",
              partialOutput: `${"x".repeat(3_000)}latest progress`,
            },
          ],
        },
      });
      push("message", {
        uuid: "progress-turn",
        type: "assistant",
        codexTurnId: "turn",
        message: { role: "assistant", content: "Continuing another step" },
      });
      await service.snapshot(selection);
      const detail = await service.detail(
        selection,
        displayToolId("turn", "command"),
      );
      expect(source.detail).toHaveBeenCalled();
      expect(detail.liveOutput).toHaveLength(2_048);
      expect(detail.liveOutput).toMatch(/latest progress$/);
      expect(
        await service.output(
          selection,
          displayToolId("turn", "command"),
          detail.liveOutputRevision,
        ),
      ).toEqual({ revision: detail.liveOutputRevision, status: "running" });
      expect(Boolean(detail.rawJson)).toBe(paged);
      push("message", {
        uuid: "command-result",
        type: "user",
        codexTurnId: "turn",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "command",
              content: "all passed",
            },
          ],
        },
      });
      await service.snapshot(selection);
      expect(
        (await service.detail(selection, displayToolId("turn", "command")))
          .liveOutput,
      ).toBeUndefined();
    },
  );

  it.each([false, true])(
    "restores the latest deferred queue on reconnect (drained: %s)",
    async (drained) => {
      const { service, push, runtime } = fixture();
      const first = await service.subscribe(selection, vi.fn());
      push("connected", {
        sessionId: selection.sessionId,
        state: "in-turn",
        deferredMessages: [],
      });
      const queued = [{ tempId: "queued-1", content: "Next task" }];
      push("deferred-queue", { messages: queued });
      first.cleanup();
      if (drained) push("deferred-queue", { messages: [] });
      const emit = vi.fn();
      await service.subscribe(selection, emit);
      expect(emit).toHaveBeenCalledWith(
        "connected",
        expect.objectContaining({
          deferredMessages: drained ? [] : queued,
        }),
      );
      expect(runtime.subscribeSession).toHaveBeenCalledTimes(1);
    },
  );

  it("uses a fresh runtime connection's deferred queue after process replacement", async () => {
    const { service, push } = fixture();
    const first = await service.subscribe(selection, vi.fn());
    push("deferred-queue", {
      messages: [{ tempId: "old-queue", content: "Old task" }],
    });
    push("connected", { sessionId: selection.sessionId, state: "in-turn" });
    first.cleanup();
    const emit = vi.fn();
    await service.subscribe(selection, emit);
    const connected = emit.mock.calls.find(([type]) => type === "connected");
    expect(connected?.[1].deferredMessages ?? []).toEqual([]);
  });

  it("moves a late subscriber off a temporary ID the runtime already replaced", async () => {
    const { service, push } = fixture();
    await service.subscribe(selection, vi.fn());
    push("session-id-changed", {
      oldSessionId: selection.sessionId,
      newSessionId: "durable",
    });
    const emit = vi.fn();
    await service.subscribe(selection, emit);
    expect(emit).toHaveBeenCalledWith(
      "connected",
      expect.objectContaining({ sessionId: selection.sessionId }),
    );
    expect(emit).toHaveBeenCalledWith("session-id-changed", {
      oldSessionId: selection.sessionId,
      newSessionId: "durable",
    });
  });

  it("reports the attached process ID when the rename predates the view", async () => {
    const { service, push } = fixture();
    await service.subscribe(selection, vi.fn());
    // A view created after the rename only sees the runtime's connected ID.
    push("connected", { sessionId: "durable", state: "idle" });
    const emit = vi.fn();
    await service.subscribe(selection, emit);
    expect(emit).toHaveBeenCalledWith("session-id-changed", {
      oldSessionId: selection.sessionId,
      newSessionId: "durable",
    });

    const unchanged = vi.fn();
    push("connected", { sessionId: selection.sessionId, state: "idle" });
    await service.subscribe(selection, unchanged);
    expect(
      unchanged.mock.calls.some(([type]) => type === "session-id-changed"),
    ).toBe(false);
  });

  it("renders safe Markdown and file links in cold, older and live projections", async () => {
    const { service, source, push } = fixture();
    const initial = await source.read();
    const markdown =
      "**会自动更新**\n\n1. 查看 [服务端逻辑](/Users/yueyuan/project/server.ts:711)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))";
    const table = "\n\n| 比较项 | 关系 |\n|---|---|\n| 词表 | 通常相同 |";
    const reply: Message = {
      uuid: "answer",
      type: "assistant",
      codexTurnId: "turn",
      message: { role: "assistant", content: markdown + table },
    };
    source.read.mockResolvedValue({
      ...initial,
      messages: [...initial.messages, reply],
    });
    const assertRendered = (value: SessionDisplaySnapshot, label: string) => {
      const snapshot = SessionDisplaySnapshotSchema.parse(value);
      const segment = snapshot.nodes.at(-1);
      if (
        segment?.type !== "segment" ||
        segment.segment.type !== "assistant_text"
      )
        throw new Error("Expected assistant text");
      const html = segment.segment.renderedHtml;
      expect(html).toContain('class="markdown-table-wrapper"');
      expect(html).toContain("<th>比较项</th>");
      expect(html).toContain("<td>通常相同</td>");
      expect(html).toContain(`<strong>${label}</strong>`);
      expect(html).toContain("<ol>");
      expect(html).toContain('class="local-file-link"');
      expect(html).toContain(
        'data-file-path="/Users/yueyuan/project/server.ts"',
      );
      expect(html).toContain('data-line="711"');
      expect(html).not.toContain("<script>");
      expect(html).not.toContain('href="javascript:');
    };
    const cold = await service.snapshot(selection);
    assertRendered(cold, "会自动更新");
    assertRendered(await service.older(selection, "older"), "会自动更新");
    let live = cold;
    await service.subscribe(selection, (type, data) => {
      if (type === "display-snapshot") live = data as SessionDisplaySnapshot;
      if (type === "display-patch") {
        const next = applySessionDisplayPatch(
          live,
          SessionDisplayPatchSchema.parse(data),
        );
        if (!next) throw new Error("Expected applicable patch");
        live = next;
      }
    });
    push("message", {
      ...reply,
      uuid: "live-answer",
      _isStreaming: true,
      message: {
        role: "assistant",
        content: markdown.replace("会自动更新", "更新中") + table,
      },
    });
    await service.snapshot(selection);
    assertRendered(live, "更新中");
    push("message", {
      ...reply,
      uuid: "live-answer",
      message: {
        role: "assistant",
        content: markdown.replace("会自动更新", "更新完成") + table,
      },
    });
    await service.snapshot(selection);
    assertRendered(live, "更新完成");
    expect(source.detail).not.toHaveBeenCalled();
  });

  it("does not resurrect acknowledged tools after a persisted history rewrite", async () => {
    vi.useFakeTimers();
    const { service, source, push } = fixture(10);
    await service.subscribe(selection, vi.fn());
    const initial = await source.read();
    const events: Message[] = [
      {
        uuid: "a-turn",
        type: "assistant",
        codexTurnId: "turn",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "a",
              name: "Bash",
              input: { command: "pnpm test" },
            },
          ],
        },
      },
      {
        uuid: "a-result",
        type: "user",
        codexTurnId: "turn",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a", content: "passed" },
          ],
        },
      },
      {
        uuid: "p-turn",
        type: "assistant",
        codexTurnId: "turn",
        message: { role: "assistant", content: "Done" },
      },
    ];
    for (const message of events) push("message", message);
    const before = await service.snapshot(selection);
    source.stamp.mockResolvedValue("2");
    source.read.mockResolvedValue({
      ...initial,
      messages: [...initial.messages, ...events],
      stamp: "2",
    });
    await vi.advanceTimersByTimeAsync(11);
    source.stamp.mockResolvedValue("3");
    source.read.mockResolvedValue({ ...initial, stamp: "3" });
    await vi.advanceTimersByTimeAsync(11);
    const after = await service.snapshot(selection);
    expect(after.view.epoch).not.toBe(before.view.epoch);
    expect(after.nodes).toHaveLength(1);
  });

  it("keeps child streaming state out of the parent text accumulator", async () => {
    const { service, push } = fixture();
    await service.subscribe(selection, vi.fn());
    push("message", {
      type: "stream_event",
      event: { type: "message_start", message: { id: "main-turn" } },
    });
    push("message", {
      type: "stream_event",
      uuid: "main-turn",
      codexTurnId: "turn",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "A" },
      },
    });
    push("message", {
      type: "stream_event",
      isSubagent: true,
      event: { type: "message_start", message: { id: "child" } },
    });
    push("message", {
      type: "stream_event",
      uuid: "main-turn",
      codexTurnId: "turn",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "B" },
      },
    });
    const snapshot = await service.snapshot(selection);
    expect(
      snapshot.nodes.flatMap((n) =>
        n.type === "segment" && n.segment.type === "assistant_text"
          ? [n.segment.content]
          : [],
      ),
    ).toEqual(["AB"]);
  });

  it("rejects child thread output without relying on a subagent flag", async () => {
    const { service, source, push } = fixture(10);
    vi.useFakeTimers();
    await service.subscribe(selection, vi.fn());
    const before = await service.snapshot(selection);
    for (const isReplay of [false, true]) {
      push("message", {
        uuid: "child-review",
        type: "assistant",
        codexThreadId: "child-thread",
        codexTurnId: "child-turn",
        isReplay,
        message: { role: "assistant", content: "Disposition: fix" },
      });
    }
    source.stamp.mockResolvedValue("2");
    await vi.advanceTimersByTimeAsync(11);
    expect((await service.snapshot(selection)).nodes).toEqual(before.nodes);
  });

  it.each([false, true])(
    "reconciles old unscoped reviews only against native history (native: %s)",
    async (native) => {
      vi.useFakeTimers();
      const { service, source, push } = fixture(10);
      const initial = await source.read();
      await service.subscribe(selection, vi.fn());
      const from = Date.parse("2026-09-08T14:00:00Z");
      const before = Date.parse("2026-09-08T14:50:00Z");
      const messages = [
        { id: "fix", turn: "child-review", time: "2026-09-08T14:05:44Z" },
        { id: "ship", turn: "child-recheck", time: "2026-09-08T14:07:40Z" },
        { id: "parent", turn: "turn", time: "2026-09-08T14:06:00Z" },
        { id: "new", turn: "not-persisted", time: "2026-09-08T14:51:00Z" },
        { id: "outside-page", turn: "older", time: "2026-09-08T13:59:00Z" },
      ];
      for (const m of messages)
        push("message", {
          uuid: m.id,
          type: "assistant",
          codexTurnId: m.turn,
          timestamp: m.time,
          message: { role: "assistant", content: m.id },
        });
      source.read.mockResolvedValue({
        ...initial,
        ...(native
          ? { codexTurnWindow: { turnIds: ["turn", "latest"], from, before } }
          : {}),
      });
      for (const stamp of ["2", "3"]) {
        source.stamp.mockResolvedValue(stamp);
        await vi.advanceTimersByTimeAsync(11);
        const snapshot = await service.snapshot(selection);
        const texts = snapshot.nodes.flatMap((node) =>
          node.type === "segment" && node.segment.type === "assistant_text"
            ? [node.segment.content]
            : [],
        );
        expect(texts).toEqual(
          native
            ? ["parent", "new", "outside-page"]
            : messages.map((m) => m.id),
        );
      }
    },
  );

  it("projects fatal runtime errors and retains hold across tool updates", async () => {
    const { service, push } = fixture();
    await service.subscribe(selection, vi.fn());
    push("status", { state: "hold" });
    push("message", {
      uuid: "a-turn",
      type: "assistant",
      codexTurnId: "turn",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "a",
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
      },
    });
    expect((await service.snapshot(selection)).activity.state).toBe("hold");
    push("error", { message: "Process failed" });
    expect((await service.snapshot(selection)).activity.state).toBe("failed");
  });
  it("subscribes before reading, then snapshots and streams only display patches", async () => {
    const { service, source, runtime, push } = fixture();
    const emit = vi.fn();
    await service.subscribe(selection, emit);
    expect(runtime.subscribeSession.mock.invocationCallOrder[0]).toBeLessThan(
      required(source.read.mock.invocationCallOrder[0]),
    );
    let snapshot = required(
      emit.mock.calls.find((c) => c[0] === "display-snapshot"),
    )[1] as SessionDisplaySnapshot;
    push("message", {
      uuid: "a-turn",
      type: "assistant",
      codexTurnId: "turn",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "a",
            name: "Bash",
            input: { command: "pnpm test", secretBody: "NOT_ON_DEFAULT_WIRE" },
          },
        ],
      },
    });
    await service.snapshot(selection); // flush the ordered transaction
    const patch = required(
      emit.mock.calls.find((c) => c[0] === "display-patch"),
    )[1];
    snapshot = required(applySessionDisplayPatch(snapshot, patch));
    expect(snapshot.nodes).toHaveLength(2);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(
      "NOT_ON_DEFAULT_WIRE",
    );
    expect(emit.mock.calls.filter((c) => c[0] === "message")).toEqual([]);
  });
  it("rebases a returning client without replaying closed tool bodies", async () => {
    const { service, push } = fixture();
    const first = vi.fn();
    const subscription = await service.subscribe(selection, first);
    push("message", {
      uuid: "a-turn",
      type: "assistant",
      codexTurnId: "turn",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "a",
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
      },
    });
    push("message", {
      uuid: "a-result",
      type: "user",
      codexTurnId: "turn",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "a",
            content: "RESULT_BODY_SHOULD_STAY_LAZY",
          },
        ],
      },
    });
    push("message", {
      uuid: "p-turn",
      type: "assistant",
      codexTurnId: "turn",
      codexMessagePhase: "commentary",
      message: { role: "assistant", content: "Step done" },
    });
    subscription.cleanup();
    const returning = vi.fn();
    await service.subscribe(selection, returning);
    const snapshot = required(
      returning.mock.calls.find((c) => c[0] === "display-snapshot"),
    )[1] as SessionDisplaySnapshot;
    expect(JSON.stringify(snapshot)).not.toContain(
      "RESULT_BODY_SHOULD_STAY_LAZY",
    );
    const closedGroup = snapshot.nodes.find(
      (n) =>
        n.type === "segment" &&
        n.segment.type === "tool_group" &&
        n.segment.displayMode === "summary",
    );
    if (
      closedGroup?.type !== "segment" ||
      closedGroup.segment.type !== "tool_group"
    )
      throw new Error("Expected a closed tool group");
    expect(closedGroup.segment.steps).toBeUndefined();
    expect(closedGroup.segment.toolNames).toEqual([]);
    expect(returning.mock.calls.map((c) => c[0])).toEqual([
      "connected",
      "display-snapshot",
    ]);
  });
  it("does not let one reader closing stop the shared source", async () => {
    const { service, runtime } = fixture();
    const a = await service.subscribe(selection, vi.fn());
    await service.subscribe(selection, vi.fn());
    a.cleanup();
    expect(runtime.subscribeSession).toHaveBeenCalledTimes(1);
    const subscription = await required(
      runtime.subscribeSession.mock.results[0],
    ).value;
    expect(subscription.cleanup).not.toHaveBeenCalled();
  });
  it("shows the prompt a replacement process was started with before the projection attached", async () => {
    vi.useFakeTimers();
    const { service, source, runtime, push } = fixture(1_000);
    const firstTurn = [
      {
        uuid: "disk-user-1",
        type: "user",
        cursorTurnIndex: 1,
        turnId: "cursor-turn-1",
        message: { role: "user", content: "First question" },
      },
      {
        uuid: "disk-answer-1",
        type: "assistant",
        cursorTurnIndex: 1,
        turnId: "cursor-turn-1",
        message: { role: "assistant", content: "First answer" },
      },
    ] as Message[];
    source.read.mockResolvedValue({
      provider: "cursor",
      messages: firstTurn,
      activity: "completed",
      stamp: "1",
    });
    runtime.getProcessForSession.mockResolvedValue({
      id: "process-a",
    } as never);
    await service.subscribe(selection, vi.fn());

    // The old process exits (idle restart); a new one is started with the
    // next prompt and buffers it before the projection resubscribes.
    push("complete", {});
    runtime.getProcessForSession.mockResolvedValue({
      id: "process-b",
    } as never);
    runtime.subscribeSession.mockImplementation(async (_id, send) => {
      send("message", {
        isReplay: true,
        isOptimistic: true,
        type: "user",
        uuid: "live-user-2",
        cursorTurnIndex: 2,
        turnId: "cursor-turn-2",
        message: { role: "user", content: "Second question" },
      });
      return { cleanup: vi.fn() };
    });
    await vi.advanceTimersByTimeAsync(1_000);

    const snapshot = await service.snapshot(selection);
    const questions = snapshot.nodes.filter((node) => node.type === "question");
    expect(questions).toHaveLength(2);
    expect(JSON.stringify(questions[1])).toContain("Second question");
  });
  it("keeps treating replay as seen when resubscribing to the same process", async () => {
    vi.useFakeTimers();
    const { service, runtime, push } = fixture(1_000);
    await service.subscribe(selection, vi.fn());
    push("complete", {});
    runtime.subscribeSession.mockImplementation(async (_id, send) => {
      send("message", {
        isReplay: true,
        type: "user",
        uuid: "replayed-user",
        codexTurnId: "turn-2",
        message: { role: "user", content: "Already seen" },
      });
      return { cleanup: vi.fn() };
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.subscribeSession).toHaveBeenCalledTimes(2);
    const snapshot = await service.snapshot(selection);
    expect(JSON.stringify(snapshot)).not.toContain("Already seen");
  });

  it("resubscribes after the runtime stream is lost without completing", async () => {
    vi.useFakeTimers();
    const { service, runtime } = fixture(1_000);
    let loseStream: ((error: unknown) => void) | undefined;
    const firstCleanup = vi.fn();
    runtime.subscribeSession.mockImplementationOnce(
      async (_id, _emit, options?: { onError?: (error: unknown) => void }) => {
        loseStream = options?.onError;
        return { cleanup: firstCleanup };
      },
    );
    await service.subscribe(selection, vi.fn());
    expect(runtime.subscribeSession).toHaveBeenCalledTimes(1);

    // The runtime restarted: the stream ends with no "complete" event.
    loseStream?.(
      new Error("Runtime event stream ended before the session did"),
    );
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.subscribeSession).toHaveBeenCalledTimes(2);
  });

  it("folds a settled answer in place and serves its members on demand", async () => {
    const { service, source, push } = fixture(60_000, {
      foldSettledTurns: true,
    });
    const turn = (id: string, text: string): Message[] => [
      {
        uuid: `${id}-user`,
        type: "user",
        codexTurnId: id,
        message: { role: "user", content: text },
      },
      {
        uuid: `${id}-progress`,
        type: "assistant",
        codexTurnId: id,
        codexMessagePhase: "commentary",
        codexCorrelationKey: `codex:${id}:agent-message:progress`,
        message: { role: "assistant", content: `Checking ${id}` },
      },
      {
        uuid: `${id}-tool`,
        type: "assistant",
        codexTurnId: id,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `${id}-call`,
              name: "Bash",
              input: { command: "pnpm test" },
            },
          ],
        },
      },
      {
        uuid: `${id}-result`,
        type: "user",
        codexTurnId: id,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `${id}-call`,
              content: "passed",
            },
          ],
        },
      },
    ];
    const final = (id: string): Message => ({
      uuid: `${id}-final`,
      type: "assistant",
      codexTurnId: id,
      codexMessagePhase: "final_answer",
      codexCorrelationKey: `codex:${id}:agent-message:final`,
      message: { role: "assistant", content: `Answer ${id}` },
    });
    source.read.mockResolvedValue({
      provider: "codex",
      messages: turn("turn-1", "Fix"),
      activity: "running",
      stamp: "1",
    });
    let live: SessionDisplaySnapshot | undefined;
    await service.subscribe(selection, (type, data) => {
      if (type === "display-snapshot") live = data as SessionDisplaySnapshot;
      if (type === "display-patch") {
        const next = live
          ? applySessionDisplayPatch(
              live,
              SessionDisplayPatchSchema.parse(data),
            )
          : null;
        if (!next) throw new Error("Expected applicable patch");
        live = next;
      }
    });
    const running = await service.snapshot(selection);
    expect(
      running.nodes.some(
        (node) => node.type === "segment" && node.segment.type === "process",
      ),
    ).toBe(false);

    source.read.mockResolvedValue({
      provider: "codex",
      messages: [...turn("turn-1", "Fix"), final("turn-1")],
      turnStatuses: { "turn-1": "completed" },
      activity: "completed",
      stamp: "2",
    });
    push("complete", {});
    await vi.waitFor(async () => {
      const snapshot = await service.snapshot(selection);
      expect(
        snapshot.nodes.map((node) =>
          node.type === "segment" ? node.segment.type : node.type,
        ),
      ).toEqual(["question", "process", "assistant_text"]);
    });
    const settled = await service.snapshot(selection);
    // Completing the turn is an ordinary patch, not a new view epoch.
    expect(settled.view.epoch).toBe(running.view.epoch);
    expect(live?.nodes).toEqual(settled.nodes);
    expect(JSON.stringify(settled)).not.toContain("Checking turn-1");
    const fold = settled.nodes.find(
      (node) => node.type === "segment" && node.segment.type === "process",
    );
    const page = await service.process(selection, required(fold).id);
    expect(
      page.nodes.map((node) =>
        node.type === "segment" ? node.segment.type : node.type,
      ),
    ).toEqual(["assistant_text", "tool_group"]);
    expect(JSON.stringify(page)).toContain("Checking turn-1");

    // Older history pages record their cursor so folds can be rebuilt later.
    source.read.mockImplementation(async (_selection, cursor?: string) =>
      cursor === "older"
        ? {
            provider: "codex",
            messages: [...turn("turn-0", "Earlier"), final("turn-0")],
            turnStatuses: { "turn-0": "completed" },
            activity: "unknown",
            stamp: "2",
          }
        : {
            provider: "codex",
            messages: [...turn("turn-1", "Fix"), final("turn-1")],
            turnStatuses: { "turn-1": "completed" },
            activity: "completed",
            stamp: "2",
          },
    );
    const older = await service.older(selection, "older");
    const olderFold = older.nodes.find(
      (node) => node.type === "segment" && node.segment.type === "process",
    );
    if (olderFold?.type !== "segment" || olderFold.segment.type !== "process")
      throw new Error("Expected an older fold");
    expect(olderFold.segment.pageCursor).toBe("older");
    const olderPage = await service.process(
      selection,
      olderFold.id,
      olderFold.segment.pageCursor,
    );
    expect(JSON.stringify(olderPage)).toContain("Checking turn-0");
    await expect(
      service.process(selection, "process:missing:0"),
    ).rejects.toThrow("Display process not found");
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing expected fixture value");
  return value;
}
