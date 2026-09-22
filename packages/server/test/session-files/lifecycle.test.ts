import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFileLifecycle } from "../../src/session-files/lifecycle.js";
import {
  readSavedFileRecords,
  savedFileActivities,
} from "../../src/session-files/reader.js";
import { SessionFileStore } from "../../src/session-files/store.js";
import type { FileChangeScope } from "../../src/session-files/types.js";

let root: string;
let workspace: string;
let store: SessionFileStore;
let lifecycle: SessionFileLifecycle;
const scope: FileChangeScope = {
  provider: "codex",
  sessionId: "session",
  branchId: "session",
  turnId: "pending:request",
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "yep-capture-lifecycle-"));
  workspace = join(root, "project");
  await mkdir(workspace);
  store = new SessionFileStore(join(root, "store"));
  lifecycle = new SessionFileLifecycle(store, { checkpointIntervalMs: 0 });
});
afterEach(async () => {
  await lifecycle.close("owner");
  await rm(root, { recursive: true, force: true });
});
async function records() {
  return Promise.all(
    (await store.listRecords(scope)).map((id) => store.readRecord(scope, id)),
  );
}
async function manifests() {
  const folder = join(store.directory, "executions");
  return Promise.all(
    (await readdir(folder)).map(async (file) =>
      JSON.parse(await readFile(join(folder, file), "utf8")),
    ),
  );
}

