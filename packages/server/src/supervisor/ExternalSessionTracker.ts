import { stat } from "node:fs/promises";
import * as path from "node:path";
import {
  type ContextCompactEvent,
  type ContextCumulativeUsage,
  type DirProjectId,
  type UrlProjectId,
  asDirProjectId,
} from "@yep-anywhere/shared";
import { getCodexSubagentMetadata } from "../codex/subagent.js";
import { decodeProjectId, encodeProjectId } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { readFirstLine } from "../utils/jsonl.js";
import { BatchProcessor } from "../watcher/BatchProcessor.js";
import type {
  BusEvent,
  EventBus,
  FileChangeEvent,
  SessionAbortedEvent,
  SessionCreatedEvent,
  SessionStatusEvent,
  SessionUpdatedEvent,
} from "../watcher/EventBus.js";
import type { Supervisor } from "./Supervisor.js";
import {
  type ExternalProcessProbe,
  hasActiveExternalProviderProcess,
} from "./externalProcessProbe.js";
import type {
  ContextUsage,
  Project,
  SessionOwnership,
  SessionSummary,
} from "./types.js";

interface ExternalSessionInfo {
  detectedAt: Date;
  lastActivity: Date;
  /** Directory-format projectId (from file path, NOT base64url) */
  dirProjectId?: DirProjectId;
  /** URL-format projectId (base64url) */
  projectId?: UrlProjectId;
  /** Session provider */
  provider: FileChangeEvent["provider"];
  timeoutId: ReturnType<typeof setTimeout>;
  validationTimeoutId: ReturnType<typeof setTimeout> | null;
}

interface CodexFileSessionMeta {
  cwd: string;
  timestamp: string;
  model?: string;
  isSubagent: boolean;
}

/** Default grace period after abort before external detection resumes (30 seconds) */
const DEFAULT_ABORT_GRACE_MS = 30000;
const MISSING_PROJECT_WARNING_INTERVAL_MS = 60_000;

export interface ExternalSessionTrackerOptions {
  eventBus: EventBus;
  supervisor: Supervisor;
  scanner: ProjectScanner;
  /** Time in ms before external status decays to idle (default: 30000) */
  decayMs?: number;
  /** Grace period in ms after abort before external detection resumes (default: 30000) */
  abortGraceMs?: number;
  /** How often to re-check that an external provider process is still alive (default: 3000) */
  processValidationMs?: number;
  /** Optional process probe override for tests/platform-specific integrations */
  externalProcessProbe?: ExternalProcessProbe;
  /** Optional callback to get session summary for new external sessions */
  getSessionSummary?: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<SessionSummary | null>;
  /** Resolve ownership held by a standalone agent runtime. */
  getRuntimeProcess?: (
    sessionId: string,
  ) => Promise<{ projectId: UrlProjectId } | null>;
}

/**
 * Tracks sessions that are actively controlled by external programs (not owned by this app).
 *
 * Uses file change events to detect when a session file is modified, then checks
 * if we own that session via Supervisor. If not owned, best-effort process
 * probing decides whether an external provider process is still alive for the
 * project. If probing is unavailable, it falls back to the historical
 * recent-file-activity window.
 */
export class ExternalSessionTracker {
  private externalSessions: Map<string, ExternalSessionInfo> = new Map();
  /** Sessions recently aborted by this server - grace period before external detection */
  private recentlyAborted: Map<string, number> = new Map(); // sessionId -> timestamp
  private eventBus: EventBus;
  private supervisor: Supervisor;
  private scanner: ProjectScanner;
  private decayMs: number;
  private abortGraceMs: number;
  private processValidationMs: number;
  private externalProcessProbe: ExternalProcessProbe;
  private unsubscribe: (() => void) | null = null;
  private getSessionSummary?: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<SessionSummary | null>;
  private getRuntimeProcess?: ExternalSessionTrackerOptions["getRuntimeProcess"];
  private runtimeOwnedSessions = new Set<string>();
  /** Batches session parsing to prevent OOM from concurrent file reads */
  private sessionParser: BatchProcessor<SessionSummary | null>;
  /** Tracks sessions that have already emitted session-created */
  private createdSessions: Set<string> = new Set();
  /** Cache of last known session state for change detection */
  private sessionStateCache: Map<
    string,
    {
      title: string | null;
      messageCount: number;
      projectId: UrlProjectId;
      contextUsage?: ContextUsage;
      cumulativeUsage?: ContextCumulativeUsage;
      compactCount?: number;
      compactEvents?: ContextCompactEvent[];
      model?: string;
      reasoningEffort?: string;
      serviceTier?: string;
    }
  > = new Map();
  private missingProjectWarningTimestamps: Map<string, number> = new Map();

