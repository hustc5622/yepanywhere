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
