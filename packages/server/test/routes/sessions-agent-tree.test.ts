import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { invalidateCodexSessionManifest } from "../../src/sessions/codex-session-manifest.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

describe("GET /projects/:projectId/sessions/:root/agent-tree/:agent", () => {
  let testDir: string;
  let project: Project;
  let reader: CodexSessionReader;
  let routes: ReturnType<typeof createSessionsRoutes>;
  const rootId = "root-thread";
  const primaryReader = {
    getSessionSummary: vi.fn(
      async (
        _id: string,
        _projectId: UrlProjectId,
      ): Promise<SessionSummary | null> => null,
    ),
    getAgentSession: vi.fn(async () => null),
  };

  beforeEach(async () => {
    primaryReader.getSessionSummary.mockReset().mockResolvedValue(null);
    primaryReader.getAgentSession.mockClear();
    testDir = join(tmpdir(), `agent-tree-route-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    const projectPath = "/test/mixed-provider";
    project = {
      id: encodeProjectId(projectPath),
      path: projectPath,
      name: "mixed-provider",
      sessionDir: join(testDir, "claude"),
      provider: "claude",
      sessionCount: 1,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
    };
    const now = new Date().toISOString();
    const threads = [
      { id: rootId },
      { id: "child", parent: rootId },
      { id: "sibling", parent: rootId },
      { id: "grandchild", parent: "child" },
      { id: "other-root" },
      { id: "unrelated", parent: "other-root" },
      { id: "other-project", parent: rootId, cwd: "/another/project" },
      { id: "cycle-a", parent: "cycle-b" },
      { id: "cycle-b", parent: "cycle-a" },
    ];
    for (const { id, parent, cwd = projectPath } of threads) {
      const entries = [
        {
          type: "session_meta",
          timestamp: now,
          payload: {
            id,
            cwd,
            timestamp: now,
            source: "vscode",
            ...(parent ? { parent_thread_id: parent } : {}),
          },
        },
        {
          type: "event_msg",
          timestamp: now,
          payload: { type: "user_message", message: "Review changes" },
        },
        ...(id === "child"
          ? [
              {
                type: "event_msg",
                timestamp: now,
                payload: {
                  type: "item_completed",
                  thread_id: id,
                  turn_id: "child-turn",
                  item: {
                    type: "SubAgentActivity",
                    id: "spawn-grandchild",
                    kind: "started",
                    agent_thread_id: "grandchild",
                    agent_path: "/root/child/grandchild",
                  },
                },
              },
            ]
          : []),
        {
          type: "response_item",
          timestamp: now,
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "**Nested** review" }],
          },
        },
        {
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "task_complete",
            turn_id: "child-turn",
            last_agent_message: "Review complete",
          },
        },
      ];
      await writeFile(
        join(testDir, `${id}.jsonl`),
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
    }
    reader = new CodexSessionReader({ sessionsDir: testDir, projectPath });
    routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async (id: string) =>
          id === project.id ? project : null,
        ),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: () => primaryReader as unknown as ISessionReader,
      codexSessionsDir: testDir,
      codexReaderFactory: () => reader,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    invalidateCodexSessionManifest(testDir);
    await rm(testDir, { recursive: true, force: true });
  });

  const requestPath = (projectId: string, agentId: string) =>
    `/projects/${projectId}/sessions/${rootId}/agent-tree/${agentId}`;

  it.each([
    ["child", rootId],
    ["sibling", rootId],
    ["grandchild", "child"],
  ])(
    "resolves %s through its Codex root in a Claude-primary project",
    async (agentId, parentId) => {
      const summary = vi.spyOn(reader, "getSessionSummary");
      const response = await routes.request(requestPath(project.id, agentId));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        status: "completed",
        descriptor: { agentId, parentAgentId: parentId },
      });
      expect(body.messages.length).toBeGreaterThan(0);
      expect(JSON.stringify(body.messages)).toContain(
        "<strong>Nested</strong>",
      );
      expect(primaryReader.getSessionSummary).toHaveBeenCalledWith(
        rootId,
        project.id,
      );
      expect(summary).toHaveBeenCalledWith(rootId, project.id);
      expect(summary.mock.calls.every(([id]) => id === rootId)).toBe(true);
      expect(primaryReader.getAgentSession).not.toHaveBeenCalled();
      if (agentId === "child") {
        expect(body.messages).toContainEqual(
          expect.objectContaining({
            type: "system",
            subtype: "codex_native_item",
            codexThreadItem: expect.objectContaining({
              type: "subAgentActivity",
              agentThreadId: "grandchild",
              agentPath: "/root/child/grandchild",
            }),
          }),
        );
      }
    },
  );

  it.each([rootId, "unrelated", "other-project", "cycle-a", "missing"])(
    "returns 404 for an unverified descendant %s",
    async (agentId) => {
      for (const query of ["", "?includeInheritedContext=true"]) {
        const response = await routes.request(
          requestPath(project.id, agentId) + query,
        );
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
          error: "Agent session not found",
        });
      }
    },
  );

  it("returns and augments inherited snapshot content only when explicitly requested", async () => {
    const timestamp = new Date().toISOString();
    const entries = [
      {
        ordinal: 0,
        type: "session_meta",
        payload: {
          id: "context-child",
          cwd: project.path,
          timestamp,
          parent_thread_id: rootId,
          subagent_history_start_ordinal: 4,
        },
      },
      {
        ordinal: 1,
        type: "session_meta",
        payload: { id: rootId, cwd: project.path, timestamp },
      },
      {
        ordinal: 2,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "**Inherited** snapshot" }],
        },
      },
      {
        ordinal: 3,
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "parent-turn",
          last_agent_message: "Parent is done",
        },
      },
      {
        ordinal: 4,
        type: "event_msg",
        payload: { type: "task_started", turn_id: "own-turn" },
      },
      {
        ordinal: 5,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "**Own** progress" }],
        },
      },
    ];
    await writeFile(
      join(testDir, "context-child.jsonl"),
      `${entries.map((entry) => JSON.stringify({ timestamp, ...entry })).join("\n")}\n`,
    );
    const path = requestPath(project.id, "context-child");
    for (const query of [
      "",
      "?includeInheritedContext=false",
      "?includeInheritedContext=1",
    ]) {
      const response = await routes.request(path + query);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.hasInheritedContext).toBe(true);
      expect(body).not.toHaveProperty("inheritedMessages");
      expect(JSON.stringify(body)).not.toContain("**Inherited** snapshot");
      expect(body.status).toBe("running");
    }
    const response = await routes.request(
      `${path}?includeInheritedContext=true`,
    );
    expect(response.status).toBe(200);
    const expanded = await response.json();
    expect(expanded.hasInheritedContext).toBe(true);
    expect(JSON.stringify(expanded.inheritedMessages)).toContain(
      "<strong>Inherited</strong> snapshot",
    );
    expect(JSON.stringify(expanded.inheritedMessages)).not.toContain("Own");
    expect(JSON.stringify(expanded.messages)).toContain(
      "<strong>Own</strong> progress",
    );
    expect(JSON.stringify(expanded.messages)).not.toContain("Inherited");
    expect(expanded.status).toBe("running");
    expect(expanded.descriptor.parentAgentId).toBe(rootId);
  });

  it("keeps the direct-agent endpoint limited to the immediate parent", async () => {
    const response = await routes.request(
      `/projects/${project.id}/sessions/${rootId}/agents/grandchild`,
    );
    expect(response.status).toBe(404);
    const direct = await routes.request(
      `/projects/${project.id}/sessions/${rootId}/agents/child`,
    );
    expect(direct.status).toBe(200);
  });

  it("returns 404 when the root provider has no tree reader", async () => {
    const summary = await reader.getSessionSummary(rootId, project.id);
    if (!summary) throw new Error("Root fixture is missing");
    primaryReader.getSessionSummary.mockResolvedValue({
      ...summary,
      provider: "claude",
    });
    const readTree = vi.spyOn(reader, "getAgentSessionInTree");
    const response = await routes.request(requestPath(project.id, "child"));
    expect(response.status).toBe(404);
    expect(readTree).not.toHaveBeenCalled();
    expect(primaryReader.getAgentSession).not.toHaveBeenCalled();
  });

  it("rejects invalid or absent projects before resolving the reader", async () => {
    const invalid = await routes.request(requestPath("!invalid", "child"));
    expect(invalid.status).toBe(400);
    const absent = await routes.request(
      requestPath(encodeProjectId("/absent"), "child"),
    );
    expect(absent.status).toBe(404);
    expect(primaryReader.getSessionSummary).not.toHaveBeenCalled();
  });
});
