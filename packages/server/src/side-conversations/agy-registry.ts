/**
 * Temporary Antigravity side conversations, shared across Yep processes.
 *
 * Unlike Codex (`ephemeral`) and Pi (in-memory), agy persists every
 * conversation it creates, so a side conversation exists in
 * `~/.gemini/antigravity-cli` while it is open. The runtime that owns it
 * (embedded, or the external runtime process) records it here; the web/API
 * process reads this file to keep it out of session lists and external
 * activity. Deleted conversations stay listed for a short while because
 * agy's catalog drops their summary row asynchronously.
 *
 * Only Yep's own data dir is written; agy's store is never touched.
 */

import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../config.js";
import { atomicWriteJson } from "../utils/atomic-json-file.js";

const FILE_NAME = "agy-side-sessions.json";
/** Keep hiding a deleted conversation until agy's catalog has caught up. */
const DELETED_RETENTION_MS = 10 * 60_000;
/** An entry this old is an orphan even if its owner pid was reused. */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface AgySideSessionEntry {
  parentSessionId: string;
  /** The Yep process that owns the conversation. */
  pid: number;
  createdAt: string;
  /** Set once agy deleted the conversation. */
  deletedAt?: string;
}

interface RegistryFile {
  version: 1;
  sessions: Record<string, AgySideSessionEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(text: string): RegistryFile {
  try {
    const value = JSON.parse(text) as unknown;
    if (isRecord(value) && isRecord(value.sessions)) {
      const sessions: Record<string, AgySideSessionEntry> = {};
      for (const [id, entry] of Object.entries(value.sessions)) {
        if (
          isRecord(entry) &&
          typeof entry.parentSessionId === "string" &&
          typeof entry.pid === "number" &&
          typeof entry.createdAt === "string"
        ) {
          sessions[id] = {
            parentSessionId: entry.parentSessionId,
            pid: entry.pid,
            createdAt: entry.createdAt,
            ...(typeof entry.deletedAt === "string"
              ? { deletedAt: entry.deletedAt }
              : {}),
          };
        }
      }
      return { version: 1, sessions };
    }
  } catch {
    // A torn or foreign file hides nothing.
  }
  return { version: 1, sessions: {} };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class AgySideSessionRegistry {
  private readonly filePath: string;
  /** Conversations this process has open right now. */
  private readonly open = new Set<string>();
  private cache: { mtimeMs: number; size: number; ids: Set<string> } | null =
    null;
  private writes: Promise<void> = Promise.resolve();

  constructor(dataDir?: string) {
    this.filePath = join(dataDir ?? getDataDir(), FILE_NAME);
  }

  /** Whether `sessionId` is a Yep side conversation (open or just deleted). */
  isHidden(sessionId: string): boolean {
    if (this.open.has(sessionId)) return true;
    return this.hiddenIds().has(sessionId);
  }

  /** Every hidden id; cached by file mtime for list hot paths. */
  hiddenIds(): ReadonlySet<string> {
    let info: { mtimeMs: number; size: number };
    try {
      info = statSync(this.filePath);
    } catch {
      this.cache = null;
      return this.open;
    }
    if (
      !this.cache ||
      this.cache.mtimeMs !== info.mtimeMs ||
      this.cache.size !== info.size
    ) {
      let text = "";
      try {
        text = readFileSync(this.filePath, "utf8");
      } catch {
        // Treated as empty.
      }
      this.cache = {
        mtimeMs: info.mtimeMs,
        size: info.size,
        ids: new Set(Object.keys(parse(text).sessions)),
      };
    }
    if (this.open.size === 0) return this.cache.ids;
    return new Set([...this.cache.ids, ...this.open]);
  }

  /** Record a conversation agy just created for a side conversation. */
  async register(sessionId: string, parentSessionId: string): Promise<void> {
    this.open.add(sessionId);
    await this.update((sessions) => {
      sessions[sessionId] = {
        parentSessionId,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
    });
  }

  /** agy deleted the conversation; keep hiding it until its catalog row is gone. */
  async markDeleted(sessionId: string): Promise<void> {
    this.open.delete(sessionId);
    await this.update((sessions) => {
      const entry = sessions[sessionId];
      if (entry) entry.deletedAt = new Date().toISOString();
    });
  }

  /** The conversation outlived its side conversation without being deleted. */
  release(sessionId: string): void {
    this.open.delete(sessionId);
  }

  /** Conversations whose owner is gone and that agy never deleted. */
  async staleIds(now = Date.now()): Promise<string[]> {
    const { sessions } = await this.read();
    return Object.entries(sessions).flatMap(([id, entry]) => {
      if (entry.deletedAt) return [];
      const age = now - Date.parse(entry.createdAt);
      const orphan =
        entry.pid === process.pid
          ? !this.open.has(id)
          : !processAlive(entry.pid);
      return orphan || age > MAX_AGE_MS ? [id] : [];
    });
  }

  private async read(): Promise<RegistryFile> {
    return parse(await readFile(this.filePath, "utf8").catch(() => ""));
  }

  private update(
    change: (sessions: Record<string, AgySideSessionEntry>) => void,
  ): Promise<void> {
    const next = this.writes.then(async () => {
      const file = await this.read();
      change(file.sessions);
      const now = Date.now();
      for (const [id, entry] of Object.entries(file.sessions)) {
        if (
          entry.deletedAt &&
          now - Date.parse(entry.deletedAt) > DELETED_RETENTION_MS
        )
          delete file.sessions[id];
      }
      await atomicWriteJson(this.filePath, file);
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
}

let shared: AgySideSessionRegistry | null = null;

/** The registry in Yep's data dir (`YEP_ANYWHERE_DATA_DIR` aware). */
export function getAgySideSessionRegistry(): AgySideSessionRegistry {
  shared ??= new AgySideSessionRegistry();
  return shared;
}

/** True for an agy conversation that only backs a Yep side conversation. */
export function isHiddenAgySideSession(sessionId: string): boolean {
  return getAgySideSessionRegistry().isHidden(sessionId);
}
