import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AsyncCodexBridgeJournal,
  createCodexBridgeJournalRecord,
} from "../../src/codex-bridge/CodexBridgeJournal.js";
import {
  CODEX_BRIDGE_DELTA_METHODS,
  classifyCodexBridgeNotification,
  resolveCodexBridgeJournalMode,
  safeCodexBridgeMethod,
  shouldJournalServerNotification,
} from "../../src/codex-bridge/journal-policy.js";

describe("Codex bridge journal policy", () => {
  it("defaults invalid and missing values to lifecycle", () => {
    expect(resolveCodexBridgeJournalMode(undefined)).toBe("lifecycle");
    expect(resolveCodexBridgeJournalMode("unknown")).toBe("lifecycle");
    expect(resolveCodexBridgeJournalMode(" FULL ")).toBe("full");
    expect(resolveCodexBridgeJournalMode("legacy-blocking")).toBe(
      "legacy-blocking",
    );
  });

  it("keeps every audited delta out of lifecycle while full captures metadata", () => {
    expect(CODEX_BRIDGE_DELTA_METHODS.size).toBeGreaterThan(5);
    for (const method of CODEX_BRIDGE_DELTA_METHODS) {
      expect(classifyCodexBridgeNotification(method)).toBe("delta");
      expect(shouldJournalServerNotification("lifecycle", method)).toBe(false);
      expect(shouldJournalServerNotification("full", method)).toBe(true);
    }
  });

  it("retains bounded unknown method names", () => {
    const unsafe = "future/private-token/method";
    const safe = safeCodexBridgeMethod(unsafe);
    expect(safe).toBe(unsafe);
    expect(safe).toContain("private-token");
    expect(shouldJournalServerNotification("lifecycle", unsafe)).toBe(false);
    expect(shouldJournalServerNotification("full", unsafe)).toBe(true);
  });
});

describe("AsyncCodexBridgeJournal", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("coalesces cross-frame snapshots into one compact record", async () => {
    const { writer, filePath } = await createWriter(directories);
    const first = record("thread/status/changed", 10);
    const second = record("thread/status/changed", 12);
    expect(
      writer.enqueue(first, {
        connectionId: 1,
        coalesceKey: "1:thread:status",
        priority: "normal",
      }),
    ).toBe(true);
    expect(
      writer.enqueue(second, {
        connectionId: 1,
        coalesceKey: "1:thread:status",
        priority: "normal",
      }),
    ).toBe(true);

    await writer.close();
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      method: "thread/status/changed",
      count: 2,
      wireBytes: 22,
    });
    expect(writer.getStats()).toMatchObject({
      coalescedRecords: 1,
      writtenRecords: 1,
      circuitOpen: false,
    });
  });

  it("evicts normal records for a terminal record under the global byte cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-journal-cap-"));
    directories.push(directory);
    const writer = new AsyncCodexBridgeJournal({
      mode: "full",
      filePath: join(directory, "full-diagnostic.jsonl"),
      maxQueueBytes: 850,
      maxConnectionQueueBytes: 850,
      flushIntervalMs: 10_000,
    });
    for (let index = 0; index < 8; index += 1) {
      writer.enqueue(record("item/agentMessage/delta", 100), {
        connectionId: 1,
        priority: "normal",
      });
    }
    expect(
      writer.enqueue(record("turn/completed", 100), {
        connectionId: 1,
        priority: "terminal",
      }),
    ).toBe(true);
    expect(writer.getStats().droppedRecords).toBeGreaterThan(0);
    await writer.close();
    const contents = await readFile(
      join(directory, "full-diagnostic.jsonl"),
      "utf8",
    );
    expect(contents).toContain('"method":"turn/completed"');
  });

  it("enforces one real writer lease and leaves the first writer healthy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-journal-lease-"));
    directories.push(directory);
    const filePath = join(directory, "lifecycle.jsonl");
    const first = new AsyncCodexBridgeJournal({
      mode: "lifecycle",
      filePath,
      flushIntervalMs: 10_000,
    });
    const second = new AsyncCodexBridgeJournal({
      mode: "lifecycle",
      filePath,
      flushIntervalMs: 10_000,
    });
    first.enqueue(record("turn/started", 10), {
      connectionId: 1,
      priority: "normal",
    });
    await first.flush();
    second.enqueue(record("turn/completed", 10), {
      connectionId: 2,
      priority: "terminal",
    });
    await second.flush();
    expect(second.getStats().circuitOpen).toBe(true);
    expect(first.getStats().circuitOpen).toBe(false);

    first.enqueue(record("turn/completed", 10), {
      connectionId: 1,
      priority: "terminal",
    });
    await first.close();
    await second.close();
    expect(await readFile(filePath, "utf8")).toContain(
      '"method":"turn/completed"',
    );
  });

  it("batches records and keeps rotated lifecycle storage bounded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-journal-rotate-"));
    directories.push(directory);
    const filePath = join(directory, "lifecycle.jsonl");
    const writer = new AsyncCodexBridgeJournal({
      mode: "lifecycle",
      filePath,
      maxSegmentBytes: 700,
      keepSegments: 1,
      flushIntervalMs: 10_000,
    });
    for (let batch = 0; batch < 5; batch += 1) {
      for (let index = 0; index < 3; index += 1) {
        writer.enqueue(record("turn/started", 100), {
          connectionId: batch + 1,
          priority: "normal",
        });
      }
      await writer.flush();
    }
    await writer.close();
    const files = (await readdir(directory)).filter(
      (entry) => entry.startsWith("lifecycle") && entry.endsWith(".jsonl"),
    );
    expect(files.length).toBeLessThanOrEqual(2);
    expect(writer.getStats()).toMatchObject({
      writtenRecords: 15,
      circuitOpen: false,
    });
  });

  it("abandons a timed-out shutdown flush without reopening the released writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-journal-timeout-"));
    directories.push(directory);
    const filePath = join(directory, "lifecycle.jsonl");
    const writer = new AsyncCodexBridgeJournal({
      mode: "lifecycle",
      filePath,
      writeDelayMs: 100,
      flushIntervalMs: 10_000,
    });
    writer.enqueue(record("turn/started", 10), {
      connectionId: 1,
      priority: "normal",
    });

    await writer.close(1);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(await readdir(directory)).not.toContain(
      "lifecycle.jsonl.writer.lock",
    );
    expect(writer.getStats()).toMatchObject({
      queuedRecords: 0,
      writtenRecords: 0,
      droppedRecords: 1,
    });
  });
});

async function createWriter(directories: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "codex-journal-"));
  directories.push(directory);
  const filePath = join(directory, "lifecycle.jsonl");
  return {
    filePath,
    writer: new AsyncCodexBridgeJournal({
      mode: "lifecycle",
      filePath,
      flushIntervalMs: 10_000,
    }),
  };
}

function record(method: string, wireBytes: number) {
  return createCodexBridgeJournalRecord({
    instanceId: "instance-test",
    mode: method.includes("delta") ? "full" : "lifecycle",
    kind: "server-notification",
    classification: classifyCodexBridgeNotification(method),
    direction: "server",
    connectionId: 1,
    profile: "light",
    method,
    sessionId: "thread-1",
    turnId: "turn-1",
    wireBytes,
  });
}
