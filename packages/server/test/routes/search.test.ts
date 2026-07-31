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
});
