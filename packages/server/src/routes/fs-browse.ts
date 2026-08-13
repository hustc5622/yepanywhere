import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  isAbsolute as nodeIsAbsolute,
  posix,
  resolve,
  sep,
  win32,
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
 * The `path` query must be an absolute path on the server's OS. When omitted,
 * Windows returns a virtual list of mounted drive roots; other systems start
 * at the server user's home directory. Directory traversal is blocked by
 * rejecting any resolved path that escapes the requested root.
 */

export interface FsBrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FsBrowseResponse {
  /** The listed directory (or an empty string for the Windows drive list). */
  path: string;
  /** Parent directory, or null when already at the filesystem root. */
  parent: string | null;
  entries: FsBrowseEntry[];
  /** True when the server could not read the directory (permission/other). */
  error?: string;
}

export interface FsBrowseDeps {
  platform?: NodeJS.Platform;
  pathExists?: (path: string) => Promise<boolean>;
  readDirectoryNames?: (path: string) => Promise<string[]>;
}

/** Resolve the starting point for an empty/malformed request. */
function defaultBrowseRoot(): string {
  // Use the server process user's home directory as a friendly default.
  return homedir();
}

async function listWindowsDrives(
  pathExists: (path: string) => Promise<boolean>,
): Promise<FsBrowseEntry[]> {
  const entries: FsBrowseEntry[] = [];
  for (let code = 65; code <= 90; code++) {
    const path = `${String.fromCharCode(code)}:\\`;
    if (await pathExists(path)) {
      entries.push({ name: path, path, isDirectory: true });
    }
  }
  return entries;
}

async function listMacVolumes(
  pathExists: (path: string) => Promise<boolean>,
  readDirectoryNames: (path: string) => Promise<string[]>,
): Promise<FsBrowseEntry[]> {
  const entries: FsBrowseEntry[] = [
    { name: "/", path: "/", isDirectory: true },
  ];
  try {
    const names = await readDirectoryNames("/Volumes");
    for (const name of names) {
      const path = posix.join("/Volumes", name);
      if (await pathExists(path)) {
        entries.push({ name, path, isDirectory: true });
      }
    }
  } catch {
    // /Volumes can be unavailable without preventing access to the system disk.
  }
  return entries;
}

/**
 * Validate that `candidate` is an absolute path and, if `root` is provided,
 * that it does not escape root via ".." segments.
 */
function safeResolve(
  root: string | null,
  candidate: string,
  pathApi: {
    isAbsolute: (path: string) => boolean;
    resolve: (...paths: string[]) => string;
    sep: string;
  },
): string | null {
  if (!candidate || !pathApi.isAbsolute(candidate)) return null;
  const resolved = pathApi.resolve(candidate);
  if (root) {
    const normalizedRoot = pathApi.resolve(root);
    if (
      resolved !== normalizedRoot &&
      !resolved.startsWith(`${normalizedRoot}${pathApi.sep}`)
    ) {
      return null;
    }
  }
  return resolved;
}

export function createFsBrowseRoutes(deps: FsBrowseDeps = {}): Hono {
  const routes = new Hono();
  const platform = deps.platform ?? process.platform;
  const pathApi =
    platform === "darwin"
      ? { isAbsolute: posix.isAbsolute, resolve: posix.resolve, sep: posix.sep }
      : { isAbsolute: nodeIsAbsolute, resolve, sep };
  const pathExists =
    deps.pathExists ??
    (async (path: string) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    });
  const readDirectoryNames =
    deps.readDirectoryNames ??
    (async (path: string) => {
      const dirents = await readdir(path, { withFileTypes: true });
      return dirents
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);
    });

  routes.get("/browse", async (c) => {
    const requested = c.req.query("path");

    if (!requested && platform === "win32") {
      return c.json({
        path: "",
        parent: null,
        entries: await listWindowsDrives(pathExists),
      } satisfies FsBrowseResponse);
    }

    if (!requested && platform === "darwin") {
      return c.json({
        path: "",
        parent: null,
        entries: await listMacVolumes(pathExists, readDirectoryNames),
      } satisfies FsBrowseResponse);
    }

    const root =
      requested && pathApi.isAbsolute(requested)
        ? pathApi.resolve(requested)
        : null;
    const targetDir = root ?? defaultBrowseRoot();

    // Block traversal against the requested root if one was supplied.
    if (requested) {
      const safe = safeResolve(root, requested, pathApi);
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

    const parent = pathApi.resolve(targetDir, "..");
    const parentPath =
      platform === "win32" && win32.parse(targetDir).root === targetDir
        ? ""
        : platform === "darwin" &&
            (targetDir === "/" || posix.dirname(targetDir) === "/Volumes")
          ? ""
          : parent === targetDir
            ? null
            : parent; // at filesystem root, parent === self

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
