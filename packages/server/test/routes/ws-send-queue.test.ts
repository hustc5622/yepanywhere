import type { YepMessage } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type OutboundFrame,
  type SendQueueTransport,
  coalesceKeyFor,
  createSendQueue,
} from "../../src/routes/ws-send-queue.js";

/**
 * Frames are encoded as their JSON text so assertions read as the messages that
 * actually reached the socket.
 */
function decode(frame: OutboundFrame): YepMessage {
  return JSON.parse(frame as string) as YepMessage;
}

/**
 * Build a queue whose congestion re-check is driven by the test rather than by
 * wall-clock timers.
 */
function createControlledQueue(
  overrides: {
    highWaterMarkBytes?: number;
    maxQueuedMessages?: number;
    stallTimeoutMs?: number;
    now?: () => number;
    encode?: (msg: YepMessage) => Promise<OutboundFrame>;
  } = {},
) {
  const sent: OutboundFrame[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  let buffered = 0;
  let release: (() => void) | null = null;

  const transport: SendQueueTransport = {
    send: (data) => {
      sent.push(data);
    },
    close: (code, reason) => {
      closed.push({ code, reason });
    },
    bufferedAmount: () => buffered,
  };

  const queue = createSendQueue({
    transport,
    encode: overrides.encode ?? (async (msg) => JSON.stringify(msg)),
    highWaterMarkBytes: overrides.highWaterMarkBytes ?? 1024,
    ...(overrides.maxQueuedMessages !== undefined
      ? { maxQueuedMessages: overrides.maxQueuedMessages }
      : {}),
    ...(overrides.stallTimeoutMs !== undefined
      ? { stallTimeoutMs: overrides.stallTimeoutMs }
      : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
    delay: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });

  return {
    queue,
    sent,
    closed,
    setBuffered: (bytes: number) => {
      buffered = bytes;
    },
    isParked: () => release !== null,
    releaseDelay: () => {
      const fn = release;
      release = null;
      fn?.();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const pendingEvent = (html: string): YepMessage =>
  ({
    type: "event",
    subscriptionId: "sub-1",
    eventType: "pending",
    data: { html },
  }) as YepMessage;

const augmentEvent = (
  blockIndex: number | undefined,
  html: string,
  messageId = "msg-1",
): YepMessage =>
  ({
    type: "event",
    subscriptionId: "sub-1",
    eventType: "markdown-augment",
    data: {
      ...(blockIndex !== undefined ? { blockIndex } : {}),
      html,
      messageId,
    },
  }) as YepMessage;

const messageEvent = (uuid: string): YepMessage =>
  ({
    type: "event",
    subscriptionId: "sub-1",
    eventType: "message",
    data: { uuid },
  }) as YepMessage;

describe("coalesceKeyFor", () => {
  it("coalesces pending on the subscription alone", () => {
    // The client's onPending ignores messageId and overwrites one element, so a
    // finer key would let stale HTML outlive the newest value.
    expect(coalesceKeyFor(pendingEvent("a"))).toBe(
      coalesceKeyFor(pendingEvent("b")),
    );
  });

  it("separates markdown augments by block index", () => {
    expect(coalesceKeyFor(augmentEvent(0, "a"))).toBe(
      coalesceKeyFor(augmentEvent(0, "b")),
    );
    expect(coalesceKeyFor(augmentEvent(0, "a"))).not.toBe(
      coalesceKeyFor(augmentEvent(1, "a")),
    );
  });

  it("keys final-render augments by message id", () => {
    expect(coalesceKeyFor(augmentEvent(undefined, "a", "m1"))).toBe(
      coalesceKeyFor(augmentEvent(undefined, "b", "m1")),
    );
    expect(coalesceKeyFor(augmentEvent(undefined, "a", "m1"))).not.toBe(
      coalesceKeyFor(augmentEvent(undefined, "a", "m2")),
    );
  });

  it("never coalesces additive or lifecycle traffic", () => {
    expect(coalesceKeyFor(messageEvent("u1"))).toBeNull();
    expect(
      coalesceKeyFor({
        type: "event",
        subscriptionId: "sub-1",
        eventType: "complete",
        data: {},
      } as YepMessage),
    ).toBeNull();
    expect(
      coalesceKeyFor({
        type: "response",
        id: "r1",
        status: 200,
        body: {},
      } as YepMessage),
    ).toBeNull();
  });

  it("declines to coalesce when the key cannot be derived", () => {
    // A final-render augment with no message id, and a non-numeric blockIndex,
    // have no stable identity — deliver them untouched rather than guess.
    expect(
      coalesceKeyFor({
        type: "event",
        subscriptionId: "sub-1",
        eventType: "markdown-augment",
        data: { html: "x" },
      } as YepMessage),
    ).toBeNull();
    expect(
      coalesceKeyFor({
        type: "event",
        subscriptionId: "sub-1",
        eventType: "markdown-augment",
        data: { html: "x", blockIndex: "0" },
      } as YepMessage),
    ).toBeNull();
    expect(
      coalesceKeyFor({
        type: "event",
        subscriptionId: "sub-1",
        eventType: "markdown-augment",
        data: null,
      } as YepMessage),
    ).toBeNull();
  });
});

describe("createSendQueue", () => {
  it("behaves like an un-throttled sender when the transport has no buffer signal", async () => {
    const sent: OutboundFrame[] = [];
    const close = vi.fn();
    const queue = createSendQueue({
      transport: {
        send: (data) => {
          sent.push(data);
        },
        close,
      },
      encode: async (msg) => JSON.stringify(msg),
    });

    queue.enqueue(pendingEvent("a"));
    queue.enqueue(pendingEvent("b"));
    queue.enqueue(messageEvent("u1"));
    await settle();

    // Nothing is congested, so nothing is coalesced and order is verbatim.
    expect(sent.map((f) => decode(f))).toMatchObject([
      { eventType: "pending", data: { html: "a" } },
      { eventType: "pending", data: { html: "b" } },
      { eventType: "message" },
    ]);
    expect(close).not.toHaveBeenCalled();
  });

  it("collapses superseded pending state while the socket is congested", async () => {
    const h = createControlledQueue();
    h.setBuffered(4096); // above the 1024 high-water mark

    h.queue.enqueue(pendingEvent("v1"));
    expect(h.isParked()).toBe(true);

    h.queue.enqueue(pendingEvent("v2"));
    h.queue.enqueue(pendingEvent("v3"));
    expect(h.queue.depth).toBe(1);

    h.setBuffered(0);
    h.releaseDelay();
    await settle();

    // Three updates, one frame: the intermediate values never mattered.
    expect(h.sent.map((f) => decode(f))).toMatchObject([
      { eventType: "pending", data: { html: "v3" } },
    ]);
  });

  it("keeps a superseding update behind a lifecycle event queued after it", async () => {
    const h = createControlledQueue();
    h.setBuffered(4096);

    h.queue.enqueue(pendingEvent("v1"));
    h.queue.enqueue({
      type: "event",
      subscriptionId: "sub-1",
      eventType: "complete",
      data: {},
    } as YepMessage);
    h.queue.enqueue(pendingEvent("v2"));

    h.setBuffered(0);
    h.releaseDelay();
    await settle();

    // `complete` clears streaming HTML on the client. If the newer pending were
    // appended instead of replacing in place, it would land after `complete` and
    // leave stale streaming output on screen.
    expect(h.sent.map((f) => decode(f))).toMatchObject([
      { eventType: "pending", data: { html: "v2" } },
      { eventType: "complete" },
    ]);
  });

  it("never drops transcript messages under congestion", async () => {
    const h = createControlledQueue();
    h.setBuffered(4096);

    h.queue.enqueue(messageEvent("u1"));
    h.queue.enqueue(messageEvent("u2"));
    h.queue.enqueue(messageEvent("u3"));
    expect(h.queue.depth).toBe(3);

    h.setBuffered(0);
    h.releaseDelay();
    await settle();

    expect(h.sent.map((f) => decode(f))).toMatchObject([
      { data: { uuid: "u1" } },
      { data: { uuid: "u2" } },
      { data: { uuid: "u3" } },
    ]);
  });

  it("keeps distinct markdown blocks and collapses repeats of one block", async () => {
    const h = createControlledQueue();
    h.setBuffered(4096);

    h.queue.enqueue(augmentEvent(0, "block0-v1"));
    h.queue.enqueue(augmentEvent(1, "block1"));
    h.queue.enqueue(augmentEvent(0, "block0-v2"));

    h.setBuffered(0);
    h.releaseDelay();
    await settle();

    expect(h.sent.map((f) => decode(f))).toMatchObject([
      { data: { blockIndex: 0, html: "block0-v2" } },
      { data: { blockIndex: 1, html: "block1" } },
    ]);
  });

  it("stops coalescing into a message that is already being encoded", async () => {
    let releaseEncode: (() => void) | null = null;
    const h = createControlledQueue({
      encode: async (msg) => {
        if ((msg as { data?: { html?: string } }).data?.html === "v1") {
          await new Promise<void>((resolve) => {
            releaseEncode = resolve;
          });
        }
        return JSON.stringify(msg);
      },
    });

    h.queue.enqueue(pendingEvent("v1"));
    await Promise.resolve();
    // v1 has left the queue and is mid-encode, so v2 must queue behind it
    // rather than mutate a payload that is already committed.
    h.queue.enqueue(pendingEvent("v2"));
    releaseEncode?.();
    await settle();

    expect(h.sent.map((f) => decode(f))).toMatchObject([
      { data: { html: "v1" } },
      { data: { html: "v2" } },
    ]);
  });

  it("closes the socket when non-coalescable output outruns the link", async () => {
    const h = createControlledQueue({ maxQueuedMessages: 3 });
    h.setBuffered(4096);

    for (let i = 0; i < 5; i++) h.queue.enqueue(messageEvent(`u${i}`));
    await settle();

    expect(h.closed).toEqual([{ code: 1011, reason: "Send queue overflow" }]);
    // A failed queue accepts nothing further and holds no references.
    h.queue.enqueue(messageEvent("late"));
    expect(h.queue.depth).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  it("closes a socket that stays congested past the stall timeout", async () => {
    let clock = 0;
    const h = createControlledQueue({
      stallTimeoutMs: 100,
      now: () => clock,
    });
    h.setBuffered(4096);

    h.queue.enqueue(messageEvent("u1"));
    expect(h.isParked()).toBe(true);

    // First re-check records the start of congestion, the second exceeds it.
    clock = 50;
    h.releaseDelay();
    await settle();
    expect(h.closed).toHaveLength(0);

    clock = 500;
    h.releaseDelay();
    await settle();

    expect(h.closed).toEqual([{ code: 1011, reason: "Send buffer stalled" }]);
  });

  it("closes the socket when the transport rejects a frame", async () => {
    const close = vi.fn();
    const queue = createSendQueue({
      transport: {
        send: () => {
          throw new Error("socket gone");
        },
        close,
      },
      encode: async (msg) => JSON.stringify(msg),
    });

    queue.enqueue(messageEvent("u1"));
    await settle();

    expect(close).toHaveBeenCalledWith(1011, "Failed to send message");
  });
});
