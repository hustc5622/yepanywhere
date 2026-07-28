import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalImageRoutes } from "../../src/routes/local-image.js";

describe("Local image routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-local-image-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves files from the managed uploads directory", async () => {
    const uploadsDir = path.join(tempDir, "uploads");
    const sessionDir = path.join(
      uploadsDir,
      "encoded-project-path",
      "session-123",
    );
    await mkdir(sessionDir, { recursive: true });

    const filePath = path.join(sessionDir, "screenshot 9.10.56 AM.png");
    await writeFile(filePath, "png-bytes");

    const routes = createLocalImageRoutes({
      allowedPaths: [uploadsDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("png-bytes");
  });

  it("serves extensionless Kimi blobs by sniffing the image signature", async () => {
    const blobsDir = path.join(
      tempDir,
      "sessions",
      "wd_x",
      "agents",
      "main",
      "blobs",
    );
    await mkdir(blobsDir, { recursive: true });

    const hash = "b".repeat(64);
    const filePath = path.join(blobsDir, hash);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("body"),
    ]);
    await writeFile(filePath, png);

    const routes = createLocalImageRoutes({
      allowedPaths: [path.join(tempDir, "sessions")],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("rejects extensionless files that are not images", async () => {
    const blobsDir = path.join(tempDir, "sessions", "blobs");
    await mkdir(blobsDir, { recursive: true });

    const filePath = path.join(blobsDir, "c".repeat(64));
    await writeFile(filePath, "not an image at all");

    const routes = createLocalImageRoutes({
      allowedPaths: [path.join(tempDir, "sessions")],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(400);
  });

  it("ignores empty allowed path prefixes", async () => {
    const filePath = path.join(tempDir, "outside.png");
    await writeFile(filePath, "png-bytes");

    const routes = createLocalImageRoutes({
      allowedPaths: [""],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Path not in allowed directories",
    });
  });

  it("rejects files outside the allowed directories", async () => {
    const uploadsDir = path.join(tempDir, "uploads");
    const otherDir = path.join(tempDir, "other");
    await mkdir(otherDir, { recursive: true });

    const filePath = path.join(otherDir, "outside.png");
    await writeFile(filePath, "png-bytes");

    const routes = createLocalImageRoutes({
      allowedPaths: [uploadsDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Path not in allowed directories",
    });
  });
});
