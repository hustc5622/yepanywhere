import { isNonRetryableError } from "./types";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

export type SendPingFn = (id: string) => void;

export interface ConnectionManagerConfig {
  /** Base delay for exponential backoff (default: 1000ms) */
  baseDelayMs?: number;
  /** Maximum delay between reconnect attempts (default: 30000ms) */
  maxDelayMs?: number;
  /** Maximum number of reconnect attempts before giving up (default: 10) */
  maxAttempts?: number;
  /** Jitter factor for backoff randomization (default: 0.3) */
  jitterFactor?: number;
  /** Time without events before connection is considered stale (default: 45000ms) */
  staleThresholdMs?: number;
  /** Interval for checking stale connections (default: 10000ms) */
  staleCheckIntervalMs?: number;
  /**
   * Timeout waiting for pong response before forcing reconnect (default:
   * 5000ms). Remote tunnels and mobile wake-ups routinely exceed 2s while the
   * connection is still healthy; a false timeout reconnects every stream.
   */
  pongTimeoutMs?: number;
  /** Injectable timer interface for testing */
  timers?: TimerInterface;
  /** Injectable visibility interface for testing */
  visibility?: VisibilityInterface;
}

export type ReconnectFn = () => Promise<void>;

/**
 * Injectable timer interface for deterministic testing.
 */
export interface TimerInterface {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  now(): number;
}

/**
 * Injectable visibility interface for testing.
 */
export interface VisibilityInterface {
  isVisible(): boolean;
  onVisibilityChange(cb: (visible: boolean) => void): () => void;
}

type EventMap = {
  stateChange: (state: ConnectionState, prev: ConnectionState) => void;
  reconnectFailed: (error: Error) => void;
  visibilityRestored: () => void;
};

const DEFAULT_CONFIG = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 10,
  jitterFactor: 0.3,
  staleThresholdMs: 45000,
  staleCheckIntervalMs: 10000,
  pongTimeoutMs: 5000,
} as const;

/**
 * Default timer implementation using real browser timers.
 */
const realTimers: TimerInterface = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id),
  now: () => Date.now(),
};

/**
 * Default visibility implementation using the Page Visibility API.
 */
const realVisibility: VisibilityInterface = {
  isVisible: () => typeof document !== "undefined" && !document.hidden,
  onVisibilityChange(cb) {
    if (typeof document === "undefined") return () => {};
    const handler = () => cb(!document.hidden);
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  },
};

/**
 * Centralized connection state machine that manages reconnection.
 *
 * Replaces the multiple overlapping reconnection systems (stale timers,
 * visibility handlers, backoff logic) scattered across ActivityBus,
 * useSessionStream, useActivityBusConnection, etc.
 *
 * States:
 * - connected: socket is up, events flowing
 * - reconnecting: attempting to re-establish connection with backoff
 * - disconnected: gave up (max attempts or non-retryable error)
 *
 * Consumers call handleClose/handleError to report problems.
 * ConnectionManager decides when and how to reconnect via the provided reconnectFn.
 */
export class ConnectionManager {
  private _state: ConnectionState = "disconnected";
  private _reconnectAttempts = 0;
  private _reconnectFn: ReconnectFn | null = null;
  private _sendPing: SendPingFn | null = null;
  private _label: string | null = null;
  private _started = false;

  // Stale detection
  private _lastEventTime = 0;
  private _hasReceivedHeartbeat = false;
  private _staleCheckIntervalId: number | null = null;

  // Visibility & network recovery
  private _hiddenSince: number | null = null;
  private _removeVisibilityListener: (() => void) | null = null;
  private _removeOnlineListener: (() => void) | null = null;
  private _nonRetryableDisconnect = false;
  private _pendingPingId: string | null = null;
  private _pongTimeoutId: number | null = null;
  private _pingCounter = 0;

  // Backoff
  private _backoffTimerId: number | null = null;

  // In-flight reconnect dedup
  private _reconnectPromise: Promise<void> | null = null;

  // Event listeners
  private _listeners: {
    stateChange: Set<EventMap["stateChange"]>;
    reconnectFailed: Set<EventMap["reconnectFailed"]>;
    visibilityRestored: Set<EventMap["visibilityRestored"]>;
  } = {
    stateChange: new Set(),
    reconnectFailed: new Set(),
    visibilityRestored: new Set(),
  };

  // Config
  private readonly config: Required<
    Omit<ConnectionManagerConfig, "timers" | "visibility">
  >;
  private readonly timers: TimerInterface;
  private readonly visibility: VisibilityInterface;

