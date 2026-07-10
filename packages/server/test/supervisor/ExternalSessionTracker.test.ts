import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import { type BusEvent, EventBus } from "../../src/watcher/EventBus.js";

const projectId = Buffer.from("/tmp/project").toString(
  "base64url",
) as UrlProjectId;

function createProject(): Project {
  return {
    id: projectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/claude/projects/-tmp-project",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createSummary(sessionId: string): SessionSummary {
  return {
    id: sessionId,
    projectId,
    title: "Test session",
    fullTitle: "Test session",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "claude",
  };
}

function createFileChange(sessionId: string): BusEvent {
  return {
    type: "file-change",
    provider: "claude",
    path: `/tmp/claude/projects/-tmp-project/${sessionId}.jsonl`,
    relativePath: `projects/-tmp-project/${sessionId}.jsonl`,
    changeType: "modify",
    timestamp: "2026-01-01T00:00:02.000Z",
    fileType: "session",
  };
}

async function flushTrackerWork(): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(300);
  await Promise.resolve();
}

describe("ExternalSessionTracker", () => {
  let eventBus: EventBus;
  let events: BusEvent[];
  let tracker: ExternalSessionTracker;
  let tempDirs: string[];
  const project = createProject();

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    events = [];
    tempDirs = [];
    eventBus.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    tracker?.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  function createTracker(
    externalProcessProbe: () => Promise<boolean | null>,
    processValidationMs = 100,
  ): ExternalSessionTracker {
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
      decayMs: 10000,
      processValidationMs,
      externalProcessProbe,
      getSessionSummary: vi.fn(async (sessionId) => createSummary(sessionId)),
    });
  }

  it("tracks top-level sessions in hostname-scoped Claude project dirs", async () => {
    const externalProcessProbe = vi.fn(async () => true);
    const getProjectBySessionDirSuffix = vi.fn(async () => project);
    tracker = new ExternalSessionTracker({
      eventBus,
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        getAllProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
        getProjectBySessionDirSuffix,
      } as never,
      decayMs: 10000,
      processValidationMs: 0,
      externalProcessProbe,
      getSessionSummary: vi.fn(async (sessionId) => createSummary(sessionId)),
    });

    eventBus.emit({
      ...createFileChange("sess-hosted"),
      path: "/tmp/claude/projects/host/-tmp-project/sess-hosted.jsonl",
      relativePath: "projects/host/-tmp-project/sess-hosted.jsonl",
    });
    await flushTrackerWork();

    expect(externalProcessProbe).toHaveBeenCalledTimes(1);
    expect(getProjectBySessionDirSuffix).toHaveBeenCalledWith(
      "host/-tmp-project",
    );
    expect(tracker.isExternal("sess-hosted")).toBe(true);
  });

  it("ignores nested workflow session files under subagents", async () => {
    const externalProcessProbe = vi.fn(async () => true);
    const getProjectBySessionDirSuffix = vi.fn(async () => project);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    tracker = new ExternalSessionTracker({
      eventBus,
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        getAllProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
        getProjectBySessionDirSuffix,
      } as never,
      decayMs: 10000,
      processValidationMs: 100,
      externalProcessProbe,
      getSessionSummary: vi.fn(async (sessionId) => createSummary(sessionId)),
    });

    eventBus.emit({
      ...createFileChange("workflow-session"),
      path: "/tmp/claude/projects/-tmp-project/subagents/workflows/wf_123/workflow-session.jsonl",
      relativePath:
        "projects/-tmp-project/subagents/workflows/wf_123/workflow-session.jsonl",
    });
    await flushTrackerWork();

    expect(externalProcessProbe).not.toHaveBeenCalled();
    expect(getProjectBySessionDirSuffix).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === "session-created" &&
          event.session.id === "workflow-session",
      ),
    ).toBe(false);
  });

  it("ignores Codex rollout files that belong to collaboration subagents", async () => {
    const externalProcessProbe = vi.fn(async () => true);
    const getSessionSummary = vi.fn(async (sessionId) =>
      createSummary(sessionId),
    );
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
      externalProcessProbe,
      getSessionSummary,
    });

    const dir = await mkdtemp(join(tmpdir(), "yep-codex-subagent-"));
    tempDirs.push(dir);
    const sessionId = "019f4af6-57d5-73e1-96d0-b3ee3a8eceda";
    const fileName = `rollout-2026-07-10T15-38-06-${sessionId}.jsonl`;
    const filePath = join(dir, fileName);
    await writeFile(
      filePath,
      `${JSON.stringify({
        timestamp: "2026-07-10T07:38:06.222Z",
        type: "session_meta",
        payload: {
          session_id: "019f4af5-b6a3-7a23-8305-f583dd9097a3",
          id: sessionId,
          parent_thread_id: "019f4af5-b6a3-7a23-8305-f583dd9097a3",
          timestamp: "2026-07-10T07:38:06.222Z",
          cwd: "/tmp/project",
          thread_source: "subagent",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "019f4af5-b6a3-7a23-8305-f583dd9097a3",
                depth: 1,
                agent_path: "/root/review_codex",
              },
            },
          },
        },
      })}\n`,
    );

    eventBus.emit({
      type: "file-change",
      provider: "codex",
      path: filePath,
      relativePath: `2026/07/10/${fileName}`,
      changeType: "create",
      timestamp: "2026-07-10T07:38:06.222Z",
      fileType: "session",
    });
    await flushTrackerWork();

    expect(externalProcessProbe).not.toHaveBeenCalled();
    expect(getSessionSummary).not.toHaveBeenCalled();
    expect(tracker.isExternal(sessionId)).toBe(false);
    expect(
      events.some(
        (event) =>
          (event.type === "session-created" &&
            event.session.id === sessionId) ||
          (event.type === "session-status-changed" &&
            event.sessionId === sessionId),
      ),
    ).toBe(false);
  });

  it("creates unowned sessions without external ownership when no provider process is active", async () => {
    tracker = createTracker(vi.fn(async () => false));

    eventBus.emit(createFileChange("sess-inactive"));
    await flushTrackerWork();

    expect(tracker.isExternal("sess-inactive")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "session-status-changed" &&
          event.ownership.owner === "external",
      ),
    ).toBe(false);

    const created = events.find(
      (event) =>
        event.type === "session-created" &&
        event.session.id === "sess-inactive",
    );
    expect(created?.type).toBe("session-created");
    if (created?.type === "session-created") {
      expect(created.session.ownership).toEqual({ owner: "none" });
    }
  });

  it("marks unowned sessions external when a provider process is active", async () => {
    tracker = createTracker(vi.fn(async () => true));

    eventBus.emit(createFileChange("sess-active"));
    await flushTrackerWork();

    expect(tracker.isExternal("sess-active")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "session-status-changed" &&
          event.sessionId === "sess-active" &&
          event.ownership.owner === "external",
      ),
    ).toBe(true);
  });

  it("does not misclassify sessions owned by a standalone runtime", async () => {
    const externalProcessProbe = vi.fn(async () => true);
    const getRuntimeProcess = vi.fn(async () => ({ projectId }));
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
      externalProcessProbe,
      getRuntimeProcess,
      getSessionSummary: vi.fn(async (sessionId) => createSummary(sessionId)),
    });

    eventBus.emit(createFileChange("sess-runtime-owned"));
    await flushTrackerWork();

    expect(getRuntimeProcess).toHaveBeenCalledWith("sess-runtime-owned");
    expect(externalProcessProbe).not.toHaveBeenCalled();
    expect(tracker.isExternal("sess-runtime-owned")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "session-status-changed" &&
          event.sessionId === "sess-runtime-owned" &&
          event.ownership.owner === "external",
      ),
    ).toBe(false);
  });

  it("clears external ownership when process validation sees the provider process exit", async () => {
    const externalProcessProbe = vi
      .fn<[], Promise<boolean | null>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    tracker = createTracker(externalProcessProbe, 500);

    eventBus.emit(createFileChange("sess-exited"));
    await flushTrackerWork();
    expect(tracker.isExternal("sess-exited")).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    expect(tracker.isExternal("sess-exited")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "session-status-changed" &&
          event.sessionId === "sess-exited" &&
          event.ownership.owner === "none",
      ),
    ).toBe(true);
  });
});
