/**
 * Guard for runtimes without zstd.
 *
 * `node:zlib` only exposes zstd from Node 22.15.0, while this package declares
 * `node >=22.13.0`. Binding those functions at module scope (`promisify(
 * zstdDecompress)`) throws `TypeError: The "original" argument must be of type
 * function` while the module is *imported*, and `codex-session-manifest` is on
 * `app.ts`'s import graph — so on a supported-but-older runtime the whole server
 * would fail to start, for every user, whether or not any rollout was compressed.
 *
 * These tests mock zstd out of `node:zlib` and require that importing still
 * works, that the capability probe reports false, and that an actual read of a
 * compressed rollout fails with an actionable message instead of a TypeError.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:zlib", async () => {
  const actual = await vi.importActual<typeof import("node:zlib")>("node:zlib");
  return {
    ...actual,
    zstdDecompress: undefined,
    createZstdDecompress: undefined,
  };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-zstd-unsupported-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("codex rollout reads without zstd support", () => {
  it("imports the module and reports the capability as unavailable", async () => {
    const mod = await import("../../src/sessions/codex-rollout-file.js");
    expect(mod.isCodexRolloutDecompressionSupported()).toBe(false);
  });

  it("still reads plain rollouts", async () => {
    const { readCodexRolloutLines } = await import(
      "../../src/sessions/codex-rollout-file.js"
    );
    const filePath = join(dir, "rollout-plain.jsonl");
    await writeFile(filePath, '{"type":"session_meta"}\n', "utf8");

    expect(await readCodexRolloutLines(filePath)).toEqual([
      '{"type":"session_meta"}',
    ]);
  });

  it("fails a compressed read with an actionable error, not a TypeError", async () => {
    const { readCodexRolloutFirstLine, readCodexRolloutText } = await import(
      "../../src/sessions/codex-rollout-file.js"
    );
    const filePath = join(dir, "rollout-compressed.jsonl.zst");
    await writeFile(filePath, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));

    await expect(readCodexRolloutText(filePath)).rejects.toThrow(/22\.15\.0/);
    await expect(readCodexRolloutFirstLine(filePath, 4096)).rejects.toThrow(
      /22\.15\.0/,
    );
  });

  it("hides compressed rollouts from the manifest instead of listing unreadable sessions", async () => {
    const { getCodexSessionManifest, invalidateCodexSessionManifest } =
      await import("../../src/sessions/codex-session-manifest.js");
    await writeFile(
      join(dir, "rollout-compressed.jsonl.zst"),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
    );

    invalidateCodexSessionManifest(dir);
    const manifest = await getCodexSessionManifest(dir);
    expect(manifest.sessions).toHaveLength(0);
  });
});
