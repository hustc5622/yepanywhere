import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RuntimeEventSessionIndex,
  parseIdentity,
} from "../../src/runtime/RuntimeEventSessionIndex.js";
import { RuntimeEventStore } from "../../src/runtime/RuntimeEventStore.js";

function line(
  processId: string,
  sessionId: string,
  seq: number,
  timestamp = `2026-10-22T00:00:${String(seq).padStart(2, "0")}.000Z`,
): string {
  return `${JSON.stringify({ seq, timestamp, processId, sessionId, type: "message", data: { seq } })}\n`;
}

describe("RuntimeEventSessionIndex", () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(tmpdir(), `runtime-index-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("indexes sessions per process and reads only appended bytes", async () => {
    const a = path.join(dir, "proc-a.jsonl");
    await writeFile(a, line("proc-a", "s1", 1) + line("proc-a", "s2", 2));
    await writeFile(path.join(dir, "ignored.txt"), line("proc-x", "s1", 9));
    const index = new RuntimeEventSessionIndex(dir);

    expect(await index.processIdsForSession("s1")).toEqual(["proc-a"]);
    expect(await index.processIdsForSession("s2")).toEqual(["proc-a"]);
    const afterFirst = index.scannedBytes;

    // Unchanged files are not read again.
    await index.snapshot();
    expect(index.scannedBytes).toBe(afterFirst);

    const tail = line("proc-a", "s3", 3);
    await appendFile(a, tail);
    expect(await index.processIdsForSession("s3")).toEqual(["proc-a"]);
    expect(index.scannedBytes - afterFirst).toBe(Buffer.byteLength(tail));
  });

  it("waits for a partial final line instead of dropping it", async () => {
    const a = path.join(dir, "proc-a.jsonl");
    const full = line("proc-a", "late", 1);
    await writeFile(a, full.slice(0, 20));
    const index = new RuntimeEventSessionIndex(dir);
    expect(await index.processIdsForSession("late")).toEqual([]);
    await appendFile(a, full.slice(20));
    expect(await index.processIdsForSession("late")).toEqual(["proc-a"]);
  });

  it("handles lines that span read chunks and multibyte text", async () => {
    const a = path.join(dir, "proc-a.jsonl");
    const big = `${JSON.stringify({
      seq: 1,
      timestamp: "2026-10-22T00:00:01.000Z",
      processId: "proc-a",
      sessionId: "big",
      type: "message",
      data: { text: "思考".repeat(400_000) },
    })}\n`;
    await writeFile(a, big + line("proc-a", "after", 2));
    const index = new RuntimeEventSessionIndex(dir);
    expect(await index.processIdsForSession("big")).toEqual(["proc-a"]);
    expect(await index.processIdsForSession("after")).toEqual(["proc-a"]);
  });

  it("rescans replaced or truncated files and forgets deleted ones", async () => {
    const a = path.join(dir, "proc-a.jsonl");
    await writeFile(a, line("proc-a", "old", 1) + line("proc-a", "old", 2));
    const index = new RuntimeEventSessionIndex(dir);
    expect(await index.processIdsForSession("old")).toEqual(["proc-a"]);

    // A new inode under the same name (external rotation/rewrite).
    await rm(a);
    await writeFile(a, line("proc-a", "new", 1));
    expect(await index.processIdsForSession("old")).toEqual([]);
    expect(await index.processIdsForSession("new")).toEqual(["proc-a"]);

    // Same inode, shorter file.
    await writeFile(a, "");
    expect(await index.processIdsForSession("new")).toEqual([]);

    await writeFile(path.join(dir, "proc-b.jsonl.1"), line("proc-b", "b", 1));
    expect(await index.allProcessIds()).toEqual(["proc-b"]);
    await rm(path.join(dir, "proc-b.jsonl.1"));
    expect(await index.allProcessIds()).toEqual([]);
  });

  it("keeps a moved summary valid without rescanning the rotated file", async () => {
    const current = path.join(dir, "proc-a.jsonl");
    const rotated = `${current}.1`;
    await writeFile(current, line("proc-a", "s1", 1));
    const index = new RuntimeEventSessionIndex(dir);
    await index.snapshot();
    const scanned = index.scannedBytes;
    await rename(current, rotated);
    index.moved(current, rotated);
    const next = line("proc-a", "s2", 2);
    await writeFile(current, next);
    expect(await index.processIdsForSession("s1")).toEqual(["proc-a"]);
    expect(await index.processIdsForSession("s2")).toEqual(["proc-a"]);
    expect(index.scannedBytes - scanned).toBe(Buffer.byteLength(next));
  });

  it("picks the latest process by timestamp, then process id", async () => {
    await writeFile(
      path.join(dir, "p1.jsonl"),
      line("p1", "s", 1, "2026-10-22T00:00:05.000Z"),
    );
    await writeFile(
      path.join(dir, "p2.jsonl"),
      line("p2", "s", 1, "2026-10-22T00:00:09.000Z"),
    );
    await writeFile(
      path.join(dir, "p3.jsonl"),
      line("p3", "s", 1, "2026-10-22T00:00:09.000Z"),
    );
    const index = new RuntimeEventSessionIndex(dir);
    expect(await index.latestProcessIdForSession("s")).toBe("p3");
    expect(await index.latestProcessIdForSession("missing")).toBeUndefined();
  });

  it("shares one follow-up refresh between concurrent lookups", async () => {
    await writeFile(path.join(dir, "p1.jsonl"), line("p1", "s", 1));
    const index = new RuntimeEventSessionIndex(dir);
    const internals = index as unknown as { refresh(): Promise<unknown> };
    const original = internals.refresh.bind(index);
    let refreshes = 0;
    internals.refresh = () => {
      refreshes++;
      return original();
    };
    const first = index.snapshot();
    // Lookups during an in-flight refresh cannot trust it; they all share a
    // single follow-up instead of each scanning the journal.
    const followers = [index.snapshot(), index.snapshot(), index.snapshot()];
    expect(followers[1]).toBe(followers[0]);
    expect(followers[2]).toBe(followers[0]);
    expect(followers[0]).not.toBe(first);
    await Promise.all([first, ...followers]);
    expect(refreshes).toBe(2);
    // Once idle, the next lookup starts a fresh refresh.
    await appendFile(path.join(dir, "p1.jsonl"), line("p1", "late", 2));
    expect(await index.processIdsForSession("late")).toEqual(["p1"]);
    expect(refreshes).toBe(3);
  });

  it("tolerates a missing directory", async () => {
    const index = new RuntimeEventSessionIndex(path.join(dir, "absent"));
    expect(await index.allProcessIds()).toEqual([]);
  });
});

describe("parseIdentity", () => {
  const buf = (value: string) => Buffer.from(value, "utf8");
  it("reads the serialized prefix, including escaped identifiers", () => {
    const record = {
      seq: 7,
      timestamp: "2026-10-22T00:00:07.000Z",
      processId: 'p"1\\x',
      sessionId: "会话-1",
      type: "message",
      data: { text: "x".repeat(5_000) },
    };
    expect(parseIdentity(buf(JSON.stringify(record)))).toEqual({
      seq: 7,
      timestamp: record.timestamp,
      processId: record.processId,
      sessionId: record.sessionId,
      type: "message",
    });
  });
  it("falls back to a full parse for other key orders", () => {
    expect(
      parseIdentity(
        buf(
          JSON.stringify({
            type: "status",
            sessionId: "s",
            processId: "p",
            timestamp: "t",
            seq: 2,
          }),
        ),
      ),
    ).toEqual({
      seq: 2,
      timestamp: "t",
      processId: "p",
      sessionId: "s",
      type: "status",
    });
  });
  it("rejects invalid or incomplete identities", () => {
    expect(parseIdentity(buf('{"seq":1,"timestamp":"t"'))).toBeNull();
    expect(
      parseIdentity(
        buf(
          JSON.stringify({
            seq: 1.5,
            timestamp: "t",
            processId: "p",
            sessionId: "s",
          }),
        ),
      ),
    ).toBeNull();
    expect(parseIdentity(buf("not json"))).toBeNull();
  });
});

describe("RuntimeEventSessionIndex partial appends", () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(tmpdir(), `runtime-index-glued-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("ignores a truncated record glued to the next append", async () => {
    // Partial "lost" record, then the next append on the same line, then a
    // normal record. The glued line still ends with "}".
    const partial = line("proc-a", "lost", 1).slice(0, -12);
    await writeFile(
      path.join(dir, "proc-a.jsonl"),
      partial + line("proc-a", "glued", 2) + line("proc-a", "kept", 3),
    );
    const index = new RuntimeEventSessionIndex(dir);
    expect(await index.processIdsForSession("lost")).toEqual([]);
    expect(await index.processIdsForSession("glued")).toEqual([]);
    expect(await index.processIdsForSession("kept")).toEqual(["proc-a"]);
  });
});

