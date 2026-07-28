import type { UrlProjectId } from "@yep-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexBridgeController } from "../../src/codex-bridge/types.js";
import type { SessionIndexService } from "../../src/indexes/index.js";
import type { NotificationService } from "../../src/notifications/index.js";
import type { OpenCodeBridgeController } from "../../src/opencode-bridge/types.js";
import type { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import {
  type InboxDeps,
  type InboxResponse,
  createInboxRoutes,
} from "../../src/routes/inbox.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

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

describe("Inbox Routes", () => {
  let mockScanner: ProjectScanner;
  let mockReaderFactory: (project: Project) => ISessionReader;
  let mockSupervisor: Supervisor;
  let mockNotificationService: NotificationService;
  let mockSessionIndexService: SessionIndexService;
  let sessionsByDir: Map<string, SessionSummary[]>;
  let codexSessionsByPath: Map<string, SessionSummary[]>;
  let processMap: Map<
    string,
    { getPendingInputRequest: () => unknown; state: { type: string } }
  >;
  let unreadMap: Map<string, boolean>;

  beforeEach(() => {
    sessionsByDir = new Map();
    codexSessionsByPath = new Map();
    processMap = new Map();
    unreadMap = new Map();

    // Mock scanner
    mockScanner = {
      listProjects: vi.fn(async () => []),
    } as unknown as ProjectScanner;

    // Mock reader factory - now takes a Project instead of sessionDir
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

    // Mock notification service
    mockNotificationService = {
      hasUnread: vi.fn(
        (sessionId: string, _updatedAt: string) =>
          unreadMap.get(sessionId) ?? false,
      ),
      getSessionsNeedingReview: vi.fn(() => []),
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
  });

  async function makeRequest(deps: InboxDeps): Promise<InboxResponse> {
    const routes = createInboxRoutes(deps);
    const response = await routes.request("/");
    expect(response.status).toBe(200);
    return response.json();
  }

  describe("tier categorization", () => {
    it("skips inactive projects older than the inbox time window", async () => {
      const recentProject = {
        ...createProject("proj1", "recent-project", "/sessions/recent"),
        lastActivity: minutesAgo(10),
      };
      const oldProject = {
        ...createProject("proj2", "old-project", "/sessions/old"),
        lastActivity: hoursAgo(48),
      };
      const recentSession = createSession("sess1", "proj1", minutesAgo(10));
      const oldSession = createSession("sess2", "proj2", hoursAgo(48));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([
        oldProject,
        recentProject,
      ]);
      sessionsByDir.set("/sessions/recent", [recentSession]);
      sessionsByDir.set("/sessions/old", [oldSession]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.recentActivity.map((item) => item.sessionId)).toEqual([
        "sess1",
      ]);
      expect(
        vi
          .mocked(mockSessionIndexService.getSessionsWithCache)
          .mock.calls.map((call) => call[0]),
      ).toEqual(["/sessions/recent"]);
    });

    it("categorizes session with pendingInputType into needsAttention", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // Mock process with pending input
      processMap.set("sess1", {
        getPendingInputRequest: () => ({
          type: "tool-approval",
          id: "req1",
          prompt: "Allow?",
        }),
        state: { type: "waiting-input" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(1);
      expect(result.needsAttention[0].sessionId).toBe("sess1");
      expect(result.needsAttention[0].pendingInputType).toBe("tool-approval");
      expect(result.active).toHaveLength(0);
    });

    it("categorizes session with in-turn process (no pending) into active", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // Mock in-turn process without pending input
      processMap.set("sess1", {
        getPendingInputRequest: () => null,
        state: { type: "in-turn" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(1);
      expect(result.active[0].sessionId).toBe("sess1");
      expect(result.active[0].activity).toBe("in-turn");
    });

    it("does not treat inactive codex bridge session views as active", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("bridge-sess", "proj1", hoursAgo(2), {
        provider: "codex",
      });
      // Shape a real codex sidecar emits for a session whose TUI died
      // mid-turn: no connection left (active: false, ownership none) while the
      // last observed activity is still "in-turn".
      const codexBridgeService = {
        listSessionViews: vi.fn(async () => [
          {
            session: {
              ...session,
              ownership: { owner: "none" },
            },
            projectName: project.name,
            activity: "in-turn" as const,
            active: false,
          },
        ]),
        isSessionActive: vi.fn(async () => false),
      } as unknown as CodexBridgeController;

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
        codexBridgeService,
      });

      expect(result.active).toHaveLength(0);
      expect(result.needsAttention).toHaveLength(0);
      // The verdict comes from the bulk snapshot: no per-session probe at all,
      // which is what kept /api/inbox O(1) in bridge requests.
      expect(codexBridgeService.isSessionActive).not.toHaveBeenCalled();
    });

    it("categorizes session updated in last hour into recentActivity", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(45)); // 45 minutes ago

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(1);
      expect(result.recentActivity[0].sessionId).toBe("sess1");
    });

    it("categorizes unread session updated within 8 hours into unread8h", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", hoursAgo(4)); // 4 hours ago

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(1);
      expect(result.unread8h[0].sessionId).toBe("sess1");
    });

    it("categorizes unread session updated within 24 hours into unread24h", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", hoursAgo(12)); // 12 hours ago

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
      expect(result.unread24h).toHaveLength(1);
      expect(result.unread24h[0].sessionId).toBe("sess1");
    });

    it("does not categorize session older than 24h or already read", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");

      // Session older than 24h
      const oldSession = createSession("old-sess", "proj1", hoursAgo(30));
      // Session within 24h but already read
      const readSession = createSession("read-sess", "proj1", hoursAgo(12));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [oldSession, readSession]);
      unreadMap.set("old-sess", true); // unread but too old
      unreadMap.set("read-sess", false); // already read

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
      expect(result.unread24h).toHaveLength(0);
    });
  });

  describe("priority", () => {
    it("assigns session to highest priority tier only", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      // Session that could qualify for multiple tiers:
      // - has pending input (needsAttention)
      // - has running process (active)
      // - updated 10 minutes ago (recentActivity)
      // - is unread (unread8h)
      const session = createSession("sess1", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);

      // Mock process with pending input (highest priority)
      processMap.set("sess1", {
        getPendingInputRequest: () => ({
          type: "user-question",
          id: "req1",
          prompt: "Question?",
        }),
        state: { type: "waiting-input" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Should only appear in needsAttention (highest priority)
      expect(result.needsAttention).toHaveLength(1);
      expect(result.needsAttention[0].sessionId).toBe("sess1");
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
    });

    it("surfaces a bridge-held approval on a session Yep still owns", async () => {
      // The owned OpenCode process missed `permission.asked` across an SSE
      // reconnect, so only the bridge holds the request. The inbox used to
      // consult the bridge only when no process existed, which hid the blocker
      // from needs-attention entirely.
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess-owned", "proj1", minutesAgo(2), {
        provider: "opencode",
      });
      const opencodeBridgeService = {
        listSessionViews: vi.fn(async () => [
          {
            session: { ...session, ownership: { owner: "external" as const } },
            projectName: project.name,
            activity: "waiting-input" as const,
            pendingInputType: "tool-approval" as const,
            active: true,
          },
        ]),
        isSessionActive: vi.fn(async () => true),
        getPendingInputRequest: vi.fn(async () => ({
          id: "per_bridge_only",
          type: "tool-approval",
          prompt: "Allow external_directory?",
        })),
      } as unknown as OpenCodeBridgeController;

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      processMap.set("sess-owned", {
        getPendingInputRequest: () => null,
        state: { type: "in-turn" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
        opencodeBridgeService,
      });

      expect(result.needsAttention).toHaveLength(1);
      expect(result.needsAttention[0]?.sessionId).toBe("sess-owned");
      expect(result.needsAttention[0]?.pendingRequestId).toBe(
        "per_bridge_only",
      );
      // One lookup for the one waiting session, not a serialized sweep.
      expect(
        opencodeBridgeService.getPendingInputRequest,
      ).toHaveBeenCalledTimes(1);
    });

    it("session in active tier does not appear in lower tiers", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      // In-turn session that is also recent and unread
      const session = createSession("sess1", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);

      // Mock in-turn process without pending input
      processMap.set("sess1", {
        getPendingInputRequest: () => null,
        state: { type: "in-turn" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Should only appear in active tier
      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(1);
      expect(result.active[0].sessionId).toBe("sess1");
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
    });
  });

  describe("badgeCount", () => {
    it("does not count ordinary historical unread sessions", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", hoursAgo(4));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.unread8h.map((item) => item.sessionId)).toEqual(["sess1"]);
      expect(result.badgeCount).toBe(0);
      expect(result.badgeSessionIds).toEqual([]);
    });

    it("counts sessions needing attention", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      processMap.set("sess1", {
        getPendingInputRequest: () => ({
          type: "user-question",
          id: "req1",
          prompt: "Question?",
        }),
        state: { type: "waiting-input" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.badgeCount).toBe(1);
      expect(result.badgeSessionIds).toEqual(["sess1"]);
    });

    it("does not count notification-backed sessions needing review", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(45));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      vi.mocked(
        mockNotificationService.getSessionsNeedingReview,
      ).mockReturnValue(["sess1", "missing-session"]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.recentActivity.map((item) => item.sessionId)).toEqual([
        "sess1",
      ]);
      expect(result.badgeCount).toBe(0);
      expect(result.badgeSessionIds).toEqual([]);
    });

    it("counts sessions needing attention even if they also need review", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      processMap.set("sess1", {
        getPendingInputRequest: () => ({
          type: "tool-approval",
          id: "req1",
          prompt: "Allow?",
        }),
        state: { type: "waiting-input" },
      });
      vi.mocked(
        mockNotificationService.getSessionsNeedingReview,
      ).mockReturnValue(["sess1"]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.badgeCount).toBe(1);
      expect(result.badgeSessionIds).toEqual(["sess1"]);
    });
  });

  describe("sorting within tiers", () => {
    it("sorts items by updatedAt descending (most recent first)", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      // Create sessions with different update times
      const sessions = [
        createSession("sess-oldest", "proj1", minutesAgo(25)),
        createSession("sess-middle", "proj1", minutesAgo(15)),
        createSession("sess-newest", "proj1", minutesAgo(5)),
      ];

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", sessions);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // All should be in recentActivity (< 1 hour)
      expect(result.recentActivity).toHaveLength(3);
      // Most recent first
      expect(result.recentActivity[0].sessionId).toBe("sess-newest");
      expect(result.recentActivity[1].sessionId).toBe("sess-middle");
      expect(result.recentActivity[2].sessionId).toBe("sess-oldest");
    });
  });

  describe("tier limits", () => {
    it("limits each tier to 20 items", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      // Create 25 sessions, all recently updated
      const sessions: SessionSummary[] = [];
      for (let i = 0; i < 25; i++) {
        sessions.push(createSession(`sess-${i}`, "proj1", minutesAgo(i + 1)));
      }

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", sessions);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Should be capped at 20
      expect(result.recentActivity).toHaveLength(20);
      // Oldest sessions (sess-20 through sess-24) should be excluded
      const ids = result.recentActivity.map((item) => item.sessionId);
      expect(ids).not.toContain("sess-20");
      expect(ids).not.toContain("sess-24");
    });
  });

  describe("graceful handling of unavailable services", () => {
    it("works without supervisor", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // No supervisor provided
      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        // supervisor: undefined
      });

      // Session should appear in recentActivity (no activity info)
      expect(result.recentActivity).toHaveLength(1);
      expect(result.recentActivity[0].sessionId).toBe("sess1");
      expect(result.recentActivity[0].activity).toBeUndefined();
      expect(result.recentActivity[0].pendingInputType).toBeUndefined();
    });

    it("works without notificationService", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", hoursAgo(4));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // No notification service - session is older than 30 min, so won't be in recentActivity
      // Without hasUnread, it won't appear in unread tiers either
      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        // notificationService: undefined
      });

      // Session should not appear in any tier (no unread tracking)
      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
      expect(result.unread24h).toHaveLength(0);
    });

    it("works without sessionIndexService (uses reader directly)", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // No session index service - should use reader directly
      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        // sessionIndexService: undefined
      });

      expect(result.recentActivity).toHaveLength(1);
      expect(result.recentActivity[0].sessionId).toBe("sess1");
    });

    it("returns empty tiers when no projects exist", async () => {
      vi.mocked(mockScanner.listProjects).mockResolvedValue([]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
      expect(result.unread24h).toHaveLength(0);
    });
  });

  describe("multi-project aggregation", () => {
    it("aggregates sessions across multiple projects", async () => {
      const projects = [
        createProject("proj1", "project1", "/sessions/proj1"),
        createProject("proj2", "project2", "/sessions/proj2"),
      ];
      const sess1 = createSession("sess1", "proj1", minutesAgo(5));
      const sess2 = createSession("sess2", "proj2", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue(projects);
      sessionsByDir.set("/sessions/proj1", [sess1]);
      sessionsByDir.set("/sessions/proj2", [sess2]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.recentActivity).toHaveLength(2);
      // Sorted by updatedAt descending
      expect(result.recentActivity[0].sessionId).toBe("sess1");
      expect(result.recentActivity[0].projectId).toBe("proj1");
      expect(result.recentActivity[1].sessionId).toBe("sess2");
      expect(result.recentActivity[1].projectId).toBe("proj2");
    });

    it("includes project name in inbox items", async () => {
      const project = createProject(
        "proj1",
        "my-awesome-project",
        "/sessions/proj1",
      );
      const session = createSession("sess1", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.recentActivity[0].projectName).toBe("my-awesome-project");
    });

    it("uses customTitle when available", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(10), {
        title: "Original title",
        customTitle: "My Custom Title",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.recentActivity[0].sessionTitle).toBe("My Custom Title");
    });
  });

  describe("archived sessions", () => {
    it("excludes archived sessions from all tiers", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");

      // Archived session that would qualify for needsAttention
      const archivedSession = createSession(
        "archived-sess",
        "proj1",
        minutesAgo(5),
        { isArchived: true },
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [archivedSession]);

      // Mock process with pending input - would normally put it in needsAttention
      processMap.set("archived-sess", {
        getPendingInputRequest: () => ({
          type: "tool-approval",
          id: "req1",
          prompt: "Allow?",
        }),
        state: { type: "waiting-input" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Archived session should be excluded from ALL tiers
      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
      expect(result.unread24h).toHaveLength(0);
    });

    it("excludes archived sessions from unread tiers", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");

      // Archived unread session within 8 hours
      const archivedSession = createSession(
        "archived-sess",
        "proj1",
        hoursAgo(4),
        {
          isArchived: true,
        },
      );
      // Non-archived unread session within 8 hours
      const normalSession = createSession("normal-sess", "proj1", hoursAgo(4));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [archivedSession, normalSession]);
      unreadMap.set("archived-sess", true);
      unreadMap.set("normal-sess", true);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Archived session should be excluded from unread tier
      expect(result.unread8h).toHaveLength(1);
      expect(result.unread8h[0].sessionId).toBe("normal-sess");
    });

    it("excludes archived sessions from unread24h tier", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");

      // Archived unread session within 24 hours (but outside 8h)
      const archivedSession = createSession(
        "archived-sess",
        "proj1",
        hoursAgo(12),
        {
          isArchived: true,
        },
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [archivedSession]);
      unreadMap.set("archived-sess", true);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Archived session should be excluded from unread24h tier
      expect(result.unread24h).toHaveLength(0);
    });

    it("includes codex sessions for projects whose primary provider is claude", async () => {
      const project = createProject("proj1", "project1", "/sessions/proj1");
      project.path = "/home/user/project1";
      const codexSession = createSession("codex-sess", "proj1", minutesAgo(5), {
        provider: "codex",
        title: "Codex session",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      codexSessionsByPath.set(project.path, [codexSession]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        sessionIndexService: mockSessionIndexService,
        codexScanner: {
          listProjects: vi.fn(async () => [
            {
              ...project,
              sessionDir: "/tmp/codex-sessions",
              provider: "codex",
            },
          ]),
        } as unknown as CodexSessionScanner,
        codexSessionsDir: "/tmp/codex-sessions",
        codexReaderFactory: vi.fn(
          (projectPath: string) =>
            ({
              listSessions: vi.fn(
                async () => codexSessionsByPath.get(projectPath) ?? [],
              ),
              getAgentMappings: vi.fn(async () => []),
              getAgentSession: vi.fn(async () => null),
            }) as unknown as CodexSessionReader,
        ),
      });

      expect(result.recentActivity).toHaveLength(1);
      expect(result.recentActivity[0]?.sessionId).toBe("codex-sess");
      expect(result.recentActivity[0]?.sessionTitle).toBe("Codex session");
    });
  });
});
