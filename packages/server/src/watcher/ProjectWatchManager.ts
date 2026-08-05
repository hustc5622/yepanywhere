/**
 * ProjectWatchManager
 *
 * Watches a project's working directory and emits `project-file-changed`
 * events on the shared EventBus whenever a file or directory inside it
 * changes. The frontend subscribes to those events (over the activity
 * stream) and refreshes the repository tree so it never goes stale relative
 * to the real filesystem.
 *
 * Design notes:
 * - Each project is watched with a private EventBus + the existing recursive
 *   FileWatcher (which already does per-file debounce + periodic rescan). The
 *   private bus keeps the raw provider="project" file-change events off the
 *   shared bus, so scanner / session-index subscribers never see them; only
 *   the translated `project-file-changed` event reaches the shared bus.
 * - Watching is reference-counted by lazily starting on first `ensureWatching`
 *   and stopping after an idle period (no frontend is browsing that project).
 * - The frontend already filters events by projectId, so broadcasting to all
 *   activity subscribers is safe.
 */

import type { UrlProjectId } from "@yep-anywhere/shared";
import type { FileChangeEvent, ProjectFileChangedEvent } from "./EventBus.js";
import { EventBus, FileWatcher } from "./index.js";

export interface ProjectWatchManagerOptions {
  /** Shared bus on which project-file-changed events are emitted. */
  eventBus: EventBus;
  /** Per-file debounce for the underlying FileWatcher (default 300ms). */
  debounceMs?: number;
  /** Periodic full-tree rescan to catch events fs.watch misses (default 4s). */
  periodicRescanMs?: number;
  /** Stop a watcher this long after its last `ensureWatching` call (default 15m). */
  idleTimeoutMs?: number;
}

interface ProjectWatchTarget {
  projectId: UrlProjectId;
  path: string;
  watcher: FileWatcher;
  privateBus: EventBus;
  unsubscribe: () => void;
  lastUsed: number;
}

export class ProjectWatchManager {
  private readonly eventBus: EventBus;
  private readonly debounceMs: number;
  private readonly periodicRescanMs: number;
  private readonly idleTimeoutMs: number;
  private readonly targets = new Map<string, ProjectWatchTarget>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ProjectWatchManagerOptions) {
    this.eventBus = options.eventBus;
    this.debounceMs = Math.max(50, options.debounceMs ?? 300);
    this.periodicRescanMs = options.periodicRescanMs ?? 4000;
    this.idleTimeoutMs = Math.max(60_000, options.idleTimeoutMs ?? 15 * 60_000);
  }

  /**
   * Start (or keep alive) watching a project's working directory. Called when
   * the frontend browses the project's file tree; the lastUsed timestamp is
   * bumped so the watcher isn't reaped while the user is exploring.
   */
  ensureWatching(projectId: UrlProjectId, projectPath: string): void {
    this.ensureSweep();
    const existing = this.targets.get(projectId);
    if (existing) {
      existing.lastUsed = Date.now();
      if (existing.path !== projectPath) {
        this.teardownTarget(existing);
        this.targets.delete(projectId);
        this.createTarget(projectId, projectPath);
      }
      return;
    }
    this.createTarget(projectId, projectPath);
  }

  /** Stop all watchers and the idle sweeper. Call on server shutdown. */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const target of this.targets.values()) {
      this.teardownTarget(target);
    }
    this.targets.clear();
  }

  private createTarget(projectId: UrlProjectId, projectPath: string): void {
    const privateBus = new EventBus();
    const watcher = new FileWatcher({
      watchDir: projectPath,
      provider: "project",
      eventBus: privateBus,
      debounceMs: this.debounceMs,
      periodicRescanMs: this.periodicRescanMs,
    });

    const unsubscribe = privateBus.subscribe((event) => {
      if (event.type === "file-change") {
        this.onRawChange(projectId, event as FileChangeEvent);
      }
    });

    watcher.start();

    this.targets.set(projectId, {
      projectId,
      path: projectPath,
      watcher,
      privateBus,
      unsubscribe,
      lastUsed: Date.now(),
    });
  }

  private onRawChange(projectId: UrlProjectId, event: FileChangeEvent): void {
    const payload: ProjectFileChangedEvent = {
      type: "project-file-changed",
      projectId,
      path: event.path,
      relativePath: event.relativePath,
      changeType: event.changeType,
      timestamp: event.timestamp,
    };
    this.eventBus.emit(payload);
  }

  private teardownTarget(target: ProjectWatchTarget): void {
    target.unsubscribe();
    target.watcher.stop();
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, target] of this.targets) {
        if (now - target.lastUsed > this.idleTimeoutMs) {
          this.teardownTarget(target);
          this.targets.delete(id);
        }
      }
    }, 60_000);
  }
}
