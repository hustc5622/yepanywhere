import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "../logging/logger.js";
import type {
  EventBus,
  FileChangeEvent,
  FileChangeType,
  WatchProvider,
} from "./EventBus.js";

export interface FileWatcherOptions {
  /** Directory to watch (e.g., ~/.claude) */
  watchDir: string;
  /** Provider that owns this directory */
  provider: WatchProvider;
  /** EventBus to emit events to */
  eventBus: EventBus;
  /** Debounce delay in ms (default: 200) */
  debounceMs?: number;
  /**
   * Optional periodic full-tree rescan interval (ms).
   * Useful on platforms where fs.watch may miss deep file writes.
   */
  periodicRescanMs?: number;
}

export class FileWatcher {
  private watchDir: string;
  private provider: WatchProvider;
  private eventBus: EventBus;
  private debounceMs: number;
  private periodicRescanMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private rescanTimer: NodeJS.Timeout | null = null;
  private rescanInProgress = false;
  private periodicRescanTimer: NodeJS.Timeout | null = null;
  private knownFiles: Set<string> = new Set();
  private knownFileMtimes: Map<string, number> = new Map();

  constructor(options: FileWatcherOptions) {
    this.watchDir = options.watchDir;
    this.provider = options.provider;
    this.eventBus = options.eventBus;
    this.debounceMs = options.debounceMs ?? 200;
    this.periodicRescanMs = options.periodicRescanMs ?? 0;
  }

  /**
   * Start watching for file changes.
   */
  start(): void {
    if (this.watcher) {
      return; // Already watching
    }

    // Build initial file list for detecting create vs modify
    this.scanExistingFiles();

    try {
      this.watcher = fs.watch(
        this.watchDir,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) {
            getLogger().debug(
              `[FileWatcher] Raw event provider=${this.provider} type=${eventType} file=<null> path=${this.watchDir}`,
            );
            this.scheduleRescan();
            return;
          }
          this.handleFileEvent(eventType, filename);
        },
      );

      this.watcher.on("error", (error) => {
        console.error("[FileWatcher] Error:", error);
      });

      getLogger().info(`[FileWatcher] Watching ${this.watchDir}`);

