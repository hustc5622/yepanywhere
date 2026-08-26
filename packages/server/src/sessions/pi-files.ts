import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parsePiSessionHeader } from "@yep-anywhere/shared";

export const PI_AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

export const PI_SESSIONS_DIR =
  process.env.PI_SESSIONS_DIR ??
  process.env.PI_CODING_AGENT_SESSION_DIR ??
  join(PI_AGENT_DIR, "sessions");

/**
 * Pi treats PI_CODING_AGENT_SESSION_DIR as one exact (flat) session directory.
 * YEP's PI_SESSIONS_DIR, by contrast, is a discovery root containing Pi's
 * native per-project directories.
 */
export const PI_SESSION_DIR_IS_EXACT =
  !process.env.PI_SESSIONS_DIR?.trim() &&
  Boolean(process.env.PI_CODING_AGENT_SESSION_DIR?.trim());

/** Mirror Pi's native `--<encoded-cwd>--` session-directory layout. */
export function getPiProjectSessionDir(
  cwd: string,
  sessionsDir = PI_SESSIONS_DIR,
): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(sessionsDir, safePath);
}

export interface PiSessionFileRecord {
  sessionId: string;
  filePath: string;
  cwd: string;
  createdAt: string;
  parentSession?: string;
  mtime: number;
  size: number;
}

export async function readFirstJsonlRecord(path: string): Promise<unknown> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return null;
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = content.indexOf("\n");
    const line = (newline >= 0 ? content.slice(0, newline) : content).trim();
    return line ? (JSON.parse(line) as unknown) : null;
  } finally {
    await handle.close();
  }
}

/**
 * Whether the newest turn in a Pi session log has finished.
 *
 * - `in-flight`: the agent still owes work — the last conversation entry is a
 *   user prompt, a tool result, or an assistant message that stopped to call a
 *   tool (or has not settled on a stop reason yet).
 * - `settled`: the last assistant message reached a terminal stop reason.
 * - `unknown`: the tail could not be read or holds no conversation entry.
 */
export type PiSessionTailActivity = "in-flight" | "settled" | "unknown";

/** Bytes read from the end of a session log when classifying its tail. */
const PI_TAIL_READ_BYTES = 256 * 1024;

/**
 * Pi stop reasons that mean the agent handed control back to the user.
 * `toolUse`, `pending` and `deferred` all leave the turn owing more work.
 */
const PI_TERMINAL_STOP_REASONS = new Set([
  "stop",
  "length",
  "error",
  "aborted",
]);

/**
 * Classify the tail of a Pi session log without reading the whole file.
 *
 * Pi is also hosted in-process by SDK embedders (Pi Web runs `AgentSession`
 * inside its own server), where no `pi` process exists to find in the process
 * table and the host's cwd is its own install directory. For those sessions the
 * append-only log is the only evidence that a turn is running, so callers use
 * this to decide liveness when a process probe reports nothing.
 *
 * The file is read backwards from a small tail chunk and expands only far
 * enough to capture the newest conversation entry. This keeps ordinary reads
 * bounded while still handling a single JSONL record containing a large image,
 * tool result, or reasoning block. Reading backwards also keeps the answer
 * correct for a log holding several branches, because the physically last entry
 * is always the most recent write regardless of which branch it is on.
 */
export async function readPiSessionTailActivity(
  filePath: string,
): Promise<PiSessionTailActivity> {
  try {
    const handle = await open(filePath, "r");
    try {
      const { size } = await handle.stat();
      if (size === 0) return "unknown";

      // Read backwards in bounded chunks. `carry` holds the beginning of the
      // suffix line until its preceding newline is found, so a single JSONL
      // record larger than the initial 256 KiB window is still classified
      // correctly. Keeping bytes (rather than decoded strings) also avoids
      // corrupting UTF-8 when a chunk boundary splits a multibyte character.
      let position = size;
      let carry = Buffer.alloc(0);
      let nextReadBytes = PI_TAIL_READ_BYTES;
      while (position > 0) {
        const start = Math.max(0, position - nextReadBytes);
        const length = position - start;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        const combined = Buffer.concat([buffer.subarray(0, bytesRead), carry]);
        const firstNewline = start === 0 ? -1 : combined.indexOf(0x0a);
        const completeLines =
          start === 0
            ? combined
            : firstNewline >= 0
              ? combined.subarray(firstNewline + 1)
              : Buffer.alloc(0);

        const activity = classifyPiTailLines(completeLines.toString("utf8"));
        if (activity) return activity;

        if (start === 0) return "unknown";
        carry =
          firstNewline >= 0 ? combined.subarray(0, firstNewline) : combined;
        position = start;
        nextReadBytes *= 2;
      }
    } finally {
      await handle.close();
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

function classifyPiTailLines(tail: string): PiSessionTailActivity | null {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const activity = classifyPiTailEntry(entry);
    if (activity) return activity;
  }
  return null;
}

function classifyPiTailEntry(entry: unknown): PiSessionTailActivity | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (record.type !== "message") return null;
  const message = record.message;
  if (typeof message !== "object" || message === null) return null;
  const role = (message as Record<string, unknown>).role;
  if (role === "user" || role === "toolResult") return "in-flight";
  if (role !== "assistant") return null;
  const stopReason = (message as Record<string, unknown>).stopReason;
  return typeof stopReason === "string" &&
    PI_TERMINAL_STOP_REASONS.has(stopReason)
    ? "settled"
    : "in-flight";
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  let topLevel: Dirent[];
  try {
    topLevel = await readdir(root, { withFileTypes: true });
  } catch {
    return paths;
  }

  for (const entry of topLevel) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      paths.push(path);
      continue;
    }
    if (!entry.isDirectory()) continue;
    try {
      const nested = await readdir(path, { withFileTypes: true });
      for (const child of nested) {
        if (child.isFile() && child.name.endsWith(".jsonl")) {
          paths.push(join(path, child.name));
        }
      }
    } catch {
      // A concurrently removed or unreadable project directory is skipped.
    }
  }
  return paths;
}

