import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import { AgySessionReader } from "../../src/sessions/agy-reader.js";
import {
  agySessionIdFromWatchPath,
  annotateAgyReplyPhases,
  findAgySessionRecord,
  listAgySessionRecords,
  parseAgyTime,
  pickAgyWorkspace,
  readAgyTranscript,
  readAgyUserText,
} from "../../src/sessions/agy-store.js";
import {
  cleanAgyToolOutput,
  readAgyToolTiming,
} from "../../src/sessions/agy-tools.js";

function openSqlite() {
  const sqlite = process.getBuiltinModule?.("node:sqlite") as
    | {
        DatabaseSync: new (
          path: string,
        ) => {
          exec(sql: string): void;
          prepare(sql: string): { run(...params: unknown[]): unknown };
          close(): void;
        };
      }
    | undefined;
  if (!sqlite) throw new Error("node:sqlite unavailable");
  return sqlite;
}

const SESSION_ID = "fddfa614-7d5b-4c2e-aa2a-fcc2793821a6";
const CHILD_ID = "11111111-2222-4333-8444-555555555555";
const EMPTY_ID = "e1bd2f4e-d2e6-46df-8ca2-cc6b65b57c16";

// Rows shaped like references/antigravity/probe transcript_full.jsonl.
const STEPS = [
  {
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-11-21T08:58:00Z",
    content:
      "<USER_REQUEST>\nCreate note.txt then run ls.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: x.\n</ADDITIONAL_METADATA>",
  },
  {
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-11-21T08:58:00Z",
    model: "gemini-3.8-flash-low",
    input_tokens: 2159,
    cache_read_tokens: 6631,
    output_tokens: 73,
    thinking: "Plan the two calls.",
    tool_calls: [
      {
        name: "write_file",
        args: { Content: "probe ok", Path: "/w/note.txt" },
      },
      {
        name: "run_command",
        args: { CommandLine: "ls -la", toolSummary: "List directory" },
      },
    ],
  },
  {
    step_index: 2,
    source: "MODEL",
    type: "GENERIC",
    status: "DONE",
    created_at: "2026-11-21T08:58:04Z",
    content:
      "Created At: 2026-11-21T16:58:04+08:00\nCompleted At: 2026-11-21T16:58:07+08:00\nCreated file.",
  },
  {
    step_index: 3,
    source: "MODEL",
    type: "GENERIC",
    status: "ERROR",
    created_at: "2026-11-21T08:58:04Z",
    error: "user denied permission to run command:\nls -la",
    content: "Created At: x\nEncountered error in step execution: denied",
  },
  {
    step_index: 4,
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    status: "DONE",
    created_at: "2026-11-21T09:00:09Z",
    content: "<SYSTEM_MESSAGE>background tasks stopped</SYSTEM_MESSAGE>",
  },
  {
    step_index: 5,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-11-21T09:00:10Z",
    model: "gemini-4-neon-high",
    content: "Done.",
  },
  {
    step_index: 6,
    source: "SYSTEM",
    type: "CHECKPOINT",
    status: "DONE",
    created_at: "2026-11-21T09:01:00Z",
    content: "# Resuming from a compaction",
  },
];

