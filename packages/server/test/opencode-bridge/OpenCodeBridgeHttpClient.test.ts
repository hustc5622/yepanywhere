import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeBridgeHttpClient } from "../../src/opencode-bridge/OpenCodeBridgeHttpClient.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected TCP address"));
        return;
      }
      servers.push(server);
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("OpenCodeBridgeHttpClient", () => {
  it("resolves session liveness with a single sidecar request", async () => {
    const requests: string[] = [];
    const bridge = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url === "/sessions/ses_live/view") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionView: {
              session: {
                id: "ses_live",
                projectId: "project_1",
                title: "Live OpenCode session",
                fullTitle: "Live OpenCode session",
                createdAt: "2026-07-20T08:50:00.000Z",
                updatedAt: "2026-07-20T08:50:01.000Z",
                messageCount: 1,
                ownership: { owner: "external" },
                provider: "opencode",
                activity: "in-turn",
              },
              projectName: "demo",
              activity: "in-turn",
              active: true,
            },
          }),
        );
        return;
      }
      if (req.url === "/sessions/ses_idle/view") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionView: {
              session: {
                id: "ses_idle",
                projectId: "project_1",
                title: "Idle OpenCode session",
                fullTitle: "Idle OpenCode session",
                createdAt: "2026-07-20T08:00:00.000Z",
                updatedAt: "2026-07-20T08:10:00.000Z",
                messageCount: 7,
                ownership: { owner: "none" },
                provider: "opencode",
              },
              projectName: "demo",
              active: false,
            },
          }),
        );
        return;
      }
      if (req.url === "/sessions/ses_stale/view") {
        // TUI died mid-turn: still tagged in-turn, but reported inactive.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionView: {
              session: {
                id: "ses_stale",
                projectId: "project_1",
                title: "Stale OpenCode session",
                fullTitle: "Stale OpenCode session",
                createdAt: "2026-07-20T08:00:00.000Z",
                updatedAt: "2026-07-20T08:10:00.000Z",
                messageCount: 3,
                ownership: { owner: "none" },
                provider: "opencode",
                activity: "in-turn",
              },
              projectName: "demo",
              activity: "in-turn",
              active: false,
            },
          }),
        );
        return;
      }
      if (req.url === "/sessions/ses_empty/view") {
        // Not displayable: no messages and no live runtime state.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionView: {
              session: {
                id: "ses_empty",
                projectId: "project_1",
                title: null,
                fullTitle: null,
                createdAt: "2026-07-20T08:00:00.000Z",
                updatedAt: "2026-07-20T08:00:00.000Z",
                messageCount: 0,
                ownership: { owner: "none" },
                provider: "opencode",
              },
              projectName: "demo",
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new OpenCodeBridgeHttpClient({
      baseUrl: await listen(bridge),
    });

    await expect(client.isSessionActive("ses_live")).resolves.toBe(true);
    // Exactly one request: probing `/active` and `/view` in parallel doubled
    // every liveness check and, with it, the sidecar's upstream fan-out.
    expect(requests).toEqual(["/sessions/ses_live/view"]);

    requests.length = 0;
    await expect(client.isSessionActive("ses_idle")).resolves.toBe(false);
    expect(requests).toEqual(["/sessions/ses_idle/view"]);

    // The sidecar verdict wins over the view's own activity field.
    requests.length = 0;
    await expect(client.isSessionActive("ses_stale")).resolves.toBe(false);
    expect(requests).toEqual(["/sessions/ses_stale/view"]);

    // Undisplayable and unknown sessions stay inactive, as before.
    requests.length = 0;
    await expect(client.isSessionActive("ses_empty")).resolves.toBe(false);
    await expect(client.isSessionActive("ses_missing")).resolves.toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.endsWith("/view"))).toBe(true);
  });

  it("polls the session-view snapshot once instead of synchronizing twice", async () => {
    let sessionsRequests = 0;
    let sessionViewRequests = 0;
    const bridge = createServer((req, res) => {
      if (req.url === "/sessions") {
        sessionsRequests += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessions: [] }));
        return;
      }
      if (req.url === "/session-views") {
        sessionViewRequests += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessions: [
              {
                session: {
                  id: "ses_live",
                  projectId: "project_1",
                  title: "Live OpenCode session",
                  fullTitle: "Live OpenCode session",
                  createdAt: "2026-07-10T08:50:00.000Z",
                  updatedAt: "2026-07-10T08:50:01.000Z",
                  messageCount: 1,
                  ownership: { owner: "external" },
                  provider: "opencode",
                  activity: "in-turn",
                },
                projectName: "demo",
                activity: "in-turn",
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const eventBus = { emit: vi.fn() };
    const client = new OpenCodeBridgeHttpClient({
      baseUrl: await listen(bridge),
      eventBus: eventBus as never,
    });

    await (
      client as unknown as { pollSessions: () => Promise<void> }
    ).pollSessions();

    expect(sessionViewRequests).toBe(1);
    expect(sessionsRequests).toBe(0);
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session-created",
        session: expect.objectContaining({ id: "ses_live" }),
      }),
    );
  });

  it("coalesces a burst of push signals into one leading and one trailing poll", async () => {
    let sessionViewRequests = 0;
    const bridge = createServer((req, res) => {
      if (req.url === "/session-views") {
        sessionViewRequests += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessions: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const eventBus = { emit: vi.fn() };
    const client = new OpenCodeBridgeHttpClient({
      baseUrl: await listen(bridge),
      eventBus: eventBus as never,
    });
    const internals = client as unknown as { requestPoll: () => void };

    try {
      for (let index = 0; index < 30; index += 1) internals.requestPoll();

      await vi.waitFor(() => expect(sessionViewRequests).toBe(1));
      // Still one poll well inside the 200ms window: the remaining 29 signals
      // were collapsed rather than each costing a bridge request.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(sessionViewRequests).toBe(1);

      // The collapsed signals are not dropped - one trailing poll re-reads the
      // final state once the window elapses.
      await vi.waitFor(() => expect(sessionViewRequests).toBe(2), {
        timeout: 1_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(sessionViewRequests).toBe(2);
    } finally {
      client.shutdown();
    }
  });

  it("collapses push signals that race an in-flight poll into one trailing poll", async () => {
    let sessionViewRequests = 0;
    const bridge = createServer((req, res) => {
      if (req.url === "/session-views") {
        sessionViewRequests += 1;
        // Slow enough that every later signal arrives while the poll runs.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ sessions: [] }));
        }, 120);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const eventBus = { emit: vi.fn() };
    const client = new OpenCodeBridgeHttpClient({
      baseUrl: await listen(bridge),
      eventBus: eventBus as never,
    });
    const internals = client as unknown as {
      pollSessions: () => Promise<void>;
      requestPoll: () => void;
    };

    try {
      const leading = internals.pollSessions();
      for (let index = 0; index < 50; index += 1) internals.requestPoll();
      await leading;

      // One leading poll plus at most one merged trailing refresh - not one
      // poll per signal, and not a self-sustaining poll loop.
      await vi.waitFor(() => expect(sessionViewRequests).toBe(2), {
        timeout: 2_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(sessionViewRequests).toBe(2);
    } finally {
      client.shutdown();
    }
  });

  it("emits runtime state changes without overwriting persisted session content", () => {
    const eventBus = { emit: vi.fn() };
    const client = new OpenCodeBridgeHttpClient({
      baseUrl: "http://127.0.0.1:1",
      eventBus: eventBus as never,
    });
    type TestView = {
      session: {
        id: string;
        projectId: string;
        title: string;
        updatedAt: string;
        messageCount: number;
        ownership: { owner: "external" };
        provider: "opencode";
        activity: "in-turn" | "waiting-input";
      };
      projectName: string;
      activity: "in-turn" | "waiting-input";
    };
    const rawEmitChanges = (
      client as unknown as {
        emitChanges: (entry: {
          id: string;
          view: TestView;
          state: {
            projectId: string;
            activity: "in-turn" | "waiting-input";
            pendingInputType?: string;
            active: boolean;
          };
        }) => void;
      }
    ).emitChanges.bind(client);
    // Mirrors OpenCodeBridgeHttpClient.collectPollEntries: lifecycle state is
    // derived from the session view before diffing.
    const emitChanges = (view: TestView) =>
      rawEmitChanges({
        id: view.session.id,
        view,
        state: {
          projectId: view.session.projectId,
          activity: view.session.activity,
          active: true,
        },
      });

    const view = {
      session: {
        id: "ses_live",
        projectId: "project_1",
        title: "Generated OpenCode title",
        updatedAt: "2026-07-10T09:00:00.000Z",
        messageCount: 1,
        ownership: { owner: "external" as const },
        provider: "opencode" as const,
        activity: "in-turn" as const,
      },
      projectName: "demo",
      activity: "in-turn" as const,
    };

    emitChanges(view);
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session-updated" }),
    );

    eventBus.emit.mockClear();
    emitChanges({
      ...view,
      session: {
        ...view.session,
        title: "A later generated title",
        updatedAt: "2026-07-10T09:00:01.000Z",
        messageCount: 2,
      },
    });
    expect(eventBus.emit).not.toHaveBeenCalled();

    emitChanges({
      ...view,
      session: { ...view.session, activity: "waiting-input" },
      activity: "waiting-input",
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "process-state-changed",
        activity: "waiting-input",
      }),
    );
  });

  it("suppresses external ownership for Supervisor-owned sessions", () => {
    const eventBus = { emit: vi.fn() };
    const client = new OpenCodeBridgeHttpClient({
      baseUrl: "http://127.0.0.1:1",
      eventBus: eventBus as never,
    });
    // The local Supervisor owns "ses_owned" but not "ses_external".
    client.setOwnershipResolver((sessionId) => sessionId === "ses_owned");

    const rawEmitChanges = (
      client as unknown as {
        emitChanges: (entry: {
          id: string;
          view: { session: { id: string }; projectName: string };
          state: { projectId: string; activity: string; active: boolean };
        }) => void;
      }
    ).emitChanges.bind(client);
    const emitChangesFor = (id: string) =>
      rawEmitChanges({
        id,
        view: { session: { id }, projectName: "demo" },
        state: { projectId: "project_1", activity: "in-turn", active: true },
      });

    const ownershipEvents = () =>
      eventBus.emit.mock.calls.filter(
        ([event]) =>
          (event as { type?: string }).type === "session-status-changed",
      );

    // Owned session: no external ownership event should reach the EventBus.
    emitChangesFor("ses_owned");
    expect(
      ownershipEvents().some(
        ([event]) =>
          (event as { sessionId?: string }).sessionId === "ses_owned",
      ),
    ).toBe(false);

    // Unowned session: external ownership is still reported as before.
    emitChangesFor("ses_external");
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session-status-changed",
        sessionId: "ses_external",
        ownership: { owner: "external" },
      }),
    );
  });
});
