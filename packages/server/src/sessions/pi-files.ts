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

async function readFirstJsonlRecord(path: string): Promise<unknown> {
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

export async function listPiSessionFiles(
  sessionsDir = PI_SESSIONS_DIR,
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

export async function findPiSessionFile(
  sessionId: string,
  sessionsDir = PI_SESSIONS_DIR,
): Promise<PiSessionFileRecord | null> {
  const records = await listPiSessionFiles(sessionsDir);
  return records.find((record) => record.sessionId === sessionId) ?? null;
}