describe("RuntimeEventStore session lookup", () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(tmpdir(), `runtime-store-index-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replays every process of a session across rotations and new writes", async () => {
    const store = new RuntimeEventStore({ eventsDir: dir, maxFileBytes: 400 });
    for (let i = 0; i < 6; i++)
      await store.append({
        processId: "proc-1",
        sessionId: "s",
        type: "message",
        data: { text: `first ${i}` },
      });
    await store.append({
      processId: "proc-2",
      sessionId: "other",
      type: "message",
      data: {},
    });
    const before = await store.replay({ sessionId: "s", allProcesses: true });
    expect(new Set(before.map((r) => r.processId))).toEqual(
      new Set(["proc-1"]),
    );

    // A later process for the same session becomes visible immediately.
    await store.append({
      processId: "proc-3",
      sessionId: "s",
      type: "message",
      data: { text: "resumed" },
      timestamp: "2999-01-01T00:00:00.000Z",
    });
    const after = await store.replay({ sessionId: "s", allProcesses: true });
    expect(after.map((r) => r.processId)).toContain("proc-3");
    expect(after.filter((r) => r.processId === "proc-1")).toHaveLength(
      before.length,
    );
    // Without allProcesses only the latest process is replayed.
    const latest = await store.replay({ sessionId: "s" });
    expect(new Set(latest.map((r) => r.processId))).toEqual(
      new Set(["proc-3"]),
    );
    // An unscoped replay must name its record types.
    await expect(store.replay({})).rejects.toThrow(/requires sessionId/);
  });

  it("replays only the requested types across every journal", async () => {
    const store = new RuntimeEventStore({ eventsDir: dir, maxFileBytes: 400 });
    for (let i = 0; i < 8; i++)
      await store.append({
        processId: "proc-busy",
        sessionId: "s",
        type: "message",
        data: { text: `payload ${i}`.repeat(20) },
      });
    await store.append({
      processId: "proc-remap",
      sessionId: "temp",
      type: "session-id-changed",
      data: { oldSessionId: "temp", newSessionId: "real" },
    });
    await store.append({
      processId: "proc-remap",
      sessionId: "real",
      type: "message",
      data: {},
    });

    const remaps = await store.replay({ types: ["session-id-changed"] });
    expect(remaps).toEqual([
      expect.objectContaining({
        processId: "proc-remap",
        type: "session-id-changed",
        data: { oldSessionId: "temp", newSessionId: "real" },
      }),
    ]);
    // A scoped replay still honours the type filter.
    await expect(
      store.replay({ sessionId: "s", types: ["session-id-changed"] }),
    ).resolves.toEqual([]);
  });
});