describe("agy store", () => {
  let dataDir: string;
  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function seed(): Promise<void> {
    dataDir = await mkdtemp(join(tmpdir(), "agy-store-"));
    await mkdir(join(dataDir, "conversations"), { recursive: true });
    const logs = join(
      dataDir,
      "brain",
      SESSION_ID,
      ".system_generated",
      "logs",
    );
    await mkdir(logs, { recursive: true });
    await writeFile(
      join(logs, "transcript_full.jsonl"),
      `${STEPS.map((step) => JSON.stringify(step)).join("\n")}\n{"step_index":`,
    );

    const { DatabaseSync } = openSqlite();
    const catalog = new DatabaseSync(
      join(dataDir, "conversation_summaries.db"),
    );
    catalog.exec(`CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '',
      preview text NOT NULL DEFAULT '', step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL, workspace_uris text NOT NULL,
      status text NOT NULL DEFAULT '', parent_conversation_id text NOT NULL DEFAULT '',
      last_user_input_time datetime NOT NULL)`);
    const insert = catalog.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      SESSION_ID,
      "Write a note",
      "Write a note",
      7,
      "2026-11-21 09:01:00.123456+00:00",
      JSON.stringify(["file:///w"]),
      "CASCADE_RUN_STATUS_IDLE",
      "",
      "2026-11-21 08:58:00+00:00",
    );
    // Subagent runs and never-prompted sessions are not listed.
    insert.run(
      CHILD_ID,
      "child",
      "",
      3,
      "2026-11-21 09:02:00+00:00",
      JSON.stringify(["file:///w"]),
      "",
      SESSION_ID,
      "2026-11-21 09:02:00+00:00",
    );
    insert.run(
      EMPTY_ID,
      "",
      "",
      0,
      "0001-01-01 00:00:00+00:00",
      JSON.stringify(["file:///w"]),
      "",
      "",
      "0001-01-01 00:00:00+00:00",
    );
    catalog.close();

    const conversation = new DatabaseSync(
      join(dataDir, "conversations", `${SESSION_ID}.db`),
    );
    conversation.exec(
      "CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, step_payload blob)",
    );
    const step = conversation.prepare(
      "INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)",
    );
    step.run(
      1,
      15,
      Buffer.from(
        "\u0012\u0018call_2435139212849124346\u0012\u0018call_2435139212849126127",
      ),
    );
    step.run(2, 132, Buffer.from("\u0012\u0018call_2435139212849124346"));
    step.run(3, 132, Buffer.from("\u0012\u0018call_2435139212849126127"));
    conversation.close();
  }

  it("lists root conversations with their workspace", async () => {
    await seed();
    const records = await listAgySessionRecords({ dataDir });
    expect(records.map((record) => record.sessionId)).toEqual([SESSION_ID]);
    expect(records[0]).toMatchObject({
      cwd: "/w",
      title: "Write a note",
      stepCount: 7,
      updatedAtMs: Date.parse("2026-11-21T09:01:00.123Z"),
    });
    expect(await findAgySessionRecord(CHILD_ID, { dataDir })).toBeNull();
  });

  it("projects steps into a Pi session with ACP tool ids", async () => {
    await seed();
    const record = await findAgySessionRecord(SESSION_ID, { dataDir });
    if (!record) throw new Error("record expected");
    const session = await readAgyTranscript(record);
    const summary = session?.entries.map((entry) =>
      entry.type === "message"
        ? {
            role: entry.message.role,
            ...("toolCallId" in entry.message
              ? {
                  toolCallId: entry.message.toolCallId,
                  isError: entry.message.isError,
                }
              : {}),
          }
        : { type: entry.type },
    );
    expect(summary).toEqual([
      { role: "user" },
      { role: "assistant" },
      {
        role: "toolResult",
        toolCallId: "call_2435139212849124346",
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "call_2435139212849126127",
        isError: true,
      },
      { role: "assistant" },
      { type: "compaction" },
    ]);
    const user = session?.entries[0];
    expect(user?.type === "message" && user.message.content).toEqual([
      { type: "text", text: "Create note.txt then run ls." },
    ]);
    const assistant = session?.entries[1];
    if (assistant?.type !== "message" || assistant.message.role !== "assistant")
      throw new Error("assistant expected");
    expect(assistant.message.model).toBe("gemini-3.8-flash-low");
    expect(assistant.message.content).toEqual([
      { type: "thinking", thinking: "Plan the two calls." },
      {
        type: "toolCall",
        id: "call_2435139212849124346",
        name: "Write",
        arguments: {
          Content: "probe ok",
          Path: "/w/note.txt",
          file_path: "/w/note.txt",
          content: "probe ok",
        },
      },
      {
        type: "toolCall",
        id: "call_2435139212849126127",
        name: "Bash",
        arguments: {
          CommandLine: "ls -la",
          toolSummary: "List directory",
          command: "ls -la",
          description: "List directory",
        },
      },
    ]);
    const written = session?.entries[2];
    expect(
      written?.type === "message" &&
        written.message.role === "toolResult" &&
        written.message.content,
    ).toEqual([{ type: "text", text: "Created file." }]);
    // The result is stamped when the call ended and carries agy's own
    // call-to-result time, not the planner step's shared start.
    expect(written?.timestamp).toBe("2026-11-21T08:58:07.000Z");
    expect(
      written?.type === "message" &&
        written.message.role === "toolResult" &&
        written.message.durationMs,
    ).toBe(3000);
    const denied = session?.entries[3];
    expect(
      denied?.type === "message" &&
        denied.message.role === "toolResult" &&
        "durationMs" in denied.message,
    ).toBe(false);
  });

  it("falls back to synthesized ids without the conversation store", async () => {
    await seed();
    const record = await findAgySessionRecord(SESSION_ID, { dataDir });
    if (!record) throw new Error("record expected");
    const session = await readAgyTranscript({
      ...record,
      conversationDbPath: join(dataDir, "missing.db"),
    });
    const ids = session?.entries.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult"
        ? [entry.message.toolCallId]
        : [],
    );
    expect(ids).toEqual(["agy-call-1-0", "agy-call-1-1"]);
  });

  it("summarizes sessions for a project", async () => {
    await seed();
    const reader = new AgySessionReader({ dataDir, projectPath: "/w" });
    const sessions = await reader.listSessions("p" as UrlProjectId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: SESSION_ID,
      provider: "agy",
      title: "Write a note",
      createdAt: "2026-11-21T08:58:00.000Z",
    });
    const other = new AgySessionReader({ dataDir, projectPath: "/elsewhere" });
    expect(await other.listSessions("p" as UrlProjectId)).toEqual([]);
  });

  it("sizes the context meter by agy's compaction limit, not 1M", async () => {
    await seed();
    // A model-info cache that knows nothing falls back to agy's own table;
    // the reader must ask as provider "agy", not Pi's gateway defaults.
    const asked: (string | undefined)[] = [];
    const reader = new AgySessionReader({
      dataDir,
      projectPath: "/w",
      getContextWindow: (_model, provider) => {
        asked.push(provider);
        return undefined;
      },
    });
    const [summary] = await reader.listSessions("p" as UrlProjectId);
    // The fixture ends with a CHECKPOINT, so the fill is unknown but the
    // window is still reported (gemini-4-neon → 512K).
    expect(summary?.contextUsage).toMatchObject({
      contextWindow: 512_000,
      unknown: true,
    });
    expect(asked).toContain("agy");
    expect(asked).not.toContain("pi");
  });
});

