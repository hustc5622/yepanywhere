import * as fs from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { normalizeProviderGroup } from "../sessions/provider-groups.js";
import type { Project } from "../supervisor/types.js";

type WatchProvider = "claude" | "codex" | "gemini" | "opencode" | "kimi";
type ChangeSource = "fs-watch" | "poll";

interface CodexSessionInfo {
  id: string;
  filePath: string;
}

interface GeminiSessionInfo {
  id: string;
  filePath: string;
}

interface OpenCodeSessionInfo {
  id: string;
  filePath: string;
  /** OpenCode stores every session in one SQLite file; use this row version
   * to distinguish an update to the selected session from another session's
   * database write. */
  mtime?: number;
}

interface SessionWatchTarget {
  key: string;
  sessionId: string;
  projectId: UrlProjectId;
  providerHint?: string;
  subscribers: Map<number, (event: FocusedSessionWatchEvent) => void>;
  filePath: string | null;
  fileName: string | null;
  provider: WatchProvider | null;
  knownMtimeMs: number | null;
  knownSize: number | null;
  /** Provider-specific session version. Only set for OpenCode SQLite rows. */
  knownSessionMtime: number | null;
  watcher: fs.FSWatcher | null;
  pollTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  resolveRetryTimer: NodeJS.Timeout | null;
  resolving: boolean;
  checkInProgress: boolean;
}

export interface FocusedSessionWatchRequest {
  sessionId: string;
  projectId: UrlProjectId;
  providerHint?: string;
}

export interface FocusedSessionWatchEvent {
  type: "session-watch-change";
  sessionId: string;
  projectId: UrlProjectId;
  provider: WatchProvider;
  path: string;
  source: ChangeSource;
  timestamp: string;
}

export interface FocusedSessionWatchManagerOptions {
  scanner: {
    getProject(projectId: string): Promise<Project | null>;
    getOrCreateProject(projectId: string): Promise<Project | null>;
  };
  codexScanner: {
    getSessionsForProject(projectPath: string): Promise<CodexSessionInfo[]>;
  };
  geminiScanner: {
    getSessionsForProject(projectPath: string): Promise<GeminiSessionInfo[]>;
  };
  opencodeScanner?: {
    getSessionsForProject(projectPath: string): Promise<OpenCodeSessionInfo[]>;
  };
  pollMs?: number;
  debounceMs?: number;
}

interface ResolvedSessionFile {
  filePath: string;
  provider: WatchProvider;
  /**
   * OpenCode sessions share one SQLite file. The per-row time_updated value
   * lets us avoid emitting a change for every other session's write.
   */
  sessionMtime?: number;
}

/**
 * Focused, per-session file watcher with polling fallback.
 *
 * This is designed for "open session" UI views where missing updates is
 * catastrophic. Watches are reference-counted per (projectId, sessionId).
 */
export class FocusedSessionWatchManager {
  private static readonly LOG_EVENTS =
    process.env.SESSION_FOCUSED_WATCH_LOG_EVENTS === "true";
  private readonly scanner: FocusedSessionWatchManagerOptions["scanner"];
  private readonly codexScanner: FocusedSessionWatchManagerOptions["codexScanner"];
  private readonly geminiScanner: FocusedSessionWatchManagerOptions["geminiScanner"];
  private readonly opencodeScanner: FocusedSessionWatchManagerOptions["opencodeScanner"];
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private readonly targets = new Map<string, SessionWatchTarget>();
  private nextSubscriberId = 1;

  constructor(options: FocusedSessionWatchManagerOptions) {
    this.scanner = options.scanner;
    this.codexScanner = options.codexScanner;
    this.geminiScanner = options.geminiScanner;
    this.opencodeScanner = options.opencodeScanner;
    this.pollMs = Math.max(250, options.pollMs ?? 1500);
    this.debounceMs = Math.max(50, options.debounceMs ?? 200);
  }

  subscribe(
    request: FocusedSessionWatchRequest,
    onChange: (event: FocusedSessionWatchEvent) => void,
  ): () => void {
    const key = this.getKey(request);
    let target = this.targets.get(key);
    if (!target) {
      target = this.createTarget(request);
      this.targets.set(key, target);
    }

    const subscriberId = this.nextSubscriberId++;
    target.subscribers.set(subscriberId, onChange);

    if (target.subscribers.size === 1) {
      void this.ensureWatching(target);
    }

    return () => {
      const current = this.targets.get(key);
      if (!current) return;
      current.subscribers.delete(subscriberId);
      if (current.subscribers.size === 0) {
        this.teardownTarget(current);
        this.targets.delete(key);
      }
    };
  }

