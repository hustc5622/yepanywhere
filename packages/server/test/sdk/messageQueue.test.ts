import { describe, expect, it } from "vitest";
import { MessageQueue } from "../../src/sdk/messageQueue.js";

describe("MessageQueue lifecycle", () => {
  it("discards pending input and rejects pushes after close", async () => {
    const queue = new MessageQueue();
    queue.push({ text: "discard me" });

    expect(queue.close()).toBe(1);
    expect(queue.depth).toBe(0);
    expect(queue.isClosed).toBe(true);
    expect(queue.push({ text: "too late" })).toBe(-1);
    await expect(queue.generator().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("ends a waiting generator and closes idempotently", async () => {
    const queue = new MessageQueue();
    const next = queue.generator().next();
    expect(queue.isWaiting).toBe(true);

    expect(queue.close()).toBe(0);
    expect(queue.close()).toBe(0);
    await expect(next).resolves.toEqual({ done: true, value: undefined });
  });
});
