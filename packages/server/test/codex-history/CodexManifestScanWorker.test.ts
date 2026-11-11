import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanCodexManifestHeadersInWorker } from "../../src/codex-history/CodexManifestScanWorker.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("Codex manifest scan worker", () => {
  it("single-flights one physical root and keeps event-loop lag bounded", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-scan-worker-"));
    roots.push(root);
    const nested = join(root, "nested");
    await mkdir(nested);
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        writeFile(
          join(index % 2 === 0 ? root : nested, `session-${index}.jsonl`),
          `${JSON.stringify({ id: index })}\n`,
        ),
      ),
    );

    const lags: number[] = [];
    let expected = performance.now() + 2;
    const timer = setInterval(() => {
      const now = performance.now();
      lags.push(Math.max(0, now - expected));
      expected = now + 2;
    }, 2);
    const first = scanCodexManifestHeadersInWorker(root, 1024);
    const second = scanCodexManifestHeadersInWorker(root, 1024);
    expect(second).toBe(first);
    const rows = await first;
    clearInterval(timer);

    expect(rows).toHaveLength(500);
    lags.sort((left, right) => left - right);
    const p95 = lags[Math.floor(lags.length * 0.95)] ?? 0;
    expect(p95).toBeLessThanOrEqual(20);
  });

  it("re-reads only changed files and stops a first line at its newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-scan-incremental-"));
    roots.push(root);
    const longMeta = JSON.stringify({ meta: "x".repeat(40_000) });
    await writeFile(
      join(root, "long.jsonl"),
      `${longMeta}\n${"y".repeat(500_000)}\n`,
    );
    await writeFile(
      join(root, "stable.jsonl"),
      `${JSON.stringify({ id: 1 })}\n`,
    );

    const first = await scanCodexManifestHeadersInWorker(root, 1024 * 1024);
    const byName = (rows: typeof first, name: string) =>
      rows?.find((row) => row.filePath.endsWith(name));
    expect(byName(first, "long.jsonl")?.firstLine).toBe(longMeta);

    await writeFile(join(root, "long.jsonl"), `${JSON.stringify({ id: 2 })}\n`);
    const second = await scanCodexManifestHeadersInWorker(root, 1024 * 1024);
    expect(byName(second, "long.jsonl")?.firstLine).toBe('{"id":2}');
    // The unchanged file comes back as the same cached header object.
    expect(byName(second, "stable.jsonl")).toBe(byName(first, "stable.jsonl"));
  });
});
