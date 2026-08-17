import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodexSessionMetaEntry,
  parseCodexSessionEntry,
} from "@yep-anywhere/shared";
import { getCodexSubagentMetadata } from "../codex/subagent.js";
import { getLogger } from "../logging/logger.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import {
  CODEX_ROLLOUT_COMPRESSED_SUFFIX,
  isCodexRolloutDecompressionSupported,
  isCompressedCodexRolloutPath,
  plainCodexRolloutPath,
  readCodexRolloutFirstLine,
} from "./codex-rollout-file.js";

export interface CodexSessionManifestEntry {
  id: string;
  cwd: string;
  /**
   * Path to the rollout on disk.
   *
   * This may be either a plain `.jsonl` file or Codex's compressed
   * `.jsonl.zst`, so it is NOT safe to treat as text. Decode it only through
   * `codex-rollout-file.ts` (or `readSharedCodexEntries`, which builds on it);
   * `readFile(path, "utf-8")` does not fail on compressed bytes, it silently
   * returns mojibake. Stat-ing, moving and copying the path are byte-level and
   * remain safe for both forms.
   */
  filePath: string;
  /** True when `filePath` holds compressed bytes rather than JSONL text. */
  compressed: boolean;
  timestamp: string;
  mtime: number;
  size: number;
  isSubagent: boolean;
  /** Parent thread id, when this session is a sub-agent. */
  parentThreadId?: string;
  /** Agent path (e.g. "/root/task_name"), when available. */
  agentPath?: string;
  /** Randomly assigned nickname (e.g. "Einstein"), when available. */
  agentNickname?: string;
  /** Agent role (e.g. "explorer", "worker", "default"), when available. */
  agentRole?: string;
  /** Spawn depth from the root thread, when available. */
  depth?: number;
}

export interface CodexSessionManifest {
  sessions: CodexSessionManifestEntry[];
  byId: Map<string, CodexSessionManifestEntry>;
  byProjectPath: Map<string, CodexSessionManifestEntry[]>;
  /** Sub-agent sessions keyed by parent thread id. */
  byParentThread: Map<string, CodexSessionManifestEntry[]>;
}

const CODEX_META_READ_MAX_BYTES = 1024 * 1024;
const CODEX_SESSION_MANIFEST_TTL_MS = 5_000;
const MANIFEST_SCAN_BATCH_SIZE = 50;

interface CodexSessionManifestCacheEntry {
  manifest?: CodexSessionManifest;
  timestamp: number;
  inFlight?: Promise<CodexSessionManifest>;
}

const manifestCache = new Map<string, CodexSessionManifestCacheEntry>();

export async function getCodexSessionManifest(
  sessionsDir: string,
): Promise<CodexSessionManifest> {
  const now = Date.now();
  const cached = manifestCache.get(sessionsDir);

  if (
    cached?.manifest &&
    now - cached.timestamp < CODEX_SESSION_MANIFEST_TTL_MS
  ) {
    return cached.manifest;
  }

  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const promise = buildCodexSessionManifest(sessionsDir)
    .then((manifest) => {
      manifestCache.set(sessionsDir, {
        manifest,
        timestamp: Date.now(),
      });
      return manifest;
    })
    .catch((error) => {
      const latest = manifestCache.get(sessionsDir);
      if (latest?.inFlight === promise) {
        if (latest.manifest) {
          manifestCache.set(sessionsDir, {
            manifest: latest.manifest,
            timestamp: latest.timestamp,
          });
        } else {
          manifestCache.delete(sessionsDir);
        }
      }
      throw error;
    });

  manifestCache.set(sessionsDir, {
    manifest: cached?.manifest,
    timestamp: cached?.timestamp ?? 0,
    inFlight: promise,
  });

  return promise;
}

export function invalidateCodexSessionManifest(sessionsDir: string): void {
  manifestCache.delete(sessionsDir);
}

async function buildCodexSessionManifest(
  sessionsDir: string,
): Promise<CodexSessionManifest> {
  try {
    await stat(sessionsDir);
  } catch {
    return createManifest([]);
  }

  const files = await findRolloutFiles(sessionsDir);
  getLogger().debug(
    `[CodexManifest] Found ${files.length} rollout files in ${sessionsDir}`,
  );

  const sessions: CodexSessionManifestEntry[] = [];
  let failCount = 0;

  for (let i = 0; i < files.length; i += MANIFEST_SCAN_BATCH_SIZE) {
    const batch = files.slice(i, i + MANIFEST_SCAN_BATCH_SIZE);
    const results = await Promise.all(batch.map(readSessionManifestEntry));
    for (const result of results) {
      if (result) {
        sessions.push(result);
      } else {
        failCount++;
      }
    }
  }

  if (files.length > 0 && sessions.length === 0) {
    getLogger().warn(
      `[CodexManifest] Found ${files.length} rollout files but parsed 0 sessions (${failCount} failed). First file: ${files[0]}`,
    );
  } else if (failCount > 0) {
    getLogger().debug(
      `[CodexManifest] Parsed ${sessions.length} sessions, ${failCount} files skipped`,
    );
  }

  return createManifest(sessions);
}

