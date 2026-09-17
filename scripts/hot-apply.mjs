#!/usr/bin/env node
/**
 * One-shot overlay of the current working tree onto the already-running
 * deployment, without going through a full deploy.
 *
 * Motivation: the 8022 service often supervises live agent turns that must not
 * be interrupted, yet a small fix in the working tree is wanted immediately.
 * This command classifies the diff between the deployed build commit and the
 * working tree, then applies the smallest disruption tier that can deliver it:
 *
 *   client   Rebuild the browser bundle and atomically swap `client-dist` in
 *            the running bundle directory. No server process is touched;
 *            open tabs auto-reload through useBuildRefresh().
 *   shell    Additionally rebuild the server bundle and restart the web/API
 *            process. Zero session impact only when the agent runtime runs as
 *            an external worker (YEP_RUNTIME_MODE=external).
 *   runtime  Also restart the agent runtime worker. Live turns are aborted.
 *
 * The overlay is deliberately temporary: it only rewrites artifacts under the
 * runtime bundle directory and records state in <dataDir>/hot-apply/. The next
 * ordinary `scripts/deploy.sh` run rebuilds everything from the committed tree
 * and the overlay disappears on its own. `--revert` restores the backup early.
 *
 * Usage:
 *   pnpm hot-apply --check           # classify only, change nothing
 *   pnpm hot-apply                   # apply client-tier changes
 *   pnpm hot-apply --allow-shell     # allow a web/API restart
 *   pnpm hot-apply --allow-runtime   # allow aborting live turns
 *   pnpm hot-apply --status
 *   pnpm hot-apply --revert
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHotApplyPlan } from "./runtime-reload-classifier.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const COLOR = process.stdout.isTTY;
const c = {
  green: (s) => (COLOR ? `\u001b[32m${s}\u001b[0m` : s),
  yellow: (s) => (COLOR ? `\u001b[33m${s}\u001b[0m` : s),
  red: (s) => (COLOR ? `\u001b[31m${s}\u001b[0m` : s),
  dim: (s) => (COLOR ? `\u001b[2m${s}\u001b[0m` : s),
};
const log = (msg) => console.log(`${c.green("==>")} ${msg}`);
const warn = (msg) => console.warn(`${c.yellow("!!")}  ${msg}`);
const fail = (msg) => console.error(`${c.red("xx")}  ${msg}`);
const dim = (msg) => console.log(c.dim(`    ${msg}`));

function usage() {
  console.log(`
hot-apply - overlay the working tree onto the running deployment

Usage:
  pnpm hot-apply [options]

Options:
  --check, --dry-run   Classify the diff and print the plan; change nothing
  --status             Print the current overlay state and exit
  --revert             Restore the client bundle saved by the last overlay
  --allow-shell        Permit rebuilding/restarting the web/API process
  --allow-runtime      Permit restarting the agent runtime (aborts live turns)
  --base-url <url>     Running deployment base URL
                       (default: $YEP_HOT_APPLY_BASE_URL or http://127.0.0.1:8022/yep)
  --help, -h           Show this message

Tiers are derived from the changed files, never from flags: a client-only diff
never restarts anything, and a runtime diff is refused until --allow-runtime is
passed explicitly.
`);
}

function parseArgs(argv) {
  const options = {
    check: false,
    status: false,
    revert: false,
    allowShell: false,
    allowRuntime: false,
    baseUrl: process.env.YEP_HOT_APPLY_BASE_URL ?? "http://127.0.0.1:8022/yep",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--check":
      case "--dry-run":
        options.check = true;
        break;
      case "--status":
        options.status = true;
        break;
      case "--revert":
        options.revert = true;
        break;
      case "--allow-shell":
        options.allowShell = true;
        break;
      case "--allow-runtime":
        options.allowRuntime = true;
        options.allowShell = true;
        break;
      case "--base-url": {
        const value = argv[i + 1];
        if (!value || value.startsWith("-")) {
          throw new Error("--base-url requires a value");
        }
        options.baseUrl = value.replace(/\/$/, "");
        i += 1;
        break;
      }
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function run(command, args, extraEnv) {
  return execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

function runInherit(command, args, extraEnv) {
  execFileSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

function dataDir() {
  if (process.env.YEP_ANYWHERE_DATA_DIR) {
    return process.env.YEP_ANYWHERE_DATA_DIR;
  }
  const profile = process.env.YEP_ANYWHERE_PROFILE;
  return path.join(
    homedir(),
    profile ? `.yep-anywhere-${profile}` : ".yep-anywhere",
  );
}

function stateDir() {
  return path.join(dataDir(), "hot-apply");
}

function statePath() {
  return path.join(stateDir(), "state.json");
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf-8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Locate the bundle directory the running service actually executes.
 *
 * Reading it from the live process is the only reliable source: a deployment
 * may run from the LaunchAgent runtime copy, from a fallback process started
 * out of the repository, or from a custom YEP_LAUNCHD_RUNTIME_DIR.
 */
