import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordCodexFileNotification } from "../../src/session-files/codex-operations.js";
import { projectFileOperations } from "../../src/session-files/operation-projection.js";
import { SessionFileOperationStore } from "../../src/session-files/operation-store.js";
let root: string;
let store: SessionFileOperationStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-file-ops-"));
  store = new SessionFileOperationStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const scope = { provider: "codex", sourceId: "local", sessionId: "s" };
const context = { sessionId: "s", workspace: "/not-an-existing-worktree" };
const item = {
  type: "fileChange",
  id: "call",
  status: "completed",
  changes: [
    { path: "report.md", kind: { type: "add" }, diff: "# Saved\nsecond\n" },
  ],
};
const notification = {
  method: "item/completed",
  params: { threadId: "s", turnId: "t", item },
};

describe("Codex actual file operation adapter", () => {
  it("captures native additions as content, replays once, and never needs a worktree", async () => {
    await recordCodexFileNotification(store, context, notification);
    await recordCodexFileNotification(store, context, {
      method: "turn/completed",
      params: { threadId: "s", turn: { id: "t", items: [item] } },
    });
    await recordCodexFileNotification(store, context, {
      method: "turn/diff/updated",
      params: { threadId: "s", turnId: "t", diff: "aggregate" },
    });
    const saved = await new SessionFileOperationStore(root).snapshot(scope);
    expect(saved.operations).toHaveLength(1);
    const files = await projectFileOperations(
      store,
      saved.operations,
      context.workspace,
      new Map([["t", "user"]]),
    );
    expect(files.files[0]).toMatchObject({
      additions: 2,
      deletions: 0,
      count: 1,
    });
  });
  it.each(["inProgress", "failed", "declined"])(
    "does not count %s proposals as applied",
    async (status) => {
      await recordCodexFileNotification(store, context, {
        ...notification,
        params: { ...notification.params, item: { ...item, status } },
      });
      const saved = await store.snapshot(scope);
      expect(
        (
          await projectFileOperations(
            store,
            saved.operations,
            context.workspace,
            new Map([["t", "u"]]),
          )
        ).files,
      ).toEqual([]);
    },
  );
  it("ignores another thread and does not infer a child apply_patch from an outer exec result", async () => {
    await recordCodexFileNotification(store, context, {
      ...notification,
      params: { ...notification.params, threadId: "other" },
    });
    await recordCodexFileNotification(store, context, {
      ...notification,
      params: {
        ...notification.params,
        item: {
          type: "dynamicToolCall",
          id: "exec",
          status: "completed",
          tool: "exec",
          arguments: 'tools.apply_patch("patch")',
          contentItems: [],
        },
      },
    });
    expect((await store.snapshot(scope)).operations).toEqual([]);
  });
});
