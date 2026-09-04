/**
 * Outbound WebSocket send queue with backpressure and supersede-coalescing.
 *
 * `ws.send()` never blocks: it accepts the frame and buffers it. On a fast link
 * that is fine, but on a tunnelled connection the socket drains at link speed
 * while the server keeps producing streaming events, so the frames pile up in
 * Node's own send buffer. Two things follow, and both were observed as
 * "streaming feels laggy but the server looks idle":
 *
 * 1. Memory grows without bound, because nothing ever pushed back.
 * 2. Latency grows without bound. Every frame queued behind the backlog is
 *    already stale by the time it reaches the browser, so the typewriter ends
 *    up minutes behind the real turn and no amount of waiting catches it up —
 *    the backlog is replayed in full.
 *
 * The fix is to stop draining once the socket buffer is deep enough, and to let
 * the queue collapse while we wait. Most high-frequency streaming events are
 * *absolute state for a key*, not increments, so keeping only the newest one per
 * key loses nothing: the client applies the newest and never sees that an
 * intermediate value existed. That converts unbounded latency growth into
 * bounded staleness, which is what a live view actually wants.
 *
 * On a link that keeps up, `bufferedAmount` stays near zero, the queue is always
 * empty, nothing is ever coalesced, and this is byte-for-byte the previous
 * behaviour.
 */
import type { WireEvent, YepMessage } from "@yep-anywhere/shared";

export type OutboundFrame = string | ArrayBuffer | Uint8Array<ArrayBuffer>;

export interface SendQueueTransport {
  send(data: OutboundFrame): void;
  close(code?: number, reason?: string): void;
  /**
   * Bytes currently queued in the socket's own send buffer.
   *
   * Optional: a transport that does not expose it (tests, non-`ws` adapters)
   * is treated as never congested, which reproduces the un-throttled behaviour
   * exactly.
   */
  bufferedAmount?(): number;
}

export interface SendQueueOptions {
  transport: SendQueueTransport;
  /** Frame encoder; may be async (JSON frame compression runs on zlib's pool). */
  encode: (msg: YepMessage) => Promise<OutboundFrame>;
  /**
   * Socket-buffer depth at which we stop draining.
   *
   * This has to stay comfortably above the bandwidth-delay product, or we would
   * throttle a healthy link and lose throughput: at 50 Mbps with the ~20 ms RTT
   * measured to our tunnel endpoints that product is only ~128 KB. It also has
   * to stay low enough that a full buffer is a fraction of a second of
   * staleness rather than several seconds.
   */
  highWaterMarkBytes?: number;
  /** How long to wait before re-checking a congested socket. */
  drainRetryMs?: number;
  /**
   * How long a socket may stay congested before we give up on it. A client that
   * has not drained anything for this long is gone in every way that matters,
   * and closing lets `ConnectionManager` reconnect and resynchronize.
   */
  stallTimeoutMs?: number;
  /**
   * Backstop for messages that cannot be coalesced (transcript messages,
   * responses, terminal output). Reaching it means we are producing durable
   * output far faster than the link accepts it; closing is honest and
   * recoverable, silently growing is neither.
   */
  maxQueuedMessages?: number;
  /** Injectable delay for deterministic tests. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface SendQueue {
  /** Queue a message for delivery. Never throws. */
  enqueue(msg: YepMessage): void;
  /** Number of messages waiting to be encoded and sent. */
  readonly depth: number;
}

const DEFAULT_HIGH_WATER_MARK_BYTES = 512 * 1024;
const DEFAULT_DRAIN_RETRY_MS = 15;
const DEFAULT_STALL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUED_MESSAGES = 4096;

interface QueueEntry {
  msg: YepMessage;
  key: string | null;
}

/**
 * Key an event by the client-side state it overwrites, or return `null` when the
 * message must be delivered as-is.
 *
 * Only events whose client handler performs an **absolute, keyed assignment**
 * may be coalesced. Anything additive (transcript messages), any lifecycle
 * signal, and every request/response or terminal frame must survive verbatim.
 *
 * Verified against the client handlers rather than assumed:
 *
 * - `pending` → `useStreamingMarkdown.onPending` does
 *   `pendingElement.innerHTML = html` on a single element and ignores
 *   `data.messageId` entirely. So the subscription is the whole key: a finer key
 *   would let stale HTML from a previous message outlive the newest value.
 * - `markdown-augment` → `onAugment` overwrites `innerHTML` of the block with a
 *   matching `blockIndex`, and inserts new blocks at the position implied by
 *   that index rather than by arrival order, so same-index values supersede and
 *   different indices are independent. The final-render variant (`messageId`,
 *   no `blockIndex`) lands in `setMarkdownAugments` keyed by message id.
 *
 * Dropping an intermediate value leaves gaps in `WireEvent.eventId`, which is
 * harmless: `handleSessionSubscribe` never reads the `lastEventId` a client
 * sends back, resumption is driven by `lastMessageId`, and the counter restarts
 * at 0 for every new subscription.
 */
