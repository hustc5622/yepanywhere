import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSharedCodexEntries } from "../../src/sessions/codex-entries-reader.js";
import type { CodexRolloutScanError } from "../../src/sessions/codex-rollout-file.js";
import {
  compressedCodexRolloutPath,
  isCompressedCodexRolloutPath,
  iterateCodexRolloutLines,
  plainCodexRolloutPath,
  readCodexRolloutFirstLine,
  readCodexRolloutLines,
  resolveExistingCodexRolloutPath,
} from "../../src/sessions/codex-rollout-file.js";

const compress = promisify(zstdCompress);

let dir: string;

const META_LINE = JSON.stringify({
  type: "session_meta",
  timestamp: "2026-08-15T02:29:49.000Z",
  payload: {
    id: "session-zst",
    timestamp: "2026-08-15T02:29:49.000Z",
    cwd: "/tmp/project",
  },
});

const USER_LINE = JSON.stringify({
  type: "response_item",
  timestamp: "2026-08-15T02:30:00.000Z",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hello" }],
  },
});

const ROLLOUT = `${META_LINE}\n${USER_LINE}\n`;

async function writePlain(name: string, body = ROLLOUT): Promise<string> {
  const filePath = join(dir, name);
  await writeFile(filePath, body, "utf8");
  return filePath;
}

