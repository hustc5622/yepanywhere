import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { FileChangeEvent } from "../watcher/EventBus.js";

const execFileAsync = promisify(execFile);
const SNAPSHOT_TTL_MS = 1000;

export interface ExternalProcessProbeRequest {
  provider: FileChangeEvent["provider"];
  projectPath: string;
  excludePids?: readonly number[];
}

/**
 * true: a matching external provider process is active in this project
 * false: process table was checked and no matching process was found
 * null: process table/cwd probing is unavailable, so callers should fall back
 */
export type ExternalProcessProbe = (
  request: ExternalProcessProbeRequest,
) => Promise<boolean | null>;

interface ProcessSnapshotEntry {
  pid: number;
  command: string;
  cwd: string | null;
}

let cachedSnapshot: {
  timestamp: number;
  entries: ProcessSnapshotEntry[];
} | null = null;

export const hasActiveExternalProviderProcess: ExternalProcessProbe = async ({
  provider,
  projectPath,
  excludePids = [],
}) => {
  if (process.platform === "win32") {
    return null;
  }

  const entries = await getProcessSnapshot();
  if (!entries) return null;

  const excluded = new Set<number>([process.pid, ...excludePids]);
  const normalizedProjectPath = normalizePath(projectPath);

  for (const entry of entries) {
    if (excluded.has(entry.pid)) continue;
    if (!commandMatchesProvider(provider, entry.command)) continue;
    if (!entry.cwd) continue;
    if (normalizePath(entry.cwd) === normalizedProjectPath) {
      return true;
    }
  }

  return false;
};

async function getProcessSnapshot(): Promise<ProcessSnapshotEntry[] | null> {
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshot.timestamp < SNAPSHOT_TTL_MS) {
    return cachedSnapshot.entries;
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 1500,
    }));
  } catch {
    return null;
  }

  const candidates = stdout
    .split("\n")
    .map(parsePsLine)
    .filter((entry): entry is Omit<ProcessSnapshotEntry, "cwd"> =>
      Boolean(entry && commandMatchesAnyProvider(entry.command)),
    );

  const entries: ProcessSnapshotEntry[] = [];
  for (const candidate of candidates) {
    entries.push({
      ...candidate,
      cwd: await getProcessCwd(candidate.pid),
    });
  }

  cachedSnapshot = { timestamp: now, entries };
  return entries;
}

function parsePsLine(line: string): Omit<ProcessSnapshotEntry, "cwd"> | null {
  const match = line.match(/^\s*(\d+)\s+(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid, command: match[2] };
}

async function getProcessCwd(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      {
        maxBuffer: 64 * 1024,
        timeout: 1000,
      },
    );
    return (
      stdout
        .split("\n")
        .find((line) => line.startsWith("n"))
        ?.slice(1)
        .trim() || null
    );
  } catch {
    return null;
  }
}

function commandMatchesAnyProvider(command: string): boolean {
  return (
    commandMatchesProvider("claude", command) ||
    commandMatchesProvider("gemini", command) ||
    commandMatchesProvider("codex", command) ||
    commandMatchesProvider("pi", command) ||
    commandMatchesProvider("zcode", command)
  );
}

function commandMatchesProvider(
  provider: FileChangeEvent["provider"],
  command: string,
): boolean {
  const normalized = command.toLowerCase();
  switch (provider) {
    case "claude":
      return /\bclaude\b/.test(normalized);
    case "gemini":
      return /\bgemini\b/.test(normalized);
    case "codex":
      return /\bcodex\b/.test(normalized) && !/\bapp-server\b/.test(normalized);
    case "pi":
      return /(?:^|[\/\s])pi(?:\.[cm]?js|[-_]coding[-_]agent)?(?:[\/\s]|$)/.test(
        normalized,
      );
    case "zcode":
      return /\bzcode\b/.test(normalized) && !/\bapp-server\b/.test(normalized);
    default:
      return false;
  }
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
