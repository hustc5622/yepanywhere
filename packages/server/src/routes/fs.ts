import { stat } from "node:fs/promises";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import {
  type FileLocateCandidate,
  isUrlProjectId,
  parseLineColumn,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  FilePreviewError,
  buildFilePreview,
  openPreviewFile,
  rawFileResponse,
  resolvePreviewPath,
} from "../file-preview/index.js";
import type { ProjectScanner } from "../projects/scanner.js";

export interface FsRoutesDeps {
  scanner: Pick<ProjectScanner, "getProject" | "listProjects">;
}

function fsRawUrl(absolutePath: string): string {
  return `/api/fs/raw?path=${encodeURIComponent(absolutePath)}`;
}

function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof FilePreviewError) {
    return c.json(error.toJSON(), error.status);
  }
  console.error("[FsPreview] Unexpected error:", error);
  return c.json({ error: "Internal error" }, 500);
}

/**
 * Unified file preview API.
 *
 * - `GET /api/fs/preview?path=&projectId=&highlight=true` → metadata, kind,
 *   inline text (≤ 1 MB), optional highlighting and markdown HTML.
 * - `GET /api/fs/raw?path=&projectId=&download=true` → bytes, with `Range`.
 *
 * `path` may be absolute or, with `projectId`, relative to the project root,
 * and may carry a `:line[:column]` suffix. Any path the server can read is
 * allowed; the API authentication middleware is the only gate.
 */
export function createFsRoutes(deps: FsRoutesDeps): Hono {
  const routes = new Hono();

  async function resolveRequest(c: Context) {
    const rawPath = c.req.query("path") ?? "";
    const projectId = c.req.query("projectId");
    let baseDir: string | undefined;
    if (projectId) {
      if (!isUrlProjectId(projectId)) {
        throw new FilePreviewError(400, "Invalid project ID format");
      }
      const project = await deps.scanner.getProject(projectId);
      if (!project) throw new FilePreviewError(404, "Project not found");
      if (!project.isRemoteProject) baseDir = project.path;
    }
    const resolved = await resolvePreviewPath(rawPath, baseDir);
    const file = await openPreviewFile(resolved.absolutePath, rawPath);
    return { resolved, file };
  }

  routes.get("/preview", async (c) => {
    try {
      const { resolved, file } = await resolveRequest(c);
      const preview = await buildFilePreview(file, {
        displayPath: resolved.absolutePath,
        rawUrl: fsRawUrl(resolved.absolutePath),
        highlight: c.req.query("highlight") === "true",
        renderMarkdown: true,
      });
      return c.json({
        ...preview,
        ...(resolved.line !== undefined && { lineNumber: resolved.line }),
        ...(resolved.column !== undefined && {
          columnNumber: resolved.column,
        }),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get("/raw", async (c) => {
    try {
      const { file } = await resolveRequest(c);
      return rawFileResponse(file, {
        download: c.req.query("download") === "true",
        cacheControl: "private, no-store",
        range: c.req.header("range"),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  /**
   * GET /api/fs/locate?path=<relative path>
   * Local projects whose root contains this relative path as a regular file.
   * Used on demand when a relative path from a transcript is not found in the
   * session's own project (e.g. a reply that cites another project's files).
   */
  routes.get("/locate", async (c) => {
    const rawPath = (c.req.query("path") ?? "").trim();
    const relative = normalize(parseLineColumn(rawPath).path);
    if (
      !rawPath ||
      isAbsolute(relative) ||
      relative === "." ||
      relative.startsWith(`..${sep}`) ||
      relative === ".."
    ) {
      return c.json({ error: "path must be a relative file path" }, 400);
    }

    const projects = (await deps.scanner.listProjects()).filter(
      (project) => !project.isRemoteProject && isAbsolute(project.path),
    );
    const seen = new Set<string>();
    const found = await Promise.all(
      projects.map(async (project): Promise<FileLocateCandidate | null> => {
        const absolutePath = resolve(project.path, relative);
        if (seen.has(absolutePath)) return null;
        seen.add(absolutePath);
        try {
          if (!(await stat(absolutePath)).isFile()) return null;
        } catch {
          return null;
        }
        return {
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          absolutePath,
        };
      }),
    );
    return c.json({
      candidates: found.filter(
        (candidate): candidate is FileLocateCandidate => candidate !== null,
      ),
    });
  });

  return routes;
}
