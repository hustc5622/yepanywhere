import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import {
  type OpenCodeSessionChangeCursor,
  type OpenCodeSessionChangeScanResult,
  OpenCodeSessionScanError,
  OpenCodeSessionScanner,
} from "../../src/projects/opencode-scanner.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  type OpenCodeSessionChangeFsWatcher,
  OpenCodeSessionChangeMonitor,
} from "../../src/services/OpenCodeSessionChangeMonitor.js";
import { SessionTitleService } from "../../src/services/SessionTitleService.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { OpenCodeSessionReader } from "../../src/sessions/opencode-reader.js";
import type { SessionUpdatedEvent } from "../../src/watcher/EventBus.js";
import { EventBus } from "../../src/watcher/EventBus.js";

interface TestStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): TestStatement;
  close(): void;
}

interface TestSqliteModule {
  DatabaseSync: new (path: string) => TestDatabase;
}

class TestFsWatcher implements OpenCodeSessionChangeFsWatcher {
  closed = false;
  private errorHandler: ((error: Error) => void) | null = null;

  close(): void {
    this.closed = true;
  }

  on(_event: "error", listener: (error: Error) => void): this {
    this.errorHandler = listener;
    return this;
  }

  emitError(error: Error): void {
    this.errorHandler?.(error);
  }

  unref(): void {}
}

async function loadSqlite(): Promise<TestSqliteModule | null> {
  const specifier: string = "node:sqlite";
  const getBuiltinModule = (
    process as unknown as {
      getBuiltinModule?: (name: string) => unknown;
    }
  ).getBuiltinModule;
  const builtin = getBuiltinModule?.call(process, specifier) as
    | TestSqliteModule
    | undefined;
  if (builtin?.DatabaseSync) return builtin;
  return import(specifier)
    .then((module) => {
      const DatabaseSync = (module as { DatabaseSync?: unknown }).DatabaseSync;
      return typeof DatabaseSync === "function"
        ? ({ DatabaseSync } as TestSqliteModule)
        : null;
    })
    .catch(() => null);
}

async function createDatabase(dbPath: string): Promise<TestDatabase | null> {
  const sqlite = await loadSqlite();
  if (!sqlite) return null;
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY,
      project_id text,
      directory text,
      parent_id text,
      title text,
      model text,
      metadata text,
      time_created integer,
      time_updated integer NOT NULL,
      time_archived integer,
      tokens_input integer DEFAULT 0,
      tokens_output integer DEFAULT 0,
      tokens_reasoning integer DEFAULT 0,
      tokens_cache_read integer DEFAULT 0,
      tokens_cache_write integer DEFAULT 0
    );
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  return db;
}

