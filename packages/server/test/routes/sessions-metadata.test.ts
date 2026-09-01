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
import type { RuntimeProcessSnapshot } from "../../src/runtime/types.js";
import { ManualSessionTitleError } from "../../src/services/SessionTitleService.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

interface TestSqliteStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
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
  // Vitest routes a bare dynamic `import("node:sqlite")` through Vite's
  // resolver, which fails to resolve it and silently disables every test that
  // depends on a real database. `process.getBuiltinModule` bypasses the
  // resolver; the dynamic import stays as a fallback for plain Node.
  const getBuiltinModule = (
    process as unknown as { getBuiltinModule?: (name: string) => unknown }
  ).getBuiltinModule;
  const builtin = getBuiltinModule?.call(process, specifier) as
    | { DatabaseSync?: TestSqliteModule["DatabaseSync"] }
    | undefined;
  if (builtin?.DatabaseSync) return { DatabaseSync: builtin.DatabaseSync };
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

async function readArchivedAt(
  dbPath: string,
  sessionId: string,
): Promise<unknown> {
  const sqlite = await loadSqliteModule();
  if (!sqlite) return undefined;
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT time_archived FROM session WHERE id = ?")
      .get(sessionId)?.time_archived;
  } finally {
    db.close();
  }
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
  it("generates a title only through the explicit project session endpoint", async () => {
    const projectId = encodeProjectId("/tmp/project");
    const generateTitleManually = vi.fn(async () => "Generated title");
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      scanner: {} as SessionsDeps["scanner"],
      readerFactory: vi.fn() as unknown as SessionsDeps["readerFactory"],
      sessionTitleService: { generateTitleManually },
    });

    expect(generateTitleManually).not.toHaveBeenCalled();
    const response = await routes.request(
      `/projects/${projectId}/sessions/session-1/title`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "Generated title" });
    expect(generateTitleManually).toHaveBeenCalledWith("session-1", projectId);
  });

  it("returns a useful status when manual title generation cannot run", async () => {
    const projectId = encodeProjectId("/tmp/project");
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      scanner: {} as SessionsDeps["scanner"],
      readerFactory: vi.fn() as unknown as SessionsDeps["readerFactory"],
      sessionTitleService: {
        generateTitleManually: vi.fn(async () => {
          throw new ManualSessionTitleError(
            "insufficient_context",
            "The session needs both user input and AI output before a title can be generated",
          );
        }),
      },
    });

    const response = await routes.request(
      `/projects/${projectId}/sessions/session-1/title`,
      { method: "POST" },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error:
        "The session needs both user input and AI output before a title can be generated",
      code: "insufficient_context",
    });
  });

  it("accepts the pin API while persisting the existing metadata bit", async () => {
    const updateMetadata = vi.fn(async () => undefined);
    const eventBus = new EventBus();
    const emit = vi.spyOn(eventBus, "emit");
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      scanner: {} as SessionsDeps["scanner"],
      readerFactory: vi.fn() as unknown as SessionsDeps["readerFactory"],
      sessionMetadataService: {
        updateMetadata,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      eventBus,
    });

    const response = await routes.request("/sessions/session-1/metadata", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });

    expect(response.status).toBe(200);
    expect(updateMetadata).toHaveBeenCalledWith("session-1", {
      title: undefined,
      archived: undefined,
      starred: true,
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session-metadata-changed",
        sessionId: "session-1",
        pinned: true,
        starred: true,
      }),
    );
  });

  it("returns live usage and retry status before the session file exists", async () => {
    const project = createProject();
    const process = {
      id: "proc-codex-live",
      sessionId: "sess-codex-live",
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      sessionTitle: null,
      state: "in-turn",
      startedAt: "2026-08-14T15:50:09.000Z",
      queueDepth: 0,
      provider: "codex",
      model: "gpt-5.3-codex",
      retryStatus: {
        attempt: 2,
        message: "rate limited",
        next: 1_789_000_000_000,
      },
      permissionMode: "default",
      modeVersion: 0,
      pendingInputRequest: null,
      supportsDynamicModels: false,
      supportsDynamicCommands: false,
      supportsSetModel: false,
      contextWindow: 258_400,
      messageHistory: [
        {
          type: "user",
          uuid: "prompt-1",
          timestamp: "2026-08-14T15:50:09.000Z",
          message: { role: "user", content: "inspect the repository" },
        },
        {
          type: "system",
          subtype: "turn_usage",
          usage: {
            input_tokens: 15_112,
            model_context_window: 258_400,
          },
        },
        {
          type: "system",
          subtype: "turn_usage",
          usage: {
            input_tokens: 167_772,
            output_tokens: 1_024,
            cached_input_tokens: 150_000,
            model_context_window: 258_400,
          },
        },
      ],
    } satisfies RuntimeProcessSnapshot;
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      runtimeController: {
        getProcessSnapshotForSession: vi.fn(async () => process),
        wasEverOwned: vi.fn(async () => true),
      } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSession: vi.fn(async () => null),
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/${process.sessionId}`,
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.session.contextUsage).toMatchObject({
      inputTokens: 167_772,
      outputTokens: 1_024,
      cacheReadTokens: 150_000,
      percentage: 65,
      contextWindow: 258_400,
    });
    expect(json.messages).toHaveLength(1);
    expect(json.messages[0].contextBefore).toMatchObject({
      inputTokens: 167_772,
      percentage: 65,
      contextWindow: 258_400,
    });
    expect(json.session.retryStatus).toEqual(process.retryStatus);

    const metadataResponse = await routes.request(
      `/projects/${project.id}/sessions/${process.sessionId}/metadata`,
    );
    expect(metadataResponse.status).toBe(200);
    expect((await metadataResponse.json()).session.retryStatus).toEqual(
      process.retryStatus,
    );
  });

  it("augments live Edit messages before the session file exists", async () => {
    const project = createProject();
    const process = {
      id: "proc-codex-edit",
      sessionId: "sess-codex-edit",
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      sessionTitle: null,
      state: "in-turn",
      startedAt: "2026-09-01T00:00:00.000Z",
      queueDepth: 0,
      provider: "codex",
      model: "gpt-5.6-sol",
      permissionMode: "default",
      modeVersion: 0,
      pendingInputRequest: null,
      supportsDynamicModels: false,
      supportsDynamicCommands: false,
      supportsSetModel: false,
      messageHistory: [
        {
          type: "assistant",
          uuid: "live-edit-message",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "live-edit-tool",
                name: "Edit",
                input: {
                  file_path: "src/live.ts",
                  changes: [
                    {
                      path: "src/live.ts",
                      kind: "update",
                      diff: "@@ -1 +1 @@\n-before\n+after",
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          type: "user",
          uuid: "live-edit-result",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "live-edit-tool",
                content: "ok",
              },
            ],
          },
        },
      ],
    } satisfies RuntimeProcessSnapshot;
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      runtimeController: {
        getProcessSnapshotForSession: vi.fn(async () => process),
        wasEverOwned: vi.fn(async () => true),
      } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSession: vi.fn(async () => null),
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/${process.sessionId}`,
    );
    const json = await response.json();
    const edit = json.messages
      .flatMap((message: { content?: unknown }) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .find(
        (block: { type?: string; name?: string }) =>
          block.type === "tool_use" && block.name === "Edit",
      );

    expect(response.status).toBe(200);
    expect(edit.input._rawPatch).toContain("-before");
    expect(edit.input._structuredPatch).toHaveLength(1);
    expect(edit.input._diffHtml).toContain('class="line line-deleted"');
  });

  it("persists live and idle permission-mode changes", async () => {
    const testDir = join(tmpdir(), `session-mode-route-${randomUUID()}`);
    const metadata = new SessionMetadataService({ dataDir: testDir });
    const setPermissionMode = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        permissionMode: "plan",
        modeVersion: 4,
      })
      .mockResolvedValueOnce({ ok: false });

    try {
      await metadata.initialize();
      const routes = createSessionsRoutes({
        supervisor: {} as SessionsDeps["supervisor"],
        runtimeController: {
          setPermissionMode,
        } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
        scanner: {} as SessionsDeps["scanner"],
        readerFactory: vi.fn(),
        sessionMetadataService: metadata,
      });

      const liveResponse = await routes.request("/sessions/sess-1/mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "plan" }),
      });
      expect(liveResponse.status).toBe(200);
      await expect(liveResponse.json()).resolves.toEqual({
        permissionMode: "plan",
        modeVersion: 4,
      });
      expect(metadata.getPermissionMode("sess-1")).toBe("plan");

      const idleResponse = await routes.request("/sessions/sess-1/mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "bypassPermissions" }),
      });
      expect(idleResponse.status).toBe(200);
      await expect(idleResponse.json()).resolves.toEqual({
        permissionMode: "bypassPermissions",
        modeVersion: 0,
      });

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();
      expect(reloaded.getPermissionMode("sess-1")).toBe("bypassPermissions");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

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
      await metadata.setPermissionMode("temporary-id", "bypassPermissions");

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
        permissionMode: "bypassPermissions",
        modeVersion: 0,
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

  it("uses catalog metadata without invoking a cold Codex rollout summary scan", async () => {
    const project = createProject();
    const summary = {
      ...createSummary(),
      messageCount: 1,
      contextUsage: {
        inputTokens: 100,
        contextWindow: 200_000,
        percentage: 0.05,
      },
    };
    const claudeGetSummary = vi.fn(async () => null);
    const codexGetSummary = vi.fn(async () => {
      throw new Error("expensive rollout summary must not run");
    });
    const catalogLookup = vi.fn(async () => summary);
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      runtimeController: {
        getProcessSnapshotForSession: vi.fn(async () => null),
      } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: claudeGetSummary,
          }) as unknown as ISessionReader,
      ),
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () =>
          ({
            getSessionSummary: codexGetSummary,
          }) as unknown as CodexSessionReader,
      ),
      codexSessionCatalog: {
        getSessionSummary: catalogLookup,
      } as unknown as NonNullable<SessionsDeps["codexSessionCatalog"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/${summary.id}/metadata`,
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.session).toMatchObject({
      provider: "codex",
      contextUsage: summary.contextUsage,
    });
    expect(json.session).not.toHaveProperty("messageCount");
    expect(catalogLookup).toHaveBeenCalledWith(summary.id, project.path);
    expect(claudeGetSummary).not.toHaveBeenCalled();
    expect(codexGetSummary).not.toHaveBeenCalled();
  });

  it("returns the native Codex edit-fork branch family in metadata", async () => {
    const project = createProject();
    const root = {
      ...createSummary(),
      id: "root-session",
      title: "a",
      fullTitle: "a",
    };
    const child = {
      ...createSummary(),
      id: "child-session",
      title: "b2",
      fullTitle: "b2",
      forkParentSessionId: root.id,
      updatedAt: "2026-09-01T00:01:00.000Z",
    };
    const branchState = {
      sessionId: child.id,
      provider: "codex" as const,
      activeBranchId: "user-d-turn-d",
      selectedBranchId: "user-d-turn-d",
      branches: [
        {
          id: "user-b-turn-b",
          sessionId: root.id,
          parentId: "user-a-turn-a",
          prompt: "b",
          title: "b",
          depth: 2,
          index: 2,
          siblingIndex: 1,
          siblingCount: 2,
          isActive: false,
          provider: "codex" as const,
        },
        {
          id: "user-b2-turn-b2",
          sessionId: child.id,
          parentId: "user-a-turn-a",
          prompt: "b2",
          title: "b2",
          depth: 2,
          index: 4,
          siblingIndex: 2,
          siblingCount: 2,
          isActive: true,
          provider: "codex" as const,
        },
      ],
    };
    const getForkBranchState = vi.fn(async () => branchState);
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      runtimeController: {
        getProcessSnapshotForSession: vi.fn(async () => null),
      } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      codexSessionCatalog: {
        getSessionSummary: vi.fn(async () => child),
        getSnapshot: vi.fn(async () => ({
          sessions: [child, root],
          byProjectPath: new Map([[project.path, [child, root]]]),
          unknownMessageCountIds: new Set([child.id, root.id]),
          createdAt: Date.now(),
        })),
      } as unknown as NonNullable<SessionsDeps["codexSessionCatalog"]>,
      codexAppServerHistoryReader: {
        getForkBranchState,
      } as unknown as NonNullable<SessionsDeps["codexAppServerHistoryReader"]>,
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getMetadata: vi.fn(() => ({
          provider: "codex",
          projectPath: project.path,
          forkParentSessionId: root.id,
          forkTargetMessageId: "user-b-turn-b",
          forkFamilyTitle: "Stable family",
          forkFamilyFullTitle: "Stable family full title",
        })),
        getAllMetadata: vi.fn(() => ({})),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/${child.id}/metadata`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      session: {
        id: child.id,
        title: "Stable family",
        fullTitle: "Stable family full title",
        forkParentSessionId: root.id,
        branchState,
        codexBranchState: branchState,
      },
    });
    expect(getForkBranchState).toHaveBeenCalledWith(
      child.id,
      expect.arrayContaining([
        expect.objectContaining({ id: root.id }),
        expect.objectContaining({
          id: child.id,
          forkParentSessionId: root.id,
          forkTargetMessageId: "user-b-turn-b",
        }),
      ]),
      undefined,
    );
  });

  it("uses the shared summary index for a missing Codex context meter", async () => {
    const project = createProject();
    const summary: SessionSummary = {
      ...createSummary(),
      model: "gpt-5.6-sol",
      contextUsage: {
        inputTokens: 394_295,
        percentage: 52,
        contextWindow: 760_000,
        outputTokens: 700,
        cacheReadTokens: 393_856,
      },
    };
    const codexGetSummary = vi.fn(async () => {
      throw new Error("context status should use the shared summary index");
    });
    const codexReader = {
      getSessionSummary: codexGetSummary,
    } as unknown as CodexSessionReader;
    const getSessionSummaryWithCache = vi.fn(async () => summary);
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      runtimeController: {
        getProcessSnapshotForSession: vi.fn(async () => null),
      } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
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
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(() => codexReader),
      sessionIndexService: {
        getSessionSummaryWithCache,
      } as unknown as NonNullable<SessionsDeps["sessionIndexService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/${summary.id}/context-status`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: "jsonl",
      model: "gpt-5.6-sol",
      contextUsage: summary.contextUsage,
    });
    expect(getSessionSummaryWithCache).toHaveBeenCalledWith(
      "/tmp/codex-sessions",
      project.id,
      summary.id,
      codexReader,
    );
    expect(codexGetSummary).not.toHaveBeenCalled();
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
      provider: "codex",
      parentSessionId: "ses_parent",
      lastTurnStatus: "failed",
      lastErrorMessage: "stale persisted error",
    };
    const bridgeSummary: SessionSummary = {
      ...persistedSummary,
      ownership: { owner: "external" },
      activity: "in-turn",
      source: "codex-bridge",
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
          provider: "codex" as const,
          session: { entries: [] },
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
      codexBridgeService: {
        getSessionView: vi.fn(async () => bridgeView),
        isSessionActive: vi.fn(async () => true),
        getPendingInputRequest: vi.fn(async () => null),
      } as unknown as NonNullable<SessionsDeps["codexBridgeService"]>,
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

  it("resolves bridge liveness for session detail without a second probe", async () => {
    const project = createProject();
    const summary: SessionSummary = {
      id: "ses_detail",
      projectId: project.id,
      title: "Codex detail session",
      fullTitle: "Codex detail session",
      createdAt: "2026-07-20T09:00:00.000Z",
      updatedAt: "2026-07-20T09:05:00.000Z",
      messageCount: 2,
      ownership: { owner: "none" },
      provider: "codex",
      source: "codex-bridge",
    };
    const reader = {
      getSessionSummary: vi.fn(async () => summary),
      getSession: vi.fn(async () => ({
        summary,
        data: {
          provider: "codex" as const,
          session: { entries: [] },
        },
        messagesAlreadyProjected: true,
      })),
    } as unknown as ISessionReader;
    const isSessionActive = vi.fn(async () => true);
    const codexBridgeService = {
      getSessionView: vi.fn(async () => ({
        session: { ...summary, ownership: { owner: "external" as const } },
        projectName: project.name,
        activity: "in-turn" as const,
        active: true,
      })),
      isSessionActive,
      getPendingInputRequest: vi.fn(async () => null),
    } as unknown as NonNullable<SessionsDeps["codexBridgeService"]>;

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
      codexBridgeService,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/${summary.id}`,
    );
    expect(response.status).toBe(200);
    const serverTiming = response.headers.get("server-timing");
    for (const stage of [
      "projectLookup",
      "bridgeView",
      "historyCapability",
      "summaryScan",
      "pageRead",
      "normalize",
      "canonicalSelect",
      "canonicalOverlay",
      "augment",
    ]) {
      expect(serverTiming).toContain(`${stage};dur=`);
    }
    const json = await response.json();
    expect(json.session.ownership).toEqual({ owner: "external" });
    // The view already answered liveness; probing /active again doubled the
    // bridge (and, behind it, upstream) request count on every session open.
    expect(isSessionActive).not.toHaveBeenCalled();
  });

  it("uses the paginated app-server history snapshot before the rollout reader", async () => {
    const project = { ...createProject(), provider: "codex" as const };
    const summary: SessionSummary = {
      id: "0198f000-0000-7000-8000-000000000001",
      projectId: project.id,
      title: "Paginated history",
      fullTitle: "Paginated history",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:01.000Z",
      messageCount: 1,
      ownership: { owner: "none" },
      provider: "codex",
    };
    const rolloutGetSession = vi.fn();
    const appHistoryGetSession = vi.fn(async () => ({
      kind: "loaded" as const,
      session: {
        summary,
        data: { provider: "codex" as const, session: { entries: [] } },
        projectedMessages: [
          {
            type: "user",
            uuid: "user-1-turn-1",
            message: { role: "user", content: "hello" },
          },
        ],
        paginationApplied: true,
        pagination: {
          hasOlderMessages: false,
          totalMessageCount: 1,
          returnedMessageCount: 1,
          totalCompactions: 0,
        },
        historySource: "codex-app-server" as const,
      },
    }));
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      runtimeController: {
        getProcessSnapshotForSession: vi.fn(async () => null),
        wasEverOwned: vi.fn(async () => false),
      } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () => ({ getSession: rolloutGetSession }) as unknown as ISessionReader,
      ),
      codexAppServerHistoryReader: {
        getSession: appHistoryGetSession,
      } as unknown as NonNullable<SessionsDeps["codexAppServerHistoryReader"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/${summary.id}`,
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.historySource).toBe("codex-app-server");
    expect(json.messages).toHaveLength(1);
    expect(json.session).not.toHaveProperty("messageCount");
    expect(appHistoryGetSession).toHaveBeenCalledOnce();
    expect(rolloutGetSession).not.toHaveBeenCalled();
  });

  it("returns a body-free canonical projection for the automatic Inspector index", async () => {
    const project = { ...createProject(), provider: "codex" as const };
    const summary: SessionSummary = {
      id: "inspector-projection-session",
      projectId: project.id,
      title: "Inspector projection",
      fullTitle: "Inspector projection",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:01.000Z",
      messageCount: 3,
      ownership: { owner: "none" },
      provider: "codex",
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
      readerFactory: vi.fn(
        () => ({ getSession: vi.fn() }) as unknown as ISessionReader,
      ),
      codexAppServerHistoryReader: {
        getSession: vi.fn(async () => ({
          kind: "loaded" as const,
          session: {
            summary,
            data: { provider: "codex" as const, session: { entries: [] } },
            projectedMessages: [
              {
                uuid: "question-1",
                type: "user",
                message: { role: "user", content: "Run the checks" },
              },
              {
                uuid: "tool-message",
                type: "assistant",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: "check-1",
                      name: "Bash",
                      input: {
                        command: "pnpm test",
                        description: "INPUT_SECRET",
                      },
                    },
                  ],
                },
              },
              {
                uuid: "result-message",
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "check-1",
                      content: "RESULT_SECRET",
                    },
                  ],
                },
              },
            ],
            paginationApplied: true,
            pagination: {
              hasOlderMessages: false,
              totalMessageCount: 3,
              returnedMessageCount: 3,
              totalCompactions: 0,
            },
            historySource: "codex-app-server" as const,
          },
        })),
      } as unknown as NonNullable<SessionsDeps["codexAppServerHistoryReader"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/${summary.id}?view=canonical&projection=inspector`,
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    const serialized = JSON.stringify(json.messages);
    expect(serialized).toContain("pnpm test");
    expect(serialized).not.toContain("INPUT_SECRET");
    expect(serialized).not.toContain("RESULT_SECRET");
  });

  it("marks an externally-owned display tool batch as the live tail", async () => {
    const project = createProject();
    const summary: SessionSummary = {
      id: "external-display-session",
      projectId: project.id,
      title: "External display",
      fullTitle: "External display",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:01.000Z",
      messageCount: 2,
      ownership: { owner: "none" },
      provider: "codex",
    };
    const reader = {
      getSessionSummary: vi.fn(async () => summary),
      getSessionFileStats: vi.fn(async () => ({ mtime: 1, size: 2 })),
      getSession: vi.fn(async () => ({
        summary,
        data: { provider: "codex" as const, session: { entries: [] } },
        projectedMessages: [
          {
            uuid: "question-1",
            type: "user",
            message: { role: "user", content: "Run externally" },
          },
          {
            uuid: "tool-1-message",
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "external-tool-1",
                  name: "Bash",
                  input: { command: "pnpm test" },
                },
              ],
            },
          },
        ],
      })),
    };
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      runtimeController: {
        getProcessSnapshotForSession: vi.fn(async () => null),
      } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
      sessionCommandService: {
        getPendingInput: vi.fn(async () => null),
      } as unknown as NonNullable<SessionsDeps["sessionCommandService"]>,
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader as unknown as ISessionReader),
      externalTracker: {
        isExternal: vi.fn(() => true),
      } as unknown as NonNullable<SessionsDeps["externalTracker"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/${summary.id}/display`,
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.turns[0].segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_group",
          status: "running",
          liveTail: true,
        }),
      ]),
    );
  });

  it("resolves a process-less Codex session from the catalog in a mixed-provider project", async () => {
    const project = createProject();
    const summary: SessionSummary = {
      ...createSummary(),
    };
    const primaryGetSession = vi.fn();
    const appHistoryGetSession = vi.fn(async () => ({
      kind: "loaded" as const,
      session: {
        summary,
        data: { provider: "codex" as const, session: { entries: [] } },
        projectedMessages: [
          {
            type: "user",
            uuid: "catalog-user",
            message: { role: "user", content: "hello" },
          },
        ],
        paginationApplied: true,
        pagination: {
          hasOlderMessages: false,
          totalMessageCount: 1,
          returnedMessageCount: 1,
          totalCompactions: 0,
        },
        historySource: "codex-app-server" as const,
      },
    }));
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      runtimeController: {
        getProcessSnapshotForSession: vi.fn(async () => null),
        wasEverOwned: vi.fn(async () => false),
      } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () => ({ getSession: primaryGetSession }) as unknown as ISessionReader,
      ),
      codexSessionCatalog: {
        getSessionSummary: vi.fn(async () => summary),
      } as unknown as NonNullable<SessionsDeps["codexSessionCatalog"]>,
      codexAppServerHistoryReader: {
        getSession: appHistoryGetSession,
      } as unknown as NonNullable<SessionsDeps["codexAppServerHistoryReader"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/${summary.id}`,
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.historySource).toBe("codex-app-server");
    expect(json.messages[0]?.uuid).toBe("catalog-user");
    expect(json.session).not.toHaveProperty("messageCount");
    expect(appHistoryGetSession).toHaveBeenCalledOnce();
    expect(primaryGetSession).not.toHaveBeenCalled();
  });

  it("falls back to the existing rollout reader with a typed history reason", async () => {
    const project = { ...createProject(), provider: "codex" as const };
    const summary: SessionSummary = {
      id: "0198f000-0000-7000-8000-000000000002",
      projectId: project.id,
      title: "Legacy history",
      fullTitle: "Legacy history",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:01.000Z",
      messageCount: 1,
      ownership: { owner: "none" },
      provider: "codex",
    };
    const rolloutGetSession = vi.fn(async () => ({
      summary,
      data: { provider: "codex" as const, session: { entries: [] } },
      projectedMessages: [
        {
          type: "user",
          uuid: "legacy-user",
          message: { role: "user", content: "legacy" },
        },
      ],
      historySource: "codex-rollout" as const,
    }));
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      runtimeController: {
        getProcessSnapshotForSession: vi.fn(async () => null),
        wasEverOwned: vi.fn(async () => false),
      } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () => ({ getSession: rolloutGetSession }) as unknown as ISessionReader,
      ),
      codexAppServerHistoryReader: {
        getSession: vi.fn(async () => ({
          kind: "fallback" as const,
          reason: "legacy_history" as const,
        })),
      } as unknown as NonNullable<SessionsDeps["codexAppServerHistoryReader"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/${summary.id}`,
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.historySource).toBe("codex-rollout");
    expect(json.historyFallbackReason).toBe("legacy_history");
    expect(json.messages[0]?.uuid).toBe("legacy-user");
    expect(rolloutGetSession).toHaveBeenCalledOnce();
  });

  it("prefers persisted provider and Codex source over conflicting resume settings", async () => {
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
            getSessionSummary: vi.fn(async () => ({
              ...createSummary(),
              codexModelProvider: "openai",
            })),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
        getCodexModelProvider: vi.fn(() => "deepseek"),
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
          model: "deepseek-v4-flash",
          codexModelProvider: "deepseek",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({
        providerName: "codex",
        model: "deepseek-v4-flash",
        codexModelProvider: "openai",
      }),
    );
  });

  it("infers a custom Codex source only when legacy session metadata is missing", async () => {
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
            getSessionSummary: vi.fn(async () => ({
              ...createSummary(),
              model: "deepseek-v4-flash",
              codexModelProvider: undefined,
            })),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
        getCodexModelProvider: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "continue",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({
        providerName: "codex",
        model: undefined,
        codexModelProvider: "deepseek",
      }),
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

  it("refuses legacy OpenCode archive requests without modifying its database", async () => {
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

      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => null),
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          listProjects: vi.fn(async () => [project]),
          invalidateCache,
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(() => ({}) as ISessionReader),
        sessionMetadataService: {
          getPersistedProvider: vi.fn(() => "opencode"),
          getProvider: vi.fn(() => undefined),
          updateMetadata,
        } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
        sessionArchiveService: archiveService,
      });

      expect(await readArchivedAt(dbPath, sessionId)).toBeNull();

      const archiveResponse = await routes.request(
        `/sessions/${sessionId}/metadata`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: true }),
        },
      );

      expect(archiveResponse.status).toBe(404);
      expect(await readArchivedAt(dbPath, sessionId)).toBeNull();
      expect(archiveService.getArchivedSession(sessionId)).toBeUndefined();
      expect(invalidateCache).not.toHaveBeenCalled();
      expect(updateMetadata).not.toHaveBeenCalled();
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