describe("agy store helpers", () => {
  it("parses Go timestamps and the zero time", () => {
    expect(parseAgyTime("2026-11-21 08:58:04.649217+00:00")).toBe(
      Date.parse("2026-11-21T08:58:04.649Z"),
    );
    expect(parseAgyTime("0001-01-01 00:00:00+00:00")).toBeNull();
  });

  it("prefers the requested spelling of an aliased workspace", () => {
    expect(
      pickAgyWorkspace(JSON.stringify(["file:///private/tmp", "file:///tmp"])),
    ).toBe(process.platform === "darwin" ? "/tmp" : "/private/tmp");
    if (process.platform === "darwin") {
      // agy lists the two spellings in either order.
      expect(
        pickAgyWorkspace(
          JSON.stringify(["file:///tmp", "file:///private/tmp"]),
        ),
      ).toBe("/tmp");
    }
    expect(pickAgyWorkspace(JSON.stringify(["file:///a", "file:///b"]))).toBe(
      "/a",
    );
    expect(pickAgyWorkspace("not json")).toBeNull();
  });

  it("extracts the typed prompt and cleans tool output", () => {
    expect(
      readAgyUserText(
        "<USER_REQUEST>\nhi\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>x</USER_SETTINGS_CHANGE>",
      ),
    ).toBe("hi");
    expect(
      cleanAgyToolOutput(
        "Created At: a\nCompleted At: b\nCreated At: a\nCompleted At: b\nok\n",
      ),
    ).toBe("ok");
  });

  it("reads per-call timing from result bookkeeping lines", () => {
    expect(
      readAgyToolTiming(
        "Created At: 2026-11-22T23:48:53+08:00\nCompleted At: 2026-11-22T23:50:15+08:00\nCreated At: 2026-11-22T23:48:53+08:00\nCompleted At: 2026-11-22T23:50:15+08:00\nMade 1 replacement",
      ),
    ).toEqual({
      createdAtMs: Date.parse("2026-11-22T15:48:53Z"),
      completedAtMs: Date.parse("2026-11-22T15:50:15Z"),
      durationMs: 82_000,
    });
    // A background task has started but not ended.
    expect(
      readAgyToolTiming(
        "Created At: 2026-11-22T23:52:10+08:00\nTool is running as a background task",
      ),
    ).toEqual({ createdAtMs: Date.parse("2026-11-22T15:52:10Z") });
    expect(readAgyToolTiming("Created At: x\nok")).toEqual({});
    expect(readAgyToolTiming(undefined)).toEqual({});
  });

  it("maps watched paths to conversation ids", () => {
    expect(
      agySessionIdFromWatchPath(
        `/h/.gemini/antigravity-cli/brain/${SESSION_ID}/.system_generated/logs/transcript_full.jsonl`,
      ),
    ).toBe(SESSION_ID);
    expect(
      agySessionIdFromWatchPath(
        `${SESSION_ID}/.system_generated/logs/transcript_full.jsonl`,
      ),
    ).toBe(SESSION_ID);
    expect(agySessionIdFromWatchPath("/h/other/file")).toBeNull();
  });
});