  constructor(options: ExternalSessionTrackerOptions) {
    this.eventBus = options.eventBus;
    this.supervisor = options.supervisor;
    this.scanner = options.scanner;
    this.decayMs = options.decayMs ?? 30000;
    this.abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    this.processValidationMs = options.processValidationMs ?? 3000;
    this.externalProcessProbe =
      options.externalProcessProbe ?? hasActiveExternalProviderProcess;
    this.getSessionSummary = options.getSessionSummary;
    this.getRuntimeProcess = options.getRuntimeProcess;

    // Initialize batch processor for session parsing
    // Limits concurrent JSONL parsing to prevent OOM during bulk file operations
    this.sessionParser = new BatchProcessor<SessionSummary | null>({
      concurrency: 5,
      batchMs: 300,
      onResult: (sessionId, summary) => {
        if (!summary) return;

        const projectId = summary.projectId as UrlProjectId;
        const now = new Date().toISOString();

        // Check if supervisor owns this session
        const isOwned =
          !!this.supervisor.getProcessForSession(sessionId) ||
          this.runtimeOwnedSessions.has(sessionId);
        const isExternal = this.externalSessions.has(sessionId);

        // Clean up external tracking if owned
        if (isOwned) {
          this.removeExternal(sessionId);
        }

        // For owned sessions, we only emit session-updated (supervisor handles session-created).
        // For unowned sessions discovered from files, emit session-created the first time,
        // but only mark ownership external when the active external tracker still has it.
        if (!this.createdSessions.has(sessionId)) {
          if (isOwned) {
            // Owned session - supervisor already emitted session-created with title: null
            // Cache state and emit session-updated if title is now available
            this.sessionStateCache.set(sessionId, {
              title: summary.title,
              messageCount: summary.messageCount,
              projectId,
              contextUsage: summary.contextUsage,
              cumulativeUsage: summary.cumulativeUsage,
              compactCount: summary.compactCount,
              compactEvents: summary.compactEvents,
              model: summary.model,
              reasoningEffort: summary.reasoningEffort,
              serviceTier: summary.serviceTier,
            });
            this.createdSessions.add(sessionId);

            // Emit session-updated if title, messageCount, contextUsage, or model has real values
            // (supervisor emits session-created with title: null, messageCount: 0)
            if (
              summary.title ||
              summary.messageCount > 0 ||
              summary.contextUsage ||
              summary.model
            ) {
              const event: SessionUpdatedEvent = {
                type: "session-updated",
                sessionId,
                projectId,
                title: summary.title,
                messageCount: summary.messageCount,
                updatedAt: summary.updatedAt,
                contextUsage: summary.contextUsage,
                cumulativeUsage: summary.cumulativeUsage,
                compactCount: summary.compactCount,
                compactEvents: summary.compactEvents,
                model: summary.model,
                reasoningEffort: summary.reasoningEffort,
                serviceTier: summary.serviceTier,
                timestamp: now,
              };
              this.eventBus.emit(event);
            }
          } else {
            // New unowned session - emit session-created. This may be a still-active
            // external terminal session, or just a session file created by a process
            // that has already exited.
            summary.ownership = isExternal
              ? { owner: "external" }
              : { owner: "none" };

            const event: SessionCreatedEvent = {
              type: "session-created",
              session: summary,
              timestamp: now,
            };
            this.eventBus.emit(event);
            this.createdSessions.add(sessionId);

            // Cache initial state for future change detection
            this.sessionStateCache.set(sessionId, {
              title: summary.title,
              messageCount: summary.messageCount,
              projectId,
              contextUsage: summary.contextUsage,
              cumulativeUsage: summary.cumulativeUsage,
              compactCount: summary.compactCount,
              compactEvents: summary.compactEvents,
              model: summary.model,
              reasoningEffort: summary.reasoningEffort,
              serviceTier: summary.serviceTier,
            });
          }
        } else {
          // Existing session - check for changes and emit session-updated
          const cached = this.sessionStateCache.get(sessionId);
          const titleChanged = cached?.title !== summary.title;
          const messageCountChanged =
            cached?.messageCount !== summary.messageCount;
          // Compare context usage by input tokens (percentage can be derived)
          const contextUsageChanged =
            cached?.contextUsage?.inputTokens !==
            summary.contextUsage?.inputTokens;
          const cumulativeUsageChanged =
            cached?.cumulativeUsage?.totalTokens !==
              summary.cumulativeUsage?.totalTokens ||
            cached?.cumulativeUsage?.inputTokens !==
              summary.cumulativeUsage?.inputTokens ||
            cached?.cumulativeUsage?.outputTokens !==
              summary.cumulativeUsage?.outputTokens ||
            cached?.cumulativeUsage?.cacheReadTokens !==
              summary.cumulativeUsage?.cacheReadTokens ||
            cached?.cumulativeUsage?.cacheCreationTokens !==
              summary.cumulativeUsage?.cacheCreationTokens;
          const compactCountChanged =
            cached?.compactCount !== summary.compactCount;
          const compactEventsChanged =
            JSON.stringify(cached?.compactEvents ?? []) !==
            JSON.stringify(summary.compactEvents ?? []);
          const modelChanged = cached?.model !== summary.model;
          const reasoningEffortChanged =
            cached?.reasoningEffort !== summary.reasoningEffort;
          const serviceTierChanged =
            cached?.serviceTier !== summary.serviceTier;

          if (
            titleChanged ||
            messageCountChanged ||
            contextUsageChanged ||
            cumulativeUsageChanged ||
            compactCountChanged ||
            compactEventsChanged ||
            modelChanged ||
            reasoningEffortChanged ||
            serviceTierChanged
          ) {
            const event: SessionUpdatedEvent = {
              type: "session-updated",
              sessionId,
              projectId,
              title: summary.title,
              messageCount: summary.messageCount,
              updatedAt: summary.updatedAt,
              contextUsage: summary.contextUsage,
              cumulativeUsage: summary.cumulativeUsage,
              compactCount: summary.compactCount,
              compactEvents: summary.compactEvents,
              model: summary.model,
              reasoningEffort: summary.reasoningEffort,
              serviceTier: summary.serviceTier,
              timestamp: now,
            };
            this.eventBus.emit(event);

            // Update cache
            this.sessionStateCache.set(sessionId, {
              title: summary.title,
              messageCount: summary.messageCount,
              projectId,
              contextUsage: summary.contextUsage,
              cumulativeUsage: summary.cumulativeUsage,
              compactCount: summary.compactCount,
              compactEvents: summary.compactEvents,
              model: summary.model,
              reasoningEffort: summary.reasoningEffort,
              serviceTier: summary.serviceTier,
            });
          }
        }
      },
      onError: (sessionId, error) => {
        // Log but don't fail - session may not be readable yet
        console.warn(
          `[ExternalSessionTracker] Failed to read session ${sessionId}:`,
          error.message,
        );
      },
    });

    // Subscribe to bus events
    this.unsubscribe = options.eventBus.subscribe((event: BusEvent) => {
      if (event.type === "file-change") {
        void this.handleFileChange(event);
      } else if (event.type === "session-aborted") {
        this.handleSessionAborted(event);
      }
    });
  }

