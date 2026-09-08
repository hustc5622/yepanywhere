import { SessionDisplaySnapshotSchema } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { SessionDisplayService } from "../../src/display/SessionDisplayService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import { registerSessionDisplayRoutes } from "../../src/routes/session-display.js";
import { handleSessionSubscribe } from "../../src/routes/ws-handlers.js";
import type {
  Message,
  Project,
  SessionSummary,
} from "../../src/supervisor/types.js";

describe("session display HTTP / subscription contract", () => {
  it("uses the same snapshot on HTTP and WS, keeps closed details stable across appends and pages large bodies", async () => {
    const projectId = encodeProjectId("/tmp/display-contract");
    const project: Project = {
      id: projectId,
      path: "/tmp/display-contract",
      name: "fixture",
      sessionDir: "/tmp/display-contract",
      provider: "claude",
      sessionCount: 1,
      activeOwnedCount: 1,
      activeExternalCount: 0,
      lastActivity: null,
    };
    const summary: SessionSummary = {
      id: "session",
      projectId,
      provider: "claude",
      title: "Run",
      fullTitle: "Run",
      createdAt: "2026-09-07T00:00:00Z",
      updatedAt: "2026-09-07T00:00:01Z",
      messageCount: 4,
      ownership: { owner: "self" },
    };
    const messages: Message[] = [
      { uuid: "user", type: "user", message: { role: "user", content: "Run" } },
      {
        uuid: "call",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "a",
              name: "Bash",
              input: { command: "pnpm test" },
            },
          ],
        },
      },
      {
        uuid: "result",
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "a",
              content: "PRIVATE_TOOL_BODY".repeat(20_000),
            },
          ],
        },
      },
      {
        uuid: "progress",
        type: "assistant",
        message: { role: "assistant", content: "First stage done" },
      },
    ];
    const reader = {
      getSessionSummary: vi.fn(async () => summary),
      getSessionFileStats: vi.fn(async () => ({
        mtime: messages.length,
        size: messages.length,
      })),
      getSession: vi.fn(async () => ({
        summary,
        data: { provider: "codex", session: { entries: [] } },
        projectedMessages: messages,
      })),
    };
    let push: (type: string, data: unknown) => void = () => {};
    const runtime = {
      getProcessForSession: vi.fn(async () => ({ id: "p" }) as never),
      subscribeSession: vi.fn(async (_id: string, emit: typeof push) => {
        push = emit;
        return { cleanup: vi.fn() };
      }),
    };
    const service = new SessionDisplayService({ runtime, pollMs: 60_000 });
    const app = new Hono();
    registerSessionDisplayRoutes(app, {
      displayService: service,
      scanner: { getOrCreateProject: vi.fn(async () => project) },
      providerResolution: { readerFactory: () => reader as never },
      getRuntimeState: vi.fn(async () => ({
        provider: "claude",
        projectId,
        toolsMayBeActive: true,
      })),
    });
    try {
      const root = `/projects/${projectId}/sessions/session/display`;
      const response = await app.request(`${root}/view`);
      expect(response.status).toBe(200);
      const snapshot = SessionDisplaySnapshotSchema.parse(
        await response.json(),
      );
      expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_TOOL_BODY");
      const group = snapshot.nodes.find(
        (n) => n.type === "segment" && n.segment.type === "tool_group",
      );
      if (group?.type !== "segment" || group.segment.type !== "tool_group")
        throw new Error("Missing tool group");
      expect(group.segment.steps).toBeUndefined();
      expect(group.segment.toolNames).toEqual([]);
      const send = vi.fn();
      const subscriptions = new Map<string, () => void>();
      await handleSessionSubscribe(
        subscriptions,
        {
          type: "subscribe",
          subscriptionId: "sub",
          channel: "session",
          sessionId: "session",
          display: { projectId },
        },
        send,
        runtime as never,
        service,
      );
      expect(
        send.mock.calls.find(
          ([event]) => event.eventType === "display-snapshot",
        )?.[0].data,
      ).toEqual(snapshot);
      const next: Message = {
        uuid: "next",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "b",
              name: "Bash",
              input: { command: "pnpm build" },
            },
          ],
        },
      };
      messages.push(next);
      push("message", next);
      const updated = await service.snapshot({
        projectId,
        sessionId: "session",
      });
      expect(updated.nodes.some((n) => n.id === group.id)).toBe(true);
      expect(
        send.mock.calls.some(([event]) => event.eventType === "display-patch"),
      ).toBe(true);
      const details = await app.request(
        `${root}/groups/${encodeURIComponent(group.id)}`,
      );
      expect(details.status).toBe(200);
      const steps = (await details.json()) as {
        steps: Array<{ id: string; summary: string; preview: string }>;
      };
      const toolId = steps.steps[0]?.id;
      expect(toolId).toBeDefined();
      expect(steps.steps[0]?.summary).toBe("pnpm test");
      expect(steps.steps[0]?.preview).toBe("");
      expect(JSON.stringify(steps)).not.toContain("PRIVATE_TOOL_BODY");
      const tool = await app.request(
        `${root}/tools/${encodeURIComponent(String(toolId))}`,
      );
      expect(tool.status).toBe(200);
      const body = (await tool.json()) as {
        rawJson: { content: string; offset: number; total: number };
        nextCursor: string;
      };
      expect(body.rawJson.content.length).toBeLessThanOrEqual(128 * 1024);
      expect(body.rawJson.total).toBeGreaterThan(body.rawJson.content.length);
      expect(body.rawJson.content).toContain("PRIVATE_TOOL_BODY");
      const second = await app.request(
        `${root}/tools/${encodeURIComponent(String(toolId))}?cursor=${encodeURIComponent(body.nextCursor)}`,
      );
      expect(second.status).toBe(200);
      expect(
        ((await second.json()) as { rawJson: { offset: number } }).rawJson
          .offset,
      ).toBe(body.rawJson.content.length);
      expect(JSON.stringify(send.mock.calls)).not.toContain(
        "PRIVATE_TOOL_BODY",
      );
      subscriptions.get("sub")?.();
    } finally {
      service.dispose();
    }
  });
});
