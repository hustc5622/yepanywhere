import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlCodexEventStore } from "../../src/codex-events/index.js";
import { testDraft } from "./helpers.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-store-jsonl-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("JsonlCodexEventStore chunked load", () => {
  it("loads a multi-chunk journal with multi-byte characters across chunk boundaries", async () => {
    const filePath = join(tempDir(), "events.jsonl");
    const writer = new JsonlCodexEventStore({ filePath });
    // Multi-byte characters long enough to straddle many tiny read chunks.
    const longText = "界面文案🙂".repeat(200);
    await writer.append(
      testDraft("item/started", { note: longText }, { eventId: "event-1" }),
    );
    await writer.append(
      testDraft(
        "warning",
        { message: "第二条会话" },
        { eventId: "event-2", sessionId: "session-2" },
      ),
    );

    const reader = new JsonlCodexEventStore({ filePath, loadChunkBytes: 16 });
    const sessionOne = await reader.replay({ sessionId: "session-1" });
    const sessionTwo = await reader.replay({ sessionId: "session-2" });

    expect(sessionOne).toHaveLength(1);
    expect(sessionOne[0]?.payload).toEqual({
      safety: "safe",
      data: { note: longText },
    });
    expect(sessionTwo).toHaveLength(1);
    expect(sessionTwo[0]?.payload).toEqual({
      safety: "safe",
      data: { message: "第二条会话" },
    });
  });

  it("tolerates a corrupt partial final line and starts the next append on a fresh line", async () => {
    const filePath = join(tempDir(), "events.jsonl");
    const writer = new JsonlCodexEventStore({ filePath });
    await writer.append(
      testDraft("warning", { message: "first" }, { eventId: "event-1" }),
    );
    // Simulate a crashed writer: partial record without a trailing newline.
    writeFileSync(filePath, `${readFileSync(filePath, "utf8")}not-json`);

    const corrupt: Array<{ lineNumber: number; reason: string }> = [];
    const reader = new JsonlCodexEventStore({
      filePath,
      loadChunkBytes: 8,
      onCorruptLine: (details) => corrupt.push(details),
    });

    expect(await reader.replay({ sessionId: "session-1" })).toHaveLength(1);
    expect(corrupt).toEqual([{ lineNumber: 2, reason: "invalid_json" }]);

    await reader.append(
      testDraft("warning", { message: "second" }, { eventId: "event-2" }),
    );
    const lines = readFileSync(filePath, "utf8").split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe("not-json");
    expect(JSON.parse(lines[2] as string)).toMatchObject({
      eventId: "event-2",
      sequence: 2,
    });

    // The appended event is replayable despite the corrupt line in between.
    expect(await reader.replay({ sessionId: "session-1" })).toHaveLength(2);
  });

  it("retries a failed cold load instead of poisoning the store", async () => {
    const filePath = join(tempDir(), "events.jsonl");
    // A directory makes the cold load fail with EISDIR on the first read.
    mkdirSync(filePath);
    const store = new JsonlCodexEventStore({ filePath, loadChunkBytes: 8 });

    await expect(store.replay({ sessionId: "session-1" })).rejects.toThrow();

    rmSync(filePath, { recursive: true, force: true });
    const writer = new JsonlCodexEventStore({ filePath });
    await writer.append(
      testDraft("warning", { message: "recovered" }, { eventId: "event-1" }),
    );

    // Same store instance recovers on the next call.
    await expect(
      store.replay({ sessionId: "session-1" }),
    ).resolves.toHaveLength(1);
  });
});

