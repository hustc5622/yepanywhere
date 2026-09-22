import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordCodexFileNotification } from "../../src/session-files/codex-operations.js";
import {
  importCodexFileHistory,
  importStructuredFileHistory,
} from "../../src/session-files/history-operations.js";
import { projectFileOperations } from "../../src/session-files/operation-projection.js";
import { SessionFileOperationStore } from "../../src/session-files/operation-store.js";
import type { Message } from "../../src/supervisor/types.js";
import {
  nestedPatchCandidate,
  nestedPatchOuterResult,
} from "./fixtures/operations.js";
let root: string;
let store: SessionFileOperationStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "file-history-"));
  store = new SessionFileOperationStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const context = { sessionId: "s", workspace: "/project" };
const scope = { provider: "codex", sourceId: "local", sessionId: "s" };

describe("historical file operation evidence", () => {
  it.each(["live-first", "history-first"])(
    "deduplicates reordered multi-file evidence in %s delivery order without hiding real conflicts",
    async (deliveryOrder) => {
      const live = () =>
        recordCodexFileNotification(store, context, {
          method: "item/completed",
          params: {
            threadId: "s",
            turnId: "t",
            item: {
              type: "fileChange",
              id: "multi-file",
              status: "completed",
              changes: ["a.md", "b.md"].map((path) => ({
                path,
                kind: { type: "add" },
                diff: `${path}\n`,
              })),
            },
          },
        });
      const history = (content = "b.md\n") =>
        importCodexFileHistory(
          store,
          context,
          [
            {
              type: "event_msg",
              timestamp: "2026-09-21T00:00:00Z",
              payload: {
                type: "item_completed",
                thread_id: "s",
                turn_id: "t",
                item: {
                  type: "FileChange",
                  id: "multi-file",
                  status: "completed",
                  changes: {
                    "b.md": { type: "add", content },
                    "a.md": { type: "add", content: "a.md\n" },
                  },
                },
              },
            },
          ],
          [],
        );
      const deliveries =
        deliveryOrder === "live-first" ? [live, history] : [history, live];
      await deliveries[0]?.();
      const first = await store.snapshot(scope);
      await deliveries[1]?.();
      const replayed = await new SessionFileOperationStore(root).snapshot(
        scope,
      );
      expect(replayed.revision).toBe(first.revision);
      expect(replayed.operations).toHaveLength(1);
      expect(replayed.operations[0]?.conflict).toBe(false);
      const projected = await projectFileOperations(
        store,
        replayed.operations,
        context.workspace,
        new Map([["t", "u"]]),
      );
      expect(projected.unavailableOperations).toBe(0);
      expect(projected.files).toHaveLength(2);
      expect(projected.files).toEqual(
        expect.arrayContaining(
          ["a.md", "b.md"].map((path) =>
            expect.objectContaining({
              path,
              additions: 1,
              deletions: 0,
              count: 1,
            }),
          ),
        ),
      );

      await history("different content\n");
      expect((await store.snapshot(scope)).operations[0]?.conflict).toBe(true);
    },
  );

  it("recovers a code-mode child from the native completed FileChange, not from the JavaScript wrapper", async () => {
    const outer = [
      { type: "response_item", payload: nestedPatchCandidate },
      { type: "response_item", payload: nestedPatchOuterResult },
    ];
    await importCodexFileHistory(store, context, outer, []);
    expect((await store.snapshot(scope)).operations).toEqual([]);
    const native = {
      type: "event_msg",
      timestamp: "2026-09-21T00:00:00Z",
      payload: {
        type: "item_completed",
        thread_id: "s",
        turn_id: "t",
        item: {
          type: "FileChange",
          id: "exec-child",
          status: "completed",
          changes: {
            "/project/report.md": {
              type: "add",
              content: `${Array.from({ length: 135 }, (_, i) => `line ${i}`).join("\n")}\n`,
            },
          },
        },
      },
    };
    await importCodexFileHistory(store, context, [...outer, native], []);
    await importCodexFileHistory(store, context, [native], []);
    const snapshot = await store.snapshot(scope);
    expect(snapshot.operations).toHaveLength(1);
    const result = await projectFileOperations(
      store,
      snapshot.operations,
      context.workspace,
      new Map([["t", "u"]]),
    );
    expect(result.files[0]).toMatchObject({
      additions: 135,
      deletions: 0,
      count: 1,
      path: "report.md",
    });
  });
  it("does not accept legacy patches without explicit success or belonging to another thread", async () => {
    const payload = {
      type: "patch_apply_end",
      call_id: "c",
      turn_id: "t",
      changes: { a: { type: "add", content: "text" } },
    };
    await importCodexFileHistory(
      store,
      context,
      [
        { type: "event_msg", payload },
        {
          type: "event_msg",
          payload: { ...payload, success: true, thread_id: "other" },
        },
      ],
      [],
    );
    expect((await store.snapshot(scope)).operations).toEqual([]);
  });
  it("uses structured result pre/post images and rejects missing or failed tool results", async () => {
    const messages: Message[] = [
      { type: "user", uuid: "u", message: { role: "user", content: "edit" } },
      {
        type: "assistant",
        uuid: "a",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "c",
              name: "Edit",
              input: { path: "report.md" },
            },
          ],
        },
      },
    ];
    const ctx = { ...context, provider: "zcode" };
    await importStructuredFileHistory(store, ctx, messages);
    expect(
      (await store.snapshot({ ...scope, provider: "zcode" })).operations,
    ).toEqual([]);
    const result: Message = {
      type: "user",
      uuid: "result",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "c",
            content: JSON.stringify({
              filePath: "report.md",
              originalFile: "old\n",
              content: "new\n",
            }),
          },
        ],
      },
    };
    await importStructuredFileHistory(store, ctx, [...messages, result]);
    const saved = await store.snapshot({ ...scope, provider: "zcode" });
    expect(
      (
        await projectFileOperations(
          store,
          saved.operations,
          "/project",
          new Map([["u", "u"]]),
        )
      ).files[0],
    ).toMatchObject({ additions: 1, deletions: 1 });
  });
});
