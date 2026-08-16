import { basename } from "node:path";
import {
  PI_SESSIONS_DIR,
  type PiSessionFileRecord,
  listPiSessionFiles,
} from "../sessions/pi-files.js";
import type { Project } from "../supervisor/types.js";
import { encodeProjectId } from "./paths.js";

const SCAN_CACHE_TTL_MS = 5_000;

export interface PiScannerOptions {
  sessionsDir?: string;
}

/** Discover Pi projects from the cwd stored in each native session header. */
export class PiSessionScanner {
  private readonly sessionsDir: string;
  private cache: { records: PiSessionFileRecord[]; at: number } | null = null;

  constructor(options: PiScannerOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? PI_SESSIONS_DIR;
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
      const updatedAt = new Date(record.mtime).toISOString();
      const current = grouped.get(record.cwd);
      if (current) {
        current.count += 1;
        if (!current.lastActivity || updatedAt > current.lastActivity) {
          current.lastActivity = updatedAt;
        }
      } else {
        grouped.set(record.cwd, { count: 1, lastActivity: updatedAt });
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
      provider: "pi" as const,
    })).sort((a, b) =>
      (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""),
    );
  }

  async getSessionsForProject(
    projectPath: string,
  ): Promise<PiSessionFileRecord[]> {
    const records = await this.scan();
    return records.filter((record) => record.cwd === projectPath);
  }

  private async scan(): Promise<PiSessionFileRecord[]> {
    if (this.cache && Date.now() - this.cache.at < SCAN_CACHE_TTL_MS) {
      return this.cache.records;
    }
    const records = await listPiSessionFiles(this.sessionsDir);
    this.cache = { records, at: Date.now() };
    return records;
  }
}

export const piSessionScanner = new PiSessionScanner();
