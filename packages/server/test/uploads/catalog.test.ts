import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UploadCatalog } from "../../src/uploads/catalog.js";
import { UploadManager } from "../../src/uploads/manager.js";

const PROJECT = "cHJvamVjdA";

describe("UploadCatalog", () => {
  let root: string;
  let uploadsDir: string;
  let manager: UploadManager;
  let catalog: UploadCatalog;

  beforeEach(async () => {
    root = join(tmpdir(), `upload-catalog-${randomUUID()}`);
    uploadsDir = join(root, "uploads");
    await mkdir(uploadsDir, { recursive: true });
    manager = new UploadManager({ uploadsDir });
    catalog = new UploadCatalog({ uploadsDir, uploadManager: manager });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function store(
    sessionId: string,
    originalName: string,
    storageClass: "user" | "generated" = "user",
  ) {
    return manager.ingest({
      projectId: PROJECT,
      sessionId,
      originalName,
      mimeType: "image/png",
      storageClass,
      stream: (async function* () {
        yield Buffer.from(`bytes of ${originalName}`);
      })(),
    });
  }

  it("lists each stored file with its source, newest first", async () => {
    const web = await store("session-a", "screen.png");
    const feishu = await store("session-a", "chat.png");
    await manager.setTaskAttachmentRetention(
      { projectId: PROJECT, sessionId: "session-a", taskId: "feishu-task" },
      [feishu.id],
    );
    const generated = await store("session-b", "chart.png", "generated");
    await utimes(web.path, new Date(1_000), new Date(1_000));

    const { entries, totals } = await catalog.list();
    expect(entries.map((entry) => entry.ref)).toEqual([
      expect.any(String),
      expect.any(String),
      web.ref,
    ]);
    expect(totals.count).toBe(3);
    expect(entries.find((entry) => entry.id === web.id)).toMatchObject({
      source: "web",
      originalName: "screen.png",
      mimeType: "image/png",
      downloadUrl: web.ref,
    });
    expect(entries.find((entry) => entry.id === feishu.id)?.source).toBe(
      "feishu",
    );
    const generatedEntry = entries.find((entry) => entry.id === generated.id);
    expect(generatedEntry).toMatchObject({
      source: "generated",
      originalName: "chart.png",
    });
    expect(generatedEntry?.downloadUrl).toBeUndefined();
    expect(JSON.stringify(entries)).not.toContain(uploadsDir);

    await expect(
      catalog.list({ projectId: PROJECT, sessionId: "session-b" }),
    ).resolves.toMatchObject({ totals: { count: 1 } });
    await expect(catalog.list({ source: "feishu" })).resolves.toMatchObject({
      totals: { count: 1 },
    });
    await expect(catalog.list({ query: "SCREEN" })).resolves.toMatchObject({
      totals: { count: 1 },
    });
  });

  it("summarizes sessions and paginates with a cursor", async () => {
    await store("session-a", "one.png");
    await store("session-a", "two.png");
    await store("session-b", "three.png");

    const first = await catalog.listSessions({}, { limit: 1 });
    expect(first.sessions).toHaveLength(1);
    expect(first.nextCursor).toBe("1");
    expect(first.totals.count).toBe(3);
    const second = await catalog.listSessions({}, { cursor: first.nextCursor });
    expect(second.nextCursor).toBeNull();
    const all = [...first.sessions, ...second.sessions];
    expect(
      all.find((session) => session.sessionId === "session-a"),
    ).toMatchObject({ count: 2 });
  });

  it("counts untracked uploads as sent by their own session", async () => {
    const legacy = await store("session-a", "legacy.png");
    await expect(catalog.get(legacy.ref)).resolves.toMatchObject({
      usedBy: [{ projectId: PROJECT, sessionId: "session-a" }],
    });

    await catalog.recordUse([legacy.ref], {
      projectId: PROJECT,
      sessionId: "session-b",
    });
    await utimes(legacy.path, new Date(1_000), new Date(1_000));
    await expect(catalog.get(legacy.ref)).resolves.toMatchObject({
      usedBy: [
        { projectId: PROJECT, sessionId: "session-a" },
        { projectId: PROJECT, sessionId: "session-b" },
      ],
    });
  });

  it("treats a tracked upload no session sent as unused", async () => {
    await catalog.recordUse(
      [(await store("session-a", "seed.png")).ref],
      { projectId: PROJECT, sessionId: "session-a" },
      Date.now() - 60_000,
    );
    const draft = await store("session-a", "draft.png");
    await expect(catalog.get(draft.ref)).resolves.toMatchObject({
      usedBy: [],
    });

    await expect(catalog.remove(draft.ref)).resolves.toMatchObject({
      status: "removed",
    });
    await expect(stat(draft.path)).rejects.toThrow();
    await expect(catalog.remove(draft.ref)).resolves.toEqual({
      status: "not_found",
    });
  });

  it("requires confirmation before deleting a file a session sent", async () => {
    const sent = await store("session-a", "sent.png");
    await expect(catalog.remove(sent.ref)).resolves.toMatchObject({
      status: "needs_confirmation",
    });
    expect((await stat(sent.path)).isFile()).toBe(true);
    await expect(
      catalog.remove(sent.ref, { confirmed: true }),
    ).resolves.toMatchObject({ status: "removed" });
    await expect(stat(sent.path)).rejects.toThrow();
  });

  it("removes a generated copy together with its task record", async () => {
    const generated = await store("session-a", "out.png", "generated");
    await manager.setTaskAttachmentRetention(
      {
        projectId: PROJECT,
        sessionId: "session-a",
        taskId: `generated-${generated.id}`,
      },
      [generated.id],
    );
    await expect(
      catalog.remove(generated.ref, { confirmed: true }),
    ).resolves.toMatchObject({ status: "removed" });
    await expect(stat(generated.path)).rejects.toThrow();
    await expect(
      manager.getTaskAttachmentRetention({
        projectId: PROJECT,
        sessionId: "session-a",
        taskId: `generated-${generated.id}`,
      }),
    ).resolves.toBeNull();
  });
});
