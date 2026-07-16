/** Synchronize a remote Claude JSONL session into Yep's local project store. */

import { access, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path, { join, posix } from "node:path";
import type { RemoteExecutorConfig } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { getRemoteSessionStorageMode } from "./remote-executor-config.js";
import {
  executorLabel,
  inLoginShell,
  quoteShell,
  runRemoteCommand,
} from "./remote-spawn.js";

const remoteHomeCache = new Map<string, string>();

export interface RemoteSessionSyncOptions {
  executor: RemoteExecutorConfig;
  /** Project cwd as seen by Yep/macOS. */
  localCwd: string;
  /** The same project cwd as seen inside the remote VM. */
  remoteCwd: string;
  sessionId: string;
  /** Local Claude projects root. */
  localSessionsDir?: string;
  /** Shared-file visibility wait override, primarily for tests. */
  sharedVisibilityTimeoutMs?: number;
}

export interface SyncResult {
  success: boolean;
  mode: "shared" | "ssh-replica";
  localPath?: string;
  remotePath?: string;
  bytesTransferred?: number;
  error?: string;
  durationMs: number;
}

/** Claude encodes an absolute cwd by replacing separators and colons. */
export function getProjectDirFromCwd(cwd: string): string {
  return cwd.replace(/[/\\:]/g, "-");
}

export function getLocalSessionPath(
  cwd: string,
  sessionId: string,
  sessionsDir = join(homedir(), ".claude", "projects"),
): string {
  return join(sessionsDir, getProjectDirFromCwd(cwd), `${sessionId}.jsonl`);
}

export function getSharedSessionPath(
  executor: RemoteExecutorConfig,
  remoteCwd: string,
  sessionId: string,
): string | null {
  const storage = executor.sessionStorage;
  if (storage?.mode !== "shared" || !storage.localProjectsDir) return null;
  return join(
    storage.localProjectsDir,
    getProjectDirFromCwd(remoteCwd),
    `${sessionId}.jsonl`,
  );
}

function replaceCwdPrefix(
  value: string,
  remoteCwd: string,
  localCwd: string,
): string {
  const normalizedRemote = posix.normalize(remoteCwd);
  const normalizedValue = posix.normalize(value);
  if (normalizedValue === normalizedRemote) return path.normalize(localCwd);
  if (!normalizedValue.startsWith(`${normalizedRemote}/`)) return value;

  const suffix = normalizedValue.slice(normalizedRemote.length + 1);
  return join(localCwd, ...suffix.split("/"));
}

/**
 * Rewrite only semantic cwd fields in the local replica. Message text and
 * tool payloads remain byte-for-byte equivalent so transcript content is not
 * accidentally changed.
 */
export function rewriteSessionCwds(
  content: string,
  remoteCwd: string,
  localCwd: string,
): string {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop();

  const rewritten = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (typeof entry.cwd === "string") {
        entry.cwd = replaceCwdPrefix(entry.cwd, remoteCwd, localCwd);
      }
      return JSON.stringify(entry);
    } catch {
      // Preserve malformed/partial lines. The regular reader already handles
      // them defensively, and sync must never destroy the remote transcript.
      return line;
    }
  });

  return `${rewritten.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
}

async function getRemoteHome(
  executor: RemoteExecutorConfig,
): Promise<string | null> {
  const key = executorLabel(executor);
  const cached = remoteHomeCache.get(key);
  if (cached) return cached;

  const result = await runRemoteCommand(
    executor,
    inLoginShell('printf "%s" "$HOME"'),
  );
  if (!result.success || !result.stdout) return null;
  const remoteHome = result.stdout.trim();
  if (!remoteHome) return null;
  remoteHomeCache.set(key, remoteHome);
  return remoteHome;
}

async function getRemoteSessionsDir(
  executor: RemoteExecutorConfig,
): Promise<string | null> {
  if (executor.remoteSessionsDir) return executor.remoteSessionsDir;
  if (executor.remoteClaudeConfigDir) {
    return posix.join(executor.remoteClaudeConfigDir, "projects");
  }
  const remoteHome = await getRemoteHome(executor);
  return remoteHome ? posix.join(remoteHome, ".claude", "projects") : null;
}

/**
 * Pull the authoritative remote JSONL after a turn and store a local replica
 * under the local cwd's encoded project directory.
 */
export async function syncRemoteSessionFile(
  options: RemoteSessionSyncOptions,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const remoteSessionsDir = await getRemoteSessionsDir(options.executor);
  if (!remoteSessionsDir) {
    return {
      success: false,
      mode: "ssh-replica",
      error: "Unable to determine the remote Claude sessions directory",
      durationMs: Date.now() - startedAt,
    };
  }

  const remotePath = posix.join(
    remoteSessionsDir,
    getProjectDirFromCwd(options.remoteCwd),
    `${options.sessionId}.jsonl`,
  );
  const localPath = getLocalSessionPath(
    options.localCwd,
    options.sessionId,
    options.localSessionsDir,
  );
  const result = await runRemoteCommand(
    options.executor,
    inLoginShell(`cat -- ${quoteShell(remotePath)}`),
    30_000,
    128 * 1024 * 1024,
  );

  if (!result.success) {
    return {
      success: false,
      mode: "ssh-replica",
      localPath,
      remotePath,
      error: result.error ?? "Failed to read remote session file",
      durationMs: Date.now() - startedAt,
    };
  }

  const localContent = rewriteSessionCwds(
    result.stdout,
    options.remoteCwd,
    options.localCwd,
  );
  const tempPath = `${localPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(tempPath, localContent, "utf8");
    await rename(tempPath, localPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    return {
      success: false,
      mode: "ssh-replica",
      localPath,
      remotePath,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }

  const durationMs = Date.now() - startedAt;
  getLogger().debug(
    {
      event: "claude_remote_session_synced",
      executor: executorLabel(options.executor),
      sessionId: options.sessionId,
      localPath,
      remotePath,
      durationMs,
    },
    "Synced remote Claude session into the local session store",
  );

  return {
    success: true,
    mode: "ssh-replica",
    localPath,
    remotePath,
    bytesTransferred: Buffer.byteLength(result.stdout),
    durationMs,
  };
}

function defaultSharedVisibilityTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.YEP_CLAUDE_SHARED_SESSION_WAIT_MS ?? "",
    10,
  );
  return Number.isFinite(configured) && configured >= 0 ? configured : 2_000;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export async function waitForSharedSessionFile(
  options: RemoteSessionSyncOptions,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const localPath = getSharedSessionPath(
    options.executor,
    options.remoteCwd,
    options.sessionId,
  );
  if (!localPath) {
    return {
      success: false,
      mode: "shared",
      error: "Shared session storage is missing localProjectsDir",
      durationMs: Date.now() - startedAt,
    };
  }

  const timeoutMs =
    options.sharedVisibilityTimeoutMs ?? defaultSharedVisibilityTimeoutMs();
  const deadline = startedAt + timeoutMs;
  do {
    try {
      await access(localPath);
      const fileStat = await stat(localPath);
      if (fileStat.isFile() && fileStat.size > 0) {
        const durationMs = Date.now() - startedAt;
        getLogger().debug(
          {
            event: "claude_shared_session_visible",
            executor: executorLabel(options.executor),
            sessionId: options.sessionId,
            localPath,
            durationMs,
          },
          "Shared Claude session file is visible locally",
        );
        return {
          success: true,
          mode: "shared",
          localPath,
          bytesTransferred: 0,
          durationMs,
        };
      }
    } catch {
      // 9p visibility can lag briefly after Claude emits its result message.
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return {
    success: false,
    mode: "shared",
    localPath,
    error: `Shared Claude session file was not visible after ${timeoutMs}ms`,
    durationMs: Date.now() - startedAt,
  };
}

export interface RemoteSessionStorageDependencies {
  syncReplica?: (options: RemoteSessionSyncOptions) => Promise<SyncResult>;
  waitForShared?: (options: RemoteSessionSyncOptions) => Promise<SyncResult>;
}

/** Resolve the turn's JSONL through exactly one configured storage strategy. */
export function materializeRemoteSessionFile(
  options: RemoteSessionSyncOptions,
  dependencies: RemoteSessionStorageDependencies = {},
): Promise<SyncResult> {
  if (getRemoteSessionStorageMode(options.executor) === "shared") {
    return (dependencies.waitForShared ?? waitForSharedSessionFile)(options);
  }
  return (dependencies.syncReplica ?? syncRemoteSessionFile)(options);
}