  private handleSessionAborted(event: SessionAbortedEvent): void {
    this.markAborted(event.sessionId);
  }

  /**
   * Check if a session is currently marked as external.
   */
  isExternal(sessionId: string): boolean {
    return this.externalSessions.has(sessionId);
  }

  /**
   * Get info about an external session, or null if not external.
   * Returns the directory-format projectId (for internal use only).
   */
  getExternalSessionInfo(
    sessionId: string,
  ): { lastActivity: Date; dirProjectId: DirProjectId } | null {
    const info = this.externalSessions.get(sessionId);
    if (!info) return null;
    if (!info.dirProjectId) return null;
    return { lastActivity: info.lastActivity, dirProjectId: info.dirProjectId };
  }

  /**
   * Get info about an external session with URL-format projectId.
   * Use this for API responses and events.
   */
  async getExternalSessionInfoWithUrlId(
    sessionId: string,
  ): Promise<{ lastActivity: Date; projectId: UrlProjectId } | null> {
    const info = this.externalSessions.get(sessionId);
    if (!info) return null;

    if (info.projectId) {
      return {
        lastActivity: info.lastActivity,
        projectId: info.projectId,
      };
    }

    if (!info.dirProjectId) return null;

    const project = await this.scanner.getProjectBySessionDirSuffix(
      info.dirProjectId,
    );
    if (!project) return null;

    return {
      lastActivity: info.lastActivity,
      projectId: project.id as UrlProjectId,
    };
  }

