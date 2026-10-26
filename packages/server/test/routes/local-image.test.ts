import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalImageRoutes } from "../../src/routes/local-image.js";
import type { Project } from "../../src/supervisor/types.js";

describe("Local image routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-local-image-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function projectAt(projectPath: string, isRemoteProject = false): Project {
    return {
      id: "test-project" as Project["id"],
      name: "test-project",
      path: projectPath,
      sessionDir: path.join(tempDir, "sessions"),
      sessionCount: 1,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      isRemoteProject,
    };
  }

  it("serves project output and follows project discovery and removal", async () => {
    const projectDir = path.join(tempDir, "project");
    const outputDir = path.join(projectDir, "output", "marketing");
    await mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, "cover.png");
    await writeFile(filePath, "png-bytes");

    const listProjects = vi
      .fn<() => Promise<Project[]>>()
      .mockResolvedValue([]);
    const routes = createLocalImageRoutes({
      allowedPaths: [],
      scanner: { listProjects },
    });
    const url = `/?path=${encodeURIComponent(filePath)}`;
    expect((await routes.request(url)).status).toBe(403);

    listProjects.mockResolvedValue([projectAt(projectDir)]);
    const response = await routes.request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("png-bytes");

    listProjects.mockResolvedValue([]);
    expect((await routes.request(url)).status).toBe(403);
  });

  it("rejects sibling paths, traversal and symlinks escaping a project", async () => {
    const projectDir = path.join(tempDir, "project");
    const outsideDir = path.join(tempDir, "project-other");
    await mkdir(projectDir);
    await mkdir(outsideDir);
    const outsideFile = path.join(outsideDir, "private.png");
    await writeFile(outsideFile, "private-bytes");
    const link = path.join(projectDir, "escape.png");
    await symlink(outsideFile, link);

    const routes = createLocalImageRoutes({
      allowedPaths: [],
      scanner: { listProjects: async () => [projectAt(projectDir)] },
    });
    for (const filePath of [
      outsideFile,
      `${projectDir}/../project-other/private.png`,
      link,
    ]) {
      const response = await routes.request(
        `/?path=${encodeURIComponent(filePath)}`,
      );
      expect(response.status).toBe(403);
    }
  });

  it("resolves symlinked project roots and allows links within a project", async () => {
    const projectDir = path.join(tempDir, "project");
    await mkdir(projectDir);
    await writeFile(path.join(projectDir, "cover.png"), "png-bytes");
    await symlink(
      path.join(projectDir, "cover.png"),
      path.join(projectDir, "alias.png"),
    );
    const projectLink = path.join(tempDir, "project-link");
    await symlink(projectDir, projectLink);

    const routes = createLocalImageRoutes({
      allowedPaths: [],
      scanner: { listProjects: async () => [projectAt(projectLink)] },
    });
    const response = await routes.request(
      `/?path=${encodeURIComponent(path.join(projectLink, "alias.png"))}`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("png-bytes");
  });

  it("does not use remote or invalid project roots to authorize local files", async () => {
    const filePath = path.join(tempDir, "private.png");
    await writeFile(filePath, "private-bytes");
    const routes = createLocalImageRoutes({
      allowedPaths: [],
      scanner: {
        listProjects: async () => [
          projectAt(tempDir, true),
          projectAt(""),
          projectAt("/"),
          projectAt(path.join(tempDir, "missing")),
        ],
      },
    });
    expect(
      (await routes.request(`/?path=${encodeURIComponent(filePath)}`)).status,
    ).toBe(403);
  });

  it("serves explicitly allowed files without scanning projects", async () => {
    const filePath = path.join(tempDir, "cover.png");
    await writeFile(filePath, "png-bytes");
    const listProjects = vi.fn<() => Promise<Project[]>>();
    const routes = createLocalImageRoutes({
      allowedPaths: [tempDir],
      scanner: { listProjects },
    });
    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("png-bytes");
    expect(listProjects).not.toHaveBeenCalled();
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
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("png-bytes");
  });

  it("serves extensionless blobs by sniffing the image signature", async () => {
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
