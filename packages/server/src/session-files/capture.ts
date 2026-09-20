import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { SessionFileStore } from "./store.js";
import {
  type CapturePolicy,
  CapturePolicySchema,
  DEFAULT_CAPTURE_POLICY,
  type FileSnapshot,
  RelativePathSchema,
} from "./types.js";

const execute = promisify(execFile);
const gitOptions = {
  encoding: "utf8" as const,
  timeout: 15_000,
  maxBuffer: 8 * 1024 * 1024,
};

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return (
    value === "" ||
    (!isAbsolute(value) && value !== ".." && !value.startsWith("../"))
  );
}

function excluded(path: string, policy: CapturePolicy): boolean {
  return path
    .split("/")
    .some((part) => policy.excludedDirectories.includes(part));
}

/** Detect repositories without treating Git failures as permission to scan ignored files. */
async function isGitWorkspace(root: string): Promise<boolean> {
  let directory = root;
  while (true) {
    try {
      await lstat(join(directory, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

/**
 * Full bounded capture. Does not execute agent code, alter Git's index, or follow
 * symlinks. Callers must await the baseline BEFORE allowing execution to begin.
 * Each file is checked for concurrent writes; the tree is not an atomic snapshot.
 */
export async function captureWorkspace(
  store: SessionFileStore,
  workspace: string,
  overrides: Partial<CapturePolicy> = {},
): Promise<{ id: string; snapshot: FileSnapshot }> {
  const policy = CapturePolicySchema.parse({
    ...DEFAULT_CAPTURE_POLICY,
    ...overrides,
  });
  // Git metadata must never be collected, even with a custom exclusion policy.
  policy.excludedDirectories = [
    ...new Set([".git", ...policy.excludedDirectories]),
  ].sort();
  const root = await realpath(workspace);
  if (!(await lstat(root)).isDirectory())
    throw new Error("Workspace must be a directory");
  // Keep captured content out of its own source tree (including symlink aliases).
  let ancestor = store.directory;
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      const target = join(canonical, relative(ancestor, store.directory));
      if (within(root, target))
        throw new Error("Snapshot storage must be outside the workspace");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  const snapshot: FileSnapshot = {
    version: 1,
    workspace: root,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    enumeration: (await isGitWorkspace(root)) ? "git" : "directory",
    policy,
    listingComplete: true,
    files: [],
    omissions: [],
  };
  const paths = new Set<string>();
  let entries = 0;
  const omit = (
    path: string,
    reason: FileSnapshot["omissions"][number]["reason"],
  ) => {
    snapshot.omissions.push({ path, reason });
  };
  const accept = (path: string) => {
    if (!RelativePathSchema.safeParse(path).success) {
      snapshot.listingComplete = false;
      return false;
    }
    return !excluded(path, policy);
  };

  if (snapshot.enumeration === "git") {
    // No shell, no user Git index writes. Include tracked dirty and untracked files.
    const run = (args: string[]) =>
      execute(
        "git",
        ["-C", root, "ls-files", ...args, "-z", "--", "."],
        gitOptions,
      );
    const results = await Promise.all([
      run(["--cached", "--others", "--exclude-standard"]),
      run(["--others", "--ignored", "--exclude-standard", "--directory"]),
    ]);
    for (const [index, result] of results.entries()) {
      for (const raw of result.stdout.split("\0").filter(Boolean)) {
        if (++entries > policy.maxEntries) {
          snapshot.listingComplete = false;
          break;
        }
        const path = raw.replace(/\/$/, "");
        if (!accept(path)) continue;
        if (index === 1) omit(path, "ignored");
        else paths.add(path);
      }
    }
  } else {
    const walk = async (directory: string, prefix: string): Promise<void> => {
      // A directory can be replaced between enumeration and descent.
      if ((await realpath(directory)) !== directory) {
        if (prefix) omit(prefix, "symlink");
        else snapshot.listingComplete = false;
        return;
      }
      const dir = await opendir(directory);
      for await (const entry of dir) {
        if (++entries > policy.maxEntries) {
          snapshot.listingComplete = false;
          break;
        }
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!accept(path)) continue;
        if (entry.isSymbolicLink()) omit(path, "symlink");
        else if (entry.isDirectory()) {
          try {
            await walk(join(directory, entry.name), path);
          } catch {
            omit(path, "unreadable");
          }
        } else if (entry.isFile()) paths.add(path);
        else omit(path, "unsupported");
      }
    };
    await walk(root, "");
  }

  let totalBytes = 0;
  for (const path of [...paths].sort()) {
    const target = join(root, path);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let captured: Buffer | undefined;
    let executable = false;
    try {
      // Git can list a deleted tracked child under a directory replaced by a
      // symlink. Mark the subtree unknown instead of following it or inventing
      // deletions from missing files at the link's destination.
      let parent = root;
      let linkedParent = false;
      for (const part of path.split("/").slice(0, -1)) {
        parent = join(parent, part);
        try {
          if ((await lstat(parent)).isSymbolicLink()) {
            linkedParent = true;
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          throw error;
        }
      }
      if (linkedParent) {
        omit(path, "symlink");
        continue;
      }
      let info: Stats;
      try {
        info = await lstat(target);
      } catch (error) {
        // Git lists tracked files removed from the worktree; this is real absence.
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          snapshot.enumeration === "git"
        )
          continue;
        throw error;
      }
      if ((await realpath(dirname(target))) !== dirname(target)) {
        omit(path, "symlink");
        continue;
      }
      if (info.isSymbolicLink()) {
        omit(path, "symlink");
        continue;
      }
      if (!info.isFile()) {
        omit(path, "unsupported");
        continue;
      }
      if (info.size > policy.maxFileBytes) {
        omit(path, "too-large");
        continue;
      }
      if (totalBytes + info.size > policy.maxTotalBytes) {
        omit(path, "byte-budget");
        continue;
      }
      handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.ino !== info.ino ||
        before.dev !== info.dev
      ) {
        omit(path, "unstable");
        continue;
      }
      const buffer = Buffer.alloc(
        Math.min(before.size, policy.maxFileBytes) + 1,
      );
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      const current = await lstat(target);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        current.ino !== after.ino ||
        current.dev !== after.dev ||
        current.mtimeMs !== after.mtimeMs ||
        current.ctimeMs !== after.ctimeMs ||
        length !== after.size ||
        (await realpath(target)) !== target
      ) {
        omit(path, "unstable");
        continue;
      }
      if (length > policy.maxFileBytes) {
        omit(path, "too-large");
        continue;
      }
      if (totalBytes + length > policy.maxTotalBytes) {
        omit(path, "byte-budget");
        continue;
      }
      captured = buffer.subarray(0, length);
      executable = (after.mode & 0o111) !== 0;
    } catch {
      omit(path, "unreadable");
    } finally {
      await handle?.close();
    }
    if (captured) {
      // Storage failures must fail capture, never masquerade as source-file omissions.
      const blob = await store.putBlob(captured);
      snapshot.files.push({ path, blob, bytes: captured.length, executable });
      totalBytes += captured.length;
    }
  }
  snapshot.omissions.sort((a, b) => a.path.localeCompare(b.path));
  snapshot.finishedAt = new Date().toISOString();
  const id = await store.putSnapshot(snapshot);
  return { id, snapshot };
}
