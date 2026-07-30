import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../projects/scanner.js";
import { createFilesRoutes } from "./files.js";

describe("createFilesRoutes - PUT /files", () => {
  let tmp: string;
  let projectId: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "files-write-"));
    await mkdir(join(tmp, "src"));
    await writeFile(join(tmp, "README.md"), "# original");
    await writeFile(join(tmp, "icon.png"), Buffer.from([0, 1, 2]));
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

  async function put(
    path: string,
    content: string,
    id = projectId,
  ): Promise<Response> {
    return makeApp().request(`/${id}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
  }

  it("overwrites an existing text file and the change persists", async () => {
    const res = await put("README.md", "# updated by test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe("README.md");

    const onDisk = await readFile(join(tmp, "README.md"), "utf-8");
    expect(onDisk).toBe("# updated by test");
  });

  it("creates a new text file inside a subdirectory", async () => {
    const res = await put("src/new.ts", "export const x = 1;");
    expect(res.status).toBe(200);
    const onDisk = await readFile(join(tmp, "src/new.ts"), "utf-8");
    expect(onDisk).toBe("export const x = 1;");
  });

  it("rejects a missing path", async () => {
    const res = await put("", "hello");
    expect(res.status).toBe(400);
  });

  it("rejects a missing content", async () => {
    const res = await makeApp().request(`/${projectId}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "README.md" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-text files", async () => {
    const res = await put("icon.png", "not an image");
    expect(res.status).toBe(415);
  });

  it("rejects path traversal outside the project", async () => {
    const res = await put("../escaped.txt", "nope");
    expect(res.status).toBe(400);
  });

  it("rejects an unknown project", async () => {
    const unknown = toUrlProjectId("/nonexistent/path/xyz");
    const res = await put("README.md", "hi", unknown);
    expect(res.status).toBe(404);
  });

  it("rejects oversized content", async () => {
    const huge = "a".repeat(2 * 1024 * 1024);
    const res = await put("big.txt", huge);
    expect(res.status).toBe(413);
  });
});
