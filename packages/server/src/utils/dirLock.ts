import * as fs from "node:fs/promises";

export interface DirLockOptions {
  timeoutMs: number;
  /** A lock directory older than this is assumed abandoned by a crash. */
  staleMs: number;
  /** Named in the timeout error. */
  label: string;
  retryMs?: number;
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const stats = await fs.stat(lockPath);
    return Date.now() - stats.mtimeMs > staleMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Run `callback` holding an exclusive `mkdir` lock.
 *
 * The deadline is checked on every attempt, and a stale lock that cannot be
 * removed (permissions, read-only volume) waits like a held one: otherwise
 * mkdir, stale check and failed rm would retry back to back forever.
 */
export async function withDirLock<T>(
  lockPath: string,
  options: DirLockOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const retryMs = options.retryMs ?? 25;
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (Date.now() - start >= options.timeoutMs) {
      throw new Error(`Timed out acquiring ${options.label}: ${lockPath}`);
    }
    if (await isStale(lockPath, options.staleMs)) {
      const removed = await fs
        .rm(lockPath, { recursive: true, force: true })
        .then(
          () => true,
          () => false,
        );
      if (removed) continue;
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  try {
    return await callback();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
