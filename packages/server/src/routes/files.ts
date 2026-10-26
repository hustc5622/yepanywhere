import { normalize, resolve, sep } from "node:path";
import { type PatchHunk, isUrlProjectId } from "@yep-anywhere/shared";
import { type Context, Hono } from "hono";
import { computeEditAugment } from "../augments/edit-augments.js";
import {
  FilePreviewError,
  type PreviewFile,
  buildFilePreview,
  openPreviewFile,
  rawFileResponse,
} from "../file-preview/index.js";
import type { ProjectScanner } from "../projects/scanner.js";

export interface FilesDeps {
  scanner: ProjectScanner;
}

/**
 * Validate and resolve file path, preventing directory traversal.
 * Returns null if the path is invalid or escapes the project root.
 */
function resolveFilePath(
  projectRoot: string,
  relativePath: string,
): string | null {
  // Normalize the path to handle . and ..
  const normalized = normalize(relativePath);

  // Reject absolute paths
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return null;
  }

  // Reject paths that try to escape (after normalization, should not start with ..)
  if (normalized.startsWith("..")) {
    return null;
  }

  // Resolve to absolute path
  const resolved = resolve(projectRoot, normalized);

  // Verify the resolved path is still within project root
  const normalizedRoot = resolve(projectRoot);
  if (
    !resolved.startsWith(`${normalizedRoot}${sep}`) &&
    resolved !== normalizedRoot
  ) {
    return null;
  }

  return resolved;
}

export function createFilesRoutes(deps: FilesDeps): Hono {
  const routes = new Hono();

  /** Resolve `:projectId` + `?path=` to a regular file inside the project. */
  async function openProjectFile(
    c: Context,
  ): Promise<{ relativePath: string; file: PreviewFile } | Response> {
    const projectId = c.req.param("projectId") ?? "";
    const relativePath = c.req.query("path");
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }
    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const filePath = resolveFilePath(project.path, relativePath);
    if (!filePath) {
      return c.json({ error: "Invalid file path" }, 400);
    }
    try {
      return {
        relativePath,
        file: await openPreviewFile(filePath, relativePath),
      };
    } catch (error) {
      if (error instanceof FilePreviewError) {
        return c.json(error.toJSON(), error.status);
      }
      throw error;
    }
  }

  /**
   * GET /api/projects/:projectId/files
   * Project-relative wrapper over the shared preview core (`/api/fs/preview`).
   * Query params:
   *   - path: relative path to file (required)
   *   - highlight: if "true", include syntax-highlighted HTML and markdown preview
   */
  routes.get("/:projectId/files", async (c) => {
    const opened = await openProjectFile(c);
    if (opened instanceof Response) return opened;
    const { relativePath, file } = opened;
    const projectId = c.req.param("projectId");
    const preview = await buildFilePreview(file, {
      displayPath: relativePath,
      rawUrl: `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(relativePath)}`,
      highlight: c.req.query("highlight") === "true",
    });
    return c.json(preview);
  });

  /**
   * GET /api/projects/:projectId/files/raw
   * Raw file bytes (with Range support).
   * Query params:
   *   - path: relative path to file (required)
   *   - download: if "true", set Content-Disposition to attachment
   */
  routes.get("/:projectId/files/raw", async (c) => {
    const opened = await openProjectFile(c);
    if (opened instanceof Response) return opened;
    return rawFileResponse(opened.file, {
      download: c.req.query("download") === "true",
      range: c.req.header("range"),
    });
  });

  /**
   * POST /api/projects/:projectId/diff/expand
   * Compute an expanded diff with full file context.
   *
   * Uses originalFile from the SDK's Edit tool result directly - the SDK never
   * truncates this field (verified up to 150KB+ files).
   *
   * Body:
   *   - filePath: path to file (for syntax highlighting detection)
   *   - oldString: the original text being replaced
   *   - newString: the new text to insert
   *   - originalFile: complete file content from SDK Edit result
   */
  routes.post("/:projectId/diff/expand", async (c) => {
    // Parse body
    let body: {
      filePath: string;
      oldString: string;
      newString: string;
      originalFile: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { filePath, oldString, newString, originalFile } = body;

    if (
      !filePath ||
      typeof oldString !== "string" ||
      typeof newString !== "string" ||
      typeof originalFile !== "string"
    ) {
      return c.json(
        {
          error:
            "Missing required fields: filePath, oldString, newString, originalFile",
        },
        400,
      );
    }

    // Compute the new file content by applying the edit
    const newFullContent = originalFile.replace(oldString, newString);

    // Compute augment with large context (entire file)
    const augment = await computeEditAugment(
      "expand",
      {
        file_path: filePath,
        old_string: originalFile,
        new_string: newFullContent,
      },
      999999, // Full file context
    );

    return c.json({
      structuredPatch: augment.structuredPatch as PatchHunk[],
      diffHtml: augment.diffHtml,
    });
  });

  return routes;
}
