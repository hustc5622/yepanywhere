import type { ChildProcess } from "node:child_process";

/**
 * Spawn option for agent children that must be terminable as a tree: the
 * child leads its own process group, so helpers it forks (Cursor's
 * worker-server, Codex command runners) receive the same signals instead of
 * being orphaned when only the direct child is signalled.
 */
export const OWN_PROCESS_GROUP = process.platform !== "win32";

/**
 * SIGTERM the child's process group (or the child alone on Windows), then
 * SIGKILL it if the child has not exited within `graceMs`. Resolves on exit.
 */
export async function terminateProcessTree(
  child: ChildProcess | null | undefined,
  graceMs: number,
): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  const killTarget =
    OWN_PROCESS_GROUP && child.pid > 0 ? -child.pid : child.pid;

  try {
    process.kill(killTarget, "SIGTERM");
  } catch {
    // Not a group leader (spawned without its own group): signal it alone.
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }

  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(killTarget, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, graceMs);
  timer.unref?.();

  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
