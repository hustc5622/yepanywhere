import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexBridgeHttpClient } from "../../src/codex-bridge/CodexBridgeHttpClient.js";
import type {
  CodexBridgeSession,
  CodexBridgeSessionView,
  CodexUsageResponse,
} from "../../src/codex-bridge/types.js";
import type { EventBus } from "../../src/watcher/index.js";

describe("CodexBridgeHttpClient", () => {
  let server: Server;
  let baseUrl: string;
  let sessionViews: CodexBridgeSessionView[];
  let sidecarAvailable: boolean;
  let controlRequests: Array<{
    path: string;
    authorization?: string;
    body: Record<string, unknown>;
  }>;

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
    sidecarAvailable = true;
    controlRequests = [];

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");

      if (!sidecarAvailable) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "temporarily unavailable" }));
        return;
      }

      if (url.pathname === "/sessions") {
        res.end(
          JSON.stringify({
            sessions: sessionViews.map(createSessionFromView),
          }),
        );
        return;
      }

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

      if (
        req.method === "POST" &&
        (url.pathname.endsWith("/input-binding") ||
          url.pathname.endsWith("/input"))
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        controlRequests.push({
          path: url.pathname,
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >,
        });
        res.end(
          JSON.stringify(
            url.pathname.endsWith("/input-binding")
              ? { bound: true }
              : { accepted: true },
          ),
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

  it("carries the authenticated central broker claim to the sidecar", async () => {
    const client = new CodexBridgeHttpClient({
      baseUrl,
      authToken: "shared-control-token",
    });
    const binding = {
      operationId: "int_12345678-1234-4234-8234-123456789abc",
      operationVersion: 2,
    };

    await expect(
      client.bindPendingInputInteraction(
        "bridge-session",
        "bridge-request",
        binding,
      ),
    ).resolves.toBe(true);
    await expect(
      client.respondToInput(
        "bridge-session",
        "bridge-request",
        "approve",
        undefined,
        {
          ...binding,
          operationVersion: 3,
          actor: { id: "feishu-user", channel: "feishu" },
        },
      ),
    ).resolves.toBe(true);

    expect(controlRequests).toEqual([
      {
        path: "/sessions/bridge-session/input-binding",
        authorization: "Bearer shared-control-token",
        body: { requestId: "bridge-request", ...binding },
      },
      {
        path: "/sessions/bridge-session/input",
        authorization: "Bearer shared-control-token",
        body: {
          requestId: "bridge-request",
          response: "approve",
          operationId: binding.operationId,
          operationVersion: 3,
          actor: { id: "feishu-user", channel: "feishu" },
        },
      },
    ]);
  });

  it("keeps the last Codex poll snapshot during a transient sidecar outage", async () => {
    const emitted: unknown[] = [];
    const eventBus = {
      emit: vi.fn((event) => emitted.push(event)),
      subscribe: vi.fn(),
      subscriberCount: 0,
    } as unknown as EventBus;
    const client = new CodexBridgeHttpClient({
      baseUrl,
      eventBus,
      pollIntervalMs: 10,
    });
    client.start();
    try {
      await waitFor(() =>
        emitted.some(
          (event) =>
            (event as { type?: string; session?: { id?: string } }).type ===
              "session-created" &&
            (event as { session?: { id?: string } }).session?.id ===
              "active-empty",
        ),
      );
      emitted.length = 0;
      sidecarAvailable = false;
      await delay(40);

      expect(
        emitted.some(
          (event) =>
            (event as { type?: string }).type === "session-status-changed" &&
            (event as { ownership?: { owner?: string } }).ownership?.owner ===
              "none",
        ),
      ).toBe(false);
    } finally {
      client.shutdown();
    }
  });
});

function createSessionFromView(
  view: CodexBridgeSessionView,
): CodexBridgeSession {
  return {
    id: view.session.id,
    projectId: view.session.projectId,
    projectPath: "/tmp/project",
    projectName: view.projectName,
    title: view.session.title,
    fullTitle: view.session.fullTitle,
    createdAt: view.session.createdAt,
    updatedAt: view.session.updatedAt,
    messageCount: view.session.messageCount,
    provider: "codex",
    model: view.session.model,
    activity: view.activity,
    connectionIds: [1],
  };
}

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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await delay(10);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