  dispose(): void {
    for (const target of this.targets.values()) {
      this.teardownTarget(target);
    }
    this.targets.clear();
  }

  private getKey(request: FocusedSessionWatchRequest): string {
    return `${request.projectId}:${request.sessionId}`;
  }

  private createTarget(
    request: FocusedSessionWatchRequest,
  ): SessionWatchTarget {
    return {
      key: this.getKey(request),
      sessionId: request.sessionId,
      projectId: request.projectId,
      providerHint: request.providerHint,
      subscribers: new Map(),
      filePath: null,
      fileName: null,
      provider: null,
      knownMtimeMs: null,
      knownSize: null,
      knownSessionMtime: null,
      watcher: null,
      pollTimer: null,
      debounceTimer: null,
      resolveRetryTimer: null,
      resolving: false,
      checkInProgress: false,
    };
  }

  private async ensureWatching(target: SessionWatchTarget): Promise<void> {
    if (target.resolving || target.subscribers.size === 0) {
      return;
    }
    target.resolving = true;
    try {
      const resolved = await this.resolveSessionFile(target);
      if (!resolved) {
        this.ensureResolveRetry(target);
        return;
      }

      this.clearResolveRetry(target);

      if (target.filePath === resolved.filePath && target.watcher) {
        return;
      }

      await this.attachTargetToFile(target, resolved);
    } finally {
      target.resolving = false;
    }
  }

  private ensureResolveRetry(target: SessionWatchTarget): void {
    if (target.resolveRetryTimer) return;
    target.resolveRetryTimer = setInterval(
      () => {
        void this.ensureWatching(target);
      },
      Math.max(this.pollMs * 2, 2000),
    );
  }

  private clearResolveRetry(target: SessionWatchTarget): void {
    if (!target.resolveRetryTimer) return;
    clearInterval(target.resolveRetryTimer);
    target.resolveRetryTimer = null;
  }

  private async attachTargetToFile(
    target: SessionWatchTarget,
    resolved: ResolvedSessionFile,
  ): Promise<void> {
    this.teardownRuntime(target);

    target.filePath = resolved.filePath;
    target.fileName = basename(resolved.filePath);
    target.provider = resolved.provider;
    target.knownSessionMtime = resolved.sessionMtime ?? null;

    try {
      const stats = await stat(resolved.filePath);
      target.knownMtimeMs = stats.mtimeMs;
      target.knownSize = stats.size;
    } catch {
      target.knownMtimeMs = null;
      target.knownSize = null;
    }

    try {
      const watchDir = dirname(resolved.filePath);
      target.watcher = fs.watch(watchDir, (_eventType, filename) => {
        if (filename) {
          const changedName = filename.toString();
          if (changedName !== target.fileName) return;
        }
        this.scheduleDebouncedCheck(target, "fs-watch");
      });
      target.watcher.on("error", () => {
        this.scheduleDebouncedCheck(target, "fs-watch");
      });
    } catch (error) {
      console.warn(
        `[FocusedSessionWatch] Failed to start fs.watch for ${resolved.filePath}:`,
        error,
      );
    }

    target.pollTimer = setInterval(() => {
      void this.checkForChanges(target, "poll");
    }, this.pollMs);

    if (FocusedSessionWatchManager.LOG_EVENTS) {
      console.log(
        `[FocusedSessionWatch] Watching session=${target.sessionId} project=${target.projectId} file=${resolved.filePath}`,
      );
    }
  }

