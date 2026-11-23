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
        // Context fill mirrors Pi's own `calculateContextTokens()`: the
        // provider-reported `totalTokens` (which includes output).
        inputTokens: 36,
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

  it("exposes a resubmitted prompt with unchanged text as an edit branch", async () => {
    const sessionsDir = join(tmpdir(), `pi-sessions-${randomUUID()}`);
    const projectPath = join(tmpdir(), `pi-project-${randomUUID()}`);
    const projectDir = join(sessionsDir, "--pi-same-text-project--");
    tempDirs.push(sessionsDir);
    await mkdir(projectDir, { recursive: true });

    const user = (id: string, parentId: string | null, text: string) => ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-11-04T01:00:00.000Z",
      message: { role: "user", content: text, timestamp: 1 },
    });
    const assistant = (id: string, parentId: string, text: string) => ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-11-04T01:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        timestamp: 2,
      },
    });

    const parentId = randomUUID();
    const parentPath = join(projectDir, `parent_${parentId}.jsonl`);
    await writeFile(
      parentPath,
      jsonl([
        {
          type: "session",
          version: 3,
          id: parentId,
          timestamp: "2026-11-04T01:00:00.000Z",
          cwd: projectPath,
        },
        user("u1", null, "first prompt"),
        assistant("a1", "u1", "first answer"),
        user("u2", "a1", "continue"),
        assistant("a2", "u2", "original answer"),
      ]),
    );

    // Pi's fork copies the retained path under the same entry ids, then the
    // edited prompt follows under a new id. Here it repeats the original text.
    const childId = randomUUID();
    await writeFile(
      join(projectDir, `child_${childId}.jsonl`),
      jsonl([
        {
          type: "session",
          version: 3,
          id: childId,
          timestamp: "2026-11-04T02:00:00.000Z",
          cwd: projectPath,
          parentSession: parentPath,
        },
        user("u1", null, "first prompt"),
        assistant("a1", "u1", "first answer"),
        {
          type: "model_change",
          id: "model",
          parentId: "a1",
          timestamp: "2026-11-04T02:00:01.000Z",
          provider: "yep-openai-compatible",
          modelId: "gpt-5",
        },
        user("u2-retry", "model", "continue"),
        assistant("a2-retry", "u2-retry", "another answer"),
      ]),
    );

    const reader = new PiSessionReader({ sessionsDir, projectPath });
    const projectId = encodeProjectId(projectPath);
    const loaded = await reader.getSession(childId, projectId);
    const forks = loaded?.branchState?.branches
      .filter((branch) => branch.siblingCount > 1)
      .map((branch) => ({
        id: branch.id,
        sessionId: branch.sessionId,
        position: `${branch.siblingIndex}/${branch.siblingCount}`,
      }));
    expect(forks).toEqual([
      { id: "u2", sessionId: parentId, position: "1/2" },
      { id: "u2-retry", sessionId: childId, position: "2/2" },
    ]);

    // Metadata-only reads return the same family without a transcript load.
    expect(await reader.getBranchState(childId)).toEqual(loaded?.branchState);
    expect(await reader.getBranchState(parentId)).toMatchObject({
      sessionId: parentId,
      activeBranchId: "u2",
    });

    const loneId = randomUUID();
    await writeFile(
      join(projectDir, `lone_${loneId}.jsonl`),
      jsonl([
        {
          type: "session",
          version: 3,
          id: loneId,
          timestamp: "2026-11-04T03:00:00.000Z",
          cwd: projectPath,
        },
        user("lone-user", null, "unrelated"),
      ]),
    );
    expect(await reader.getBranchState(loneId)).toBeUndefined();
  });

  it("observes appended Pi JSONL entries immediately without waiting for catalog TTL", async () => {
    const sessionsDir = join(tmpdir(), `pi-sessions-fresh-${randomUUID()}`);
    const projectPath = join(tmpdir(), `pi-project-fresh-${randomUUID()}`);
    const projectDir = join(sessionsDir, "--pi-project--");
    tempDirs.push(sessionsDir);
    await mkdir(projectDir, { recursive: true });

    const sessionId = randomUUID();
    const filePath = join(projectDir, `session_${sessionId}.jsonl`);
    const initialRecords = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-11-22T05:00:00.000Z",
        cwd: projectPath,
      },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-11-22T05:00:01.000Z",
        message: { role: "user", content: "first prompt", timestamp: 1 },
      },
    ];
    await writeFile(filePath, jsonl(initialRecords));

    const reader = new PiSessionReader({ sessionsDir, projectPath });
    const projectId = encodeProjectId(projectPath);

    const firstStats = await reader.getSessionFileStats(sessionId);
    const firstLoaded = await reader.getSession(sessionId, projectId);
    expect(firstStats).not.toBeNull();
    expect(firstLoaded?.summary.messageCount).toBe(1);

    // Append directly on disk within the 5s catalog TTL (without invalidateFile).
    await writeFile(
      filePath,
      jsonl([
        ...initialRecords,
        {
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: "2026-11-22T05:00:05.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "fresh reply" }],
            provider: "yep-openai-compatible",
            model: "gpt-5",
            stopReason: "stop",
            timestamp: 2,
          },
        },
      ]),
    );

    const secondStats = await reader.getSessionFileStats(sessionId);
    expect(secondStats).not.toBeNull();
    expect(secondStats?.size).toBeGreaterThan(firstStats?.size ?? 0);

    const secondLoaded = await reader.getSession(sessionId, projectId);
    expect(secondLoaded?.summary.messageCount).toBe(2);
    const normalized = secondLoaded ? normalizeSession(secondLoaded) : null;
    expect(
      normalized?.messages.some(
        (m) =>
          m.type === "assistant" && JSON.stringify(m).includes("fresh reply"),
      ),
    ).toBe(true);
  });
});
