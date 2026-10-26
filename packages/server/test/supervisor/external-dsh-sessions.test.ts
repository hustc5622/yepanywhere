import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import { type BusEvent, EventBus } from "../../src/watcher/EventBus.js";

/**
 * dsh Web hosts every agent in-process, so there is never a `dsh` process
 * attributable to the project. The read-only dsh integration relies on the log
 * tail: an open `turn/start` means running, an unanswered `approval/asked`
 * means waiting for the user.
 */
const PROJECT_PATH = "/tmp/dsh-project";
const projectId = Buffer.from(PROJECT_PATH).toString(
  "base64url",
) as UrlProjectId;

function createProject(): Project {
  return {
    id: projectId,
    path: PROJECT_PATH,
    name: "dsh-project",
    sessionCount: 1,
    sessionDir: "/tmp/dsh-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "dsh",
  };
}

function frame(records: unknown[]): Buffer {
  return zstdCompressSync(
    Buffer.from(
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    ),
  );
}

async function settle(ms = 120): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ExternalSessionTracker dsh sessions", () => {
  let eventBus: EventBus;
  let events: BusEvent[];
  let tracker: ExternalSessionTracker;
  let sessionsDir: string;

  beforeEach(async () => {
    eventBus = new EventBus();
    events = [];
    eventBus.subscribe((event) => events.push(event));
    sessionsDir = join(tmpdir(), `dsh-tracker-${randomUUID()}`);
    await mkdir(sessionsDir, { recursive: true });
    const project = createProject();
    tracker = new ExternalSessionTracker({
      eventBus,
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        getAllProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
        getProjectBySessionDirSuffix: vi.fn(async () => project),
      } as never,
      decayMs: 300,
      processValidationMs: 60,
      externalProcessProbe: async () => false,
      getSessionSummary: vi.fn(
        async (sessionId: string): Promise<SessionSummary> => ({
          id: sessionId,
          projectId,
          title: "dsh session",
          fullTitle: "dsh session",
          createdAt: "2026-10-23T00:00:00.000Z",
          updatedAt: "2026-10-23T00:00:01.000Z",
          messageCount: 1,
          ownership: { owner: "none" },
          provider: "dsh",
        }),
      ),
    });
  });

  afterEach(async () => {
    tracker?.dispose();
    vi.restoreAllMocks();
    await rm(sessionsDir, { recursive: true, force: true });
  });

  async function writeSession(sessionId: string, records: unknown[]) {
    const relativePath = join(
      "--tmp-dsh-project--",
      sessionId,
      "session.v4.jsonl.zstd",
    );
    const filePath = join(sessionsDir, relativePath);
    await mkdir(join(sessionsDir, "--tmp-dsh-project--", sessionId), {
      recursive: true,
    });
    await writeFile(
      filePath,
      Buffer.concat([
        frame([
          {
            type: "session",
            version: 4,
            id: sessionId,
            createdAt: 1,
            cwd: PROJECT_PATH,
          },
        ]),
        frame(records),
      ]),
    );
    return { filePath, relativePath };
  }

  function emitFileChange(file: { filePath: string; relativePath: string }) {
    eventBus.emit({
      type: "file-change",
      provider: "dsh",
      path: file.filePath,
      relativePath: file.relativePath,
      changeType: "modify",
      timestamp: "2026-10-23T00:00:02.000Z",
      fileType: "session",
    });
  }

  const prompt = {
    type: "user/message",
    seq: 1,
    time: 2,
    data: {
      id: "u1",
      content: [{ type: "text", text: "go" }],
      source: { kind: "user" },
    },
  };

  const statusEvents = (sessionId: string) =>
    events.filter(
      (event) =>
        event.type === "session-status-changed" &&
        event.sessionId === sessionId,
    );

  it("marks an open turn running, then waiting on an approval, then idle", async () => {
    const file = await writeSession("session-live", [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      prompt,
    ]);
    emitFileChange(file);
    await settle();
    expect(tracker.isExternal("session-live")).toBe(true);
    expect(tracker.getExternalActivity("session-live")).toBe("in-turn");

    await appendFile(
      file.filePath,
      frame([
        {
          type: "approval/asked",
          seq: 2,
          data: { id: "ap", toolName: "bash" },
        },
      ]),
    );
    emitFileChange(file);
    await settle();
    expect(tracker.getExternalActivity("session-live")).toBe("waiting-input");
    expect(statusEvents("session-live").at(-1)).toMatchObject({
      ownership: { owner: "external" },
      activity: "waiting-input",
    });

    await appendFile(
      file.filePath,
      frame([
        {
          type: "approval/decided",
          seq: 3,
          data: { id: "ap", outcome: "allowed-once" },
        },
        {
          type: "turn/end",
          seq: 4,
          data: { turn: 1, reason: { kind: "completed" } },
        },
      ]),
    );
    emitFileChange(file);
    await settle();
    expect(tracker.isExternal("session-live")).toBe(false);
  });

  it("leaves a settled session unowned", async () => {
    const file = await writeSession("session-idle", [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      prompt,
      {
        type: "turn/end",
        seq: 2,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ]);
    emitFileChange(file);
    await settle();
    expect(tracker.isExternal("session-idle")).toBe(false);
  });
});