  private scheduleDebouncedCheck(
    target: SessionWatchTarget,
    source: ChangeSource,
  ): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
    }
    target.debounceTimer = setTimeout(() => {
      target.debounceTimer = null;
      void this.checkForChanges(target, source);
    }, this.debounceMs);
  }

  private async checkForChanges(
    target: SessionWatchTarget,
    source: ChangeSource,
  ): Promise<void> {
    if (target.checkInProgress || target.subscribers.size === 0) {
      return;
    }
    target.checkInProgress = true;

    try {
      const filePath = target.filePath;
      if (!filePath || !target.provider) {
        await this.ensureWatching(target);
        return;
      }

      let nextMtimeMs: number;
      let nextSize: number;
      try {
        const stats = await stat(filePath);
        nextMtimeMs = stats.mtimeMs;
        nextSize = stats.size;
      } catch {
        target.knownMtimeMs = null;
        target.knownSize = null;
        await this.ensureWatching(target);
        return;
      }

      const hadBaseline =
        target.knownMtimeMs !== null && target.knownSize !== null;
      const changed =
        hadBaseline &&
        (target.knownMtimeMs !== nextMtimeMs || target.knownSize !== nextSize);

      target.knownMtimeMs = nextMtimeMs;
      target.knownSize = nextSize;

      if (!changed) {
        return;
      }

      // OpenCode uses one database file for every session. A database mtime
      // alone therefore tells us only that *some* OpenCode session changed.
      // Re-resolve the selected row and emit only when its time_updated value
      // changed too. Without this guard, one active `of` session repeatedly
      // refreshes every other OpenCode session currently open in Yep.
      if (target.provider === "opencode") {
        const resolved = await this.resolveSessionFile(target);
        if (!resolved || resolved.provider !== "opencode") {
          await this.ensureWatching(target);
          return;
        }

        const nextSessionMtime = resolved.sessionMtime ?? null;
        if (nextSessionMtime === target.knownSessionMtime) {
          return;
        }
        target.knownSessionMtime = nextSessionMtime;
      }

      const event: FocusedSessionWatchEvent = {
        type: "session-watch-change",
        sessionId: target.sessionId,
        projectId: target.projectId,
        provider: target.provider,
        path: filePath,
        source,
        timestamp: new Date().toISOString(),
      };

      if (FocusedSessionWatchManager.LOG_EVENTS) {
        console.log(
          `[FocusedSessionWatch] change session=${event.sessionId} project=${event.projectId} source=${event.source} file=${event.path}`,
        );
      }

      for (const callback of target.subscribers.values()) {
        try {
          callback(event);
        } catch (error) {
          console.error(
            "[FocusedSessionWatch] subscriber callback failed:",
            error,
          );
        }
      }
    } finally {
      target.checkInProgress = false;
    }
  }

  private async resolveSessionFile(
    target: SessionWatchTarget,
  ): Promise<ResolvedSessionFile | null> {
    const project =
      (await this.scanner.getProject(target.projectId)) ??
      (await this.scanner.getOrCreateProject(target.projectId));

    if (!project) {
      return null;
    }

    const providerCandidates = this.getProviderCandidates(
      target.providerHint,
      project.provider,
    );

    for (const provider of providerCandidates) {
      if (provider === "claude") {
        const dirs = [project.sessionDir, ...(project.mergedSessionDirs ?? [])];
        for (const dir of dirs) {
          const candidate = join(dir, `${target.sessionId}.jsonl`);
          if (await this.fileExists(candidate)) {
            return { filePath: candidate, provider };
          }
        }
        continue;
      }

      if (provider === "codex") {
        const sessions = await this.codexScanner.getSessionsForProject(
          project.path,
        );
        const match = sessions.find(
          (session) => session.id === target.sessionId,
        );
        if (match) {
          return { filePath: match.filePath, provider };
        }
        continue;
      }

      if (provider === "gemini") {
        const sessions = await this.geminiScanner.getSessionsForProject(
          project.path,
        );
        const match = sessions.find(
          (session) => session.id === target.sessionId,
        );
        if (match) {
          return { filePath: match.filePath, provider };
        }
        continue;
      }

      if (provider === "opencode") {
        const sessions =
          (await this.opencodeScanner?.getSessionsForProject(project.path)) ??
          [];
        const match = sessions.find(
          (session) => session.id === target.sessionId,
        );
        if (match) {
          return {
            filePath: match.filePath,
            provider,
            sessionMtime: match.mtime,
          };
        }
      }
    }

    return null;
  }

  private getProviderCandidates(
    providerHint: string | undefined,
    projectProvider: string | undefined,
  ): WatchProvider[] {
    const candidates: WatchProvider[] = [];
    const pushCandidate = (candidate: WatchProvider | null) => {
      if (!candidate || candidates.includes(candidate)) return;
      candidates.push(candidate);
    };

    pushCandidate(this.normalizeProvider(providerHint));
    pushCandidate(this.normalizeProvider(projectProvider));
    pushCandidate("claude");
    pushCandidate("codex");
    pushCandidate("gemini");
    pushCandidate("opencode");
    return candidates;
  }

  private normalizeProvider(
    provider: string | undefined,
  ): WatchProvider | null {
    return normalizeProviderGroup(provider);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private teardownRuntime(target: SessionWatchTarget): void {
    if (target.watcher) {
      target.watcher.close();
      target.watcher = null;
    }
    if (target.pollTimer) {
      clearInterval(target.pollTimer);
      target.pollTimer = null;
    }
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }
  }

  private teardownTarget(target: SessionWatchTarget): void {
    this.teardownRuntime(target);
    this.clearResolveRetry(target);
  }
}