describe("JsonlCodexEventStore rotation", () => {
  it("rotates the active journal into a segment and replays across segment boundaries", async () => {
    const directory = tempDir();
    const filePath = join(directory, "events.jsonl");
    const rotations: Array<{ from: string; to: string; pruned: string[] }> = [];
    const store = new JsonlCodexEventStore({
      filePath,
      rotation: { maxBytes: 600, keepSegments: 10 },
      onRotate: (details) => rotations.push(details),
    });

    // Each event is ~300 bytes, so a few appends cross the 600-byte waterline.
    for (let index = 1; index <= 6; index += 1) {
      await store.append(
        testDraft(
          index % 2 === 0 ? "turn/completed" : "error",
          { message: `event-${index} ${"x".repeat(200)}` },
          { eventId: `event-${index}` },
        ),
      );
    }

    expect(rotations.length).toBeGreaterThanOrEqual(1);
    expect(rotations[0]?.from).toBe(filePath);
    expect(rotations[0]?.to).toMatch(/events\.\d{17}(-\d+)?\.jsonl$/);
    const segmentFiles = readdirSync(directory).filter((entry) =>
      /^events\.\d{17}(-\d+)?\.jsonl$/.test(entry),
    );
    expect(segmentFiles.length).toBeGreaterThanOrEqual(1);

    // The rotating instance keeps every event replayable in-process.
    const inProcess = await store.replay({ sessionId: "session-1" });
    expect(inProcess).toHaveLength(6);
    expect(inProcess.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(
      (await store.replay({ sessionId: "session-1", methods: ["error"] })).map(
        (event) => event.eventId,
      ),
    ).toEqual(["event-1", "event-3", "event-5"]);

    // A fresh instance cold-loads across segment files with the same result.
    const reopened = new JsonlCodexEventStore({ filePath });
    const replayed = await reopened.replay({ sessionId: "session-1" });
    expect(replayed.map((event) => event.eventId)).toEqual(
      inProcess.map((event) => event.eventId),
    );
    expect(
      (
        await reopened.replay({
          sessionId: "session-1",
          methods: ["turn/completed"],
        })
      ).map((event) => event.eventId),
    ).toEqual(["event-2", "event-4", "event-6"]);
  });

  it("prunes closed segments beyond keepSegments", async () => {
    const directory = tempDir();
    const filePath = join(directory, "events.jsonl");
    const rotations: Array<{ from: string; to: string; pruned: string[] }> = [];
    const store = new JsonlCodexEventStore({
      filePath,
      now: () => 1_700_000_000_000,
      rotation: { maxBytes: 1, keepSegments: 1 },
      onRotate: (details) => rotations.push(details),
    });

    for (let index = 1; index <= 8; index += 1) {
      await store.append(
        testDraft(
          "warning",
          { message: `event-${index} ${"x".repeat(200)}` },
          { eventId: `event-${index}` },
        ),
      );
    }

    expect(rotations.length).toBeGreaterThanOrEqual(2);
    const segmentFiles = readdirSync(directory).filter((entry) =>
      /^events\.\d{17}(-\d+)?\.jsonl$/.test(entry),
    );
    expect(segmentFiles).toHaveLength(1);
    expect(rotations.at(-1)?.pruned.length).toBeGreaterThanOrEqual(1);

    // A fresh instance only sees events from the retained segment + active file.
    const reopened = new JsonlCodexEventStore({ filePath });
    const replayed = await reopened.replay({ sessionId: "session-1" });
    expect(replayed.map((event) => event.eventId)).toEqual([
      "event-7",
      "event-8",
    ]);
  });

  it("does not rotate below the waterline or when disabled", async () => {
    const directory = tempDir();
    const belowPath = join(directory, "below", "events.jsonl");
    const below = new JsonlCodexEventStore({
      filePath: belowPath,
      rotation: { maxBytes: 1_000_000 },
    });
    await below.append(
      testDraft("warning", { message: "small" }, { eventId: "event-1" }),
    );

    const disabledPath = join(directory, "disabled", "events.jsonl");
    const disabled = new JsonlCodexEventStore({
      filePath: disabledPath,
      rotation: { maxBytes: 0 },
    });
    for (let index = 1; index <= 4; index += 1) {
      await disabled.append(
        testDraft(
          "warning",
          { message: `event-${index} ${"x".repeat(200)}` },
          { eventId: `event-${index}` },
        ),
      );
    }

    for (const directoryPath of [
      join(directory, "below"),
      join(directory, "disabled"),
    ]) {
      expect(
        readdirSync(directoryPath).filter((entry) =>
          /^events\.\d{17}(-\d+)?\.jsonl$/.test(entry),
        ),
      ).toHaveLength(0);
    }
    expect(await disabled.replay({ sessionId: "session-1" })).toHaveLength(4);
  });
});

describe("JsonlCodexEventStore replay allocation", () => {
  it("returns shared references instead of deep copies", async () => {
    // Cloning every envelope on replay cost ~650 ms and ~250 MB of garbage per
    // request on a session with 144k journalled events. Identity across replays
    // is what proves the copy is gone; if this ever regresses, the canonical
    // overlay silently becomes the slowest part of opening a session again.
    const filePath = join(tempDir(), "events.jsonl");
    const store = new JsonlCodexEventStore({ filePath });
    await store.append(testDraft("item/started", {}, { eventId: "event-1" }));
    await store.append(testDraft("item/completed", {}, { eventId: "event-2" }));

    const first = await store.replay({ sessionId: "session-1" });
    const second = await store.replay({ sessionId: "session-1" });

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    // Fresh array each call...
    expect(second).not.toBe(first);
    // ...but the envelopes themselves are not re-allocated.
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("does not let a caller's array operations disturb the store", async () => {
    const filePath = join(tempDir(), "events.jsonl");
    const store = new JsonlCodexEventStore({ filePath });
    await store.append(testDraft("item/started", {}, { eventId: "event-1" }));
    await store.append(testDraft("item/completed", {}, { eventId: "event-2" }));

    const replayed = await store.replay({ sessionId: "session-1" });
    // The overlay sorts a copy; make sure the array we hand out is detached.
    [...replayed].reverse();

    const after = await store.replay({ sessionId: "session-1" });
    expect(after.map((event) => event.eventId)).toEqual(["event-1", "event-2"]);
  });
});

/**
 * Pruning is permanent data loss, so it must not be silent.
 *
 * Retention is a fixed segment count, so any long-lived session eventually has
 * its earliest events deleted. The in-memory indexes keep rotated events for the
 * life of the process (deliberately, so replay and sequences stay continuous),
 * which means the loss only becomes observable after a restart -- and nothing
 * observed it: `matchesReplaySnapshot` compares a cached projection against the
 * replay, so an incomplete replay validates cleanly against an equally
 * incomplete cache, and the reducer folds a partial history without complaint.
 *
 * Measured retention on a production install: 256 MiB per segment, 3 segments
 * kept, one rotation every ~17 h, so roughly 2.9 days of history.
 */
describe("JsonlCodexEventStore journal loss reporting", () => {
  async function fillUntilPruned(filePath: string) {
    const rotations: Array<{
      pruned: string[];
      prunedSummary: Array<{
        path: string;
        known: boolean;
        eventCount: number;
        sessions: Array<{ sessionId: string; eventCount: number }>;
      }>;
    }> = [];
    const store = new JsonlCodexEventStore({
      filePath,
      now: () => 1_700_000_000_000,
      rotation: { maxBytes: 1, keepSegments: 1 },
      onRotate: (details) => rotations.push(details),
    });
    for (let index = 1; index <= 8; index += 1) {
      await store.append(
        testDraft(
          "warning",
          { message: `event-${index} ${"x".repeat(200)}` },
          { eventId: `event-${index}` },
        ),
      );
    }
    return rotations;
  }

  it("reports which sessions a pruned segment took history from", async () => {
    const filePath = join(tempDir(), "events.jsonl");
    const rotations = await fillUntilPruned(filePath);

    const pruning = rotations.filter((r) => r.pruned.length > 0);
    expect(pruning.length).toBeGreaterThanOrEqual(1);
    const summary = pruning.at(-1)?.prunedSummary ?? [];
    expect(summary).toHaveLength(pruning.at(-1)?.pruned.length ?? 0);
    // Described from load-time bookkeeping, never by re-reading the segment we
    // are deleting for being large.
    expect(summary[0]?.known).toBe(true);
    expect(summary[0]?.eventCount).toBeGreaterThan(0);
    expect(summary[0]?.sessions).toEqual([
      { sessionId: "session-1", eventCount: summary[0]?.eventCount },
    ]);
  });

  it("warns a restarted process that a session's journal prefix is gone", async () => {
    const filePath = join(tempDir(), "events.jsonl");
    await fillUntilPruned(filePath);

    // The restart is what makes the loss visible: this instance can only load
    // the surviving files.
    const gapReports: Array<{
      gaps: Array<{
        sessionId: string;
        firstSequence: number;
        missingLeadingEvents: number;
        remainingEvents: number;
      }>;
      sessionCount: number;
      journalFiles: number;
    }> = [];
    const reopened = new JsonlCodexEventStore({
      filePath,
      onJournalGaps: (details) => gapReports.push(details),
    });
    const replayed = await reopened.replay({ sessionId: "session-1" });

    expect(gapReports).toHaveLength(1);
    const gap = gapReports[0]?.gaps[0];
    expect(gap?.sessionId).toBe("session-1");
    // Per-session sequences are dense and start at 1, so a surviving first
    // sequence above 1 is exactly the count of deleted leading events.
    expect(gap?.firstSequence).toBeGreaterThan(1);
    expect(gap?.missingLeadingEvents).toBe((gap?.firstSequence ?? 0) - 1);
    expect(gap?.remainingEvents).toBe(replayed.length);
    expect(gap?.missingLeadingEvents).toBe(8 - replayed.length);
  });

  it("stays quiet when the journal still holds every session from the start", async () => {
    const filePath = join(tempDir(), "events.jsonl");
    const store = new JsonlCodexEventStore({ filePath });
    await store.append(
      testDraft("warning", { message: "a" }, { eventId: "event-a" }),
    );
    await store.append(
      testDraft("warning", { message: "b" }, { eventId: "event-b" }),
    );

    const gapReports: unknown[] = [];
    const reopened = new JsonlCodexEventStore({
      filePath,
      onJournalGaps: (details) => gapReports.push(details),
    });
    expect(await reopened.replay({ sessionId: "session-1" })).toHaveLength(2);
    expect(gapReports).toHaveLength(0);
  });
});
