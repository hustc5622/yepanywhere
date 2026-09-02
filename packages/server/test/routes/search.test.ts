import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type {
  SessionContentIndexService,
  SessionContentIndexState,
} from "../../src/indexes/index.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createSearchRoutes } from "../../src/routes/search.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

describe("Search Routes", () => {
  it("passes an exact session filter to the content index", async () => {
    const project: Project = {
      id: "project-1" as UrlProjectId,
      path: "/tmp/project-1",
      name: "project-1",
      sessionCount: 2,
      sessionDir: "/tmp/project-1/sessions",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };
    const reader = {} as ISessionReader;
    const index = { sessions: {} } as SessionContentIndexState;
    const ensureIndexed = vi.fn(async () => index);
    const searchScope = vi.fn(() => [
      {
        sessionId: "session-2",
        title: "Target session",
        updatedAt: "2026-07-31T00:00:00.000Z",
        provider: "claude" as const,
        matchCount: 2,
        titleMatch: false,
        matches: [
          {
            messageId: "message-1",
            role: "user",
            snippet: "find the needle here",
            matchStart: 9,
            matchLength: 6,
          },
        ],
      },
    ]);

    const routes = createSearchRoutes({
      scanner: {
        listProjects: vi.fn(async () => [project]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => reader),
      sessionContentIndexService: {
        ensureIndexed,
        searchScope,
      } as unknown as SessionContentIndexService,
    });

    const response = await routes.request(
      "/?q=needle&project=project-1&session=session-2",
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(searchScope).toHaveBeenCalledWith(index, "needle", 200, "session-2");
    expect(body).toMatchObject({
      query: "needle",
      sort: "recent",
      totalSessions: 1,
      totalMatches: 2,
      results: [
        {
          sessionId: "session-2",
          projectId: "project-1",
          matchCount: 2,
        },
      ],
    });
  });

  it("orders results by recency by default and by relevance on request", async () => {
    const project: Project = {
      id: "project-1" as UrlProjectId,
      path: "/tmp/project-1",
      name: "project-1",
      sessionCount: 2,
      sessionDir: "/tmp/project-1/sessions",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };
    const index = { sessions: {} } as SessionContentIndexState;
    const makeResult = (
      sessionId: string,
      updatedAt: string,
      matchCount: number,
    ) => ({
      sessionId,
      title: `${sessionId} title`,
      updatedAt,
      provider: "claude" as const,
      matchCount,
      titleMatch: false,
      matches: [
        {
          messageId: `${sessionId}-m1`,
          role: "user",
          snippet: "needle",
          matchStart: 0,
          matchLength: 6,
        },
      ],
    });

    const routes = createSearchRoutes({
      scanner: {
        listProjects: vi.fn(async () => [project]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => ({}) as ISessionReader),
      sessionContentIndexService: {
        ensureIndexed: vi.fn(async () => index),
        searchScope: vi.fn(() => [
          // Older session with many matches, newer session with a single match.
          makeResult("old-many", "2026-01-01T00:00:00.000Z", 9),
          makeResult("new-few", "2026-07-31T00:00:00.000Z", 1),
        ]),
      } as unknown as SessionContentIndexService,
    });

    const recent = await (await routes.request("/?q=needle")).json();
    expect(recent.sort).toBe("recent");
    expect(
      recent.results.map((r: { sessionId: string }) => r.sessionId),
    ).toEqual(["new-few", "old-many"]);

    const relevance = await (
      await routes.request("/?q=needle&sort=relevance")
    ).json();
    expect(relevance.sort).toBe("relevance");
    expect(
      relevance.results.map((r: { sessionId: string }) => r.sessionId),
    ).toEqual(["old-many", "new-few"]);
  });
});
