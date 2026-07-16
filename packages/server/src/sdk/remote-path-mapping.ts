import path, { posix, win32 } from "node:path";
import type { RemoteExecutorConfig } from "@yep-anywhere/shared";

type LocalPathApi = typeof path.posix | typeof path.win32;

function isWindowsStyleAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function localPathApi(...values: string[]): LocalPathApi {
  return values.some(isWindowsStyleAbsolute) ? win32 : path;
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes("..");
}

function assertSafeAbsolutePath(
  value: string,
  api: LocalPathApi | typeof posix,
  side: "local" | "remote",
): void {
  if (
    !api.isAbsolute(value) ||
    value.includes("\0") ||
    hasParentSegment(value)
  ) {
    throw new Error(
      `${side} path must be absolute and cannot contain '..': ${value}`,
    );
  }
}

function isOutside(
  relativePath: string,
  api: LocalPathApi | typeof posix,
): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${api.sep}`) ||
    api.isAbsolute(relativePath)
  );
}

/** Map a host path below localRoot into the remote POSIX mount. */
export function mapLocalPathToRemote(
  localPath: string,
  executor: Pick<RemoteExecutorConfig, "localRoot" | "remoteRoot">,
): string {
  const api = localPathApi(executor.localRoot, localPath);
  assertSafeAbsolutePath(executor.localRoot, api, "local");
  assertSafeAbsolutePath(localPath, api, "local");
  assertSafeAbsolutePath(executor.remoteRoot, posix, "remote");

  const localRoot = api.resolve(executor.localRoot);
  const resolvedPath = api.resolve(localPath);
  const relativePath = api.relative(localRoot, resolvedPath);
  if (isOutside(relativePath, api)) {
    throw new Error(
      `Project path is outside the configured shared root: ${resolvedPath} (root: ${localRoot})`,
    );
  }

  const components = relativePath ? relativePath.split(api.sep) : [];
  return components.length > 0
    ? posix.join(posix.resolve(executor.remoteRoot), ...components)
    : posix.resolve(executor.remoteRoot);
}

/** Map a remote POSIX path below remoteRoot into the host shared root. */
export function mapRemotePathToLocal(
  remotePath: string,
  executor: Pick<RemoteExecutorConfig, "localRoot" | "remoteRoot">,
): string {
  const api = localPathApi(executor.localRoot);
  assertSafeAbsolutePath(executor.localRoot, api, "local");
  assertSafeAbsolutePath(executor.remoteRoot, posix, "remote");
  assertSafeAbsolutePath(remotePath, posix, "remote");

  const remoteRoot = posix.resolve(executor.remoteRoot);
  const resolvedPath = posix.resolve(remotePath);
  const relativePath = posix.relative(remoteRoot, resolvedPath);
  if (isOutside(relativePath, posix)) {
    throw new Error(
      `Remote path is outside the configured shared root: ${resolvedPath} (root: ${remoteRoot})`,
    );
  }

  const components = relativePath ? relativePath.split(posix.sep) : [];
  return components.length > 0
    ? api.join(api.resolve(executor.localRoot), ...components)
    : api.resolve(executor.localRoot);
}

export function tryMapLocalPathToRemote(
  localPath: string,
  executor: Pick<RemoteExecutorConfig, "localRoot" | "remoteRoot">,
): string | null {
  try {
    return mapLocalPathToRemote(localPath, executor);
  } catch {
    return null;
  }
}

export function tryMapRemotePathToLocal(
  remotePath: string,
  executor: Pick<RemoteExecutorConfig, "localRoot" | "remoteRoot">,
): string | null {
  try {
    return mapRemotePathToLocal(remotePath, executor);
  } catch {
    return null;
  }
}

/** True when candidate is root itself or a component-boundary descendant. */
export function isLocalPathWithin(candidate: string, root: string): boolean {
  const api = localPathApi(candidate, root);
  if (!api.isAbsolute(candidate) || !api.isAbsolute(root)) return false;
  const relativePath = api.relative(api.resolve(root), api.resolve(candidate));
  return !isOutside(relativePath, api);
}

/** True when candidate is root itself or a POSIX component-boundary descendant. */
export function isRemotePathWithin(candidate: string, root: string): boolean {
  if (!posix.isAbsolute(candidate) || !posix.isAbsolute(root)) return false;
  const relativePath = posix.relative(
    posix.resolve(root),
    posix.resolve(candidate),
  );
  return !isOutside(relativePath, posix);
}
