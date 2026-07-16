import path, { posix, win32 } from "node:path";
import type {
  RemoteExecutorConfig,
  RemoteSessionStorageConfig,
} from "@yep-anywhere/shared";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";
import {
  isLocalPathWithin,
  isRemotePathWithin,
  mapLocalPathToRemote,
} from "./remote-path-mapping.js";

const SSH_USER_REGEX = /^(?!-)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PATH_LENGTH = 4096;

export interface RemoteExecutorParseResult {
  executor?: RemoteExecutorConfig;
  error?: string;
}

function optionalTrimmedString(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function validPath(value: string, flavor: "local" | "remote"): boolean {
  return (
    value.length <= MAX_PATH_LENGTH &&
    !value.includes("\0") &&
    !value.split(/[\\/]+/).includes("..") &&
    (flavor === "local"
      ? path.isAbsolute(value) || win32.isAbsolute(value)
      : posix.isAbsolute(value))
  );
}

function normalizeLocalPath(value: string): string {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
    ? win32.resolve(value)
    : path.resolve(value);
}

export function getRemoteSessionStorageMode(
  executor: Pick<RemoteExecutorConfig, "sessionStorage">,
): "shared" | "ssh-replica" {
  return executor.sessionStorage?.mode ?? "ssh-replica";
}

function parseSessionStorage(
  raw: unknown,
  roots: Pick<RemoteExecutorConfig, "localRoot" | "remoteRoot">,
  remoteClaudeConfigDir: string | undefined,
  remoteSessionsDir: string | undefined,
): { storage?: RemoteSessionStorageConfig; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "executor sessionStorage must be an object" };
  }

  const input = raw as Record<string, unknown>;
  if (input.mode !== "shared" && input.mode !== "ssh-replica") {
    return {
      error: 'executor sessionStorage.mode must be "shared" or "ssh-replica"',
    };
  }
  if (input.mode === "ssh-replica") {
    return { storage: { mode: "ssh-replica" } };
  }

  const localProjectsDir = optionalTrimmedString(input.localProjectsDir);
  if (
    localProjectsDir === null ||
    localProjectsDir === undefined ||
    !validPath(localProjectsDir, "local")
  ) {
    return {
      error:
        "shared sessionStorage.localProjectsDir must be an absolute local path",
    };
  }
  const remoteProjectsDir = optionalTrimmedString(input.remoteProjectsDir);
  if (
    remoteProjectsDir === null ||
    remoteProjectsDir === undefined ||
    !validPath(remoteProjectsDir, "remote")
  ) {
    return {
      error:
        "shared sessionStorage.remoteProjectsDir must be an absolute POSIX path",
    };
  }

  const normalizedLocal = normalizeLocalPath(localProjectsDir);
  const normalizedRemote = posix.resolve(remoteProjectsDir);
  if (
    !isLocalPathWithin(normalizedLocal, roots.localRoot) ||
    normalizedLocal === normalizeLocalPath(roots.localRoot)
  ) {
    return {
      error:
        "shared sessionStorage.localProjectsDir must be a child of localRoot",
    };
  }
  if (
    !isRemotePathWithin(normalizedRemote, roots.remoteRoot) ||
    normalizedRemote === posix.resolve(roots.remoteRoot)
  ) {
    return {
      error:
        "shared sessionStorage.remoteProjectsDir must be a child of remoteRoot",
    };
  }

  let translated: string;
  try {
    translated = mapLocalPathToRemote(normalizedLocal, roots);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (translated !== normalizedRemote) {
    return {
      error:
        "shared session projects directories do not describe the same mapped path",
    };
  }
  if (remoteClaudeConfigDir) {
    return {
      error:
        "shared session storage cannot set remoteClaudeConfigDir; credentials must remain in the remote private profile",
    };
  }
  if (remoteSessionsDir) {
    return {
      error:
        "shared session storage uses remoteProjectsDir instead of remoteSessionsDir",
    };
  }

  return {
    storage: {
      mode: "shared",
      localProjectsDir: normalizedLocal,
      remoteProjectsDir: normalizedRemote,
    },
  };
}

