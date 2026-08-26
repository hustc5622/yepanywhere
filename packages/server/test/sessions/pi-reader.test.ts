import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { PiSessionScanner } from "../../src/projects/pi-scanner.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { PiSessionReader } from "../../src/sessions/pi-reader.js";

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("Pi native session reader", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("discovers projects, follows the active tree branch, and normalizes tools", async () => {
    const sessionsDir = join(tmpdir(), `pi-sessions-${randomUUID()}`);
    const projectPath = join(tmpdir(), `pi-project-${randomUUID()}`);
    const projectDir = join(sessionsDir, "--pi-project--");
    tempDirs.push(sessionsDir);
    await mkdir(projectDir, { recursive: true });

    const parentId = randomUUID();
    const parentPath = join(projectDir, `parent_${parentId}.jsonl`);
    await writeFile(
      parentPath,
      jsonl([
        {
          type: "session",
          version: 3,
          id: parentId,
          timestamp: "2026-08-15T01:00:00.000Z",
          cwd: projectPath,
        },
        {
          type: "message",
          id: "parent-user",
          parentId: null,
          timestamp: "2026-08-15T01:00:01.000Z",
          message: {
            role: "user",
            content: "parent prompt",
            timestamp: 1,
          },
        },
      ]),
    );

    const reader = new PiSessionReader({
      sessionsDir,
      projectPath,
      getContextWindow: () => 96_000,
    });
    const projectId = encodeProjectId(projectPath);
    // Prime the short directory cache before the fork file exists. A lookup
    // for the new id must retry the scan immediately instead of returning 404.
    expect(await reader.listSessions(projectId)).toHaveLength(1);

    const childId = randomUUID();
    const childPath = join(projectDir, `child_${childId}.jsonl`);
    await writeFile(
      childPath,
      jsonl([
        {
          type: "session",
          version: 3,
          id: childId,
          timestamp: "2026-08-15T02:00:00.000Z",
          cwd: projectPath,
          parentSession: parentPath,
        },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp: "2026-08-15T02:00:01.000Z",
          provider: "yep-openai-compatible",
          modelId: "gpt-5",
        },
        {
          type: "thinking_level_change",
          id: "thinking",
          parentId: "model",
          timestamp: "2026-08-15T02:00:02.000Z",
          thinkingLevel: "high",
        },
        {
          type: "message",
          id: "user-active",
          parentId: "thinking",
          timestamp: "2026-08-15T02:00:03.000Z",
          message: {
            role: "user",
            content: "edit the active branch",
            timestamp: 2,
          },
        },
        {
          type: "message",
          id: "assistant-abandoned",
          parentId: "user-active",
          timestamp: "2026-08-15T02:00:04.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "abandoned answer" }],
            provider: "yep-openai-compatible",
            model: "gpt-5",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
            },
            stopReason: "stop",
            timestamp: 3,
          },
        },
        {
          type: "message",
          id: "assistant-tool",
          parentId: "user-active",
          timestamp: "2026-08-15T02:00:05.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "inspect first",
                thinkingSignature: "pi-reasoning-signature",
              },
              {
                type: "toolCall",
                id: "call-1",
                name: "bash",
                arguments: { command: "pwd" },
              },
            ],
            provider: "yep-openai-compatible",
            model: "gpt-5",
            usage: {
              input: 20,
              output: 5,
              cacheRead: 3,
              cacheWrite: 1,
              totalTokens: 29,
            },
            stopReason: "toolUse",
            timestamp: 4,
          },
        },
        {
          type: "message",
          id: "tool-result",
          parentId: "assistant-tool",
          timestamp: "2026-08-15T02:00:06.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: projectPath }],
            details: { exitCode: 0 },
            isError: false,
            timestamp: 5,
          },
        },
        {
          type: "message",
          id: "assistant-final",
          parentId: "tool-result",
          timestamp: "2026-08-15T02:00:07.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            provider: "yep-openai-compatible",
            model: "gpt-5",
            usage: {
              input: 30,
              output: 4,
              cacheRead: 2,
              cacheWrite: 0,
              totalTokens: 36,
            },
            stopReason: "stop",
            timestamp: 6,
          },
        },
      ]),
    );

    const summary = await reader.getSessionSummary(childId, projectId);
    expect(summary).toMatchObject({
      id: childId,
      provider: "pi",
      fullTitle: "edit the active branch",
      model: "gpt-5",
      reasoningEffort: "high",
      messageCount: 3,
      lastTurnStatus: "completed",
      forkParentSessionId: parentId,
      contextUsage: {
        inputTokens: 32,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheCreationTokens: 0,
        contextWindow: 96_000,
      },
    });
    expect(summary?.cumulativeUsage).toMatchObject({
      inputTokens: 50,
      outputTokens: 9,
      turnCount: 2,
    });

    const loaded = await reader.getSession(childId, projectId);
    expect(loaded).not.toBeNull();
    if (!loaded) throw new Error("Expected Pi session to load");
    const normalized = normalizeSession(loaded);
    expect(normalized.branchState).toMatchObject({
      provider: "pi",
      sessionId: childId,
      activeBranchId: "user-active",
      selectedBranchId: "user-active",
      branches: [
        expect.objectContaining({
          id: "parent-user",
          sessionId: parentId,
          siblingIndex: 1,
          siblingCount: 2,
          provider: "pi",
        }),
        expect.objectContaining({
          id: "user-active",
          sessionId: childId,
          siblingIndex: 2,
          siblingCount: 2,
          provider: "pi",
        }),
      ],
    });
    expect(
      normalized.messages.some(
        (message) =>
          message.type === "assistant" &&
          Array.isArray(message.message?.content) &&
          message.message.content.some(
            (block) =>
              block.type === "text" && block.text === "abandoned answer",
          ),
      ),
    ).toBe(false);
    expect(normalized.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uuid: "assistant-tool",
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "thinking",
                signature: "pi-reasoning-signature",
              }),
              expect.objectContaining({
                type: "tool_use",
                id: "call-1",
                name: "Bash",
                input: { command: "pwd" },
              }),
            ]),
          }),
        }),
        expect.objectContaining({
          uuid: "tool-result",
          tool_use_id: "call-1",
        }),
      ]),
    );

    const scanner = new PiSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();
    expect(projects).toEqual([
      expect.objectContaining({
        path: projectPath,
        provider: "pi",
        sessionCount: 2,
      }),
    ]);
  });

  it("keeps unchanged parsed sessions cached when another Pi file changes", async () => {
    const sessionsDir = join(tmpdir(), `pi-sessions-${randomUUID()}`);
    const projectPath = join(tmpdir(), `pi-project-${randomUUID()}`);
    const projectDir = join(sessionsDir, "--pi-cache-project--");
    tempDirs.push(sessionsDir);
    await mkdir(projectDir, { recursive: true });

    const makeRecords = (sessionId: string, answer = "done") => [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-08-25T01:00:00.000Z",
        cwd: projectPath,
      },
      {
        type: "message",
        id: `${sessionId}-user`,
        parentId: null,
        timestamp: "2026-08-25T01:00:01.000Z",
        message: { role: "user", content: "prompt", timestamp: 1 },
      },
      {
        type: "message",
        id: `${sessionId}-assistant`,
        parentId: `${sessionId}-user`,
        timestamp: "2026-08-25T01:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: answer }],
          stopReason: "stop",
          timestamp: 2,
        },
      },
    ];

    const firstPath = join(projectDir, "first.jsonl");
    const secondPath = join(projectDir, "second.jsonl");
    await Promise.all([
      writeFile(firstPath, jsonl(makeRecords("first"))),
      writeFile(secondPath, jsonl(makeRecords("second"))),
    ]);

    const reader = new PiSessionReader({ sessionsDir, projectPath });
    const projectId = encodeProjectId(projectPath);
    const firstLoad = await reader.getSession("second", projectId, undefined, {
      deferMedia: true,
    });
    expect(firstLoad).not.toBeNull();

    await writeFile(firstPath, jsonl(makeRecords("first", "changed")));
    reader.invalidateFile(firstPath);

    const secondLoad = await reader.getSession("second", projectId, undefined, {
      deferMedia: true,
    });
    expect(secondLoad).not.toBeNull();
    expect(secondLoad?.data.provider).toBe("pi");
    expect(firstLoad?.data.provider).toBe("pi");
    if (
      firstLoad?.data.provider === "pi" &&
      secondLoad?.data.provider === "pi"
    ) {
      expect(secondLoad.data.session).toBe(firstLoad.data.session);
    }
  });
});
