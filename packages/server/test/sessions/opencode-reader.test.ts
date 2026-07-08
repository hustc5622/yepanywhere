import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeSessionScanner } from "../../src/projects/opencode-scanner.js";
import { encodeProjectId } from "../../src/projects/paths.js";
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
          tokens_cache_read
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "ses_test",
      "global",
      "test",
      projectPath,
      "Yep Anywhere Session",
      "1",
      createdAt,
      updatedAt,
      JSON.stringify({
        id: "glm-5.2",
        providerID: "anthropic",
        variant: "default",
      }),
      1000,
      50,
      200,
    );

    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "msg_user",
      "ses_test",
      createdAt + 10,
      createdAt + 10,
      JSON.stringify({
        role: "user",
        time: { created: createdAt + 10 },
        model: { providerID: "anthropic", modelID: "glm-5.2" },
      }),
    );
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
});
