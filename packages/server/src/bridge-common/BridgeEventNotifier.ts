import type { ServerResponse } from "node:http";

const DEFAULT_DEBOUNCE_MS = 50;
const KEEPALIVE_INTERVAL_MS = 25_000;

/**
 * Server-side half of the bridge "poll-on-push" channel.
 *
 * Bridge sidecars keep their state in-process; the main server used to
 * discover changes only through interval polling, which added up to a full
 * poll interval of latency before e.g. a waiting-input approval appeared in
 * the UI. Sidecars now attach SSE subscribers here and call `notify()` on any
 * state change; the main server reacts by polling immediately. The payload is
 * intentionally just a change signal - the existing poll/diff pipeline stays
 * the single source of truth.
 */
export class BridgeEventNotifier {
  private subscribers = new Set<ServerResponse>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  attach(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.subscribers.add(res);
    res.on("close", () => {
      this.subscribers.delete(res);
      this.stopKeepaliveIfIdle();
    });
    this.ensureKeepalive();
  }

  /** Debounced change signal to all subscribers. */
  notify(): void {
    if (this.subscribers.size === 0 || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const frame = `event: changed\ndata: ${Date.now()}\n\n`;
      for (const res of this.subscribers) {
        try {
          res.write(frame);
        } catch {
          this.subscribers.delete(res);
        }
      }
    }, DEFAULT_DEBOUNCE_MS);
    this.notifyTimer.unref?.();
  }

  close(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    for (const res of this.subscribers) {
      try {
        res.end();
      } catch {
        // already closed
      }
    }
    this.subscribers.clear();
  }

  private ensureKeepalive(): void {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      for (const res of this.subscribers) {
        try {
          res.write(": keepalive\n\n");
        } catch {
          this.subscribers.delete(res);
        }
      }
      this.stopKeepaliveIfIdle();
    }, KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer.unref?.();
  }

  private stopKeepaliveIfIdle(): void {
    if (this.subscribers.size === 0 && this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
