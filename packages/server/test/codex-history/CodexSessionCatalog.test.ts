import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessionCatalog } from "../../src/codex-history/CodexSessionCatalog.js";
import type { Thread } from "../../src/sdk/providers/codex-protocol/generated/v2/Thread.js";
import { invalidateCodexSessionManifest } from "../../src/sessions/codex-session-manifest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function thread(
  id: string,
  cwd: string,
  path: string,
  updatedAt: number,
): Thread {
  return {
    id,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: `preview-${id}`,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: updatedAt - 10,
    updatedAt,
    recencyAt: updatedAt,
    status: { type: "notLoaded" },
    path,
    cwd,
    cliVersion: "0.149.0",
    source: "cli",
    canAcceptDirectInput: null,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

describe("CodexSessionCatalog", () => {
  it("paginates once, validates paths, groups cwd rows, and reuses the snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-catalog-"));
    roots.push(root);
    const validA = join(root, "a.jsonl");
    const validB = join(root, "b.jsonl");
    await writeFile(validA, "{}\n");
    await writeFile(validB, "{}\n");
    const pages = [
      {
        data: [
          thread("a", "/repo/a", validA, 200),
          thread("ghost", "/repo/a", join(root, "missing.jsonl"), 300),
        ],
        nextCursor: "next",
        backwardsCursor: null,
      },
      {
        data: [thread("b", "/repo/b", validB, 100)],
        nextCursor: null,
        backwardsCursor: null,
      },
    ];
    const listThreads = vi.fn(async () => {
      const page = pages.shift();
      if (!page) throw new Error("unexpected extra page");
      return page;
    });
    const catalog = new CodexSessionCatalog({
      client: { listThreads },
      ttlMs: 60_000,
    });

    const [first, concurrent] = await Promise.all([
      catalog.getSnapshot(),
      catalog.getSnapshot(),
    ]);
    const cached = await catalog.getSnapshot();

    expect(first).toBe(concurrent);
    expect(cached).toBe(first);
    expect(listThreads).toHaveBeenCalledTimes(2);
    expect(listThreads).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        useStateDbOnly: true,
        sortKey: "updated_at",
        limit: 100,
        sourceKinds: ["cli", "vscode", "exec", "appServer"],
      }),
    );
    expect(first?.sessions.map((session) => session.id)).toEqual(["a", "b"]);
    expect(first?.sessions[0]).toMatchObject({ messageCount: 1 });
    expect(first?.sessions[0]).not.toHaveProperty("messageCountAccuracy");
    expect(first?.unknownMessageCountIds).toEqual(new Set(["a", "b"]));
    expect(
      first?.byProjectPath.get("/repo/a")?.map((session) => session.id),
    ).toEqual(["a"]);
  });

  it("returns null so callers can scan-and-repair when the DB page is empty", async () => {
    const catalog = new CodexSessionCatalog({
      client: {
        listThreads: vi.fn(async () => ({
          data: [],
          nextCursor: null,
          backwardsCursor: null,
        })),
      },
    });

    await expect(catalog.getSnapshot()).resolves.toBeNull();
  });

  it("reconciles missing state DB rows from the rollout manifest in the background", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-catalog-reconcile-"));
    roots.push(root);
    const indexedPath = join(root, "indexed.jsonl");
    const missingId = "0198f000-0000-7000-8000-000000000099";
    const missingPath = join(root, `rollout-${missingId}.jsonl`);
    await writeFile(indexedPath, "{}\n");
    await writeFile(
      missingPath,
      `${JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-22T00:00:00.000Z",
        payload: {
          id: missingId,
          timestamp: "2026-08-22T00:00:00.000Z",
          cwd: "/repo/missing",
        },
      })}\n`,
    );
    const catalog = new CodexSessionCatalog({
      client: {
        listThreads: vi.fn(async () => ({
          data: [thread("indexed", "/repo/indexed", indexedPath, 200)],
          nextCursor: null,
          backwardsCursor: null,
        })),
      },
      sessionsDir: root,
      ttlMs: 60_000,
    });

    const first = await catalog.getSnapshot();
    expect(first?.sessions.map((session) => session.id)).toEqual(["indexed"]);
    await vi.waitFor(async () => {
      const reconciled = await catalog.getSnapshot();
      expect(reconciled?.sessions.map((session) => session.id)).toContain(
        missingId,
      );
    });
  });

  it("retains manifest-confirmed missing rows across TTL reloads until deletion is confirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-catalog-ttl-"));
    roots.push(root);
    const indexedPath = join(root, "indexed.jsonl");
    const missingId = "0198f000-0000-7000-8000-000000000088";
    const missingPath = join(root, `rollout-${missingId}.jsonl`);
    await writeFile(indexedPath, "{}\n");
    await writeFile(
      missingPath,
      `${JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-22T00:00:00.000Z",
        payload: {
          id: missingId,
          timestamp: "2026-08-22T00:00:00.000Z",
          cwd: "/repo/missing",
        },
      })}\n`,
    );
    let now = 1;
    const catalog = new CodexSessionCatalog({
      client: {
        listThreads: vi.fn(async () => ({
          data: [thread("indexed", "/repo/indexed", indexedPath, 200)],
          nextCursor: null,
          backwardsCursor: null,
        })),
      },
      sessionsDir: root,
      ttlMs: 2,
      now: () => now,
    });

    await catalog.getSnapshot();
    await vi.waitFor(async () => {
      expect(
        (await catalog.getSnapshot())?.sessions.map((session) => session.id),
      ).toContain(missingId);
    });

    now = 10;
    expect(
      (await catalog.getSnapshot())?.sessions.map((session) => session.id),
    ).toContain(missingId);

    await unlink(missingPath);
    invalidateCodexSessionManifest(root);
    now = 20;
    await catalog.getSnapshot();
    await vi.waitFor(async () => {
      expect(
        (await catalog.getSnapshot())?.sessions.map((session) => session.id),
      ).not.toContain(missingId);
    });
  });

  it("does not revive an invalidated manifest-only row during the next compose", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-catalog-delete-"));
    roots.push(root);
    const indexedPath = join(root, "indexed.jsonl");
    const missingId = "0198f000-0000-7000-8000-000000000077";
    const missingPath = join(root, `rollout-${missingId}.jsonl`);
    await writeFile(indexedPath, "{}\n");
    await writeFile(
      missingPath,
      `${JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-22T00:00:00.000Z",
        payload: {
          id: missingId,
          timestamp: "2026-08-22T00:00:00.000Z",
          cwd: "/repo/missing",
        },
      })}\n`,
    );
    const catalog = new CodexSessionCatalog({
      client: {
        listThreads: vi.fn(async () => ({
          data: [thread("indexed", "/repo/indexed", indexedPath, 200)],
          nextCursor: null,
          backwardsCursor: null,
        })),
      },
      sessionsDir: root,
      ttlMs: 60_000,
    });
    await catalog.getSnapshot();
    await vi.waitFor(async () => {
      expect(
        (await catalog.getSnapshot())?.sessions.map((session) => session.id),
      ).toContain(missingId);
    });

    await unlink(missingPath);
    invalidateCodexSessionManifest(root);
    catalog.invalidateSession(missingId);
    const immediatelyComposed = await catalog.getSnapshot();

    expect(immediatelyComposed?.sessions.map((session) => session.id)).toEqual([
      "indexed",
    ]);
    await vi.waitFor(async () => {
      expect(
        (await catalog.getSnapshot())?.sessions.map((session) => session.id),
      ).not.toContain(missingId);
    });
  });

  it("includes every user-visible source while excluding subagent sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-catalog-sources-"));
    roots.push(root);
    const rolloutPath = join(root, "shared.jsonl");
    await writeFile(rolloutPath, "{}\n");
    const sources = ["cli", "vscode", "exec", "appServer"] as const;
    const rows = sources.map((source, index) => ({
      ...thread(source, "/repo/source", rolloutPath, 200 - index),
      source,
    }));
    const listThreads = vi.fn(async () => ({
      data: rows,
      nextCursor: null,
      backwardsCursor: null,
    }));
    const catalog = new CodexSessionCatalog({
      client: { listThreads },
      ttlMs: 60_000,
    });

    expect(
      (await catalog.getSnapshot())?.sessions.map((row) => row.id),
    ).toEqual(sources);
    expect(listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKinds: [...sources] }),
    );
  });

  it("honors the manifest kill switch without calling app-server", async () => {
    const listThreads = vi.fn();
    const catalog = new CodexSessionCatalog({
      client: { listThreads },
      source: "manifest",
    });

    await expect(catalog.getSnapshot()).resolves.toBeNull();
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("serves a 1000-thread warm catalog within the 50 ms budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-catalog-scale-"));
    roots.push(root);
    const rolloutPath = join(root, "shared.jsonl");
    await writeFile(rolloutPath, "{}\n");
    const threads = Array.from({ length: 1_000 }, (_, index) =>
      thread(
        `thread-${index}`,
        `/repo/${index % 10}`,
        rolloutPath,
        2_000 - index,
      ),
    );
    const listThreads = vi.fn(async (params: { cursor?: string | null }) => {
      const start = Number.parseInt(params.cursor ?? "0", 10);
      const data = threads.slice(start, start + 100);
      const next = start + data.length;
      return {
        data,
        nextCursor: next < threads.length ? String(next) : null,
        backwardsCursor: null,
      };
    });
    const catalog = new CodexSessionCatalog({
      client: { listThreads },
      ttlMs: 60_000,
    });
    expect((await catalog.getSnapshot())?.sessions).toHaveLength(1_000);

    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      await catalog.getSnapshot();
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThan(50);
  });
});
