/**
 * Native edit forks for Antigravity CLI (`agy`) conversations.
 *
 * ACP does not expose `/fork`, but every `agy acp` process embeds the
 * language server the TUI uses for it. That server listens on loopback
 * (Connect HTTP+JSON) behind a CSRF token, and agy reads the token from
 * `ANTIGRAVITY_SERVER_CSRF_TOKEN`; the port is only printed to the ACP log.
 *
 * `LanguageServerService/ForkConversation {sourceCascadeId, forkAtStepIndex}`
 * copies steps `0..forkAtStepIndex` (inclusive) into a new conversation with
 * the same step indexes, timestamps and workspace, and leaves the source
 * untouched. agy rejects a fork point that is itself a user message ("the
 * fork would carry a prompt with no response"), so editing the prompt at
 * step N forks at N - 1. See references/antigravity/README.md.
 *
 * The fork runs in a short-lived `agy acp` of its own, so the conversation
 * process Yep then attaches with `session/resume` stays an ordinary one.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "../../logging/logger.js";
import { parseAgyStepEntryId } from "../../sessions/agy-store.js";

const LS_SERVICE = "exa.language_server_pb.LanguageServerService";
const DEFAULT_TIMEOUT_MS = 30_000;
const LOG_POLL_INTERVAL_MS = 100;

/** Where an agy edit lands: a native fork, or a fresh conversation. */
export type AgyEditForkPlan =
  | { kind: "fork"; sourceSessionId: string; forkAtStepIndex: number }
  | { kind: "fresh"; sourceSessionId: string };

/**
 * Turn the edited prompt's message id into a fork plan. Editing the first
 * prompt keeps no history, which a fresh conversation already is.
 */
export function planAgyEditFork(
  sourceSessionId: string,
  editedMessageId: string,
): AgyEditForkPlan {
  const parsed = parseAgyStepEntryId(editedMessageId);
  if (!parsed) {
    throw new Error(
      `Antigravity edit boundary is not a persisted agy message: ${editedMessageId}`,
    );
  }
  if (parsed.sessionId !== null && parsed.sessionId !== sourceSessionId) {
    throw new Error(
      "Antigravity edit boundary belongs to a different conversation",
    );
  }
  return parsed.stepIndex === 0
    ? { kind: "fresh", sourceSessionId }
    : {
        kind: "fork",
        sourceSessionId,
        forkAtStepIndex: parsed.stepIndex - 1,
      };
}

/** The HTTP (Connect) port line agy logs when its language server starts. */
export function parseAgyLanguageServerHttpPort(log: string): number | null {
  const match = /listening on random port at (\d+) for HTTP\s*$/mu.exec(log);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

export interface ForkAgyConversationOptions {
  agyPath: string;
  cwd: string;
  /** Spawn environment (proxy routing, PATH); the token is added here. */
  env: Record<string, string>;
  sourceSessionId: string;
  forkAtStepIndex: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minimal line-delimited JSON-RPC client for one short-lived `agy acp`. */
class AgyRpc {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private exitError: Error | null = null;

  constructor(private readonly child: ChildProcess) {
    // A write racing the child's exit must not become an unhandled EPIPE.
    child.stdin?.on("error", () => undefined);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    const fail = (error: Error) => {
      this.exitError ??= error;
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    };
    child.on("error", fail);
    child.on("exit", (code, signal) =>
      fail(
        new Error(
          `agy acp exited before the fork finished (${signal ?? `code ${code}`})`,
        ),
      ),
    );
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let frame: JsonRpcResponse;
      try {
        frame = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof frame.id !== "number") continue;
      const waiter = this.pending.get(frame.id);
      if (!waiter) continue;
      this.pending.delete(frame.id);
      if (frame.error) {
        const message =
          typeof frame.error.message === "string"
            ? frame.error.message
            : "agy JSON-RPC error";
        waiter.reject(
          Object.assign(new Error(message), { code: frame.error.code }),
        );
      } else {
        waiter.resolve(frame.result);
      }
    }
  }
}

function abortError(): Error {
  return new Error("Antigravity fork was aborted");
}

async function waitForPort(
  logPath: string,
  deadline: number,
  signal: AbortSignal | undefined,
  rpcFailed: () => Error | null,
): Promise<number> {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    const failure = rpcFailed();
    if (failure) throw failure;
    const log = await readFile(logPath, "utf8").catch(() => "");
    const port = parseAgyLanguageServerHttpPort(log);
    if (port) return port;
    await new Promise((resolve) => setTimeout(resolve, LOG_POLL_INTERVAL_MS));
  }
  throw new Error(
    "agy did not report its language server port; this agy version may not support edit forks",
  );
}

/**
 * Fork `sourceSessionId` after `forkAtStepIndex` and return the new
 * conversation id. The source conversation is never modified.
 */
export async function forkAgyConversation(
  options: ForkAgyConversationOptions,
): Promise<string> {
  const log = getLogger();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(24).toString("hex");
  const dir = await mkdtemp(join(tmpdir(), "yep-agy-fork-"));
  const logPath = join(dir, "acp.log");
  const child = spawn(options.agyPath, ["acp", "--log-file", logPath], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "ignore"],
    env: {
      ...process.env,
      ...options.env,
      ANTIGRAVITY_SERVER_CSRF_TOKEN: token,
    },
  });
  const rpc = new AgyRpc(child);
  let rpcFailure: Error | null = null;
  const onAbort = () => child.kill();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => child.kill(), timeoutMs);

  try {
    if (options.signal?.aborted) throw abortError();
    await rpc.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "yep-anywhere", version: "fork" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    // The language server boots on the first session-level request.
    // `session/list` is read-only and also surfaces a signed-out CLI (or one
    // that cannot refresh its token): it must succeed before the fork, or
    // a failed edit would leave an orphan copy that nothing attaches to.
    const listed = rpc.request("session/list", {});
    listed.catch((error: unknown) => {
      rpcFailure =
        error instanceof Error ? error : new Error(String(error ?? "unknown"));
    });
    const port = await waitForPort(
      logPath,
      deadline,
      options.signal,
      () => rpcFailure,
    );
    await listed;

    const response = await fetch(
      `http://127.0.0.1:${port}/${LS_SERVICE}/ForkConversation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-antigravity-csrf-token": token,
        },
        body: JSON.stringify({
          sourceCascadeId: options.sourceSessionId,
          forkAtStepIndex: options.forkAtStepIndex,
          targetForkWorkspace: "FORK_TARGET_CURRENT_WORKSPACE",
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          ...(options.signal ? [options.signal] : []),
        ]),
      },
    );
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Reported below with the raw text.
    }
    if (!response.ok) {
      const message =
        isRecord(body) && typeof body.message === "string"
          ? body.message
          : text.trim() || `HTTP ${response.status}`;
      throw new Error(
        `Antigravity could not fork the conversation: ${message}`,
      );
    }
    const newSessionId =
      isRecord(body) && typeof body.newCascadeId === "string"
        ? body.newCascadeId.trim()
        : "";
    if (!newSessionId) {
      throw new Error("Antigravity fork returned no conversation id");
    }
    log.info(
      {
        event: "agy_conversation_forked",
        sourceSessionId: options.sourceSessionId,
        forkAtStepIndex: options.forkAtStepIndex,
        newSessionId,
        warnings: isRecord(body) ? body.warnings : undefined,
      },
      "Forked Antigravity conversation",
    );
    return newSessionId;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    child.kill();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
