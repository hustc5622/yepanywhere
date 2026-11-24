import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  HarnessId,
  HarnessUpdateBlockReason,
  HarnessUpdateManager,
} from "@yep-anywhere/shared";
import { findDshCliPath } from "../dsh/cli.js";
import { findCodexCliPath, findPiCliPath } from "../sdk/cli-detection.js";
import { findAgyPath } from "../sdk/providers/agy.js";
import { findCursorAgentPath } from "../sdk/providers/cursor-cli.js";
import { findMcodePath } from "../sdk/providers/mcode.js";

export const HARNESS_PACKAGES: Partial<Record<HarnessId, string>> = {
  codex: "@openai/codex",
  pi: "@earendil-works/pi-coding-agent",
  mcode: "@minimax/code",
  dsh: "@deepseek-ai/dsh",
};

export const HARNESS_REGISTRIES: Partial<Record<HarnessId, string>> = {
  mcode: "https://npmmirror.xaminim.com/",
};

const MAX_WRAPPER_BYTES = 8 * 1024;

export interface HarnessCommand {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export type RunHarnessCommand = (
  command: HarnessCommand,
  options?: { timeoutMs?: number; onOutput?: (text: string) => void },
) => Promise<string>;

/** No shell, stdin, sudo, or client-supplied command fragments. */
export const runHarnessCommand: RunHarnessCommand = (command, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command.file,
      command.args,
      {
        cwd: homedir(),
        env: command.env ?? process.env,
        timeout: options.timeoutMs ?? 20_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              error.killed
                ? "CLI command timed out. Check the installation and retry."
                : stderr.trim().slice(-4_000) || error.message.slice(-4_000),
            ),
          );
        } else {
          resolve(stdout.trim());
        }
      },
    );
    child.stdin?.end();
    if (options.onOutput) {
      child.stdout?.on("data", options.onOutput);
      child.stderr?.on("data", options.onOutput);
    }
  });

export interface HarnessInstallation {
  path?: string;
  /** Underlying CLI executable when `path` is a recognized wrapper script. */
  resolvedPath?: string;
  currentVersion?: string;
  manager?: HarnessUpdateManager;
  supportsCheck?: boolean;
  blockedReason?: HarnessUpdateBlockReason;
  error?: string;
  command?: HarnessCommand;
}

export function parseHarnessVersion(
  value: string,
  id?: HarnessId,
): string | undefined {
  if (id === "cursor") {
    const dated = value.match(/\b\d{4}\.\d{2}\.\d{2}-[0-9A-Za-z._-]+\b/)?.[0];
    if (dated) return dated;
  }
  return value.match(
    /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/,
  )?.[0];
}

export function isNewerHarnessVersion(
  latest: string,
  current: string,
): boolean {
  if (!validHarnessVersion(latest) || !validHarnessVersion(current))
    return false;
  const a = latest.split(/[.+-]/).slice(0, 3).map(BigInt);
  const b = current.split(/[.+-]/).slice(0, 3).map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  const prerelease = (version: string) =>
    version.split("+", 1)[0]?.split("-").slice(1).join("-");
  const ap = prerelease(latest);
  const bp = prerelease(current);
  if (!ap || !bp) return !ap && Boolean(bp);
  const aa = ap.split(".");
  const bb = bp.split(".");
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i];
    const y = bb[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return y === undefined;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y);
    if (xn !== yn) return !xn;
    return x > y;
  }
  return false;
}

function validHarnessVersion(value: string): boolean {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    )
  )
    return false;
  const prerelease = value.split("+", 1)[0]?.split("-").slice(1).join("-");
  return !prerelease?.split(".").some((part) => /^0\d+$/.test(part));
}

function allowedUpdateVersion(id: HarnessId, value: string): boolean {
  return (
    validHarnessVersion(value) &&
    (id === "dsh" || /^\d+\.\d+\.\d+$/.test(value))
  );
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readSmallTextFile(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_WRAPPER_BYTES) {
      return null;
    }
    const content = await readFile(path, "utf8");
    if (content.includes("\0")) return null;
    return content;
  } catch {
    return null;
  }
}

interface WrapperTarget {
  targetPath: string;
  expectedNodePath?: string;
}

/**
 * Statically inspect known managed wrapper scripts without executing them:
 * - Codex model-proxy wrapper (`codex-model-proxy.zsh` + `YEP_CODEX_REAL_PATH`)
 * - MiniMax Code Node-pinned wrapper (`exec <node> <mcode> "$@"`)
 */
