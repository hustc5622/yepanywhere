import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionBranchState } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  type SessionDisplayRuntimeState,
  registerSessionDisplayRoutes,
} from "../../src/routes/session-display.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { invalidateCodexSessionManifest } from "../../src/sessions/codex-session-manifest.js";
import { PiSessionReader } from "../../src/sessions/pi-reader.js";
import type { LoadedSession } from "../../src/sessions/types.js";
import type {
  Message,
  Project,
  SessionSummary,
} from "../../src/supervisor/types.js";

const PROJECT_PATH = "/tmp/session-display-project";
const PROJECT_ID = encodeProjectId(PROJECT_PATH);
const SESSION_ID = "session-display-fixture";
const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  for (const dir of dirs) invalidateCodexSessionManifest(dir);
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function project(): Project {
  return {
    id: PROJECT_ID,
    path: PROJECT_PATH,
    name: "session-display-project",
    sessionCount: 1,
    sessionDir: "/tmp/session-display-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function buildMessages(
  turnCount: number,
  toolsPerTurn = 1,
  leaveLastTurnOpen = false,
): Message[] {
  const messages: Message[] = [];
  for (let turn = 0; turn < turnCount; turn += 1) {
    messages.push({
      uuid: `user-${turn}`,
      type: "user",
      message: { role: "user", content: `Question ${turn}` },
      timestamp: `2026-09-01T00:${String(turn).padStart(2, "0")}:00.000Z`,
    });
    const toolBlocks = Array.from({ length: toolsPerTurn }, (_, tool) => ({
      type: "tool_use",
      id: `tool-${turn}-${tool}`,
      name: tool % 2 === 0 ? "Read" : "Bash",
      input:
        tool % 2 === 0
          ? { file_path: `/private/fixture-${turn}-${tool}.ts` }
          : { command: "pnpm test" },
    }));
    messages.push({
      uuid: `assistant-tools-${turn}`,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Progress ${turn}` }, ...toolBlocks],
      },
    });
    for (let tool = 0; tool < toolsPerTurn; tool += 1) {
      messages.push({
        uuid: `result-${turn}-${tool}`,
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `tool-${turn}-${tool}`,
              content: `TOOL_BODY_${turn}_${tool}:${"x".repeat(2_000)}`,
            },
          ],
        },
      });
    }
    if (!leaveLastTurnOpen || turn < turnCount - 1) {
      messages.push({
        uuid: `assistant-final-${turn}`,
        type: "assistant",
        message: { role: "assistant", content: `Answer ${turn}` },
      });
    }
  }
  return messages;
}

function countToolUses(messages: Message[]): number {
  return messages.reduce((total, message) => {
    const content = message.message?.content ?? message.content;
    return (
      total +
      (Array.isArray(content)
        ? content.filter((block) => block.type === "tool_use").length
        : 0)
    );
  }, 0);
}

function createRoutes(
  turnCount: number,
  toolsPerTurn = 1,
  indexedQuestionText?: string,
  runtime?: SessionDisplayRuntimeState,
  leaveLastTurnOpen = false,
) {
  const messages = buildMessages(turnCount, toolsPerTurn, leaveLastTurnOpen);
  let revision = 1;
  const summary = (): SessionSummary => ({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    title: "Display fixture",
    fullTitle: "Display fixture",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: `2026-09-01T00:00:0${revision}.000Z`,
    messageCount: messages.length,
    userQuestions: Array.from({ length: turnCount }, (_, turn) => ({
      id: `user-${turn}`,
      text: indexedQuestionText ?? `Question ${turn}`,
      timestamp: `2026-09-01T00:${String(turn).padStart(2, "0")}:00.000Z`,
    })),
    ownership: { owner: "none" },
    provider: "codex",
  });
  const getSession = vi.fn(
    async (): Promise<LoadedSession> => ({
      summary: summary(),
      data: { provider: "codex", session: { entries: [] } },
      projectedMessages: structuredClone(messages),
    }),
  );
  const reader = {
    getSession,
    getSessionSummary: vi.fn(async () => summary()),
    getSessionFileStats: vi.fn(async () => ({
      mtime: revision,
      size: messages.length,
    })),
  };
  const app = new Hono();
  registerSessionDisplayRoutes(app, {
    scanner: { getOrCreateProject: vi.fn(async () => project()) },
    providerResolution: {
      readerFactory: () => reader as never,
    },
    ...(runtime ? { getRuntimeState: vi.fn(async () => runtime) } : {}),
  });
  return {
    app,
    getSession,
    advanceRevision: () => {
      revision += 1;
    },
  };
}

describe("session display routes", () => {
  it("annotates native Codex fork questions with cross-session alternatives", async () => {
    const summary: SessionSummary = {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      title: "Fork child",
      fullTitle: "Fork child",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:03:00.000Z",
      messageCount: 4,
      ownership: { owner: "none" },
      provider: "codex",
      forkParentSessionId: "parent-session",
    };
    const getSession = vi.fn(async () => null);
    const reader = {
      getSession,
      getSessionSummary: vi.fn(async () => summary),
      getSessionFileStats: vi.fn(async () => null),
    };
    const branchState: SessionBranchState = {
      sessionId: SESSION_ID,
      provider: "codex",
      activeBranchId: "user-d-turn-d",
      selectedBranchId: "user-d-turn-d",
      branches: [
        {
          id: "user-b-turn-b",
          sessionId: "parent-session",
          parentId: "user-a-turn-a",
          prompt: "b",
          title: "b",
          depth: 2,
          index: 2,
          siblingIndex: 1,
          siblingCount: 2,
          isActive: false,
          provider: "codex",
        },
        {
          id: "user-b2-turn-b2",
          sessionId: SESSION_ID,
          parentId: "user-a-turn-a",
          prompt: "b2",
          title: "b2",
          depth: 2,
          index: 4,
          siblingIndex: 2,
          siblingCount: 2,
          isActive: true,
          provider: "codex",
        },
      ],
    };
    const nativeMessages: Message[] = [
      {
        uuid: "user-a-turn-a",
        type: "user",
        message: { role: "user", content: "a" },
        codexTurnId: "turn-a",
      },
      {
        uuid: "user-b2-turn-b2",
        type: "user",
        message: { role: "user", content: "b2" },
        codexTurnId: "turn-b2",
      },
      {
        uuid: "user-d-turn-d",
        type: "user",
        message: { role: "user", content: "d" },
        codexTurnId: "turn-d",
      },
      {
        uuid: "assistant-markdown-turn-d",
        type: "assistant",
        message: {
          role: "assistant",
          content:
            "See [the plan](/tmp/session-display-project/docs/plan.md:7).",
        },
        codexTurnId: "turn-d",
      },
    ];
    const getSemanticTurnsPage = vi.fn(async () => ({
      kind: "loaded" as const,
      messages: nativeMessages,
      summary,
      provider: "codex" as const,
      revision: "cas1.1.session",
    }));
    const app = new Hono();
    registerSessionDisplayRoutes(app, {
      scanner: {
        getOrCreateProject: vi.fn(async () => ({
          ...project(),
          provider: "codex" as const,
        })),
      },
      providerResolution: {
        readerFactory: () => reader as never,
        codexSessionsDir: "/tmp/codex-sessions",
        codexReaderFactory: () => reader as never,
      },
      codexAppServerHistoryReader: {
        getSemanticTurnsPage,
        getSemanticTurn: vi.fn(),
      },
      getBranchState: vi.fn(async () => branchState),
    });

    const response = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      revision: string;
      turns: Array<{
        question: {
          messageId: string;
          branch?: {
            branchId: string;
            parentId: string | null;
            siblingIndex: number;
            siblingCount: number;
          };
        } | null;
        segments: Array<{
          type: string;
          content?: string;
          renderedHtml?: string;
        }>;
      }>;
    };
    expect(page.revision).toBe("cas1.1.session");
    expect(page.turns).toHaveLength(3);
    expect(page.turns[1]?.question).toMatchObject({
      messageId: "user-b2-turn-b2",
      branch: {
        branchId: "user-b2-turn-b2",
        parentId: "user-a-turn-a",
        siblingIndex: 2,
        siblingCount: 2,
      },
    });
    const markdownSegment = page.turns[2]?.segments.find(
      (segment) => segment.type === "assistant_text",
    );
    expect(markdownSegment?.content).toContain("[the plan](");
    expect(markdownSegment?.renderedHtml).toContain('class="local-file-link"');
    expect(markdownSegment?.renderedHtml).toContain(
      'data-file-path="/tmp/session-display-project/docs/plan.md"',
    );
    expect(markdownSegment?.renderedHtml).toContain('data-line="7"');
    expect(getSession).not.toHaveBeenCalled();
  });

  it("paginates by user turns and keeps questions independent of tool bodies", async () => {
    const { app, getSession } = createRoutes(45);
    const firstResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display`,
    );
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      revision: string;
      turns: Array<{
        question: { messageId: string } | null;
        segments: Array<{ type: string; detailRef?: string }>;
      }>;
      nextCursor?: string;
    };
    const firstJson = JSON.stringify(first);
    expect(first.turns).toHaveLength(40);
    expect(first.turns[0]?.question?.messageId).toBe("user-5");
    expect(first.nextCursor).toBeDefined();
    expect(firstJson).not.toContain("TOOL_BODY_");
    expect(firstJson).not.toContain("/private/fixture-");

    const olderResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(olderResponse.status).toBe(200);
    const older = (await olderResponse.json()) as {
      turns: Array<{ question: { messageId: string } | null }>;
      nextCursor?: string;
    };
    expect(older.turns).toHaveLength(5);
    expect(older.turns[0]?.question?.messageId).toBe("user-0");
    expect(older.nextCursor).toBeUndefined();

    const callsBeforeQuestions = getSession.mock.calls.length;
    const questionResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display/questions`,
    );
    expect(questionResponse.status).toBe(200);
    const questions = (await questionResponse.json()) as {
      coverage: string;
      questions: Array<{ messageId: string; turnId: string }>;
    };
    expect(questions.coverage).toBe("complete");
    expect(questions.questions).toHaveLength(45);
    expect(questions.questions[0]).toMatchObject({
      messageId: "user-0",
      turnId: "turn:user-0",
    });
    expect(getSession).toHaveBeenCalledTimes(callsBeforeQuestions);
  });

  it("returns only the selected group details and rejects an old revision", async () => {
    const { app, advanceRevision } = createRoutes(2, 2);
    const displayResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display`,
    );
    const display = (await displayResponse.json()) as {
      revision: string;
      turns: Array<{
        segments: Array<{ type: string; detailRef?: string }>;
      }>;
    };
    const group = display.turns[0]?.segments.find(
      (segment) => segment.type === "tool_group",
    );
    expect(group?.detailRef).toBeDefined();

    const detailResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display/tool-groups/${group?.detailRef}?revision=${encodeURIComponent(display.revision)}`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      messages: Message[];
      nextCursor?: string;
    };
    expect(detail.nextCursor).toBeUndefined();
    expect(JSON.stringify(detail.messages)).toContain("TOOL_BODY_0_0");
    expect(JSON.stringify(detail.messages)).toContain("TOOL_BODY_0_1");
    expect(JSON.stringify(detail.messages)).not.toContain("TOOL_BODY_1_0");

    advanceRevision();
    const staleResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display/tool-groups/${group?.detailRef}?revision=${encodeURIComponent(display.revision)}`,
    );
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      code: "SESSION_DISPLAY_STALE",
    });
  });

  it("marks the active live tail without including its raw body", async () => {
    const { app, getSession } = createRoutes(
      1,
      2,
      undefined,
      {
        provider: "codex",
        toolsMayBeActive: true,
      },
      true,
    );
    const response = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display`,
    );
    const page = (await response.json()) as {
      revision: string;
      turns: Array<{
        segments: Array<{
          type: string;
          count?: number;
          detailRef?: string;
          liveTail?: true;
        }>;
      }>;
    };
    const liveTail = page.turns[0]?.segments.find(
      (segment) => segment.type === "tool_group",
    );

    expect(response.status).toBe(200);
    expect(liveTail).toMatchObject({ count: 2, liveTail: true });
    expect(JSON.stringify(page)).not.toContain("TOOL_BODY_");
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith(
      SESSION_ID,
      PROJECT_ID,
      undefined,
      expect.objectContaining({ maxMessages: 1_000 }),
    );

    const detailResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display/tool-groups/${liveTail?.detailRef}?revision=${encodeURIComponent(page.revision)}`,
    );
    expect(detailResponse.status).toBe(200);
    expect(JSON.stringify(await detailResponse.json())).toContain(
      "TOOL_BODY_0_0",
    );
  });

  it("augments app-server FileChange only in the requested live-tail detail", async () => {
    const revision = "cas1.1.session-display-edit";
    const summary: SessionSummary = {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      title: "Codex edit",
      fullTitle: "Codex edit",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:01.000Z",
      messageCount: 3,
      ownership: { owner: "self" },
      provider: "codex",
    };
    const messages: Message[] = [
      {
        uuid: "native-user-native-turn",
        type: "user",
        message: { role: "user", content: "Apply the change" },
        codexTurnId: "native-turn",
      },
      {
        uuid: "native-edit-native-turn",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "native-edit",
              name: "Edit",
              input: {
                file_path: "/tmp/session-display-project/src/example.ts",
                changes: [
                  {
                    path: "/tmp/session-display-project/src/example.ts",
                    kind: "update",
                    diff: "@@ -1 +1 @@\n-const before = true;\n+const after = true;",
                  },
                ],
              },
            },
          ],
        },
        codexTurnId: "native-turn",
      },
      {
        uuid: "native-edit-result-native-turn",
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "native-edit",
              content: "File changes applied",
            },
          ],
        },
        codexTurnId: "native-turn",
      },
    ];
    const reader = {
      getSession: vi.fn(async () => null),
      getSessionSummary: vi.fn(async () => summary),
      getSessionFileStats: vi.fn(async () => null),
    };
    const getSemanticTurnsPage = vi.fn(async () => ({
      kind: "loaded" as const,
      messages: structuredClone(messages),
      summary,
      provider: "codex" as const,
      revision,
    }));
    const getSemanticTurn = vi.fn(async () => ({
      kind: "loaded" as const,
      messages: structuredClone(messages),
      revision,
    }));
    const app = new Hono();
    registerSessionDisplayRoutes(app, {
      scanner: {
        getOrCreateProject: vi.fn(async () => ({
          ...project(),
          provider: "codex" as const,
        })),
      },
      providerResolution: {
        readerFactory: () => reader as never,
        codexSessionsDir: "/tmp/codex-sessions",
        codexReaderFactory: () => reader as never,
      },
      codexAppServerHistoryReader: {
        getSemanticTurnsPage,
        getSemanticTurn,
      },
      getRuntimeState: vi.fn(async () => ({
        provider: "codex" as const,
        toolsMayBeActive: true,
      })),
    });

    const displayResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display`,
    );
    const display = (await displayResponse.json()) as {
      revision: string;
      turns: Array<{
        segments: Array<{
          type: string;
          detailRef?: string;
          liveTail?: true;
        }>;
      }>;
    };
    const liveTail = display.turns[0]?.segments.find(
      (segment) => segment.type === "tool_group",
    );
    expect(displayResponse.status).toBe(200);
    expect(liveTail?.liveTail).toBe(true);
    expect(JSON.stringify(display)).not.toContain("const before");

    const detailResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display/tool-groups/${liveTail?.detailRef}?revision=${encodeURIComponent(display.revision)}`,
    );
    const detail = (await detailResponse.json()) as { messages: Message[] };
    const editInput = detail.messages
      .flatMap((message) => {
        const content = message.message?.content ?? message.content;
        return Array.isArray(content) ? content : [];
      })
      .find((block) => block.type === "tool_use" && block.name === "Edit")
      ?.input as
      | {
          _rawPatch?: string;
          _structuredPatch?: unknown[];
          _diffHtml?: string;
        }
      | undefined;

    expect(detailResponse.status).toBe(200);
    expect(getSemanticTurn).toHaveBeenCalledOnce();
    expect(editInput?._rawPatch).toContain("const before");
    expect(editInput?._structuredPatch).toHaveLength(1);
    expect(editInput?._diffHtml).toContain('class="line line-deleted"');
  });

  it("paginates the independent question directory and marks partial coverage", async () => {
    const { app } = createRoutes(125);
    const firstResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display/questions`,
    );
    const first = (await firstResponse.json()) as {
      coverage: string;
      questions: Array<{ messageId: string }>;
      nextCursor?: string;
    };
    expect(firstResponse.status).toBe(200);
    expect(first.coverage).toBe("partial");
    expect(first.questions).toHaveLength(100);
    expect(first.questions[0]?.messageId).toBe("user-25");

    const olderResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display/questions?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    const older = (await olderResponse.json()) as {
      coverage: string;
      questions: Array<{ messageId: string }>;
      nextCursor?: string;
    };
    expect(olderResponse.status).toBe(200);
    expect(older.coverage).toBe("complete");
    expect(older.questions).toHaveLength(25);
    expect(older.questions[0]?.messageId).toBe("user-0");
    expect(older.nextCursor).toBeUndefined();
  });

  it("bounds previews from indexes created before the display schema", async () => {
    const { app, getSession } = createRoutes(1, 1, "x".repeat(200));
    const response = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display/questions`,
    );
    const page = (await response.json()) as {
      questions: Array<{ preview: string }>;
    };

    expect(response.status).toBe(200);
    expect(page.questions[0]?.preview).toHaveLength(140);
    expect(page.questions[0]?.preview.endsWith("...")).toBe(true);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("rebuilds a complete question page when the bounded summary index is partial", async () => {
    const summary: SessionSummary = {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      title: "Partial questions",
      fullTitle: "Partial questions",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:01.000Z",
      messageCount: 2,
      userQuestions: [{ id: "user-0", text: "Question 0" }],
      userQuestionCoverage: "partial",
      ownership: { owner: "none" },
      provider: "codex",
    };
    const getSession = vi.fn(async () => ({
      summary,
      data: { provider: "codex" as const, session: { entries: [] } },
      projectedMessages: [
        {
          uuid: "user-0",
          type: "user",
          message: { role: "user", content: "Question 0" },
        },
        {
          uuid: "user-1",
          type: "user",
          message: { role: "user", content: "Question 1" },
        },
      ],
    }));
    const reader = {
      getSession,
      getSessionSummary: vi.fn(async () => summary),
      getSessionFileStats: vi.fn(async () => ({ mtime: 1, size: 2 })),
    };
    const app = new Hono();
    registerSessionDisplayRoutes(app, {
      scanner: { getOrCreateProject: vi.fn(async () => project()) },
      providerResolution: { readerFactory: () => reader as never },
    });

    const response = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display/questions`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      coverage: "complete",
      questions: [
        { messageId: "user-0", preview: "Question 0" },
        { messageId: "user-1", preview: "Question 1" },
      ],
    });
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("paginates explicit tool details at 50 rendered tools", async () => {
    const { app } = createRoutes(1, 60);
    const displayResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display`,
    );
    const display = (await displayResponse.json()) as {
      revision: string;
      turns: Array<{
        segments: Array<{
          type: string;
          count?: number;
          detailRef?: string;
        }>;
      }>;
    };
    const group = display.turns[0]?.segments.find(
      (segment) => segment.type === "tool_group",
    );
    expect(group?.count).toBe(60);

    const firstResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display/tool-groups/${group?.detailRef}?revision=${encodeURIComponent(display.revision)}`,
    );
    const first = (await firstResponse.json()) as {
      messages: Message[];
      nextCursor?: string;
    };
    expect(firstResponse.status).toBe(200);
    expect(countToolUses(first.messages)).toBe(50);
    expect(first.nextCursor).toBeDefined();

    const secondResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${SESSION_ID}/display/tool-groups/${group?.detailRef}?revision=${encodeURIComponent(display.revision)}&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    const second = (await secondResponse.json()) as { messages: Message[] };
    expect(secondResponse.status).toBe(200);
    expect(countToolUses(second.messages)).toBe(10);
  });

  it("uses the real Codex rollout reader with byte-offset turn cursors", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "display-codex-"));
    tempDirs.push(sessionsDir);
    const sessionId = randomUUID();
    const entries: unknown[] = [
      {
        type: "session_meta",
        timestamp: "2026-09-01T03:00:00.000Z",
        payload: {
          id: sessionId,
          cwd: PROJECT_PATH,
          timestamp: "2026-09-01T03:00:00.000Z",
          model_provider: "openai",
        },
      },
    ];
    for (let turn = 0; turn < 25; turn += 1) {
      entries.push(
        {
          type: "response_item",
          timestamp: `2026-09-01T03:${String(turn).padStart(2, "0")}:01.000Z`,
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: {
              turn_id: `native-turn-${turn}`,
            },
            content: [{ type: "input_text", text: `Codex question ${turn}` }],
          },
        },
        {
          type: "response_item",
          timestamp: `2026-09-01T03:${String(turn).padStart(2, "0")}:02.000Z`,
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: `codex-tool-${turn}`,
            arguments: JSON.stringify({ cmd: "pnpm test" }),
          },
        },
        {
          type: "response_item",
          timestamp: `2026-09-01T03:${String(turn).padStart(2, "0")}:03.000Z`,
          payload: {
            type: "function_call_output",
            call_id: `codex-tool-${turn}`,
            output: `CODEX_ROLLOUT_BODY_${turn}:${"x".repeat(1_000)}`,
          },
        },
        {
          type: "response_item",
          timestamp: `2026-09-01T03:${String(turn).padStart(2, "0")}:04.000Z`,
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `Codex answer ${turn}` }],
          },
        },
      );
    }
    await writeFile(
      join(sessionsDir, `rollout-${sessionId}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    const codexProject: Project = {
      ...project(),
      provider: "codex",
      sessionDir: sessionsDir,
    };
    const app = new Hono();
    registerSessionDisplayRoutes(app, {
      scanner: { getOrCreateProject: vi.fn(async () => codexProject) },
      providerResolution: {
        readerFactory: () => reader,
        codexSessionsDir: sessionsDir,
        codexReaderFactory: () => reader,
      },
    });

    const firstResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${sessionId}/display?limit=20`,
    );
    const first = (await firstResponse.json()) as {
      revision: string;
      turns: Array<{
        id: string;
        question: {
          content: string | Array<{ type: string; text?: string }>;
        } | null;
        segments: Array<{ type: string; detailRef?: string }>;
      }>;
      nextCursor?: string;
    };
    expect(firstResponse.status).toBe(200);
    expect(first.turns).toHaveLength(20);
    expect(first.turns[0]?.id).toBe("turn:native-turn-5");
    expect(first.turns[0]?.question?.content).toEqual([
      { type: "text", text: "Codex question 5" },
    ]);
    expect(JSON.stringify(first)).not.toContain("CODEX_ROLLOUT_BODY_");

    const firstToolGroup = first.turns[0]?.segments.find(
      (segment) => segment.type === "tool_group",
    );
    const detailResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${sessionId}/display/tool-groups/${firstToolGroup?.detailRef}?revision=${encodeURIComponent(first.revision)}`,
    );
    const detail = (await detailResponse.json()) as { messages: Message[] };
    expect(detailResponse.status).toBe(200);
    expect(countToolUses(detail.messages)).toBe(1);
    expect(JSON.stringify(detail)).toContain("CODEX_ROLLOUT_BODY_5");

    const olderResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${sessionId}/display?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    const older = (await olderResponse.json()) as {
      turns: Array<{
        id: string;
        question: {
          content: string | Array<{ type: string; text?: string }>;
        } | null;
      }>;
    };
    expect(olderResponse.status).toBe(200);
    expect(older.turns).toHaveLength(5);
    expect(older.turns[0]?.id).toBe("turn:native-turn-0");
    expect(older.turns[0]?.question?.content).toEqual([
      { type: "text", text: "Codex question 0" },
    ]);

    const questionResponse = await app.request(
      `/projects/${PROJECT_ID}/sessions/${sessionId}/display/questions`,
    );
    const questions = (await questionResponse.json()) as {
      questions: Array<{ messageId: string; turnId: string }>;
    };
    expect(questionResponse.status).toBe(200);
    expect(questions.questions[0]?.turnId).toBe("turn:native-turn-0");
  });

  it("uses the real Pi active-branch reader without returning tool results", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "display-pi-"));
    tempDirs.push(sessionsDir);
    const sessionId = randomUUID();
    const projectDir = join(sessionsDir, "--display-project--");
    await mkdir(projectDir, { recursive: true });
    const records = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-09-01T04:00:00.000Z",
        cwd: PROJECT_PATH,
      },
      {
        type: "message",
        id: "pi-user",
        parentId: null,
        timestamp: "2026-09-01T04:00:01.000Z",
        message: { role: "user", content: "Pi question" },
      },
      {
        type: "message",
        id: "pi-tool-message",
        parentId: "pi-user",
        timestamp: "2026-09-01T04:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Checking Pi" },
            {
              type: "toolCall",
              id: "pi-tool",
              name: "bash",
              arguments: { command: "pnpm test" },
            },
          ],
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        id: "pi-result",
        parentId: "pi-tool-message",
        timestamp: "2026-09-01T04:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "pi-tool",
          toolName: "bash",
          content: [{ type: "text", text: "PI_TOOL_RESULT_BODY" }],
          isError: false,
        },
      },
      {
        type: "message",
        id: "pi-final",
        parentId: "pi-result",
        timestamp: "2026-09-01T04:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Pi answer" }],
          stopReason: "stop",
        },
      },
    ];
    await writeFile(
      join(projectDir, `session_${sessionId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const reader = new PiSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    const piProject: Project = {
      ...project(),
      provider: "pi",
      sessionDir: sessionsDir,
    };
    const app = new Hono();
    registerSessionDisplayRoutes(app, {
      scanner: { getOrCreateProject: vi.fn(async () => piProject) },
      providerResolution: {
        readerFactory: () => reader,
        piSessionsDir: sessionsDir,
        piReaderFactory: () => reader,
      },
    });

    const response = await app.request(
      `/projects/${PROJECT_ID}/sessions/${sessionId}/display`,
    );
    const display = (await response.json()) as {
      turns: Array<{
        question: { content: string } | null;
        segments: Array<{ type: string; count?: number }>;
      }>;
    };
    expect(response.status).toBe(200);
    expect(display.turns[0]?.question?.content).toBe("Pi question");
    expect(display.turns[0]?.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_group", count: 1 }),
        expect.objectContaining({
          type: "assistant_text",
          content: "Pi answer",
        }),
      ]),
    );
    expect(JSON.stringify(display)).not.toContain("PI_TOOL_RESULT_BODY");
  });
});
