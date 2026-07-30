import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../projects/scanner.js";
import { type ProjectBrowseResponse, createFilesRoutes } from "./files.js";

describe("createFilesRoutes - /files/browse", () => {
  let tmp: string;
  let projectId: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "files-browse-"));
    await mkdir(join(tmp, "src"));
    await mkdir(join(tmp, "docs"));
    await writeFile(join(tmp, "README.md"), "# hi");
    await writeFile(join(tmp, "main.ts"), "console.log(1)");
    projectId = toUrlProjectId(tmp);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function makeApp() {
    const scanner = {
      getProject: async (id: string) =>
        id === projectId ? { path: tmp } : null,
    } as unknown as ProjectScanner;
    return createFilesRoutes({ scanner });
  }

  it("lists the root directory with directories before files, sorted", async () => {
    const app = makeApp();
    const res = await app.request(`/${projectId}/files/browse`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectBrowseResponse;
    expect(body.path).toBe("");
    expect(body.parent).toBeNull();

    const types = body.entries.map((e) => e.type);
    // All directories must come before any file.
    const lastDir = types.lastIndexOf("dir");
    const firstFile = types.indexOf("file");
    expect(firstFile).toBeGreaterThan(lastDir);

    const names = body.entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("docs");
    expect(names).toContain("README.md");
    expect(names).toContain("main.ts");

    const readme = body.entries.find((e) => e.name === "README.md");
    expect(readme?.type).toBe("file");
    expect(readme?.size).toBeGreaterThan(0);
    expect(readme?.isText).toBe(true);
  });

  it("navigates into a subdirectory and reports the parent", async () => {
    const app = makeApp();
    const res = await app.request(
      `/${projectId}/files/browse?path=${encodeURIComponent("src")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectBrowseResponse;
    expect(body.path).toBe("src");
    expect(body.parent).toBe("");
  });

  it("rejects path traversal outside the project", async () => {
    const app = makeApp();
    const res = await app.request(
      `/${projectId}/files/browse?path=${encodeURIComponent("../etc")}`,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown project", async () => {
    const app = makeApp();
    const unknown = toUrlProjectId("/nonexistent/path/xyz");
    const res = await app.request(`/${unknown}/files/browse`);
    expect(res.status).toBe(404);
  });

  it("returns 400 when the path is not a directory", async () => {
    const app = makeApp();
    const res = await app.request(
      `/${projectId}/files/browse?path=${encodeURIComponent("README.md")}`,
    );
    expect(res.status).toBe(400);
  });
});
