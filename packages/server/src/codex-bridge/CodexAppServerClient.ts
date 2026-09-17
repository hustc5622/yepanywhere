import { type ChildProcess, spawn } from "node:child_process";
import { findCodexCliPath } from "../sdk/cli-detection.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
}

export interface CodexAppServerClientOptions {
  codexHome?: string;
  codexPathOverride?: string;
  requestTimeoutMs?: number;
  onNotification?(method: string, params: unknown): void;
  onExit?(reason: string): void;
}

/**
 * Minimal JSON-RPC client for `codex app-server --listen stdio://`.
 *
 * Every instance owns its own Codex process, so `codexHome` can be pointed at
 * an alternate `CODEX_HOME` directory to talk to a different Codex account
 * without touching the machine-wide login state.
 */
export class CodexAppServerClient {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 2;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly stderrChunks: string[] = [];

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  async start(): Promise<void> {
    if (this.child) return;
    const codexPath =
      this.options.codexPathOverride ?? (await findCodexCliPath());
    if (!codexPath) throw new Error("Codex CLI not found");

    const env = { ...process.env };
    if (this.options.codexHome) env.CODEX_HOME = this.options.codexHome;

    const child = spawn(codexPath, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: process.platform === "win32",
    });
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrChunks.push(chunk.toString("utf-8"));
      if (this.stderrChunks.length > 50) this.stderrChunks.shift();
    });
    child.on("error", (error) => this.fail(error.message));
    child.on("exit", (code, signal) =>
      this.fail(
        `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})${
          this.stderr() ? ` stderr: ${this.stderr()}` : ""
        }`,
      ),
    );

    await this.request("initialize", {
      clientInfo: { name: "yep-anywhere", version: "dev" },
      capabilities: null,
    });
    this.notify("initialized");
  }

  request<T = unknown>(method: string, params: unknown = null): Promise<T> {
    if (this.closed) return Promise.reject(new Error("client closed"));
    const child = this.child;
    if (!child) return Promise.reject(new Error("client not started"));

    const id = method === "initialize" ? 1 : this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  notify(method: string, params: unknown = null): void {
    this.child?.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail("client closed");
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1_500);
    forceKill.unref();
  }

  private consume(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(new Error(message.error.message ?? "request failed"));
        } else {
          entry.resolve(message.result);
        }
        continue;
      }
      if (message.method && message.id === undefined) {
        this.options.onNotification?.(message.method, message.params);
      }
    }
  }

  private fail(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    if (!this.closed) this.options.onExit?.(reason);
  }

  private stderr(): string {
    return this.stderrChunks.join("").trim();
  }
}
