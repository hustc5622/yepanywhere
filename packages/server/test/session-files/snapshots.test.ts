import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureWorkspace } from "../../src/session-files/capture.js";
import { recordSnapshotChanges } from "../../src/session-files/changes.js";
import { SessionFileStore } from "../../src/session-files/store.js";
import type { FileChangeScope } from "../../src/session-files/types.js";

const execute = promisify(execFile);
const scope: FileChangeScope = {
  provider: "codex",
  sessionId: "session/1",
  branchId: "main",
  turnId: "turn-1",
};
let directory: string;
let workspace: string;
let store: SessionFileStore;
const git = (...args: string[]) => execute("git", ["-C", workspace, ...args]);
const write = (path: string, content: string | Buffer) =>
  writeFile(join(workspace, path), content);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "yep-file-snapshots-"));
  workspace = join(directory, "workspace");
  await mkdir(workspace);
  store = new SessionFileStore(join(directory, "store"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("session file snapshots", () => {
  it("records actual script writes and deletions, retaining versions after restart", async () => {
    await write("changed.md", "before\n");
    await write("removed.md", "keep this version\n");
    const before = await captureWorkspace(store, workspace);
    await execute(
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs');
      fs.writeFileSync('changed.md', 'after\\n');
      fs.writeFileSync('created.md', '# Report\\n');
      fs.unlinkSync('removed.md');
    `,
      ],
      { cwd: workspace },
    );
    const after = await captureWorkspace(store, workspace);
    const { id, record } = await recordSnapshotChanges(
      store,
      scope,
      before.id,
      after.id,
    );
    expect(record.changes.map(({ path, kind }) => [path, kind])).toEqual([
      ["changed.md", "modified"],
      ["created.md", "added"],
      ["removed.md", "deleted"],
    ]);
    expect(record.complete).toBe(true);
    expect(record.attribution).toBe("observed-during-execution");
    await rm(workspace, { recursive: true });
    const reopened = new SessionFileStore(store.directory);
    expect(await reopened.readRecord(scope, id)).toEqual(record);
    expect(await reopened.listRecords(scope)).toEqual([id]);
    const deleted = record.changes.find((c) => c.path === "removed.md");
    expect(
      (await reopened.readBlob(deleted?.before?.blob ?? "missing")).toString(),
    ).toBe("keep this version\n");
    expect(await reopened.readSnapshot(before.id)).toEqual(before.snapshot);
  });

  it("deduplicates binary content, preserves empty files and executable changes", async () => {
    await write("a.bin", Buffer.from([0, 255, 17]));
    await write("b.bin", Buffer.from([0, 255, 17]));
    await write("empty", "");
    const before = await captureWorkspace(store, workspace);
    expect(await readdir(join(store.directory, "blobs"))).toHaveLength(2);
    await chmod(join(workspace, "empty"), 0o755);
    const after = await captureWorkspace(store, workspace);
    const { record } = await recordSnapshotChanges(
      store,
      scope,
      before.id,
      after.id,
    );
    expect(record.changes).toHaveLength(1);
    expect(record.changes[0]).toMatchObject({
      path: "empty",
      kind: "modified",
      after: { executable: true },
    });
    expect(
      await store.readBlob(before.snapshot.files[0]?.blob ?? "missing"),
    ).toEqual(Buffer.from([0, 255, 17]));
  });

  it("uses dirty Git content, captures untracked files, respects ignores, leaves index alone", async () => {
    await git("init", "-q");
    await write(".gitignore", "ignored/\n*.log\n");
    await write("tracked.md", "staged\n");
    await write("tracked.log", "tracked despite ignore\n");
    await git("add", "tracked.md");
    await git("add", "-f", "tracked.log");
    await write("tracked.md", "dirty baseline\n");
    await write("new.md", "untracked\n");
    await mkdir(join(workspace, "ignored"));
    await write("ignored/private.md", "not captured");
    const index = await readFile(join(workspace, ".git/index"));
    const before = await captureWorkspace(store, workspace);
    expect(before.snapshot.enumeration).toBe("git");
    expect(before.snapshot.files.map((f) => f.path)).toEqual([
      ".gitignore",
      "new.md",
      "tracked.log",
      "tracked.md",
    ]);
    expect(before.snapshot.omissions).toContainEqual({
      path: "ignored",
      reason: "ignored",
    });
    expect(
      (
        await store.readBlob(
          before.snapshot.files.find((f) => f.path === "tracked.md")?.blob ??
            "missing",
        )
      ).toString(),
    ).toBe("dirty baseline\n");
    await write("tracked.md", "next\n");
    const after = await captureWorkspace(store, workspace);
    expect(
      (await recordSnapshotChanges(store, scope, before.id, after.id)).record
        .changes,
    ).toHaveLength(1);
    expect(await readFile(join(workspace, ".git/index"))).toEqual(index);
  });

  it("captures a Git subtree and detects deletion of a tracked parent directory", async () => {
    await git("init", "-q");
    await mkdir(join(workspace, "sub", "nested"), { recursive: true });
    await write("sub/nested/a.md", "old");
    await write("outside.md", "outside");
    await git("add", ".");
    const before = await captureWorkspace(store, join(workspace, "sub"));
    expect(before.snapshot.files.map((f) => f.path)).toEqual(["nested/a.md"]);
    await rm(join(workspace, "sub/nested"), { recursive: true });
    const after = await captureWorkspace(store, join(workspace, "sub"));
    expect(
      (await recordSnapshotChanges(store, scope, before.id, after.id)).record
        .changes[0]?.kind,
    ).toBe("deleted");
  });

  it("does not report deletion when a file becomes ignored", async () => {
    await git("init", "-q");
    await write("report.md", "keep");
    const before = await captureWorkspace(store, workspace);
    await write(".gitignore", "report.md\n");
    const after = await captureWorkspace(store, workspace);
    const { record } = await recordSnapshotChanges(
      store,
      scope,
      before.id,
      after.id,
    );
    expect(record.uncertainPaths).toContain("report.md");
    expect(record.changes.some((c) => c.path === "report.md")).toBe(false);
    expect(record.complete).toBe(false);
  });

  it("treats tracked children of a replaced symlink directory as unknown", async () => {
    await git("init", "-q");
    await mkdir(join(workspace, "docs"));
    await write("docs/a.md", "before");
    await git("add", ".");
    const before = await captureWorkspace(store, workspace);
    await rm(join(workspace, "docs"), { recursive: true });
    const outside = join(directory, "outside");
    await mkdir(outside);
    await symlink(outside, join(workspace, "docs"));
    const after = await captureWorkspace(store, workspace);
    const { record } = await recordSnapshotChanges(
      store,
      scope,
      before.id,
      after.id,
    );
    expect(record.changes.some((c) => c.path === "docs/a.md")).toBe(false);
    expect(record.uncertainPaths).toContain("docs/a.md");
  });

  it("fails closed on Git and storage errors instead of publishing a misleading snapshot", async () => {
    await write(".git", "gitdir: /nonexistent/yep-snapshot-test\n");
    await expect(captureWorkspace(store, workspace)).rejects.toThrow();
    await expect(readdir(join(store.directory, "snapshots"))).rejects.toThrow();
    await rm(join(workspace, ".git"));
    await write("report.md", "new");
    await writeFile(store.directory, "not a directory");
    await expect(captureWorkspace(store, workspace)).rejects.toThrow();
  });

  it("never follows file/directory symlinks or collects storage inside the workspace", async () => {
    await writeFile(join(directory, "secret"), "outside");
    await symlink(join(directory, "secret"), join(workspace, "link.md"));
    await symlink(directory, join(workspace, "linked-dir"));
    const result = await captureWorkspace(store, workspace);
    expect(result.snapshot.files).toEqual([]);
    expect(result.snapshot.omissions).toHaveLength(2);
    const nested = new SessionFileStore(join(workspace, "cache"));
    await expect(captureWorkspace(nested, workspace)).rejects.toThrow(
      "outside",
    );
    await symlink(workspace, join(directory, "alias"));
    await expect(
      captureWorkspace(
        new SessionFileStore(join(directory, "alias/cache")),
        workspace,
      ),
    ).rejects.toThrow("outside");
  });

  it("does not call an oversize or symlink-replaced file deleted", async () => {
    await write("large.md", "small");
    await write("link.md", "old");
    const before = await captureWorkspace(store, workspace, {
      maxFileBytes: 10,
    });
    await write("large.md", "x".repeat(11));
    await rm(join(workspace, "link.md"));
    await symlink(join(directory, "outside"), join(workspace, "link.md"));
    const after = await captureWorkspace(store, workspace, {
      maxFileBytes: 10,
    });
    const { record } = await recordSnapshotChanges(
      store,
      scope,
      before.id,
      after.id,
    );
    expect(record.changes).toEqual([]);
    expect(record.uncertainPaths).toEqual(["large.md", "link.md"]);
    expect(record.complete).toBe(false);
  });

  it("exposes byte and listing limits without inventing added/deleted files", async () => {
    await write("a", "1234");
    await write("b", "5678");
    const limited = await captureWorkspace(store, workspace, {
      maxTotalBytes: 4,
    });
    expect(limited.snapshot.files).toHaveLength(1);
    expect(limited.snapshot.omissions).toContainEqual({
      path: "b",
      reason: "byte-budget",
    });
    const before = await captureWorkspace(store, workspace, { maxEntries: 1 });
    expect(before.snapshot.listingComplete).toBe(false);
    await rm(join(workspace, "a"));
    const after = await captureWorkspace(store, workspace, { maxEntries: 1 });
    const { record } = await recordSnapshotChanges(
      store,
      scope,
      before.id,
      after.id,
    );
    expect(record.changes.some((c) => c.kind === "added")).toBe(false);
    expect(record.complete).toBe(false);
  });

  it("makes retries and concurrent store instances idempotent and separates session scopes", async () => {
    const before = await captureWorkspace(store, workspace);
    await write("report.md", "new");
    const after = await captureWorkspace(store, workspace);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        recordSnapshotChanges(
          new SessionFileStore(store.directory),
          scope,
          before.id,
          after.id,
        ),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await store.listRecords(scope)).toHaveLength(1);
    const pi = { ...scope, provider: "pi" as const, branchId: "entry-1" };
    expect(await store.listRecords(pi)).toEqual([]);
    await recordSnapshotChanges(store, pi, before.id, after.id);
    expect(await store.listRecords(pi)).toHaveLength(1);
    const branch = await recordSnapshotChanges(
      store,
      { ...scope, branchId: "fork" },
      before.id,
      after.id,
    );
    expect(branch.id).not.toBe(results[0]?.id);
  });

  it("rejects cross-workspace/policy comparisons, invalid IDs and corrupt blobs", async () => {
    await write("a.md", "old");
    const before = await captureWorkspace(store, workspace);
    const changedPolicy = await captureWorkspace(store, workspace, {
      maxFileBytes: 100,
    });
    await expect(
      recordSnapshotChanges(store, scope, before.id, changedPolicy.id),
    ).rejects.toThrow("policies");
    const other = join(directory, "other");
    await mkdir(other);
    const after = await captureWorkspace(store, other);
    await expect(
      recordSnapshotChanges(store, scope, before.id, after.id),
    ).rejects.toThrow("workspaces");
    await expect(store.readBlob("../../secret")).rejects.toThrow();
    const blob = before.snapshot.files[0]?.blob ?? "missing";
    await writeFile(
      join(store.directory, "blobs", `${blob}.json`),
      JSON.stringify({ base64: Buffer.from("bad").toString("base64") }),
    );
    await expect(store.readBlob(blob)).rejects.toThrow("integrity");
  });
});
