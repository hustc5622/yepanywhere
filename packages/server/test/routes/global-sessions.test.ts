import type { SessionCreatedBy, UrlProjectId } from "@yep-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexBridgeController } from "../../src/codex-bridge/types.js";
import type { SessionIndexService } from "../../src/indexes/index.js";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import type { NotificationService } from "../../src/notifications/index.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import {
  type GlobalSessionsDeps,
  type GlobalSessionsResponse,
  createGlobalSessionsRoutes,
} from "../../src/routes/global-sessions.js";
import type { GeminiSessionReader } from "../../src/sessions/gemini-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

// Helper to create ISO timestamps relative to now
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// Helper to create a mock session
function createSession(
  id: string,
  projectId: string,
  updatedAt: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    projectId: projectId as UrlProjectId,
    title: `Session ${id}`,
    fullTitle: `Session ${id} full title`,
    createdAt: hoursAgo(48),
    updatedAt,
    messageCount: 5,
    ownership: { owner: "none" },
    provider: "claude",
    ...overrides,
  };
}

// Helper to create a mock project
function createProject(id: string, name: string, sessionDir: string): Project {
  return {
    id: id as UrlProjectId,
    path: `/home/user/${name}`,
    name,
    sessionCount: 1,
    sessionDir,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

describe("Global Sessions Routes", () => {
  let mockScanner: ProjectScanner;
  let mockReaderFactory: (project: Project) => ISessionReader;
  let mockSupervisor: Supervisor;
  let mockExternalTracker: ExternalSessionTracker;
  let mockNotificationService: NotificationService;
  let mockSessionIndexService: SessionIndexService;
  let mockMetadataService: SessionMetadataService;
  let sessionsByDir: Map<string, SessionSummary[]>;
  let processMap: Map<
    string,
    {
      id: string;
      getPendingInputRequest: () => unknown;
      state: { type: string };
      permissionMode: string;
      modeVersion: number;
    }
  >;
  let unreadMap: Map<string, boolean>;
  let metadataMap: Map<
    string,
    {
      customTitle?: string;
      aiTitle?: string;
      isArchived?: boolean;
      isStarred?: boolean;
      createdBy?: SessionCreatedBy;
    }
  >;
  let externalSessions: Set<string>;

  beforeEach(() => {
    sessionsByDir = new Map();
    processMap = new Map();
    unreadMap = new Map();
    metadataMap = new Map();
    externalSessions = new Set();

    // Mock scanner
    mockScanner = {
      listProjects: vi.fn(async () => []),
    } as unknown as ProjectScanner;

    // Mock reader factory
    mockReaderFactory = vi.fn((project: Project) => ({
      listSessions: vi.fn(
        async () => sessionsByDir.get(project.sessionDir) ?? [],
      ),
      getAgentMappings: vi.fn(async () => []),
      getAgentSession: vi.fn(async () => null),
    })) as unknown as (project: Project) => ISessionReader;

    // Mock supervisor
    mockSupervisor = {
      getProcessForSession: vi.fn((sessionId: string) =>
        processMap.get(sessionId),
      ),
    } as unknown as Supervisor;

    // Mock external tracker
    mockExternalTracker = {
      isExternal: vi.fn((sessionId: string) => externalSessions.has(sessionId)),
    } as unknown as ExternalSessionTracker;

    // Mock notification service
    mockNotificationService = {
      hasUnread: vi.fn(
        (sessionId: string, _updatedAt: string) =>
          unreadMap.get(sessionId) ?? false,
      ),
    } as unknown as NotificationService;

    // Mock session index service
    mockSessionIndexService = {
      getSessionsWithCache: vi.fn(
        async (
          sessionDir: string,
          _projectId: string,
          reader: ISessionReader,
        ) => {
          return reader.listSessions(_projectId as UrlProjectId);
        },
      ),
    } as unknown as SessionIndexService;

    // Mock metadata service
    mockMetadataService = {
      getMetadata: vi.fn((sessionId: string) => metadataMap.get(sessionId)),
    } as unknown as SessionMetadataService;
  });

  function getDeps(
    overrides: Partial<GlobalSessionsDeps> = {},
  ): GlobalSessionsDeps {
    return {
      scanner: mockScanner,
      readerFactory: mockReaderFactory,
      supervisor: mockSupervisor,
      externalTracker: mockExternalTracker,
      notificationService: mockNotificationService,
      sessionIndexService: mockSessionIndexService,
      sessionMetadataService: mockMetadataService,
      ...overrides,
    };
  }

  async function makeRequest(
    queryString = "",
  ): Promise<GlobalSessionsResponse> {
    const routes = createGlobalSessionsRoutes(getDeps());
    const response = await routes.request(`/${queryString}`);
    expect(response.status).toBe(200);
    return response.json();
  }

  async function makeStatsRequest(
    routes = createGlobalSessionsRoutes(getDeps()),
    queryString = "",
  ): Promise<{ stats: GlobalSessionsResponse["stats"] }> {
    const response = await routes.request(`/stats${queryString}`);
    expect(response.status).toBe(200);
    return response.json();
  }

  describe("basic functionality", () => {
    it("returns empty array when no projects exist", async () => {
      vi.mocked(mockScanner.listProjects).mockResolvedValue([]);

      const result = await makeRequest();

      expect(result.sessions).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it("returns sessions from multiple projects", async () => {
      const project1 = createProject("proj1", "project-one", "/sessions/proj1");
      const project2 = createProject("proj2", "project-two", "/sessions/proj2");
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj2", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([
        project1,
        project2,
      ]);
      sessionsByDir.set("/sessions/proj1", [session1]);
      sessionsByDir.set("/sessions/proj2", [session2]);

      const result = await makeRequest();

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0].id).toBe("sess1"); // More recent first
      expect(result.sessions[0].projectName).toBe("project-one");
      expect(result.sessions[1].id).toBe("sess2");
      expect(result.sessions[1].projectName).toBe("project-two");
    });

    it("passes creation source metadata through to global session items", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5), {
        provider: "codex",
        originator: "Codex Desktop",
        source: "appServer",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      metadataMap.set("sess1", { createdBy: "yep" });

      const result = await makeRequest();

      expect(result.sessions[0]).toMatchObject({
        id: "sess1",
        createdBy: "yep",
        originator: "Codex Desktop",
        source: "appServer",
      });
    });

    it("stops scanning older projects once the requested page is full", async () => {
      const project1 = {
        ...createProject("proj1", "project-one", "/sessions/proj1"),
        lastActivity: minutesAgo(1),
      };
      const project2 = {
        ...createProject("proj2", "project-two", "/sessions/proj2"),
        lastActivity: minutesAgo(2),
      };
      const project3 = {
        ...createProject("proj3", "project-three", "/sessions/proj3"),
        lastActivity: minutesAgo(3),
      };
      const session1 = createSession("sess1", "proj1", minutesAgo(1));
      const session2 = createSession("sess2", "proj2", minutesAgo(2));
      const session3 = createSession("sess3", "proj3", minutesAgo(3));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([
        project3,
        project1,
        project2,
      ]);
      sessionsByDir.set("/sessions/proj1", [session1]);
      sessionsByDir.set("/sessions/proj2", [session2]);
      sessionsByDir.set("/sessions/proj3", [session3]);

      const result = await makeRequest("?limit=1");

      expect(result.sessions.map((session) => session.id)).toEqual(["sess1"]);
      expect(result.hasMore).toBe(true);
      expect(
        vi
          .mocked(mockSessionIndexService.getSessionsWithCache)
          .mock.calls.map((call) => call[0]),
      ).toEqual(["/sessions/proj1", "/sessions/proj2"]);
    });

    it("only computes global stats when includeStats=true", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);
      metadataMap.set("sess1", { isStarred: true });

      const withoutStats = await makeRequest();
      expect(withoutStats.stats).toEqual({
        totalCount: 0,
        unreadCount: 0,
        starredCount: 0,
        archivedCount: 0,
        providerCounts: {},
        executorCounts: {},
      });

      const withStats = await makeRequest("?includeStats=true");
      expect(withStats.stats.totalCount).toBe(1);
      expect(withStats.stats.unreadCount).toBe(1);
      expect(withStats.stats.starredCount).toBe(1);
      expect(withStats.stats.providerCounts.claude).toBe(1);
    });

    it("includes project context on each session", async () => {
      const project = createProject("proj1", "my-project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const result = await makeRequest();

      expect(result.sessions[0].projectId).toBe("proj1");
      expect(result.sessions[0].projectName).toBe("my-project");
    });
  });

  describe("stats endpoint", () => {
    it("returns cached stats and invalidates on metadata changes", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));
      const eventBus = new EventBus();
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const routes = createGlobalSessionsRoutes(getDeps({ eventBus }));

      const first = await makeStatsRequest(routes);
      expect(first.stats.totalCount).toBe(1);
      expect(first.stats.archivedCount).toBe(0);
      expect(vi.mocked(mockScanner.listProjects)).toHaveBeenCalledTimes(1);

      metadataMap.set("sess1", { isArchived: true });
      const second = await makeStatsRequest(routes);
      expect(second.stats.totalCount).toBe(1);
      expect(second.stats.archivedCount).toBe(0);
      expect(vi.mocked(mockScanner.listProjects)).toHaveBeenCalledTimes(1);

      eventBus.emit({
        type: "session-metadata-changed",
        sessionId: "sess1",
        archived: true,
        timestamp: new Date().toISOString(),
      });

      const third = await makeStatsRequest(routes);
      expect(third.stats.totalCount).toBe(0);
      expect(third.stats.archivedCount).toBe(1);
      expect(vi.mocked(mockScanner.listProjects)).toHaveBeenCalledTimes(2);
    });
  });

  describe("filtering", () => {
    it("filters by projectId when ?project query param provided", async () => {
      const project1 = createProject("proj1", "project-one", "/sessions/proj1");
      const project2 = createProject("proj2", "project-two", "/sessions/proj2");
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj2", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([
        project1,
        project2,
      ]);
      sessionsByDir.set("/sessions/proj1", [session1]);
      sessionsByDir.set("/sessions/proj2", [session2]);

      const result = await makeRequest("?project=proj1");

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("sess1");
    });

    it("excludes archived sessions by default", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2]);
      metadataMap.set("sess2", { isArchived: true });

      const result = await makeRequest();

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("sess1");
    });

    it("includes archived sessions when ?includeArchived=true", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2]);
      metadataMap.set("sess2", { isArchived: true });

      const result = await makeRequest("?includeArchived=true");

      expect(result.sessions).toHaveLength(2);
    });

    it("filters command-message sessions with ?kind=slash-command", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const commandSession = createSession(
        "sess-command",
        "proj1",
        minutesAgo(5),
        {
          title:
            "<command-message>kb-map-repo-capabilities</command-message> done",
        },
      );
      const dollarCommandSession = createSession(
        "sess-dollar-command",
        "proj1",
        minutesAgo(7),
        {
          title: "$git commit push",
        },
      );
      const normalSession = createSession(
        "sess-normal",
        "proj1",
        minutesAgo(10),
        {
          title: "Normal session",
        },
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [
        commandSession,
        dollarCommandSession,
        normalSession,
      ]);

      const result = await makeRequest("?kind=slash-command");

      expect(result.sessions.map((session) => session.id)).toEqual([
        "sess-command",
        "sess-dollar-command",
      ]);
    });

    it("excludes command-message sessions with ?excludeKind=slash-command", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const commandSession = createSession(
        "sess-command",
        "proj1",
        minutesAgo(5),
        {
          title:
            "<command-message>kb-map-repo-capabilities</command-message> done",
        },
      );
      const dollarCommandSession = createSession(
        "sess-dollar-command",
        "proj1",
        minutesAgo(7),
        {
          title: "$git commit push",
        },
      );
      const normalSession = createSession(
        "sess-normal",
        "proj1",
        minutesAgo(10),
        {
          title: "Normal session",
        },
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [
        commandSession,
        dollarCommandSession,
        normalSession,
      ]);

      const result = await makeRequest("?excludeKind=slash-command");

      expect(result.sessions.map((session) => session.id)).toEqual([
        "sess-normal",
      ]);
    });
  });

  describe("search", () => {
    it("filters by session title when ?q query param provided", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(5), {
        title: "Fix login bug",
      });
      const session2 = createSession("sess2", "proj1", minutesAgo(10), {
        title: "Add new feature",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2]);

      const result = await makeRequest("?q=login");

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("sess1");
    });

    it("searches in customTitle", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(5), {
        title: "Original title",
      });
      const session2 = createSession("sess2", "proj1", minutesAgo(10), {
        title: "Another title",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2]);
      metadataMap.set("sess1", { customTitle: "Custom Login Session" });

      const result = await makeRequest("?q=custom");

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("sess1");
    });

    it("searches in projectName", async () => {
      const project1 = createProject(
        "proj1",
        "authentication-service",
        "/sessions/proj1",
      );
      const project2 = createProject(
        "proj2",
        "payment-gateway",
        "/sessions/proj2",
      );
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj2", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([
        project1,
        project2,
      ]);
      sessionsByDir.set("/sessions/proj1", [session1]);
      sessionsByDir.set("/sessions/proj2", [session2]);

      const result = await makeRequest("?q=authentication");

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("sess1");
    });

    it("search is case-insensitive", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5), {
        title: "FIX LOGIN BUG",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const result = await makeRequest("?q=login");

      expect(result.sessions).toHaveLength(1);
    });
  });

  describe("pagination", () => {
    it("limits results to specified limit", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const sessions = Array.from({ length: 5 }, (_, i) =>
        createSession(`sess${i}`, "proj1", minutesAgo(i)),
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", sessions);

      const result = await makeRequest("?limit=2");

      expect(result.sessions).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    it("returns hasMore=false when all results returned", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const sessions = [createSession("sess1", "proj1", minutesAgo(5))];

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", sessions);

      const result = await makeRequest("?limit=10");

      expect(result.sessions).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });

    it("uses after cursor for pagination", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj1", minutesAgo(10));
      const session3 = createSession("sess3", "proj1", minutesAgo(15));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2, session3]);

      // Get sessions after session1's timestamp (should skip session1)
      const afterCursor = session1.updatedAt;
      const result = await makeRequest(`?after=${afterCursor}`);

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0].id).toBe("sess2");
      expect(result.sessions[1].id).toBe("sess3");
    });

    it("combines after cursor with limit", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const sessions = Array.from({ length: 10 }, (_, i) =>
        createSession(`sess${i}`, "proj1", minutesAgo(i)),
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", sessions);

      // Skip first 3, take 2
      const afterCursor = sessions[2].updatedAt;
      const result = await makeRequest(`?after=${afterCursor}&limit=2`);

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0].id).toBe("sess3");
      expect(result.sessions[1].id).toBe("sess4");
      expect(result.hasMore).toBe(true);
    });
  });

  describe("provider catalog", () => {
    it("reuses provider presence from listed projects before consulting scanners", async () => {
      const project = {
        ...createProject("proj1", "project-one", "/sessions/proj1"),
        hasCodexSessions: true,
      } as Project;
      const codexSession = createSession(
        "codex-sess-1",
        "proj1",
        minutesAgo(1),
        {
          provider: "codex",
        },
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", []);

      const codexScanner = {
        listProjects: vi.fn(async () => {
          throw new Error("codex scanner should not be consulted");
        }),
      };
      const codexReader = {
        listSessions: vi.fn(async () => [codexSession]),
      } as unknown as ISessionReader;
      const codexReaderFactory = vi.fn(() => codexReader);
      const sessionIndexService = {
        getSessionsWithCache: vi.fn(
          async (
            sessionDir: string,
            _projectId: string,
            reader: ISessionReader,
          ) => {
            if (sessionDir === "/codex/sessions") {
              expect(reader).toBe(codexReader);
              return [codexSession];
            }
            return reader.listSessions(_projectId as UrlProjectId);
          },
        ),
      } as unknown as SessionIndexService;

      const routes = createGlobalSessionsRoutes({
        ...getDeps({ sessionIndexService }),
        codexScanner:
          codexScanner as unknown as GlobalSessionsDeps["codexScanner"],
        codexSessionsDir: "/codex/sessions",
        codexReaderFactory:
          codexReaderFactory as unknown as GlobalSessionsDeps["codexReaderFactory"],
      });

      const response = await routes.request("/?project=proj1");
      expect(response.status).toBe(200);
      const result = (await response.json()) as GlobalSessionsResponse;

      expect(codexScanner.listProjects).not.toHaveBeenCalled();
      expect(codexReaderFactory).toHaveBeenCalledWith(project.path);
      expect(result.sessions.some((s) => s.id === "codex-sess-1")).toBe(true);
    });

    it("builds codex project catalog once and avoids per-project scanner checks", async () => {
      const project1 = createProject("proj1", "project-one", "/sessions/proj1");
      const project2 = createProject("proj2", "project-two", "/sessions/proj2");

      vi.mocked(mockScanner.listProjects).mockResolvedValue([
        project1,
        project2,
      ]);
      sessionsByDir.set("/sessions/proj1", []);
      sessionsByDir.set("/sessions/proj2", []);

      const codexScanner = {
        listProjects: vi.fn(async () => [
          {
            ...project1,
            provider: "codex",
          },
        ]),
        getSessionsForProject: vi.fn(async () => []),
      };

      const codexReaderFactory = vi.fn(() => ({
        listSessions: vi.fn(async () => [
          createSession("codex-sess-1", "proj1", minutesAgo(1), {
            provider: "codex",
          }),
        ]),
      }));

      const routes = createGlobalSessionsRoutes({
        ...getDeps(),
        codexScanner:
          codexScanner as unknown as GlobalSessionsDeps["codexScanner"],
        codexReaderFactory:
          codexReaderFactory as unknown as GlobalSessionsDeps["codexReaderFactory"],
      });
      const response = await routes.request("/");
      expect(response.status).toBe(200);
      const result = (await response.json()) as GlobalSessionsResponse;

      expect(codexScanner.listProjects).toHaveBeenCalledTimes(1);
      expect(codexScanner.getSessionsForProject).not.toHaveBeenCalled();
      expect(codexReaderFactory).toHaveBeenCalledTimes(1);
      expect(codexReaderFactory).toHaveBeenCalledWith(project1.path);
      expect(result.sessions.some((s) => s.id === "codex-sess-1")).toBe(true);
    });

    it("uses session index cache for codex sessions merged into claude projects", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", []);

      const codexSession = createSession(
        "codex-sess-1",
        "proj1",
        minutesAgo(1),
        {
          provider: "codex",
        },
      );
      const codexReader = {
        listSessions: vi.fn(async () => [codexSession]),
      } as unknown as CodexSessionReader;
      const codexReaderFactory = vi.fn(() => codexReader);
      const codexScanner = {
        listProjects: vi.fn(async () => [{ ...project, provider: "codex" }]),
      };
      const sessionIndexService = {
        getSessionsWithCache: vi.fn(
          async (
            sessionDir: string,
            _projectId: string,
            reader: ISessionReader,
          ) => {
            if (sessionDir === "/codex/sessions") {
              expect(reader).toBe(codexReader);
              return [codexSession];
            }
            return reader.listSessions(_projectId as UrlProjectId);
          },
        ),
      } as unknown as SessionIndexService;

      const routes = createGlobalSessionsRoutes({
        ...getDeps({ sessionIndexService }),
        codexScanner:
          codexScanner as unknown as GlobalSessionsDeps["codexScanner"],
        codexSessionsDir: "/codex/sessions",
        codexReaderFactory:
          codexReaderFactory as unknown as GlobalSessionsDeps["codexReaderFactory"],
      });

      const response = await routes.request("/");
      expect(response.status).toBe(200);
      const result = (await response.json()) as GlobalSessionsResponse;

      expect(
        vi.mocked(sessionIndexService.getSessionsWithCache),
      ).toHaveBeenCalledWith("/codex/sessions", project.id, codexReader, {
        allowStale: true,
      });
      expect(codexReader.listSessions).not.toHaveBeenCalled();
      expect(result.sessions.some((s) => s.id === "codex-sess-1")).toBe(true);
    });

    it("uses session index cache for gemini sessions merged into claude projects", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", []);

      const geminiSession = createSession(
        "gemini-sess-1",
        "proj1",
        minutesAgo(1),
        {
          provider: "gemini",
        },
      );
      const geminiReader = {
        listSessions: vi.fn(async () => [geminiSession]),
      } as unknown as GeminiSessionReader;
      const geminiReaderFactory = vi.fn(() => geminiReader);
      const geminiScanner = {
        listProjects: vi.fn(async () => [{ ...project, provider: "gemini" }]),
        getHashToCwd: vi.fn(async () => new Map()),
      };
      const sessionIndexService = {
        getSessionsWithCache: vi.fn(
          async (
            sessionDir: string,
            _projectId: string,
            reader: ISessionReader,
          ) => {
            if (sessionDir === "/gemini/tmp") {
              expect(reader).toBe(geminiReader);
              return [geminiSession];
            }
            return reader.listSessions(_projectId as UrlProjectId);
          },
        ),
      } as unknown as SessionIndexService;

      const routes = createGlobalSessionsRoutes({
        ...getDeps({ sessionIndexService }),
        geminiScanner:
          geminiScanner as unknown as GlobalSessionsDeps["geminiScanner"],
        geminiSessionsDir: "/gemini/tmp",
        geminiReaderFactory:
          geminiReaderFactory as unknown as GlobalSessionsDeps["geminiReaderFactory"],
      });

      const response = await routes.request("/");
      expect(response.status).toBe(200);
      const result = (await response.json()) as GlobalSessionsResponse;

      expect(
        vi.mocked(sessionIndexService.getSessionsWithCache),
      ).toHaveBeenCalledWith("/gemini/tmp", project.id, geminiReader, {
        allowStale: true,
      });
      expect(geminiReader.listSessions).not.toHaveBeenCalled();
      expect(result.sessions.some((s) => s.id === "gemini-sess-1")).toBe(true);
    });
  });

  describe("enrichment", () => {
    it("enriches with self ownership from supervisor", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      processMap.set("sess1", {
        id: "proc-1",
        getPendingInputRequest: () => null,
        state: { type: "in-turn" },
        permissionMode: "default",
        modeVersion: 1,
      });

      const result = await makeRequest();

      expect(result.sessions[0].ownership).toEqual({
        owner: "self",
        processId: "proc-1",
        permissionMode: "default",
        modeVersion: 1,
      });
      expect(result.sessions[0].activity).toBe("in-turn");
    });

    it("enriches with external ownership", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      externalSessions.add("sess1");

      const result = await makeRequest();

      expect(result.sessions[0].ownership).toEqual({ owner: "external" });
    });

    it("marks idle bridged sessions with open connections as external", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5), {
        provider: "codex",
      });
      const codexBridgeService = {
        listSessionViews: vi.fn(async () => []),
        getSessionView: vi.fn(async () => ({
          session: {
            ...session,
            ownership: { owner: "external" },
            source: "codex-bridge",
          },
          projectName: "project",
          activity: "idle",
        })),
        isSessionActive: vi.fn(async () => true),
      } as unknown as CodexBridgeController;

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const routes = createGlobalSessionsRoutes(
        getDeps({ codexBridgeService }),
      );
      const response = await routes.request("/");
      expect(response.status).toBe(200);
      const result = (await response.json()) as GlobalSessionsResponse;

      expect(result.sessions[0].ownership).toEqual({ owner: "external" });
      expect(result.sessions[0].activity).toBe("idle");
    });

    it("uses bridge turn health as authoritative over stale persisted state", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5), {
        provider: "codex",
        lastTurnStatus: "failed",
        lastErrorMessage: "stale persisted error",
        retryStatus: { attempt: 2, message: "stale retry" },
      });
      const codexBridgeService = {
        listSessionViews: vi.fn(async () => []),
        getSessionView: vi.fn(async () => ({
          session: {
            ...session,
            ownership: { owner: "external" },
            source: "codex-bridge",
            lastTurnStatus: undefined,
            lastErrorMessage: undefined,
            retryStatus: undefined,
          },
          projectName: "project",
          activity: "idle",
        })),
        isSessionActive: vi.fn(async () => true),
      } as unknown as CodexBridgeController;

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const routes = createGlobalSessionsRoutes(
        getDeps({ codexBridgeService }),
      );
      const response = await routes.request("/");
      expect(response.status).toBe(200);
      const result = (await response.json()) as GlobalSessionsResponse;

      expect(result.sessions[0].lastTurnStatus).toBeUndefined();
      expect(result.sessions[0].lastErrorMessage).toBeUndefined();
      expect(result.sessions[0].retryStatus).toBeUndefined();
    });

    it("enriches with pendingInputType", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      processMap.set("sess1", {
        id: "proc-1",
        getPendingInputRequest: () => ({ type: "tool-approval" }),
        state: { type: "waiting-input" },
        permissionMode: "default",
        modeVersion: 1,
      });

      const result = await makeRequest();

      expect(result.sessions[0].pendingInputType).toBe("tool-approval");
    });

    it("enriches with hasUnread from notification service", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);

      const result = await makeRequest();

      expect(result.sessions[0].hasUnread).toBe(true);
    });

    it("enriches with metadata (customTitle, aiTitle, isArchived, isStarred)", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      metadataMap.set("sess1", {
        customTitle: "My Custom Title",
        aiTitle: "AI Title",
        isStarred: true,
      });

      const result = await makeRequest();

      expect(result.sessions[0].customTitle).toBe("My Custom Title");
      expect(result.sessions[0].aiTitle).toBe("AI Title");
      expect(result.sessions[0].isStarred).toBe(true);
    });
  });

  describe("sorting", () => {
    it("sorts by updatedAt descending (most recent first)", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(15));
      const session2 = createSession("sess2", "proj1", minutesAgo(5));
      const session3 = createSession("sess3", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2, session3]);

      const result = await makeRequest();

      expect(result.sessions[0].id).toBe("sess2"); // 5 min ago
      expect(result.sessions[1].id).toBe("sess3"); // 10 min ago
      expect(result.sessions[2].id).toBe("sess1"); // 15 min ago
    });
  });
});
