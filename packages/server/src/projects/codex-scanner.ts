/**
 * CodexSessionScanner - Scans Codex sessions and groups them by project (cwd).
 *
 * Unlike Claude which organizes sessions by project directory, Codex stores
 * sessions by date: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Each session file has session_meta as the first line containing the cwd.
 * We scan all sessions and group them by cwd to create virtual "projects".
 *
 * The physical tree scan is shared with CodexSessionReader through a short-lived
 * manifest, so project discovery and session listing do not independently walk
 * ~/.codex/sessions.
 */

import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CodexSessionCatalog } from "../codex-history/CodexSessionCatalog.js";
import {
  type CodexSessionManifestEntry,
  getCodexSessionManifest,
  invalidateCodexSessionManifest,
} from "../sessions/codex-session-manifest.js";
import type { Project } from "../supervisor/types.js";
import { canonicalizeProjectPath, encodeProjectId } from "./paths.js";

export const CODEX_SESSIONS_DIR =
  process.env.CODEX_SESSIONS_DIR ?? getDefaultCodexSessionsDir();

export function getDefaultCodexHomeDir(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function getDefaultCodexSessionsDir(): string {
  return join(getDefaultCodexHomeDir(), "sessions");
}

interface CodexSessionInfo {
  id: string;
  cwd: string;
  filePath: string;
  timestamp: string;
  mtime: number;
  size: number;
  isSubagent: boolean;
}

export interface CodexScannerOptions {
  sessionsDir?: string; // override for testing
}

export class CodexSessionScanner {
  private sessionsDir: string;
  private sessionCatalog?: CodexSessionCatalog;

  constructor(options: CodexScannerOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? CODEX_SESSIONS_DIR;
  }

  invalidateCache(): void {
    invalidateCodexSessionManifest(this.sessionsDir);
    this.sessionCatalog?.invalidate();
  }

  setSessionCatalog(catalog: CodexSessionCatalog | undefined): void {
    this.sessionCatalog = catalog;
  }

  /**
   * Scan all Codex sessions and group them by project (cwd).
   * Returns projects sorted by last activity (most recent first).
   */
  async listProjects(): Promise<Project[]> {
    const catalog = await this.sessionCatalog?.getSnapshot();
    if (catalog) {
      return Array.from(catalog.byProjectPath, ([cwd, sessions]) => ({
        id: encodeProjectId(cwd),
        path: cwd,
        name: basename(cwd),
        sessionCount: sessions.length,
        sessionDir: this.sessionsDir,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: sessions[0]?.updatedAt ?? null,
        provider: "codex" as const,
      })).sort((left, right) =>
        (right.lastActivity ?? "").localeCompare(left.lastActivity ?? ""),
      );
    }
    const manifest = await getCodexSessionManifest(this.sessionsDir);

    // Group sessions by cwd
    const projectMap = new Map<
      string,
      { sessions: CodexSessionManifestEntry[]; lastActivity: number }
    >();

    for (const session of manifest.sessions) {
      const projectPath = canonicalizeProjectPath(session.cwd);
      const existing = projectMap.get(projectPath);
      if (existing) {
        existing.sessions.push(session);
        if (session.mtime > existing.lastActivity) {
          existing.lastActivity = session.mtime;
        }
      } else {
        projectMap.set(projectPath, {
          sessions: [session],
          lastActivity: session.mtime,
        });
      }
    }

    // Convert to Project[]
    const projects: Project[] = [];
    for (const [cwd, data] of projectMap) {
      projects.push({
        id: encodeProjectId(cwd),
        path: cwd,
        name: basename(cwd),
        sessionCount: data.sessions.length,
        sessionDir: this.sessionsDir, // All sessions are in the same tree
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: new Date(data.lastActivity).toISOString(),
        provider: "codex",
      });
    }

    // Sort by last activity descending
    projects.sort((a, b) => {
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return (
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );
    });

    return projects;
  }

  /**
   * Get sessions for a specific project (cwd).
   */
  async getSessionsForProject(
    projectPath: string,
  ): Promise<CodexSessionInfo[]> {
    const manifest = await getCodexSessionManifest(this.sessionsDir);
    const canonicalProjectPath = canonicalizeProjectPath(projectPath);
    return manifest.byProjectPath.get(canonicalProjectPath) ?? [];
  }
}
