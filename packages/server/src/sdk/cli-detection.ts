import { exec, execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import * as os from "node:os";
import { promisify } from "node:util";

const isWindows = os.platform() === "win32";
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Returns the platform-appropriate command to locate an executable in PATH.
 * Uses `where` on Windows, `which` on Unix.
 */
export function whichCommand(name: string): string {
  return isWindows ? `where ${name}` : `which ${name}`;
}

/**
 * Information about the Codex CLI installation.
 */
export interface CodexCliInfo {
  /** Whether the CLI was found */
  found: boolean;
  /** Path to the CLI executable */
  path?: string;
  /** CLI version string */
  version?: string;
  /** Error message if not found */
  error?: string;
}

/**
 * Detect the Codex CLI installation.
 *
 * Checks:
 * 1. Explicit YEP_CODEX_PATH/CODEX_PATH overrides
 * 2. PATH via `which codex`
 * 3. Common installation locations (NVM, cargo, local bin, etc.)
 *
 * @returns Information about the CLI installation
 */
export async function detectCodexCli(): Promise<CodexCliInfo> {
  const codexPath = await findCodexCliPath();
  if (codexPath) {
    const version = await getCodexVersion(codexPath);
    if (version) {
      return { found: true, path: codexPath, version };
    }
  }

  return {
    found: false,
    error: "Codex CLI not found. Install via: cargo install codex",
  };
}

/**
 * Common Codex CLI installation paths (checked after PATH lookup).
 * Includes the Codex desktop app's sandbox-bin location.
 */
export function getCodexCommonPaths(home = os.homedir()): string[] {
  const ext = isWindows ? ".exe" : "";
  const sep = isWindows ? "\\" : "/";
  return isWindows
    ? [
        `${home}${sep}.codex${sep}.sandbox-bin${sep}codex${ext}`,
        `${home}${sep}.cargo${sep}bin${sep}codex${ext}`,
        `${home}${sep}.codex${sep}bin${sep}codex${ext}`,
        `${home}${sep}AppData${sep}Local${sep}bin${sep}codex${ext}`,
      ]
    : [
        `${home}/.codex/.sandbox-bin/codex`,
        `${home}/.local/bin/codex`,
        ...getNvmCodexPaths(home),
        "/usr/local/bin/codex",
        `${home}/.cargo/bin/codex`,
        `${home}/.codex/bin/codex`,
      ];
}

function getNvmCodexPaths(home: string): string[] {
  const versionsRoot = `${home}/.nvm/versions/node`;
  try {
    return readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) =>
        right.localeCompare(left, undefined, { numeric: true }),
      )
      .map((version) => `${versionsRoot}/${version}/bin/codex`);
  } catch {
    return [];
  }
}

/**
 * Find the Codex CLI path from an explicit override, PATH, or common locations.
 * Returns the path if found, null otherwise.
 */
export async function findCodexCliPath(): Promise<string | null> {
  for (const explicitPath of [
    process.env.YEP_CODEX_PATH,
    process.env.CODEX_PATH,
  ]) {
    if (explicitPath && existsSync(explicitPath)) return explicitPath;
  }

  try {
    const { stdout } = await execAsync(whichCommand("codex"), {
      encoding: "utf-8",
    });
    const codexPath = stdout.split("\n")[0]?.trim();
    if (codexPath) return codexPath;
  } catch {
    // Not in PATH
  }

  for (const path of getCodexCommonPaths()) {
    if (existsSync(path)) return path;
  }

  return null;
}

/**
 * Get the version of the Codex CLI at the given path.
 */
async function getCodexVersion(codexPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(codexPath, ["--version"], {
      encoding: "utf-8",
    });
    const output = stdout.trim();
    return output;
  } catch {
    return undefined;
  }
}
