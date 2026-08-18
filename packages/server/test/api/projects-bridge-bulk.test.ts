import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { BridgeSessionView } from "../../src/bridge-common/types.js";
import type { CodexBridgeController } from "../../src/codex-bridge/types.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createProjectsRoutes } from "../../src/routes/projects.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

const PROJECT_PATH = "/repo/bridge-bulk";
const PROJECT_ID = toUrlProjectId(PROJECT_PATH);

function project(): Project {
  return {
    id: PROJECT_ID,
    path: PROJECT_PATH,
    name: "bridge-bulk",
    sessionCount: 0,
    sessionDir: `${PROJECT_PATH}/.sessions`,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: "2026-07-20T10:00:00.000Z",
    provider: "claude",
  };
}

function view(id: string, live: boolean): BridgeSessionView {
  return {
    session: {
      id,
      projectId: PROJECT_ID,
      title: id,
      fullTitle: id,
      createdAt: "2026-07-20T09:00:00.000Z",
      updatedAt: "2026-07-20T09:30:00.000Z",
      messageCount: 4,
      ownership: live ? { owner: "external" } : { owner: "none" },
      provider: "codex",
      source: "codex-bridge",
    },
    projectName: "bridge-bulk",
    ...(live ? { activity: "in-turn" as const } : {}),
    // The bulk snapshot ships the sidecar's own liveness verdict, which is
    // what removes the need for a per-session /active probe.
    active: live,
  };
}

/**
 * A session whose CLI vanished mid-turn: still tagged `in-turn`, but the
 * sidecar reports it inactive. It must not be counted as live.
 */
function staleView(id: string): BridgeSessionView {
  return {
    ...view(id, false),
    activity: "in-turn",
    active: false,
  };
}

interface BridgeCallCounts {
  listSessionViews: number;
  getSessionView: number;
  isSessionActive: number;
}

function stubBridge(views: BridgeSessionView[]): {
  controller: CodexBridgeController;
  calls: BridgeCallCounts;
} {
  const calls: BridgeCallCounts = {
    listSessionViews: 0,
    getSessionView: 0,
    isSessionActive: 0,
  };
  const controller = {
    getStatus: () => {
      throw new Error("getStatus must not be called by the project routes");
    },
    listSessions: () => [],
    listSessionViews: () => {
      calls.listSessionViews += 1;
      return views;
    },
    getSessionView: (sessionId: string) => {
      calls.getSessionView += 1;
      return views.find((item) => item.session.id === sessionId) ?? null;
    },
    isSessionActive: (sessionId: string) => {
      calls.isSessionActive += 1;
      return (
        views.find((item) => item.session.id === sessionId)?.session.ownership
          .owner === "external"
      );
    },
    getPendingInputRequest: () => null,
    respondToInput: () => false,
  } as unknown as CodexBridgeController;
  return { controller, calls };
}

function routesFor(codexViews: BridgeSessionView[]) {
  const codex = stubBridge(codexViews);
  const scanner = {
    listProjects: async () => [project()],
    getOrCreateProject: async (projectId: string) =>
      projectId === PROJECT_ID ? project() : null,
    invalidateCache: () => {},
  } as unknown as ProjectScanner;

  const routes = createProjectsRoutes({
    scanner,
    readerFactory: () =>
      ({ listSessions: async () => [] }) as unknown as ISessionReader,
    gitStatusProvider: async () => null,
    codexBridgeService: codex.controller,
  });

  return { routes, codex };
}

describe("project routes bridge fan-out", () => {
  // A large bridge snapshot must still result in constant route fan-out.
  const codexViews = Array.from({ length: 148 }, (_, index) =>
    view(`codex-${index}`, index % 3 === 0),
  );
  const liveCount = codexViews.filter(
    (item) => item.session.ownership.owner === "external",
  ).length;

  it("lists projects with one bulk snapshot and no per-session probes", async () => {
    const { routes, codex } = routesFor(codexViews);

    const res = await routes.request("/");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      projects: Array<{ id: string; activeExternalCount: number }>;
    };

    expect(codex.calls.listSessionViews).toBe(1);
    expect(codex.calls.isSessionActive).toBe(0);
    expect(codex.calls.getSessionView).toBe(0);

    // Liveness is still derived correctly, just from the snapshot.
    const listed = json.projects.find((item) => item.id === PROJECT_ID);
    expect(listed?.activeExternalCount).toBe(liveCount);
  });

  it("lists project sessions with one bulk snapshot", async () => {
    const { routes, codex } = routesFor(codexViews);

    const res = await routes.request(`/${PROJECT_ID}/sessions`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sessions: Array<{ id: string }> };

    expect(codex.calls.listSessionViews).toBe(1);
    expect(codex.calls.isSessionActive).toBe(0);
    expect(codex.calls.getSessionView).toBe(0);

    // Only live bridge sessions are merged into the project session list.
    expect(json.sessions).toHaveLength(liveCount);
  });

  it("does not count stale in-turn views the sidecar reports inactive", async () => {
    const { routes, codex } = routesFor([
      staleView("codex-stale"),
      view("codex-live", true),
    ]);

    const res = await routes.request("/");
    const json = (await res.json()) as {
      projects: Array<{ id: string; activeExternalCount: number }>;
    };

    expect(
      json.projects.find((item) => item.id === PROJECT_ID)?.activeExternalCount,
    ).toBe(1);
    expect(codex.calls.isSessionActive).toBe(0);
  });

  it("keeps bridge fan-out constant as the session count grows", async () => {
    const many = Array.from({ length: 600 }, (_, index) =>
      view(`codex-many-${index}`, index % 2 === 0),
    );
    const { routes, codex } = routesFor(many);

    await routes.request("/");

    expect(codex.calls.listSessionViews).toBe(1);
    expect(codex.calls.isSessionActive).toBe(0);
  });
});
