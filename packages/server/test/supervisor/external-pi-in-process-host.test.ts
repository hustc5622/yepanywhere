import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import { type BusEvent, EventBus } from "../../src/watcher/EventBus.js";

/**
 * Pi is also hosted in-process: Pi Web runs `AgentSession` inside its own
 * server, so there is no `pi` process in the table and the host's cwd is its
 * install directory. Every probe for such a session returns a definitive
 * `false`, which used to retire the session immediately — so a session that was
 * actively streaming was reported to the client as "not running".
 *
 * These tests pin the log-based fallback that covers that host shape.
 */
const PROJECT_PATH = "/tmp/pi-project";
const projectId = Buffer.from(PROJECT_PATH).toString(
  "base64url",
) as UrlProjectId;

function createProject(): Project {
  return {
    id: projectId,
    path: PROJECT_PATH,
    name: "pi-project",
    sessionCount: 1,
    sessionDir: "/tmp/pi-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "pi",
  };
}

function createSummary(
  sessionId: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: sessionId,
    projectId,
    title: "Pi session",
    fullTitle: "Pi session",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:01.000Z",
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "pi",
    ...overrides,
  };
}

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/**
 * Real timers with short intervals: the Pi path does real file I/O, which a
 * fake clock cannot flush.
 */
const VALIDATION_MS = 60;
const DECAY_MS = 300;

async function settle(ms = 120): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ExternalSessionTracker Pi in-process hosts", () => {
  let eventBus: EventBus;
  let events: BusEvent[];
  let tracker: ExternalSessionTracker;
  let sessionsDir: string;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    eventBus = new EventBus();
    events = [];
    eventBus.subscribe((event) => events.push(event));
    sessionsDir = join(tmpdir(), `pi-tracker-${randomUUID()}`);
    tempDirs.push(sessionsDir);
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    tracker?.dispose();
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  function createTracker(
    externalProcessProbe: () => Promise<boolean | null>,
    processValidationMs = VALIDATION_MS,
    piInFlightStaleMs = 5 * 60_000,
    getSessionSummary = vi.fn(async (sessionId: string) =>
      createSummary(sessionId),
    ),
  ): ExternalSessionTracker {
    const project = createProject();
    return new ExternalSessionTracker({
      eventBus,
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        getAllProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
        getProjectBySessionDirSuffix: vi.fn(async () => project),
      } as never,
      decayMs: DECAY_MS,
      processValidationMs,
      piInFlightStaleMs,
      externalProcessProbe,
      getSessionSummary,
    });
  }

  async function writeSession(
    sessionId: string,
    tail: unknown[],
  ): Promise<string> {
    const filePath = join(sessionsDir, `2026-08-19_${sessionId}.jsonl`);
    await writeFile(
      filePath,
      jsonl([
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-08-19T00:00:00.000Z",
          cwd: PROJECT_PATH,
        },
        ...tail,
      ]),
    );
    return filePath;
  }

  function emitFileChange(filePath: string): void {
    eventBus.emit({
      type: "file-change",
      provider: "pi",
      path: filePath,
      relativePath: filePath,
      changeType: "modify",
      timestamp: "2026-08-19T00:00:02.000Z",
      fileType: "session",
    });
  }

  const userPrompt = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-08-19T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  };

  const settledAnswer = {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-08-19T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    },
  };

  const toolCall = {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-08-19T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
      stopReason: "toolUse",
    },
  };

  it("marks a session external when the log shows an unfinished turn and no process exists", async () => {
    const probe = vi.fn(async () => false);
    tracker = createTracker(probe);
    const filePath = await writeSession("pi-live", [userPrompt, toolCall]);

    emitFileChange(filePath);
    await settle();

    expect(probe).toHaveBeenCalled();
    expect(tracker.isExternal("pi-live")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "session-status-changed" &&
          event.sessionId === "pi-live" &&
          event.ownership.owner === "external" &&
          event.activity === "in-turn",
      ),
    ).toBe(true);
  });

  it("leaves a settled session unowned", async () => {
    tracker = createTracker(async () => false);
    const filePath = await writeSession("pi-idle", [userPrompt, settledAnswer]);

    emitFileChange(filePath);
    await settle();

    expect(tracker.isExternal("pi-idle")).toBe(false);
  });

  it("keeps validating a log-evidenced session and retires it once the turn settles", async () => {
    tracker = createTracker(async () => false);
    const filePath = await writeSession("pi-turn", [userPrompt, toolCall]);

    emitFileChange(filePath);
    await settle();
    expect(tracker.isExternal("pi-turn")).toBe(true);

    // Validation re-reads the log rather than trusting the earlier verdict, so
    // the session survives while the turn is still running.
    await settle();
    expect(tracker.isExternal("pi-turn")).toBe(true);

    await writeSession("pi-turn", [userPrompt, settledAnswer]);
    await settle();
    expect(tracker.isExternal("pi-turn")).toBe(false);
  });

  it("publishes the persisted terminal turn status when a Pi turn settles", async () => {
    let lastTurnStatus: SessionSummary["lastTurnStatus"] = "interrupted";
    tracker = createTracker(
      async () => false,
      VALIDATION_MS,
      5 * 60_000,
      vi.fn(async (sessionId: string) =>
        createSummary(sessionId, { lastTurnStatus }),
      ),
    );
    const filePath = await writeSession("pi-status", [userPrompt, toolCall]);

    emitFileChange(filePath);
    await settle(380);

    lastTurnStatus = "completed";
    await writeSession("pi-status", [userPrompt, settledAnswer]);
    emitFileChange(filePath);
    await settle(380);

    expect(
      events.some(
        (event) =>
          event.type === "session-updated" &&
          event.sessionId === "pi-status" &&
          event.lastTurnStatus === "completed",
      ),
    ).toBe(true);
  });

  it("survives the decay timeout while a turn is still unfinished", async () => {
    // A long thinking phase appends nothing, so decay must consult the log too.
    tracker = createTracker(async () => false, 0);
    const filePath = await writeSession("pi-thinking", [userPrompt, toolCall]);

    emitFileChange(filePath);
    await settle();
    expect(tracker.isExternal("pi-thinking")).toBe(true);

    await settle(DECAY_MS + 150);
    expect(tracker.isExternal("pi-thinking")).toBe(true);

    await writeSession("pi-thinking", [userPrompt, settledAnswer]);
    await settle(DECAY_MS + 150);
    expect(tracker.isExternal("pi-thinking")).toBe(false);
  });

  it("retires an unfinished log after the host stops writing for the stale window", async () => {
    tracker = createTracker(async () => false, VALIDATION_MS, 180);
    const filePath = await writeSession("pi-crashed", [userPrompt, toolCall]);

    emitFileChange(filePath);
    await settle();
    expect(tracker.isExternal("pi-crashed")).toBe(true);

    await vi.waitFor(
      () => expect(tracker.isExternal("pi-crashed")).toBe(false),
      {
        timeout: 1_000,
        interval: 20,
      },
    );
  });

  it("treats a settled log as idle even when a Pi process remains in the project", async () => {
    // A resident Pi CLI can stay open at its prompt, and another Pi session may
    // be running in the same cwd. The terminal log tail is session-specific;
    // the process probe is not.
    tracker = createTracker(async () => true);
    const filePath = await writeSession("pi-cli", [userPrompt, settledAnswer]);

    emitFileChange(filePath);
    await settle();

    expect(tracker.isExternal("pi-cli")).toBe(false);
  });
});
