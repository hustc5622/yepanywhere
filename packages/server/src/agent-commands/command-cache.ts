import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SlashCommand } from "@yep-anywhere/shared";
import { getDataDir } from "../config.js";
import { getLogger } from "../logging/logger.js";
import { atomicWriteJson } from "../utils/atomic-json-file.js";

/**
 * Last `/` list an ACP provider (MiniMax Code, Cursor) reported per working
 * directory, so a new or idle session can offer the same commands before a
 * process runs. Pi keeps its own `pi-commands.json` (same idea, older file).
 * The file lives in the data dir so the web/API shell can read what an
 * external agent runtime wrote.
 */
const CACHE_VERSION = 1;
const MAX_ENTRIES = 128;

interface CacheEntry {
  provider: string;
  cwd: string;
  updatedAt: string;
  commands: SlashCommand[];
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

export function agentCommandCachePath(): string {
  return join(getDataDir(), "agent-commands.json");
}

function cacheKey(provider: string, cwd: string): string {
  return `${provider}\u0000${cwd}`;
}

async function readCacheFile(path: string): Promise<CacheFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as CacheFile).version === CACHE_VERSION &&
      (parsed as CacheFile).entries &&
      typeof (parsed as CacheFile).entries === "object"
    ) {
      return parsed as CacheFile;
    }
  } catch {
    // Missing or unreadable: start empty.
  }
  return { version: CACHE_VERSION, entries: {} };
}

export async function readAgentCommandCache(
  provider: string,
  cwd: string,
  path = agentCommandCachePath(),
): Promise<SlashCommand[] | null> {
  const entry = (await readCacheFile(path)).entries[cacheKey(provider, cwd)];
  return Array.isArray(entry?.commands) ? entry.commands : null;
}

let writeChain: Promise<void> = Promise.resolve();

/** Remember the list; writes are serialized and failures only logged. */
export function writeAgentCommandCache(
  provider: string,
  cwd: string,
  commands: SlashCommand[],
  path = agentCommandCachePath(),
): Promise<void> {
  writeChain = writeChain.then(async () => {
    try {
      const file = await readCacheFile(path);
      const key = cacheKey(provider, cwd);
      const previous = file.entries[key]?.commands;
      if (previous && JSON.stringify(previous) === JSON.stringify(commands)) {
        return;
      }
      file.entries[key] = {
        provider,
        cwd,
        updatedAt: new Date().toISOString(),
        commands,
      };
      const entries = Object.entries(file.entries)
        .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
        .slice(0, MAX_ENTRIES);
      await atomicWriteJson(path, {
        version: CACHE_VERSION,
        entries: Object.fromEntries(entries),
      });
    } catch (error) {
      getLogger().debug({ error }, "Failed to persist agent command list");
    }
  });
  return writeChain;
}

/** Resolves once queued cache writes have finished (tests, shutdown). */
export function waitForAgentCommandCacheWrites(): Promise<void> {
  return writeChain;
}