async function writeCompressed(name: string, body = ROLLOUT): Promise<string> {
  const filePath = join(dir, `${name}.zst`);
  await writeFile(filePath, await compress(Buffer.from(body, "utf8")));
  return filePath;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-rollout-file-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("codex rollout path helpers", () => {
  it("maps between plain and compressed forms idempotently", () => {
    const plain = "/s/rollout-x.jsonl";
    const compressed = "/s/rollout-x.jsonl.zst";

    expect(isCompressedCodexRolloutPath(plain)).toBe(false);
    expect(isCompressedCodexRolloutPath(compressed)).toBe(true);

    expect(compressedCodexRolloutPath(plain)).toBe(compressed);
    expect(compressedCodexRolloutPath(compressed)).toBe(compressed);

    expect(plainCodexRolloutPath(compressed)).toBe(plain);
    expect(plainCodexRolloutPath(plain)).toBe(plain);
  });

  it("prefers the plain file when both forms exist", async () => {
    // Codex materializes a compressed rollout back to plain before appending, so
    // during a resume both files exist and the plain one is the live copy.
    const plain = await writePlain("rollout-a.jsonl");
    await writeCompressed("rollout-a.jsonl", "stale\n");

    expect(await resolveExistingCodexRolloutPath(plain)).toBe(plain);
    expect(await resolveExistingCodexRolloutPath(`${plain}.zst`)).toBe(plain);
  });

  it("resolves the compressed file when only it exists", async () => {
    const compressed = await writeCompressed("rollout-b.jsonl");
    const plain = join(dir, "rollout-b.jsonl");

    expect(await resolveExistingCodexRolloutPath(plain)).toBe(compressed);
  });

  it("returns null when neither form exists", async () => {
    expect(
      await resolveExistingCodexRolloutPath(join(dir, "missing.jsonl")),
    ).toBeNull();
  });
});

describe("reading compressed rollouts", () => {
  it("reads identical lines from plain and compressed copies", async () => {
    const plain = await writePlain("rollout-c.jsonl");
    const compressed = await writeCompressed("rollout-d.jsonl");

    const fromPlain = await readCodexRolloutLines(plain);
    const fromCompressed = await readCodexRolloutLines(compressed);

    expect(fromCompressed).toEqual(fromPlain);
    expect(fromCompressed).toHaveLength(2);
  });

  it("reads the header line from both forms without inflating everything", async () => {
    // A long tail after the header would be inflated by a naive whole-file read;
    // the streaming reader must stop at the first newline.
    const body = `${META_LINE}\n${`${USER_LINE}\n`.repeat(2000)}`;
    const plain = await writePlain("rollout-e.jsonl", body);
    const compressed = await writeCompressed("rollout-f.jsonl", body);

    expect(await readCodexRolloutFirstLine(plain, 1024 * 1024)).toBe(META_LINE);
    expect(await readCodexRolloutFirstLine(compressed, 1024 * 1024)).toBe(
      META_LINE,
    );
  });

  it("returns null for an empty rollout in either form", async () => {
    const plain = await writePlain("rollout-g.jsonl", "");
    const compressed = await writeCompressed("rollout-h.jsonl", "");

    expect(await readCodexRolloutFirstLine(plain, 4096)).toBeNull();
    expect(await readCodexRolloutFirstLine(compressed, 4096)).toBeNull();
  });

  it("leaves the source file untouched", async () => {
    const compressed = await writeCompressed("rollout-i.jsonl");
    const before = await readFile(compressed);

    await readCodexRolloutLines(compressed);
    await readCodexRolloutFirstLine(compressed, 4096);

    expect(await readFile(compressed)).toEqual(before);
  });

  it("parses shared entries from a compressed rollout", async () => {
    const compressed = await writeCompressed("rollout-j.jsonl");

    const loaded = await readSharedCodexEntries(compressed);

    expect(loaded.entries).toHaveLength(2);
    expect(loaded.entries[0]?.type).toBe("session_meta");
  });

  it("iterates bounded UTF-8 lines with stable logical byte offsets", async () => {
    const body = `\uFEFF${JSON.stringify({ text: "你好" })}\r\n${JSON.stringify({ text: "tail" })}`;
    const filePath = await writePlain("rollout-k.jsonl", body);

    const lines = [];
    for await (const line of iterateCodexRolloutLines(filePath, {
      maxLineBytes: 1024,
    })) {
      lines.push(line);
    }

    expect(lines.map((line) => line.line)).toEqual([
      JSON.stringify({ text: "你好" }),
      JSON.stringify({ text: "tail" }),
    ]);
    expect(lines.map((line) => line.offset)).toEqual([
      0,
      Buffer.byteLength(JSON.stringify({ text: "你好" }), "utf8") + 2,
    ]);
  });

  it("rejects an oversized line before JSON parsing", async () => {
    const filePath = await writePlain(
      "rollout-l.jsonl",
      `${"x".repeat(128)}\n`,
    );

    await expect(
      (async () => {
        for await (const _line of iterateCodexRolloutLines(filePath, {
          maxLineBytes: 64,
        })) {
          // The first line must fail before this body runs.
        }
      })(),
    ).rejects.toMatchObject<CodexRolloutScanError>({
      code: "entry_too_large",
    });
  });
});

/**
 * Single-owner invariant for the compressed-rollout format.
 *
 * The bug this whole module exists to fix was not "zstd was missing" but "how
 * rollout bytes are stored was knowledge spread across whichever call site
 * happened to read a file". `cloneCodexSession` inlined `readFile(path,
 * "utf-8")`, which does not fail on compressed bytes — it silently yields
 * mojibake, and because that call site is also the only rollout *writer*, it
 * turned a read bug into a corrupt file on disk.
 *
 * So the format has exactly one owner. This test fails if a second module starts
 * reaching for the codec directly instead of going through this one.
 */
describe("compressed rollout format ownership", () => {
  const OWNER = "sessions/codex-rollout-file.ts";

  async function collectSourceFiles(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await collectSourceFiles(full)));
      else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
    }
    return found;
  }

  it("keeps zstd usage in exactly one module", async () => {
    const srcDir = join(import.meta.dirname, "..", "..", "src");
    const files = await collectSourceFiles(srcDir);

    const owners: string[] = [];
    for (const file of files) {
      // Comments are stripped first: neighbouring modules legitimately explain in
      // prose *why* byte offsets survive compression, and that must not count as
      // reaching for the codec.
      const code = (await readFile(file, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
      if (/zstd/i.test(code)) {
        owners.push(relative(srcDir, file).split(sep).join("/"));
      }
    }

    expect(owners).toEqual([OWNER]);
  });
});
