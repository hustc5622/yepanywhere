import { basename } from "node:path";
import { OPENCODE_DB_PATH, withOpenCodeDb } from "../sessions/opencode-db.js";
import type { Project } from "../supervisor/types.js";
import { canonicalizeProjectPath, encodeProjectId } from "./paths.js";

export { OPENCODE_DB_PATH };

interface OpenCodeProjectInfo {
  path: string;
  sessionCount: number;
  lastActivity: string | null;
}

export interface OpenCodeSessionInfo {
  id: string;
  directory: string;
  filePath: string;
  timestamp: string;
  mtime: number;
}

export interface OpenCodeScannerOptions {
  dbPath?: string;
}

const SCAN_CACHE_TTL = 5_000;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export class OpenCodeSessionScanner {
  private dbPath: string;
  private cachedProjects: {
    result: OpenCodeProjectInfo[];
    timestamp: number;
  } | null = null;

  constructor(options: OpenCodeScannerOptions = {}) {
    this.dbPath = options.dbPath ?? OPENCODE_DB_PATH;
  }

  invalidateCache(): void {
    this.cachedProjects = null;
  }

  async listProjects(): Promise<Project[]> {
    const projectInfos = await this.scanProjects();
    return projectInfos
      .map((info) => {
        const path = canonicalizeProjectPath(info.path);
        return {
          id: encodeProjectId(path),
          path,
          name: basename(path),
          sessionCount: info.sessionCount,
          sessionDir: this.dbPath,
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: info.lastActivity,
          provider: "opencode" as const,
        };
      })
      .sort((a, b) => {
        if (!a.lastActivity) return 1;
        if (!b.lastActivity) return -1;
        return (
          new Date(b.lastActivity).getTime() -
          new Date(a.lastActivity).getTime()
        );
      });
  }

  async getSessionsForProject(
    projectPath: string,
  ): Promise<OpenCodeSessionInfo[]> {
    const canonicalProjectPath = canonicalizeProjectPath(projectPath);
    return withOpenCodeDb(this.dbPath, [], (db) => {
      const rows = db
        .prepare(
          `
            SELECT id, directory, time_updated
            FROM session
            WHERE directory = ? AND time_archived IS NULL
            ORDER BY time_updated DESC
          `,
        )
        .all(canonicalProjectPath);

      return rows
        .map((row) => {
          const id = asString(row.id);
          const directory = asString(row.directory);
          const mtime = asNumber(row.time_updated);
          if (!id || !directory || mtime === undefined) return null;
          return {
            id,
            directory,
            filePath: this.dbPath,
            timestamp: new Date(mtime).toISOString(),
            mtime,
          };
        })
        .filter((item): item is OpenCodeSessionInfo => item !== null);
    });
  }

  private async scanProjects(): Promise<OpenCodeProjectInfo[]> {
    if (
      this.cachedProjects &&
      Date.now() - this.cachedProjects.timestamp < SCAN_CACHE_TTL
    ) {
      return this.cachedProjects.result;
    }

    const result = await withOpenCodeDb(this.dbPath, [], (db) => {
      const rows = db
        .prepare(
          `
            SELECT directory, COUNT(*) AS session_count, MAX(time_updated) AS last_updated
            FROM session
            WHERE directory IS NOT NULL
              AND directory != ''
              AND time_archived IS NULL
            GROUP BY directory
          `,
        )
        .all();

      return rows
        .map((row) => {
          const rawPath = asString(row.directory);
          const sessionCount = asNumber(row.session_count) ?? 0;
          const lastUpdated = asNumber(row.last_updated);
          if (!rawPath || sessionCount <= 0) return null;

          return {
            path: canonicalizeProjectPath(rawPath),
            sessionCount,
            lastActivity:
              lastUpdated !== undefined
                ? new Date(lastUpdated).toISOString()
                : null,
          };
        })
        .filter((item): item is OpenCodeProjectInfo => item !== null);
    });

    this.cachedProjects = { result, timestamp: Date.now() };
    return result;
  }
}
