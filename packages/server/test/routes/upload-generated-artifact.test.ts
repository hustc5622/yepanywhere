import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUploadRoutes } from "../../src/routes/upload.js";
import { GeneratedArtifactMaterializer } from "../../src/uploads/generated-artifact.js";
import { UploadManager } from "../../src/uploads/manager.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("generated artifact HTTP delivery", () => {
  it("serves only the hash-bound registry route and keeps ordinary uploads working", async () => {
    const context = await createContext();
    const source = join(context.workspace, "report.pdf");
    const bytes = Buffer.from("%PDF-1.7\nsafe-report\n");
    await writeFile(source, bytes);
    const artifact = await materialize(context, "report.pdf");

    const response = await context.routes.request(
      artifact.downloadUrl.slice("/api".length),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

    const generatedPath = await context.uploadManager.resolveTaskPathRef(
      { projectId: context.projectId, sessionId: context.sessionId },
      artifact.managedRef,
    );
    const bypass = await context.routes.request(
      `/projects/${context.projectId}/sessions/${context.sessionId}/upload/${encodeURIComponent(basename(generatedPath))}`,
    );
    expect(bypass.status).toBe(404);

    const userUpload = await context.uploadManager.ingest({
      projectId: context.projectId,
      sessionId: context.sessionId,
      originalName: ".yep-generated-report.txt",
      mimeType: "text/plain",
      stream: chunks(Buffer.from("ordinary user upload")),
    });
    expect(userUpload.name).toContain("_user-.yep-generated-");
    const ordinary = await context.routes.request(
      `/projects/${context.projectId}/sessions/${context.sessionId}/upload/${encodeURIComponent(userUpload.name)}`,
    );
    expect(ordinary.status).toBe(200);
    expect(await ordinary.text()).toBe("ordinary user upload");

    await writeFile(generatedPath, Buffer.from("%PDF-1.7\nevil-report\n"));
    const tampered = await context.routes.request(
      artifact.downloadUrl.slice("/api".length),
    );
    expect(tampered.status).toBe(409);
  });

  it("fails closed for missing registry/retention and expired records", async () => {
    const context = await createContext();
    await writeFile(
      join(context.workspace, "report.pdf"),
      "%PDF-1.7\nsafe-report\n",
    );
    const artifact = await materialize(context, "report.pdf");
    const registryPath = join(
      context.uploadsDir,
      context.projectId,
      context.sessionId,
      ".generated",
      `${artifact.id}.json`,
    );
    await rename(registryPath, `${registryPath}.missing`);
    expect(
      (await context.routes.request(artifact.downloadUrl.slice("/api".length)))
        .status,
    ).toBe(404);
    await rename(`${registryPath}.missing`, registryPath);

    const attachmentId = artifact.managedRef.slice("upload:".length);
    const retentionPath = join(
      context.uploadsDir,
      context.projectId,
      context.sessionId,
      ".retention",
      `generated-${attachmentId}.json`,
    );
    await rename(retentionPath, `${retentionPath}.missing`);
    expect(
      (await context.routes.request(artifact.downloadUrl.slice("/api".length)))
        .status,
    ).toBe(404);
    await rename(`${retentionPath}.missing`, retentionPath);

    context.now = 2_001;
    expect(
      (await context.routes.request(artifact.downloadUrl.slice("/api".length)))
        .status,
    ).toBe(410);
  });
});

async function createContext() {
  const root = await mkdtemp(join(tmpdir(), "yep-generated-http-"));
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
  const context = {
    root,
    workspace,
    uploadsDir,
    projectId,
    sessionId,
    uploadManager,
    now: 1_000,
    routes: undefined as unknown as ReturnType<typeof createUploadRoutes>,
  };
  context.routes = createUploadRoutes({
    scanner: { getProject: async () => ({ path: workspace }) } as never,
    upgradeWebSocket: (() => async (c: { text(text: string): Response }) =>
      c.text("upgrade required")) as never,
    uploadsDir,
    uploadManager,
    now: () => context.now,
  });
  return context;
}

async function materialize(
  context: Awaited<ReturnType<typeof createContext>>,
  relativePath: string,
) {
  const materializer = new GeneratedArtifactMaterializer({
    uploadManager: context.uploadManager,
    now: () => 1_000,
    retentionMs: 1_000,
  });
  const result = await materializer.materialize(
    {
      lifecycle: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "fileChange",
        id: "file-1",
        status: "completed",
        changes: [{ path: relativePath, kind: { type: "add" } }],
      },
    },
    {
      projectId: context.projectId,
      sessionId: context.sessionId,
      taskId: "task-1",
      workspaceRoot: context.workspace,
      threadId: "thread-1",
      turnId: "turn-1",
      canonicalEventId: "connection-1:1",
      canonicalEventSequence: 1,
    },
  );
  const artifact = result.artifacts[0];
  if (!artifact) throw new Error(JSON.stringify(result.warnings));
  return artifact;
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}
