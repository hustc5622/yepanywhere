import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { SessionIndexService } from "../../src/indexes/index.js";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createProcessesRoutes } from "../../src/routes/processes.js";
import type { RuntimeController } from "../../src/runtime/types.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type {
  ProcessInfo,
  Project,
  SessionSummary,
} from "../../src/supervisor/types.js";

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.sessions",
    activeOwnedCount: 1,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "codex",
  };
}

function createProcessInfo(): ProcessInfo {
  return {
    id: "proc-1",
    sessionId: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    projectPath: "/tmp/project",
    projectName: "project",
    sessionTitle: null,
    state: "in-turn",
    startedAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    queueDepth: 0,
    provider: "codex",
  };
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Fix the agents page titles",
    fullTitle: "Fix the agents page titles",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 1,
    ownership: { owner: "self", processId: "proc-1" },
    provider: "codex",
  };
}

describe("Processes Routes", () => {
  it("preserves the OpenCode reasoning preference after a live model switch", async () => {
    const setModel = vi.fn(async () => ({ success: true }));
    const routes = createProcessesRoutes({
      runtimeController: {
        getProcess: vi.fn(async () => ({
          provider: "opencode",
          reasoningEffort: "default",
          requestedReasoningEffort: "max",
        })),
        setModel,
      } as unknown as RuntimeController,
      supervisor: {} as Supervisor,
      scanner: {} as ProjectScanner,
      readerFactory: vi.fn(),
    });

    const response = await routes.request("/proc-1/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "ohmyrouter/deepseek-v4-pro" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      model: "ohmyrouter/deepseek-v4-pro",
      reasoningEffort: "max",
    });
    expect(setModel).toHaveBeenCalledWith(
      "proc-1",
      "ohmyrouter/deepseek-v4-pro",
    );
  });

  it("falls back to the live summary title when the index lookup misses", async () => {
    const project = createProject();
    const process = createProcessInfo();
    const summary = createSummary();

    const getSessionSummary = vi.fn(async () => summary);
    const getSessionTitle = vi.fn(async () => null);

    const routes = createProcessesRoutes({
      supervisor: {
        getProcessInfoList: vi.fn(() => [process]),
        getRecentlyTerminatedProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary,
          }) as unknown as ISessionReader,
      ),
      sessionIndexService: {
        getSessionTitle,
      } as unknown as SessionIndexService,
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
      } as unknown as SessionMetadataService,
    });

    const response = await routes.request("/?includeTerminated=true");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.processes).toHaveLength(1);
    expect(json.processes[0]?.sessionTitle).toBe("Fix the agents page titles");
    expect(json.terminatedProcesses).toEqual([]);

    expect(getSessionTitle).toHaveBeenCalledWith(
      "/tmp/project/.sessions",
      "proj-1",
      "sess-1",
      expect.anything(),
    );
    expect(getSessionSummary).toHaveBeenCalledWith("sess-1", "proj-1");
  });

  it("uses the process provider session source for mixed-provider projects", async () => {
    const project = {
      ...createProject(),
      provider: "claude",
      sessionDir: "/tmp/project/.claude-sessions",
    } satisfies Project;
    const process = createProcessInfo();
    const summary = createSummary();

    const claudeReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as ISessionReader;
    const getSessionTitle = vi.fn(async () => summary.title);

    const routes = createProcessesRoutes({
      supervisor: {
        getProcessInfoList: vi.fn(() => [process]),
        getRecentlyTerminatedProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => claudeReader),
      processSessionSourceFactory: vi.fn(() => ({
        reader: codexReader,
        sessionDir: "/tmp/codex-sessions",
      })),
      sessionIndexService: {
        getSessionTitle,
      } as unknown as SessionIndexService,
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.processes).toHaveLength(1);
    expect(json.processes[0]?.sessionTitle).toBe("Fix the agents page titles");

    expect(vi.mocked(codexReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      "proj-1",
    );
    expect(getSessionTitle).toHaveBeenCalledWith(
      "/tmp/codex-sessions",
      "proj-1",
      "sess-1",
      codexReader,
    );
    expect(vi.mocked(claudeReader.getSessionSummary)).not.toHaveBeenCalled();
  });

  it("prefers persisted session provider over stale process provider for display", async () => {
    const project = {
      ...createProject(),
      provider: "claude",
      sessionDir: "/tmp/project/.claude-sessions",
    } satisfies Project;
    const process = {
      ...createProcessInfo(),
      provider: "claude",
    } satisfies ProcessInfo;
    const summary = createSummary();

    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as ISessionReader;

    const routes = createProcessesRoutes({
      supervisor: {
        getProcessInfoList: vi.fn(() => [process]),
        getRecentlyTerminatedProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      processSessionSourceFactory: vi.fn(() => ({
        reader: codexReader,
        sessionDir: "/tmp/codex-sessions",
      })),
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({ provider: "codex" })),
      } as unknown as SessionMetadataService,
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.processes).toHaveLength(1);
    expect(json.processes[0]?.sessionTitle).toBe("Fix the agents page titles");
    expect(json.processes[0]?.provider).toBe("codex");
  });
});