async function resolveManagedWrapperTarget(
  id: HarnessId,
  wrapperPath: string,
  resolvedWrapper: string,
): Promise<WrapperTarget | null> {
  if (id !== "codex" && id !== "mcode") return null;
  const content = await readSmallTextFile(resolvedWrapper);
  if (!content) return null;

  if (id === "codex") {
    if (!content.includes("codex-model-proxy.zsh")) return null;
    const match = content.match(
      /^\s*(?:export\s+)?YEP_CODEX_REAL_PATH=(?:"([^"\n]+)"|'([^'\n]+)'|([^\s#]+))/m,
    );
    const candidate =
      match?.[1] ??
      match?.[2] ??
      match?.[3] ??
      process.env.YEP_CODEX_REAL_PATH?.trim();
    if (!candidate || !isAbsolute(candidate)) return null;
    if (!(await executable(candidate))) return null;
    const resolvedCandidate = await realpath(candidate);
    if (resolvedCandidate === resolvedWrapper) return null;
    return { targetPath: candidate };
  }

  // MiniMax Code Node-pinned shell wrapper (e.g. ~/.local/bin/mcode).
  const execMatch = content.match(
    /^\s*exec\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\/\S+))\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\/\S+))\s+"\$@"/m,
  );
  if (!execMatch) return null;
  const nodePath = execMatch[1] ?? execMatch[2] ?? execMatch[3];
  const targetPath = execMatch[4] ?? execMatch[5] ?? execMatch[6];
  if (!nodePath || !targetPath) return null;
  if (!isAbsolute(nodePath) || !isAbsolute(targetPath)) return null;
  if (!(await executable(nodePath)) || !(await executable(targetPath))) {
    return null;
  }
  const resolvedTarget = await realpath(targetPath);
  if (resolvedTarget === resolvedWrapper || wrapperPath === targetPath) {
    return null;
  }
  return { targetPath, expectedNodePath: nodePath };
}

async function findHarnessPath(id: HarnessId): Promise<string | null> {
  switch (id) {
    case "codex":
      return findCodexCliPath();
    case "pi":
      return findPiCliPath();
    case "cursor":
      return findCursorAgentPath();
    case "mcode":
      return findMcodePath();
    case "agy":
      return findAgyPath();
    case "dsh":
      return findDshCliPath();
  }
}

function versionCommandFor(id: HarnessId, path: string): HarnessCommand {
  if (id === "agy") {
    return {
      file: path,
      args: ["--version"],
      env: {
        ...process.env,
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      },
    };
  }
  return { file: path, args: ["--version"] };
}

function isOfficialMcodeInstallerPath(path: string, resolved: string): boolean {
  const installDir =
    process.env.MCODE_INSTALL_DIR?.trim() || join(homedir(), ".minimax-code");
  const expectedPrefix = `${resolve(installDir)}/`;
  return (
    resolve(path).startsWith(expectedPrefix) ||
    resolved.startsWith(expectedPrefix)
  );
}