function insertSession(
  db: TestDatabase,
  input: {
    id: string;
    directory: string | null;
    updatedAt: number;
    title?: string;
    parentId?: string;
    archivedAt?: number;
  },
): void {
  db.prepare(
    `
      INSERT INTO session (
        id, project_id, directory, parent_id, title, time_created,
        time_updated, time_archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.id,
    "global",
    input.directory,
    input.parentId ?? null,
    input.title ?? input.id,
    input.updatedAt,
    input.updatedAt,
    input.archivedAt ?? null,
  );
}

function insertMessageWithText(
  db: TestDatabase,
  input: {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    text: string;
    updatedAt: number;
    parentId?: string;
    finish?: string;
  },
): void {
  db.prepare(
    `
      INSERT INTO message (
        id, session_id, time_created, time_updated, data
      ) VALUES (?, ?, ?, ?, ?)
    `,
  ).run(
    input.id,
    input.sessionId,
    input.updatedAt,
    input.updatedAt,
    JSON.stringify({
      role: input.role,
      time: {
        created: input.updatedAt,
        ...(input.role === "assistant" ? { completed: input.updatedAt } : {}),
      },
      ...(input.parentId ? { parentID: input.parentId } : {}),
      ...(input.finish ? { finish: input.finish } : {}),
      ...(input.role === "user"
        ? {
            model: {
              providerID: "anthropic",
              modelID: "glm-5.2",
            },
          }
        : {
            providerID: "anthropic",
            modelID: "glm-5.2",
          }),
    }),
  );
  db.prepare(
    `
      INSERT INTO part (
        id, message_id, session_id, time_created, time_updated, data
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(
    `part_${input.id}`,
    input.id,
    input.sessionId,
    input.updatedAt,
    input.updatedAt,
    JSON.stringify({ type: "text", text: input.text }),
  );
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for asynchronous monitor work");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function emptyScanResult(
  cursor: OpenCodeSessionChangeCursor,
): OpenCodeSessionChangeScanResult {
  return {
    changes: [],
    scannedRows: 0,
    skipped: { archived: 0, child: 0, invalidDirectory: 0 },
    nextCursor: cursor,
    hasMore: false,
  };
}

describe("OpenCodeSessionChangeMonitor", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ now: 10_000 });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("uses a monotonic cursor and skips archived, child, and invalid-directory rows", async () => {
    const directory = join(tmpdir(), `opencode-monitor-${randomUUID()}`);
    tempDirs.push(directory);
    await mkdir(directory, { recursive: true });
    const dbPath = join(directory, "opencode.db");
    const db = await createDatabase(dbPath);
    expect(db).not.toBeNull();
    if (!db) return;

    let notifyFsChange: ((filename: string | Buffer | null) => void) | null =
      null;
    const watcher = new TestFsWatcher();
    const eventBus = new EventBus();
    const events: SessionUpdatedEvent[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "session-updated") events.push(event);
    });
    const scanner = new OpenCodeSessionScanner({ dbPath });
    const scanSpy = vi.spyOn(scanner, "scanSessionChanges");
    const monitor = new OpenCodeSessionChangeMonitor({
      dbPath,
      scanner,
      eventBus,
      batchLimit: 2,
      maxBatchesPerScan: 2,
      processingConcurrency: 2,
      debounceMs: 10,
      pollMs: 1_000,
      startupOverlapMs: 0,
      watchFactory: (_watchDirectory, onChange) => {
        notifyFsChange = onChange;
        return watcher;
      },
    });
    monitor.start();
    await monitor.waitForIdle();

    const projectPath = "c:\\work\\demo";
    for (const row of [
      { id: "ses_a_archived", archivedAt: 10_001 },
      { id: "ses_b_child", parentId: "ses_parent" },
      { id: "ses_c_invalid", directory: "" },
      { id: "ses_d", directory: projectPath },
      { id: "ses_e", directory: projectPath },
    ]) {
      insertSession(db, {
        id: row.id,
        directory: row.directory ?? projectPath,
        updatedAt: 10_001,
        archivedAt: row.archivedAt,
        parentId: row.parentId,
      });
    }

    notifyFsChange?.("opencode.db-wal");
    await vi.advanceTimersByTimeAsync(10);
    await monitor.waitForIdle();

    expect(events.map((event) => event.sessionId).sort()).toEqual([
      "ses_d",
      "ses_e",
    ]);
    expect(events[0]?.projectId).toBe(
      encodeProjectId("C:/work/demo") as UrlProjectId,
    );
    expect(monitor.currentCursor).toEqual({
      updatedAt: 10_010,
      sessionId: "",
    });
    expect(scanSpy.mock.calls.every((call) => call[1] === 2)).toBe(true);
    // Five equal-timestamp rows require pagination and a bounded continuation;
    // none may be lost at the page boundary.
    expect(scanSpy.mock.calls.length).toBeGreaterThanOrEqual(4);

    await monitor.stop();
    db.close();
    expect(watcher.closed).toBe(true);
  });

  it("uses polling to recover a change when fs.watch is missed", async () => {
    const directory = join(tmpdir(), `opencode-monitor-poll-${randomUUID()}`);
    tempDirs.push(directory);
    await mkdir(directory, { recursive: true });
    const dbPath = join(directory, "opencode.db");
    const db = await createDatabase(dbPath);
    expect(db).not.toBeNull();
    if (!db) return;

    const eventBus = new EventBus();
    const events: SessionUpdatedEvent[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "session-updated") events.push(event);
    });
    const monitor = new OpenCodeSessionChangeMonitor({
      dbPath,
      scanner: new OpenCodeSessionScanner({ dbPath }),
      eventBus,
      pollMs: 50,
      startupOverlapMs: 0,
      watchFactory: () => new TestFsWatcher(),
    });
    monitor.start();
    await monitor.waitForIdle();

    insertSession(db, {
      id: "ses_poll",
      directory: "/tmp/poll-project",
      updatedAt: 10_001,
    });
    await vi.advanceTimersByTimeAsync(50);
    await monitor.waitForIdle();

    expect(events.map((event) => event.sessionId)).toEqual(["ses_poll"]);
    await monitor.stop();
    db.close();
  });

  it("accepts an idempotent overlap replay with watermark-only progress", async () => {
    const scanner = {
      scanSessionChanges: vi.fn(
        async (
          cursor: OpenCodeSessionChangeCursor,
        ): Promise<OpenCodeSessionChangeScanResult> => ({
          changes: [
            {
              sessionId: "ses_replayed",
              directory: "/tmp/replayed",
              updatedAt: cursor.updatedAt,
            },
          ],
          scannedRows: 0,
          skipped: { archived: 0, child: 0, invalidDirectory: 0 },
          nextCursor: { updatedAt: cursor.updatedAt + 50, sessionId: "" },
          hasMore: false,
        }),
      ),
    };
    const emitted: string[] = [];
    const monitor = new OpenCodeSessionChangeMonitor({
      dbPath: "/tmp/opencode.db",
      scanner,
      eventBus: new EventBus(),
      pollMs: 50,
      startupOverlapMs: 0,
      watchFactory: () => new TestFsWatcher(),
      emitEvent: (event) => emitted.push(event.sessionId),
    });

    monitor.start();
    await monitor.waitForIdle();
    expect(emitted).toEqual(["ses_replayed"]);

    await vi.advanceTimersByTimeAsync(50);
    await monitor.waitForIdle();
    expect(emitted).toEqual(["ses_replayed", "ses_replayed"]);
    expect(scanner.scanSessionChanges).toHaveBeenCalledTimes(2);
    expect(monitor.currentCursor).toEqual({
      updatedAt: 10_100,
      sessionId: "",
    });

    await monitor.stop();
  });

  it("re-emits a message-only final stop and drives the shared title service", async () => {
    vi.useRealTimers();
    const directory = join(
      tmpdir(),
      `opencode-monitor-title-chain-${randomUUID()}`,
    );
    tempDirs.push(directory);
    await mkdir(directory, { recursive: true });
    const dbPath = join(directory, "opencode.db");
    const db = await createDatabase(dbPath);
    expect(db).not.toBeNull();
    if (!db) return;

    const projectPath = join(directory, "external-cli-project");
    const projectId = encodeProjectId(projectPath) as UrlProjectId;
    const sessionId = "ses_external_cli";
    const metadataService = new SessionMetadataService({
      dataDir: join(directory, "yep-metadata"),
    });
    await metadataService.initialize();
    const eventBus = new EventBus();
    const reader = new OpenCodeSessionReader({ dbPath, projectPath });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"title":"Benchmark 失败模式分析"}' } },
            ],
          }),
          { status: 200 },
        ),
    );
    let loadCount = 0;
    const titleService = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      scheduleDelayMs: 0,
      minRetryIntervalMs: 0,
      retryMaxAttempts: 1,
      fetchImpl: fetchMock,
      loadSession: async (requestedSessionId, requestedProjectId) => {
        const loaded = await reader.getSession(
          requestedSessionId,
          requestedProjectId,
        );
        loadCount += 1;
        return loaded ? normalizeSession(loaded) : null;
      },
    });
    titleService.start();

    let notifyFsChange: ((filename: string | Buffer | null) => void) | null =
      null;
    const sessionEvents: SessionUpdatedEvent[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "session-updated") sessionEvents.push(event);
    });
    const monitor = new OpenCodeSessionChangeMonitor({
      dbPath,
      scanner: new OpenCodeSessionScanner({ dbPath }),
      eventBus,
      debounceMs: 10,
      pollMs: 1_000,
      startupOverlapMs: 0,
      watchFactory: (_watchDirectory, onChange) => {
        notifyFsChange = onChange;
        return new TestFsWatcher();
      },
    });
    monitor.start();
    await monitor.waitForIdle();

    const toolUpdatedAt = Date.now() + 10;
    insertSession(db, {
      id: sessionId,
      directory: projectPath,
      title: "New session",
      updatedAt: toolUpdatedAt,
    });
    insertMessageWithText(db, {
      id: "msg_user",
      sessionId,
      role: "user",
      text: "分析 Benchmark Run #58 的失败模式",
      updatedAt: toolUpdatedAt,
    });
    insertMessageWithText(db, {
      id: "msg_tool_stage",
      sessionId,
      role: "assistant",
      text: "我将先读取 benchmark 结果。",
      parentId: "msg_user",
      finish: "tool-calls",
      updatedAt: toolUpdatedAt,
    });
    const persistedSessionUpdatedAt = db
      .prepare("SELECT time_updated FROM session WHERE id = ?")
      .get(sessionId)?.time_updated;

    notifyFsChange?.("opencode.db-wal");
    await waitUntil(() => sessionEvents.length === 1 && loadCount >= 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadataService.getMetadata(sessionId)?.aiTitle).toBeUndefined();

    // OpenCode's final projection changes only message/part rows. Deliberately
    // leave session.time_updated untouched to guard the external CLI path.
    const finalUpdatedAt = toolUpdatedAt + 10;
    insertMessageWithText(db, {
      id: "msg_final",
      sessionId,
      role: "assistant",
      text: "已完成 Benchmark Run #58 的失败模式分析。",
      parentId: "msg_tool_stage",
      finish: "stop",
      updatedAt: finalUpdatedAt,
    });
    expect(
      db.prepare("SELECT time_updated FROM session WHERE id = ?").get(sessionId)
        ?.time_updated,
    ).toBe(persistedSessionUpdatedAt);

    notifyFsChange?.("opencode.db-shm");
    await waitUntil(
      () => metadataService.getMetadata(sessionId)?.aiTitle !== undefined,
    );

    expect(sessionEvents.map((event) => event.sessionId)).toEqual([
      sessionId,
      sessionId,
    ]);
    expect(sessionEvents[1]).toMatchObject({
      trigger: "opencode-db-reconcile",
      updatedAt: new Date(finalUpdatedAt).toISOString(),
      projectId,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(metadataService.getMetadata(sessionId)?.aiTitle).toBe(
      "Benchmark 失败模式分析",
    );

    await monitor.stop();
    titleService.stop();
    db.close();
  });

  it("debounces dense main/WAL/SHM notifications into one scan", async () => {
    let notifyFsChange: ((filename: string | Buffer | null) => void) | null =
      null;
    const scanner = {
      scanSessionChanges: vi.fn(async (cursor: OpenCodeSessionChangeCursor) =>
        emptyScanResult(cursor),
      ),
    };
    const monitor = new OpenCodeSessionChangeMonitor({
      dbPath: "/tmp/opencode.db",
      scanner,
      eventBus: new EventBus(),
      debounceMs: 20,
      pollMs: 1_000,
      startupOverlapMs: 0,
      watchFactory: (_directory, onChange) => {
        notifyFsChange = onChange;
        return new TestFsWatcher();
      },
    });
    monitor.start();
    await monitor.waitForIdle();
    expect(scanner.scanSessionChanges).toHaveBeenCalledTimes(1);

    notifyFsChange?.("opencode.db");
    notifyFsChange?.("opencode.db-wal");
    notifyFsChange?.("opencode.db-shm");
    notifyFsChange?.("unrelated-file");
    await vi.advanceTimersByTimeAsync(19);
    expect(scanner.scanSessionChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await monitor.waitForIdle();
    expect(scanner.scanSessionChanges).toHaveBeenCalledTimes(2);

    await monitor.stop();
  });

  it("limits asynchronous event processing concurrency", async () => {
    let scanCount = 0;
    let active = 0;
    let maxActive = 0;
    const emitted: string[] = [];
    const scanner = {
      scanSessionChanges: vi.fn(
        async (
          cursor: OpenCodeSessionChangeCursor,
        ): Promise<OpenCodeSessionChangeScanResult> => {
          scanCount += 1;
          if (scanCount > 1) return emptyScanResult(cursor);
          return {
            changes: Array.from({ length: 7 }, (_, index) => ({
              sessionId: `ses_${index}`,
              directory: "/tmp/project",
              updatedAt: 10_001 + index,
            })),
            scannedRows: 7,
            skipped: { archived: 0, child: 0, invalidDirectory: 0 },
            nextCursor: { updatedAt: 10_007, sessionId: "ses_6" },
            hasMore: false,
          };
        },
      ),
    };
    const monitor = new OpenCodeSessionChangeMonitor({
      dbPath: "/tmp/opencode.db",
      scanner,
      eventBus: new EventBus(),
      processingConcurrency: 2,
      startupOverlapMs: 0,
      watchFactory: () => new TestFsWatcher(),
      emitEvent: async (event) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        emitted.push(event.sessionId);
        active -= 1;
      },
    });
    monitor.start();
    await monitor.waitForIdle();

    expect(emitted).toHaveLength(7);
    expect(maxActive).toBe(2);
    await monitor.stop();
  });

  it("retains its cursor after a transient database failure and retries on poll", async () => {
    let attempt = 0;
    const emitted: SessionUpdatedEvent[] = [];
    const scanner = {
      scanSessionChanges: vi.fn(
        async (
          cursor: OpenCodeSessionChangeCursor,
        ): Promise<OpenCodeSessionChangeScanResult> => {
          attempt += 1;
          if (attempt === 1) {
            throw new OpenCodeSessionScanError(
              "query-failed",
              new Error("database is locked"),
            );
          }
          return attempt === 2
            ? {
                changes: [
                  {
                    sessionId: "ses_recovered",
                    directory: "/tmp/recovered",
                    updatedAt: 10_001,
                  },
                ],
                scannedRows: 1,
                skipped: { archived: 0, child: 0, invalidDirectory: 0 },
                nextCursor: {
                  updatedAt: 10_001,
                  sessionId: "ses_recovered",
                },
                hasMore: false,
              }
            : emptyScanResult(cursor);
        },
      ),
    };
    const monitor = new OpenCodeSessionChangeMonitor({
      dbPath: "/tmp/opencode.db",
      scanner,
      eventBus: new EventBus(),
      pollMs: 50,
      startupOverlapMs: 0,
      watchFactory: () => new TestFsWatcher(),
      emitEvent: (event) => emitted.push(event),
    });
    monitor.start();
    await monitor.waitForIdle();
    expect(monitor.currentCursor).toEqual({
      updatedAt: 10_000,
      sessionId: "",
    });

    await vi.advanceTimersByTimeAsync(50);
    await monitor.waitForIdle();
    expect(emitted.map((event) => event.sessionId)).toEqual(["ses_recovered"]);
    expect(monitor.currentCursor.sessionId).toBe("ses_recovered");
    await monitor.stop();
  });

  it("waits for an in-flight emit during stop and never emits afterward", async () => {
    let resolveEmit: (() => void) | null = null;
    let emitStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      emitStarted = resolve;
    });
    const scanner = {
      scanSessionChanges: vi.fn(
        async (): Promise<OpenCodeSessionChangeScanResult> => ({
          changes: [
            {
              sessionId: "ses_in_flight",
              directory: "/tmp/in-flight",
              updatedAt: 10_001,
            },
            {
              sessionId: "ses_must_not_start",
              directory: "/tmp/in-flight",
              updatedAt: 10_002,
            },
          ],
          scannedRows: 2,
          skipped: { archived: 0, child: 0, invalidDirectory: 0 },
          nextCursor: {
            updatedAt: 10_002,
            sessionId: "ses_must_not_start",
          },
          hasMore: false,
        }),
      ),
    };
    const emitted: string[] = [];
    const monitor = new OpenCodeSessionChangeMonitor({
      dbPath: "/tmp/opencode.db",
      scanner,
      eventBus: new EventBus(),
      processingConcurrency: 1,
      startupOverlapMs: 0,
      watchFactory: () => new TestFsWatcher(),
      emitEvent: async (event) => {
        emitted.push(event.sessionId);
        emitStarted?.();
        await new Promise<void>((resolve) => {
          resolveEmit = resolve;
        });
      },
    });
    monitor.start();
    await started;

    let stopCompleted = false;
    const stopPromise = monitor.stop().then(() => {
      stopCompleted = true;
    });
    await Promise.resolve();
    expect(stopCompleted).toBe(false);
    resolveEmit?.();
    await stopPromise;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(emitted).toEqual(["ses_in_flight"]);
    expect(scanner.scanSessionChanges).toHaveBeenCalledOnce();
  });
});