describe("SessionFileLifecycle", () => {
  it("publishes live observations under native identity, without duplicating file versions", async () => {
    await writeFile(join(workspace, "report.md"), "before");
    await lifecycle.begin({ ...scope }, workspace, "owner", "request");
    await writeFile(join(workspace, "report.md"), "first");
    await lifecycle.checkpoint(scope.sessionId);
    expect(await records()).toEqual([]);
    await lifecycle.bind(scope.sessionId, "native");
    await lifecycle.checkpoint(scope.sessionId);
    expect((await records())[0]).toMatchObject({
      execution: { status: "active" },
      changes: [
        expect.objectContaining({ path: "report.md", kind: "modified" }),
      ],
    });
    const select = async () =>
      readSavedFileRecords(store, "codex", scope.sessionId, workspace, [
        {
          type: "user",
          uuid: "question",
          codexTurnId: "native",
          message: { role: "user", content: "go" },
        },
      ]);
    expect(savedFileActivities((await select()).records)).toHaveLength(1);
    const snapshotCount = (await readdir(join(store.directory, "snapshots")))
      .length;
    await lifecycle.checkpoint(scope.sessionId);
    expect(await records()).toHaveLength(1);
    expect(await readdir(join(store.directory, "snapshots"))).toHaveLength(
      snapshotCount,
    );
    await writeFile(join(workspace, "report.md"), "second");
    await lifecycle.checkpoint(scope.sessionId);
    const liveFiles = savedFileActivities((await select()).records);
    expect(liveFiles[0]?.savedVersions).toHaveLength(1);
    await lifecycle.finish(scope.sessionId, "native", "completed");
    const files = savedFileActivities((await select()).records);
    expect(files[0]?.savedVersions).toHaveLength(1);
    const finalId = files[0]?.savedVersions?.[0]?.recordId ?? "missing";
    const final = await store.readRecord(scope, finalId);
    expect(final.execution?.status).toBe("completed");
    expect(
      (
        await store.readBlob(final.changes[0]?.before?.blob ?? "missing")
      ).toString(),
    ).toBe("before");
    expect(
      (
        await store.readBlob(final.changes[0]?.after?.blob ?? "missing")
      ).toString(),
    ).toBe("second");
  });

  it("removes reverted live changes when the terminal observation has no net change", async () => {
    await writeFile(join(workspace, "report.md"), "before");
    await lifecycle.begin({ ...scope }, workspace, "owner", "request");
    await lifecycle.bind(scope.sessionId, "native");
    await writeFile(join(workspace, "report.md"), "temporary");
    await lifecycle.checkpoint(scope.sessionId);
    await writeFile(join(workspace, "report.md"), "before");
    await lifecycle.finish(scope.sessionId, "native", "completed");
    const selected = await readSavedFileRecords(
      store,
      "codex",
      scope.sessionId,
      workspace,
      [
        {
          type: "user",
          uuid: "question",
          codexTurnId: "native",
          message: { role: "user", content: "go" },
        },
      ],
    );
    expect(selected.records).toHaveLength(2);
    expect(savedFileActivities(selected.records)).toEqual([]);
  });

  it("periodically captures a running turn and stops scheduling after completion", async () => {
    lifecycle = new SessionFileLifecycle(store, { checkpointIntervalMs: 20 });
    await lifecycle.begin({ ...scope }, workspace, "owner", "request");
    await lifecycle.bind(scope.sessionId, "native");
    await writeFile(join(workspace, "live.md"), "visible before completion");
    await vi.waitFor(async () =>
      expect(
        (await records()).some(
          (r) =>
            r.execution?.status === "active" &&
            r.changes.some((c) => c.path === "live.md"),
        ),
      ).toBe(true),
    );
    await lifecycle.finish(scope.sessionId, "native", "completed");
    const count = (await records()).length;
    await writeFile(join(workspace, "outside-turn.md"), "not this turn");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await records()).toHaveLength(count);
    expect(
      (await records())
        .flatMap((r) => r.changes)
        .some((c) => c.path === "outside-turn.md"),
    ).toBe(false);
  });
  it.each(["completed", "failed", "interrupted"] as const)(
    "persists baseline before admission and records writes on %s",
    async (status) => {
      await writeFile(join(workspace, "report.md"), "old");
      await lifecycle.begin({ ...scope }, workspace, "owner", "request");
      const [active] = await manifests();
      expect(active).toMatchObject({ status: "active", coverage: "full" });
      expect(await store.readSnapshot(active.before)).toBeDefined();
      await lifecycle.bind(scope.sessionId, "native-turn");
      await writeFile(join(workspace, "report.md"), "new");
      // Duplicate admission/steer must not reset the original baseline.
      await lifecycle.begin({ ...scope }, workspace, "owner", "other-request");
      await lifecycle.reject(scope.sessionId, "other-request");
      await lifecycle.finish(scope.sessionId, "unrelated-turn", "completed");
      expect(await records()).toEqual([]);
      await lifecycle.finish(scope.sessionId, "native-turn", status);
      await lifecycle.finish(scope.sessionId, "native-turn", status);
      const saved = await records();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        scope: { turnId: "native-turn" },
        execution: { status, coverage: "full" },
        complete: true,
      });
      const old = saved[0]?.changes[0]?.before?.blob;
      expect((await store.readBlob(old ?? "missing")).toString()).toBe("old");
    },
  );

  it("serializes close after pending admission and marks disconnect observations partial", async () => {
    const pending = lifecycle.begin(
      { ...scope },
      workspace,
      "owner",
      "request",
    );
    const close = lifecycle.close("owner");
    await Promise.all([pending, close]);
    expect((await records())[0]).toMatchObject({
      complete: false,
      execution: { status: "disconnected", coverage: "partial" },
    });
    expect((await manifests())[0]).toMatchObject({ status: "disconnected" });
  });

  it("records late attachment as partial and never consumes another owner's capture", async () => {
    await lifecycle.begin({ ...scope }, workspace, "first", "late", true);
    await lifecycle.bind(scope.sessionId, "native");
    await lifecycle.close("second");
    expect(await records()).toEqual([]);
    await writeFile(join(workspace, "new.md"), "new");
    await lifecycle.finish(scope.sessionId, "native", "completed");
    expect((await records())[0]).toMatchObject({
      complete: false,
      execution: { coverage: "partial" },
    });
  });

  it("persists a capture failure without blocking agent admission or inventing a baseline", async () => {
    await lifecycle.begin(
      { ...scope },
      join(root, "missing"),
      "owner",
      "request",
    );
    const [active] = await manifests();
    expect(active).toMatchObject({ coverage: "partial" });
    expect(active.captureError).toBeTruthy();
    expect(active.before).toBeUndefined();
    await lifecycle.close("owner");
    expect(await records()).toEqual([]);
  });

  it("rejects only the pending request and does not revive crash manifests on restart", async () => {
    await lifecycle.begin({ ...scope }, workspace, "owner", "rejected");
    await lifecycle.reject(scope.sessionId, "rejected");
    expect((await records())[0]).toMatchObject({
      execution: { status: "rejected", coverage: "partial" },
    });
    await lifecycle.begin({ ...scope }, workspace, "owner", "crash");
    const restarted = new SessionFileLifecycle(
      new SessionFileStore(store.directory),
    );
    await restarted.finish(scope.sessionId, "old-turn", "completed");
    expect(await records()).toHaveLength(1);
    expect((await manifests()).some((m) => m.status === "active")).toBe(true);
  });
});