interface PiSessionFileCatalogState {
  records?: PiSessionFileRecord[];
  at: number;
  generation: number;
  inFlight?: {
    generation: number;
    promise: Promise<PiSessionFileRecord[]>;
  };
}

const PI_SESSION_FILE_CATALOG_TTL_MS = 5_000;
const piSessionFileCatalogs = new Map<string, PiSessionFileCatalogState>();

function getPiSessionFileCatalogState(
  sessionsDir: string,
): PiSessionFileCatalogState {
  const key = resolve(sessionsDir);
  let state = piSessionFileCatalogs.get(key);
  if (!state) {
    state = { at: 0, generation: 0 };
    piSessionFileCatalogs.set(key, state);
  }
  return state;
}

/** Invalidate the provider-wide Pi file catalog after a watcher event. */
export function invalidatePiSessionFileCatalog(
  sessionsDir = PI_SESSIONS_DIR,
): void {
  const state = getPiSessionFileCatalogState(sessionsDir);
  state.generation += 1;
  state.records = undefined;
  state.at = 0;
}

async function scanPiSessionFiles(
  sessionsDir: string,
): Promise<PiSessionFileRecord[]> {
  const files = await collectJsonlFiles(sessionsDir);
  const records = await Promise.all(
    files.map(async (filePath): Promise<PiSessionFileRecord | null> => {
      try {
        const [headerValue, fileStats] = await Promise.all([
          readFirstJsonlRecord(filePath),
          stat(filePath),
        ]);
        const header = parsePiSessionHeader(headerValue);
        if (!header) return null;
        return {
          sessionId: header.id,
          filePath,
          cwd: header.cwd,
          createdAt: header.timestamp,
          ...(header.parentSession
            ? { parentSession: header.parentSession }
            : {}),
          mtime: fileStats.mtimeMs,
          size: fileStats.size,
        };
      } catch {
        return null;
      }
    }),
  );
  return records.filter(
    (record): record is PiSessionFileRecord => record !== null,
  );
}

export async function listPiSessionFiles(
  sessionsDir = PI_SESSIONS_DIR,
  options: { force?: boolean } = {},
): Promise<PiSessionFileRecord[]> {
  const state = getPiSessionFileCatalogState(sessionsDir);
  if (options.force) {
    state.generation += 1;
    state.records = undefined;
    state.at = 0;
  }

  if (state.records && Date.now() - state.at < PI_SESSION_FILE_CATALOG_TTL_MS) {
    return state.records;
  }

  const generation = state.generation;
  if (state.inFlight?.generation === generation) {
    return state.inFlight.promise;
  }

  const promise = scanPiSessionFiles(sessionsDir).then((records) => {
    if (state.generation !== generation) {
      // A watcher invalidated the catalog while this scan was reading. Do not
      // hand the stale array to a project reader (which would cache it again);
      // join or start the scan for the new generation instead.
      return listPiSessionFiles(sessionsDir);
    }
    state.records = records;
    state.at = Date.now();
    return records;
  });
  state.inFlight = { generation, promise };
  void promise.finally(() => {
    if (state.inFlight?.promise === promise) state.inFlight = undefined;
  });
  return promise;
}

export async function findPiSessionFile(
  sessionId: string,
  sessionsDir = PI_SESSIONS_DIR,
): Promise<PiSessionFileRecord | null> {
  const records = await listPiSessionFiles(sessionsDir);
  const record = records.find((candidate) => candidate.sessionId === sessionId);
  if (record) return record;
  return (
    (await listPiSessionFiles(sessionsDir, { force: true })).find(
      (candidate) => candidate.sessionId === sessionId,
    ) ?? null
  );
}
