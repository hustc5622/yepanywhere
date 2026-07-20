import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeSessionScanner } from "../../src/projects/opencode-scanner.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { OpenCodeSessionReader } from "../../src/sessions/opencode-reader.js";

interface TestSqliteStatement {
  run(...params: unknown[]): void;
}

interface TestSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): TestSqliteStatement;
  close(): void;
}

interface TestSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => TestSqliteDatabase;
}

async function loadSqliteModule(): Promise<TestSqliteModule | null> {
  const specifier: string = "node:sqlite";
  return import(specifier)
    .then((mod) => {
      const maybeModule = mod as {
        DatabaseSync?: TestSqliteModule["DatabaseSync"];
      };
      return maybeModule.DatabaseSync
        ? { DatabaseSync: maybeModule.DatabaseSync }
        : null;
    })
    .catch(() => null);
}

async function createOpenCodeDb(
  dbPath: string,
  projectPath: string,
  options: {
    sessionMetadata?: Record<string, unknown> | null;
    sessionTitle?: string;
    /** null simulates an older session row that did not persist variant. */
    sessionVariant?: string | null;
    messageVariants?: Array<string | undefined>;
  } = {},
): Promise<boolean> {
  const sqlite = await loadSqliteModule();
  if (!sqlite) return false;

  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        title text NOT NULL,
        version text NOT NULL,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        revert text,
        permission text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_compacting integer,
        time_archived integer,
        workspace_id text,
        path text,
        agent text,
        model text,
        cost real DEFAULT 0 NOT NULL,
        tokens_input integer DEFAULT 0 NOT NULL,
        tokens_output integer DEFAULT 0 NOT NULL,
        tokens_reasoning integer DEFAULT 0 NOT NULL,
        tokens_cache_read integer DEFAULT 0 NOT NULL,
        tokens_cache_write integer DEFAULT 0 NOT NULL,
        metadata text
      );
      CREATE TABLE message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
      CREATE TABLE part (
        id text PRIMARY KEY,
        message_id text NOT NULL,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
    `);

    const createdAt = Date.UTC(2026, 6, 7, 1, 34, 46);
    const updatedAt = Date.UTC(2026, 6, 7, 1, 35, 23);
    db.prepare(
      `
        INSERT INTO session (
          id,
          project_id,
          slug,
          directory,
          title,
          version,
          time_created,
          time_updated,
          model,
          tokens_input,
          tokens_output,
          tokens_cache_read,
          metadata
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "ses_test",
      "global",
      "test",
      projectPath,
      options.sessionTitle ?? "Yep Anywhere Session",
      "1",
      createdAt,
      updatedAt,
      JSON.stringify({
        id: "glm-5.2",
        providerID: "anthropic",
        ...(options.sessionVariant === null
          ? {}
          : { variant: options.sessionVariant ?? "default" }),
      }),
      1000,
      50,
      200,
      options.sessionMetadata === undefined
        ? null
        : JSON.stringify(options.sessionMetadata),
    );

    const messageVariants = options.messageVariants ?? [undefined];
    for (const [index, variant] of messageVariants.entries()) {
      const messageId = index === 0 ? "msg_user" : `msg_user_${index}`;
      const messageTime = index === 0 ? createdAt + 10 : updatedAt + index * 10;
      db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      ).run(
        messageId,
        "ses_test",
        messageTime,
        messageTime,
        JSON.stringify({
          role: "user",
          time: { created: messageTime },
          model: {
            providerID: "anthropic",
            modelID: "glm-5.2",
            ...(variant ? { variant } : {}),
          },
        }),
      );
    }
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "prt_user",
      "msg_user",
      "ses_test",
      createdAt + 20,
      createdAt + 20,
      JSON.stringify({ type: "text", text: "搜一下腾讯新发布的 hy3系列模型" }),
    );

    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "msg_assistant",
      "ses_test",
      updatedAt - 1000,
      updatedAt,
      JSON.stringify({
        parentID: "msg_user",
        role: "assistant",
        modelID: "glm-5.2",
        providerID: "anthropic",
        tokens: {
          input: 800,
          output: 50,
          cache: { read: 200 },
        },
        time: { created: updatedAt - 1000, completed: updatedAt },
        finish: "stop",
      }),
    );
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "prt_assistant",
      "msg_assistant",
      "ses_test",
      updatedAt,
      updatedAt,
      JSON.stringify({ type: "text", text: "腾讯混元 Hy3 已发布。" }),
    );
  } finally {
    db.close();
  }

  return true;
}