  constructor(config: ConnectionManagerConfig = {}) {
    this.config = {
      baseDelayMs: config.baseDelayMs ?? DEFAULT_CONFIG.baseDelayMs,
      maxDelayMs: config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs,
      maxAttempts: config.maxAttempts ?? DEFAULT_CONFIG.maxAttempts,
      jitterFactor: config.jitterFactor ?? DEFAULT_CONFIG.jitterFactor,
      staleThresholdMs:
        config.staleThresholdMs ?? DEFAULT_CONFIG.staleThresholdMs,
      staleCheckIntervalMs:
        config.staleCheckIntervalMs ?? DEFAULT_CONFIG.staleCheckIntervalMs,
      pongTimeoutMs: config.pongTimeoutMs ?? DEFAULT_CONFIG.pongTimeoutMs,
    };
    this.timers = config.timers ?? realTimers;
    this.visibility = config.visibility ?? realVisibility;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get reconnectAttempts(): number {
    return this._reconnectAttempts;
  }

  /**
   * Start the connection manager with a reconnect function.
   * Idempotent — calling multiple times updates the reconnectFn but
   * doesn't create duplicate listeners.
   *
   * @param reconnectFn - Function to call when reconnecting.
   * @param options.sendPing - Optional function to send a keepalive ping with a given ID.
   *   When provided, visibility changes trigger a ping/pong check instead of
   *   blindly forcing reconnect.
   * @param options.label - Optional label for log messages (e.g., "ws").
   */
  start(
    reconnectFn: ReconnectFn,
    options?: { sendPing?: SendPingFn; label?: string },
  ): void {
    this._reconnectFn = reconnectFn;
    this._sendPing = options?.sendPing ?? null;
    this._label = options?.label ?? null;
    if (this._started) return;
    this._started = true;
    this._nonRetryableDisconnect = false;
    this._setState("connected");
    this._startStaleCheck();
    this._startVisibilityListener();
    this._startOnlineListener();
  }

  /**
   * Stop the connection manager, clearing all timers and listeners.
   */
  stop(): void {
    this._started = false;
    this._reconnectFn = null;
    this._sendPing = null;
    this._label = null;
    this._stopStaleCheck();
    this._stopVisibilityListener();
    this._stopOnlineListener();
    this._cancelBackoff();
    this._cancelPongTimeout();
    this._reconnectPromise = null;
    this._hasReceivedHeartbeat = false;
    this._hiddenSince = null;
    this._nonRetryableDisconnect = false;
    this._setState("disconnected");
  }

  /**
   * Record that an event was received. Resets the stale timer.
   */
  recordEvent(): void {
    this._lastEventTime = this.timers.now();
  }

  /**
   * Record that a heartbeat was received. Enables stale detection.
   */
  recordHeartbeat(): void {
    this._hasReceivedHeartbeat = true;
    this._lastEventTime = this.timers.now();
  }

  /**
   * Mark the connection as connected. Resets backoff counter.
   * Called by consumers when their subscription's onOpen fires.
   */
  markConnected(): void {
    this._reconnectAttempts = 0;
    this._reconnectPromise = null;
    this._nonRetryableDisconnect = false;
    this._cancelBackoff();
    this._setState("connected");
  }

  /**
   * Handle a pong response from the server.
   * Only acts if the ID matches the current pending ping (ignores stale pongs).
   */
  receivePong(id: string): void {
    if (id !== this._pendingPingId) return;
    this._cancelPongTimeout();
    this._pendingPingId = null;
    this._log("pong received, connection verified");
  }

  /**
   * Handle an error from a consumer. Triggers reconnect for retryable errors,
   * transitions to disconnected for non-retryable ones.
   */
  handleError(error: Error): void {
    const retryable = !isNonRetryableError(error);
    this._log(`error: ${error.message}, retryable=${retryable}`);
    if (this._state === "reconnecting") return; // already reconnecting
    if (!retryable) {
      this._nonRetryableDisconnect = true;
      this._setState("disconnected", `error: ${error.message}`);
      this._emitReconnectFailed(error);
      return;
    }
    this._startReconnecting(`error: ${error.message}`);
  }

  /**
   * Handle a close event from a consumer. Optionally pass the close error
   * to check retryability (e.g., WebSocketCloseError with code 4001).
   */
  handleClose(error?: Error): void {
    const retryable = !error || !isNonRetryableError(error);
    const detail = error?.message ?? "no error";
    this._log(`close: ${detail}, retryable=${retryable}`);
    if (this._state === "reconnecting") return; // already reconnecting
    if (error && !retryable) {
      this._nonRetryableDisconnect = true;
      this._setState("disconnected", `close: ${detail}`);
      this._emitReconnectFailed(error);
      return;
    }
    this._startReconnecting(`close: ${detail}`);
  }

  /**
   * Force an immediate reconnect, resetting backoff.
   * Useful for user-initiated reconnection.
   */
  forceReconnect(reason?: string): void {
    this._log(`force reconnect${reason ? `: ${reason}` : ""}`);
    this._reconnectAttempts = 0;
    this._nonRetryableDisconnect = false;
    this._cancelBackoff();
    this._reconnectPromise = null;
    this._startReconnecting(reason ?? "force");
  }

  /**
   * Subscribe to events. Returns an unsubscribe function.
   */
  on(event: "stateChange", cb: EventMap["stateChange"]): () => void;
  on(event: "reconnectFailed", cb: EventMap["reconnectFailed"]): () => void;
  on(
    event: "visibilityRestored",
    cb: EventMap["visibilityRestored"],
  ): () => void;
  on(event: keyof EventMap, cb: (...args: never[]) => void): () => void {
    const set = this._listeners[event] as Set<(...args: never[]) => void>;
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  // --- Private methods ---

  private _log(msg: string): void {
    const prefix = this._label
      ? `[ConnectionManager:${this._label}]`
      : "[ConnectionManager]";
    console.log(`${prefix} ${msg}`);
  }

  private _setState(newState: ConnectionState, reason?: string): void {
    if (newState === this._state) return;
    const prev = this._state;
    this._state = newState;
    const suffix = reason ? ` (${reason})` : "";
    this._log(`${prev} → ${newState}${suffix}`);
    for (const cb of this._listeners.stateChange) {
      cb(newState, prev);
    }
  }

  private _emitReconnectFailed(error: Error): void {
    for (const cb of this._listeners.reconnectFailed) {
      cb(error);
    }
  }

  private _emitVisibilityRestored(): void {
    for (const cb of this._listeners.visibilityRestored) {
      cb();
    }
  }

  private _startReconnecting(reason?: string): void {
    this._cancelPongTimeout();
    this._pendingPingId = null;
    this._setState("reconnecting", reason);
    this._scheduleReconnect();
  }

  private _scheduleReconnect(): void {
    if (!this._started || !this._reconnectFn) return;

    if (this._reconnectAttempts >= this.config.maxAttempts) {
      this._setState("disconnected");
      this._emitReconnectFailed(
        new Error(
          `Reconnection failed after ${this.config.maxAttempts} attempts`,
        ),
      );
      return;
    }

    const delay = this._getBackoffDelay(this._reconnectAttempts);
    this._reconnectAttempts++;
    this._log(
      `attempt ${this._reconnectAttempts}/${this.config.maxAttempts}, delay ${Math.round(delay)}ms`,
    );

    this._backoffTimerId = this.timers.setTimeout(() => {
      this._backoffTimerId = null;
      this._executeReconnect();
    }, delay);
  }

  private _executeReconnect(): void {
    if (!this._started || !this._reconnectFn) return;

    // Dedup: if a reconnect is already in-flight, don't start another
    if (this._reconnectPromise) return;

    const fn = this._reconnectFn;
    const reconnectPromise = fn();
    this._reconnectPromise = reconnectPromise;

    reconnectPromise
      .then(() => {
        // Ignore stale outcomes from superseded reconnect attempts.
        if (this._reconnectPromise !== reconnectPromise) return;
        // Transport reconnected — transition to connected so consumers
        // (e.g. ActivityBus stateChange listener) can re-subscribe.
        // The new subscription's onOpen will call markConnected() again (no-op).
        this.markConnected();
      })
      .catch((error: unknown) => {
        // Ignore stale outcomes from superseded reconnect attempts.
        if (this._reconnectPromise !== reconnectPromise) return;
        this._reconnectPromise = null;
        const err = error instanceof Error ? error : new Error(String(error));
        this._log(`reconnect failed: ${err.message}`);
        if (isNonRetryableError(err)) {
          this._nonRetryableDisconnect = true;
          this._setState("disconnected");
          this._emitReconnectFailed(err);
          return;
        }
        // Schedule next attempt
        this._scheduleReconnect();
      });
  }

  private _getBackoffDelay(attempt: number): number {
    const base = this.config.baseDelayMs * 2 ** attempt;
    const jitter = 1 + Math.random() * this.config.jitterFactor;
    return Math.min(this.config.maxDelayMs, base * jitter);
  }

  private _cancelBackoff(): void {
    if (this._backoffTimerId !== null) {
      this.timers.clearTimeout(this._backoffTimerId);
      this._backoffTimerId = null;
    }
  }

  // --- Stale detection ---

  private _startStaleCheck(): void {
    this._stopStaleCheck();
    this._lastEventTime = this.timers.now();
    this._staleCheckIntervalId = this.timers.setInterval(() => {
      this._checkStale();
    }, this.config.staleCheckIntervalMs);
  }

  private _stopStaleCheck(): void {
    if (this._staleCheckIntervalId !== null) {
      this.timers.clearInterval(this._staleCheckIntervalId);
      this._staleCheckIntervalId = null;
    }
  }

  private _checkStale(): void {
    if (this._state !== "connected") return;
    if (!this._hasReceivedHeartbeat) return;
    const elapsed = this.timers.now() - this._lastEventTime;
    if (elapsed >= this.config.staleThresholdMs) {
      this._log(`stale (${elapsed}ms since last event)`);
      this.forceReconnect("stale");
    }
  }

  // --- Visibility ---

  private _startVisibilityListener(): void {
    this._removeVisibilityListener = this.visibility.onVisibilityChange(
      (visible) => {
        if (!visible) {
          this._hiddenSince = this.timers.now();
        } else {
          this._handleBecameVisible();
        }
      },
    );
  }

  private _stopVisibilityListener(): void {
    if (this._removeVisibilityListener) {
      this._removeVisibilityListener();
      this._removeVisibilityListener = null;
    }
  }

  private _startOnlineListener(): void {
    this._stopOnlineListener();
    if (
      typeof window === "undefined" ||
      typeof window.addEventListener !== "function"
    ) {
      return;
    }
    const handler = () => {
      this._handleOnline();
    };
    window.addEventListener("online", handler);
    this._removeOnlineListener = () =>
      window.removeEventListener("online", handler);
  }

  private _stopOnlineListener(): void {
    if (this._removeOnlineListener) {
      this._removeOnlineListener();
      this._removeOnlineListener = null;
    }
  }

  private _handleOnline(): void {
    if (!this._started || this._nonRetryableDisconnect) return;
    if (
      this._state === "disconnected" ||
      (this._state === "reconnecting" && !this._reconnectPromise)
    ) {
      this.forceReconnect("network-online");
    }
  }

  private _handleBecameVisible(): void {
    if (!this._started) return;

    const hiddenDuration =
      this._hiddenSince !== null ? this.timers.now() - this._hiddenSince : null;
    this._hiddenSince = null;

    // After a long background/sleep period, reconnect attempts may have been
    // exhausted. Resume reconnecting when the user returns to the page (unless
    // the server rejected us with a non-retryable auth/origin error).
    if (this._state === "disconnected") {
      if (!this._nonRetryableDisconnect) {
        this._log(
          `visible${hiddenDuration != null ? ` after ${hiddenDuration}ms hidden` : ""} while disconnected, reconnecting`,
        );
        this.forceReconnect("visibility-restored");
      }
      return;
    }

    if (this._state !== "connected") return;

    // Notify consumers immediately so they can refresh data in parallel
    // with the ping/pong health check below.
    this._emitVisibilityRestored();

    if (!this._sendPing) {
      // No ping function provided — skip connectivity check
      return;
    }

    // Cancel any previous pending ping (handles rapid visible/hidden toggling)
    this._cancelPongTimeout();

    const pingId = String(++this._pingCounter);
    this._pendingPingId = pingId;

    this._log(
      `visible${hiddenDuration != null ? ` after ${hiddenDuration}ms hidden` : ""}, pinging`,
    );

    try {
      this._sendPing(pingId);
    } catch {
      this._pendingPingId = null;
      this._log("ping send failed");
      this.forceReconnect("ping-failed");
      return;
    }

    this._pongTimeoutId = this.timers.setTimeout(() => {
      this._pongTimeoutId = null;
      if (this._pendingPingId === pingId) {
        this._log("pong timeout");
        this._pendingPingId = null;
        this.forceReconnect("pong-timeout");
      }
    }, this.config.pongTimeoutMs);
  }

  private _cancelPongTimeout(): void {
    if (this._pongTimeoutId !== null) {
      this.timers.clearTimeout(this._pongTimeoutId);
      this._pongTimeoutId = null;
    }
  }
}
