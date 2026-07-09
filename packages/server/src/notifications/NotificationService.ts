/**
 * NotificationService manages session notification state (last seen timestamps).
 * This enables "unread" badge tracking across all devices/tabs.
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RecentEntry } from "../recents/index.js";
import type { EventBus, SessionSeenEvent } from "../watcher/EventBus.js";

export type { SessionSeenEvent };

export interface LastSeenEntry {
  /** ISO timestamp of when session was last viewed */
  timestamp: string;
  /** Optional: last message ID that was seen */
  messageId?: string;
}

export interface SessionNeedsReviewEntry {
  /** Why the session should be counted in app badges */
  reason: "session-halted";
  /** ISO timestamp of when the review-worthy event happened */
  timestamp: string;
}

export interface NotificationState {
  /** Map of sessionId -> last seen info */
  lastSeen: Record<string, LastSeenEntry>;
  /** Sessions that produced a notification and should stay badged until viewed */
  needsReview: Record<string, SessionNeedsReviewEntry>;
  /** Schema version for future migrations */
  version: number;
}

const CURRENT_VERSION = 2;

export interface NotificationServiceOptions {
  /** Directory to store notification state (defaults to ~/.yep-anywhere) */
  dataDir?: string;
  /** EventBus for emitting seen events */
  eventBus?: EventBus;
}

