import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SlashCommand } from "@yep-anywhere/shared";
import { getDataDir } from "../../config.js";
import { getLogger } from "../../logging/logger.js";
import { atomicWriteJson } from "../../utils/atomic-json-file.js";

/**
 * Last `/` list Pi reported per working directory.
 *
 * Pi only answers `get_commands` while its process runs, but an idle session
 * (no process) is still resumable by sending a message — including an
 * extension command or prompt template. Remembering the list lets the input
 * offer the same commands before the process starts. Pi resolves the list
 * from global plus project-local resources, hence the per-cwd key. The file
 * lives in the data dir so the web/API shell can read what an external agent
 * runtime wrote.
 */
const CACHE_VERSION = 1;
const MAX_ENTRIES = 64;

interface PiCommandCacheFile {
  version: number;
  byCwd: Record<string, { updatedAt: string; commands: SlashCommand[] }>;
}

/** Default cache location; providers resolve it once at construction. */
export function piCommandCachePath(): string {
  return join(getDataDir(), "pi-commands.json");
}

async function readCacheFile(path: string): Promise<PiCommandCacheFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as PiCommandCacheFile).version === CACHE_VERSION &&
      (parsed as PiCommandCacheFile).byCwd &&
      typeof (parsed as PiCommandCacheFile).byCwd === "object"
    ) {
      return parsed as PiCommandCacheFile;
    }
  } catch {
    // Missing or unreadable: start empty.
  }
  return { version: CACHE_VERSION, byCwd: {} };
}

let writeChain: Promise<void> = Promise.resolve();

export async function readPiCommandCache(
  cwd: string,
  path = piCommandCachePath(),
): Promise<SlashCommand[] | null> {
  const entry = (await readCacheFile(path)).byCwd[cwd];
  return Array.isArray(entry?.commands) ? entry.commands : null;
}

/** Remember the list; writes are serialized and failures only logged. */
export function writePiCommandCache(
  cwd: string,
  commands: SlashCommand[],
  path = piCommandCachePath(),
): Promise<void> {
  writeChain = writeChain.then(async () => {
    try {
      const file = await readCacheFile(path);
      const previous = file.byCwd[cwd]?.commands;
      if (previous && JSON.stringify(previous) === JSON.stringify(commands)) {
        return;
      }
      file.byCwd[cwd] = { updatedAt: new Date().toISOString(), commands };
      const entries = Object.entries(file.byCwd)
        .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
        .slice(0, MAX_ENTRIES);
      await atomicWriteJson(path, {
        version: CACHE_VERSION,
        byCwd: Object.fromEntries(entries),
      });
    } catch (error) {
      getLogger().debug({ error }, "Failed to persist Pi command list");
    }
  });
  return writeChain;
}

/** Resolves once queued cache writes have finished (tests, shutdown). */
export function waitForPiCommandCacheWrites(): Promise<void> {
  return writeChain;
}
