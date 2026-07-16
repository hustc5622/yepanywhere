/**
 * SSH transport for running the Claude Code CLI on a remote machine.
 *
 * The Claude Agent SDK remains in the Yep server process and speaks its normal
 * stdio control protocol through SSH. The actual `claude` executable, auth,
 * tools, and shell commands all live in the remote machine.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { constants, access, stat } from "node:fs/promises";
import path, { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type { RemoteExecutorConfig } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { getRemoteSessionStorageMode } from "./remote-executor-config.js";
import { mapLocalPathToRemote } from "./remote-path-mapping.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 12_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

// These values describe the Agent SDK transport itself. Authentication,
// provider selection, proxy settings, and every other machine-specific value
// intentionally come from the VM instead of the Yep/macOS process.
const REMOTE_SDK_ENV_KEYS = [
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
] as const;

export interface RemoteExecutorTestResult {
  success: boolean;
  host: string;
  homeDir?: string;
  claudeAvailable?: boolean;
  claudeVersion?: string;
  localRootAvailable?: boolean;
  sharedRootAvailable?: boolean;
  sessionStorageMode?: "shared" | "ssh-replica";
  localProjectsDirAvailable?: boolean;
  localProjectsDirPermissionsSecure?: boolean;
  remoteProjectsDirAvailable?: boolean;
  remoteProjectsDirPermissionsSecure?: boolean;
  remoteSessionStoreLinked?: boolean;
  credentialStoragePrivate?: boolean;
  remoteClaudeConfigDirUnset?: boolean;
  error?: string;
  connectionTimeMs?: number;
}

export interface RemoteCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

export interface RemoteSpawnOptions {
  executor: RemoteExecutorConfig;
  /** Called with the local SSH child, primarily for liveness/PID reporting. */
  onSpawn?: (process: ChildProcess) => void;
}

/** Quote one value for a POSIX shell without allowing interpolation. */
export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function executorLabel(executor: RemoteExecutorConfig): string {
  const userPrefix = executor.user ? `${executor.user}@` : "";
  const portSuffix =
    executor.port && executor.port !== 22 ? `:${executor.port}` : "";
  return `${userPrefix}${executor.host}${portSuffix}`;
}

/**
 * Translate a local path beneath the shared root to the corresponding remote
 * path. Paths outside the configured root are rejected instead of silently
 * pointing Claude at a different checkout.
 */
export function translateSharedPath(
  localPath: string,
  executor: Pick<RemoteExecutorConfig, "localRoot" | "remoteRoot">,
): string {
  return mapLocalPathToRemote(localPath, executor);
}

/** Build SSH argv without involving a local shell. */
export function buildSshArgs(
  executor: Pick<RemoteExecutorConfig, "host" | "user" | "port">,
  remoteCommand: string,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): string[] {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.ceil(connectTimeoutMs / 1000))}`,
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
  ];

  if (executor.port) args.push("-p", String(executor.port));
  if (executor.user) args.push("-l", executor.user);
  args.push("--", executor.host, remoteCommand);
  return args;
}

export function inLoginShell(command: string): string {
  return `bash -lc ${quoteShell(command)}`;
}

/** Execute a bounded, non-interactive command over SSH. */
export function runRemoteCommand(
  executor: Pick<RemoteExecutorConfig, "host" | "user" | "port">,
  command: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  maxOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
): Promise<RemoteCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "ssh",
      buildSshArgs(executor, command, Math.min(timeoutMs, 10_000)),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationTimer: NodeJS.Timeout | null = null;

    const decode = (chunks: Buffer[]): string =>
      Buffer.concat(chunks).toString("utf8");

    const finish = (result: RemoteCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const terminate = () => {
      child.kill("SIGTERM");
      terminationTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1_000);
      terminationTimer.unref();
    };

    const failForLimit = (stream: "stdout" | "stderr") => {
      terminate();
      finish({
        success: false,
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
        exitCode: null,
        error: `Remote command ${stream} exceeded ${maxOutputBytes} bytes`,
      });
    };

    const appendBounded = (
      chunks: Buffer[],
      chunk: Buffer,
      currentBytes: number,
      stream: "stdout" | "stderr",
    ): number => {
      if (currentBytes + chunk.byteLength > maxOutputBytes) {
        failForLimit(stream);
        return currentBytes;
      }
      chunks.push(Buffer.from(chunk));
      return currentBytes + chunk.byteLength;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!settled) {
        stdoutBytes = appendBounded(stdoutChunks, chunk, stdoutBytes, "stdout");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!settled) {
        stderrBytes = appendBounded(stderrChunks, chunk, stderrBytes, "stderr");
      }
    });

    const timer = setTimeout(() => {
      terminate();
      finish({
        success: false,
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
        exitCode: null,
        error: `Remote command timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      finish({
        success: false,
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
        exitCode: null,
        error: error.message,
      });
    });
    child.once("exit", (code) => {
      if (terminationTimer) {
        clearTimeout(terminationTimer);
        terminationTimer = null;
      }
      const stdout = decode(stdoutChunks);
      const stderr = decode(stderrChunks);
      const cleanStderr = stderr.trim();
      finish({
        success: code === 0,
        stdout,
        stderr,
        exitCode: code,
        error:
          code === 0
            ? undefined
            : cleanStderr || `SSH exited with code ${code}`,
      });
    });
  });
}

