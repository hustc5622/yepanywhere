import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodexSessionMetaEntry,
  parseCodexSessionEntry,
} from "@yep-anywhere/shared";
import { getCodexSubagentMetadata } from "../codex/subagent.js";
import { getLogger } from "../logging/logger.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import { readFirstLine } from "../utils/jsonl.js";

export interface CodexSessionManifestEntry {
  id: string;
  cwd: string;
  filePath: string;
  timestamp: string;
  mtime: number;
  size: number;
  isSubagent: boolean;
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
  depth?: number;
}

export interface CodexSessionManifest {
  sessions: CodexSessionManifestEntry[];
  byId: Map<string, CodexSessionManifestEntry>;
  byProjectPath: Map<string, CodexSessionManifestEntry[]>;
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

  const files = await findJsonlFiles(sessionsDir);
  getLogger().debug(
    `[CodexManifest] Found ${files.length} .jsonl files in ${sessionsDir}`,
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
      `[CodexManifest] Found ${files.length} .jsonl files but parsed 0 sessions (${failCount} failed). First file: ${files[0]}`,
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

  for (const session of sessions) {
    if (!byId.has(session.id)) {
      byId.set(session.id, session);
    }

    const projectPath = canonicalizeProjectPath(session.cwd);
    const projectSessions = byProjectPath.get(projectPath);
    if (projectSessions) {
      projectSessions.push(session);
    } else {
      byProjectPath.set(projectPath, [session]);
    }
  }

  return {
    sessions,
    byId,
    byProjectPath,
  };
}

async function findJsonlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await findJsonlFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    getLogger().debug(
      `[CodexManifest] Error scanning directory ${dir}: ${error instanceof Error ? error.message : error}`,
    );
  }

  return files;
}

async function readSessionManifestEntry(
  filePath: string,
): Promise<CodexSessionManifestEntry | null> {
  try {
    const [stats, firstLine] = await Promise.all([
      stat(filePath),
      readFirstLine(filePath, CODEX_META_READ_MAX_BYTES),
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

    const subagent = getCodexSubagentMetadata(meta);
    return {
      id: meta.id,
      cwd: meta.cwd,
      filePath,
      timestamp: meta.timestamp,
      mtime: stats.mtimeMs,
      size: stats.size,
      isSubagent: subagent.isSubagent,
      parentThreadId: subagent.parentThreadId,
      agentNickname: subagent.agentNickname,
      agentRole: subagent.agentRole,
      depth: subagent.depth,
    };
  } catch (error) {
    getLogger().debug(
      `[CodexManifest] Error reading ${filePath}: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
}
