import { basename } from "node:path";
import {
  AGY_BRAIN_DIR,
  AGY_DATA_DIR,
  type AgySessionRecord,
  listAgySessionRecords,
} from "../sessions/agy-store.js";
import type { Project } from "../supervisor/types.js";
import { canonicalizeProjectPath, encodeProjectId } from "./paths.js";

const SCAN_CACHE_TTL_MS = 5_000;

export interface AgyScannerOptions {
  dataDir?: string;
}

/** Group Antigravity CLI catalog rows into Yep projects by workspace cwd. */
export class AgySessionScanner {
  private readonly dataDir: string;
  private readonly sessionsDir: string;
  private cache: { records: AgySessionRecord[]; at: number } | null = null;

  constructor(options: AgyScannerOptions = {}) {
    this.dataDir = options.dataDir ?? AGY_DATA_DIR;
    this.sessionsDir =
      options.dataDir !== undefined
        ? `${options.dataDir}/brain`
        : AGY_BRAIN_DIR;
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
      provider: "agy" as const,
      hasAgySessions: true,
    }));
  }

  async getSessionsForProject(
    projectPath: string,
  ): Promise<AgySessionRecord[]> {
    const target = canonicalizeProjectPath(projectPath);
    const records = await this.scan();
    return records.filter(
      (record) => canonicalizeProjectPath(record.cwd) === target,
    );
  }

  private async scan(): Promise<AgySessionRecord[]> {
    if (this.cache && Date.now() - this.cache.at < SCAN_CACHE_TTL_MS) {
      return this.cache.records;
    }
    const records = await listAgySessionRecords({ dataDir: this.dataDir });
    this.cache = { records, at: Date.now() };
    return records;
  }
}