/** Check SSH, Claude, and the configured shared-directory mount. */
export async function testRemoteExecutor(
  executor: RemoteExecutorConfig,
): Promise<RemoteExecutorTestResult> {
  const startedAt = Date.now();
  const host = executorLabel(executor);
  const sessionStorageMode = getRemoteSessionStorageMode(executor);
  let localRootAvailable = false;
  try {
    await access(executor.localRoot, constants.R_OK | constants.W_OK);
    localRootAvailable = (await stat(executor.localRoot)).isDirectory();
  } catch {
    localRootAvailable = false;
  }
  const connection = await runRemoteCommand(executor, "true", 8_000);
  if (!connection.success) {
    return {
      success: false,
      host,
      localRootAvailable,
      sessionStorageMode,
      error: connection.error ?? "SSH connection failed",
      connectionTimeMs: Date.now() - startedAt,
    };
  }

  const homeResult = await runRemoteCommand(
    executor,
    inLoginShell('printf "%s" "$HOME"'),
  );
  const claudeCommand = executor.claudePath ?? "claude";
  const claudeResult = await runRemoteCommand(
    executor,
    inLoginShell(`${quoteShell(claudeCommand)} --version`),
  );
  const sharedRootResult = await runRemoteCommand(
    executor,
    inLoginShell(
      `test -d ${quoteShell(executor.remoteRoot)} && test -r ${quoteShell(executor.remoteRoot)} && test -w ${quoteShell(executor.remoteRoot)}`,
    ),
  );

  let localProjectsDirAvailable: boolean | undefined;
  let localProjectsDirPermissionsSecure: boolean | undefined;
  let remoteProjectsDirAvailable: boolean | undefined;
  let remoteProjectsDirPermissionsSecure: boolean | undefined;
  let remoteSessionStoreLinked: boolean | undefined;
  let credentialStoragePrivate: boolean | undefined;
  let remoteClaudeConfigDirUnset: boolean | undefined;
  const storage = executor.sessionStorage;
  if (
    sessionStorageMode === "shared" &&
    storage?.localProjectsDir &&
    storage.remoteProjectsDir
  ) {
    try {
      await access(storage.localProjectsDir, constants.R_OK);
      const projectsStat = await stat(storage.localProjectsDir);
      localProjectsDirAvailable = projectsStat.isDirectory();
      localProjectsDirPermissionsSecure =
        process.platform === "win32" || (projectsStat.mode & 0o027) === 0;
    } catch {
      localProjectsDirAvailable = false;
      localProjectsDirPermissionsSecure = false;
    }

    const remoteProjectsResult = await runRemoteCommand(
      executor,
      inLoginShell(
        `test -d ${quoteShell(storage.remoteProjectsDir)} && test -r ${quoteShell(storage.remoteProjectsDir)} && test -w ${quoteShell(storage.remoteProjectsDir)}`,
      ),
    );
    remoteProjectsDirAvailable = remoteProjectsResult.success;
    const remoteProjectsModeResult = await runRemoteCommand(
      executor,
      inLoginShell(`stat -c '%a' -- ${quoteShell(storage.remoteProjectsDir)}`),
    );
    if (remoteProjectsModeResult.success) {
      const remoteMode = Number.parseInt(
        remoteProjectsModeResult.stdout.trim(),
        8,
      );
      remoteProjectsDirPermissionsSecure =
        Number.isFinite(remoteMode) && (remoteMode & 0o027) === 0;
    } else {
      remoteProjectsDirPermissionsSecure = false;
    }

    const linkedResult = await runRemoteCommand(
      executor,
      inLoginShell(
        `test -d "$HOME/.claude/projects" && test "$HOME/.claude/projects" -ef ${quoteShell(storage.remoteProjectsDir)}`,
      ),
    );
    remoteSessionStoreLinked = linkedResult.success;

    const privateProfileResult = await runRemoteCommand(
      executor,
      inLoginShell(
        `case "$HOME/.claude" in ${quoteShell(posix.resolve(executor.remoteRoot))}|${quoteShell(`${posix.resolve(executor.remoteRoot)}/`)}*) exit 1 ;; *) exit 0 ;; esac`,
      ),
    );
    credentialStoragePrivate = privateProfileResult.success;
    const configDirResult = await runRemoteCommand(
      executor,
      inLoginShell('test -z "${CLAUDE_CONFIG_DIR:-}"'),
    );
    remoteClaudeConfigDirUnset = configDirResult.success;
  }

  const claudeAvailable = claudeResult.success;
  const sharedRootAvailable = sharedRootResult.success;
  const errors: string[] = [];
  if (!localRootAvailable) {
    errors.push(`Shared root is unavailable locally: ${executor.localRoot}`);
  }
  if (!claudeAvailable) {
    errors.push(
      claudeResult.error ?? `Claude CLI is unavailable: ${claudeCommand}`,
    );
  }
  if (!sharedRootAvailable) {
    errors.push(
      `Shared root is not mounted read/write on the remote: ${executor.remoteRoot}`,
    );
  }
  if (localProjectsDirAvailable === false) {
    errors.push("Shared Claude projects directory is unreadable locally");
  }
  if (localProjectsDirPermissionsSecure === false) {
    errors.push(
      "Shared Claude projects directory permissions are too broad (expected 0700 or 0750)",
    );
  }
  if (remoteProjectsDirAvailable === false) {
    errors.push("Shared Claude projects directory is not read/write remotely");
  }
  // Do not reject a shared store based on the mode reported by the remote
  // mount. Filesystems such as bindfs can intentionally expose synthetic
  // permissions (for example 0777) even when the authoritative directory on
  // the Yep host is 0700. The local mode check above protects the persisted
  // transcript, while the remote checks still require a read/write directory,
  // a linked ~/.claude/projects, and credentials outside the shared root.
  if (remoteSessionStoreLinked === false) {
    errors.push(
      "Remote ~/.claude/projects does not point at the configured shared projects directory",
    );
  }
  if (credentialStoragePrivate === false) {
    errors.push(
      "Remote Claude credentials would reside inside the shared root",
    );
  }
  if (remoteClaudeConfigDirUnset === false) {
    errors.push("Remote CLAUDE_CONFIG_DIR must be unset for shared storage");
  }

  return {
    success: true,
    host,
    homeDir: homeResult.success ? homeResult.stdout.trim() : undefined,
    claudeAvailable,
    claudeVersion: claudeAvailable ? claudeResult.stdout.trim() : undefined,
    localRootAvailable,
    sharedRootAvailable,
    sessionStorageMode,
    localProjectsDirAvailable,
    localProjectsDirPermissionsSecure,
    remoteProjectsDirAvailable,
    remoteProjectsDirPermissionsSecure,
    remoteSessionStoreLinked,
    credentialStoragePrivate,
    remoteClaudeConfigDirUnset,
    error: errors.length > 0 ? errors.join("; ") : undefined,
    connectionTimeMs: Date.now() - startedAt,
  };
}