  /**
   * Mark a session as recently aborted. During the grace period, file changes
   * won't trigger external session detection (they're from our own cleanup).
   * Called by Supervisor when a process is aborted.
   */
  markAborted(sessionId: string): void {
    this.recentlyAborted.set(sessionId, Date.now());
    // Also remove from external tracking if present (abort takes precedence)
    this.removeExternal(sessionId);
  }

  /**
   * Check if a session is within the abort grace period.
   */
  private isInAbortGracePeriod(sessionId: string): boolean {
    const abortedAt = this.recentlyAborted.get(sessionId);
    if (!abortedAt) return false;

    const elapsed = Date.now() - abortedAt;
    if (elapsed >= this.abortGraceMs) {
      // Grace period expired - clean up
      this.recentlyAborted.delete(sessionId);
      return false;
    }
    return true;
  }

  /**
   * Get all currently external session IDs.
   */
  getExternalSessions(): string[] {
    return Array.from(this.externalSessions.keys());
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Clear batch processor
    this.sessionParser.dispose();

    // Clear all timeouts
    for (const info of this.externalSessions.values()) {
      clearTimeout(info.timeoutId);
      if (info.validationTimeoutId) {
        clearTimeout(info.validationTimeoutId);
      }
    }
    this.externalSessions.clear();
    this.recentlyAborted.clear();
    this.runtimeOwnedSessions.clear();
    this.missingProjectWarningTimestamps.clear();
  }

  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    // Only care about session files
    if (event.fileType !== "session" && event.fileType !== "agent-session") {
      return;
    }

    if (event.provider === "codex") {
      await this.handleCodexFileChange(event);
      return;
    }

    // Parse sessionId and projectId from path
    // Format: projects/<projectId>/<sessionId>.jsonl
    const parsed = this.parseSessionPath(event.relativePath);
    if (!parsed) return;

    const { sessionId, dirProjectId } = parsed;

    // Check if we own this session
    const process = this.supervisor.getProcessForSession(sessionId);
    const runtimeProcess = process
      ? null
      : await this.getRuntimeProcess?.(sessionId);
    if (runtimeProcess) this.runtimeOwnedSessions.add(sessionId);
    else this.runtimeOwnedSessions.delete(sessionId);
    if (process || runtimeProcess) {
      // We own it - remove from external tracking if present
      this.removeExternal(sessionId);
      // Still parse to detect title/messageCount changes for owned sessions
      if (this.getSessionSummary) {
        const getSessionSummary = this.getSessionSummary;
        const projectId = process?.projectId ?? runtimeProcess?.projectId;
        if (!projectId) return;
        this.sessionParser.enqueue(sessionId, async () => {
          return getSessionSummary(sessionId, projectId);
        });
      }
      return;
    }

    // Check if this session was recently aborted by us - ignore file changes
    // during grace period (they're from our own process cleanup, not external)
    if (this.isInAbortGracePeriod(sessionId)) {
      return;
    }

