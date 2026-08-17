/**
 * Gate for partial-read parity.
 *
 * The mtime-index optimization serves a session window by reading only the tail
 * of a rollout instead of the whole file. That is only safe if the window it
 * produces is indistinguishable from the window a full read produces — including
 * message ids, which callers round-trip as pagination cursors
 * (`truncatedBeforeMessageId`, `beforeMessageId`, `aroundMessageId`) and use for
 * scroll anchoring.
 *
 * These tests read the same fixture both ways and require the windows to be
 * deep-equal. They fail loudly if message identity ever becomes a function of
 * how much of the file was parsed.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexSessionEntry,
  parseCodexSessionEntry,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachCodexEntryByteOffset } from "../../src/sessions/codex-entry-anchor.js";
import { buildCodexBranchView } from "../../src/sessions/codex-rollback.js";
import { codexRolloutSupportsTailRead } from "../../src/sessions/codex-tail-read.js";
import { convertCodexEntries } from "../../src/sessions/normalization.js";
import { sliceAtCompactBoundaries } from "../../src/sessions/pagination.js";
import type { Message } from "../../src/supervisor/types.js";

const SESSION_ID = "00000000-0000-0000-0000-0000000000aa";
const CWD = "/tmp/parity-project";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-parity-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ts(seconds: number): string {
  return new Date(Date.UTC(2026, 7, 15, 0, 0, seconds)).toISOString();
}

function metaLine(): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp: ts(0),
    payload: { id: SESSION_ID, timestamp: ts(0), cwd: CWD },
  });
}

function userLine(text: string, second: number): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: ts(second),
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

function assistantLine(text: string, second: number): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: ts(second),
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  });
}

function compactedLine(second: number): string {
  return JSON.stringify({
    type: "compacted",
    timestamp: ts(second),
    payload: { message: "summary" },
  });
}

function rolledBackLine(numTurns: number, second: number): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts(second),
    payload: { type: "thread_rolled_back", num_turns: numTurns },
  });
}

/** Build a rollout body plus the byte offset of every line. */
function layout(lines: string[]): { body: string; offsets: number[] } {
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += Buffer.byteLength(line, "utf8") + 1;
  }
  return { body: `${lines.join("\n")}\n`, offsets };
}

/** Parse a slice of rollout text, anchoring each entry at its absolute offset. */
function parseWithOffsets(
  text: string,
  baseOffset: number,
): CodexSessionEntry[] {
  const entries: CodexSessionEntry[] = [];
  let cursor = baseOffset;
  for (const line of text.split("\n")) {
    const length = Buffer.byteLength(line, "utf8") + 1;
    if (line) {
      const entry = parseCodexSessionEntry(line);
      if (entry) {
        attachCodexEntryByteOffset(entry, cursor);
        entries.push(entry);
      }
    }
    cursor += length;
  }
  return entries;
}

function windowFrom(
  entries: CodexSessionEntry[],
  tailCompactions: number,
  maxMessages: number,
): { messages: Message[]; total: number } {
  const view = buildCodexBranchView(entries, SESSION_ID);
  const messages = convertCodexEntries(
    view.entries,
    SESSION_ID,
    view.branchState,
  );
  const sliced = sliceAtCompactBoundaries(
    messages,
    tailCompactions,
    undefined,
    maxMessages,
  );
  return { messages: sliced.messages, total: messages.length };
}

interface Fixture {
  filePath: string;
  body: string;
  /** Byte offset of the Nth-from-last `compacted` line. */
  tailOffset: number;
}

async function writeFixture(
  name: string,
  lines: string[],
  tailFromCompaction: number,
): Promise<Fixture> {
  const { body, offsets } = layout(lines);
  const filePath = join(dir, name);
  await writeFile(filePath, body, "utf8");

  const compactedIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes('"compacted"'))
    .map(({ index }) => index);
  const pick = compactedIndexes[compactedIndexes.length - tailFromCompaction];
  const tailOffset = pick === undefined ? 0 : (offsets[pick] ?? 0);
  return { filePath, body, tailOffset };
}

async function readTail(filePath: string, offset: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const length = size - offset;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, offset);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function conversation(turns: number, compactEvery: number): string[] {
  const lines = [metaLine()];
  let second = 1;
  for (let turn = 0; turn < turns; turn++) {
    lines.push(userLine(`prompt ${turn}`, second++));
    lines.push(assistantLine(`reply ${turn}`, second++));
    if (compactEvery > 0 && (turn + 1) % compactEvery === 0) {
      lines.push(compactedLine(second++));
    }
  }
  return lines;
}