      if (this.periodicRescanMs > 0) {
        this.periodicRescanTimer = setInterval(() => {
          this.rescanAndEmit();
        }, this.periodicRescanMs);
        getLogger().info(
          `[FileWatcher] Periodic rescan enabled (${this.periodicRescanMs}ms) for ${this.watchDir}`,
        );
      }
    } catch (error) {
      console.error("[FileWatcher] Failed to start:", error);
    }
  }

  /**
   * Stop watching for file changes.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    if (this.periodicRescanTimer) {
      clearInterval(this.periodicRescanTimer);
      this.periodicRescanTimer = null;
    }
    this.knownFiles.clear();
    this.knownFileMtimes.clear();

    getLogger().info("[FileWatcher] Stopped");
  }

  /**
   * Check if watcher is active.
   */
  get isWatching(): boolean {
    return this.watcher !== null;
  }

  private scanExistingFiles(): void {
    this.knownFiles.clear();
    this.knownFileMtimes.clear();
    this.scanDir(this.watchDir, this.knownFileMtimes);
    this.knownFiles = new Set(this.knownFileMtimes.keys());
  }

  private scanDir(dir: string, index: Map<string, number>): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.scanDir(fullPath, index);
        } else {
          try {
            const stats = fs.statSync(fullPath);
            index.set(fullPath, stats.mtimeMs);
          } catch {
            // File may have disappeared between readdir/stat
          }
        }
      }
    } catch {
      // Ignore errors (e.g., permission denied)
    }
  }

  private handleFileEvent(eventType: string, filename: string): void {
    const fullPath = path.join(this.watchDir, filename);

    getLogger().debug(
      `[FileWatcher] Raw event provider=${this.provider} type=${eventType} file=${filename} path=${fullPath}`,
    );

    // Debounce per-file
    const existingTimer = this.debounceTimers.get(fullPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(fullPath);
      this.emitEvent(fullPath, eventType);
    }, this.debounceMs);

    this.debounceTimers.set(fullPath, timer);
  }

  private emitEvent(fullPath: string, _eventType: string): void {
    // Determine change type
    let changeType: FileChangeType;
    const fileExists = fs.existsSync(fullPath);

    if (!fileExists) {
      if (this.knownFiles.has(fullPath)) {
        changeType = "delete";
        this.knownFiles.delete(fullPath);
        this.knownFileMtimes.delete(fullPath);
      } else {
        // File never existed from our POV, skip
        return;
      }
    } else {
      let mtimeMs = Date.now();
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {
        // File disappeared between existsSync and statSync
        return;
      }

      if (this.knownFiles.has(fullPath)) {
        const previousMtime = this.knownFileMtimes.get(fullPath);
        if (previousMtime === mtimeMs) {
          // No meaningful change; skip duplicate callback.
          return;
        }
        changeType = "modify";
      } else {
        changeType = "create";
        this.knownFiles.add(fullPath);
      }
      this.knownFileMtimes.set(fullPath, mtimeMs);
    }

    const relativePath = path.relative(this.watchDir, fullPath);

    const event: FileChangeEvent = {
      type: "file-change",
      provider: this.provider,
      path: fullPath,
      relativePath,
      changeType,
      timestamp: new Date().toISOString(),
      fileType: this.parseFileType(relativePath),
    };

    getLogger().debug(
      `[FileWatcher] Emitting file-change provider=${event.provider} changeType=${event.changeType} fileType=${event.fileType} relativePath=${event.relativePath}`,
    );

    this.eventBus.emit(event);
  }

  /**
   * When fs.watch provides no filename (common on macOS under load),
   * rescan the tree and synthesize events from mtime/delete deltas.
   */
  private scheduleRescan(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
    }

    getLogger().debug(
      `[FileWatcher] Scheduling fallback rescan provider=${this.provider}`,
    );

    this.rescanTimer = setTimeout(
      () => {
        this.rescanTimer = null;
        this.rescanAndEmit();
      },
      Math.max(this.debounceMs * 2, 400),
    );
  }

  private rescanAndEmit(): void {
    if (this.rescanInProgress) {
      return;
    }
    this.rescanInProgress = true;

    try {
      getLogger().debug(
        `[FileWatcher] Running fallback rescan provider=${this.provider}`,
      );
      const current = new Map<string, number>();
      this.scanDir(this.watchDir, current);

      // Create/modify events
      for (const [fullPath, mtimeMs] of current.entries()) {
        const prevMtime = this.knownFileMtimes.get(fullPath);
        if (prevMtime === undefined || prevMtime !== mtimeMs) {
          this.emitEvent(fullPath, "change");
        }
      }

      // Delete events
      for (const fullPath of this.knownFileMtimes.keys()) {
        if (!current.has(fullPath)) {
          this.emitEvent(fullPath, "rename");
        }
      }

      this.knownFileMtimes = current;
      this.knownFiles = new Set(current.keys());
    } finally {
      this.rescanInProgress = false;
    }
  }

  private parseFileType(relativePath: string): FileChangeEvent["fileType"] {
    switch (this.provider) {
      case "claude":
        return this.parseClaudeFileType(relativePath);
      case "gemini":
        return this.parseGeminiFileType(relativePath);
      case "codex":
        return this.parseCodexFileType(relativePath);
      case "opencode":
        return this.parseOpenCodeFileType(relativePath);
      case "kimi":
        return this.parseKimiFileType(relativePath);
    }
  }

  private parseKimiFileType(relativePath: string): FileChangeEvent["fileType"] {
    // Watching ~/.kimi-code/sessions - session logs are
    // {workspace}/session_{uuid}/agents/{agentId}/wire.jsonl
    if (relativePath.endsWith("wire.jsonl")) {
      return "session";
    }
    return "other";
  }

  private parseClaudeFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.claude/projects - relativePath is {hash}/{session}.jsonl
    if (relativePath.endsWith(".jsonl")) {
      if (path.basename(relativePath).startsWith("agent-")) {
        return "agent-session";
      }
      return "session";
    }
    return "other";
  }

  private parseGeminiFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.gemini/tmp - relativePath is {hash}/chats/session-*.json
    // On Windows, path.relative() returns backslashes
    if (
      (relativePath.includes("/chats/") ||
        relativePath.includes("\\chats\\")) &&
      relativePath.endsWith(".json")
    ) {
      return "session";
    }
    return "other";
  }

  private parseCodexFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.codex/sessions - relativePath is {year}/{month}/{day}/rollout-*.jsonl
    if (relativePath.endsWith(".jsonl")) {
      return "session";
    }
    return "other";
  }

  private parseOpenCodeFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    const baseName = path.basename(relativePath);
    if (
      baseName === "opencode.db" ||
      baseName === "opencode.db-wal" ||
      baseName === "opencode.db-shm"
    ) {
      return "session";
    }
    return "other";
  }
}
