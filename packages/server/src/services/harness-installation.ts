import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { HarnessId, HarnessUpdateBlockReason } from "@yep-anywhere/shared";
import { findCodexCliPath, findPiCliPath } from "../sdk/cli-detection.js";

export const HARNESS_PACKAGES: Record<HarnessId, string> = {
  codex: "@openai/codex",
  pi: "@earendil-works/pi-coding-agent",
};

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
  currentVersion?: string;
  manager?: "npm" | "brew";
  blockedReason?: HarnessUpdateBlockReason;
  error?: string;
  command?: HarnessCommand;
}

export function parseHarnessVersion(value: string): string | undefined {
  return value.match(
    /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/,
  )?.[0];
}

export function isNewerHarnessVersion(
  latest: string,
  current: string,
): boolean {
  const a = latest.split(/[.+-]/).slice(0, 3).map(Number);
  const b = current.split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return !latest.includes("-") && current.includes("-");
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
    options.path !== undefined
      ? options.path
      : await (id === "codex" ? findCodexCliPath() : findPiCliPath());
  if (!path) return { blockedReason: "not_installed" };
  if ((options.platform ?? process.platform) === "win32") {
    return { path, blockedReason: "unsupported_platform" };
  }
  const run = options.run ?? runHarnessCommand;
  const resolved = await realpath(path);
  const info: HarnessInstallation = { path };
  try {
    info.currentVersion = parseHarnessVersion(
      await run({ file: path, args: ["--version"] }),
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
  if (id === "codex" && resolved.includes("/Caskroom/codex/")) {
    const prefix = resolved.split("/Caskroom/codex/")[0] as string;
    // A version-pinned Caskroom path would disappear during the upgrade.
    if (resolve(path) !== join(prefix, "bin", "codex")) {
      return { ...info, blockedReason: "unsupported_install" };
    }
    const brew = join(prefix, "bin", "brew");
    return {
      ...info,
      manager: "brew",
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

  const suffix = `/lib/node_modules/${HARNESS_PACKAGES[id]}`;
  for (let dir = dirname(resolved); dir !== dirname(dir); dir = dirname(dir)) {
    if (!dir.endsWith(suffix)) continue;
    try {
      const manifest = JSON.parse(
        await readFile(join(dir, "package.json"), "utf8"),
      );
      if (manifest.name !== HARNESS_PACKAGES[id]) continue;
      const prefix = dir.slice(0, -suffix.length);
      // A global install must own the bin entry as well as the package tree.
      if ((await realpath(join(prefix, "bin", id))) !== resolved) continue;
      const npm = join(prefix, "bin", "npm");
      const node = join(prefix, "bin", "node");
      if (!(await executable(npm)) || !(await executable(node))) {
        return {
          ...info,
          manager: "npm",
          blockedReason: "package_manager_missing",
        };
      }
      return {
        ...info,
        manager: "npm",
        command: {
          file: npm,
          args: ["--prefix", prefix],
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
  return { ...info, blockedReason: "unsupported_install" };
}

export async function getLatestHarnessVersion(
  id: HarnessId,
  installation: HarnessInstallation,
  run: RunHarnessCommand,
): Promise<string> {
  if (!installation.command) throw new Error("Unsupported CLI installation");
  const command = installation.command;
  const output = await run(
    {
      ...command,
      args:
        installation.manager === "npm"
          ? [
              ...command.args,
              "view",
              `${HARNESS_PACKAGES[id]}@latest`,
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
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("The package manager did not return a stable CLI version");
  }
  return version;
}

export function harnessInstallCommand(
  id: HarnessId,
  installation: HarnessInstallation,
  version: string,
): HarnessCommand {
  if (!installation.command || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Invalid CLI update plan");
  }
  const command = installation.command;
  return {
    ...command,
    args:
      installation.manager === "npm"
        ? [
            ...command.args,
            "install",
            "--global",
            `${HARNESS_PACKAGES[id]}@${version}`,
            "--no-audit",
            "--no-fund",
            ...(id === "pi" ? ["--ignore-scripts"] : []),
          ]
        : ["upgrade", "--cask", "codex"],
  };
}