function remoteClaudeArgs(command: string, args: string[]): string[] {
  const firstArg = args[0];
  const commandName = path.basename(command).toLowerCase();
  const sdkCliScript =
    firstArg &&
    (firstArg.endsWith("cli.js") || firstArg.endsWith("cli.mjs")) &&
    firstArg.includes("claude-agent-sdk");

  return sdkCliScript || commandName === "node" || commandName === "node.exe"
    ? args.slice(1)
    : args;
}

export interface RemoteClaudeCommand {
  cli: string;
  args: string[];
  remoteCommand: string;
}

/** Build the remote command separately so path/env isolation can be tested. */
export function buildRemoteClaudeCommand(
  executor: RemoteExecutorConfig,
  spawnOptions: SpawnOptions,
): RemoteClaudeCommand {
  const cli = executor.claudePath ?? "claude";
  const args = remoteClaudeArgs(spawnOptions.command, spawnOptions.args);
  const envParts = REMOTE_SDK_ENV_KEYS.flatMap((key) => {
    const value = spawnOptions.env[key];
    return value === undefined ? [] : [`${key}=${quoteShell(value)}`];
  });
  if (
    executor.remoteClaudeConfigDir &&
    getRemoteSessionStorageMode(executor) !== "shared"
  ) {
    envParts.push(
      `CLAUDE_CONFIG_DIR=${quoteShell(executor.remoteClaudeConfigDir)}`,
    );
  }
  const commandParts = [
    `cd ${quoteShell(spawnOptions.cwd ?? executor.remoteRoot)}`,
    "exec",
    ...(envParts.length > 0 ? ["env"] : []),
    ...envParts,
    quoteShell(cli),
    ...args.map(quoteShell),
  ];
  return {
    cli,
    args,
    remoteCommand: inLoginShell(
      `${commandParts[0]} && ${commandParts.slice(1).join(" ")}`,
    ),
  };
}

