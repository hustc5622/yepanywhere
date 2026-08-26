/**
 * ZCode app-server stdio JSON transport client.
 *
 * This is an independent implementation (not sharing `CodexAppServerClient`)
 * to avoid destabilising the already-complex Codex provider.  The two share
 * the same NDJSON-over-stdio pattern but differ in method set, event model
 * and session lifecycle.
 *
 * IMPORTANT: The real ZCode CLI 0.16.1 does NOT use a `jsonrpc` field in its
 * message envelope.  Messages are classified solely by the presence of
 * `method` and `id` keys.  Outbound messages from this client therefore
 * omit `jsonrpc` to match the real protocol shape.  The inbound parser is
 * lenient (passthrough) so it tolerates responses that happen to include it.
 *
 * Responsibilities:
 *   - Spawn a ZCode `app-server` child process and wire stdio handlers.
 *   - Line-buffer stdout and dispatch each complete JSON line as one of:
 *       1. Response to our request (resolve pending promise).
 *       2. Server notification (enqueue onto `AsyncQueue`).
 *       3. Server-to-client request (call registered handler, send response).
 *   - Bounded + plaintext stderr tail.
 *   - Per-request timeout, graceful close, and process-exit rejection of all
 *     pending requests.
 *
 * Security: arbitrary stream chunks are joined into complete lines before
 * entering the bounded diagnostic buffer without masking their content.
 * `getStderrTail()` therefore returns the original bounded tail.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type {
  ZCodeJsonRpcId,
  ZCodeJsonRpcNotification,
} from "@yep-anywhere/shared";
import type { ZCodeErrorCode } from "@yep-anywhere/shared";

import { getLogger } from "../../../logging/logger.js";
import type {
  ZCodePendingRequest,
  ZCodeProtocolClientConfig,
  ZCodeServerRequestHandler,
} from "./types.js";
import { ZCodeProtocolError, ZCodeServerError } from "./types.js";

const log = getLogger().child({ component: "zcode-protocol-client" });

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_BOUND = 64 * 1024; // 64 KiB
const SHUTDOWN_GRACE_MS = 1_500;

// =============================================================================
// AsyncQueue — minimal notification buffer (AbortSignal-aware)
// =============================================================================

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private closedError: Error | null = null;

  push(item: T): void {
    if (this.closedError) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  close(error?: Error): void {
    if (this.closedError) return;
    this.closedError = error ?? new Error("Queue closed");
    for (const waiter of this.waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(this.closedError);
    }
    this.waiters = [];
    this.items = [];
  }

  async shift(signal?: AbortSignal): Promise<T> {
    if (this.items.length > 0) {
      const item = this.items.shift();
      if (item === undefined) throw new Error("Queue underflow");
      return item;
    }
    if (this.closedError) throw this.closedError;

    return await new Promise<T>((resolve, reject) => {
      const waiter: {
        resolve: (value: T) => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, signal };

      if (signal) {
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error("Operation aborted"));
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }
}

// =============================================================================
// ZCodeProtocolClient
// =============================================================================

export class ZCodeProtocolClient {
  private process: ChildProcess | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stderrLineBuffer = "";
  private closeError: Error | null = null;
  private closed = false;

  private nextRequestId = 1;
  private readonly pendingRequests = new Map<JsonRpcId, ZCodePendingRequest>();
  private readonly notifications = new AsyncQueue<ZCodeJsonRpcNotification>();
  private serverRequestHandler: ZCodeServerRequestHandler | null = null;

  private readonly requestTimeoutMs: number;
  private readonly stderrBound: number;

  constructor(private readonly config: ZCodeProtocolClientConfig) {
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.stderrBound = config.stderrBound ?? DEFAULT_STDERR_BOUND;
  }

  /** OS PID of the spawned app-server child process. */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  isAlive(): boolean {
    const child = this.process;
    return Boolean(child?.pid && child.exitCode === null && !child.killed);
  }

  setServerRequestHandler(handler: ZCodeServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /**
   * Spawn the app-server child and wait for the `spawn` event.
   * Throws `ZCodeProtocolError("zcode_protocol_start_failed")` on failure.
   */
  async connect(): Promise<void> {
    if (this.process) {
      throw new Error("ZCode app-server already connected");
    }

    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: this.config.env,
      shell: process.platform === "win32",
    });

    this.process = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf-8");
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (line) this.handleJsonRpcLine(line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      // Stream chunks are arbitrary. Reassemble complete lines for diagnostics
      // while keeping the pending line and retained tail bounded.
      this.stderrLineBuffer += chunk.toString("utf-8");
      const lines = this.stderrLineBuffer.split("\n");
      this.stderrLineBuffer = lines.pop() ?? "";
      for (const line of lines) this.appendStderrLine(line);
      if (this.stderrLineBuffer.length > this.stderrBound) {
        this.appendStderrLine("[ZCode stderr line omitted]");
        this.stderrLineBuffer = "";
      }
    });

    child.on("error", (error: Error) => {
      this.handleProcessClose(error);
    });

    child.on("exit", (code, signal) => {
      this.handleProcessClose(
        new Error(
          `ZCode app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        child.off("exit", onExit);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        child.off("exit", onExit);
        reject(this.closeError ?? error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
        const exitError = new Error(
          `ZCode app-server exited before connect (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        );
        this.handleProcessClose(exitError);
        reject(this.closeError ?? exitError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("exit", onExit);
    }).catch((error: unknown) => {
      throw toZCodeProtocolError(
        "zcode_protocol_start_failed",
        "Failed to start ZCode app-server",
        error,
      );
    });
  }

  /**
   * Send a JSON-RPC request and await the response.
   *
   * Rejects with `ZCodeServerError` when the server returns an error, or
   * `ZCodeProtocolError("zcode_protocol_timeout")` on timeout, or
   * `ZCodeProtocolError("zcode_protocol_closed")` when the process dies.
   */
  async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw toZCodeProtocolError(
        "zcode_protocol_closed",
        "ZCode app-server client is closed",
        this.closeError ?? undefined,
      );
    }

    const id: JsonRpcId = this.nextRequestId++;

    const resultPromise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        pending.reject(
          toZCodeProtocolError(
            "zcode_protocol_timeout",
            `ZCode request timed out: ${method} (${this.requestTimeoutMs}ms)`,
          ),
        );
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        method,
        params,
        timer,
      });
    });

    // Clean up the timer when the promise settles.
    const result = resultPromise.finally(() => {
      const pending = this.pendingRequests.get(id);
      if (pending?.timer) clearTimeout(pending.timer);
    });

    // Real ZCode CLI does NOT use a `jsonrpc` field — omit it from outbound
    // requests to match the actual protocol shape.
    this.sendRaw({ id, method, params });

    return result;
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    this.sendRaw({
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  /** Get the next server notification. Blocks until one arrives or the queue closes. */
  async nextNotification(
    signal?: AbortSignal,
  ): Promise<ZCodeJsonRpcNotification> {
    return await this.notifications.shift(signal);
  }

  /** Get the plaintext stderr tail for diagnostics. */
  getStderrTail(): string {
    return this.stderrBuffer.trim();
  }

  /**
   * Close the client: reject all pending requests, close the notification
   * queue, and terminate the child process that this client spawned.
   * Does NOT affect other ZCode processes or the ZCode Desktop.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stderrLineBuffer = "";

    const closeError = toZCodeProtocolError(
      "zcode_protocol_closed",
      "ZCode app-server client closed",
    );
    this.closeError = closeError;

    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(closeError);
    }
    this.pendingRequests.clear();
    this.notifications.close(closeError);

    const child = this.process;
    this.process = null;
    void this.terminateChild(child);
  }

  // -------------------------------------------------------------------------
  // Internal dispatch
  // -------------------------------------------------------------------------

  private handleJsonRpcLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log.debug({ line }, "Ignoring non-JSON app-server line");
      return;
    }

    const method =
      typeof message.method === "string" ? (message.method as string) : null;
    const hasId =
      typeof message.id === "string" || typeof message.id === "number";

    // Server request (method + id) → call handler, send response back.
    if (method && hasId) {
      this.handleServerRequest({
        id: message.id as JsonRpcId,
        method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      });
      return;
    }

    // Server notification (method, no id) → enqueue.
    if (method) {
      this.notifications.push({
        method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      });
      return;
    }

    // Response to our request (id, no method) → resolve/reject pending.
    if (hasId) {
      const id = message.id as JsonRpcId;
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      this.pendingRequests.delete(id);
      if (pending.timer) clearTimeout(pending.timer);

      if (message.error && typeof message.error === "object") {
        const error = message.error as {
          code?: number;
          message?: string;
          data?: unknown;
        };
        pending.reject(
          new ZCodeServerError(
            typeof error.code === "number" ? error.code : -32000,
            error.message ?? "JSON-RPC request failed",
            error.data,
            id,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private handleServerRequest(request: {
    id: JsonRpcId;
    method: string;
    params?: unknown;
  }): void {
    const respond = (payload: Record<string, unknown>): void => {
      // Real ZCode CLI does NOT use `jsonrpc` in its envelope.
      this.sendRaw({ id: request.id, ...payload });
    };

    if (!this.serverRequestHandler) {
      respond({
        error: {
          code: -32601,
          message: `Unsupported server request: ${request.method}`,
        },
      });
      return;
    }

    void this.serverRequestHandler({
      id: request.id,
      method: request.method,
      ...(request.params !== undefined ? { params: request.params } : {}),
    })
      .then((result) => {
        respond({ result: result ?? {} });
      })
      .catch((error: unknown) => {
        respond({
          error: {
            code: -32000,
            message:
              error instanceof Error ? error.message : "Server request failed",
          },
        });
      });
  }

  private handleProcessClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;

    if (this.stderrLineBuffer) {
      this.appendStderrLine(this.stderrLineBuffer);
      this.stderrLineBuffer = "";
    }

    const capturedStderr = this.stderrBuffer.trim();
    const processError = capturedStderr
      ? new Error(
          `${error.message}\nZCode app-server stderr:\n${capturedStderr}`,
          {
            cause: error,
          },
        )
      : error;
    this.closeError = toZCodeProtocolError(
      "zcode_protocol_closed",
      processError.message,
      processError,
    );

    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(this.closeError as ZCodeProtocolError);
    }
    this.pendingRequests.clear();

    // Emit a terminal error notification so consumers can surface it.
    this.notifications.push({
      method: "error",
      params: { error: { message: processError.message }, willRetry: false },
    });
    this.notifications.close(this.closeError);
    this.process = null;
  }

  private appendStderrLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    this.stderrBuffer = `${this.stderrBuffer}${text}\n`.slice(
      -this.stderrBound,
    );
    log.debug({ stderr: text }, "zcode app-server stderr");
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.process?.stdin || this.closed) return;
    try {
      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error: unknown) {
      this.handleProcessClose(
        error instanceof Error
          ? error
          : new Error("Failed to write to ZCode app-server stdin"),
      );
    }
  }

  private async terminateChild(child: ChildProcess | null): Promise<void> {
    if (!child?.pid || child.killed || child.exitCode !== null) return;

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    const killTarget =
      process.platform !== "win32" && child.pid > 0 ? -child.pid : child.pid;

    try {
      process.kill(killTarget, "SIGTERM");
    } catch {
      return;
    }

    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.killed) return;
      try {
        process.kill(killTarget, "SIGKILL");
      } catch {
        // Ignore escalation failures during shutdown.
      }
    }, SHUTDOWN_GRACE_MS);

    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

type JsonRpcId = ZCodeJsonRpcId;

function toZCodeProtocolError(
  code: ZCodeErrorCode,
  message: string,
  cause?: unknown,
): ZCodeProtocolError {
  return new ZCodeProtocolError(
    code,
    message,
    cause !== undefined ? { cause } : undefined,
  );
}
