import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalFileRoutes } from "../../src/routes/local-file.js";

describe("Local file routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-local-file-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves markdown files by default and preserves line metadata", async () => {
    const codexDir = path.join(tempDir, ".codex");
    await mkdir(codexDir, { recursive: true });
    const filePath = path.join(codexDir, "AGENTS.md");
    await writeFile(filePath, "# Agent Rules\n\nUse rg first.");

    const routes = createLocalFileRoutes();

    const response = await routes.request(
      `/?path=${encodeURIComponent(`${filePath}:3`)}`,
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      metadata: {
        path: filePath,
        mimeType: "text/markdown",
        isText: true,
      },
      content: "# Agent Rules\n\nUse rg first.",
      lineNumber: 3,
    });
    expect(json.renderedMarkdownHtml).toContain("<h1>Agent Rules</h1>");
  });

  it("reads documents across directories without project or session metadata", async () => {
    const routes = createLocalFileRoutes();
    for (const directory of ["project-a/docs", "project-b/docs", "reports"]) {
      const docDir = path.join(tempDir, directory);
      await mkdir(docDir, { recursive: true });
      const filePath = path.join(docDir, "summary.md");
      await writeFile(filePath, `# ${directory}`);

      const response = await routes.request(
        `/?path=${encodeURIComponent(filePath)}`,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        content: `# ${directory}`,
      });
    }
  });

  it("reads a document through a symlink to another directory", async () => {
    const docsDir = path.join(tempDir, "docs");
    await mkdir(docsDir);
    const filePath = path.join(docsDir, "summary.md");
    await writeFile(filePath, "# Linked document");
    const linkPath = path.join(tempDir, "summary.md");
    await symlink(filePath, linkPath);

    const response = await createLocalFileRoutes().request(
      `/?path=${encodeURIComponent(linkPath)}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: "# Linked document",
    });
  });

  it("rejects unsupported local file extensions", async () => {
    const allowedDir = path.join(tempDir, ".codex");
    await mkdir(allowedDir, { recursive: true });
    const filePath = path.join(allowedDir, "auth.json");
    await writeFile(filePath, "{}");

    const routes = createLocalFileRoutes();

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Not a supported local text file type",
    });
  });
});