function wrapChildProcess(child: ChildProcess): SpawnedProcess {
  const { stdin, stdout } = child;
  if (!stdin || !stdout) {
    throw new Error("Remote Claude process requires piped stdin and stdout.");
  }

  return {
    stdin,
    stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    kill(signal: NodeJS.Signals): boolean {
      return child.kill(signal);
    },
    on(event, listener) {
      child.on(event, listener as (...args: unknown[]) => void);
    },
    once(event, listener) {
      child.once(event, listener as (...args: unknown[]) => void);
    },
    off(event, listener) {
      child.off(event, listener as (...args: unknown[]) => void);
    },
  } as SpawnedProcess;
}

/**
 * Create the Agent SDK spawn hook. The hook deliberately does not forward the
 * Mac's Anthropic credentials; the VM's official Claude CLI owns auth.
 */
export function createRemoteSpawn(
  options: RemoteSpawnOptions,
): (spawnOptions: SpawnOptions) => SpawnedProcess {
  return (spawnOptions) => {
    const { executor } = options;
    const { cli, args, remoteCommand } = buildRemoteClaudeCommand(
      executor,
      spawnOptions,
    );

    getLogger().info(
      {
        event: "claude_remote_spawn_start",
        executor: executorLabel(executor),
        cwd: spawnOptions.cwd,
        cli,
        argCount: args.length,
      },
      `Starting Claude Code through SSH on ${executorLabel(executor)}`,
    );

    const child = spawn("ssh", buildSshArgs(executor, remoteCommand), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    options.onSpawn?.(child);

    const stderrDecoder = new StringDecoder("utf8");
    child.stderr?.on("data", (chunk: Buffer) => {
      const stderr = stderrDecoder.write(chunk).trim();
      if (!stderr) return;
      getLogger().debug(
        {
          event: "claude_remote_stderr",
          executor: executorLabel(executor),
          stderr,
        },
        "Remote Claude stderr",
      );
    });

    const abort = () => child.kill("SIGTERM");
    if (spawnOptions.signal.aborted) {
      abort();
    } else {
      spawnOptions.signal.addEventListener("abort", abort, { once: true });
    }
    child.once("exit", () => {
      const trailingStderr = stderrDecoder.end().trim();
      if (trailingStderr) {
        getLogger().debug(
          {
            event: "claude_remote_stderr",
            executor: executorLabel(executor),
            stderr: trailingStderr,
          },
          "Remote Claude stderr",
        );
      }
      spawnOptions.signal.removeEventListener("abort", abort);
    });

    return wrapChildProcess(child);
  };
}
