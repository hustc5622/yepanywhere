import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  isAbsolute as nodeIsAbsolute,
  resolve,
  sep,
} from "node:path";
import { Hono } from "hono";

/**
 * Server-side filesystem browser.
 *
 * Unlike a client-native folder picker (e.g. Tauri dialog), this browses the
 * filesystem of the **machine running the Yep Anywhere server** — which is
 * exactly what users want when they open the web UI from a phone, tablet, or
 * any remote browser: the selected directory becomes the agent's working
 * directory on the *server* device, not on the client device.
 *
 * Endpoint:
 *   GET /api/filesystem/browse?path=<absolute dir>
 *
 * The `path` query must be an absolute path on the server's OS. When omitted
 * (or invalid), it falls back to the server user's home directory so the
 * picker always has a sane starting point. Directory traversal is blocked by
 * rejecting any resolved path that escapes the requested root.
 */

export interface FsBrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FsBrowseResponse {
  /** The directory actually listed (absolute, server OS format). */
  path: string;
  /** Parent directory, or null when already at the filesystem root. */
  parent: string | null;
  entries: FsBrowseEntry[];
  /** True when the server could not read the directory (permission/other). */
  error?: string;
}

/** Resolve the starting point for an empty/malformed request. */
function defaultBrowseRoot(): string {
  // Use the server process user's home directory as a friendly default.
  return homedir();
}

/**
 * Validate that `candidate` is an absolute path and, if `root` is provided,
 * that it does not escape root via ".." segments.
 */
function safeResolve(root: string | null, candidate: string): string | null {
  if (!candidate || !nodeIsAbsolute(candidate)) return null;
  const resolved = resolve(candidate);
  if (root) {
    const normalizedRoot = resolve(root);
    if (
      resolved !== normalizedRoot &&
      !resolved.startsWith(`${normalizedRoot}${sep}`)
    ) {
      return null;
    }
  }
  return resolved;
}

export function createFsBrowseRoutes(): Hono {
  const routes = new Hono();

  routes.get("/browse", async (c) => {
    const requested = c.req.query("path");

    const root =
      requested && nodeIsAbsolute(requested) ? resolve(requested) : null;
    const targetDir = root ?? defaultBrowseRoot();

    // Block traversal against the requested root if one was supplied.
    if (requested) {
      const safe = safeResolve(root, requested);
      if (!safe) {
        return c.json(
          {
            path: targetDir,
            parent: null,
            entries: [],
            error: "Invalid path: must be absolute and within allowed scope",
          } satisfies FsBrowseResponse,
          400,
        );
      }
    }

    const parent = resolve(targetDir, "..");
    const parentPath = parent === targetDir ? null : parent; // at filesystem root, parent === self

    const entries: FsBrowseEntry[] = [];
    try {
      const dirents = await readdir(targetDir, { withFileTypes: true });
      for (const dirent of dirents) {
        // Only directories are selectable as a project working directory.
        if (!dirent.isDirectory()) continue;
        const entryPath = resolve(targetDir, dirent.name);
        entries.push({
          name: dirent.name,
          path: entryPath,
          isDirectory: true,
        });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to read directory";
      const response: FsBrowseResponse = {
        path: targetDir,
        parent: parentPath,
        entries: [],
        error: message,
      };
      return c.json(response, 200);
    }

    // Sort: directories by name, case-insensitive.
    entries.sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );

    const response: FsBrowseResponse = {
      path: targetDir,
      parent: parentPath,
      entries,
    };
    return c.json(response, 200);
  });

  return routes;
}

/** Human-readable name for the root fallback (used by tests / logging). */
export const FS_BROWSE_HOME = basename(homedir());
