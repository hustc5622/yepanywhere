import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCursorContextUsage } from "../../src/sessions/cursor-context-usage.js";
import { CursorSessionReader } from "../../src/sessions/cursor-reader.js";
import { readCursorSessionDir } from "../../src/sessions/cursor-store.js";
import { normalizeSession } from "../../src/sessions/normalization.js";

function varint(value: number | bigint): Buffer {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  while (remaining > 127n) {
    bytes.push(Number(remaining & 127n) | 0x80);
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return Buffer.from(bytes);
}

function field(id: number, value: Buffer | number | bigint | string): Buffer {
  if (typeof value === "number" || typeof value === "bigint") {
    return Buffer.concat([varint(id * 8), varint(value)]);
  }
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([varint(id * 8 + 2), varint(bytes.length), bytes]);
}

function tokenDetails(used: number, max: number, breakdown?: Buffer): Buffer {
  return field(
    5,
    Buffer.concat([
      field(1, used),
      field(2, max),
      ...(breakdown ? [field(3, breakdown)] : []),
    ]),
  );
}

function category(id: string, name: string, tokens?: number): Buffer {
  return field(
    3,
    Buffer.concat([
      field(1, id),
      field(2, name),
      ...(tokens === undefined ? [] : [field(3, tokens)]),
    ]),
  );
}

describe("Cursor native context snapshot", () => {
  it("reads native counts, category estimates and protobuf default-zero categories", () => {
    const root = Buffer.concat([
      field(1, randomBytes(32)),
      tokenDetails(
        196_533,
        256_000,
        Buffer.concat([
          field(1, 196_533),
          field(2, 256_000),
          category("system_prompt", "System prompt", 2111),
          category("conversation", "Conversation", 194_422),
          category("summarized_conversation", "Summarized conversation"),
        ]),
      ),
      field(26, 1_791_877_618_968n), // Real root fields include uint64 timestamps.
      field(40, Buffer.from([0x80])), // Unknown nested data is not parsed.
    ]);
    expect(readCursorContextUsage(root)).toEqual({
      inputTokens: 196_533,
      contextWindow: 256_000,
      percentage: 76.8,
      categories: [
        { id: "system_prompt", name: "System prompt", tokens: 2111 },
        { id: "conversation", name: "Conversation", tokens: 194_422 },
        {
          id: "summarized_conversation",
          name: "Summarized conversation",
          tokens: 0,
        },
      ],
    });
  });

  it("does not invent a window for absent or zero details", () => {
    for (const root of [
      Buffer.alloc(0),
      field(1, randomBytes(32)),
      field(5, Buffer.alloc(0)),
      tokenDetails(123, 0),
    ]) {
      expect(readCursorContextUsage(root)).toBeUndefined();
    }
    expect(readCursorContextUsage(field(5, field(2, 256_000)))).toEqual({
      inputTokens: 0,
      contextWindow: 256_000,
      percentage: 0,
    });
  });

  it("preserves Cursor's denominator even when usage exceeds it", () => {
    expect(readCursorContextUsage(tokenDetails(260_000, 256_000))).toEqual({
      inputTokens: 260_000,
      contextWindow: 256_000,
      percentage: 101.6,
    });
  });

  it("ignores mismatched or malformed category snapshots without losing counts", () => {
    for (const breakdown of [
      Buffer.from([0x80]),
      Buffer.concat([
        field(1, 80_000), // Previous, pre-compaction breakdown.
        field(2, 256_000),
        category("conversation", "Conversation", 80_000),
      ]),
      Buffer.concat([field(1, 20_000), field(2, 500_000)]),
    ]) {
      expect(
        readCursorContextUsage(tokenDetails(20_000, 256_000, breakdown)),
      ).toEqual({
        inputTokens: 20_000,
        contextWindow: 256_000,
        percentage: 7.8,
      });
    }
  });

  it("rejects invalid wire types, truncated lengths, and out-of-range counts", () => {
    for (const root of [
      Buffer.from([0x2a, 0xff, 0xff, 0xff, 0x7f]),
      Buffer.from([0x2a, 0x02, 0x08]),
      Buffer.from([0x2a, 0x01, 0x80]),
      Buffer.from([0x00]),
      field(5, Buffer.concat([field(1, 0x1_0000_0000n), field(2, 256_000)])),
      field(5, Buffer.concat([field(1, "bad"), field(2, 256_000)])),
    ]) {
      expect(readCursorContextUsage(root)).toBeUndefined();
    }
  });

  it("refreshes persisted usage after WAL-only compaction without accumulating old roots", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "cursor-context-"));
    const sessionId = "native-context-session";
    const dir = join(sessionsDir, sessionId);
    await mkdir(dir);
    const sqlite = process.getBuiltinModule("node:sqlite");
    const db = new sqlite.DatabaseSync(join(dir, "store.db"));
    try {
      await writeFile(
        join(dir, "meta.json"),
        JSON.stringify({ cwd: "/tmp/project" }),
      );
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
      );
      const insert = db.prepare("INSERT INTO blobs (id,data) VALUES (?,?)");
      const user = randomBytes(32);
      insert.run(
        user.toString("hex"),
        Buffer.from(
          JSON.stringify({
            role: "user",
            content: "<user_query>Continue</user_query>",
          }),
        ),
      );
      const commitRoot = (used: number) => {
        const rootId = randomBytes(32).toString("hex");
        insert.run(
          rootId,
          Buffer.concat([
            field(1, user),
            tokenDetails(used, 256_000),
            field(16, tokenDetails(250_000, 500_000)), // Unrelated subagent state.
          ]),
        );
        db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('0',?)").run(
          Buffer.from(
            JSON.stringify({
              latestRootBlobId: rootId,
              createdAt: 1_700_000_000_000,
            }),
          ).toString("hex"),
        );
      };
      commitRoot(196_533);
      const reader = new CursorSessionReader({ sessionsDir });
      const first = await reader.getSession(sessionId, "project");
      if (!first) throw new Error("Expected persisted session");
      expect(first?.summary.contextUsage?.inputTokens).toBe(196_533);
      expect(normalizeSession(first).contextUsage?.contextWindow).toBe(256_000);
      const before = await reader.getSessionFileStats(sessionId);
      if (!before) throw new Error("Expected session file stats");
      const mainBefore = await stat(join(dir, "store.db"));
      commitRoot(20_000);
      const mainAfter = await stat(join(dir, "store.db"));
      expect(mainAfter.mtimeMs).toBe(mainBefore.mtimeMs);
      expect(mainAfter.size).toBe(mainBefore.size);
      expect(
        await reader.getSessionSummaryIfChanged(
          sessionId,
          "project",
          before.mtime,
          before.size,
        ),
      ).toMatchObject({
        summary: {
          contextUsage: {
            inputTokens: 20_000,
            contextWindow: 256_000,
            percentage: 7.8,
          },
        },
      });
      expect((await readCursorSessionDir(dir))?.contextUsage?.inputTokens).toBe(
        20_000,
      );
      expect(
        (await reader.listSessions("project")).find((s) => s.id === sessionId)
          ?.contextUsage?.inputTokens,
      ).toBe(20_000);
      expect(reader.getIndexScopeKey("/sessions")).toBe(
        "cursor::/sessions::*::turn-status-v1",
      );
    } finally {
      db.close();
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });
});