describe("OpenCodeSessionScanner incremental and backfill queries", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("paginates same-millisecond message/part updates without dropping sessions", async () => {
    const directory = join(
      tmpdir(),
      `opencode-effective-cursor-${randomUUID()}`,
    );
    tempDirs.push(directory);
    await mkdir(directory, { recursive: true });
    const dbPath = join(directory, "opencode.db");
    const db = await createDatabase(dbPath);
    expect(db).not.toBeNull();
    if (!db) return;
    const base = Date.now();

    for (const id of ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e"]) {
      insertSession(db, {
        id,
        directory: "/tmp/project",
        updatedAt: base,
      });
      insertMessageWithText(db, {
        id: `msg_${id}`,
        sessionId: id,
        role: "assistant",
        text: id,
        finish: "stop",
        updatedAt: base + 60_000,
      });
    }
    const scanner = new OpenCodeSessionScanner({ dbPath });
    const first = await scanner.scanSessionChanges(
      { updatedAt: base + 59_500, sessionId: "" },
      2,
    );
    db.prepare("UPDATE part SET data = ? WHERE id = ?").run(
      JSON.stringify({ type: "text", text: "ses_a second projection" }),
      "part_msg_ses_a",
    );
    const second = await scanner.scanSessionChanges(first.nextCursor, 2);
    const third = await scanner.scanSessionChanges(second.nextCursor, 2);

    expect(first.changes.map((change) => change.sessionId)).toEqual([
      "ses_a",
      "ses_b",
    ]);
    expect(first.hasMore).toBe(true);
    expect(second.changes.map((change) => change.sessionId)).toEqual([
      "ses_c",
      "ses_d",
    ]);
    expect(second.hasMore).toBe(true);
    expect(third.changes.map((change) => change.sessionId)).toEqual([
      "ses_a",
      "ses_e",
    ]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toEqual({
      updatedAt: base + 60_000,
      sessionId: "ses_e",
    });
    db.close();
  });

  it("replays late commits behind a same-millisecond composite cursor", async () => {
    const directory = join(tmpdir(), `opencode-late-cursor-${randomUUID()}`);
    tempDirs.push(directory);
    await mkdir(directory, { recursive: true });
    const dbPath = join(directory, "opencode.db");
    const db = await createDatabase(dbPath);
    expect(db).not.toBeNull();
    if (!db) return;
    const base = Date.now();

    insertSession(db, {
      id: "ses_z",
      directory: "/tmp/project",
      updatedAt: base,
    });
    insertMessageWithText(db, {
      id: "msg_z",
      sessionId: "ses_z",
      role: "assistant",
      text: "first projection",
      finish: "stop",
      updatedAt: base + 60_000,
    });

    const scanner = new OpenCodeSessionScanner({ dbPath });
    const first = await scanner.scanSessionChanges(
      { updatedAt: base + 59_500, sessionId: "" },
      10,
    );
    expect(first.changes.map((change) => change.sessionId)).toEqual(["ses_z"]);
    expect(first.nextCursor).toEqual({
      updatedAt: base + 60_000,
      sessionId: "ses_z",
    });

    // Both writes are committed after the cursor advanced. One belongs to a
    // lexicographically earlier session; the other changes the same session
    // again without changing its millisecond timestamp.
    insertSession(db, {
      id: "ses_a",
      directory: "/tmp/project",
      updatedAt: base,
    });
    insertMessageWithText(db, {
      id: "msg_a",
      sessionId: "ses_a",
      role: "assistant",
      text: "late projection",
      finish: "stop",
      updatedAt: base + 60_000,
    });
    db.prepare("UPDATE part SET data = ? WHERE id = ?").run(
      JSON.stringify({ type: "text", text: "second projection" }),
      "part_msg_z",
    );

    const replay = await scanner.scanSessionChanges(first.nextCursor, 10);
    expect(replay.scannedRows).toBe(0);
    expect(replay.changes.map((change) => change.sessionId)).toEqual([
      "ses_a",
      "ses_z",
    ]);
    expect(replay.nextCursor).toEqual(first.nextCursor);
    expect(replay.hasMore).toBe(false);
    db.close();
  });

  it("advances the idle watermark until an unchanged replay ages out", async () => {
    const directory = join(
      tmpdir(),
      `opencode-replay-watermark-${randomUUID()}`,
    );
    tempDirs.push(directory);
    await mkdir(directory, { recursive: true });
    const dbPath = join(directory, "opencode.db");
    const db = await createDatabase(dbPath);
    expect(db).not.toBeNull();
    if (!db) return;

    insertSession(db, {
      id: "ses_idle",
      directory: "/tmp/project",
      updatedAt: 9_500,
    });
    const scanner = new OpenCodeSessionScanner({ dbPath });

    vi.useFakeTimers({ now: 10_000 });
    try {
      const first = await scanner.scanSessionChanges(
        { updatedAt: 9_500, sessionId: "ses_idle" },
        10,
      );
      expect(first.changes.map((change) => change.sessionId)).toEqual([
        "ses_idle",
      ]);
      expect(first.nextCursor).toEqual({
        updatedAt: 10_000,
        sessionId: "",
      });

      await vi.advanceTimersByTimeAsync(1_100);
      const second = await scanner.scanSessionChanges(first.nextCursor, 10);
      expect(second.changes.map((change) => change.sessionId)).toEqual([
        "ses_idle",
      ]);
      expect(second.nextCursor.updatedAt).toBe(11_100);

      await vi.advanceTimersByTimeAsync(1_100);
      const third = await scanner.scanSessionChanges(second.nextCursor, 10);
      expect(third.changes).toEqual([]);
      expect(third.nextCursor.updatedAt).toBe(12_200);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it("returns only bounded recent top-level sessions with generic titles", async () => {
    const directory = join(tmpdir(), `opencode-invalid-title-${randomUUID()}`);
    tempDirs.push(directory);
    await mkdir(directory, { recursive: true });
    const dbPath = join(directory, "opencode.db");
    const db = await createDatabase(dbPath);
    expect(db).not.toBeNull();
    if (!db) return;

    insertSession(db, {
      id: "ses_invalid_cn",
      directory: "/tmp/project",
      title: "根据这个对话的内容，我为其生成的标题是：",
      updatedAt: 2_000,
    });
    insertSession(db, {
      id: "ses_valid",
      directory: "/tmp/project",
      title: "修复 OpenCode 标题生成漂移",
      updatedAt: 2_001,
    });
    insertSession(db, {
      id: "ses_child",
      directory: "/tmp/project",
      title: "以下是标题：",
      updatedAt: 2_002,
      parentId: "ses_parent",
    });
    insertSession(db, {
      id: "ses_archived",
      directory: "/tmp/project",
      title: "## 对话标题",
      updatedAt: 2_003,
      archivedAt: 2_004,
    });
    insertSession(db, {
      id: "ses_old",
      directory: "/tmp/project",
      title: "Here's a title for this conversation:",
      updatedAt: 999,
    });
    db.close();

    const scanner = new OpenCodeSessionScanner({ dbPath });
    const sessions = await scanner.listRecentInvalidTitleSessions(1_000, 1);
    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: "ses_invalid_cn",
        updatedAt: 2_000,
      }),
    ]);
  });

  it("excludes already titled sessions before filling the invalid-title limit", async () => {
    const directory = join(
      tmpdir(),
      `opencode-invalid-title-exclusion-${randomUUID()}`,
    );
    tempDirs.push(directory);
    await mkdir(directory, { recursive: true });
    const dbPath = join(directory, "opencode.db");
    const db = await createDatabase(dbPath);
    expect(db).not.toBeNull();
    if (!db) return;

    insertSession(db, {
      id: "ses_already_titled",
      directory: "/tmp/newer-project",
      title: "New session",
      updatedAt: 2_001,
    });
    insertSession(db, {
      id: "ses_needs_title",
      directory: "/tmp/older-project",
      title: "New session",
      updatedAt: 2_000,
    });
    db.close();

    const scanner = new OpenCodeSessionScanner({ dbPath });
    const sessions = await scanner.listRecentInvalidTitleSessions(
      1_000,
      1,
      new Set(["ses_already_titled"]),
    );

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: "ses_needs_title",
        directory: "/tmp/older-project",
      }),
    ]);
  });
});
