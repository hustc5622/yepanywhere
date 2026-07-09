import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationService } from "../../src/notifications/NotificationService.js";
import { EventBus } from "../../src/watcher/EventBus.js";

describe("NotificationService", () => {
  let testDir: string;
  let service: NotificationService;

  beforeEach(async () => {
    // Freeze time before the test timestamps so max(provided, now) returns provided
    vi.useFakeTimers({ now: new Date("2024-01-01T00:00:00Z") });
    testDir = join(tmpdir(), `claude-notifications-test-${randomUUID()}`);
    await fs.mkdir(testDir, { recursive: true });
    service = new NotificationService({ dataDir: testDir });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("starts with empty state when file doesn't exist", async () => {
      await service.initialize();

      // File is not created until first save
      expect(service.getAllLastSeen()).toEqual({});
    });

    it("creates file on first markSeen when file doesn't exist", async () => {
      await service.initialize();
      await service.markSeen("session-1", "2024-01-01T00:00:00Z");

      const content = await fs.readFile(
        join(testDir, "notifications.json"),
        "utf-8",
      );
      const state = JSON.parse(content);
      expect(state.version).toBe(2);
      expect(state.lastSeen["session-1"]).toBeDefined();
      expect(state.needsReview).toEqual({});
    });

    it("loads existing state from JSON file", async () => {
      const existingState = {
        version: 1,
        lastSeen: {
          "session-1": { timestamp: "2024-01-01T00:00:00Z" },
          "session-2": {
            timestamp: "2024-01-02T00:00:00Z",
            messageId: "msg-123",
          },
        },
      };
      await fs.writeFile(
        join(testDir, "notifications.json"),
        JSON.stringify(existingState),
      );

      await service.initialize();

      expect(service.getLastSeen("session-1")).toEqual({
        timestamp: "2024-01-01T00:00:00Z",
      });
      expect(service.getLastSeen("session-2")).toEqual({
        timestamp: "2024-01-02T00:00:00Z",
        messageId: "msg-123",
      });
      expect(service.getSessionsNeedingReview()).toEqual([]);
    });

    it("handles corrupted JSON gracefully", async () => {
      await fs.writeFile(
        join(testDir, "notifications.json"),
        "not valid json{{{",
      );

      // Should not throw
      await service.initialize();

      // Should start fresh
      expect(service.getAllLastSeen()).toEqual({});
      expect(service.getSessionsNeedingReview()).toEqual([]);
    });
  });

  describe("markSeen", () => {
    it("updates lastSeen for a session", async () => {
      await service.initialize();

      const timestamp = "2024-06-15T12:00:00Z";
      await service.markSeen("session-1", timestamp);

      expect(service.getLastSeen("session-1")).toEqual({ timestamp });
    });

    it("includes messageId when provided", async () => {
      await service.initialize();

      const timestamp = "2024-06-15T12:00:00Z";
      await service.markSeen("session-1", timestamp, "msg-456");

      expect(service.getLastSeen("session-1")).toEqual({
        timestamp,
        messageId: "msg-456",
      });
    });

    it("uses current time when timestamp not provided", async () => {
      await service.initialize();

      const before = new Date().toISOString();
      await service.markSeen("session-1");
      const after = new Date().toISOString();

      const lastSeen = service.getLastSeen("session-1");
      expect(lastSeen).toBeDefined();
      expect(lastSeen?.timestamp).toBeDefined();
      expect(lastSeen?.timestamp && lastSeen.timestamp >= before).toBe(true);
      expect(lastSeen?.timestamp && lastSeen.timestamp <= after).toBe(true);
    });

    it("persists changes to disk", async () => {
      await service.initialize();

      await service.markSeen("session-1", "2024-06-15T12:00:00Z");

      // Create new instance and verify it loads the persisted data
      const newService = new NotificationService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getLastSeen("session-1")).toEqual({
        timestamp: "2024-06-15T12:00:00Z",
      });
    });

    it("does not update if existing timestamp is newer", async () => {
      await service.initialize();

      await service.markSeen("session-1", "2024-06-15T12:00:00Z");
      await service.markSeen("session-1", "2024-06-14T12:00:00Z"); // Earlier

      expect(service.getLastSeen("session-1")).toEqual({
        timestamp: "2024-06-15T12:00:00Z", // Should keep the newer one
      });
    });

    it("clears needs-review state even when lastSeen is already newer", async () => {
      await service.initialize();

      await service.markSeen("session-1", "2024-06-15T12:00:00Z");
      await service.markSessionNeedsReview("session-1", "2024-06-15T12:30:00Z");
      await service.markSeen("session-1", "2024-06-15T11:00:00Z");

      expect(service.getLastSeen("session-1")).toEqual({
        timestamp: "2024-06-15T12:00:00Z",
      });
      expect(service.getSessionsNeedingReview()).toEqual([]);
    });

    it("updates if new timestamp is newer", async () => {
      await service.initialize();

      await service.markSeen("session-1", "2024-06-14T12:00:00Z");
      await service.markSeen("session-1", "2024-06-15T12:00:00Z"); // Later

      expect(service.getLastSeen("session-1")).toEqual({
        timestamp: "2024-06-15T12:00:00Z",
      });
    });
  });

  describe("hasUnread", () => {
    it("returns true when session never viewed", async () => {
      await service.initialize();

      expect(service.hasUnread("session-1", "2024-06-15T12:00:00Z")).toBe(true);
    });

    it("returns true when updatedAt is after lastSeen", async () => {
      await service.initialize();

      await service.markSeen("session-1", "2024-06-15T11:00:00Z");

      expect(service.hasUnread("session-1", "2024-06-15T12:00:00Z")).toBe(true);
    });

    it("returns false when updatedAt equals lastSeen", async () => {
      await service.initialize();

      await service.markSeen("session-1", "2024-06-15T12:00:00Z");

      expect(service.hasUnread("session-1", "2024-06-15T12:00:00Z")).toBe(
        false,
      );
    });

    it("returns false when updatedAt is before lastSeen", async () => {
      await service.initialize();

      await service.markSeen("session-1", "2024-06-15T12:00:00Z");

      expect(service.hasUnread("session-1", "2024-06-15T11:00:00Z")).toBe(
        false,
      );
    });
  });

  describe("needs-review badge state", () => {
    it("marks sessions as needing review", async () => {
      await service.initialize();

      await service.markSessionNeedsReview("session-1", "2024-06-15T12:00:00Z");

      expect(service.getSessionsNeedingReview()).toEqual(["session-1"]);
    });

    it("persists needs-review sessions", async () => {
      await service.initialize();

      await service.markSessionNeedsReview("session-1", "2024-06-15T12:00:00Z");

      const newService = new NotificationService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getSessionsNeedingReview()).toEqual(["session-1"]);
    });

    it("does not replace newer needs-review timestamps", async () => {
      await service.initialize();

      await service.markSessionNeedsReview("session-1", "2024-06-15T12:00:00Z");
      await service.markSessionNeedsReview("session-1", "2024-06-15T11:00:00Z");

      const persisted = JSON.parse(
        await fs.readFile(join(testDir, "notifications.json"), "utf-8"),
      ) as {
        needsReview: Record<string, { timestamp: string }>;
      };
      expect(persisted.needsReview["session-1"]).toEqual({
        reason: "session-halted",
        timestamp: "2024-06-15T12:00:00Z",
      });
    });

    it("clears needs-review state independently of lastSeen", async () => {
      await service.initialize();

      await service.markSessionNeedsReview("session-1", "2024-06-15T12:00:00Z");
      await service.clearSessionNeedsReview("session-1");

      expect(service.getSessionsNeedingReview()).toEqual([]);
      expect(service.getLastSeen("session-1")).toBeUndefined();
    });

    it("clears needs-review state when marking seen", async () => {
      await service.initialize();

      await service.markSessionNeedsReview("session-1", "2024-06-15T12:00:00Z");
      await service.markSeen("session-1", "2024-06-15T12:01:00Z");

      expect(service.getSessionsNeedingReview()).toEqual([]);
    });
  });

  describe("clearSession", () => {
    it("removes lastSeen entry for session", async () => {
      await service.initialize();

      await service.markSeen("session-1", "2024-06-15T12:00:00Z");
      await service.markSessionNeedsReview("session-1", "2024-06-15T12:30:00Z");
      await service.clearSession("session-1");

      expect(service.getLastSeen("session-1")).toBeUndefined();
      expect(service.getSessionsNeedingReview()).toEqual([]);
    });

    it("persists removal to disk", async () => {
      await service.initialize();

      await service.markSeen("session-1", "2024-06-15T12:00:00Z");
      await service.clearSession("session-1");

      const newService = new NotificationService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getLastSeen("session-1")).toBeUndefined();
    });

    it("does nothing if session not tracked", async () => {
      await service.initialize();

      // Should not throw
      await service.clearSession("nonexistent-session");

      expect(service.getLastSeen("nonexistent-session")).toBeUndefined();
    });
  });

  describe("getAllLastSeen", () => {
    it("returns copy of all entries", async () => {
      await service.initialize();

      await service.markSeen("session-1", "2024-06-15T11:00:00Z");
      await service.markSeen("session-2", "2024-06-15T12:00:00Z");

      const all = service.getAllLastSeen();

      expect(all).toEqual({
        "session-1": { timestamp: "2024-06-15T11:00:00Z" },
        "session-2": { timestamp: "2024-06-15T12:00:00Z" },
      });

      // Verify it's a copy (modifying shouldn't affect internal state)
      all["session-3"] = { timestamp: "2024-06-15T13:00:00Z" };
      expect(service.getLastSeen("session-3")).toBeUndefined();
    });
  });

  describe("importLastSeenFromRecents", () => {
    it("imports visit timestamps without flooring to server now", async () => {
      await service.initialize();

      const imported = await service.importLastSeenFromRecents([
        {
          sessionId: "session-1",
          projectId: "project-1",
          visitedAt: "2023-12-31T23:00:00.000Z",
        },
      ]);

      expect(imported).toBe(1);
      expect(service.getLastSeen("session-1")).toEqual({
        timestamp: "2023-12-31T23:00:00.000Z",
      });
    });

    it("keeps newer explicit read markers", async () => {
      await service.initialize();

      await service.markSeen("session-1", "2024-06-15T12:00:00Z");
      const imported = await service.importLastSeenFromRecents([
        {
          sessionId: "session-1",
          projectId: "project-1",
          visitedAt: "2024-06-15T11:00:00Z",
        },
      ]);

      expect(imported).toBe(0);
      expect(service.getLastSeen("session-1")).toEqual({
        timestamp: "2024-06-15T12:00:00Z",
      });
    });

    it("does not clear newer needs-review state from an older visit", async () => {
      await service.initialize();

      await service.markSessionNeedsReview("session-1", "2024-06-15T12:00:00Z");
      await service.importLastSeenFromRecents([
        {
          sessionId: "session-1",
          projectId: "project-1",
          visitedAt: "2024-06-15T11:00:00Z",
        },
      ]);

      expect(service.getSessionsNeedingReview()).toEqual(["session-1"]);
    });
  });

  describe("event emission", () => {
    it("emits session-seen event when marking seen", async () => {
      const eventBus = new EventBus();
      const handler = vi.fn();
      eventBus.subscribe(handler);

      const serviceWithEvents = new NotificationService({
        dataDir: testDir,
        eventBus,
      });
      await serviceWithEvents.initialize();

      await serviceWithEvents.markSeen(
        "session-1",
        "2024-06-15T12:00:00Z",
        "msg-123",
      );

      expect(handler).toHaveBeenCalledWith({
        type: "session-seen",
        sessionId: "session-1",
        timestamp: "2024-06-15T12:00:00Z",
        messageId: "msg-123",
      });
    });

    it("does not emit event if timestamp not newer", async () => {
      const eventBus = new EventBus();
      const handler = vi.fn();
      eventBus.subscribe(handler);

      const serviceWithEvents = new NotificationService({
        dataDir: testDir,
        eventBus,
      });
      await serviceWithEvents.initialize();

      await serviceWithEvents.markSeen("session-1", "2024-06-15T12:00:00Z");
      handler.mockClear();

      await serviceWithEvents.markSeen("session-1", "2024-06-15T11:00:00Z"); // Earlier

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("concurrent operations", () => {
    it("handles concurrent markSeen calls gracefully", async () => {
      await service.initialize();

      // Fire off multiple concurrent updates
      await Promise.all([
        service.markSeen("session-1", "2024-06-15T12:00:00Z"),
        service.markSeen("session-2", "2024-06-15T12:00:00Z"),
        service.markSeen("session-3", "2024-06-15T12:00:00Z"),
        service.markSeen("session-1", "2024-06-15T13:00:00Z"), // Update session-1 again
      ]);

      // All should be persisted
      const newService = new NotificationService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getLastSeen("session-1")).toEqual({
        timestamp: "2024-06-15T13:00:00Z",
      });
      expect(newService.getLastSeen("session-2")).toEqual({
        timestamp: "2024-06-15T12:00:00Z",
      });
      expect(newService.getLastSeen("session-3")).toEqual({
        timestamp: "2024-06-15T12:00:00Z",
      });
    });

    it("waits for queued saves before resolving concurrent markSeen calls", async () => {
      await service.initialize();

      const originalDoSave = (
        service as NotificationService & { doSave: () => Promise<void> }
      ).doSave.bind(service);
      let writeCallCount = 0;
      let releaseFirstWrite: (() => void) | undefined;
      let releaseSecondWrite: (() => void) | undefined;
      const firstWrite = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      const secondWrite = new Promise<void>((resolve) => {
        releaseSecondWrite = resolve;
      });

      (
        service as NotificationService & { doSave: () => Promise<void> }
      ).doSave = async () => {
        writeCallCount++;

        if (writeCallCount === 1) {
          await firstWrite;
        } else if (writeCallCount === 2) {
          await secondWrite;
        }

        await originalDoSave();
      };

      const firstMarkSeen = service.markSeen(
        "session-1",
        "2024-06-15T12:00:00Z",
      );
      await Promise.resolve();

      let secondResolved = false;
      const secondMarkSeen = service
        .markSeen("session-2", "2024-06-15T12:00:00Z")
        .then(() => {
          secondResolved = true;
        });

      await Promise.resolve();
      expect(writeCallCount).toBe(1);
      expect(secondResolved).toBe(false);

      releaseFirstWrite?.();
      await vi.waitFor(() => {
        expect(writeCallCount).toBe(2);
      });
      expect(secondResolved).toBe(false);

      releaseSecondWrite?.();
      await Promise.all([firstMarkSeen, secondMarkSeen]);

      const persisted = JSON.parse(
        await fs.readFile(join(testDir, "notifications.json"), "utf-8"),
      ) as {
        lastSeen: Record<string, { timestamp: string }>;
      };

      expect(persisted.lastSeen["session-1"]).toEqual({
        timestamp: "2024-06-15T12:00:00Z",
      });
      expect(persisted.lastSeen["session-2"]).toEqual({
        timestamp: "2024-06-15T12:00:00Z",
      });
    });
  });
});
