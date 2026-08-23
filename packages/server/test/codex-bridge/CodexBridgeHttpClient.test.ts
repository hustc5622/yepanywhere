import { type Server, type ServerResponse, createServer } from "node:http";
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
  let requestPaths: string[];
  let fullSnapshotEtags: Array<string | undefined>;
  let revision: number;
  let eventSubscribers: Set<ServerResponse>;
  let sendChange: (input: {
    revision: number;
    baseRevision: number;
    changedSessionIds: string[];
    split?: boolean;
  }) => void;
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
    requestPaths = [];
    fullSnapshotEtags = [];
    revision = 1;
    eventSubscribers = new Set();
    sendChange = (input) => {
      const frame = `event: changed\ndata: ${JSON.stringify({
        revision: input.revision,
        baseRevision: input.baseRevision,
        changedSessionIds: input.changedSessionIds,
      })}\n\n`;
      for (const subscriber of eventSubscribers) {
        if (input.split) {
          const splitAt = Math.floor(frame.length / 2);
          subscriber.write(frame.slice(0, splitAt));
          subscriber.write(frame.slice(splitAt));
        } else {
          subscriber.write(frame);
        }
      }
    };
    controlRequests = [];

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      requestPaths.push(url.pathname);
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

      if (url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write(": connected\n\n");
        eventSubscribers.add(res);
        res.on("close", () => eventSubscribers.delete(res));
        return;
      }

      if (url.pathname === "/session-views") {
        fullSnapshotEtags.push(req.headers["if-none-match"]);
        const etag = `W/"${revision}"`;
        res.setHeader("etag", etag);
        if (req.headers["if-none-match"] === etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.end(JSON.stringify({ revision, sessions: sessionViews }));
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
    for (const subscriber of eventSubscribers) subscriber.end();
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

  it("records poll reason, snapshot bytes, and unchanged snapshots", async () => {
    const eventBus = {
      emit: vi.fn(),
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
      await waitFor(() => client.getPollDebugStats().polls >= 2);
      const stats = client.getPollDebugStats();
      expect(stats.snapshotBytes).toBeGreaterThan(0);
      expect(stats.lastSnapshotBytes).toBe(0);
      expect(stats.reasons.startup).toBe(1);
      expect(stats.reasons.interval).toBeGreaterThanOrEqual(1);
      expect(stats.unchangedPolls).toBeGreaterThanOrEqual(1);
      expect(requestPaths).not.toContain("/sessions");
    } finally {
      client.shutdown();
    }
  });

  it("scales a 1000-session change with changed count and recovers deletes and lost events", async () => {
    sessionViews = Array.from({ length: 1_000 }, (_, index) =>
      createView(`session-${index}`, { messageCount: 1, activity: "idle" }),
    );
    const emitted: Array<Record<string, unknown>> = [];
    const eventBus = {
      emit: vi.fn((event: Record<string, unknown>) => emitted.push(event)),
      subscribe: vi.fn(),
      subscriberCount: 0,
    } as unknown as EventBus;
    const client = new CodexBridgeHttpClient({
      baseUrl,
      eventBus,
      pollIntervalMs: 300,
    });
    client.start();
    try {
      await waitFor(
        () =>
          client.getPollDebugStats().fullPolls >= 1 &&
          eventSubscribers.size === 1,
      );
      const baseline = client.getPollDebugStats();
      emitted.length = 0;

      const changed = sessionViews[500];
      if (!changed) throw new Error("missing fixture view");
      changed.session.title = "renamed";
      changed.session.updatedAt = "2026-06-10T08:01:00.000Z";
      changed.session.lastTurnStatus = "failed";
      changed.session.lastErrorMessage = "provider failed";
      changed.activity = "waiting-input";
      changed.pendingInputType = "tool-approval";
      changed.pendingInputRequestId = "approval-1";
      revision = 2;
      sendChange({
        revision,
        baseRevision: 1,
        changedSessionIds: [changed.session.id],
        split: true,
      });

      await waitFor(() => client.getPollDebugStats().targetedPolls === 1);
      const afterTargeted = client.getPollDebugStats();
      expect(
        afterTargeted.parsedSessionViews - baseline.parsedSessionViews,
      ).toBe(1);
      expect(afterTargeted.lastSnapshotBytes).toBeLessThan(
        baseline.lastSnapshotBytes / 20,
      );
      expect(
        requestPaths.filter(
          (path) => path === `/sessions/${changed.session.id}/view`,
        ),
      ).toHaveLength(1);
      expect(requestPaths).not.toContain("/session-views/delta");
      expect(
        emitted.some(
          (event) =>
            event.type === "session-updated" &&
            event.sessionId === changed.session.id &&
            event.title === "renamed",
        ),
      ).toBe(true);
      expect(
        emitted.some(
          (event) =>
            event.type === "process-state-changed" &&
            event.sessionId === changed.session.id &&
            event.pendingInputType === "tool-approval" &&
            event.lastTurnStatus === "failed",
        ),
      ).toBe(true);
      expect(
        emitted.some(
          (event) =>
            event.type === "session-status-changed" &&
            (event.ownership as { owner?: string } | undefined)?.owner ===
              "none",
        ),
      ).toBe(false);

      const fullRequestsAfterTargeted = fullSnapshotEtags.length;
      const parsedAfterTargeted = afterTargeted.parsedSessionViews;
      await waitFor(
        () => fullSnapshotEtags.length >= fullRequestsAfterTargeted + 2,
      );
      expect(fullSnapshotEtags.slice(fullRequestsAfterTargeted)).toEqual(
        expect.arrayContaining(['W/"2"', 'W/"2"']),
      );
      expect(client.getPollDebugStats().parsedSessionViews).toBe(
        parsedAfterTargeted,
      );

      sessionViews = sessionViews.filter(
        (view) => view.session.id !== changed.session.id,
      );
      revision = 3;
      sendChange({
        revision,
        baseRevision: 2,
        changedSessionIds: [changed.session.id],
      });
      await waitFor(() => client.getPollDebugStats().targetedPolls === 2);
      expect(
        emitted.some(
          (event) =>
            event.type === "session-status-changed" &&
            event.sessionId === changed.session.id &&
            (event.ownership as { owner?: string } | undefined)?.owner ===
              "none",
        ),
      ).toBe(true);

      const fullPollsBeforeRecovery = client.getPollDebugStats().fullPolls;
      revision = 5;
      sendChange({
        revision,
        baseRevision: 4,
        changedSessionIds: ["session-700"],
      });
      await waitFor(
        () => client.getPollDebugStats().fullPolls > fullPollsBeforeRecovery,
      );
      expect(client.getPollDebugStats().parsedSessionViews).toBeGreaterThan(
        afterTargeted.parsedSessionViews + 900,
      );
    } finally {
      client.shutdown();
    }
  });

  it("refreshes more than 1000 changed IDs without a query-string delta payload", async () => {
    sessionViews = Array.from({ length: 1_001 }, (_, index) =>
      createView(`wide-${index}`, { messageCount: 1, activity: "idle" }),
    );
    const eventBus = {
      emit: vi.fn(),
      subscribe: vi.fn(),
      subscriberCount: 0,
    } as unknown as EventBus;
    const client = new CodexBridgeHttpClient({
      baseUrl,
      eventBus,
      pollIntervalMs: 60_000,
    });
    client.start();
    try {
      await waitFor(
        () =>
          client.getPollDebugStats().fullPolls >= 1 &&
          eventSubscribers.size === 1,
      );
      const baseline = client.getPollDebugStats().parsedSessionViews;
      revision = 2;
      sendChange({
        revision,
        baseRevision: 1,
        changedSessionIds: sessionViews.map((view) => view.session.id),
      });

      await waitFor(
        () => client.getPollDebugStats().targetedPolls === 1,
        5_000,
      );
      expect(client.getPollDebugStats().parsedSessionViews - baseline).toBe(
        1_001,
      );
      const targetedPaths = requestPaths.filter((path) =>
        path.endsWith("/view"),
      );
      expect(targetedPaths).toHaveLength(1_001);
      expect(
        Math.max(...targetedPaths.map((path) => path.length)),
      ).toBeLessThan(100);
      expect(requestPaths).not.toContain("/session-views/delta");
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
