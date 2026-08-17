import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionArchiveService } from "../../src/archive/index.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import {
  getCodexSessionManifest,
  invalidateCodexSessionManifest,
} from "../../src/sessions/codex-session-manifest.js";
import { cloneCodexSession } from "../../src/sessions/fork.js";

const compress = promisify(zstdCompress);
const CWD = "/tmp/compressed-project";

let sessionsDir: string;
let reader: CodexSessionReader;

function rollout(sessionId: string, prompt: string): string {
  return [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-08-15T02:29:49.000Z",
      payload: {
        id: sessionId,
        timestamp: "2026-08-15T02:29:49.000Z",
        cwd: CWD,
      },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-15T02:30:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-15T02:30:05.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer" }],
      },
    }),
  ].join("\n");
}

async function writePlainRollout(
  sessionId: string,
  prompt: string,
): Promise<string> {
  const filePath = join(sessionsDir, `rollout-${sessionId}.jsonl`);
  await writeFile(filePath, rollout(sessionId, prompt), "utf8");
  return filePath;
}

async function writeCompressedRollout(
  sessionId: string,
  prompt: string,
): Promise<string> {
  const filePath = join(sessionsDir, `rollout-${sessionId}.jsonl.zst`);
  await writeFile(
    filePath,
    await compress(Buffer.from(rollout(sessionId, prompt), "utf8")),
  );
  return filePath;
}

beforeEach(async () => {
  sessionsDir = join(tmpdir(), `codex-compressed-${randomUUID()}`);
  await mkdir(sessionsDir, { recursive: true });
  reader = new CodexSessionReader({ sessionsDir });
});

afterEach(async () => {
  invalidateCodexSessionManifest(sessionsDir);
  await rm(sessionsDir, { recursive: true, force: true });
});

describe("CodexSessionReader with compressed rollouts", () => {
  it("discovers a session that exists only as .jsonl.zst", async () => {
    // Without this, a Codex install with local_thread_store_compression enabled
    // silently loses every session older than seven days.
    const sessionId = "00000000-0000-0000-0000-00000000aaaa";
    await writeCompressedRollout(sessionId, "compressed only");

    const manifest = await getCodexSessionManifest(sessionsDir);
    const entry = manifest.byId.get(sessionId);

    expect(entry).toBeDefined();
    expect(entry?.filePath.endsWith(".jsonl.zst")).toBe(true);
    expect(entry?.cwd).toBe(CWD);
  });

  it("reads messages from a compressed session", async () => {
    const sessionId = "00000000-0000-0000-0000-00000000bbbb";
    await writeCompressedRollout(sessionId, "compressed only");

    const projectId = encodeProjectId(CWD) as UrlProjectId;
    const summary = await reader.getSessionSummary(sessionId, projectId);
    const loaded = await reader.getSession(sessionId, projectId);

    expect(summary?.messageCount).toBeGreaterThan(0);
    expect(loaded?.data.session.entries.length).toBe(3);
  });

  it("prefers the plain file when a resume has materialized it", async () => {
    // Codex decompresses back to plain before appending, so both files coexist
    // during a resume and the plain copy is the live one.
    const sessionId = "00000000-0000-0000-0000-00000000cccc";
    const plainPath = await writePlainRollout(sessionId, "live prompt");
    await writeCompressedRollout(sessionId, "stale prompt");

    const manifest = await getCodexSessionManifest(sessionsDir);
    const matching = manifest.sessions.filter(
      (session) => session.id === sessionId,
    );

    expect(matching).toHaveLength(1);
    expect(matching[0]?.filePath).toBe(plainPath);
  });

  it("lists plain and compressed sessions together", async () => {
    await writePlainRollout("00000000-0000-0000-0000-00000000dddd", "plain");
    await writeCompressedRollout(
      "00000000-0000-0000-0000-00000000eeee",
      "compressed",
    );

    const projectId = encodeProjectId(CWD) as UrlProjectId;
    const sessions = await reader.listSessions(projectId);

    expect(sessions.map((session) => session.id).sort()).toEqual([
      "00000000-0000-0000-0000-00000000dddd",
      "00000000-0000-0000-0000-00000000eeee",
    ]);
  });

  it("marks the encoding on the manifest entry", async () => {
    // The flag is the forcing function for the next consumer of `filePath`: a
    // bare `string` cannot say "these bytes are not text", which is exactly how
    // the clone path came to read compressed bytes as UTF-8.
    const plainId = "00000000-0000-0000-0000-0000000000f1";
    const compressedId = "00000000-0000-0000-0000-0000000000f2";
    await writePlainRollout(plainId, "plain");
    await writeCompressedRollout(compressedId, "compressed");

    const manifest = await getCodexSessionManifest(sessionsDir);

    expect(manifest.byId.get(plainId)?.compressed).toBe(false);
    expect(manifest.byId.get(compressedId)?.compressed).toBe(true);
  });
});