    // We don't own it and it's not in grace period - decide whether it is
    // still actively controlled by an external provider process.
    await this.handleUnownedSessionActivity(sessionId, {
      provider: event.provider,
      dirProjectId,
    });
  }

  private parseSessionPath(
    relativePath: string,
  ): { sessionId: string; dirProjectId: DirProjectId } | null {
    // Expected formats:
    // - projects/<projectId>/<sessionId>.jsonl
    // - projects/<hostname>/<projectId>/<sessionId>.jsonl
    // - <projectId>/<sessionId>.jsonl (when watchDir is already ~/.claude/projects)
    // - <hostname>/<projectId>/<sessionId>.jsonl (same case with hostname)
    const parts = relativePath.split(/[\\/]+/).filter(Boolean);
    if (parts.length < 2) return null;

    const startIdx = parts[0] === "projects" ? 1 : 0;
    if (parts.length - startIdx < 2) return null;

    // Find the .jsonl file
    const filename = parts[parts.length - 1];
    if (!filename || !filename.endsWith(".jsonl")) return null;

    // Extract sessionId (filename without .jsonl)
    const sessionId = filename.slice(0, -6); // Remove '.jsonl'

    // Skip agent sessions (they start with 'agent-')
    if (sessionId.startsWith("agent-")) return null;

    const projectAndNestedParts = parts.slice(startIdx, -1);
    if (projectAndNestedParts.length === 0) return null;

    const projectPartCount =
      projectAndNestedParts.length >= 2 &&
      this.isClaudeProjectDirName(projectAndNestedParts[1])
        ? 2
        : 1;
    const nestedParts = projectAndNestedParts.slice(projectPartCount);

    // Ignore nested files such as subagents/workflows/*.jsonl. They are not
    // top-level user-visible sessions and should not trigger external
    // ownership state.
    if (nestedParts.length > 0) return null;

    const dirProjectId = asDirProjectId(
      projectAndNestedParts.slice(0, projectPartCount).join("/"),
    );

    return { sessionId, dirProjectId };
  }

  private isClaudeProjectDirName(value: string | undefined): boolean {
    return Boolean(
      value && (value.startsWith("-") || /^[a-zA-Z]--/.test(value)),
    );
  }

  private async handleCodexFileChange(event: FileChangeEvent): Promise<void> {
    const sessionId = this.extractCodexSessionId(event.relativePath);
    if (!sessionId) return;

    const meta = await this.readCodexSessionMeta(event.path);
    if (!meta) return;

    // Codex persists every collaboration worker as its own rollout file. Those
    // files are child threads of the visible CLI session, not new sessions.
    if (meta.isSubagent) {
      this.removeExternal(sessionId);
      this.runtimeOwnedSessions.delete(sessionId);
      this.createdSessions.delete(sessionId);
      this.sessionStateCache.delete(sessionId);
      return;
    }

    const process = this.supervisor.getProcessForSession(sessionId);
    const runtimeProcess = process
      ? null
      : await this.getRuntimeProcess?.(sessionId);
    if (runtimeProcess) this.runtimeOwnedSessions.add(sessionId);
    else this.runtimeOwnedSessions.delete(sessionId);
    if (process || runtimeProcess) {
      this.removeExternal(sessionId);
      // Still parse to detect title/messageCount changes for owned sessions
      if (this.getSessionSummary) {
        const getSessionSummary = this.getSessionSummary;
        const projectId = process?.projectId ?? runtimeProcess?.projectId;
        if (!projectId) return;
        this.sessionParser.enqueue(sessionId, async () => {
          return getSessionSummary(sessionId, projectId);
        });
      }
      return;
    }

    if (this.isInAbortGracePeriod(sessionId)) {
      return;
    }

    const projectId = encodeProjectId(meta.cwd);

    await this.handleUnownedSessionActivity(sessionId, {
      provider: event.provider,
      projectId,
    });
    await this.ensureCodexSessionCreated(
      sessionId,
      event.path,
      projectId,
      meta,
    );
  }

  private extractCodexSessionId(relativePath: string): string | null {
    const filename = relativePath.split(path.sep).pop();
    if (!filename || !filename.endsWith(".jsonl")) return null;
    const base = filename.slice(0, -6);
    const match = base.match(/([0-9a-fA-F-]{36})$/);
    return match?.[1] ?? null;
  }

  private async readCodexSessionMeta(
    filePath: string,
  ): Promise<CodexFileSessionMeta | null> {
    try {
      const firstLine = await readFirstLine(filePath);
      if (!firstLine) return null;

      const parsed = JSON.parse(firstLine) as {
        type?: string;
        payload?: Record<string, unknown>;
      };
      if (
        parsed.type !== "session_meta" ||
        typeof parsed.payload?.cwd !== "string" ||
        typeof parsed.payload.timestamp !== "string"
      ) {
        return null;
      }

      const model = parsed.payload.model;

      return {
        cwd: parsed.payload.cwd,
        timestamp: parsed.payload.timestamp,
        model: typeof model === "string" ? model : undefined,
        isSubagent: getCodexSubagentMetadata(parsed.payload).isSubagent,
      };
    } catch {
      return null;
    }
  }

  private async ensureCodexSessionCreated(
    sessionId: string,
    filePath: string,
    projectId: UrlProjectId,
    meta: CodexFileSessionMeta,
  ): Promise<void> {
    if (this.createdSessions.has(sessionId)) return;

    try {
      const stats = await stat(filePath);
      const summary: SessionSummary = {
        id: sessionId,
        projectId,
        title: null,
        fullTitle: null,
        createdAt: meta.timestamp,
        updatedAt: stats.mtime.toISOString(),
        messageCount: 0,
        ownership: this.externalSessions.has(sessionId)
          ? { owner: "external" }
          : { owner: "none" },
        provider: "codex",
        model: meta.model,
      };

      const event: SessionCreatedEvent = {
        type: "session-created",
        session: summary,
        timestamp: new Date().toISOString(),
      };
      this.eventBus.emit(event);
      this.createdSessions.add(sessionId);
    } catch {
      // Ignore failures until next file change
    }
  }

  private async handleUnownedSessionActivity(
    sessionId: string,
    info: {
      provider: FileChangeEvent["provider"];
      dirProjectId?: DirProjectId;
      projectId?: UrlProjectId;
    },
  ): Promise<void> {
    const activeExternalProcess = await this.checkExternalProcessForInfo(info);

    if (activeExternalProcess === false) {
      this.removeExternal(sessionId);
      this.enqueueSessionParse(sessionId, info);
      return;
    }

    // If probing is unavailable (null), keep the previous behavior and treat
    // recent external file activity as active until the decay timeout expires.
    this.markExternal(sessionId, info);
  }

  private enqueueSessionParse(
    sessionId: string,
    info: {
      provider: FileChangeEvent["provider"];
      dirProjectId?: DirProjectId;
      projectId?: UrlProjectId;
    },
  ): void {
    if (!this.getSessionSummary) return;

    const getSessionSummary = this.getSessionSummary;
    this.sessionParser.enqueue(sessionId, async () => {
      const project = await this.resolveProjectForSession(info);
      if (!project) return null;
      return getSessionSummary(sessionId, project.id as UrlProjectId);
    });
  }

  private markExternal(
    sessionId: string,
    info: {
      provider: FileChangeEvent["provider"];
      dirProjectId?: DirProjectId;
      projectId?: UrlProjectId;
    },
  ): void {
    const now = new Date();
    const existing = this.externalSessions.get(sessionId);

    if (existing) {
      // Update last activity and reset timer
      clearTimeout(existing.timeoutId);
      if (existing.validationTimeoutId) {
        clearTimeout(existing.validationTimeoutId);
      }
      existing.lastActivity = now;
      existing.timeoutId = this.createDecayTimeout(sessionId);
      existing.validationTimeoutId =
        this.createProcessValidationTimeout(sessionId);
      // Always parse to detect changes (title, messageCount)
      this.enqueueSessionParse(sessionId, info);
    } else {
      // New external session
      const externalInfo: ExternalSessionInfo = {
        detectedAt: now,
        lastActivity: now,
        dirProjectId: info.dirProjectId,
        projectId: info.projectId,
        provider: info.provider,
        timeoutId: this.createDecayTimeout(sessionId),
        validationTimeoutId: null,
      };
      externalInfo.validationTimeoutId =
        this.createProcessValidationTimeout(sessionId);
      this.externalSessions.set(sessionId, externalInfo);

      // Queue session parsing - batched to prevent OOM from bulk file operations
      this.enqueueSessionParse(sessionId, externalInfo);

      // Emit ownership change event
      void this.emitOwnershipChangeByInfo(sessionId, externalInfo, {
        owner: "external",
      });
    }
  }

  private removeExternal(sessionId: string): void {
    const existing = this.externalSessions.get(sessionId);
    if (existing) {
      clearTimeout(existing.timeoutId);
      if (existing.validationTimeoutId) {
        clearTimeout(existing.validationTimeoutId);
      }
      this.externalSessions.delete(sessionId);

      // Emit ownership change event
      void this.emitOwnershipChangeByInfo(sessionId, existing, {
        owner: "none",
      });
    }
  }

  private createDecayTimeout(sessionId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.handleDecayTimeout(sessionId);
    }, this.decayMs);
  }

  private async handleDecayTimeout(sessionId: string): Promise<void> {
    const info = this.externalSessions.get(sessionId);
    if (!info) return;

    const activeExternalProcess = await this.checkExternalProcessForInfo(info);
    if (activeExternalProcess === true) {
      info.timeoutId = this.createDecayTimeout(sessionId);
      return;
    }

    this.removeExternal(sessionId);
  }

  private createProcessValidationTimeout(
    sessionId: string,
  ): ReturnType<typeof setTimeout> | null {
    if (this.processValidationMs <= 0) return null;

    return setTimeout(() => {
      void this.validateExternalProcess(sessionId);
    }, this.processValidationMs);
  }

  private async validateExternalProcess(sessionId: string): Promise<void> {
    const info = this.externalSessions.get(sessionId);
    if (!info) return;

    const activeExternalProcess = await this.checkExternalProcessForInfo(info);
    if (activeExternalProcess === false) {
      this.removeExternal(sessionId);
      return;
    }

    if (
      activeExternalProcess === true &&
      this.externalSessions.has(sessionId)
    ) {
      info.validationTimeoutId = this.createProcessValidationTimeout(sessionId);
    }
  }

  private async checkExternalProcessForInfo(info: {
    provider: FileChangeEvent["provider"];
    dirProjectId?: DirProjectId;
    projectId?: UrlProjectId;
  }): Promise<boolean | null> {
    const project = await this.resolveProjectForSession(info);
    if (!project?.path) return null;

    const excludePids = this.supervisor
      .getAllProcesses()
      .map((process) => process.pid)
      .filter((pid): pid is number => typeof pid === "number");

    return this.externalProcessProbe({
      provider: info.provider,
      projectPath: project.path,
      excludePids,
    });
  }

  private async emitOwnershipChangeByInfo(
    sessionId: string,
    info: ExternalSessionInfo,
    ownership: SessionOwnership,
  ): Promise<void> {
    if (info.projectId) {
      const event: SessionStatusEvent = {
        type: "session-status-changed",
        sessionId,
        projectId: info.projectId,
        ownership,
        timestamp: new Date().toISOString(),
      };
      this.eventBus.emit(event);
      return;
    }

    if (!info.dirProjectId) return;

    // Convert directory format to URL format for events
    const project = await this.scanner.getProjectBySessionDirSuffix(
      info.dirProjectId,
    );
    if (!project) {
      this.warnMissingProject(
        "Cannot emit ownership change",
        info.dirProjectId,
      );
      return;
    }

    const event: SessionStatusEvent = {
      type: "session-status-changed",
      sessionId,
      projectId: project.id,
      ownership,
      timestamp: new Date().toISOString(),
    };

    // Emit through EventBus so it gets broadcast via SSE
    this.eventBus.emit(event);
  }

  private async resolveProjectForSession(info: {
    provider: FileChangeEvent["provider"];
    dirProjectId?: DirProjectId;
    projectId?: UrlProjectId;
  }): Promise<Pick<Project, "id" | "path"> | null> {
    if (info.projectId) {
      const project = await this.scanner.getProject(info.projectId);
      if (project) {
        return { id: project.id as UrlProjectId, path: project.path };
      }
      try {
        return {
          id: info.projectId,
          path: decodeProjectId(info.projectId),
        };
      } catch {
        return null;
      }
    }
    if (!info.dirProjectId) return null;
    const project = await this.scanner.getProjectBySessionDirSuffix(
      info.dirProjectId,
    );
    if (!project) {
      this.warnMissingProject("Cannot emit session-created", info.dirProjectId);
      return null;
    }
    return { id: project.id as UrlProjectId, path: project.path };
  }

  private warnMissingProject(reason: string, dirProjectId: DirProjectId): void {
    const key = `${reason}:${dirProjectId}`;
    const now = Date.now();
    const lastWarnedAt = this.missingProjectWarningTimestamps.get(key) ?? 0;
    if (now - lastWarnedAt < MISSING_PROJECT_WARNING_INTERVAL_MS) return;

    this.missingProjectWarningTimestamps.set(key, now);
    console.warn(
      `[ExternalSessionTracker] ${reason} - project not found: ${dirProjectId}`,
    );
  }
}
