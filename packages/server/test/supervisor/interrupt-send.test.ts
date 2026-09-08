import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MessageQueue,
  getUserPromptProjection,
} from "../../src/sdk/messageQueue.js";
import type { SDKMessage } from "../../src/sdk/types.js";
import { Process } from "../../src/supervisor/Process.js";

const processes: Process[] = [];

function setup(
  interruptFn: (() => Promise<void>) | null = vi.fn(async () => {}),
) {
  const buffered: IteratorResult<SDKMessage>[] = [];
  let waiting: ((value: IteratorResult<SDKMessage>) => void) | undefined;
  const push = (value: IteratorResult<SDKMessage>) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(value);
    } else {
      buffered.push(value);
    }
  };
  const queue = new MessageQueue({ preserveClientMetadata: true });
  const steerFn = vi.fn(async () => true);
  const process = new Process(
    {
      next: () => {
        const next = buffered.shift();
        return next
          ? Promise.resolve(next)
          : new Promise((resolve) => {
              waiting = resolve;
            });
      },
    },
    {
      projectPath: "/test",
      projectId: "project-1",
      sessionId: "session-1",
      provider: "codex",
      queue,
      idleTimeoutMs: 60_000,
      interruptFn: interruptFn ?? undefined,
      steerFn,
      abortFn: () => push({ done: true, value: undefined }),
    },
  );
  processes.push(process);
  const users: SDKMessage[] = [];
  process.subscribe((event) => {
    if (event.type === "message" && event.message.type === "user")
      users.push(event.message);
  });
  return {
    process,
    queue,
    steerFn,
    interruptFn,
    users,
    endTurn: () =>
      push({ done: false, value: { type: "result", session_id: "session-1" } }),
  };
}

afterEach(() => {
  for (const process of processes.splice(0)) process.terminate("test_complete");
  vi.useRealTimers();
});

describe("interrupt and send", () => {
  it("waits for the terminal event after an early interrupt acknowledgement", async () => {
    const { process, queue, interruptFn, steerFn, users, endTurn } = setup();
    const sent = process.queueMessage(
      { text: "Use the new snapshot", tempId: "new" },
      { interruptBeforeSend: true },
    );
    await vi.waitFor(() => expect(interruptFn).toHaveBeenCalledTimes(1));
    expect(queue.depth).toBe(0);
    expect(users).toHaveLength(0);
    endTurn();
    await expect(sent).resolves.toMatchObject({ success: true });
    expect(queue.depth).toBe(1);
    expect(steerFn).not.toHaveBeenCalled();
    expect(process.state.type).toBe("in-turn");
    expect(users).toMatchObject([{ tempId: "new", isOptimistic: true }]);
  });

  it("reserves the next turn ahead of deferred messages when the terminal event arrives first", async () => {
    let acknowledge!: () => void;
    const ack = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const { process, queue, steerFn, endTurn } = setup(() => ack);
    process.deferMessage({ text: "Queued task", tempId: "deferred" });
    const sent = process.queueMessage(
      { text: "Urgent correction" },
      { interruptBeforeSend: true },
    );
    endTurn();
    await vi.waitFor(() => expect(process.state.type).toBe("idle"));
    expect(queue.depth).toBe(0);
    expect(process.getDeferredQueueSummary()).toMatchObject([
      { tempId: "deferred" },
    ]);
    acknowledge();
    await expect(sent).resolves.toMatchObject({ success: true });
    const inputs = queue.generator();
    expect(
      getUserPromptProjection((await inputs.next()).value).internalPrompt,
    ).toBe("Urgent correction");
    expect(process.getDeferredQueueSummary()).toHaveLength(1);
    endTurn();
    await vi.waitFor(() => expect(queue.depth).toBe(1));
    expect(
      getUserPromptProjection((await inputs.next()).value).internalPrompt,
    ).toBe("Queued task");
    expect(steerFn).not.toHaveBeenCalled();
  });

  it("sends normally if the turn has already ended", async () => {
    const { process, queue, interruptFn, endTurn } = setup();
    endTurn();
    await vi.waitFor(() => expect(process.state.type).toBe("idle"));
    await expect(
      process.queueMessage(
        { text: "Follow up" },
        { interruptBeforeSend: true },
      ),
    ).resolves.toMatchObject({ success: true });
    expect(interruptFn).not.toHaveBeenCalled();
    expect(queue.depth).toBe(1);
  });

  it("accepts a natural completion racing an interrupt rejection", async () => {
    let rejectInterrupt!: (error: Error) => void;
    const ack = new Promise<void>((_, reject) => {
      rejectInterrupt = reject;
    });
    const { process, queue, endTurn } = setup(() => ack);
    const sent = process.queueMessage(
      { text: "Follow up" },
      { interruptBeforeSend: true },
    );
    endTurn();
    await vi.waitFor(() => expect(process.state.type).toBe("idle"));
    rejectInterrupt(new Error("no active turn to interrupt"));
    await expect(sent).resolves.toMatchObject({ success: true });
    expect(queue.depth).toBe(1);
  });

  it("does not admit or steer a message after interruption fails", async () => {
    const { process, queue, steerFn, users } = setup(async () => {
      throw new Error("transport unavailable");
    });
    process.deferMessage({ text: "Queued task", tempId: "deferred" });
    await expect(
      process.queueMessage(
        { text: "Correction" },
        { interruptBeforeSend: true },
      ),
    ).resolves.toEqual({ success: false, error: "interrupt_send_failed" });
    expect(queue.depth).toBe(0);
    expect(users).toHaveLength(0);
    expect(steerFn).not.toHaveBeenCalled();
    expect(process.getDeferredQueueSummary()).toHaveLength(1);
    expect(process.state.type).toBe("in-turn");
  });

  it("rejects a second interrupt while the first send is in progress", async () => {
    const { process, interruptFn, queue, endTurn } = setup();
    const first = process.queueMessage(
      { text: "First correction" },
      { interruptBeforeSend: true },
    );
    await expect(
      process.queueMessage(
        { text: "Second correction" },
        { interruptBeforeSend: true },
      ),
    ).resolves.toEqual({ success: false, error: "interrupt_send_in_progress" });
    endTurn();
    await expect(first).resolves.toMatchObject({ success: true });
    expect(interruptFn).toHaveBeenCalledTimes(1);
    expect(queue.depth).toBe(1);
  });

  it("rejects unsupported interruption without quietly queueing", async () => {
    const { process, queue, users } = setup(null);
    await expect(
      process.queueMessage(
        { text: "Correction" },
        { interruptBeforeSend: true },
      ),
    ).resolves.toEqual({ success: false, error: "interrupt_not_supported" });
    expect(queue.depth).toBe(0);
    expect(users).toHaveLength(0);
  });

  it.each([false, true])(
    "bounds the wait when terminal event received=%s",
    async (terminalReceived) => {
      vi.useFakeTimers();
      const { process, queue, users, endTurn } = setup(
        () => new Promise(() => {}),
      );
      const sent = process.queueMessage(
        { text: "Correction" },
        { interruptBeforeSend: true },
      );
      if (terminalReceived) endTurn();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(sent).resolves.toEqual({
        success: false,
        error: "interrupt_send_failed",
      });
      expect(queue.depth).toBe(0);
      expect(users).toHaveLength(0);
    },
  );
});
