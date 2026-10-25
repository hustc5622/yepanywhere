import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { atomicWriteText } from "../../utils/atomic-json-file.js";

/**
 * Yep-owned Pi processes use the user's native Pi configuration.
 *
 * Pi persists every RPC `set_model` / `set_thinking_level` to the global
 * `settings.json`, and Yep routes models through providers that only exist in
 * its own extension. Writing those into `~/.pi/agent/settings.json` would
 * break the user's terminal `pi`. So Yep's `PI_CODING_AGENT_DIR` is an overlay:
 * every entry of the user's agent dir (extensions, npm packages, `mcp.json`,
 * auth, models, trust, ...) is symlinked in, and only `settings.json` is a
 * per-spawn copy that Pi may freely rewrite.
 */
export const PI_OVERLAY_SETTINGS_FILE = "settings.json";

/** Real overlay entries displaced by a user entry of the same name. */
export const PI_OVERLAY_BACKUP_DIR = ".yep-isolated-backup";

/** `YEP_PI_NATIVE_CONFIG=false` restores the legacy isolated configuration. */
export function isPiNativeConfigEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.YEP_PI_NATIVE_CONFIG?.trim().toLowerCase() !== "false";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function listEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Whether `name` is a transient file another process may be holding. */
function isTransientEntry(name: string): boolean {
  return name.endsWith(".lock") || name.includes(".tmp");
}

async function linkEntry(target: string, dest: string): Promise<void> {
  try {
    await symlink(target, dest);
  } catch (error) {
    // A concurrent spawn may have created the same link first.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * Move a real overlay entry aside so the user entry can be linked. Only the
 * first displaced copy (the legacy isolated data) is kept; later conflicts are
 * runtime files Pi/extensions wrote by atomic rename over the link (caches
 * such as `mcp-cache.json`) and are dropped instead of piling up backups.
 */
async function backupEntry(overlayDir: string, name: string): Promise<void> {
  const backupDir = join(overlayDir, PI_OVERLAY_BACKUP_DIR);
  const backupPath = join(backupDir, name);
  const source = join(overlayDir, name);
  if (await lstatOrNull(backupPath)) {
    await rm(source, { recursive: true, force: true });
    return;
  }
  await mkdir(backupDir, { recursive: true });
  try {
    await rename(source, backupPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/**
 * Point `overlayDir` at `userDir`. Idempotent and safe to run concurrently;
 * called before every Pi spawn so a restarted process sees current config.
 */
export async function syncPiNativeAgentDir(
  userDir: string,
  overlayDir: string,
): Promise<void> {
  const user = resolve(userDir);
  const overlay = resolve(overlayDir);
  if (user === overlay) return;
  await mkdir(overlay, { recursive: true });

  const userEntries = new Set(
    (await listEntries(user)).filter(
      (name) => name !== PI_OVERLAY_SETTINGS_FILE && !isTransientEntry(name),
    ),
  );

  for (const name of userEntries) {
    const target = join(user, name);
    const dest = join(overlay, name);
    const current = await lstatOrNull(dest);
    if (current?.isSymbolicLink()) {
      if ((await readlink(dest)) === target) continue;
      await unlink(dest).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    } else if (current) {
      // Keep the legacy isolated file instead of deleting it.
      await backupEntry(overlay, name);
    }
    await linkEntry(target, dest);
  }

  // Drop links to entries the user has since removed.
  for (const name of await listEntries(overlay)) {
    if (userEntries.has(name)) continue;
    const dest = join(overlay, name);
    const current = await lstatOrNull(dest);
    if (!current?.isSymbolicLink()) continue;
    if ((await readlink(dest)).startsWith(`${user}${sep}`))
      await unlink(dest).catch(() => undefined);
  }

  // A rename replaces a stray symlink itself, never the user's file.
  const settingsPath = join(overlay, PI_OVERLAY_SETTINGS_FILE);
  let userSettings: string | null = null;
  try {
    userSettings = await readFile(join(user, PI_OVERLAY_SETTINGS_FILE), "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (userSettings === null) await rm(settingsPath, { force: true });
  else await atomicWriteText(settingsPath, userSettings);
}

/**
 * Undo {@link syncPiNativeAgentDir} for the isolated fallback: remove links
 * into `userDir` and move displaced entries back.
 */
export async function restorePiIsolatedAgentDir(
  userDir: string,
  overlayDir: string,
): Promise<void> {
  const user = resolve(userDir);
  const overlay = resolve(overlayDir);
  if (user === overlay) return;
  for (const name of await listEntries(overlay)) {
    const dest = join(overlay, name);
    const current = await lstatOrNull(dest);
    if (
      current?.isSymbolicLink() &&
      (await readlink(dest)).startsWith(`${user}${sep}`)
    )
      await unlink(dest).catch(() => undefined);
  }
  const backupDir = join(overlay, PI_OVERLAY_BACKUP_DIR);
  for (const name of await listEntries(backupDir)) {
    if (await lstatOrNull(join(overlay, name))) continue;
    await rename(join(backupDir, name), join(overlay, name)).catch(
      () => undefined,
    );
  }
}
