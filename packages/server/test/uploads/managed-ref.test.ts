import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ManagedUploadResolutionError,
  UploadManager,
  resolveManagedUpload,
  toPublicUpload,
} from "../../src/uploads/manager.js";

const PROJECT = "cHJvamVjdA";
const SESSION = "session-1";

describe("managed upload references", () => {
  let root: string;
  let uploads: string;

  beforeEach(async () => {
    root = join(tmpdir(), `managed-ref-${randomUUID()}`);
    uploads = join(root, "uploads");
    await mkdir(uploads, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function upload(name: string, bytes = "png-bytes") {
    const manager = new UploadManager({ uploadsDir: uploads });
    return manager.ingest({
      projectId: PROJECT,
      sessionId: SESSION,
      originalName: name,
      mimeType: "image/png",
      stream: (async function* () {
        yield Buffer.from(bytes);
      })(),
    });
  }

  it("issues a reference on completion and keeps the path server-side", async () => {
    const stored = await upload("截图.png");
    expect(stored.ref).toBe(
      `/api/projects/${PROJECT}/sessions/${SESSION}/upload/${encodeURIComponent(stored.name)}`,
    );
    expect(toPublicUpload(stored)).not.toHaveProperty("path");
  });

  it("resolves a reference, from any session, to the managed file", async () => {
    const stored = await upload("shot.png");
    const resolved = await resolveManagedUpload(
      { ref: stored.ref, originalName: "shot.png", mimeType: "image/png" },
      uploads,
    );
    expect(resolved).toMatchObject({
      id: stored.id,
      ref: stored.ref,
      name: stored.name,
      size: stored.size,
      mimeType: "image/png",
    });
    expect(resolved.path).toContain(stored.name);
  });

  it("maps a legacy upload path to its reference", async () => {
    const stored = await upload("shot.png");
    const resolved = await resolveManagedUpload({ path: stored.path }, uploads);
    expect(resolved.ref).toBe(stored.ref);
  });

  it("rejects paths and references that do not name a managed file", async () => {
    await writeFile(join(root, "secret.png"), "secret");
    const missing = `/api/projects/${PROJECT}/sessions/${SESSION}/upload/123e4567-e89b-12d3-a456-426614174000_gone.png`;
    for (const input of [
      { path: join(root, "secret.png") },
      { path: "/etc/passwd" },
      { ref: "/api/projects/x/sessions/../upload/a.png" },
      { ref: missing },
      {},
    ]) {
      await expect(resolveManagedUpload(input, uploads)).rejects.toThrow(
        ManagedUploadResolutionError,
      );
    }
  });

  it("rejects a symlink planted inside the uploads root", async () => {
    await writeFile(join(root, "secret.png"), "secret");
    const name = "123e4567-e89b-12d3-a456-426614174000_link.png";
    await mkdir(join(uploads, PROJECT, SESSION), { recursive: true });
    await symlink(
      join(root, "secret.png"),
      join(uploads, PROJECT, SESSION, name),
    );
    await expect(
      resolveManagedUpload(
        {
          ref: `/api/projects/${PROJECT}/sessions/${SESSION}/upload/${name}`,
        },
        uploads,
      ),
    ).rejects.toThrow(ManagedUploadResolutionError);
  });

  it("does not resolve server-generated storage names", async () => {
    const manager = new UploadManager({ uploadsDir: uploads });
    const generated = await manager.ingest({
      projectId: PROJECT,
      sessionId: SESSION,
      originalName: "out.png",
      mimeType: "image/png",
      storageClass: "generated",
      stream: (async function* () {
        yield Buffer.from("png");
      })(),
    });
    await expect(
      resolveManagedUpload({ ref: generated.ref }, uploads),
    ).rejects.toThrow(ManagedUploadResolutionError);
  });
});
