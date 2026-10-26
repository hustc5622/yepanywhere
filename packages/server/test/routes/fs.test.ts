import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsRoutes } from "../../src/routes/fs.js";
import { type Project, encodeProjectId } from "../../src/supervisor/types.js";

describe("Unified fs preview routes", () => {
  let tempDir: string;
  let projectDir: string;
  let outsideDir: string;
  let projectId: string;
  let routes: ReturnType<typeof createFsRoutes>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-fs-"));
    projectDir = path.join(tempDir, "project");
    outsideDir = path.join(tempDir, "outside");
    await mkdir(path.join(projectDir, "src"), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    projectId = encodeProjectId(projectDir);
    const project = {
      id: projectId,
      name: "project",
      path: projectDir,
      isRemoteProject: false,
    } as unknown as Project;
    const otherProject = {
      id: encodeProjectId(outsideDir),
      name: "outside",
      path: outsideDir,
      isRemoteProject: false,
    } as unknown as Project;
    const remoteProject = {
      id: encodeProjectId("/remote/box"),
      name: "box",
      path: tempDir,
      isRemoteProject: true,
    } as unknown as Project;
    routes = createFsRoutes({
      scanner: {
        getProject: async (id: string) => (id === projectId ? project : null),
        listProjects: async () => [project, otherProject, remoteProject],
      },
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function preview(query: Record<string, string>) {
    return routes.request(`/preview?${new URLSearchParams(query)}`);
  }

  function raw(query: Record<string, string>, headers?: HeadersInit) {
    return routes.request(`/raw?${new URLSearchParams(query)}`, { headers });
  }

  it("previews absolute files outside any project with highlighting", async () => {
    const filePath = path.join(outsideDir, "main.ts");
    await writeFile(filePath, "const answer = 42;\n");

    const res = await preview({ path: filePath, highlight: "true" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      kind: "text",
      metadata: {
        path: filePath,
        absolutePath: filePath,
        mimeType: "text/typescript",
        isText: true,
      },
      content: "const answer = 42;\n",
      rawUrl: `/api/fs/raw?path=${encodeURIComponent(filePath)}`,
    });
    expect(json.highlightedHtml).toContain("shiki");
  });

  it("resolves relative paths against the project and strips line suffixes", async () => {
    await writeFile(path.join(projectDir, "src", "notes.md"), "# Notes\n");

    const res = await preview({ path: "src/notes.md:3:2", projectId });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      kind: "markdown",
      metadata: { absolutePath: path.join(projectDir, "src", "notes.md") },
      lineNumber: 3,
      columnNumber: 2,
    });
    expect(json.renderedMarkdownHtml).toContain("<h1");
  });

  it("allows relative paths that leave the project root", async () => {
    await writeFile(path.join(outsideDir, "log.txt"), "hello");

    const res = await preview({ path: "../outside/log.txt", projectId });

    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe("hello");
  });

  it("returns metadata without content for binary kinds", async () => {
    for (const [name, kind] of [
      ["spec.pdf", "pdf"],
      ["plan.docx", "office"],
      ["shot.png", "image"],
    ] as const) {
      const filePath = path.join(outsideDir, name);
      await writeFile(filePath, "bytes");
      const json = await (await preview({ path: filePath })).json();
      expect(json.kind, name).toBe(kind);
      expect(json.content, name).toBeUndefined();
    }
  });

  it("reports missing files, directories and relative paths without context", async () => {
    expect(
      (await preview({ path: path.join(outsideDir, "missing.txt") })).status,
    ).toBe(404);
    expect((await preview({ path: outsideDir })).status).toBe(400);
    expect((await preview({ path: "src/a.ts" })).status).toBe(400);
    expect((await preview({ path: "a.ts", projectId: "nope" })).status).toBe(
      404,
    );
  });

  it("streams raw bytes with range support and download disposition", async () => {
    const filePath = path.join(outsideDir, "clip 1.mp4");
    await writeFile(filePath, "0123456789");

    const full = await raw({ path: filePath });
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(await full.text()).toBe("0123456789");

    const partial = await raw({ path: filePath }, { Range: "bytes=2-5" });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");

    const suffix = await raw({ path: filePath }, { Range: "bytes=-3" });
    expect(await suffix.text()).toBe("789");

    const bad = await raw({ path: filePath }, { Range: "bytes=20-" });
    expect(bad.status).toBe(416);

    const download = await raw({ path: filePath, download: "true" });
    expect(download.headers.get("content-disposition")).toMatch(
      /^attachment; filename="clip 1\.mp4"/,
    );
  });

  it("sandboxes active content served raw", async () => {
    const html = path.join(outsideDir, "page.html");
    const svg = path.join(outsideDir, "icon.svg");
    const pdf = path.join(outsideDir, "doc.pdf");
    await writeFile(html, "<script>alert(1)</script>");
    await writeFile(svg, "<svg/>");
    await writeFile(pdf, "%PDF");

    for (const filePath of [html, svg]) {
      const res = await raw({ path: filePath });
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // PDFs must stay viewable in the browser's built-in viewer.
    const res = await raw({ path: pdf });
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("locates a relative path across local projects on demand", async () => {
    await mkdir(path.join(outsideDir, "src"), { recursive: true });
    await writeFile(path.join(outsideDir, "src", "flow.ts"), "x");
    await mkdir(path.join(projectDir, "src", "dir.ts"));

    const located = await (
      await routes.request("/locate?path=src%2Fflow.ts%3A12")
    ).json();
    expect(located.candidates).toEqual([
      {
        projectId: encodeProjectId(outsideDir),
        projectName: "outside",
        projectPath: outsideDir,
        absolutePath: path.join(outsideDir, "src", "flow.ts"),
      },
    ]);

    // Directories and remote projects never match.
    const none = await (
      await routes.request("/locate?path=src%2Fdir.ts")
    ).json();
    expect(none.candidates).toEqual([]);

    for (const bad of ["", "%2Fabs%2Fa.ts", "..%2Fa.ts", "."]) {
      expect((await routes.request(`/locate?path=${bad}`)).status).toBe(400);
    }
  });
});
