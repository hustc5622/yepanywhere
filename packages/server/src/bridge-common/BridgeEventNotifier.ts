import { randomUUID } from "node:crypto";
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
  private revision = 0;
  private readonly changedSessionIds = new Set<string>();
  private pendingBaseRevision: number | null = null;
  /**
   * Per-process identity, regenerated on every sidecar start.
   *
   * The revision alone cannot key an HTTP cache. `notify()` is the only thing
   * that advances it, but a restarting sidecar repopulates its session map
   * from persisted state *without* notifying, so revision 0 can describe two
   * different session lists across a restart. A client holding `W/"0"` would
   * then get a 304 for a snapshot it has never seen. Mixing this id into the
   * tag makes any restart a guaranteed cache miss.
   */
  private readonly instanceId = randomUUID().slice(0, 8);

  getRevision(): number {
    return this.revision;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Entity tag for any endpoint whose body is derived from the session map.
   *
   * Shared so `/sessions` and `/session-views` cannot drift into different
   * freshness rules: both are projections of the same records, so both are
   * invalidated by exactly the same events.
   */
  snapshotEtag(revision: number = this.revision): string {
    return `W/"${this.instanceId}-${revision}"`;
  }

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
  notify(changedSessionId?: string): void {
    const baseRevision = this.revision;
    this.revision += 1;
    if (changedSessionId) this.changedSessionIds.add(changedSessionId);
    if (this.subscribers.size === 0) {
      this.changedSessionIds.clear();
      return;
    }
    if (this.notifyTimer) return;
    this.pendingBaseRevision = baseRevision;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const frame = `event: changed\ndata: ${JSON.stringify({
        instanceId: this.instanceId,
        revision: this.revision,
        baseRevision: this.pendingBaseRevision ?? this.revision,
        changedSessionIds: Array.from(this.changedSessionIds),
      })}\n\n`;
      this.pendingBaseRevision = null;
      this.changedSessionIds.clear();
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