export function coalesceKeyFor(msg: YepMessage): string | null {
  if (msg.type !== "event") return null;
  const event = msg as WireEvent;

  if (event.eventType === "pending") {
    return `${event.subscriptionId}\u0000pending`;
  }

  if (event.eventType === "markdown-augment") {
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const { messageId, blockIndex } = data as {
      messageId?: unknown;
      blockIndex?: unknown;
    };
    const messageKey = typeof messageId === "string" ? messageId : "";

    if (blockIndex === undefined) {
      // Final-render augment. Without a message id there is no key to
      // supersede, so deliver it untouched.
      if (!messageKey) return null;
      return `${event.subscriptionId}\u0000augment-final\u0000${messageKey}`;
    }

    if (typeof blockIndex !== "number") return null;
    return `${event.subscriptionId}\u0000augment-block\u0000${messageKey}\u0000${blockIndex}`;
  }

  return null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createSendQueue(options: SendQueueOptions): SendQueue {
  const {
    transport,
    encode,
    highWaterMarkBytes = DEFAULT_HIGH_WATER_MARK_BYTES,
    drainRetryMs = DEFAULT_DRAIN_RETRY_MS,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    maxQueuedMessages = DEFAULT_MAX_QUEUED_MESSAGES,
    delay = sleep,
    now = Date.now,
  } = options;

  const queue: QueueEntry[] = [];
  /** Live index from coalesce key to the still-queued entry holding it. */
  const byKey = new Map<string, QueueEntry>();
  let draining = false;
  let failed = false;
  let congestedSince: number | null = null;

  const readBufferedAmount = (): number => {
    if (!transport.bufferedAmount) return 0;
    try {
      const value = transport.bufferedAmount();
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  };

  const fail = (reason: string, err?: unknown): void => {
    if (failed) return;
    failed = true;
    queue.length = 0;
    byKey.clear();
    if (err !== undefined) {
      console.warn(`[WS] ${reason}, closing socket:`, err);
    } else {
      console.warn(`[WS] ${reason}, closing socket`);
    }
    try {
      transport.close(1011, reason);
    } catch {
      // Socket already closing/closed.
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !failed) {
        if (readBufferedAmount() > highWaterMarkBytes) {
          const at = now();
          if (congestedSince === null) {
            congestedSince = at;
          } else if (at - congestedSince > stallTimeoutMs) {
            fail("Send buffer stalled");
            return;
          }
          // Yield without sending. Everything queued in the meantime gets a
          // chance to supersede an already-queued value.
          await delay(drainRetryMs);
          continue;
        }
        congestedSince = null;

        const entry = queue.shift();
        if (!entry) break;
        // Release the key before the await: a value arriving while we encode
        // this one can no longer replace it, so it has to queue behind instead.
        if (entry.key !== null && byKey.get(entry.key) === entry) {
          byKey.delete(entry.key);
        }

        let frame: OutboundFrame;
        try {
          frame = await encode(entry.msg);
        } catch (err) {
          fail("Failed to encode message", err);
          return;
        }

        try {
          transport.send(frame);
        } catch (err) {
          fail("Failed to send message", err);
          return;
        }
      }
    } finally {
      draining = false;
    }
  };

  return {
    enqueue(msg: YepMessage): void {
      if (failed) return;

      const key = coalesceKeyFor(msg);
      if (key !== null) {
        const existing = byKey.get(key);
        if (existing) {
          // Replace the payload where it already sits rather than dropping the
          // old entry and appending a new one. Keeping the earlier position
          // means a superseding UI update can never overtake a lifecycle event
          // that was queued between the two — e.g. `[pending, complete]` must
          // not become `[complete, pending]`, which would leave stale streaming
          // HTML on screen after the stream was cleared.
          existing.msg = msg;
          return;
        }
      }

      const entry: QueueEntry = { msg, key };
      queue.push(entry);
      if (key !== null) byKey.set(key, entry);

      if (queue.length > maxQueuedMessages) {
        fail("Send queue overflow");
        return;
      }

      void drain();
    },

    get depth(): number {
      return queue.length;
    },
  };
}
