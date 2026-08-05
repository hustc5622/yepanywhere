import * as fs from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { Project } from "../supervisor/types.js";

const logger = getLogger();

/**
 * Change source for a project-repo file change event.
 */
export type ProjectFileChangeSource = "fs-watch" | "poll";

/**
 * A single changed entry reported to subscribers.
 */
export interface ProjectFileChangeDetail {
  /** Relative path from the project root ("" for the root itself). */
  path: string;
  /** Best-effort classification of the entry. */
  entryType: "file" | "dir" | "unknown";
  /** Best-effort classification of the change. */
  changeType: "create" | "modify" | "delete" | "unknown";
}

/**
 * Event pushed to subscribers when the project's repository directory changes.
 * `changes` lists every distinct entry that changed during the debounce window.
 */
export interface ProjectFileChangeEvent {
  type: "project-files-changed";
  projectId: UrlProjectId;
  changes: ProjectFileChangeDetail[];
  source: ProjectFileChangeSource;
  timestamp: string;
}

export interface ProjectFileWatchManagerOptions {
  /** Resolves a project by id so we can locate its working directory. */
  scanner: {
    getProject(projectId: string): Promise<Project | null>;
  };
  /** Debounce window for collapsing bursts of filesystem events (ms). */
  debounceMs?: number;
}

/**
 * Directories we never descend into when watching. Watching node_modules /
 * build output recursively is expensive (thousands of watchers, EMFILE risk)
 * and its contents rarely matter for real-time session repo browsing.
 */
const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  ".turbo",
  ".svelte-kit",
  ".idea",
  ".vscode",
]);

interface ProjectWatchTarget {
  projectId: UrlProjectId;
  rootPath: string | null;
  subscribers: Map<number, (event: ProjectFileChangeEvent) => void>;
  /** absolute dir path -> active watcher */
  dirWatchers: Map<string, fs.FSWatcher>;
  pendingPaths: Set<string>;
  debounceTimer: NodeJS.Timeout | null;
  /** Retry timer used when the project path isn't resolvable yet. */
  retryTimer: NodeJS.Timeout | null;
  starting: boolean;
}

/**
 * Reference-counted, per-project recursive file watcher.
 *
 * Mirrors the lifecycle of FocusedSessionWatchManager but watches an entire
 * project working directory (recursively, cross-platform via per-directory
 * fs.watch) so the client can refresh its repository file tree in real time
 * whenever a file is created / modified / deleted — by the in-app editor, the
 * AI agent, or any external tool.
 *
 * Subscribers are reference-counted per projectId: the watch starts on the
 * first subscriber and stops (closing all fs.watchers) when the last one
 * unsubscribes or the connection drops.
 */
export class ProjectFileWatchManager {
  private static readonly LOG_EVENTS =
    process.env.PROJECT_FILE_WATCH_LOG_EVENTS === "true";
  private readonly scanner: ProjectFileWatchManagerOptions["scanner"];
  private readonly debounceMs: number;
  private readonly targets = new Map<string, ProjectWatchTarget>();
  private nextSubscriberId = 1;

  constructor(options: ProjectFileWatchManagerOptions) {
    this.scanner = options.scanner;
    this.debounceMs = Math.max(50, options.debounceMs ?? 250);
  }

  subscribe(
    projectId: UrlProjectId,
    onChange: (event: ProjectFileChangeEvent) => void,
  ): () => void {
    let target = this.targets.get(projectId);
    if (!target) {
      target = this.createTarget(projectId);
      this.targets.set(projectId, target);
    }

    const subscriberId = this.nextSubscriberId++;
    target.subscribers.set(subscriberId, onChange);

    if (target.subscribers.size === 1) {
      void this.ensureWatching(target);
    }

    return () => {
      const current = this.targets.get(projectId);
      if (!current) return;
      current.subscribers.delete(subscriberId);
      if (current.subscribers.size === 0) {
        this.teardownTarget(current);
        this.targets.delete(projectId);
      }
    };
  }

  dispose(): void {
    for (const target of this.targets.values()) {
      this.teardownTarget(target);
    }
    this.targets.clear();
  }

  private createTarget(projectId: UrlProjectId): ProjectWatchTarget {
    return {
      projectId,
      rootPath: null,
      subscribers: new Map(),
      dirWatchers: new Map(),
      pendingPaths: new Set(),
      debounceTimer: null,
      retryTimer: null,
      starting: false,
    };
  }

  private async ensureWatching(target: ProjectWatchTarget): Promise<void> {
    if (target.starting || target.subscribers.size === 0) return;
    target.starting = true;
    try {
      const project = await this.scanner.getProject(target.projectId);
      if (!project || !project.path) {
        this.scheduleRetry(target);
        return;
      }
      this.clearRetry(target);

      const root = project.path;
      if (target.rootPath === root && target.dirWatchers.size > 0) {
        return;
      }
      target.rootPath = root;
      this.watchDir(target, root);
      await this.watchExistingSubdirs(target, root);

      if (ProjectFileWatchManager.LOG_EVENTS) {
        logger.info(
          `[ProjectFileWatch] Watching project=${target.projectId} root=${root}`,
        );
      }
    } catch (err) {
      logger.warn(
        { err },
        `[ProjectFileWatch] Failed to start watch for ${target.projectId}:`,
      );
      this.scheduleRetry(target);
    } finally {
      target.starting = false;
    }
  }

