import {
  SessionDisplayPatchSchema,
  type SessionDisplaySnapshot,
  SessionDisplaySnapshotSchema,
  applySessionDisplayPatch,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDisplayService } from "../../src/display/SessionDisplayService.js";
import type { Message } from "../../src/supervisor/types.js";
const selection = { projectId: "project", sessionId: "session" };
const services: SessionDisplayService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
});
function fixture(pollMs = 60_000) {
  let push: (type: string, data: unknown) => void = () => {};
  const source = {
    stamp: vi.fn(async () => "1"),
    read: vi.fn(async () => ({
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
    })),
    detail: vi.fn(async () => [] as Message[]),
  };
  const runtime = {
    getProcessForSession: vi.fn(async () => ({ id: "process" }) as never),
    subscribeSession: vi.fn(async (_id: string, emit: typeof push) => {
      push = emit;
      return { cleanup: vi.fn() };
    }),
  };
  const service = new SessionDisplayService({ runtime, pollMs });
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
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing expected fixture value");
  return value;
}
