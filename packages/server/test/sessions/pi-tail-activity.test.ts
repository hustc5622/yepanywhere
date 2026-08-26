import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPiSessionTailActivity } from "../../src/sessions/pi-files.js";

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function header(id: string, cwd: string): unknown {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-08-19T00:00:00.000Z",
    cwd,
  };
}

function message(role: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "message",
    id: randomUUID().slice(0, 8),
    parentId: null,
    timestamp: "2026-08-19T00:00:01.000Z",
    message: { role, content: [{ type: "text", text: "x" }], ...extra },
  };
}

/**
 * These cases decide whether a session with no discoverable provider process is
 * still treated as externally active, so each one maps to a real host state.
 */
describe("readPiSessionTailActivity", () => {
  const tempDirs: string[] = [];
  let dir: string;

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function writeSession(records: unknown[]): Promise<string> {
    dir = join(tmpdir(), `pi-tail-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "session.jsonl");
    await writeFile(filePath, jsonl([header("s1", "/tmp/p"), ...records]));
    return filePath;
  }

  it("treats a terminal assistant stop reason as settled", async () => {
    for (const stopReason of ["stop", "length", "error"]) {
      const filePath = await writeSession([
        message("user"),
        message("assistant", { stopReason }),
      ]);
      await expect(readPiSessionTailActivity(filePath)).resolves.toBe(
        "settled",
      );
    }
  });

  it("treats an assistant stopped to call a tool as in flight", async () => {
    const filePath = await writeSession([
      message("user"),
      message("assistant", { stopReason: "toolUse" }),
    ]);
    await expect(readPiSessionTailActivity(filePath)).resolves.toBe(
      "in-flight",
    );
  });

  it("treats a trailing user prompt as in flight", async () => {
    const filePath = await writeSession([
      message("assistant", { stopReason: "stop" }),
      message("user"),
    ]);
    await expect(readPiSessionTailActivity(filePath)).resolves.toBe(
      "in-flight",
    );
  });

  it("treats a trailing tool result as in flight", async () => {
    const filePath = await writeSession([
      message("user"),
      message("assistant", { stopReason: "toolUse" }),
      message("toolResult"),
    ]);
    await expect(readPiSessionTailActivity(filePath)).resolves.toBe(
      "in-flight",
    );
  });

  it("skips trailing non-conversation entries", async () => {
    const filePath = await writeSession([
      message("user"),
      message("assistant", { stopReason: "stop" }),
      { type: "thinking_level_change", id: "t", thinkingLevel: "high" },
      { type: "model_change", id: "m", provider: "p", modelId: "m" },
    ]);
    await expect(readPiSessionTailActivity(filePath)).resolves.toBe("settled");
  });

  it("reads only the tail of a large log and ignores the partial first line", async () => {
    dir = join(tmpdir(), `pi-tail-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "session.jsonl");
    const filler = Array.from({ length: 400 }, () =>
      message("assistant", {
        stopReason: "stop",
        content: [{ type: "text", text: "y".repeat(1024) }],
      }),
    );
    await writeFile(
      filePath,
      jsonl([
        header("s1", "/tmp/p"),
        ...filler,
        message("user"),
        message("assistant", { stopReason: "toolUse" }),
      ]),
    );
    await expect(readPiSessionTailActivity(filePath)).resolves.toBe(
      "in-flight",
    );
  });

  it("expands backwards when the newest JSONL record exceeds one tail chunk", async () => {
    const oversizedText = "z".repeat(300 * 1024);
    const settledPath = await writeSession([
      message("user"),
      message("assistant", {
        stopReason: "stop",
        content: [{ type: "text", text: oversizedText }],
      }),
    ]);
    await expect(readPiSessionTailActivity(settledPath)).resolves.toBe(
      "settled",
    );

    const runningPath = await writeSession([
      message("assistant", { stopReason: "stop" }),
      message("user", {
        content: [{ type: "text", text: oversizedText }],
      }),
    ]);
    await expect(readPiSessionTailActivity(runningPath)).resolves.toBe(
      "in-flight",
    );
  });

  it("reports unknown for a missing or contentless log", async () => {
    await expect(
      readPiSessionTailActivity(join(tmpdir(), `missing-${randomUUID()}`)),
    ).resolves.toBe("unknown");

    const filePath = await writeSession([]);
    await expect(readPiSessionTailActivity(filePath)).resolves.toBe("unknown");
  });
});
