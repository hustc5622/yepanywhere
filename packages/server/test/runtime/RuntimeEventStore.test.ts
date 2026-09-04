import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeEventStore } from "../../src/runtime/RuntimeEventStore.js";

describe("RuntimeEventStore", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `runtime-events-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("appends monotonic events and replays after a sequence", async () => {
    const store = new RuntimeEventStore({ eventsDir: testDir });
    await store.append({
      processId: "proc-1",
      sessionId: "sess-1",
      type: "message",
      data: { uuid: "msg-1", text: "one" },
    });
    await store.append({
      processId: "proc-1",
      sessionId: "sess-1",
      type: "status",
      data: { state: "waiting-input" },
    });

    await expect(store.replay({ sessionId: "sess-1" })).resolves.toMatchObject([
      { seq: 1, type: "message" },
      { seq: 2, type: "status" },
    ]);
    await expect(
      store.replay({ processId: "proc-1", afterSeq: 1 }),
    ).resolves.toMatchObject([{ seq: 2, type: "status" }]);
  });

  it("discovers persisted session events after a store restart", async () => {
    const first = new RuntimeEventStore({ eventsDir: testDir });
    await first.append({
      processId: "proc-persisted",
      sessionId: "sess-persisted",
      type: "message",
      data: { uuid: "persisted-message" },
    });
    await first.flush();

    const restarted = new RuntimeEventStore({ eventsDir: testDir });
    await expect(
      restarted.replay({ sessionId: "sess-persisted" }),
    ).resolves.toMatchObject([
      {
        processId: "proc-persisted",
        sessionId: "sess-persisted",
        type: "message",
      },
    ]);
  });

  it("replays only the latest cold-start generation and scopes afterSeq to it", async () => {
    const first = new RuntimeEventStore({ eventsDir: testDir });
    const sessionId = "sess-multi-generation";
    for (const [index, type] of ["message", "error", "complete"].entries()) {
      await first.append({
        processId: "proc-old",
        sessionId,
        type,
        data: { generation: "old", index },
        // Generation selection uses the final matching record, not an older
        // event whose timestamp happens to be farther in the future.
        timestamp:
          index === 0
            ? "2099-08-08T00:00:00.000Z"
            : `2026-08-08T00:00:0${index}.000Z`,
      });
    }
    for (const [index, type] of ["message", "error", "complete"].entries()) {
      await first.append({
        processId: "proc-new",
        sessionId,
        type,
        data: { generation: "new", index },
        timestamp: `2026-08-08T00:01:0${index}.000Z`,
      });
    }
    await first.flush();

    const restarted = new RuntimeEventStore({ eventsDir: testDir });
    await expect(
      restarted.replay({ sessionId, afterSeq: 1 }),
    ).resolves.toMatchObject([
      {
        processId: "proc-new",
        seq: 2,
        type: "error",
        data: { generation: "new" },
      },
      {
        processId: "proc-new",
        seq: 3,
        type: "complete",
        data: { generation: "new" },
      },
    ]);
    await expect(restarted.replay({ sessionId, afterSeq: 3 })).resolves.toEqual(
      [],
    );
  });

  it("uses process id as a stable tie-breaker for cold-start generations", async () => {
    const first = new RuntimeEventStore({ eventsDir: testDir });
    const timestamp = "2026-08-08T00:00:00.000Z";
    for (const processId of ["proc-a", "proc-b"]) {
      await first.append({
        processId,
        sessionId: "sess-tied-generation",
        type: "complete",
        data: { processId },
        timestamp,
      });
    }
    await first.flush();

    const restarted = new RuntimeEventStore({ eventsDir: testDir });
    await expect(
      restarted.replay({ sessionId: "sess-tied-generation" }),
    ).resolves.toMatchObject([
      { processId: "proc-b", data: { processId: "proc-b" } },
    ]);
  });

  it("keeps the previous segment readable after rotation", async () => {
    const store = new RuntimeEventStore({
      eventsDir: testDir,
      maxFileBytes: 220,
    });
    for (let index = 0; index < 4; index += 1) {
      await store.append({
        processId: "proc-rotated",
        sessionId: "sess-rotated",
        type: "message",
        data: { uuid: `msg-${index}`, text: "x".repeat(40) },
      });
    }

    const replay = await store.replay({ processId: "proc-rotated" });
    expect(replay.length).toBeGreaterThanOrEqual(2);
    expect(replay.at(-1)).toMatchObject({ seq: 4 });
  });

  it("discovers a previous session id that only remains in the rotated segment", async () => {
    const store = new RuntimeEventStore({
      eventsDir: testDir,
      maxFileBytes: 220,
    });
    await store.append({
      processId: "proc-renamed",
      sessionId: "temporary-session",
      type: "message",
      data: { uuid: "temporary-1", text: "x".repeat(80) },
    });
    await store.append({
      processId: "proc-renamed",
      sessionId: "temporary-session",
      type: "message",
      data: { uuid: "temporary-2", text: "x".repeat(80) },
    });
    await store.append({
      processId: "proc-renamed",
      sessionId: "durable-session",
      type: "session-id-changed",
      data: { oldSessionId: "temporary-session" },
    });
    await store.flush();

    const restarted = new RuntimeEventStore({ eventsDir: testDir });
    await expect(
      restarted.replay({ sessionId: "temporary-session" }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "temporary-session" }),
      ]),
    );
  });

  it("removes journal segments older than the retention window", async () => {
    const oldPath = path.join(testDir, "old-process.jsonl");
    await writeFile(oldPath, "old event\n");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(oldPath, oldTime, oldTime);

    const store = new RuntimeEventStore({
      eventsDir: testDir,
      retentionMs: 1_000,
    });
    await store.initialize();

    await expect(readdir(testDir)).resolves.not.toContain("old-process.jsonl");
  });

  it("re-applies retention on demand while the runtime keeps running", async () => {
    // initialize() only prunes at startup; a server that stays up for weeks
    // would otherwise accumulate one journal file per process forever.
    const store = new RuntimeEventStore({
      eventsDir: testDir,
      retentionMs: 1_000,
    });
    await store.initialize();

    const stalePath = path.join(testDir, "stale-process.jsonl");
    await writeFile(stalePath, "stale event\n");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(stalePath, staleTime, staleTime);
    await expect(readdir(testDir)).resolves.toContain("stale-process.jsonl");

    await store.prune();

    await expect(readdir(testDir)).resolves.not.toContain(
      "stale-process.jsonl",
    );
  });

  it("removes the oldest segments until the global byte budget is met", async () => {
    const olderPath = path.join(testDir, "older.jsonl");
    const newerPath = path.join(testDir, "newer.jsonl");
    await writeFile(olderPath, "o".repeat(80));
    await writeFile(newerPath, "n".repeat(80));
    const now = Date.now();
    await utimes(olderPath, new Date(now - 2_000), new Date(now - 2_000));
    await utimes(newerPath, new Date(now - 1_000), new Date(now - 1_000));

    const store = new RuntimeEventStore({
      eventsDir: testDir,
      maxTotalBytes: 100,
      retentionMs: 60_000,
    });
    await store.initialize();

    await expect(readdir(testDir)).resolves.toEqual(["newer.jsonl"]);
  });
});