  private scheduleRetry(target: ProjectWatchTarget): void {
    if (target.retryTimer) return;
    target.retryTimer = setInterval(() => {
      void this.ensureWatching(target);
    }, 5000);
  }

  private clearRetry(target: ProjectWatchTarget): void {
    if (!target.retryTimer) return;
    clearInterval(target.retryTimer);
    target.retryTimer = null;
  }

  private watchDir(target: ProjectWatchTarget, dir: string): void {
    if (target.dirWatchers.has(dir)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, (eventType, filename) => {
        if (filename) {
          const abs = join(dir, filename.toString());
          const rel = target.rootPath ? relative(target.rootPath, abs) : abs;
          target.pendingPaths.add(rel);
          void this.reconcileDir(target, abs);
        } else {
          // Some platforms emit events without a filename — mark root dirty.
          target.pendingPaths.add("");
        }
        this.scheduleDebouncedEmit(target);
      });
    } catch (err) {
      logger.warn({ err }, `[ProjectFileWatch] fs.watch failed for ${dir}:`);
      // If the root itself fails, retry later.
      if (dir === target.rootPath) this.scheduleRetry(target);
      return;
    }

    watcher.on("error", () => {
      // A watcher died (e.g., directory removed). Drop it and reconcile.
      this.unwatch(target, dir);
      void this.reconcileDir(target, dir);
    });

    target.dirWatchers.set(dir, watcher);
  }

  private unwatch(target: ProjectWatchTarget, dir: string): void {
    const watcher = target.dirWatchers.get(dir);
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
      target.dirWatchers.delete(dir);
    }
    // Remove any descendant watchers too.
    const prefix = `${dir}${sep}`;
    for (const key of Array.from(target.dirWatchers.keys())) {
      if (key === prefix || key.startsWith(prefix)) {
        const w = target.dirWatchers.get(key);
        try {
          w?.close();
        } catch {
          // ignore
        }
        target.dirWatchers.delete(key);
      }
    }
  }

  /**
   * Keep the watcher set in sync with the actual directory structure: watch
   * newly-created subdirectories, and drop watchers for removed ones.
   */
  private async reconcileDir(
    target: ProjectWatchTarget,
    abs: string,
  ): Promise<void> {
    if (!target.rootPath) return;
    let stats: fs.Stats | null = null;
    try {
      stats = await stat(abs);
    } catch {
      stats = null;
    }

    if (stats?.isDirectory()) {
      if (!target.dirWatchers.has(abs)) {
        this.watchDir(target, abs);
        await this.watchExistingSubdirs(target, abs);
      }
    } else if (!stats) {
      if (target.dirWatchers.has(abs)) {
        this.unwatch(target, abs);
      }
    }
  }

  private async watchExistingSubdirs(
    target: ProjectWatchTarget,
    dir: string,
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      const sub = join(dir, entry.name);
      if (!target.dirWatchers.has(sub)) {
        this.watchDir(target, sub);
        await this.watchExistingSubdirs(target, sub);
      }
    }
  }

  private scheduleDebouncedEmit(target: ProjectWatchTarget): void {
    if (target.debounceTimer) clearTimeout(target.debounceTimer);
    target.debounceTimer = setTimeout(() => {
      target.debounceTimer = null;
      void this.emitChanges(target);
    }, this.debounceMs);
  }

  private async emitChanges(target: ProjectWatchTarget): Promise<void> {
    if (target.subscribers.size === 0 || !target.rootPath) {
      target.pendingPaths.clear();
      return;
    }

    const changed = Array.from(target.pendingPaths);
    target.pendingPaths.clear();

    const details: ProjectFileChangeDetail[] = await Promise.all(
      changed.map(async (rel): Promise<ProjectFileChangeDetail> => {
        const abs = target.rootPath ? join(target.rootPath, rel) : rel;
        try {
          const stats = await stat(abs);
          return {
            path: rel,
            entryType: stats.isDirectory() ? "dir" : "file",
            changeType: "modify",
          };
        } catch {
          return { path: rel, entryType: "unknown", changeType: "delete" };
        }
      }),
    );

    const event: ProjectFileChangeEvent = {
      type: "project-files-changed",
      projectId: target.projectId,
      changes: details,
      source: "fs-watch",
      timestamp: new Date().toISOString(),
    };

    if (ProjectFileWatchManager.LOG_EVENTS) {
      logger.info(
        `[ProjectFileWatch] change project=${event.projectId} paths=${details
          .map((d) => d.path)
          .join(", ")}`,
      );
    }

    for (const callback of target.subscribers.values()) {
      try {
        callback(event);
      } catch (err) {
        logger.error({ err }, "[ProjectFileWatch] subscriber callback failed:");
      }
    }
  }

  private teardownTarget(target: ProjectWatchTarget): void {
    for (const watcher of target.dirWatchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    target.dirWatchers.clear();
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }
    this.clearRetry(target);
    target.pendingPaths.clear();
    target.rootPath = null;
  }
}
