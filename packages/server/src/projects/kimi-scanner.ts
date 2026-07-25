/**
 * KimiSessionScanner - Scans Kimi Code CLI sessions and groups them by project.
 *
 * Kimi maintains two index files under ~/.kimi-code:
 *   - session_index.jsonl : {sessionId, sessionDir, workDir} per session
 *   - workspaces.json     : workspace-id → {root, name, last_opened_at}
 *
 * This makes project discovery direct (no directory-hash guessing like Gemini):
 * sessions are grouped by their `workDir`, and workspace metadata supplies the
 * display name and last-activity timestamp.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Project } from "../supervisor/types.js";
import { encodeProjectId } from "./paths.js";

const KIMI_HOME = process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
export const KIMI_SESSIONS_DIR =
  process.env.KIMI_SESSIONS_DIR ?? join(KIMI_HOME, "sessions");

const SCAN_CACHE_TTL = 5_000;

interface KimiIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

interface KimiWorkspaceMeta {
  root: string;
  name?: string;
  lastOpenedAt?: string;
}

export interface KimiScannerOptions {
  /** Override the Kimi home dir (parent of sessions + index files). */
  homeDir?: string;
  /** Override the sessions dir (defaults to <homeDir>/sessions). */
  sessionsDir?: string;
}

export class KimiSessionScanner {
  private homeDir: string;
  private sessionsDir: string;
  private cached: {
    entries: KimiIndexEntry[];
    workspaces: KimiWorkspaceMeta[];
    timestamp: number;
  } | null = null;

  constructor(options: KimiScannerOptions = {}) {
    this.homeDir = options.homeDir ?? KIMI_HOME;
    this.sessionsDir = options.sessionsDir ?? join(this.homeDir, "sessions");
  }

  invalidateCache(): void {
    this.cached = null;
  }

  /**
   * Group Kimi sessions by their working directory into projects.
   */
  async listProjects(): Promise<Project[]> {
    const { entries, workspaces } = await this.scan();

    const byWorkDir = new Map<string, { count: number }>();
    for (const entry of entries) {
      if (!entry.workDir) continue;
      const existing = byWorkDir.get(entry.workDir);
      if (existing) existing.count += 1;
      else byWorkDir.set(entry.workDir, { count: 1 });
    }

    const workspaceByRoot = new Map<string, KimiWorkspaceMeta>();
    for (const ws of workspaces) {
      if (ws.root) workspaceByRoot.set(ws.root, ws);
    }

    const projects: Project[] = [];
    for (const [workDir, data] of byWorkDir) {
      const ws = workspaceByRoot.get(workDir);
      projects.push({
        id: encodeProjectId(workDir),
        path: workDir,
        name: ws?.name ?? basename(workDir),
        sessionCount: data.count,
        sessionDir: this.sessionsDir,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: ws?.lastOpenedAt ?? null,
        provider: "kimi",
      });
    }

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
   * Return the index entries for a specific project cwd.
   */
  async getSessionsForProject(projectPath: string): Promise<KimiIndexEntry[]> {
    const { entries } = await this.scan();
    return entries.filter((e) => e.workDir === projectPath);
  }

  private async scan(): Promise<{
    entries: KimiIndexEntry[];
    workspaces: KimiWorkspaceMeta[];
  }> {
    if (this.cached && Date.now() - this.cached.timestamp < SCAN_CACHE_TTL) {
      return {
        entries: this.cached.entries,
        workspaces: this.cached.workspaces,
      };
    }

    const [entries, workspaces] = await Promise.all([
      this.readSessionIndex(),
      this.readWorkspaces(),
    ]);

    this.cached = { entries, workspaces, timestamp: Date.now() };
    return { entries, workspaces };
  }

  private async readSessionIndex(): Promise<KimiIndexEntry[]> {
    const entries: KimiIndexEntry[] = [];
    let content: string;
    try {
      content = await readFile(
        join(this.homeDir, "session_index.jsonl"),
        "utf-8",
      );
    } catch {
      return entries;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<KimiIndexEntry>;
        if (
          typeof parsed.sessionId === "string" &&
          typeof parsed.sessionDir === "string" &&
          typeof parsed.workDir === "string"
        ) {
          entries.push({
            sessionId: parsed.sessionId,
            sessionDir: parsed.sessionDir,
            workDir: parsed.workDir,
          });
        }
      } catch {
        // Skip malformed lines.
      }
    }
    return entries;
  }

  private async readWorkspaces(): Promise<KimiWorkspaceMeta[]> {
    let content: string;
    try {
      content = await readFile(join(this.homeDir, "workspaces.json"), "utf-8");
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(content) as {
        workspaces?: Record<
          string,
          { root?: string; name?: string; last_opened_at?: string }
        >;
      };
      const out: KimiWorkspaceMeta[] = [];
      for (const ws of Object.values(parsed.workspaces ?? {})) {
        if (typeof ws?.root === "string") {
          out.push({
            root: ws.root,
            name: ws.name,
            lastOpenedAt: ws.last_opened_at,
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}

export const kimiSessionScanner = new KimiSessionScanner();
