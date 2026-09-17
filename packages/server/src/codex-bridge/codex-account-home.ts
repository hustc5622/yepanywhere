import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../config.js";
import { getDefaultCodexHomeDir } from "../projects/codex-scanner.js";

export const DEFAULT_CODEX_ACCOUNT_ID = "default";

export interface CodexAccountHomeProfile {
  id: string;
  codexHome: string;
  label: string | null;
}

/**
 * Entries linked from an alternate `CODEX_HOME` back to the machine-wide one.
 *
 * Auth is the only thing an extra account must keep private. Session storage is
 * shared so Yep's scanners, watchers, readers and resume paths keep working
 * against a single `sessions/` tree no matter which account produced a thread.
 *
 * SQLite databases (`thread_history_*.sqlite`, `state_*.sqlite`, ...) are
 * deliberately *not* linked: two processes opening the same database through
 * different paths would use different `-wal`/`-shm` side files, which risks
 * corruption. Codex keeps per-home thread-history databases instead, and Yep
 * falls back to reading rollout JSONL for those sessions.
 */
const SHARED_ENTRIES = [
  { name: "sessions", kind: "dir" },
  { name: "archived_sessions", kind: "dir" },
  { name: "session_index.jsonl", kind: "file" },
  { name: "history.jsonl", kind: "file" },
] as const;

export function readCodexAccountProfiles(
  dataDir = getDataDir(),
): CodexAccountHomeProfile[] {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dataDir, "codex-accounts.json"), "utf-8"),
    ) as { accounts?: CodexAccountHomeProfile[] };
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    return accounts.filter(
      (item) =>
        typeof item?.id === "string" && typeof item?.codexHome === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Resolve the `CODEX_HOME` for a session-scoped Codex account id.
 *
 * Returns `null` for the default/machine account (and for unknown ids), which
 * means "inherit the ambient CODEX_HOME" for callers.
 */
export function resolveCodexHomeForAccount(
  accountId: string | undefined,
  options: { dataDir?: string; defaultCodexHome?: string } = {},
): string | null {
  const id = accountId?.trim();
  if (!id || id === DEFAULT_CODEX_ACCOUNT_ID) return null;
  const profile = readCodexAccountProfiles(options.dataDir).find(
    (item) => item.id === id,
  );
  if (!profile) return null;
  ensureSharedCodexStorage(
    profile.codexHome,
    options.defaultCodexHome ?? getDefaultCodexHomeDir(),
  );
  return profile.codexHome;
}

/**
 * Point the shared session-storage entries of `codexHome` at `defaultCodexHome`.
 * Idempotent: existing symlinks and real files are left untouched.
 */
export function ensureSharedCodexStorage(
  codexHome: string,
  defaultCodexHome: string = getDefaultCodexHomeDir(),
): void {
  if (codexHome === defaultCodexHome) return;
  try {
    mkdirSync(codexHome, { recursive: true });
  } catch {
    return;
  }

  for (const entry of SHARED_ENTRIES) {
    const target = join(defaultCodexHome, entry.name);
    const linkPath = join(codexHome, entry.name);
    if (entry.kind === "dir") {
      if (!existsSync(target)) {
        try {
          mkdirSync(target, { recursive: true });
        } catch {
          continue;
        }
      }
    } else if (!existsSync(target)) {
      continue;
    }
    if (pathExists(linkPath)) continue;
    try {
      symlinkSync(target, linkPath, entry.kind === "dir" ? "dir" : "file");
    } catch {
      // A concurrent start may have created it first; ignore.
    }
  }
}

/** Accounts whose home directory currently holds credentials. */
export function listSignedInCodexAccountIds(dataDir = getDataDir()): string[] {
  return readCodexAccountProfiles(dataDir)
    .filter((profile) => existsSync(join(profile.codexHome, "auth.json")))
    .map((profile) => profile.id);
}

/** Directory names Codex creates under an alternate home (diagnostics only). */
export function listCodexHomeEntries(codexHome: string): string[] {
  try {
    return readdirSync(codexHome);
  } catch {
    return [];
  }
}

function pathExists(path: string): boolean {
  try {
    // lstat so a dangling symlink still counts as "present".
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