export class NotificationService {
  private state: NotificationState;
  private dataDir: string;
  private filePath: string;
  private eventBus?: EventBus;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: NotificationServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "notifications.json");
    this.eventBus = options.eventBus;
    this.state = {
      lastSeen: {},
      needsReview: {},
      version: CURRENT_VERSION,
    };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory and file if they don't exist.
   */
  async initialize(): Promise<void> {
    try {
      // Ensure data directory exists
      await fs.mkdir(this.dataDir, { recursive: true });

      // Try to load existing state
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as NotificationState;

      // Validate and migrate if needed
      if (parsed.version === CURRENT_VERSION) {
        this.state = {
          lastSeen: parsed.lastSeen ?? {},
          needsReview: parsed.needsReview ?? {},
          version: CURRENT_VERSION,
        };
      } else {
        // Future: handle migrations here
        this.state = {
          lastSeen: parsed.lastSeen ?? {},
          needsReview: parsed.needsReview ?? {},
          version: CURRENT_VERSION,
        };
        await this.save();
      }
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[NotificationService] Failed to load state, starting fresh:",
          error,
        );
      }
      this.state = {
        lastSeen: {},
        needsReview: {},
        version: CURRENT_VERSION,
      };
    }
  }

  /**
   * Mark a session as seen at the given timestamp.
   * @param sessionId The session ID
   * @param timestamp ISO timestamp (defaults to now)
   * @param messageId Optional message ID that was seen
   */
  async markSeen(
    sessionId: string,
    timestamp?: string,
    messageId?: string,
  ): Promise<void> {
    // Use the later of provided timestamp and current server time.
    // The client sends the session summary's updatedAt (latest visible
    // activity). Using max(provided, now) ensures that late non-visible writes
    // landing between process stop and user viewing don't flip the session back
    // to unread.
    const now = new Date().toISOString();
    const provided = timestamp ?? now;
    const ts = provided > now ? provided : now;

    await this.recordSeen(sessionId, ts, messageId, {
      clearNeedsReview: true,
      emitEvent: true,
    });
  }

  /**
   * Backfill read markers from the persisted recents list.
   *
   * A session visit means the user navigated to the session, so it is a valid
   * lower-bound read marker. Unlike markSeen(), this must preserve visitedAt
   * exactly instead of flooring to server "now"; otherwise every restart would
   * hide genuinely new content that arrived after the visit.
   */
  async importLastSeenFromRecents(visits: RecentEntry[]): Promise<number> {
    let changed = false;
    let imported = 0;

    for (const visit of visits) {
      const timestamp = visit.visitedAt;
      if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
        continue;
      }

      const updated = this.recordSeenInMemory(visit.sessionId, timestamp, {
        clearNeedsReview: false,
      });
      if (updated) {
        changed = true;
        imported += 1;
      }
    }

    if (changed) {
      await this.save();
    }

    return imported;
  }

  /**
   * Mark a session as needing review in app/browser badges.
   * This is intentionally narrower than hasUnread(): only sessions that have
   * produced a notification-worthy event are counted here.
   */
  async markSessionNeedsReview(
    sessionId: string,
    timestamp?: string,
  ): Promise<void> {
    const ts = timestamp ?? new Date().toISOString();
    const existing = this.state.needsReview[sessionId];
    if (existing && existing.timestamp >= ts) {
      return;
    }

    this.state.needsReview[sessionId] = {
      reason: "session-halted",
      timestamp: ts,
    };

    await this.save();
  }

  /**
   * Clear the badge-only review state for a session without changing lastSeen.
   */
  async clearSessionNeedsReview(sessionId: string): Promise<void> {
    if (!this.state.needsReview[sessionId]) {
      return;
    }

    delete this.state.needsReview[sessionId];
    await this.save();
  }

  /**
   * Get session IDs that should be counted in app/browser badges.
   */
  getSessionsNeedingReview(): string[] {
    return Object.keys(this.state.needsReview);
  }

  /**
   * Get the last seen entry for a session.
   */
  getLastSeen(sessionId: string): LastSeenEntry | undefined {
    return this.state.lastSeen[sessionId];
  }

  /**
   * Get all last seen entries.
   */
  getAllLastSeen(): Record<string, LastSeenEntry> {
    return { ...this.state.lastSeen };
  }

  /**
   * Check if a session has unread content.
   * @param sessionId The session ID
   * @param updatedAt ISO timestamp of when the session was last updated
   */
  hasUnread(sessionId: string, updatedAt: string): boolean {
    const lastSeen = this.state.lastSeen[sessionId];
    if (!lastSeen) {
      // Never seen = unread (if there's any content)
      return true;
    }
    return updatedAt > lastSeen.timestamp;
  }

  /**
   * Clear the last seen entry for a session.
   * Useful when a session is deleted.
   */
  async clearSession(sessionId: string): Promise<void> {
    if (this.state.lastSeen[sessionId] || this.state.needsReview[sessionId]) {
      delete this.state.lastSeen[sessionId];
      delete this.state.needsReview[sessionId];
      await this.save();
    }
  }

  private async recordSeen(
    sessionId: string,
    timestamp: string,
    messageId: string | undefined,
    options: { clearNeedsReview: boolean; emitEvent: boolean },
  ): Promise<void> {
    const changed = this.recordSeenInMemory(sessionId, timestamp, {
      messageId,
      clearNeedsReview: options.clearNeedsReview,
    });
    if (!changed) {
      return;
    }

    if (options.emitEvent && this.eventBus) {
      this.eventBus.emit({
        type: "session-seen",
        sessionId,
        timestamp,
        messageId,
      });
    }

    await this.save();
  }

  private recordSeenInMemory(
    sessionId: string,
    timestamp: string,
    options: { messageId?: string; clearNeedsReview: boolean },
  ): boolean {
    const existing = this.state.lastSeen[sessionId];
    const shouldUpdateLastSeen = !existing || existing.timestamp < timestamp;
    const needsReview = this.state.needsReview[sessionId];
    const shouldClearNeedsReview =
      options.clearNeedsReview ||
      (needsReview ? timestamp >= needsReview.timestamp : false);

    if (!shouldUpdateLastSeen && (!needsReview || !shouldClearNeedsReview)) {
      return false;
    }

    if (shouldUpdateLastSeen) {
      this.state.lastSeen[sessionId] = {
        timestamp,
        messageId: options.messageId,
      };
    }

    if (needsReview && shouldClearNeedsReview) {
      delete this.state.needsReview[sessionId];
    }

    return true;
  }

  /**
   * Save state to disk with debouncing to prevent excessive writes.
   */
  private async save(): Promise<void> {
    // Coalesce concurrent save requests into a single write loop that keeps
    // flushing until no more changes were queued during the previous write.
    if (this.savePromise) {
      this.pendingSave = true;
      await this.savePromise;
      return;
    }

    this.savePromise = this.runSaveLoop();
    try {
      await this.savePromise;
    } finally {
      this.savePromise = null;
    }
  }

  private async runSaveLoop(): Promise<void> {
    do {
      this.pendingSave = false;
      await this.doSave();
    } while (this.pendingSave);
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[NotificationService] Failed to save state:", error);
      throw error;
    }
  }

  /**
   * Get the file path for testing purposes.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Wait for any in-flight or queued saves to reach disk.
   */
  async flush(): Promise<void> {
    while (this.savePromise) {
      await this.savePromise;
    }

    if (this.pendingSave) {
      await this.save();
    }
  }
}
