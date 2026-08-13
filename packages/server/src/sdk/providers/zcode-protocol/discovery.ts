/**
 * ZCode CLI discovery and version/capability probe.
 *
 * Discovery order (first match wins):
 *   1. `YEP_ZCODE_CLI_PATH` env var (explicit override).
 *   2. `which zcode` (PATH lookup — for users who symlinked or installed).
 *   3. `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (system).
 *   4. `~/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (user).
 *
 * `.cjs` bundles require a Node.js wrapper: the launch command is
 * `process.execPath <path> app-server` rather than `<path> app-server`.
 *
 * Version probing runs `<node> <path> version` (or `<path> version` for native)
 * and parses the first `MAJOR.MINOR.PATCH` token.  The probed version is
 * compared against `ZCODE_COMPATIBILITY_BASELINE.cliVersion`; older versions
 * return a stable `zcode_cli_unsupported_version` error code.
 *
 * Windows/Linux auto-discovery is not implemented yet; the env override and
 * PATH lookup cover those platforms, and P5 will add platform adapters.
 */

import { exec, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { promisify } from "node:util";
import {
  ZCODE_COMPATIBILITY_BASELINE,
  isZCodeVersionGte,
} from "@yep-anywhere/shared";
import { whichCommand } from "../../cli-detection.js";
import type { ZCodeDiscoveryResult, ZCodeLaunchCommand } from "./types.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const isWindows = os.platform() === "win32";

/**
 * macOS ZCode.app bundle CLI paths (checked after PATH).
 *
 * The `.cjs` bundle is the built-in CLI shipped inside the ZCode Desktop app.
 */
function getZCodeBundlePaths(home = os.homedir()): string[] {
  const sep = "/";
  return [
    `/Applications${sep}ZCode.app/Contents/Resources/glm/zcode.cjs`,
    `${home}/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`,
  ];
}

/**
 * Find the ZCode CLI path.
 *
 * Returns the first existing path, or `null` when not found.
 * The returned path may be a `.cjs` bundle (requires Node wrapper) or a
 * native executable.
 */
export async function findZCodeCliPath(): Promise<{
  path: string;
  source: "env" | "path" | "app-bundle" | "user-app-bundle";
} | null> {
  // 1. Explicit env override.
  const envPath = process.env.YEP_ZCODE_CLI_PATH;
  if (envPath && existsSync(envPath)) {
    return { path: envPath, source: "env" };
  }

  // 2. PATH lookup via `which`/`where`.
  try {
    const { stdout } = await execAsync(whichCommand("zcode"), {
      encoding: "utf-8",
    });
    const zcodePath = stdout.split("\n")[0]?.trim();
    if (zcodePath && existsSync(zcodePath)) {
      return { path: zcodePath, source: "path" };
    }
  } catch {
    // Not in PATH.
  }

  // 3–4. macOS app bundle locations.
  const bundlePaths = getZCodeBundlePaths();
  for (let i = 0; i < bundlePaths.length; i += 1) {
    const p = bundlePaths[i];
    if (p && existsSync(p)) {
      return { path: p, source: i === 0 ? "app-bundle" : "user-app-bundle" };
    }
  }

  return null;
}

/**
 * Determine whether a CLI path is a `.cjs` bundle requiring a Node wrapper.
 */
export function isZCodeCjsBundle(cliPath: string): boolean {
  return cliPath.endsWith(".cjs");
}

/**
 * Resolve the launch command for spawning a ZCode app-server.
 *
 * `.cjs`: `{ command: process.execPath, args: ["<path>", "app-server"] }`.
 * Native: `{ command: "<path>", args: ["app-server"] }`.
 */
export function resolveZCodeLaunchCommand(cliPath: string): ZCodeLaunchCommand {
  const cjs = isZCodeCjsBundle(cliPath);
  if (cjs) {
    return {
      command: process.execPath,
      args: [cliPath, "app-server"],
      isCjs: true,
      cliPath,
    };
  }
  return {
    command: cliPath,
    args: ["app-server"],
    isCjs: false,
    cliPath,
  };
}

/**
 * Probe the CLI version by running `<node> <path> version` (for `.cjs`) or
 * `<path> version` (for native).
 *
 * Returns the parsed version string (e.g. `"0.16.1"`) or `null` when the
 * command failed or the output was unparseable.
 */
export async function probeZCodeCliVersion(
  cliPath: string,
): Promise<string | null> {
  const cjs = isZCodeCjsBundle(cliPath);
  const command = cjs ? process.execPath : cliPath;
  const args = cjs ? [cliPath, "version"] : ["version"];

  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf-8",
      timeout: 15_000,
    });
    const match = /(\d+\.\d+\.\d+)/.exec(stdout.trim());
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Full discovery: find CLI, probe version, check compatibility baseline.
 *
 * Returns a `ZCodeDiscoveryResult` with a stable `errorCode` when the CLI
 * cannot be used.  Does not spawn an app-server (that is the caller's job).
 *
 * Caller is responsible for redacting any diagnostic output — this function
 * does not log the CLI path or version beyond debug level.
 */
export async function discoverZCodeCli(): Promise<ZCodeDiscoveryResult> {
  const found = await findZCodeCliPath();

  if (!found) {
    return {
      path: null,
      version: null,
      source: null,
      isCjs: false,
      errorCode: "zcode_cli_not_found",
    };
  }

  const { path, source } = found;
  const isCjs = isZCodeCjsBundle(path);
  const version = await probeZCodeCliVersion(path);

  if (!version) {
    // Version probe failed — either the CLI is broken or Node is missing
    // for a `.cjs` bundle.
    return {
      path,
      version: null,
      source,
      isCjs,
      errorCode: isCjs
        ? "zcode_node_runtime_unsupported"
        : "zcode_cli_unsupported_version",
    };
  }

  const baseline = ZCODE_COMPATIBILITY_BASELINE.cliVersion;
  if (!isZCodeVersionGte(version, baseline)) {
    return {
      path,
      version,
      source,
      isCjs,
      errorCode: "zcode_cli_unsupported_version",
    };
  }

  return {
    path,
    version,
    source,
    isCjs,
    errorCode: null,
  };
}
