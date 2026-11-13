import { link, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUploadRoutes } from "../../src/routes/upload.js";
import { UploadManager } from "../../src/uploads/manager.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed upload HTTP delivery", () => {
  it("serves a stable ordinary upload with non-sniffing download headers", async () => {
    const context = await createContext();
    const upload = await context.uploadManager.ingest({
      projectId: context.projectId,
      sessionId: context.sessionId,
      originalName: "review's notes.txt",
      mimeType: "text/plain",
      stream: chunks(Buffer.from("safe notes")),
    });

    const response = await requestUpload(context, upload.name);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain("%27");
    expect(await response.text()).toBe("safe notes");
  });

  it("keeps generated storage names off the ordinary upload route", async () => {
    const context = await createContext();
    const upload = await context.uploadManager.ingest({
      projectId: context.projectId,
      sessionId: context.sessionId,
      originalName: "report.txt",
      mimeType: "text/plain",
      stream: chunks(Buffer.from("generated")),
      storageClass: "generated",
    });

    expect((await requestUpload(context, upload.name)).status).toBe(404);
  });

  it("rejects symlink and hard-link substitutions", async () => {
    const context = await createContext();
    const symlinked = await context.uploadManager.ingest({
      projectId: context.projectId,
      sessionId: context.sessionId,
      originalName: "symlink.txt",
      mimeType: "text/plain",
      stream: chunks(Buffer.from("managed")),
    });
    const moved = join(context.root, "moved.txt");
    await rename(symlinked.path, moved);
    await symlink(moved, symlinked.path);
    expect((await requestUpload(context, symlinked.name)).status).toBe(400);

    const hardLinked = await context.uploadManager.ingest({
      projectId: context.projectId,
      sessionId: context.sessionId,
      originalName: "hard-link.txt",
      mimeType: "text/plain",
      stream: chunks(Buffer.from("managed")),
    });
    await link(hardLinked.path, join(context.root, "second-link.txt"));
    expect((await requestUpload(context, hardLinked.name)).status).toBe(409);
  });
});

describe("uploads catalog HTTP API", () => {
  it("lists uploads, summarizes sessions and looks up one entry", async () => {
    const context = await createContext();
    const upload = await context.uploadManager.ingest({
      projectId: context.projectId,
      sessionId: context.sessionId,
      originalName: "shot.png",
      mimeType: "image/png",
      stream: chunks(Buffer.from("png")),
    });

    const list = await context.routes.request(
      `/uploads?projectId=${context.projectId}&sessionId=${context.sessionId}`,
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      entries: [{ ref: upload.ref, originalName: "shot.png" }],
      totals: { count: 1 },
    });

    const sessions = await context.routes.request("/uploads/sessions");
    expect(await sessions.json()).toMatchObject({
      sessions: [{ sessionId: context.sessionId, count: 1 }],
    });

    const entry = await context.routes.request(
      `/uploads/entry?ref=${encodeURIComponent(upload.ref)}`,
    );
    expect(await entry.json()).toMatchObject({ entry: { id: upload.id } });
  });

  it("rejects malformed filters and references", async () => {
    const context = await createContext();
    for (const path of [
      "/uploads?projectId=..%2F",
      `/uploads?sessionId=${context.sessionId}`,
      "/uploads?source=disk",
      "/uploads/entry?ref=%2Fetc%2Fpasswd",
    ]) {
      expect((await context.routes.request(path)).status).toBe(400);
    }
  });

  it("asks for confirmation before deleting a sent upload", async () => {
    const context = await createContext();
    const upload = await context.uploadManager.ingest({
      projectId: context.projectId,
      sessionId: context.sessionId,
      originalName: "sent.png",
      mimeType: "image/png",
      stream: chunks(Buffer.from("png")),
    });
    const remove = (confirmed: boolean) =>
      context.routes.request("/uploads", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: upload.ref, confirmed }),
      });

    const pending = await remove(false);
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({
      entry: { usedBy: [{ sessionId: context.sessionId }] },
    });
    expect((await remove(true)).status).toBe(200);
    expect((await requestUpload(context, upload.name)).status).toBe(404);
    expect((await remove(true)).status).toBe(404);
  });
});

async function createContext() {
  const root = await mkdtemp(join(tmpdir(), "yep-upload-http-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const uploadsDir = join(root, "uploads");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(uploadsDir, { recursive: true }),
  ]);
  const projectId = Buffer.from(workspace).toString("base64url");
  const sessionId = "session-1";
  const uploadManager = new UploadManager({ uploadsDir });
  const routes = createUploadRoutes({
    scanner: { getProject: async () => ({ path: workspace }) } as never,
    upgradeWebSocket: (() => async (c: { text(text: string): Response }) =>
      c.text("upgrade required")) as never,
    uploadsDir,
    uploadManager,
  });
  return {
    root,
    uploadsDir,
    projectId,
    sessionId,
    uploadManager,
    routes,
  };
}

function requestUpload(
  context: Awaited<ReturnType<typeof createContext>>,
  fileName: string,
): Promise<Response> {
  return context.routes.request(
    `/projects/${context.projectId}/sessions/${context.sessionId}/upload/${encodeURIComponent(
      basename(fileName),
    )}`,
  );
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}
