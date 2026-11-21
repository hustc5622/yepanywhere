/**
 * Locate the provider file that physically backs one session.
 *
 * "Copy session info" is pasted into agents on other machines and into bug
 * reports, where a bare `projectId + sessionId` does not name a file anyone can
 * open. The client cannot derive the path either: every provider lays sessions
 * out differently (`~/.claude/projects/<hash>/<id>.jsonl`, Pi's
 * `<timestamp>_<id>.jsonl`, Codex's `rollout-*.jsonl`, MCode's `messages.jsonl`,
 * DSH's `session.v<N>.jsonl.zst`). Only the owning reader knows.
 *
 * Resolution is deliberately separated from the route so the transcript and
 * session-detail paths can reuse it.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { RemoteExecutorConfig } from "@yep-anywhere/shared";
import { getSessionFilePath } from "../projects/paths.js";
import { isLocalPathWithin } from "../sdk/remote-path-mapping.js";
import type { Project } from "../supervisor/types.js";
import type { ISessionReader } from "./types.js";

export interface SourceFileLocation {
  /** Absolute path as this machine sees it. */
  path: string;
  /**
   * Set when the session belongs to a remote executor. `path` is then the path
   * on the machine that actually holds the file, which for `ssh-replica`
   * storage is not readable from here.
   */
  remoteHost?: string;
}

/** True when `path` falls under a configured remote executor's local root. */
export function findOwningRemoteExecutor(
  path: string,
  executors: readonly RemoteExecutorConfig[] | undefined,
): RemoteExecutorConfig | undefined {
  if (!executors || executors.length === 0) return undefined;
  // Longest root first: nested executors must not be shadowed by their parent.
  return [...executors]
    .filter((executor) => isLocalPathWithin(path, executor.localRoot))
    .sort((a, b) => b.localRoot.length - a.localRoot.length)[0];
}

async function existingFile(path: string): Promise<string | null> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? path : null;
  } catch {
    return null;
  }
}

/**
 * Absolute path of the session file, or null when the provider cannot name it.
 *
 * The owning reader answers first because it is authoritative for its own
 * layout. The `<dir>/<sessionId>.jsonl` probe afterwards only covers Claude's
 * convention (including merged cross-machine session dirs) and stays behind a
 * `stat`, so a miss never fabricates a path that does not exist.
 */
export async function resolveSessionSourceFile(
  project: Project,
  reader: ISessionReader,
  sourceSessionDir: string | undefined,
  sessionId: string,
): Promise<string | null> {
  const direct = await reader.getSessionFilePath?.(sessionId);
  if (direct) return direct;

  const dirs = [
    sourceSessionDir,
    project.sessionDir,
    ...(project.mergedSessionDirs ?? []),
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const found = await existingFile(getSessionFilePath(dir, sessionId));
    if (found) return found;
  }

  return null;
}