function createManifest(
  entries: CodexSessionManifestEntry[],
): CodexSessionManifest {
  const sessions = [...entries].sort((a, b) => b.mtime - a.mtime);
  const byId = new Map<string, CodexSessionManifestEntry>();
  const byProjectPath = new Map<string, CodexSessionManifestEntry[]>();
  const byParentThread = new Map<string, CodexSessionManifestEntry[]>();

  for (const session of sessions) {
    const isNewestForId = !byId.has(session.id);
    if (isNewestForId) {
      byId.set(session.id, session);
    }

    const projectPath = canonicalizeProjectPath(session.cwd);
    const projectSessions = byProjectPath.get(projectPath);
    if (projectSessions) {
      projectSessions.push(session);
    } else {
      byProjectPath.set(projectPath, [session]);
    }

    if (isNewestForId && session.parentThreadId) {
      const siblings = byParentThread.get(session.parentThreadId);
      if (siblings) {
        siblings.push(session);
      } else {
        byParentThread.set(session.parentThreadId, [session]);
      }
    }
  }

  return {
    sessions,
    byId,
    byProjectPath,
    byParentThread,
  };
}

/**
 * Collect rollout files, accepting both plain `.jsonl` and Codex's compressed
 * `.jsonl.zst` form.
 *
 * During a resume Codex materializes a compressed rollout back to plain without
 * immediately removing the `.zst`, so both can exist for the same session. The
 * plain file is the live copy in that window, so it wins and the compressed
 * sibling is dropped rather than scanned into a duplicate manifest entry.
 *
 * On a runtime without zstd support (Node < 22.15.0, still within this package's
 * supported range) compressed rollouts are skipped entirely: surfacing a session
 * whose every read is guaranteed to fail is worse than leaving it hidden, which
 * is what those runtimes did before compressed rollouts were understood at all.
 */
async function findRolloutFiles(dir: string): Promise<string[]> {
  const canReadCompressed = isCodexRolloutDecompressionSupported();
  const plain = new Set<string>();
  const compressed: string[] = [];

  const walk = async (current: string): Promise<void> => {
    try {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (!entry.isFile()) {
          // Symlinks and special files are not rollouts.
        } else if (entry.name.endsWith(".jsonl")) {
          plain.add(fullPath);
        } else if (
          canReadCompressed &&
          entry.name.endsWith(`.jsonl${CODEX_ROLLOUT_COMPRESSED_SUFFIX}`)
        ) {
          compressed.push(fullPath);
        }
      }
    } catch (error) {
      getLogger().debug(
        `[CodexManifest] Error scanning directory ${current}: ${error instanceof Error ? error.message : error}`,
      );
    }
  };

  await walk(dir);

  return [
    ...plain,
    ...compressed.filter((path) => !plain.has(plainCodexRolloutPath(path))),
  ];
}

async function readSessionManifestEntry(
  filePath: string,
): Promise<CodexSessionManifestEntry | null> {
  try {
    const [stats, firstLine] = await Promise.all([
      stat(filePath),
      readCodexRolloutFirstLine(filePath, CODEX_META_READ_MAX_BYTES),
    ]);

    if (!firstLine) {
      getLogger().debug(
        `[CodexManifest] Empty file or first line: ${filePath}`,
      );
      return null;
    }

    const entry = parseCodexSessionEntry(firstLine);
    if (!entry || entry.type !== "session_meta") {
      getLogger().debug(
        `[CodexManifest] Unexpected first line type=${entry?.type ?? "unknown"}: ${filePath}`,
      );
      return null;
    }

    const meta = entry.payload;
    if (!meta.id || !meta.cwd) {
      getLogger().debug(
        `[CodexManifest] session_meta missing id or cwd: ${filePath}`,
      );
      return null;
    }

    const subagentMeta = getCodexSubagentMetadata(meta);
    return {
      id: meta.id,
      cwd: meta.cwd,
      filePath,
      compressed: isCompressedCodexRolloutPath(filePath),
      timestamp: meta.timestamp,
      mtime: stats.mtimeMs,
      size: stats.size,
      isSubagent: subagentMeta.isSubagent,
      ...(subagentMeta.parentThreadId !== undefined
        ? { parentThreadId: subagentMeta.parentThreadId }
        : {}),
      ...(subagentMeta.agentPath !== undefined
        ? { agentPath: subagentMeta.agentPath }
        : {}),
      ...(subagentMeta.agentNickname !== undefined
        ? { agentNickname: subagentMeta.agentNickname }
        : {}),
      ...(subagentMeta.agentRole !== undefined
        ? { agentRole: subagentMeta.agentRole }
        : {}),
      ...(subagentMeta.depth !== undefined
        ? { depth: subagentMeta.depth }
        : {}),
    };
  } catch (error) {
    getLogger().debug(
      `[CodexManifest] Error reading ${filePath}: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
}