export function parseRemoteExecutorConfig(
  raw: unknown,
): RemoteExecutorParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "executor must be an object" };
  }

  const input = raw as Record<string, unknown>;
  if (typeof input.host !== "string") {
    return { error: "executor host is required" };
  }
  const host = normalizeSshHostAlias(input.host);
  if (!isValidSshHostAlias(host)) {
    return { error: `Invalid remote executor host: ${host || "(empty)"}` };
  }

  const user = optionalTrimmedString(input.user);
  if (user === null || (user !== undefined && !SSH_USER_REGEX.test(user))) {
    return { error: "executor user is invalid" };
  }

  let port: number | undefined;
  if (input.port !== undefined && input.port !== null && input.port !== "") {
    const candidate =
      typeof input.port === "string" ? Number(input.port) : input.port;
    if (
      typeof candidate !== "number" ||
      !Number.isInteger(candidate) ||
      candidate < 1 ||
      candidate > 65_535
    ) {
      return { error: "executor port must be an integer from 1 to 65535" };
    }
    port = candidate;
  }

  const localRoot = optionalTrimmedString(input.localRoot);
  if (
    localRoot === null ||
    localRoot === undefined ||
    !validPath(localRoot, "local")
  ) {
    return { error: "executor localRoot must be an absolute local path" };
  }
  const remoteRoot = optionalTrimmedString(input.remoteRoot);
  if (
    remoteRoot === null ||
    remoteRoot === undefined ||
    !validPath(remoteRoot, "remote")
  ) {
    return { error: "executor remoteRoot must be an absolute POSIX path" };
  }

  const claudePath = optionalTrimmedString(input.claudePath);
  if (
    claudePath === null ||
    (claudePath !== undefined && !validPath(claudePath, "remote"))
  ) {
    return { error: "executor claudePath must be an absolute POSIX path" };
  }
  const remoteClaudeConfigDir = optionalTrimmedString(
    input.remoteClaudeConfigDir,
  );
  if (
    remoteClaudeConfigDir === null ||
    (remoteClaudeConfigDir !== undefined &&
      !validPath(remoteClaudeConfigDir, "remote"))
  ) {
    return {
      error: "executor remoteClaudeConfigDir must be an absolute POSIX path",
    };
  }
  const remoteSessionsDir = optionalTrimmedString(input.remoteSessionsDir);
  if (
    remoteSessionsDir === null ||
    (remoteSessionsDir !== undefined && !validPath(remoteSessionsDir, "remote"))
  ) {
    return {
      error: "executor remoteSessionsDir must be an absolute POSIX path",
    };
  }

  const normalizedLocalRoot = normalizeLocalPath(localRoot);
  const normalizedRemoteRoot = posix.resolve(remoteRoot);
  const parsedSessionStorage = parseSessionStorage(
    input.sessionStorage,
    {
      localRoot: normalizedLocalRoot,
      remoteRoot: normalizedRemoteRoot,
    },
    remoteClaudeConfigDir ?? undefined,
    remoteSessionsDir ?? undefined,
  );
  if (parsedSessionStorage.error) {
    return { error: parsedSessionStorage.error };
  }

  return {
    executor: {
      host,
      ...(user ? { user } : {}),
      ...(port ? { port } : {}),
      localRoot: normalizedLocalRoot,
      remoteRoot: normalizedRemoteRoot,
      ...(claudePath ? { claudePath: posix.resolve(claudePath) } : {}),
      ...(remoteClaudeConfigDir
        ? { remoteClaudeConfigDir: posix.resolve(remoteClaudeConfigDir) }
        : {}),
      ...(remoteSessionsDir
        ? { remoteSessionsDir: posix.resolve(remoteSessionsDir) }
        : {}),
      ...(parsedSessionStorage.storage
        ? { sessionStorage: parsedSessionStorage.storage }
        : {}),
    },
  };
}

export function parseRemoteExecutorConfigs(raw: unknown): {
  executors?: RemoteExecutorConfig[];
  error?: string;
} {
  if (!Array.isArray(raw)) return { error: "executors must be an array" };
  const executors: RemoteExecutorConfig[] = [];
  const hosts = new Set<string>();
  const sharedProjectsDirs = new Set<string>();

  for (const item of raw) {
    const parsed = parseRemoteExecutorConfig(item);
    if (!parsed.executor) return { error: parsed.error };
    if (hosts.has(parsed.executor.host)) {
      return {
        error: `Remote executor host is configured more than once: ${parsed.executor.host}`,
      };
    }
    hosts.add(parsed.executor.host);
    if (parsed.executor.sessionStorage?.mode === "shared") {
      const localProjectsDir = parsed.executor.sessionStorage.localProjectsDir;
      if (!localProjectsDir) {
        return { error: "shared session storage is missing localProjectsDir" };
      }
      if (sharedProjectsDirs.has(localProjectsDir)) {
        return {
          error: `Shared Claude projects directory is configured more than once: ${localProjectsDir}`,
        };
      }
      sharedProjectsDirs.add(localProjectsDir);
    }
    executors.push(parsed.executor);
  }

  return { executors };
}
