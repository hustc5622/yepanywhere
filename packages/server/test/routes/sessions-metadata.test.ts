import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { SessionArchiveService } from "../../src/archive/index.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { OpenCodeSessionReader } from "../../src/sessions/opencode-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

interface TestSqliteStatement {
  run(...params: unknown[]): void;
}

interface TestSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): TestSqliteStatement;
  close(): void;
}

interface TestSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => TestSqliteDatabase;
}

async function loadSqliteModule(): Promise<TestSqliteModule | null> {
  const specifier: string = "node:sqlite";
  return import(specifier)
    .then((mod) => {
      const maybeModule = mod as {
        DatabaseSync?: TestSqliteModule["DatabaseSync"];
      };
      return maybeModule.DatabaseSync
        ? { DatabaseSync: maybeModule.DatabaseSync }
        : null;
    })
    .catch(() => null);
}

async function createOpenCodeDb(
  dbPath: string,
  projectPath: string,
  sessionId: string,
): Promise<boolean> {
  const sqlite = await loadSqliteModule();
  if (!sqlite) return false;

  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        title text NOT NULL,
        version text NOT NULL,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        revert text,
        permission text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_compacting integer,
        time_archived integer,
        workspace_id text,
        path text,
        agent text,
        model text,
        cost real DEFAULT 0 NOT NULL,
        tokens_input integer DEFAULT 0 NOT NULL,
        tokens_output integer DEFAULT 0 NOT NULL,
        tokens_reasoning integer DEFAULT 0 NOT NULL,
        tokens_cache_read integer DEFAULT 0 NOT NULL,
        tokens_cache_write integer DEFAULT 0 NOT NULL,
        metadata text
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

    const createdAt = Date.UTC(2026, 6, 7, 1, 34, 46);
    const updatedAt = Date.UTC(2026, 6, 7, 1, 35, 23);
    db.prepare(
      `
        INSERT INTO session (
          id,
          project_id,
          slug,
          directory,
          title,
          version,
          time_created,
          time_updated
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      sessionId,
      "global",
      "test",
      projectPath,
      "Yep Anywhere Session",
      "1",
      createdAt,
      updatedAt,
    );
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "msg_user",
      sessionId,
      createdAt + 10,
      createdAt + 10,
      JSON.stringify({ role: "user", time: { created: createdAt + 10 } }),
    );
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "prt_user",
      "msg_user",
      sessionId,
      createdAt + 20,
      createdAt + 20,
      JSON.stringify({ type: "text", text: "OpenCode archive target" }),
    );
  } finally {
    db.close();
  }

  return true;
}

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.claude-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Codex metadata title",
    fullTitle: "Codex metadata title",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 2,
    ownership: { owner: "none" },
    provider: "codex",
    model: "gpt-5-codex",
  };
}

describe("Sessions metadata route", () => {
  it("loads the durable session when a URL still contains its temporary ID", async () => {
    const testDir = join(tmpdir(), `session-alias-route-${randomUUID()}`);
    const project = createProject();
    const metadata = new SessionMetadataService({ dataDir: testDir });
    const getSession = vi.fn(async (sessionId: string) =>
      sessionId === "durable-id"
        ? {
            summary: {
              ...createSummary(),
              id: "durable-id",
              provider: "claude" as const,
              model: "claude-sonnet-5",
            },
            data: {
              provider: "claude" as const,
              session: { messages: [] },
            },
            messagesAlreadyProjected: true,
          }
        : null,
    );

    try {
      await metadata.initialize();
      await metadata.remapSessionId("temporary-id", "durable-id");

      const routes = createSessionsRoutes({
        supervisor: {} as SessionsDeps["supervisor"],
        runtimeController: {
          getProcessSnapshotForSession: vi.fn(async () => null),
          wasEverOwned: vi.fn(async () => true),
        } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
        scanner: {
          getOrCreateProject: vi.fn(async () => project),
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(
          () => ({ getSession }) as unknown as ISessionReader,
        ),
        sessionMetadataService: metadata,
      });

      const response = await routes.request(
        `/projects/${project.id}/sessions/temporary-id`,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        session: { id: "durable-id", model: "claude-sonnet-5" },
        messages: [],
      });
      expect(getSession).toHaveBeenCalledWith(
        "durable-id",
        project.id,
        undefined,
        expect.any(Object),
      );
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("resolves metadata across providers for mixed-provider projects", async () => {
    const project = createProject();
    const summary = createSummary();
    const claudeReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as ISessionReader;

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => claudeReader),
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/metadata`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.session).toMatchObject({
      id: "sess-1",
      title: "Codex metadata title",
      provider: "codex",
      model: "gpt-5-codex",
    });
    expect(vi.mocked(claudeReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      project.id,
    );
    expect(vi.mocked(codexReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      project.id,
    );
  });

  it("keeps persisted provider when metadata refresh misses the session summary", async () => {
    const project = createProject();

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-1",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date("2026-03-10T09:47:00.000Z") },
          provider: "claude",
          supportsDynamicCommands: false,
        })),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        getProvider: vi.fn(() => "codex"),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/metadata`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.session.provider).toBe("codex");
    expect(json.runtime).toMatchObject({
      ownership: { owner: "self", processId: "proc-1" },
      activity: "idle",
      hasResidentWorker: true,
      canArchive: true,
    });
    expect(json.session.runtime).toMatchObject({
      activity: "idle",
      hasResidentWorker: true,
      canArchive: true,
    });
  });

  it("overlays bridge turn health on metadata and persisted detail responses", async () => {
    const project = createProject();
    const persistedSummary: SessionSummary = {
      ...createSummary(),
      provider: "opencode",
      parentSessionId: "ses_parent",
      lastTurnStatus: "failed",
      lastErrorMessage: "stale persisted error",
    };
    const bridgeSummary: SessionSummary = {
      ...persistedSummary,
      ownership: { owner: "external" },
      activity: "in-turn",
      source: "opencode-bridge",
      lastTurnStatus: undefined,
      lastErrorMessage: undefined,
      retryStatus: {
        attempt: 4,
        message: "provider rate limited",
        next: 1_789_000_000_000,
      },
    };
    const reader = {
      getSessionSummary: vi.fn(async () => persistedSummary),
      getSession: vi.fn(async () => ({
        summary: persistedSummary,
        data: {
          provider: "opencode" as const,
          session: { messages: [] },
        },
        messagesAlreadyProjected: true,
      })),
    } as unknown as ISessionReader;
    const bridgeView = {
      session: bridgeSummary,
      projectName: project.name,
      activity: "in-turn" as const,
    };
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      runtimeController: {
        getProcessSnapshotForSession: vi.fn(async () => null),
        wasEverOwned: vi.fn(async () => false),
      } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
      opencodeBridgeService: {
        getSessionView: vi.fn(async () => bridgeView),
        isSessionActive: vi.fn(async () => true),
        getPendingInputRequest: vi.fn(async () => null),
      } as unknown as NonNullable<SessionsDeps["opencodeBridgeService"]>,
    });

    for (const suffix of ["/metadata", ""] as const) {
      const response = await routes.request(
        `/projects/${project.id}/sessions/${persistedSummary.id}${suffix}`,
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.session).toMatchObject({
        parentSessionId: "ses_parent",
        retryStatus: {
          attempt: 4,
          message: "provider rate limited",
          next: 1_789_000_000_000,
        },
      });
      expect(json.session.lastTurnStatus).toBeUndefined();
      expect(json.session.lastErrorMessage).toBeUndefined();
    }
  });

  it("prefers persisted provider over conflicting client resume provider", async () => {
    const project = createProject();
    const resumeSession = vi.fn(async () => ({
      id: "proc-1",
      sessionId: "sess-1",
      permissionMode: "default",
      modeVersion: 0,
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "continue",
          provider: "claude",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({ providerName: "codex" }),
    );
  });

  it("preserves persisted provider and model when queueing a restartable message", async () => {
    const project = createProject();
    const queueMessageToSession = vi.fn(async () => ({
      success: true as const,
      restarted: true,
      process: { id: "proc-2" },
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          projectPath: project.path,
          isTerminated: false,
          provider: "claude",
          model: "gpt-5.4",
          resolvedModel: "gpt-5.4",
          requestedReasoningEffort: "ultra",
          reasoningEffort: "ultra",
          executor: undefined,
        })),
        queueMessageToSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "continue",
        thinking: "max",
      }),
    });

    expect(response.status).toBe(200);
    expect(queueMessageToSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({
        model: "gpt-5.4",
        providerName: "codex",
        reasoningEffort: "ultra",
      }),
    );
  });

  it("physically archives and restores session files through metadata updates", async () => {
    const testDir = join(tmpdir(), `yep-route-archive-test-${randomUUID()}`);
    const dataDir = join(testDir, "data");
    const sessionDir = join(testDir, "claude", "projects", "-tmp-project");

    try {
      await mkdir(sessionDir, { recursive: true });
      const project = { ...createProject(), sessionDir, provider: "claude" };
      const sessionId = "sess-1";
      const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
      await writeFile(sessionPath, '{"type":"assistant","message":{}}\n');

      const summary = {
        ...createSummary(),
        provider: "claude" as const,
        title: "Archive target",
        fullTitle: "Archive target",
      };
      const reader = {
        getSessionSummary: vi.fn(async () => summary),
        getSessionFilePath: vi.fn(async () => sessionPath),
      } as unknown as ISessionReader;
      const archiveService = new SessionArchiveService({ dataDir });
      await archiveService.initialize();
      const updateMetadata = vi.fn(async () => undefined);
      const invalidateCache = vi.fn();

      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => null),
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          listProjects: vi.fn(async () => [project]),
          invalidateCache,
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(() => reader),
        sessionMetadataService: {
          getProvider: vi.fn(() => undefined),
          updateMetadata,
        } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
        sessionArchiveService: archiveService,
      });

      const archiveResponse = await routes.request(
        `/sessions/${sessionId}/metadata`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: true }),
        },
      );

      expect(archiveResponse.status).toBe(200);
      const archiveJson = await archiveResponse.json();
      expect(archiveJson.archive).toMatchObject({
        physical: true,
        action: "archive",
      });
      await expect(stat(sessionPath)).rejects.toThrow();
      expect(archiveService.getArchivedSession(sessionId)).toMatchObject({
        sessionId,
        provider: "claude",
        title: "Archive target",
      });
      const archiveListResponse = await routes.request("/archive/sessions");
      expect(archiveListResponse.status).toBe(200);
      const archiveListJson = await archiveListResponse.json();
      expect(archiveListJson.sessions).toHaveLength(1);

      const archiveDetailResponse = await routes.request(
        `/archive/sessions/${sessionId}`,
      );
      expect(archiveDetailResponse.status).toBe(200);
      const archiveDetailJson = await archiveDetailResponse.json();
      expect(archiveDetailJson.session).toMatchObject({
        sessionId,
        title: "Archive target",
      });
      expect(updateMetadata).toHaveBeenCalledWith(sessionId, {
        title: undefined,
        archived: true,
        starred: undefined,
      });
      expect(invalidateCache).toHaveBeenCalledTimes(1);

      const restoreResponse = await routes.request(
        `/sessions/${sessionId}/metadata`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: false }),
        },
      );

      expect(restoreResponse.status).toBe(200);
      expect(await readFile(sessionPath, "utf-8")).toContain("assistant");
      expect(archiveService.getArchivedSession(sessionId)).toBeUndefined();
      expect(updateMetadata).toHaveBeenLastCalledWith(sessionId, {
        title: undefined,
        archived: false,
        starred: undefined,
      });
      expect(invalidateCache).toHaveBeenCalledTimes(2);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("archives and restores OpenCode sqlite sessions through metadata updates", async () => {
    const testDir = join(
      tmpdir(),
      `yep-route-opencode-archive-${randomUUID()}`,
    );
    const dataDir = join(testDir, "data");
    const projectPath = join(testDir, "project");
    const dbPath = join(testDir, "opencode.db");
    const sessionId = "ses_opencode_archive";

    try {
      await mkdir(projectPath, { recursive: true });
      const sqliteAvailable = await createOpenCodeDb(
        dbPath,
        projectPath,
        sessionId,
      );
      if (!sqliteAvailable) return;

      const project: Project = {
        ...createProject(),
        id: encodeProjectId(projectPath),
        path: projectPath,
        name: "project",
        sessionDir: dbPath,
        provider: "opencode",
      };
      const archiveService = new SessionArchiveService({ dataDir });
      await archiveService.initialize();
      const updateMetadata = vi.fn(async () => undefined);
      const invalidateCache = vi.fn();
      const invalidateOpenCodeCache = vi.fn();
      const makeReader = () =>
        new OpenCodeSessionReader({ dbPath, projectPath });

      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => null),
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          listProjects: vi.fn(async () => [project]),
          invalidateCache,
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(() => makeReader()),
        opencodeDbPath: dbPath,
        opencodeReaderFactory: vi.fn(() => makeReader()),
        opencodeScanner: {
          invalidateCache: invalidateOpenCodeCache,
        } as unknown as SessionsDeps["opencodeScanner"],
        sessionMetadataService: {
          getProvider: vi.fn(() => "opencode"),
          updateMetadata,
        } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
        sessionArchiveService: archiveService,
      });

      expect(
        await makeReader().getSessionSummary(sessionId, project.id),
      ).not.toBeNull();

      const archiveResponse = await routes.request(
        `/sessions/${sessionId}/metadata`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: true }),
        },
      );

      expect(archiveResponse.status).toBe(200);
      const archiveJson = await archiveResponse.json();
      expect(archiveJson.archive).toMatchObject({
        physical: true,
        action: "archive",
        record: {
          sessionId,
          provider: "opencode",
          storagePath: dbPath,
        },
      });
      expect(archiveService.getArchivedSession(sessionId)).toMatchObject({
        sessionId,
        provider: "opencode",
        storagePath: dbPath,
        files: [],
      });
      expect(await makeReader().getSessionSummary(sessionId, project.id)).toBe(
        null,
      );
      expect(invalidateCache).toHaveBeenCalledTimes(1);
      expect(invalidateOpenCodeCache).toHaveBeenCalledTimes(1);

      const restoreResponse = await routes.request(
        `/sessions/${sessionId}/metadata`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: false }),
        },
      );

      expect(restoreResponse.status).toBe(200);
      expect(
        await makeReader().getSessionSummary(sessionId, project.id),
      ).toMatchObject({
        id: sessionId,
        provider: "opencode",
        title: "OpenCode archive target",
      });
      expect(archiveService.getArchivedSession(sessionId)).toBeUndefined();
      expect(invalidateCache).toHaveBeenCalledTimes(2);
      expect(invalidateOpenCodeCache).toHaveBeenCalledTimes(2);
      expect(updateMetadata).toHaveBeenLastCalledWith(sessionId, {
        title: undefined,
        archived: false,
        starred: undefined,
      });
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("archives an idle owned session after releasing the resident worker", async () => {
    const testDir = join(tmpdir(), `yep-route-idle-archive-${randomUUID()}`);
    const dataDir = join(testDir, "data");
    const sessionDir = join(testDir, "claude", "projects", "-tmp-project");

    try {
      await mkdir(sessionDir, { recursive: true });
      const project = { ...createProject(), sessionDir, provider: "claude" };
      const sessionId = "idle-owned-session";
      const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
      await writeFile(sessionPath, '{"type":"assistant","message":{}}\n');

      const summary = {
        ...createSummary(),
        id: sessionId,
        provider: "claude" as const,
        title: "Idle archive target",
        fullTitle: "Idle archive target",
      };
      const reader = {
        getSessionSummary: vi.fn(async () => summary),
        getSessionFilePath: vi.fn(async () => sessionPath),
      } as unknown as ISessionReader;
      const archiveService = new SessionArchiveService({ dataDir });
      await archiveService.initialize();
      let residentProcess:
        | {
            id: string;
            permissionMode: string;
            modeVersion: number;
            state: { type: "idle"; since: Date };
          }
        | undefined = {
        id: "proc-idle",
        permissionMode: "default",
        modeVersion: 0,
        state: { type: "idle", since: new Date("2026-03-10T09:47:00.000Z") },
      };
      const abortProcess = vi.fn(async () => {
        residentProcess = undefined;
        return true;
      });

      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => residentProcess),
          abortProcess,
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          listProjects: vi.fn(async () => [project]),
          invalidateCache: vi.fn(),
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(() => reader),
        sessionMetadataService: {
          getProvider: vi.fn(() => undefined),
          updateMetadata: vi.fn(async () => undefined),
        } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
        sessionArchiveService: archiveService,
      });

      const response = await routes.request(`/sessions/${sessionId}/metadata`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });

      expect(response.status).toBe(200);
      expect(abortProcess).toHaveBeenCalledWith("proc-idle");
      expect(residentProcess).toBeUndefined();
      await expect(stat(sessionPath)).rejects.toThrow();
      expect(archiveService.getArchivedSession(sessionId)).toMatchObject({
        sessionId,
        provider: "claude",
      });
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["in-turn", "agent_in_turn"],
    ["waiting-input", "waiting_input"],
  ] as const)(
    "rejects archiving a %s owned session with a structured reason",
    async (stateType, expectedCode) => {
      const updateMetadata = vi.fn(async () => undefined);
      const abortProcess = vi.fn(async () => true);
      const processState =
        stateType === "waiting-input"
          ? {
              type: "waiting-input" as const,
              request: {
                id: "req-1",
                sessionId: "sess-1",
                type: "tool-approval" as const,
                prompt: "Approve?",
                timestamp: "2026-03-10T09:47:00.000Z",
              },
            }
          : { type: "in-turn" as const };

      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => ({
            id: "proc-busy",
            permissionMode: "default",
            modeVersion: 0,
            state: processState,
          })),
          abortProcess,
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          listProjects: vi.fn(async () => []),
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(),
        sessionMetadataService: {
          updateMetadata,
        } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
        sessionArchiveService: {
          getSession: vi.fn(),
        } as unknown as SessionsDeps["sessionArchiveService"],
      });

      const response = await routes.request("/sessions/sess-1/metadata", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });

      expect(response.status).toBe(409);
      const json = await response.json();
      expect(json).toMatchObject({
        code: expectedCode,
        runtime: {
          canArchive: false,
          isBusy: true,
          activity: stateType,
        },
      });
      expect(json.error).toEqual(expect.any(String));
      expect(abortProcess).not.toHaveBeenCalled();
      expect(updateMetadata).not.toHaveBeenCalled();
    },
  );
});