function insertSession(
  db: TestSqliteDatabase,
  args: {
    id: string;
    projectPath: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
    parentId?: string;
    archivedAt?: number;
  },
): void {
  db.prepare(
    `
      INSERT INTO session (
        id, project_id, parent_id, slug, directory, title, version,
        time_created, time_updated, time_archived, tokens_input,
        tokens_output, tokens_reasoning, tokens_cache_read,
        tokens_cache_write, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    args.id,
    "global",
    args.parentId ?? null,
    args.id,
    args.projectPath,
    args.id,
    "1",
    args.createdAt,
    args.createdAt,
    args.archivedAt ?? null,
    0,
    0,
    0,
    0,
    0,
    args.metadata ? JSON.stringify(args.metadata) : null,
  );
}

function insertMessage(
  db: TestSqliteDatabase,
  args: {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    text: string;
    createdAt: number;
    parentId?: string;
  },
): void {
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  ).run(
    args.id,
    args.sessionId,
    args.createdAt,
    args.createdAt,
    JSON.stringify({
      role: args.role,
      time: { created: args.createdAt },
      ...(args.parentId ? { parentID: args.parentId } : {}),
    }),
  );
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    `part_${args.id}`,
    args.id,
    args.sessionId,
    args.createdAt,
    args.createdAt,
    JSON.stringify({ type: "text", text: args.text }),
  );
}

describe("OpenCode sqlite session support", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("discovers projects and reads summaries from opencode.db", async () => {
    const dir = join(tmpdir(), `opencode-reader-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "opencode.db");
    const projectPath = join(dir, "research_tasks");
    const sqliteAvailable = await createOpenCodeDb(dbPath, projectPath);
    if (!sqliteAvailable) return;

    const scanner = new OpenCodeSessionScanner({ dbPath });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      path: projectPath,
      provider: "opencode",
      sessionCount: 1,
    });

    const reader = new OpenCodeSessionReader({ dbPath, projectPath });
    const sessions = await reader.listSessions(encodeProjectId(projectPath));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "ses_test",
      provider: "opencode",
      title: "搜一下腾讯新发布的 hy3系列模型",
      model: "anthropic/glm-5.2",
      messageCount: 2,
    });
    expect(sessions[0]?.createdBy).toBeUndefined();
    expect(sessions[0]?.userQuestions?.[0]?.text).toBe(
      "搜一下腾讯新发布的 hy3系列模型",
    );

    const loaded = await reader.getSession(
      "ses_test",
      encodeProjectId(projectPath),
    );
    expect(loaded?.data.provider).toBe("opencode");
    expect(loaded?.data.session.messages).toHaveLength(2);
    expect(loaded?.data.session.messages[0]?.parts[0]?.text).toBe(
      "搜一下腾讯新发布的 hy3系列模型",
    );
  });

  it("hides subagent children from lists but links them on detail", async () => {
    const dir = join(tmpdir(), `opencode-reader-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "opencode.db");
    const projectPath = join(dir, "research_tasks");
    const sqliteAvailable = await createOpenCodeDb(dbPath, projectPath);
    if (!sqliteAvailable) return;
    const sqlite = await loadSqliteModule();
    if (!sqlite) return;

    const db = new sqlite.DatabaseSync(dbPath);
    try {
      const base = Date.UTC(2026, 6, 8);
      insertSession(db, {
        id: "ses_subagent",
        projectPath,
        createdAt: base,
        parentId: "ses_test",
      });
      insertMessage(db, {
        id: "msg_sub_user",
        sessionId: "ses_subagent",
        role: "user",
        text: "analyze the swing middleware",
        createdAt: base + 10,
      });
    } finally {
      db.close();
    }

    const reader = new OpenCodeSessionReader({ dbPath, projectPath });
    const encoded = encodeProjectId(projectPath);

    // The subagent child shares the parent's directory but must not surface as
    // a standalone session in the list.
    const sessions = await reader.listSessions(encoded);
    expect(sessions.map((session) => session.id)).toEqual(["ses_test"]);

    // The session index enumerates via listSessionFiles(); it must also exclude
    // children so they never get indexed/listed through the cached path.
    const enumerated = await reader.listSessionFiles(dbPath);
    expect(enumerated.map((entry) => entry.sessionId)).toEqual(["ses_test"]);

    // Project counts use the same top-level-session semantics as list views.
    const scanner = new OpenCodeSessionScanner({ dbPath });
    const projects = await scanner.listProjects();
    expect(projects[0]?.sessionCount).toBe(1);
    expect(projects[0]?.lastActivity).toBe(new Date(base).toISOString());

    // The parent (top-level) session carries no parent link.
    const parentSummary = await reader.getSessionSummary("ses_test", encoded);
    expect(parentSummary?.parentSessionId).toBeUndefined();

    // The child remains directly fetchable (for navigation) and exposes the
    // parent link on both its summary and loaded detail.
    const childSummary = await reader.getSessionSummary(
      "ses_subagent",
      encoded,
    );
    expect(childSummary?.parentSessionId).toBe("ses_test");

    const loadedChild = await reader.getSession("ses_subagent", encoded);
    expect(loadedChild?.summary.parentSessionId).toBe("ses_test");
  });

  it("reads Yep creation source from OpenCode session metadata", async () => {
    const dir = join(tmpdir(), `opencode-reader-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "opencode.db");
    const projectPath = join(dir, "research_tasks");
    const sqliteAvailable = await createOpenCodeDb(dbPath, projectPath, {
      sessionMetadata: { createdBy: "yep", source: "yep-anywhere" },
    });
    if (!sqliteAvailable) return;

    const reader = new OpenCodeSessionReader({ dbPath, projectPath });
    const sessions = await reader.listSessions(encodeProjectId(projectPath));

    expect(sessions[0]?.createdBy).toBe("yep");
  });

  it("reads the current OpenCode model variant as reasoning effort", async () => {
    const dir = join(tmpdir(), `opencode-reader-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "opencode.db");
    const projectPath = join(dir, "research_tasks");
    const sqliteAvailable = await createOpenCodeDb(dbPath, projectPath, {
      sessionVariant: "max",
    });
    if (!sqliteAvailable) return;

    const reader = new OpenCodeSessionReader({ dbPath, projectPath });
    const sessions = await reader.listSessions(encodeProjectId(projectPath));

    expect(sessions[0]?.reasoningEffort).toBe("max");
  });

  it("treats a later user message without a variant as Default", async () => {
    const dir = join(tmpdir(), `opencode-reader-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "opencode.db");
    const projectPath = join(dir, "research_tasks");
    const sqliteAvailable = await createOpenCodeDb(dbPath, projectPath, {
      sessionVariant: null,
      messageVariants: ["max", undefined],
    });
    if (!sqliteAvailable) return;

    const reader = new OpenCodeSessionReader({ dbPath, projectPath });
    const sessions = await reader.listSessions(encodeProjectId(projectPath));

    expect(sessions[0]?.reasoningEffort).toBe("default");
  });

  it("prefers OpenCode's persisted generated title over the first user prompt", async () => {
    const dir = join(tmpdir(), `opencode-reader-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "opencode.db");
    const projectPath = join(dir, "research_tasks");
    const sqliteAvailable = await createOpenCodeDb(dbPath, projectPath, {
      sessionTitle: "Generated OpenCode workflow title",
    });
    if (!sqliteAvailable) return;

    const reader = new OpenCodeSessionReader({ dbPath, projectPath });
    const sessions = await reader.listSessions(encodeProjectId(projectPath));

    expect(sessions[0]).toMatchObject({
      title: "Generated OpenCode workflow title",
      fullTitle: "Generated OpenCode workflow title",
    });
  });

  it.each([
    "New session",
    "New session - 2026-07-10T08:38:04.689Z",
    "New session - 2026-07-10T16:38:04+08:00",
    "Yep Anywhere Session",
    "Here's a title for this conversation:",
    "Based on the conversation, here are some title suggestions:",
    "根据这个对话的内容，我为其生成的标题是：",
    "以下是标题：",
    "对话标题",
    "建议的标题",
    "## 对话标题",
    "## 建议的标题",
  ])("falls back from generic provider title %s", async (sessionTitle) => {
    const dir = join(tmpdir(), `opencode-reader-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "opencode.db");
    const projectPath = join(dir, "research_tasks");
    const sqliteAvailable = await createOpenCodeDb(dbPath, projectPath, {
      sessionTitle,
    });
    if (!sqliteAvailable) return;

    const reader = new OpenCodeSessionReader({ dbPath, projectPath });
    const sessions = await reader.listSessions(encodeProjectId(projectPath));

    expect(sessions[0]).toMatchObject({
      title: "搜一下腾讯新发布的 hy3系列模型",
      fullTitle: "搜一下腾讯新发布的 hy3系列模型",
    });
  });

  it.each(["Benchmark Run #58 失败模式分析", "修复 OpenCode 标题生成漂移"])(
    "keeps usable provider title %s",
    async (sessionTitle) => {
      const dir = join(tmpdir(), `opencode-reader-${randomUUID()}`);
      tempDirs.push(dir);
      await mkdir(dir, { recursive: true });

      const dbPath = join(dir, "opencode.db");
      const projectPath = join(dir, "research_tasks");
      const sqliteAvailable = await createOpenCodeDb(dbPath, projectPath, {
        sessionTitle,
      });
      if (!sqliteAvailable) return;

      const reader = new OpenCodeSessionReader({ dbPath, projectPath });
      const sessions = await reader.listSessions(encodeProjectId(projectPath));

      expect(sessions[0]).toMatchObject({
        title: sessionTitle,
        fullTitle: sessionTitle,
      });
    },
  );

  it("uses project OpenCode provider config for context usage", async () => {
    const dir = join(tmpdir(), `opencode-reader-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "opencode.db");
    const projectPath = join(dir, "research_tasks");
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, "opencode.json"),
      JSON.stringify({
        providers: {
          anthropic: {
            models: {
              "glm-5.2": {
                limit: { context: 2000, output: 1000 },
              },
            },
          },
        },
      }),
    );

    const sqliteAvailable = await createOpenCodeDb(dbPath, projectPath);
    if (!sqliteAvailable) return;

    const reader = new OpenCodeSessionReader({ dbPath, projectPath });
    const sessions = await reader.listSessions(encodeProjectId(projectPath));

    expect(sessions[0]?.contextUsage).toMatchObject({
      inputTokens: 1000,
      contextWindow: 2000,
      percentage: 50,
    });
  });

  it("loads cross-session edit branches, selection, nesting, and pagination", async () => {
    const dir = join(tmpdir(), `opencode-reader-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "opencode.db");
    const projectPath = join(dir, "branch_project");
    const sqliteAvailable = await createOpenCodeDb(dbPath, projectPath, {
      sessionMetadata: { createdBy: "yep", source: "yep-anywhere" },
    });
    if (!sqliteAvailable) return;
    const sqlite = await loadSqliteModule();
    if (!sqlite) return;
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      const base = Date.UTC(2026, 6, 15);
      insertMessage(db, {
        id: "msg_u2",
        sessionId: "ses_test",
        role: "user",
        text: "original second prompt",
        createdAt: base + 100_000,
      });
      insertMessage(db, {
        id: "msg_a2",
        sessionId: "ses_test",
        role: "assistant",
        text: "original second answer",
        createdAt: base + 100_001,
        parentId: "msg_u2",
      });

      insertSession(db, {
        id: "ses_child",
        projectPath,
        createdAt: base + 200_000,
        metadata: {
          createdBy: "yep",
          source: "yep-anywhere",
          yepFork: {
            schemaVersion: 1,
            kind: "edit-fork",
            parentSessionId: "ses_test",
            forkMessageId: "msg_u2",
            createdAt: "2026-07-15T00:00:02.000Z",
          },
        },
      });
      insertMessage(db, {
        id: "msg_u1_copy",
        sessionId: "ses_child",
        role: "user",
        text: "搜一下腾讯新发布的 hy3系列模型",
        createdAt: base + 10,
      });
      insertMessage(db, {
        id: "msg_a1_copy",
        sessionId: "ses_child",
        role: "assistant",
        text: "腾讯混元 Hy3 已发布。",
        createdAt: base + 11,
        parentId: "msg_u1_copy",
      });
      insertMessage(db, {
        id: "msg_u2_edit",
        sessionId: "ses_child",
        role: "user",
        text: "edited second prompt",
        createdAt: base + 200_001,
      });
      insertMessage(db, {
        id: "msg_a2_edit",
        sessionId: "ses_child",
        role: "assistant",
        text: "edited second answer",
        createdAt: base + 200_002,
        parentId: "msg_u2_edit",
      });
      insertMessage(db, {
        id: "msg_u3",
        sessionId: "ses_child",
        role: "user",
        text: "third prompt",
        createdAt: base + 200_003,
      });
      insertMessage(db, {
        id: "msg_a3",
        sessionId: "ses_child",
        role: "assistant",
        text: "third answer",
        createdAt: base + 200_004,
        parentId: "msg_u3",
      });

      insertSession(db, {
        id: "ses_grandchild",
        projectPath,
        createdAt: base + 300_000,
        metadata: {
          yepFork: {
            schemaVersion: 1,
            kind: "edit-fork",
            parentSessionId: "ses_child",
            forkMessageId: "msg_u3",
            createdAt: "2026-07-15T00:00:03.000Z",
          },
        },
      });
      insertMessage(db, {
        id: "msg_u1_copy_2",
        sessionId: "ses_grandchild",
        role: "user",
        text: "搜一下腾讯新发布的 hy3系列模型",
        createdAt: base + 10,
      });
      insertMessage(db, {
        id: "msg_a1_copy_2",
        sessionId: "ses_grandchild",
        role: "assistant",
        text: "腾讯混元 Hy3 已发布。",
        createdAt: base + 11,
        parentId: "msg_u1_copy_2",
      });
      insertMessage(db, {
        id: "msg_u2_edit_copy_2",
        sessionId: "ses_grandchild",
        role: "user",
        text: "edited second prompt",
        createdAt: base + 200_001,
      });
      insertMessage(db, {
        id: "msg_a2_edit_copy_2",
        sessionId: "ses_grandchild",
        role: "assistant",
        text: "edited second answer",
        createdAt: base + 200_002,
        parentId: "msg_u2_edit_copy_2",
      });
      insertMessage(db, {
        id: "msg_u3_edit",
        sessionId: "ses_grandchild",
        role: "user",
        text: "third prompt edited",
        createdAt: base + 300_001,
      });

      insertSession(db, {
        id: "ses_empty_child",
        projectPath,
        createdAt: base + 400_000,
        metadata: {
          yepFork: {
            schemaVersion: 1,
            kind: "edit-fork",
            parentSessionId: "ses_test",
            forkMessageId: "msg_u2",
          },
        },
      });
      insertMessage(db, {
        id: "msg_u1_empty_copy",
        sessionId: "ses_empty_child",
        role: "user",
        text: "搜一下腾讯新发布的 hy3系列模型",
        createdAt: base + 10,
      });
      insertMessage(db, {
        id: "msg_a1_empty_copy",
        sessionId: "ses_empty_child",
        role: "assistant",
        text: "腾讯混元 Hy3 已发布。",
        createdAt: base + 11,
        parentId: "msg_u1_empty_copy",
      });

      // Neither OpenCode parent_id nor malformed metadata may create an edit
      // relation. These rows must not disrupt the valid family.
      insertSession(db, {
        id: "ses_subagent",
        projectPath,
        createdAt: base + 500_000,
        parentId: "ses_test",
      });
      insertSession(db, {
        id: "ses_broken",
        projectPath,
        createdAt: base + 600_000,
        metadata: {
          yepFork: {
            schemaVersion: 1,
            kind: "edit-fork",
            parentSessionId: "ses_test",
            forkMessageId: "missing_message",
          },
        },
      });
      insertMessage(db, {
        id: "msg_broken",
        sessionId: "ses_broken",
        role: "user",
        text: "broken",
        createdAt: base + 600_001,
      });
    } finally {
      db.close();
    }

    const reader = new OpenCodeSessionReader({ dbPath, projectPath });
    const encodedProjectId = encodeProjectId(projectPath);
    const parent = await reader.getSession("ses_test", encodedProjectId);
    const child = await reader.getSession(
      "ses_child",
      encodedProjectId,
      undefined,
      { branchId: "msg_u2_edit" },
    );
    const grandchild = await reader.getSession(
      "ses_grandchild",
      encodedProjectId,
    );

    expect(parent?.branchState?.activeBranchId).toBe("msg_u2");
    expect(child?.branchState?.activeBranchId).toBe("msg_u3");
    expect(child?.branchState?.selectedBranchId).toBe("msg_u2_edit");
    expect(grandchild?.branchState?.activeBranchId).toBe("msg_u3_edit");

    const secondPromptAlternatives = parent?.branchState?.branches.filter(
      (branch) => ["msg_u2", "msg_u2_edit"].includes(branch.id),
    );
    expect(secondPromptAlternatives?.map((branch) => branch.sessionId)).toEqual(
      ["ses_test", "ses_child"],
    );
    expect(
      secondPromptAlternatives?.every((branch) => branch.siblingCount === 2),
    ).toBe(true);
    const thirdPromptAlternatives = parent?.branchState?.branches.filter(
      (branch) => ["msg_u3", "msg_u3_edit"].includes(branch.id),
    );
    expect(thirdPromptAlternatives?.map((branch) => branch.sessionId)).toEqual([
      "ses_child",
      "ses_grandchild",
    ]);
    expect(
      thirdPromptAlternatives?.every((branch) => branch.siblingCount === 2),
    ).toBe(true);
    expect(
      parent?.branchState?.branches.some((branch) =>
        ["msg_u1_copy", "msg_u1_copy_2", "msg_u2_edit_copy_2"].includes(
          branch.id,
        ),
      ),
    ).toBe(false);

    expect(grandchild).toBeDefined();
    if (!grandchild) return;
    const normalizedGrandchild = normalizeSession(grandchild);
    expect(
      normalizedGrandchild.messages.find(
        (message) => message.uuid === "msg_u2_edit_copy_2",
      )?.branch,
    ).toMatchObject({
      sessionId: "ses_child",
      branchId: "msg_u2_edit",
      siblingCount: 2,
    });
    expect(
      normalizedGrandchild.messages.find(
        (message) => message.uuid === "msg_u3_edit",
      )?.branch,
    ).toMatchObject({
      sessionId: "ses_grandchild",
      branchId: "msg_u3_edit",
      siblingCount: 2,
    });
    expect(
      parent?.branchState?.branches.some(
        (branch) => branch.sessionId === "ses_subagent",
      ),
    ).toBe(false);
    expect(
      parent?.branchState?.branches.some(
        (branch) => branch.id === "msg_u1_empty_copy",
      ),
    ).toBe(false);

    const incremental = await reader.getSession(
      "ses_test",
      encodedProjectId,
      "msg_assistant",
    );
    expect(
      incremental?.data.session.messages.map((entry) => entry.message.id),
    ).toEqual(["msg_u2", "msg_a2"]);
    expect(incremental?.branchState?.activeBranchId).toBe("msg_u2");
  });

  it("excludes archived edit forks from active alternatives", async () => {
    const dir = join(tmpdir(), `opencode-reader-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const dbPath = join(dir, "opencode.db");
    const projectPath = join(dir, "archived_branch_project");
    const sqliteAvailable = await createOpenCodeDb(dbPath, projectPath);
    if (!sqliteAvailable) return;
    const sqlite = await loadSqliteModule();
    if (!sqlite) return;
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      insertSession(db, {
        id: "ses_archived_child",
        projectPath,
        createdAt: Date.UTC(2026, 6, 15),
        archivedAt: Date.UTC(2026, 6, 16),
        metadata: {
          yepFork: {
            schemaVersion: 1,
            kind: "edit-fork",
            parentSessionId: "ses_test",
            forkMessageId: "msg_user",
          },
        },
      });
      insertMessage(db, {
        id: "msg_archived_edit",
        sessionId: "ses_archived_child",
        role: "user",
        text: "archived edit",
        createdAt: Date.UTC(2026, 6, 15) + 1,
      });
    } finally {
      db.close();
    }

    const reader = new OpenCodeSessionReader({ dbPath, projectPath });
    const loaded = await reader.getSession(
      "ses_test",
      encodeProjectId(projectPath),
    );
    expect(loaded?.branchState).toBeUndefined();
  });

  it("keeps legacy JSON storage behavior unchanged", async () => {
    const dir = join(tmpdir(), `opencode-reader-legacy-${randomUUID()}`);
    tempDirs.push(dir);
    const storageDir = join(dir, "storage");
    const projectPath = join(dir, "legacy_project");
    const openCodeProjectId = "legacy-project-id";
    await mkdir(join(storageDir, "project"), { recursive: true });
    await mkdir(join(storageDir, "session", openCodeProjectId), {
      recursive: true,
    });
    await mkdir(join(storageDir, "message", "ses_legacy"), {
      recursive: true,
    });
    await mkdir(join(storageDir, "part", "msg_legacy"), { recursive: true });
    await writeFile(
      join(storageDir, "project", `${openCodeProjectId}.json`),
      JSON.stringify({ id: openCodeProjectId, worktree: projectPath }),
    );
    await writeFile(
      join(storageDir, "session", openCodeProjectId, "ses_legacy.json"),
      JSON.stringify({
        id: "ses_legacy",
        projectID: openCodeProjectId,
        title: "Legacy",
        time: { created: 1, updated: 2 },
      }),
    );
    await writeFile(
      join(storageDir, "message", "ses_legacy", "msg_legacy.json"),
      JSON.stringify({
        id: "msg_legacy",
        sessionID: "ses_legacy",
        role: "user",
        time: { created: 1 },
      }),
    );
    await writeFile(
      join(storageDir, "part", "msg_legacy", "part_legacy.json"),
      JSON.stringify({
        id: "part_legacy",
        sessionID: "ses_legacy",
        messageID: "msg_legacy",
        type: "text",
        text: "legacy prompt",
      }),
    );

    const reader = new OpenCodeSessionReader({
      dbPath: join(dir, "missing.db"),
      storageDir,
      projectPath,
    });
    const loaded = await reader.getSession(
      "ses_legacy",
      encodeProjectId(projectPath),
      undefined,
      { branchId: "ignored" },
    );
    expect(loaded?.data.session.messages).toHaveLength(1);
    expect(loaded?.branchState).toBeUndefined();
  });
});
