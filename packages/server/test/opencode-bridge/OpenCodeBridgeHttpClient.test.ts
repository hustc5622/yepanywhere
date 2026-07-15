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
});
