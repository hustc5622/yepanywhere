import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SideConversationSession,
  type SideEvent,
  type SideTransport,
} from "../../src/side-conversations/session.js";

const sessions: SideConversationSession[] = [];
function fixture() {
  let emit!: (event: SideEvent) => void;
  let ready = true;
  const transport: SideTransport = {
    model: "side-model",
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const create = vi.fn(
    async (_context: string, sink: (event: SideEvent) => void) => {
      emit = sink;
      return transport;
    },
  );
  const session = new SideConversationSession({
    ready: () => ready,
    parentId: () => "parent",
    create,
  });
  sessions.push(session);
  return {
    session,
    transport,
    create,
    emit: (event: SideEvent) => emit(event),
    expire: () => {
      ready = false;
    },
  };
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  vi.useRealTimers();
});

describe("side conversation lifecycle isolation", () => {
  it("does not admit the next turn before the previous send ACK settles", async () => {
    const f = fixture();
    const created = await f.session.execute({
      action: "create",
      requestId: "c",
      context: "snapshot",
    });
    const id = created.conversation?.id ?? "missing";
    let acknowledge: (() => void) | undefined;
    vi.mocked(f.transport.send).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const first = f.session.execute({
      action: "send",
      id,
      requestId: "one",
      text: "first",
    });
    f.emit({ type: "done" });
    expect(
      (
        await f.session.execute({
          action: "send",
          id,
          requestId: "two",
          text: "second",
        })
      ).error,
    ).toMatch(/Wait/);
    acknowledge?.();
    await first;
    expect(
      (
        await f.session.execute({
          action: "send",
          id,
          requestId: "two",
          text: "second",
        })
      ).error,
    ).toBeUndefined();
  });

  it("deduplicates creation and messages, keeps an independent transcript, and supports reconnect versions", async () => {
    const f = fixture();
    const [first, second] = await Promise.all(
      [1, 2].map(() =>
        f.session.execute({
          action: "create",
          requestId: "create",
          context: "snapshot",
        }),
      ),
    );
    const id = first.conversation?.id ?? "missing";
    expect(second.conversation?.id).toBe(id);
    expect(f.create).toHaveBeenCalledTimes(1);
    const request = {
      action: "send" as const,
      id,
      requestId: "question",
      text: "why?",
    };
    await f.session.execute(request);
    await f.session.execute(request);
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    f.emit({ type: "text", id: "answer", text: "**Because**", append: true });
    f.emit({ type: "done" });
    const snapshot = (await f.session.execute({ action: "get" })).conversation;
    if (!snapshot) throw new Error("Missing side snapshot");
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(snapshot.messages[1]?.html).toContain("<strong>Because</strong>");
    expect(
      await f.session.execute({ action: "get", id, version: snapshot.version }),
    ).toEqual({ supported: true, unchanged: true });
    if (snapshot.messages[0]) snapshot.messages[0].text = "client mutation";
    expect(
      (await f.session.execute({ action: "get" })).conversation?.messages[0]
        ?.text,
    ).toBe("why?");
    expect(
      (await f.session.execute({ ...request, text: "other" })).error,
    ).toMatch(/already used/);
  });

  it("cancels only the child, rejects overlap and stale IDs, and ignores late child output", async () => {
    const f = fixture();
    const id =
      (
        await f.session.execute({
          action: "create",
          requestId: "c",
          context: "snapshot",
        })
      ).conversation?.id ?? "missing";
    await f.session.execute({
      action: "send",
      id,
      requestId: "s",
      text: "question",
    });
    expect(
      (
        await f.session.execute({
          action: "send",
          id,
          requestId: "s2",
          text: "overlap",
        })
      ).error,
    ).toMatch(/Wait/);
    await f.session.execute({ action: "interrupt", id });
    expect(f.transport.interrupt).toHaveBeenCalledTimes(1);
    expect(f.transport.close).not.toHaveBeenCalled();
    f.emit({ type: "done" });
    await f.session.execute({ action: "close", id });
    f.emit({ type: "text", id: "late", text: "late output" });
    expect(
      (await f.session.execute({ action: "get" })).conversation?.messages,
    ).toHaveLength(1);
    const next = await f.session.execute({
      action: "create",
      requestId: "new",
      context: "empty",
    });
    expect(next.conversation?.id).not.toBe(id);
    expect(
      (
        await f.session.execute({
          action: "send",
          id,
          requestId: "old",
          text: "old",
        })
      ).error,
    ).toMatch(/no longer/);
  });

  it("cleans a child that finishes creating after close, without publishing it", async () => {
    const f = fixture();
    let finish!: (transport: SideTransport) => void;
    f.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.session.execute({
      action: "create",
      requestId: "c",
      context: "snapshot",
    });
    await Promise.resolve();
    const id =
      (await f.session.execute({ action: "get" })).conversation?.id ??
      "missing";
    const close = f.session.execute({ action: "close", id });
    finish(f.transport);
    await Promise.all([pending, close]);
    expect(f.transport.close).toHaveBeenCalledTimes(1);
    expect(
      (await f.session.execute({ action: "get" })).conversation?.status,
    ).toBe("closed");
  });

  it("releases admission after factory failures and enforces a separate global capacity", async () => {
    const bad = fixture();
    bad.create.mockRejectedValueOnce(new Error("unsupported protocol"));
    expect(
      (
        await bad.session.execute({
          action: "create",
          requestId: "bad",
          context: "snapshot",
        })
      ).conversation?.error,
    ).toBe("unsupported protocol");
    const fixtures = Array.from({ length: 5 }, fixture);
    const results = await Promise.all(
      fixtures.map((f) =>
        f.session.execute({
          action: "create",
          requestId: "c",
          context: "snapshot",
        }),
      ),
    );
    expect(
      results.filter((r) => r.conversation?.status === "idle"),
    ).toHaveLength(4);
    expect(results[4]?.error).toMatch(/capacity/);
  });

  it("keeps partial output on provider loss and bounds unattended execution", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const id =
      (
        await f.session.execute({
          action: "create",
          requestId: "c",
          context: "snapshot",
        })
      ).conversation?.id ?? "missing";
    await f.session.execute({
      action: "send",
      id,
      requestId: "s",
      text: "question",
    });
    f.emit({ type: "text", id: "answer", text: "partial" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(
      (await f.session.execute({ action: "get" })).conversation,
    ).toMatchObject({
      status: "closed",
      messages: [{ text: "question" }, { text: "partial" }],
    });
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });
});
