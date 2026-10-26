import { basename } from "node:path";
import {
  DSH_SESSIONS_DIR,
  type DshSessionRecord,
  dshRecordHasConversation,
  listDshSessionRecords,
} from "../sessions/dsh-store.js";
import type { Project } from "../supervisor/types.js";
import { canonicalizeProjectPath, encodeProjectId } from "./paths.js";

const SCAN_CACHE_TTL_MS = 5_000;

export interface DshScannerOptions {
  sessionsDir?: string;
}

/** Group read-only DeepSeek Harness sessions into Yep projects by cwd. */
export class DshSessionScanner {
  private readonly sessionsDir: string;
  private cache: { records: DshSessionRecord[]; at: number } | null = null;

  constructor(options: DshScannerOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? DSH_SESSIONS_DIR;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  async listProjects(): Promise<Project[]> {
    const records = await this.scan();
    const grouped = new Map<
      string,
      { count: number; lastActivity: string | null }
    >();
    for (const record of records) {
      const path = canonicalizeProjectPath(record.cwd);
      const updatedAt = new Date(record.updatedAtMs).toISOString();
      const current = grouped.get(path);
      if (current) {
        current.count += 1;
        if (!current.lastActivity || updatedAt > current.lastActivity) {
          current.lastActivity = updatedAt;
        }
      } else {
        grouped.set(path, { count: 1, lastActivity: updatedAt });
      }
    }
    return Array.from(grouped, ([path, value]) => ({
      id: encodeProjectId(path),
      path,
      name: basename(path),
      sessionCount: value.count,
      sessionDir: this.sessionsDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: value.lastActivity,
      provider: "dsh" as const,
      hasDshSessions: true,
    }));
  }

  async getSessionsForProject(
    projectPath: string,
  ): Promise<DshSessionRecord[]> {
    const target = canonicalizeProjectPath(projectPath);
    const records = await this.scan();
    return records.filter(
      (record) => canonicalizeProjectPath(record.cwd) === target,
    );
  }

  private async scan(): Promise<DshSessionRecord[]> {
    if (this.cache && Date.now() - this.cache.at < SCAN_CACHE_TTL_MS) {
      return this.cache.records;
    }
    const all = await listDshSessionRecords({ sessionsDir: this.sessionsDir });
    const records: DshSessionRecord[] = [];
    for (const record of all) {
      if (await dshRecordHasConversation(record)) records.push(record);
    }
    this.cache = { records, at: Date.now() };
    return records;
  }
}
