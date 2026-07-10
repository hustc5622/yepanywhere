import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexBridgeHttpClient } from "../../src/codex-bridge/CodexBridgeHttpClient.js";
import type {
  CodexBridgeSessionView,
  CodexUsageResponse,
} from "../../src/codex-bridge/types.js";

describe("CodexBridgeHttpClient", () => {
  let server: Server;
  let baseUrl: string;
  let sessionViews: CodexBridgeSessionView[];

  beforeEach(async () => {
    sessionViews = [
      createView("empty-idle", {
        messageCount: 0,
        activity: "idle",
      }),
      createView("active-empty", {
        messageCount: 0,
        activity: "in-turn",
      }),
      createView("has-messages", {
        messageCount: 1,
        activity: "idle",
      }),
    ];

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");

      if (url.pathname === "/session-views") {
        res.end(JSON.stringify({ sessions: sessionViews }));
        return;
      }

      if (url.pathname === "/usage") {
        res.end(
          JSON.stringify({
            usage: {
              primary: {
                usedPercent: 47,
                windowDurationMins: 300,
                resetsAt: 1_783_688_237,
              },
              secondary: null,
              planType: "pro",
              resetCredits: null,
              additionalBuckets: [],
              updatedAt: "2026-07-10T08:00:00.000Z",
            },
            error: null,
          } satisfies CodexUsageResponse),
        );
        return;
      }

      const match = url.pathname.match(/^\/sessions\/([^/]+)\/view$/);
      if (match) {
        const sessionView =
          sessionViews.find((view) => view.session.id === match[1]) ?? null;
        res.end(JSON.stringify({ sessionView }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("filters idle empty sidecar session views", async () => {
    const client = new CodexBridgeHttpClient({ baseUrl });

    await expect(client.listSessionViews()).resolves.toMatchObject([
      {
        session: { id: "active-empty", ownership: { owner: "external" } },
        activity: "in-turn",
      },
      {
        session: { id: "has-messages", ownership: { owner: "external" } },
        activity: "idle",
      },
    ]);
    await expect(client.getSessionView("empty-idle")).resolves.toBeNull();
    await expect(client.getSessionView("active-empty")).resolves.toMatchObject({
      session: { id: "active-empty", ownership: { owner: "external" } },
      activity: "in-turn",
    });
    await expect(client.getSessionView("has-messages")).resolves.toMatchObject({
      session: { id: "has-messages", ownership: { owner: "external" } },
      activity: "idle",
    });
  });

  it("reads account usage from the bridge sidecar", async () => {
    const client = new CodexBridgeHttpClient({ baseUrl });

    await expect(client.getUsage({ fresh: true })).resolves.toMatchObject({
      usage: { planType: "pro", primary: { usedPercent: 47 } },
      error: null,
    });
  });
});

function createView(
  id: string,
  options: { messageCount: number; activity: "idle" | "in-turn" },
): CodexBridgeSessionView {
  return {
    session: {
      id,
      projectId: "project-id",
      title: null,
      fullTitle: null,
      createdAt: "2026-06-10T08:00:00.000Z",
      updatedAt: "2026-06-10T08:00:00.000Z",
      messageCount: options.messageCount,
      ownership: { owner: "external" },
      provider: "codex",
      model: "openai",
      source: "codex-bridge",
    },
    projectName: "project",
    activity: options.activity,
  };
}