/** Recognize the actual install tree, never guess based on a PATH npm. */
export async function inspectHarnessInstallation(
  id: HarnessId,
  options: {
    path?: string | null;
    run?: RunHarnessCommand;
    platform?: NodeJS.Platform;
  } = {},
): Promise<HarnessInstallation> {
  const path =
    options.path !== undefined ? options.path : await findHarnessPath(id);
  if (!path) return { blockedReason: "not_installed" };
  if ((options.platform ?? process.platform) === "win32") {
    return { path, blockedReason: "unsupported_platform" };
  }
  const run = options.run ?? runHarnessCommand;
  const resolvedOriginal = await realpath(path);
  const wrapper = await resolveManagedWrapperTarget(id, path, resolvedOriginal);
  const effectivePath = wrapper?.targetPath ?? path;
  const resolved = wrapper ? await realpath(effectivePath) : resolvedOriginal;

  const info: HarnessInstallation = {
    path,
    ...(wrapper ? { resolvedPath: effectivePath } : {}),
  };

  try {
    info.currentVersion = parseHarnessVersion(
      await run(versionCommandFor(id, effectivePath)),
      id,
    );
    if (!info.currentVersion) {
      info.error =
        "Could not read the installed CLI version. Check the installation and retry.";
    }
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error);
  }

  // Desktop-app binaries and custom wrappers must be updated by their owner.
  if (resolved.includes(".app/")) {
    return { ...info, blockedReason: "unsupported_install" };
  }

  if (id === "cursor" || id === "agy") {
    if (!(await executable(effectivePath))) {
      return { ...info, blockedReason: "unsupported_install" };
    }
    return {
      ...info,
      manager: "self",
      supportsCheck: false,
      command: {
        file: effectivePath,
        args: ["update"],
      },
    };
  }

  if (id === "codex" && resolved.includes("/Caskroom/codex/")) {
    const prefix = resolved.split("/Caskroom/codex/")[0] as string;
    // A version-pinned Caskroom path would disappear during the upgrade.
    if (resolve(effectivePath) !== join(prefix, "bin", "codex")) {
      return { ...info, blockedReason: "unsupported_install" };
    }
    const brew = join(prefix, "bin", "brew");
    return {
      ...info,
      manager: "brew",
      supportsCheck: true,
      ...((await executable(brew))
        ? {
            command: {
              file: brew,
              args: [],
              env: {
                ...process.env,
                CI: "1",
                HOMEBREW_NO_INSTALL_CLEANUP: "1",
              },
            },
          }
        : { blockedReason: "package_manager_missing" as const }),
    };
  }

  const packageName = HARNESS_PACKAGES[id];
  if (packageName) {
    const suffix = `/lib/node_modules/${packageName}`;
    for (
      let dir = dirname(resolved);
      dir !== dirname(dir);
      dir = dirname(dir)
    ) {
      if (!dir.endsWith(suffix)) continue;
      try {
        const manifest = JSON.parse(
          await readFile(join(dir, "package.json"), "utf8"),
        );
        if (manifest.name !== packageName) continue;
        const prefix = dir.slice(0, -suffix.length);
        // A global install must own the bin entry as well as the package tree.
        if ((await realpath(join(prefix, "bin", id))) !== resolved) continue;
        const npm = join(prefix, "bin", "npm");
        const node = join(prefix, "bin", "node");
        if (!(await executable(npm)) || !(await executable(node))) {
          return {
            ...info,
            manager: "npm",
            supportsCheck: true,
            blockedReason: "package_manager_missing",
          };
        }
        // When invoked via a Node-pinned wrapper (e.g. mcode), ensure the wrapper's
        // Node runtime matches the npm prefix so native addons match the ABI.
        if (wrapper?.expectedNodePath) {
          const [expectedReal, prefixNodeReal] = await Promise.all([
            realpath(wrapper.expectedNodePath),
            realpath(node),
          ]);
          if (expectedReal !== prefixNodeReal) {
            return { ...info, blockedReason: "unsupported_install" };
          }
        }
        const registry = HARNESS_REGISTRIES[id];
        return {
          ...info,
          manager: "npm",
          supportsCheck: true,
          command: {
            file: npm,
            args: [
              "--prefix",
              prefix,
              ...(registry ? [`--registry=${registry}`] : []),
            ],
            env: {
              ...process.env,
              PATH: `${join(prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
              CI: "1",
              npm_config_update_notifier: "false",
            },
          },
        };
      } catch {
        // A similarly named directory is not evidence of a supported install.
      }
    }
  }

  // Official MiniMax Code standalone installer (~/.minimax-code/bin/mcode).
  if (
    id === "mcode" &&
    !wrapper &&
    isOfficialMcodeInstallerPath(effectivePath, resolved) &&
    (await executable(effectivePath))
  ) {
    return {
      ...info,
      manager: "self",
      supportsCheck: false,
      command: {
        file: effectivePath,
        args: ["update"],
      },
    };
  }

  return { ...info, blockedReason: "unsupported_install" };
}

export async function getLatestHarnessVersion(
  id: HarnessId,
  installation: HarnessInstallation,
  run: RunHarnessCommand,
): Promise<string> {
  if (!installation.command || installation.manager === "self") {
    throw new Error("Unsupported CLI installation");
  }
  const packageName = HARNESS_PACKAGES[id];
  if (installation.manager === "npm" && !packageName) {
    throw new Error("Unsupported CLI installation");
  }
  const command = installation.command;
  const output = await run(
    {
      ...command,
      args:
        installation.manager === "npm"
          ? [
              ...command.args,
              "view",
              `${packageName}@latest`,
              "version",
              "--json",
            ]
          : ["info", "--cask", "--json=v2", "codex"],
    },
    { timeoutMs: 45_000 },
  );
  const data = JSON.parse(output);
  const version =
    installation.manager === "npm" ? data : data.casks?.[0]?.version;
  // DSH's official latest channel currently includes RC releases. Respect
  // that channel explicitly rather than silently following next or alpha.
  if (typeof version !== "string" || !allowedUpdateVersion(id, version)) {
    throw new Error(
      id === "dsh"
        ? "The package manager did not return a valid DSH latest version"
        : "The package manager did not return a stable CLI version",
    );
  }
  return version;
}

export function harnessInstallCommand(
  id: HarnessId,
  installation: HarnessInstallation,
  version?: string,
): HarnessCommand {
  if (!installation.command) {
    throw new Error("Invalid CLI update plan");
  }
  if (installation.manager === "self") {
    return installation.command;
  }
  if (!version || !allowedUpdateVersion(id, version)) {
    throw new Error("Invalid CLI update plan");
  }
  const command = installation.command;
  if (installation.manager === "brew") {
    return {
      ...command,
      args: ["upgrade", "--cask", "codex"],
    };
  }
  const packageName = HARNESS_PACKAGES[id];
  if (!packageName) {
    throw new Error("Invalid CLI update plan");
  }
  return {
    ...command,
    args: [
      ...command.args,
      "install",
      "--global",
      `${packageName}@${version}`,
      "--no-audit",
      "--no-fund",
      ...(id === "pi" ? ["--ignore-scripts"] : []),
      ...(id === "mcode"
        ? ["--ignore-scripts=false", "--include=optional"]
        : []),
    ],
  };
}