describe("agy reply phases", () => {
  const assistant = (uuid: string, content: unknown[]) =>
    ({
      type: "assistant",
      uuid,
      message: { role: "assistant", content },
    }) as never;

  it("keeps replies to the user outside the folded work", () => {
    const messages = annotateAgyReplyPhases([
      // Pause while background tasks run: text, no tool call.
      assistant("agy-step-102", [
        { type: "text", text: "Running both checks." },
      ]),
      // Report next to a question.
      assistant("agy-step-153", [
        { type: "text", text: "Report…" },
        { type: "tool_use", id: "c1", name: "AskUserQuestion", input: {} },
      ]),
      // Narration of ordinary work.
      assistant("agy-step-155", [
        { type: "text", text: "Let me check the migrations." },
        { type: "tool_use", id: "c2", name: "Bash", input: {} },
      ]),
      // Tool-only and thinking-only steps.
      assistant("agy-step-156", [
        { type: "tool_use", id: "c3", name: "Read", input: {} },
      ]),
      assistant("agy-step-157", [{ type: "thinking", thinking: "hmm" }]),
      // Not an agy step id (live stream rows).
      assistant("live-1", [{ type: "text", text: "streamed" }]),
    ]) as Array<{ uuid: string; codexMessagePhase?: string }>;
    expect(
      messages.map((message) => [message.uuid, message.codexMessagePhase]),
    ).toEqual([
      ["agy-step-102", "final_answer"],
      ["agy-step-153", "final_answer"],
      ["agy-step-155", undefined],
      ["agy-step-156", undefined],
      ["agy-step-157", undefined],
      ["live-1", undefined],
    ]);
  });
});