/**
 * Contract tests for everything that consumes a rollout path.
 *
 * Discovery is what changed: `filePath` can now carry compressed bytes. Every
 * consumer therefore has to be classified as either "decodes the bytes" (must go
 * through `codex-rollout-file.ts`) or "only moves/stats the bytes" (safe for both
 * forms). These tests pin that classification for the consumers that exist, so a
 * new one cannot quietly re-introduce a UTF-8 read.
 */
describe("compressed rollout consumers", () => {
  it("clones a compressed session into a valid plain rollout", async () => {
    // The regression this guards: `cloneCodexSession` used readFile(utf-8), which
    // does not throw on zstd bytes. It produced a `rollout-*.jsonl` full of
    // mojibake that then became a permanent manifest entry.
    const sourceId = "00000000-0000-0000-0000-0000000000c1";
    const targetId = "00000000-0000-0000-0000-0000000000c2";
    await writeCompressedRollout(sourceId, "clone me");

    const manifest = await getCodexSessionManifest(sessionsDir);
    const source = manifest.byId.get(sourceId);
    expect(source?.compressed).toBe(true);

    const result = await cloneCodexSession(
      source?.filePath as string,
      targetId,
    );
    expect(result).toEqual({ newSessionId: targetId, entries: 3 });

    // The clone must be plain text, parseable, and carry the new id.
    const clonePath = join(sessionsDir, `rollout-${targetId}.jsonl`);
    const cloned = await readFile(clonePath, "utf8");
    const entries = cloned
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: unknown });
    expect(entries).toHaveLength(3);
    expect(entries[0]?.type).toBe("session_meta");
    expect((entries[0]?.payload as { id: string }).id).toBe(targetId);

    // And it must be a session the reader can actually open.
    invalidateCodexSessionManifest(sessionsDir);
    const projectId = encodeProjectId(CWD) as UrlProjectId;
    const summary = await reader.getSessionSummary(targetId, projectId);
    expect(summary?.messageCount).toBeGreaterThan(0);
  });

  it("refuses to clone bytes it could not decode instead of writing garbage", async () => {
    // Fail-closed is the part that outlives zstd: whatever storage format Codex
    // adopts next, a clone is never produced from undecoded bytes.
    const filePath = join(sessionsDir, "rollout-undecodable.jsonl");
    await writeFile(
      filePath,
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]),
    );

    await expect(
      cloneCodexSession(filePath, "00000000-0000-0000-0000-0000000000c3"),
    ).rejects.toThrow(/not decodable JSONL/);

    expect(await readdir(sessionsDir)).toEqual(["rollout-undecodable.jsonl"]);
  });

  it("archives and restores a compressed session byte-for-byte", async () => {
    // Auto-archive fires at 7 days and Codex compresses after 7 days cold, so the
    // two features meet on the same files. Archiving is a byte-level move, which
    // is safe for either form; this pins that it stays a move and that the
    // restored session is readable again.
    const sessionId = "00000000-0000-0000-0000-0000000000a1";
    const sourcePath = await writeCompressedRollout(sessionId, "archive me");
    const originalBytes = await readFile(sourcePath);

    const dataDir = join(tmpdir(), `codex-compressed-archive-${randomUUID()}`);
    const service = new SessionArchiveService({ dataDir });
    await service.initialize();
    const projectId = encodeProjectId(CWD) as UrlProjectId;

    try {
      await service.archiveSession({
        sessionId,
        provider: "codex",
        project: {
          id: projectId,
          path: CWD,
          name: "compressed-project",
          sessionCount: 1,
          sessionDir: sessionsDir,
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "codex",
        },
        sessionFilePath: sourcePath,
        reason: "manual",
      });

      // Moved out of the session tree, so discovery no longer sees it.
      invalidateCodexSessionManifest(sessionsDir);
      expect(
        (await getCodexSessionManifest(sessionsDir)).byId.get(sessionId),
      ).toBeUndefined();

      await service.restoreSession(sessionId);

      expect(await readFile(sourcePath)).toEqual(originalBytes);
      invalidateCodexSessionManifest(sessionsDir);
      const summary = await reader.getSessionSummary(sessionId, projectId);
      expect(summary?.messageCount).toBeGreaterThan(0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
