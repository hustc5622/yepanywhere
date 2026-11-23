import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgyForkLineage,
  AgySessionReader,
} from "../../src/sessions/agy-reader.js";
import {
  agyStepEntryId,
  parseAgyStepEntryId,
} from "../../src/sessions/agy-store.js";
import { normalizeSession } from "../../src/sessions/normalization.js";

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

const SOURCE = "a0476472-2b9a-4ba8-807f-fa5b2b5adfac";
const FORK = "22711671-a480-44c1-b939-3b242a355855";
const FRESH = "33333333-4444-4555-8666-777777777777";

type Step = Record<string, unknown>;

const user = (index: number, at: string, text: string): Step => ({
  step_index: index,
  source: "USER_EXPLICIT",
  type: "USER_INPUT",
  status: "DONE",
  created_at: at,
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
});
const reply = (index: number, at: string, text: string): Step => ({
  step_index: index,
  source: "MODEL",
  type: "PLANNER_RESPONSE",
  status: "DONE",
  created_at: at,
  content: text,
});

const SOURCE_STEPS = [
  user(0, "2026-11-21T08:00:00Z", "first"),
  reply(1, "2026-11-21T08:00:05Z", "a1"),
  user(2, "2026-11-21T08:01:00Z", "second"),
  reply(3, "2026-11-21T08:01:05Z", "a2"),
  user(4, "2026-11-21T08:02:00Z", "third"),
  reply(5, "2026-11-21T08:02:05Z", "a3"),
];
// agy ForkConversation at step 1: steps 0..1 keep their indexes and
// timestamps, then the fork notice and the edited prompt follow. Its later
// prompts reuse step indexes the source also has.
const FORK_STEPS = [
  SOURCE_STEPS[0] as Step,
  SOURCE_STEPS[1] as Step,
  {
    step_index: 2,
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    status: "DONE",
    created_at: "2026-11-21T09:00:00Z",
    content: "<SYSTEM_MESSAGE>forked</SYSTEM_MESSAGE>",
  },
  user(3, "2026-11-21T09:00:01Z", "second, edited"),
  reply(4, "2026-11-21T09:00:05Z", "b2"),
  user(5, "2026-11-21T09:01:00Z", "follow-up"),
  reply(6, "2026-11-21T09:01:05Z", "b3"),
];
// Editing the first prompt starts a fresh conversation; resubmitting the
// same text must not count as copied history.
const FRESH_STEPS = [
  user(0, "2026-11-21T10:00:00Z", "first"),
  reply(1, "2026-11-21T10:00:05Z", "c1"),
];

const LINEAGE: AgyForkLineage[] = [
  {
    sessionId: FORK,
    forkParentSessionId: SOURCE,
    forkTargetMessageId: agyStepEntryId(SOURCE, 2),
  },
  {
    sessionId: FRESH,
    forkParentSessionId: SOURCE,
    forkTargetMessageId: agyStepEntryId(SOURCE, 0),
  },
];

