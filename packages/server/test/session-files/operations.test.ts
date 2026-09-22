import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countOperationPatch,
  operationLineStats,
  projectFileOperations,
} from "../../src/session-files/operation-projection.js";
import { SessionFileOperationStore } from "../../src/session-files/operation-store.js";
import { contentId } from "../../src/session-files/store.js";
import { operation } from "./fixtures/operations.js";

let root: string;
let store: SessionFileOperationStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "file-operations-"));
  store = new SessionFileOperationStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const scope = { provider: "codex", sourceId: "local", sessionId: "s" };

describe("file operation persistence and projection", () => {
  it.each([
    ["\uFEFFtext\n", "text\n", 1, 1],
    ["a\r\n", "a\n", 1, 1],
    ["a", "a\n", 1, 1],
    ["", "", 0, 0],
  ] as const)(
    "keeps BOM, line endings and empty-file statistics faithful",
    async (oldText, newText, additions, deletions) => {
      const before = await store.putContent(Buffer.from(oldText));
      const after = await store.putContent(Buffer.from(newText));
      expect(
        await operationLineStats(store, {
          path: "file",
          kind: "modified",
          outcome: "applied",
          before,
          after,
        }),
      ).toMatchObject({ availability: "complete", additions, deletions });
    },
  );

  it("bounds retained content, deduplicates quota usage and preserves existing objects", async () => {
    const bounded = new SessionFileOperationStore(
      join(root, "bounded"),
      100,
      5,
    );
    const first = await bounded.putContent(Buffer.from("1234"));
    await bounded.putContent(Buffer.from("1234"));
    await expect(bounded.putContent(Buffer.from("other"))).rejects.toThrow(
      "quota",
    );
    expect((await bounded.readContent(first)).toString()).toBe("1234");
  });

  it("deduplicates repeated native and replay deliveries without adding transport timestamps", async () => {
    await store.append(operation());
    for (let i = 0; i < 100; i++)
      expect(
        (
          await store.append(
            operation({
              order: 200,
              timestamp: "2026-09-22T00:00:00Z",
              source: "historical-tool-record",
              resultId: "replayed",
            }),
          )
        ).inserted,
      ).toBe(false);
    const loaded = await new SessionFileOperationStore(root).snapshot(scope);
    expect(loaded.operations).toHaveLength(1);
    expect(
      (
        await projectFileOperations(
          store,
          loaded.operations,
          "/project",
          new Map([["t", "user"]]),
        )
      ).files[0],
    ).toMatchObject({ additions: 2, deletions: 0, count: 1 });
  });
  it("coordinates independent writers and distinguishes sessions and turns", async () => {
    const other = new SessionFileOperationStore(root);
    await Promise.all([
      store.append(operation()),
      other.append(
        operation({
          identity: { ...operation().identity, toolCallId: "second" },
          order: 2,
        }),
      ),
    ]);
    await other.append(
      operation({ identity: { ...operation().identity, sessionId: "other" } }),
    );
    expect((await store.snapshot(scope)).operations).toHaveLength(2);
    expect(
      (await store.snapshot({ ...scope, sessionId: "other" })).operations,
    ).toHaveLength(1);
  });
  it("does not let late started events replace a terminal result, and quarantines conflicting terminal facts", async () => {
    await store.append(operation());
    await store.append(
      operation({ outcome: "pending", resultId: undefined, changes: [] }),
    );
    expect((await store.snapshot(scope)).operations[0]?.record.outcome).toBe(
      "applied",
    );
    expect(
      (
        await store.append(
          operation({
            changes: [{ ...firstChange(), path: "different.md" }],
          }),
        )
      ).conflict,
    ).toBe(true);
    const result = await projectFileOperations(
      store,
      (await store.snapshot(scope)).operations,
      "/project",
      new Map([["t", "u"]]),
    );
    expect(result.files).toEqual([]);
    expect(result.unavailableOperations).toBe(1);
  });
  it("recovers a published fact if a crash happened before publishing its index", async () => {
    await store.append(operation());
    const sessionDirectory = join(
      root,
      "sessions",
      (await readdir(join(root, "sessions")))[0] ?? "missing",
    );
    const next = operation({
      identity: { ...operation().identity, toolCallId: "second" },
      order: 2,
    });
    await writeFile(join(sessionDirectory, "dirty"), "1");
    await writeFile(
      join(
        sessionDirectory,
        "records",
        `${contentId(JSON.stringify(next))}.json`,
      ),
      JSON.stringify(next),
    );
    const result = await new SessionFileOperationStore(root).snapshot(scope);
    expect(result.operations).toHaveLength(2);
  });
  it("counts each actual edit rather than splicing externally modified file versions", async () => {
    const firstBefore = await store.putContent(Buffer.from("a\n"));
    const firstAfter = await store.putContent(Buffer.from("a\nours\n"));
    const secondBefore = await store.putContent(
      Buffer.from("a\nours\nexternal\n"),
    );
    const secondAfter = await store.putContent(Buffer.from("a\nexternal\n"));
    await store.append(
      operation({
        changes: [
          {
            path: "file",
            kind: "modified",
            outcome: "applied",
            before: firstBefore,
            after: firstAfter,
          },
        ],
      }),
    );
    await store.append(
      operation({
        identity: { ...operation().identity, toolCallId: "second" },
        order: 2,
        changes: [
          {
            path: "file",
            kind: "modified",
            outcome: "applied",
            before: secondBefore,
            after: secondAfter,
          },
        ],
      }),
    );
    const result = await projectFileOperations(
      store,
      (await store.snapshot(scope)).operations,
      "/project",
      new Map([["t", "u"]]),
    );
    expect(result.files[0]).toMatchObject({
      additions: 1,
      deletions: 1,
      count: 2,
      knownOperations: 2,
      unknownOperations: 0,
    });
    expect(
      (
        await projectFileOperations(
          store,
          (
            await store.snapshot(scope)
          ).operations,
          "/project",
          new Map(),
        )
      ).files,
    ).toEqual([]);
    expect(
      (
        await projectFileOperations(
          store,
          (
            await store.snapshot(scope)
          ).operations,
          "/another",
          new Map([["t", "u"]]),
        )
      ).files,
    ).toEqual([]);
  });
  it("preserves binary changes and unknown counts when content is unavailable", async () => {
    const binary = await store.putContent(Buffer.from([0, 255]));
    await store.append(
      operation({
        changes: [
          {
            path: "image.bin",
            kind: "added",
            outcome: "applied",
            before: null,
            after: binary,
          },
        ],
      }),
    );
    const result = await projectFileOperations(
      store,
      (await store.snapshot(scope)).operations,
      "/project",
      new Map([["t", "u"]]),
    );
    expect(result.files[0]).toMatchObject({ unknownOperations: 1, count: 1 });
    expect(result.files[0]?.additions).toBeUndefined();
    await rm(join(root, "content", "blobs", `${binary.hash}.json`));
    await expect(store.readContent(binary)).rejects.toThrow();
    expect((await store.snapshot(scope)).operations).toHaveLength(1);
  });
  it("rejects truncated patches instead of reporting misleading zero or partial counts", () => {
    const change = firstChange();
    expect(countOperationPatch(change)).toMatchObject({
      availability: "complete",
      additions: 2,
      deletions: 0,
    });
    expect(
      countOperationPatch({
        ...change,
        patch: {
          format: "unified",
          complete: true,
          text: "--- a\n+++ b\n@@ -1,2 +1,2 @@\n-old\n+new\n",
        },
      }).availability,
    ).toBe("unavailable");
  });
});

function firstChange() {
  const change = operation().changes[0];
  if (!change) throw new Error("Missing test change");
  return change;
}
