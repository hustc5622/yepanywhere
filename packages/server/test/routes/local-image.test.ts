import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

  function request(filePath: string) {
    return createLocalImageRoutes().request(
      `/?path=${encodeURIComponent(filePath)}`,
    );
  }

  it("serves media at any readable absolute path", async () => {
    const outputDir = path.join(tempDir, "anywhere", "output");
    await mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, "screenshot 9.10.56 AM.png");
    await writeFile(filePath, "png-bytes");

    const response = await request(filePath);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("png-bytes");
  });

  it("follows symlinks and traversal segments to the real file", async () => {
    const realDir = path.join(tempDir, "real");
    await mkdir(realDir);
    const filePath = path.join(realDir, "cover.png");
    await writeFile(filePath, "png-bytes");
    const link = path.join(tempDir, "alias.png");
    await symlink(filePath, link);

    for (const target of [link, `${realDir}/../real/cover.png`]) {
      const response = await request(target);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("png-bytes");
    }
  });

  it("rejects relative paths, missing files, directories and non-media types", async () => {
    await mkdir(path.join(tempDir, "dir.png"));
    await writeFile(path.join(tempDir, "notes.txt"), "text");

    expect((await request("relative/cover.png")).status).toBe(400);
    expect((await request(path.join(tempDir, "missing.png"))).status).toBe(404);
    expect((await request(path.join(tempDir, "dir.png"))).status).toBe(404);
    expect((await request(path.join(tempDir, "notes.txt"))).status).toBe(400);
  });

  it("serves extensionless blobs by sniffing the image signature", async () => {
    const filePath = path.join(tempDir, "b".repeat(64));
    await writeFile(
      filePath,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("body"),
      ]),
    );

    const response = await request(filePath);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("rejects extensionless files that are not images", async () => {
    const filePath = path.join(tempDir, "c".repeat(64));
    await writeFile(filePath, "not an image at all");

    expect((await request(filePath)).status).toBe(400);
  });
});
