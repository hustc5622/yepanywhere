import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { FileChangeEvent } from "../watcher/EventBus.js";

const execFileAsync = promisify(execFile);
const SNAPSHOT_TTL_MS = 1000;
/**
 * Working directories are resolved one `lsof` call per batch instead of one per
 * pid. macOS accepts a comma-separated pid list; the chunk size only exists to
 * keep the argument vector bounded on a machine with hundreds of candidates.
 */
const CWD_BATCH_SIZE = 128;
/** Upper bound for the pid → cwd memo, so a long-lived server cannot grow it forever. */
const CWD_CACHE_MAX_ENTRIES = 1024;

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

/**
 * Single-flight guard for {@link getProcessSnapshot}.
 *
 * Every external session runs its own periodic liveness validation, so this
 * probe is called by many callers at once. Without sharing the in-flight build,
 * each caller that arrived while a snapshot was still being produced started
 * another full `ps` + `lsof` sweep, and once a sweep took longer than the TTL
 * the misses fed each other into a permanent process-spawn storm that starved
 * the event loop for every unrelated HTTP request.
 */
let inFlightSnapshot: Promise<ProcessSnapshotEntry[] | null> | null = null;

/**
 * Memoized working directories keyed by pid and command line.
 *
 * A process never changes the cwd Yep cares about here, so the expensive part
 * of a refresh only has to run for pids that were not seen before. The command
 * line is part of the key so a recycled pid cannot inherit a stale answer.
 */
const cwdCache = new Map<string, string | null>();

/** Reset probe caches. Exported for tests. */
export function resetExternalProcessProbeCache(): void {
  cachedSnapshot = null;
  inFlightSnapshot = null;
  cwdCache.clear();
}

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

  // A refresh is already running: reuse it rather than starting a second sweep.
  // A caller that already has a previous snapshot takes the slightly stale one
  // instead of blocking, because liveness here decays over tens of seconds.
  if (inFlightSnapshot) {
    return cachedSnapshot ? cachedSnapshot.entries : inFlightSnapshot;
  }

  const refresh = buildProcessSnapshot()
    // A refresh that nobody awaits (stale-served path) must not surface as an
    // unhandled rejection.
    .catch(() => null)
    .finally(() => {
      if (inFlightSnapshot === refresh) inFlightSnapshot = null;
    });
  inFlightSnapshot = refresh;

  return cachedSnapshot ? cachedSnapshot.entries : refresh;
}

async function buildProcessSnapshot(): Promise<ProcessSnapshotEntry[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 1500,
    }));
  } catch {
    // Hold the previous snapshot for another TTL rather than re-running a `ps`
    // that just failed on every subsequent call.
    if (cachedSnapshot) cachedSnapshot.timestamp = Date.now();
    return null;
  }

  const candidates = stdout
    .split("\n")
    .map(parsePsLine)
    .filter((entry): entry is Omit<ProcessSnapshotEntry, "cwd"> =>
      Boolean(entry && commandMatchesAnyProvider(entry.command)),
    );

  const entries = await resolveCandidateCwds(candidates);
  cachedSnapshot = { timestamp: Date.now(), entries };
  return entries;
}

async function resolveCandidateCwds(
  candidates: readonly Omit<ProcessSnapshotEntry, "cwd">[],
): Promise<ProcessSnapshotEntry[]> {
  const keyed = candidates.map((candidate) => ({
    candidate,
    key: cwdCacheKey(candidate.pid, candidate.command),
  }));
  const unresolved = keyed.filter(({ key }) => !cwdCache.has(key));

  if (unresolved.length > 0) {
    const resolved = await readProcessCwds(
      unresolved.map(({ candidate }) => candidate.pid),
    );
    for (const { candidate, key } of unresolved) {
      cwdCache.set(key, resolved.get(candidate.pid) ?? null);
    }
  }

  const entries = keyed.map(({ candidate, key }) => ({
    ...candidate,
    cwd: cwdCache.get(key) ?? null,
  }));

  pruneCwdCache(new Set(keyed.map(({ key }) => key)));
  return entries;
}

function cwdCacheKey(pid: number, command: string): string {
  return `${pid}\u0000${command}`;
}

/**
 * Drop memo entries for processes that are gone, so pid reuse cannot resurrect
 * an old answer and the map stays bounded on a long-running server.
 */
function pruneCwdCache(liveKeys: ReadonlySet<string>): void {
  if (cwdCache.size <= liveKeys.size) return;
  for (const key of cwdCache.keys()) {
    if (!liveKeys.has(key)) cwdCache.delete(key);
  }
  while (cwdCache.size > CWD_CACHE_MAX_ENTRIES) {
    const oldest = cwdCache.keys().next();
    if (oldest.done) break;
    cwdCache.delete(oldest.value);
  }
}

function parsePsLine(line: string): Omit<ProcessSnapshotEntry, "cwd"> | null {
  const match = line.match(/^\s*(\d+)\s+(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid, command: match[2] };
}

async function readProcessCwds(
  pids: readonly number[],
): Promise<Map<number, string | null>> {
  const resolved = new Map<number, string | null>();
  if (pids.length === 0) return resolved;

  if (process.platform === "linux") {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          resolved.set(pid, await readlink(`/proc/${pid}/cwd`));
        } catch {
          resolved.set(pid, null);
        }
      }),
    );
    return resolved;
  }

  for (let index = 0; index < pids.length; index += CWD_BATCH_SIZE) {
    const batch = pids.slice(index, index + CWD_BATCH_SIZE);
    parseLsofCwdRecords(await runLsofCwd(batch), resolved);
  }
  return resolved;
}

async function runLsofCwd(pids: readonly number[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"],
      {
        maxBuffer: 1024 * 1024,
        timeout: 2000,
      },
    );
    return stdout;
  } catch (error) {
    // lsof exits non-zero when any requested pid is gone or unreadable, while
    // still reporting every pid it could open. Keep that partial output.
    const stdout = (error as { stdout?: unknown } | null)?.stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

/** Parse `lsof -Fpn` field output: `p<pid>` selects the process, `n<path>` its cwd. */
function parseLsofCwdRecords(
  stdout: string,
  into: Map<number, string | null>,
): void {
  let currentPid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number.parseInt(line.slice(1), 10);
      currentPid = Number.isFinite(pid) ? pid : null;
      continue;
    }
    if (line.startsWith("n") && currentPid !== null) {
      const cwd = line.slice(1).trim();
      if (cwd) into.set(currentPid, cwd);
    }
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