describe("codex partial-read parity", () => {
  it("produces the same window from a full read and a tail read", async () => {
    const fixture = await writeFixture(
      "with-compaction.jsonl",
      conversation(40, 8),
      2,
    );

    const full = windowFrom(parseWithOffsets(fixture.body, 0), 2, 20);
    const tail = windowFrom(
      parseWithOffsets(
        await readTail(fixture.filePath, fixture.tailOffset),
        fixture.tailOffset,
      ),
      2,
      20,
    );

    expect(tail.messages).toHaveLength(full.messages.length);
    expect(tail.messages).toEqual(full.messages);
  });

  it("keeps ids identical across read extents", async () => {
    const fixture = await writeFixture("ids.jsonl", conversation(40, 8), 2);

    const full = windowFrom(parseWithOffsets(fixture.body, 0), 2, 20);
    const tail = windowFrom(
      parseWithOffsets(
        await readTail(fixture.filePath, fixture.tailOffset),
        fixture.tailOffset,
      ),
      2,
      20,
    );

    expect(tail.messages.map((message) => message.uuid)).toEqual(
      full.messages.map((message) => message.uuid),
    );
  });

  it("refuses tail reads for rollouts that contain rollback markers", async () => {
    // A `thread_rolled_back` marker drops the user turns *before* it. A tail read
    // cannot see those turns, so the marker silently does nothing and the window
    // keeps history a full read discards — a semantic divergence that no id
    // scheme can fix. Such rollouts must be read in full.
    const lines = conversation(20, 5);
    lines.push(rolledBackLine(2, 500));
    lines.push(userLine("after rollback", 501));
    lines.push(assistantLine("reply after rollback", 502));
    lines.push(compactedLine(503));
    lines.push(userLine("final", 504));
    lines.push(assistantLine("final reply", 505));
    const fixture = await writeFixture("rollback.jsonl", lines, 2);

    const allEntries = parseWithOffsets(fixture.body, 0);
    const tailEntries = parseWithOffsets(
      await readTail(fixture.filePath, fixture.tailOffset),
      fixture.tailOffset,
    );

    expect(codexRolloutSupportsTailRead(allEntries)).toBe(false);

    // Documents *why* the guard exists: the two windows really do differ.
    const full = windowFrom(allEntries, 2, 20);
    const tail = windowFrom(tailEntries, 2, 20);
    expect(tail.messages).not.toEqual(full.messages);
  });

  it("allows tail reads for rollouts without rollback markers", async () => {
    const fixture = await writeFixture(
      "no-rollback.jsonl",
      conversation(20, 5),
      2,
    );
    const entries = parseWithOffsets(fixture.body, 0);

    expect(codexRolloutSupportsTailRead(entries)).toBe(true);
  });

  it("keeps ids stable when the entry array is re-sliced", async () => {
    // Selecting a different branch changes which entries are visible, which used
    // to shift every downstream message id.
    const fixture = await writeFixture(
      "resliced.jsonl",
      conversation(12, 0),
      1,
    );
    const entries = parseWithOffsets(fixture.body, 0);

    const wholeIds = convertCodexEntries(entries, SESSION_ID).map(
      (message) => message.uuid,
    );
    const droppedPrefixIds = convertCodexEntries(
      entries.slice(5),
      SESSION_ID,
    ).map((message) => message.uuid);

    // Every id produced from the shorter array must also exist in the full run.
    for (const id of droppedPrefixIds) {
      expect(wholeIds).toContain(id);
    }
  });
});

describe("codex entry anchoring", () => {
  it("uses offset anchors for entries read from a rollout", async () => {
    // Guards against the positional fallback silently taking over: if offsets
    // ever stop being attached at read time, ids revert to being a function of
    // read extent and every parity guarantee above becomes vacuous.
    const fixture = await writeFixture("anchored.jsonl", conversation(4, 0), 1);
    const entries = parseWithOffsets(fixture.body, 0);

    const ids = convertCodexEntries(entries, SESSION_ID).map(
      (message) => message.uuid,
    );

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toMatch(/^codex(-[a-z]+)*-@\d+/);
    }
  });

  it("keeps the historical id shape for entries built without a file", () => {
    // Hand-built entries (fixtures, other providers' tests) must not change ids.
    const entry = parseCodexSessionEntry(userLine("no offset", 1));
    expect(entry).not.toBeNull();

    const ids = convertCodexEntries(
      [entry as CodexSessionEntry],
      SESSION_ID,
    ).map((message) => message.uuid);

    expect(ids[0]).toBe(`codex-0-${ts(1)}`);
  });
});