describe("agy edit-fork branch view", () => {
  let dataDir: string;
  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function seed(): Promise<void> {
    dataDir = await mkdtemp(join(tmpdir(), "agy-branch-"));
    await mkdir(join(dataDir, "conversations"), { recursive: true });
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
    for (const [id, steps, at] of [
      [SOURCE, SOURCE_STEPS, "2026-11-21 08:02:05+00:00"],
      [FORK, FORK_STEPS, "2026-11-21 09:01:05+00:00"],
      [FRESH, FRESH_STEPS, "2026-11-21 10:00:05+00:00"],
    ] as const) {
      const logs = join(dataDir, "brain", id, ".system_generated", "logs");
      await mkdir(logs, { recursive: true });
      await writeFile(
        join(logs, "transcript_full.jsonl"),
        `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`,
      );
      insert.run(
        id,
        "Pong",
        "Pong",
        steps.length,
        at,
        JSON.stringify(["file:///w"]),
        "CASCADE_RUN_STATUS_IDLE",
        "",
        at,
      );
    }
    catalog.close();
  }

  const reader = (lineage: AgyForkLineage[] = LINEAGE) =>
    new AgySessionReader({
      dataDir,
      projectPath: "/w",
      getForkLineage: () => lineage,
    });

  it("qualifies step ids by conversation", () => {
    expect(agyStepEntryId(SOURCE, 8)).toBe(`agy-${SOURCE}-step-8`);
    expect(parseAgyStepEntryId(agyStepEntryId(SOURCE, 8))).toEqual({
      sessionId: SOURCE,
      stepIndex: 8,
    });
    expect(parseAgyStepEntryId("agy-step-3")).toEqual({
      sessionId: null,
      stepIndex: 3,
    });
    expect(parseAgyStepEntryId("agy-call-1-0")).toBeNull();
    expect(parseAgyStepEntryId("msg_user")).toBeNull();
  });

  it("shows the edited prompts as siblings of the prompts they replaced", async () => {
    await seed();
    const state = await reader().getBranchState(FORK);
    if (!state) throw new Error("branch state expected");
    const byId = new Map(state.branches.map((branch) => [branch.id, branch]));
    const id = agyStepEntryId;

    // Copied history is not a branch of its own.
    expect(byId.has(id(FORK, 0))).toBe(false);
    expect(state.branches.map((branch) => branch.id).sort()).toEqual(
      [
        id(SOURCE, 0),
        id(SOURCE, 2),
        id(SOURCE, 4),
        id(FORK, 3),
        id(FORK, 5),
        id(FRESH, 0),
      ].sort(),
    );
    expect(byId.get(id(FORK, 3))).toMatchObject({
      sessionId: FORK,
      parentId: id(SOURCE, 0),
      siblingCount: 2,
      isActive: true,
    });
    expect(byId.get(id(SOURCE, 2))).toMatchObject({
      parentId: id(SOURCE, 0),
      siblingCount: 2,
    });
    expect(byId.get(id(FORK, 5))?.parentId).toBe(id(FORK, 3));
    // The resubmitted first prompt has a new timestamp, so it is an edit.
    expect(byId.get(id(FRESH, 0))).toMatchObject({
      sessionId: FRESH,
      parentId: byId.get(id(SOURCE, 0))?.parentId,
      siblingCount: 2,
    });
    expect(state.activeBranchId).toBe(id(FORK, 5));
  });

  it("annotates the loaded transcript with its branch switcher", async () => {
    await seed();
    const loaded = await reader().getSession(FORK, "p" as UrlProjectId);
    expect(loaded?.branchState?.sessionId).toBe(FORK);
    const users = loaded?.precomputedPiMessages?.messages.filter(
      (message) => message.type === "user",
    );
    expect(users?.map((message) => message.uuid)).toEqual([
      agyStepEntryId(FORK, 0),
      agyStepEntryId(FORK, 3),
      agyStepEntryId(FORK, 5),
    ]);
    if (!loaded) throw new Error("session expected");
    const session = normalizeSession(loaded);
    expect(session.branchState?.sessionId).toBe(FORK);
    const edited = session.messages.find(
      (message) => message.uuid === agyStepEntryId(FORK, 3),
    );
    expect(edited?.branch).toMatchObject({
      sessionId: FORK,
      siblingIndex: 2,
      siblingCount: 2,
    });
    expect(
      edited?.branch?.alternatives.map((branch) => branch.sessionId),
    ).toEqual([SOURCE, FORK]);
  });

  it("has no branch state without recorded lineage", async () => {
    await seed();
    expect(await reader([]).getBranchState(FORK)).toBeUndefined();
    const loaded = await reader([]).getSession(SOURCE, "p" as UrlProjectId);
    expect(loaded?.branchState).toBeUndefined();
  });
});
