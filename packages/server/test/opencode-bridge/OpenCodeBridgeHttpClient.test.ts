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
});
