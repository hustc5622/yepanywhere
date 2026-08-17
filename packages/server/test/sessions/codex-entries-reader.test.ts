import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getInFlightCodexReadCount,
  readSharedCodexEntries,
} from "../../src/sessions/codex-entries-reader.js";

let dir: string;

async function writeRollout(
  name: string,
  entries: Array<Record<string, unknown>>,
): Promise<string> {
  const filePath = join(dir, name);
  await writeFile(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join("\n"),
    "utf8",
  );
  return filePath;
}

function sessionMeta(id: string): Record<string, unknown> {
  return {
    type: "session_meta",
    timestamp: "2026-08-15T02:29:49.000Z",
    payload: { id, timestamp: "2026-08-15T02:29:49.000Z", cwd: "/tmp/project" },
  };
}

function userMessage(text: string): Record<string, unknown> {
  return {
    type: "response_item",
    timestamp: "2026-08-15T02:30:00.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-entries-reader-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readSharedCodexEntries", () => {
  it("parses a rollout file and reports stats", async () => {
    const filePath = await writeRollout("a.jsonl", [
      sessionMeta("session-a"),
      userMessage("hello"),
    ]);

    const loaded = await readSharedCodexEntries(filePath);

    expect(loaded.entries).toHaveLength(2);
    expect(loaded.stats.size).toBeGreaterThan(0);
  });

  it("coalesces overlapping reads of the same file into one result", async () => {
    const filePath = await writeRollout("b.jsonl", [
      sessionMeta("session-b"),
      userMessage("hello"),
    ]);

    // Requests issued before the first read settles must share its work: this is
    // what collapses the session/metadata/agents burst on one session open.
    const [first, second, third] = await Promise.all([
      readSharedCodexEntries(filePath),
      readSharedCodexEntries(filePath),
      readSharedCodexEntries(filePath),
    ]);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.entries).toHaveLength(2);
  });

  it("does not coalesce reads of different files", async () => {
    const a = await writeRollout("c.jsonl", [sessionMeta("session-c")]);
    const b = await writeRollout("d.jsonl", [
      sessionMeta("session-d"),
      userMessage("hi"),
    ]);

    const [loadedA, loadedB] = await Promise.all([
      readSharedCodexEntries(a),
      readSharedCodexEntries(b),
    ]);

    expect(loadedA).not.toBe(loadedB);
    expect(loadedA.entries).toHaveLength(1);
    expect(loadedB.entries).toHaveLength(2);
  });

  it("retains nothing once a read settles, so later reads see new appends", async () => {
    const filePath = await writeRollout("e.jsonl", [sessionMeta("session-e")]);

    const before = await readSharedCodexEntries(filePath);
    expect(before.entries).toHaveLength(1);
    expect(getInFlightCodexReadCount()).toBe(0);

    await writeFile(
      filePath,
      `${JSON.stringify(sessionMeta("session-e"))}\n${JSON.stringify(userMessage("appended"))}`,
      "utf8",
    );

    const after = await readSharedCodexEntries(filePath);
    expect(after).not.toBe(before);
    expect(after.entries).toHaveLength(2);
  });

  it("clears the in-flight entry when a read fails so later reads retry", async () => {
    const missing = join(dir, "does-not-exist.jsonl");

    await expect(readSharedCodexEntries(missing)).rejects.toThrow();
    expect(getInFlightCodexReadCount()).toBe(0);

    await writeRollout("does-not-exist.jsonl", [sessionMeta("session-f")]);
    const loaded = await readSharedCodexEntries(missing);
    expect(loaded.entries).toHaveLength(1);
  });
});