function resolveRunningBundle(baseUrl) {
  const port = new URL(baseUrl).port || "80";
  let pids = [];
  try {
    pids = run("lsof", [`-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    pids = [];
  }
  for (const pid of pids) {
    let command = "";
    try {
      command = run("ps", ["-p", pid, "-o", "command="]).trim();
    } catch {
      continue;
    }
    const match = command.match(/(\S+\/dist\/cli\.js)/);
    if (!match) continue;
    const cliJs = match[1];
    const bundleDir = path.resolve(path.dirname(cliJs), "..");
    if (fs.existsSync(path.join(bundleDir, "client-dist"))) {
      return { pid, bundleDir, command };
    }
  }
  return null;
}

/** Files changed between the deployed commit and the current working tree. */
function changedFiles(baseCommit) {
  const files = new Set();
  const collect = (output) => {
    for (const line of output.split("\n")) {
      const file = line.trim();
      if (file) files.add(file);
    }
  };
  collect(run("git", ["diff", "--name-only", baseCommit, "--"]));
  collect(run("git", ["ls-files", "--others", "--exclude-standard"]));
  return [...files].sort();
}

function commitExists(commit) {
  try {
    run("git", ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function printPlan(plan) {
  const groups = [
    ["client", plan.clientFiles],
    ["shell", plan.shellFiles],
    ["runtime", plan.runtimeFiles],
    ["shared", plan.sharedFiles],
  ];
  for (const [label, files] of groups) {
    if (files.length === 0) continue;
    dim(`${label} (${files.length}):`);
    for (const file of files.slice(0, 12)) dim(`  ${file}`);
    if (files.length > 12) dim(`  ... ${files.length - 12} more`);
  }
  if (plan.ignoredFiles.length > 0) {
    dim(
      `ignored (${plan.ignoredFiles.length}): docs/scripts/tests and other files that cannot reach a running service`,
    );
  }
}

function buildClientBundle({ basePath, buildInfo, hotBuildId }) {
  log("Building @yep-anywhere/shared ...");
  runInherit("corepack", ["pnpm", "--filter", "@yep-anywhere/shared", "build"]);

  log(`Building @yep-anywhere/client (BASE_PATH=${basePath || "/"}) ...`);
  runInherit(
    "corepack",
    ["pnpm", "--filter", "@yep-anywhere/client", "build"],
    {
      BASE_PATH: basePath,
      YEP_BUILD_ID: hotBuildId,
      YEP_BUILD_VERSION: buildInfo.version,
      YEP_BUILD_DATE: new Date().toISOString(),
      YEP_BUILD_GIT_DESCRIBE: buildInfo.gitDescribe ?? buildInfo.version,
      YEP_BUILD_PROFILE: buildInfo.buildProfile ?? "production",
    },
  );

  const clientDist = path.join(REPO_ROOT, "packages/client/dist");
  const indexHtml = path.join(clientDist, "index.html");
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`Client build produced no index.html at ${clientDist}`);
  }

  // useBuildRefresh() compares this buildId against the id compiled into the
  // running SPA, so writing it is what makes open tabs pick the overlay up.
  const overlayInfo = {
    ...buildInfo,
    buildId: hotBuildId,
    builtAt: new Date().toISOString(),
    hotApply: true,
    hotApplyBaseBuildId: buildInfo.buildId,
  };
  fs.writeFileSync(
    path.join(clientDist, "build-info.json"),
    `${JSON.stringify(overlayInfo, null, 2)}\n`,
  );
  return clientDist;
}

/**
 * Publish a freshly built client bundle into the running bundle directory.
 *
 * The swap is two renames on the same filesystem, so the server never observes
 * a partially written asset tree. The static file cache is keyed by
 * path+mtime+size, which invalidates itself without a restart.
 */
function swapClientDist({ bundleDir, freshClientDist }) {
  const target = path.join(bundleDir, "client-dist");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupsDir = path.join(stateDir(), "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const backup = path.join(backupsDir, `client-dist-${stamp}`);
  const staging = path.join(bundleDir, `.client-dist.hot-apply-${stamp}`);

  fs.cpSync(freshClientDist, staging, { recursive: true });
  const stagedIndex = path.join(staging, "index.html");
  if (!fs.existsSync(stagedIndex)) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error("Staged client bundle is incomplete; refusing to swap.");
  }

  if (fs.existsSync(target)) {
    fs.renameSync(target, backup);
  }
  try {
    fs.renameSync(staging, target);
  } catch (error) {
    if (fs.existsSync(backup) && !fs.existsSync(target)) {
      fs.renameSync(backup, target);
    }
    throw error;
  }
  return { target, backup: fs.existsSync(backup) ? backup : null };
}

function pruneBackups(keep = 3) {
  const backupsDir = path.join(stateDir(), "backups");
  if (!fs.existsSync(backupsDir)) return;
  const entries = fs
    .readdirSync(backupsDir)
    .filter((name) => name.startsWith("client-dist-"))
    .sort();
  for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
    fs.rmSync(path.join(backupsDir, name), { recursive: true, force: true });
  }
}

function showStatus(state, versionInfo) {
  if (!state) {
    log("No hot-apply overlay is recorded for this data directory.");
  } else {
    log("Last hot-apply overlay");
    dim(`applied at:    ${state.appliedAt}`);
    dim(`tier:          ${state.level}`);
    dim(`base commit:   ${state.baseCommit}`);
    dim(`base build:    ${state.baseBuildId}`);
    dim(`overlay build: ${state.hotBuildId ?? "(server restart only)"}`);
    dim(`files:         ${state.files.length}`);
    if (state.clientDistBackup) dim(`backup:        ${state.clientDistBackup}`);
  }
  if (versionInfo?.build) {
    log("Running deployment");
    dim(`server build:  ${versionInfo.build.buildId}`);
    dim(`git commit:    ${versionInfo.build.gitCommit}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const versionInfo = await fetchJson(`${options.baseUrl}/api/version`);
  const state = readState();

  if (options.status) {
    showStatus(state, versionInfo);
    return;
  }

  if (options.revert) {
    if (!state?.clientDistBackup) {
      fail("No client bundle backup is recorded; nothing to revert.");
      dim("Run scripts/deploy.sh --server-only for a clean redeploy instead.");
      process.exitCode = 1;
      return;
    }
    if (!fs.existsSync(state.clientDistBackup)) {
      fail(`Recorded backup is missing: ${state.clientDistBackup}`);
      process.exitCode = 1;
      return;
    }
    const target = path.join(state.bundleDir, "client-dist");
    const discarded = `${target}.hot-apply-discarded`;
    fs.rmSync(discarded, { recursive: true, force: true });
    if (fs.existsSync(target)) fs.renameSync(target, discarded);
    fs.cpSync(state.clientDistBackup, target, { recursive: true });
    fs.rmSync(discarded, { recursive: true, force: true });
    log(`Restored the pre-overlay client bundle into ${target}`);
    dim("Open tabs reload themselves once they poll build-info.json.");
    writeState({ ...state, revertedAt: new Date().toISOString() });
    if (state.level !== "client") {
      warn(
        "The previous overlay also restarted server processes; only the client bundle was reverted.",
      );
      warn("Run scripts/deploy.sh --server-only to fully restore the server.");
    }
    return;
  }

  if (!versionInfo?.build) {
    fail(`No running deployment answered ${options.baseUrl}/api/version`);
    dim("Pass --base-url if the service is mounted elsewhere.");
    process.exitCode = 1;
    return;
  }

  const buildInfo = versionInfo.build;
  const baseCommit = buildInfo.gitCommit;
  if (!baseCommit || !commitExists(baseCommit)) {
    fail(
      `The running deployment reports commit ${baseCommit ?? "(none)"}, which is not in this repository.`,
    );
    dim("hot-apply can only overlay a deployment built from this checkout.");
    process.exitCode = 1;
    return;
  }

  const workers = await fetchJson(`${options.baseUrl}/api/status/workers`);
  const runtimeMode = workers?.runtimeMode ?? "unknown";
  const hasActiveWork = workers?.hasActiveWork === true;

  const bundle = resolveRunningBundle(options.baseUrl);
  if (!bundle) {
    fail("Could not locate the bundle directory of the running service.");
    dim(
      "hot-apply inspects the process listening on the deployment port; is it running from a dist/cli.js bundle?",
    );
    process.exitCode = 1;
    return;
  }

  const files = changedFiles(baseCommit);
  const plan = getHotApplyPlan(files);

  log(
    `Deployed build ${buildInfo.buildId} (commit ${baseCommit.slice(0, 12)})`,
  );
  dim(`bundle:       ${bundle.bundleDir} (pid ${bundle.pid})`);
  dim(`runtime mode: ${runtimeMode}${hasActiveWork ? ", active work" : ""}`);
  dim(`changed:      ${files.length} file(s), tier: ${plan.level}`);
  printPlan(plan);

  if (plan.level === "none") {
    log("Nothing in the working tree can reach the running deployment.");
    return;
  }

  // Tier gating. The runtime owns provider child processes, so only an explicit
  // opt-in may restart it.
  if (plan.needsRuntimeRestart && !options.allowRuntime) {
    fail("This diff touches the agent runtime; it cannot be hot-applied.");
    dim(
      "Restarting the runtime aborts every live turn. Re-run with --allow-runtime when that is acceptable,",
    );
    dim(
      "or land the change with scripts/deploy.sh once the sessions are idle.",
    );
    process.exitCode = 2;
    return;
  }
  if (plan.needsShellRestart && !options.allowShell) {
    fail("This diff needs a web/API restart; it cannot be applied silently.");
    if (runtimeMode === "external") {
      dim(
        "The agent runtime is external, so a shell restart does not abort live turns. Re-run with --allow-shell.",
      );
    } else {
      dim(
        "The agent runtime is embedded in this process, so a shell restart aborts live turns.",
      );
      dim(
        "Split the runtime out first (see AGENTS.md, external runtime), or re-run with --allow-shell to accept the interruption.",
      );
    }
    process.exitCode = 2;
    return;
  }

  if (options.check) {
    log("--check requested; stopping before any change.");
    return;
  }

  const hotBuildId = `${buildInfo.buildId}+hot.${Date.now().toString(36)}`;
  const nextState = {
    appliedAt: new Date().toISOString(),
    level: plan.level,
    baseCommit,
    baseBuildId: buildInfo.buildId,
    hotBuildId: null,
    bundleDir: bundle.bundleDir,
    baseUrl: options.baseUrl,
    runtimeMode,
    files,
    clientDistBackup: state?.clientDistBackup ?? null,
  };

  if (plan.needsShellRestart || plan.needsRuntimeRestart) {
    // A server-tier change rebuilds the whole bundle anyway, which republishes
    // client-dist from the same tree. Delegating keeps one restart code path.
    const args = [];
    if (plan.needsRuntimeRestart) args.push("--restart-runtime");
    if (options.allowRuntime) args.push("--allow-yep-session-interrupt");
    log(
      `Delegating to scripts/redeploy-server.sh ${args.join(" ") || "(default)"} ...`,
    );
    runInherit(path.join(SCRIPT_DIR, "redeploy-server.sh"), args, {
      BASE_PATH: buildInfo.basePath ?? "/yep",
    });
    nextState.hotBuildId = null;
    nextState.clientDistBackup = null;
    writeState(nextState);
    log("Server-tier changes are live; the overlay state was cleared.");
    return;
  }

  const clientDist = buildClientBundle({
    basePath: buildInfo.basePath ?? "/yep",
    buildInfo,
    hotBuildId,
  });
  const swapped = swapClientDist({
    bundleDir: bundle.bundleDir,
    freshClientDist: clientDist,
  });
  nextState.hotBuildId = hotBuildId;
  nextState.clientDistBackup = swapped.backup;
  writeState(nextState);
  pruneBackups();

  log(`Client overlay published to ${swapped.target}`);
  dim(`overlay build id: ${hotBuildId}`);
  dim("No server process was restarted; live sessions are untouched.");
  dim("Open tabs auto-reload; pull-to-refresh on mobile applies it instantly.");
  dim("Undo with: pnpm hot-apply --revert");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
