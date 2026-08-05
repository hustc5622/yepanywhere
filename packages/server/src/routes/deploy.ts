import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { cleanEnv, startGitPullAndDeploy } from "./git-pull-deploy.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_LOG_BYTES = 96 * 1024;
const MAX_JOBS = 20;

export type DeploymentActionId =
  | "full"
  | "server"
  | "server-restart"
  | "services-restart"
  | "server-build"
  | "apk"
  | "apk-build"
  | "apk-install-existing"
  | "git-pull-update";

export type DeploymentJobStatus = "running" | "succeeded" | "failed";

export interface DeploymentAction {
  id: DeploymentActionId;
  args: string[];
  requiresDevice: boolean;
  supportsBuildType: boolean;
  supportsInstall: boolean;
  supportsSkipChecks: boolean;
  supportsRestartTargets?: boolean;
}

export interface AdbDevice {
  id: string;
  state: string;
  model?: string;
  product?: string;
}

export type ApkBuildType = "release" | "debug";

export interface DeploymentApkInfo {
  buildType: ApkBuildType;
  fileName: string;
  size: number;
  mtimeMs: number;
  builtAt: string;
  downloadPath: string;
}

export interface DeploymentJob {
  id: string;
  action: DeploymentActionId;
  args: string[];
  command: string;
  status: DeploymentJobStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  log?: string;
  errorReason?: string;
}

interface DeploymentJobRecord extends Omit<DeploymentJob, "log"> {
  logPath: string;
}

export interface GitVersionInfo {
  commitHash: string;
  commitHashFull: string;
  commitDate: string;
  branch: string;
  version: string;
}

export interface DeploymentStatusResponse {
  available: boolean;
  reason?: string;
  repoRoot?: string;
  scriptPath?: string;
  packageVersion?: string | null;
  stagedBuild?: {
    version: string;
    buildId: string;
    builtAt: string;
  } | null;
  actions: DeploymentAction[];
  adb: {
    available: boolean;
    devices: AdbDevice[];
    error?: string;
  };
  apk: {
    latest: DeploymentApkInfo | null;
    artifacts: DeploymentApkInfo[];
  };
  currentJob: DeploymentJob | null;
  localGitVersion?: GitVersionInfo | null;
  githubVersion?: GitVersionInfo | null;
  stableVersion?: GitVersionInfo | null;
  hasLocalUpdate?: boolean;
  hasGithubUpdate?: boolean;
}

export interface StartDeploymentRequest {
  action?: DeploymentActionId;
  buildType?: "debug" | "release";
  install?: boolean;
  deviceId?: string;
  skipChecks?: boolean;
  restartTargets?: DeploymentRestartTargets;
}

export interface DeploymentRestartTargets {
  server?: boolean;
  codexBridge?: boolean;
  claudeBridge?: boolean;
}

export interface DeployRoutesOptions {
  dataDir?: string;
  repoRoot?: string;
}

const DEPLOYMENT_ACTIONS: DeploymentAction[] = [
  {
    id: "git-pull-update",
    args: ["--git-pull", "--server-only"],
    requiresDevice: false,
    supportsBuildType: false,
    supportsInstall: false,
    supportsSkipChecks: false,
    supportsRestartTargets: true,
  },
  {
    id: "server",
    args: ["--server-only"],
    requiresDevice: false,
    supportsBuildType: false,
    supportsInstall: false,
    supportsSkipChecks: true,
    supportsRestartTargets: true,
  },
  {
    id: "server-restart",
    args: ["--server-only", "--restart-only"],
    requiresDevice: false,
    supportsBuildType: false,
    supportsInstall: false,
    supportsSkipChecks: false,
    supportsRestartTargets: true,
  },
  {
    id: "services-restart",
    args: [],
    requiresDevice: false,
    supportsBuildType: false,
    supportsInstall: false,
    supportsSkipChecks: false,
    supportsRestartTargets: true,
  },
  {
    id: "server-build",
    args: ["--server-only", "--server-build-only"],
    requiresDevice: false,
    supportsBuildType: false,
    supportsInstall: false,
    supportsSkipChecks: true,
  },
  {
    id: "apk",
    args: ["--apk-only"],
    requiresDevice: false,
    supportsBuildType: true,
    supportsInstall: true,
    supportsSkipChecks: false,
  },
  {
    id: "apk-build",
    args: ["--apk-only", "--no-install"],
    requiresDevice: false,
    supportsBuildType: true,
    supportsInstall: false,
    supportsSkipChecks: false,
  },
  {
    id: "apk-install-existing",
    args: ["--apk-only", "--no-build"],
    requiresDevice: false,
    supportsBuildType: true,
    supportsInstall: false,
    supportsSkipChecks: false,
  },
  {
    id: "full",
    args: [],
    requiresDevice: false,
    supportsBuildType: true,
    supportsInstall: true,
    supportsSkipChecks: true,
    supportsRestartTargets: true,
  },
];

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function defaultDataDir(): string {
  return (
    process.env.YEP_ANYWHERE_DATA_DIR ||
    path.join(os.homedir(), ".yep-anywhere")
  );
}

function getCandidateRepoRoots(explicit?: string): string[] {
  return uniq([
    explicit ?? "",
    process.env.YEP_DEPLOY_REPO_ROOT ?? "",
    process.cwd(),
    path.resolve(__dirname, "../../../.."),
  ]);
}

/**
 * The deploy entrypoint differs per platform:
 *   - macOS / Linux: the bash script `scripts/deploy.sh`
 *   - Windows: the PowerShell script `scripts/deploy.ps1`
 * Both expose the same CLI flags so the API contract is unchanged.
 */
function deployScriptName(): string {
  return process.platform === "win32" ? "deploy.ps1" : "deploy.sh";
}

export function getDeploymentAvailability(options?: DeployRoutesOptions): {
  available: boolean;
  reason?: string;
  repoRoot?: string;
  scriptPath?: string;
} {
  for (const repoRoot of getCandidateRepoRoots(options?.repoRoot)) {
    const scriptPath = path.join(repoRoot, "scripts", deployScriptName());
    if (fs.existsSync(scriptPath)) {
      return {
        available: true,
        repoRoot,
        scriptPath,
      };
    }
  }

  return {
    available: false,
    reason: `scripts/${deployScriptName()} was not found. Set YEP_DEPLOY_REPO_ROOT to the repository root to enable remote deploy actions.`,
  };
}

function validateDeviceId(deviceId: unknown): string | undefined {
  if (deviceId === undefined || deviceId === null || deviceId === "") {
    return undefined;
  }
  if (typeof deviceId !== "string") {
    throw new Error("deviceId must be a string.");
  }
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(deviceId)) {
    throw new Error("deviceId contains unsupported characters.");
  }
  return deviceId;
}

function getAction(actionId: unknown): DeploymentAction {
  const action = DEPLOYMENT_ACTIONS.find((item) => item.id === actionId);
  if (!action) {
    throw new Error("Unknown deploy action.");
  }
  return action;
}

function parseRestartTargets(value: unknown): DeploymentRestartTargets {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("restartTargets must be an object.");
  }

  const input = value as Record<string, unknown>;
  const targets: DeploymentRestartTargets = {};
  if ("server" in input) targets.server = input.server === true;
  if ("codexBridge" in input) {
    targets.codexBridge = input.codexBridge === true;
  }
  if ("claudeBridge" in input) {
    targets.claudeBridge = input.claudeBridge === true;
  }
  return targets;
}

function hasRestartTargets(targets: DeploymentRestartTargets): boolean {
  return (
    targets.server === true ||
    targets.codexBridge === true ||
    targets.claudeBridge === true
  );
}

function buildServicesRestartArgs(targets: DeploymentRestartTargets): string[] {
  if (!hasRestartTargets(targets)) {
    throw new Error("Select at least one service to restart.");
  }

  const args = ["--restart-only"];
  if (targets.server) {
    args.push("--server-only");
  } else {
    args.push("--no-server", "--no-apk");
  }
  if (targets.codexBridge) {
    args.push("--restart-codex-bridge");
  }
  if (targets.claudeBridge) {
    args.push("--restart-claude-bridge");
  }
  return args;
}

function appendOptionalRestartTargetArgs(
  action: DeploymentAction,
  args: string[],
  targets: DeploymentRestartTargets,
): void {
  if (!hasRestartTargets(targets)) return;
  if (!action.supportsRestartTargets) {
    throw new Error(
      "Restart target options are not supported for this action.",
    );
  }

  if (targets.server === false) {
    throw new Error(
      "Use the services-restart action to restart sidecars without the web/API server.",
    );
  }
  if (targets.codexBridge) {
    args.push("--restart-codex-bridge");
  }
  if (targets.claudeBridge) {
    args.push("--restart-claude-bridge");
  }
}

export function buildDeployArgs(input: StartDeploymentRequest): {
  action: DeploymentAction;
  args: string[];
} {
  const action = getAction(input.action);
  const restartTargets = parseRestartTargets(input.restartTargets);
  if (action.id === "services-restart") {
    return {
      action,
      args: buildServicesRestartArgs(restartTargets),
    };
  }

  const args = [...action.args];
  const buildType = input.buildType === "debug" ? "debug" : "release";
  const deviceId = validateDeviceId(input.deviceId);

  if (action.supportsSkipChecks && input.skipChecks) {
    args.push("--skip-checks");
  }

  if (action.supportsBuildType || action.id === "apk-install-existing") {
    args.push(buildType === "debug" ? "--debug" : "--release");
  }

  if (action.supportsInstall && input.install === false) {
    args.push("--no-install");
  }

  if (deviceId) {
    args.push("--device", deviceId);
  }

  appendOptionalRestartTargetArgs(action, args, restartTargets);

  return { action, args };
}

function quoteCommandArg(arg: string): string {
  return /[\s"']/u.test(arg) ? JSON.stringify(arg) : arg;
}

function getApkPath(repoRoot: string, buildType: ApkBuildType): string {
  return path.join(
    repoRoot,
    "packages",
    "mobile",
    "src-tauri",
    "gen",
    "android",
    "app",
    "build",
    "outputs",
    "apk",
    "universal",
    buildType,
    `app-universal-${buildType}.apk`,
  );
}

async function readApkInfo(
  repoRoot: string | undefined,
  buildType: ApkBuildType,
  buildTimes?: Map<ApkBuildType, string>,
): Promise<(DeploymentApkInfo & { filePath: string }) | null> {
  if (!repoRoot) return null;
  const filePath = getApkPath(repoRoot, buildType);

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return null;

    return {
      buildType,
      fileName: path.basename(filePath),
      filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      builtAt: buildTimes?.get(buildType) ?? stat.mtime.toISOString(),
      downloadPath: `/deploy/apk/download?buildType=${buildType}`,
    };
  } catch {
    return null;
  }
}

function toPublicApkInfo(
  info: DeploymentApkInfo & { filePath: string },
): DeploymentApkInfo {
  const { filePath: _filePath, ...publicInfo } = info;
  return publicInfo;
}

async function readApkArtifacts(
  repoRoot: string | undefined,
  buildTimes?: Map<ApkBuildType, string>,
): Promise<Array<DeploymentApkInfo & { filePath: string }>> {
  const artifacts = await Promise.all([
    readApkInfo(repoRoot, "release", buildTimes),
    readApkInfo(repoRoot, "debug", buildTimes),
  ]);
  return artifacts
    .filter(
      (artifact): artifact is DeploymentApkInfo & { filePath: string } =>
        !!artifact,
    )
    .sort(
      (a, b) => new Date(b.builtAt).getTime() - new Date(a.builtAt).getTime(),
    );
}

async function readLatestApkInfo(
  repoRoot: string | undefined,
  buildTimes?: Map<ApkBuildType, string>,
): Promise<(DeploymentApkInfo & { filePath: string }) | null> {
  const artifacts = await readApkArtifacts(repoRoot, buildTimes);
  return artifacts[0] ?? null;
}

function parseApkBuildType(value: unknown): ApkBuildType | undefined {
  if (value === "release" || value === "debug") return value;
  if (value === undefined || value === null || value === "") return undefined;
  throw new Error("Unsupported APK build type.");
}

function deploymentJobBuildsApk(job: DeploymentJob): boolean {
  if (job.status !== "succeeded" || !job.finishedAt) return false;
  if (job.args.includes("--no-build")) return false;
  return (
    job.action === "apk" || job.action === "apk-build" || job.action === "full"
  );
}

function getDeploymentJobApkBuildType(job: DeploymentJob): ApkBuildType {
  return job.args.includes("--debug") ? "debug" : "release";
}

async function readSuccessfulApkBuildTimes(
  dataDir: string | undefined,
): Promise<Map<ApkBuildType, string>> {
  const records = await listJobRecords(dataDir);
  const jobs = await Promise.all(
    records.map((record) => hydrateJob(dataDir, record)),
  );
  const buildTimes = new Map<ApkBuildType, string>();

  for (const job of jobs) {
    if (!deploymentJobBuildsApk(job)) continue;
    const buildType = getDeploymentJobApkBuildType(job);
    const finishedAt = job.finishedAt;
    if (!finishedAt) continue;

    const existing = buildTimes.get(buildType);
    if (!existing || finishedAt > existing) {
      buildTimes.set(buildType, finishedAt);
    }
  }

  return buildTimes;
}

function getDeployDir(dataDir?: string): string {
  return path.join(dataDir ?? defaultDataDir(), "deploy");
}

function getJobsDir(dataDir?: string): string {
  return path.join(getDeployDir(dataDir), "jobs");
}

function getLogsDir(dataDir?: string): string {
  return path.join(getDeployDir(dataDir), "logs");
}

async function ensureDeployDirs(dataDir?: string): Promise<void> {
  await Promise.all([
    fsp.mkdir(getJobsDir(dataDir), { recursive: true }),
    fsp.mkdir(getLogsDir(dataDir), { recursive: true }),
  ]);
}

function getJobPath(dataDir: string | undefined, id: string): string {
  return path.join(getJobsDir(dataDir), `${id}.json`);
}

async function readJobRecord(
  dataDir: string | undefined,
  id: string,
): Promise<DeploymentJobRecord | null> {
  try {
    const raw = await fsp.readFile(getJobPath(dataDir, id), "utf-8");
    return JSON.parse(raw) as DeploymentJobRecord;
  } catch {
    return null;
  }
}

async function writeJobRecord(
  dataDir: string | undefined,
  record: DeploymentJobRecord,
): Promise<void> {
  await ensureDeployDirs(dataDir);
  await fsp.writeFile(
    getJobPath(dataDir, record.id),
    JSON.stringify(record, null, 2),
  );
}

function isProcessRunning(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLogTail(logPath: string): Promise<string> {
  try {
    const stat = await fsp.stat(logPath);
    const start = Math.max(0, stat.size - MAX_LOG_BYTES);
    const length = stat.size - start;
    const handle = await fsp.open(logPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function hydrateJob(
  dataDir: string | undefined,
  record: DeploymentJobRecord,
): Promise<DeploymentJob> {
  let current = record;
  const log = await readLogTail(record.logPath);

  if (record.status === "running" && !isProcessRunning(record.pid)) {
    const now = new Date().toISOString();
    current = {
      ...record,
      status: log.includes("Deploy complete.") ? "succeeded" : "failed",
      updatedAt: now,
      finishedAt: now,
      exitCode: null,
      signal: null,
    };
    await writeJobRecord(dataDir, current);
  }

  const { logPath: _logPath, ...job } = current;
  return { ...job, log };
}

async function listJobRecords(
  dataDir: string | undefined,
): Promise<DeploymentJobRecord[]> {
  try {
    await ensureDeployDirs(dataDir);
    const files = await fsp.readdir(getJobsDir(dataDir));
    const records = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJobRecord(dataDir, file.replace(/\.json$/u, ""))),
    );
    return records.filter((record): record is DeploymentJobRecord => !!record);
  } catch {
    return [];
  }
}

async function findCurrentJob(
  dataDir: string | undefined,
): Promise<DeploymentJob | null> {
  const records = await listJobRecords(dataDir);
  records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const record of records) {
    const job = await hydrateJob(dataDir, record);
    if (job.status === "running") return job;
  }
  return null;
}

async function pruneOldJobs(dataDir: string | undefined): Promise<void> {
  const records = await listJobRecords(dataDir);
  records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const stale of records.slice(MAX_JOBS)) {
    await Promise.allSettled([
      fsp.unlink(getJobPath(dataDir, stale.id)),
      fsp.unlink(stale.logPath),
    ]);
  }
}

async function readPackageVersion(repoRoot?: string): Promise<string | null> {
  if (!repoRoot) return null;
  try {
    const raw = await fsp.readFile(
      path.join(repoRoot, "package.json"),
      "utf-8",
    );
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function readStagedBuildInfo(
  repoRoot?: string,
): Promise<DeploymentStatusResponse["stagedBuild"]> {
  if (!repoRoot) return null;
  try {
    const raw = await fsp.readFile(
      path.join(repoRoot, "dist", "npm-package", "build-info.json"),
      "utf-8",
    );
    const info = JSON.parse(raw) as {
      version?: string;
      buildId?: string;
      builtAt?: string;
    };
    if (!info.version || !info.buildId || !info.builtAt) return null;
    return {
      version: info.version,
      buildId: info.buildId,
      builtAt: info.builtAt,
    };
  } catch {
    return null;
  }
}

async function getGitVersionInfo(
  repoRoot: string,
  ref: string,
): Promise<GitVersionInfo | null> {
  try {
    // Get commit hash
    const { stdout: commitHashFull } = await execFileAsync(
      "git",
      ["rev-parse", ref],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    const fullHash = commitHashFull.trim();

    // Get commit date
    const { stdout: commitDate } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%ci", ref],
      { cwd: repoRoot, encoding: "utf-8" },
    );

    // Get branch name (only for HEAD)
    let branch = "unknown";
    if (ref === "HEAD") {
      try {
        const { stdout: branchOutput } = await execFileAsync(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd: repoRoot, encoding: "utf-8" },
        );
        branch = branchOutput.trim();
      } catch {
        // Branch name is optional
      }
    } else {
      branch = ref;
    }

    // Get version from package.json
    const version = await readPackageVersion(repoRoot);

    return {
      commitHash: fullHash.slice(0, 8),
      commitHashFull: fullHash,
      commitDate: commitDate.trim(),
      branch,
      version: version ?? "unknown",
    };
  } catch {
    return null;
  }
}

async function getLocalGitVersion(
  repoRoot?: string,
): Promise<GitVersionInfo | null> {
  if (!repoRoot) return null;
  return getGitVersionInfo(repoRoot, "HEAD");
}

async function getGithubVersion(
  repoRoot?: string,
  fresh = false,
): Promise<GitVersionInfo | null> {
  if (!repoRoot) return null;
  if (fresh) {
    // Best-effort refresh of the local remote-tracking ref so that an
    // explicit "Check Updates" reflects a push made from another machine.
    // Any failure (offline, auth, no remote) falls back to the cached
    // origin/main so the call never hard-fails.
    await execFileAsync("git", ["fetch", "origin"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 15000,
    }).catch(() => undefined);
  }
  try {
    // Reads the (now possibly updated) local git cache for origin/main
    return getGitVersionInfo(repoRoot, "origin/main");
  } catch {
    return null;
  }
}

async function getStableVersion(
  repoRoot?: string,
): Promise<GitVersionInfo | null> {
  if (!repoRoot) return null;
  try {
    const raw = await fsp.readFile(
      path.join(repoRoot, "dist", "npm-package", "build-info.json"),
      "utf-8",
    );
    const info = JSON.parse(raw) as {
      version?: string;
      gitCommit?: string;
      builtAt?: string;
      gitBranch?: string;
    };

    if (!info.gitCommit || !info.builtAt) return null;

    // Get commit date from git
    let commitDate = info.builtAt;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", "-1", "--format=%ci", info.gitCommit],
        { cwd: repoRoot, encoding: "utf-8" },
      );
      commitDate = stdout.trim();
    } catch {
      // Use builtAt as fallback
    }

    return {
      commitHash: info.gitCommit.slice(0, 8),
      commitHashFull: info.gitCommit,
      commitDate,
      branch: info.gitBranch ?? "unknown",
      version: info.version ?? "unknown",
    };
  } catch {
    return null;
  }
}

function getAdbPath(): string {
  if (process.env.ADB_PATH) return process.env.ADB_PATH;
  const androidHome =
    process.env.ANDROID_HOME || "/opt/homebrew/share/android-commandlinetools";
  return path.join(androidHome, "platform-tools", "adb");
}

function parseAdbDevices(stdout: string): AdbDevice[] {
  return stdout
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", state = "", ...rest] = line.split(/\s+/u);
      const fields = new Map(
        rest
          .map((part) => part.split(":"))
          .filter((part): part is [string, string] => part.length === 2),
      );
      return {
        id,
        state,
        model: fields.get("model"),
        product: fields.get("product"),
      };
    })
    .filter((device) => device.id && device.state);
}

async function getAdbStatus(): Promise<DeploymentStatusResponse["adb"]> {
  const adbPath = getAdbPath();
  try {
    const { stdout } = await execFileAsync(adbPath, ["devices", "-l"], {
      encoding: "utf-8",
      timeout: 3000,
    });
    return {
      available: true,
      devices: parseAdbDevices(stdout),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      devices: [],
      error: message,
    };
  }
}

async function buildStatus(
  options?: DeployRoutesOptions,
  fresh = false,
): Promise<DeploymentStatusResponse> {
  const availability = getDeploymentAvailability(options);
  const [adb, packageVersion, stagedBuild] = await Promise.all([
    getAdbStatus(),
    readPackageVersion(availability.repoRoot),
    readStagedBuildInfo(availability.repoRoot),
  ]);
  const currentJob = await findCurrentJob(options?.dataDir);
  const successfulApkBuildTimes = await readSuccessfulApkBuildTimes(
    options?.dataDir,
  );
  const apkArtifacts = await readApkArtifacts(
    availability.repoRoot,
    successfulApkBuildTimes,
  );

  // Get Git version information
  const [localGitVersion, githubVersion, stableVersion] = await Promise.all([
    getLocalGitVersion(availability.repoRoot),
    getGithubVersion(availability.repoRoot, fresh),
    getStableVersion(availability.repoRoot),
  ]);

  // Check if updates are available.
  // Compare commit hashes (not dates) against the deployed build baseline
  // (stableVersion = dist/npm-package/build-info.json). Date comparison was
  // fragile (rebases/amended commits, clock skew) and could never reflect a
  // push from another machine because origin/main was never fetched.
  let hasLocalUpdate = false;
  let hasGithubUpdate = false;

  if (stableVersion && localGitVersion) {
    hasLocalUpdate =
      localGitVersion.commitHashFull !== stableVersion.commitHashFull;
  }

  if (stableVersion && githubVersion) {
    hasGithubUpdate =
      githubVersion.commitHashFull !== stableVersion.commitHashFull;
  }

  return {
    ...availability,
    packageVersion,
    stagedBuild,
    actions: DEPLOYMENT_ACTIONS,
    adb,
    apk: {
      latest: apkArtifacts[0] ? toPublicApkInfo(apkArtifacts[0]) : null,
      artifacts: apkArtifacts.map(toPublicApkInfo),
    },
    currentJob,
    localGitVersion,
    githubVersion,
    stableVersion,
    hasLocalUpdate,
    hasGithubUpdate,
  };
}

export async function startDeploymentJob(
  options: DeployRoutesOptions | undefined,
  input: StartDeploymentRequest,
): Promise<DeploymentJob> {
  const availability = getDeploymentAvailability(options);
  if (
    !availability.available ||
    !availability.repoRoot ||
    !availability.scriptPath
  ) {
    throw new Error(availability.reason ?? "Remote deploy is not available.");
  }

  const currentJob = await findCurrentJob(options?.dataDir);
  if (currentJob) {
    const error = new Error("A deploy job is already running.") as Error & {
      status?: number;
    };
    error.status = 409;
    throw error;
  }

  // Handle git-pull-update action separately
  if (input.action === "git-pull-update") {
    return await startGitPullAndDeploy(options, availability.repoRoot);
  }

  const { action, args } = buildDeployArgs(input);
  await ensureDeployDirs(options?.dataDir);

  const id = randomUUID();
  const now = new Date().toISOString();
  const logPath = path.join(getLogsDir(options?.dataDir), `${id}.log`);
  const command = [
    process.platform === "win32"
      ? `powershell -File scripts/${deployScriptName()}`
      : `scripts/${deployScriptName()}`,
    ...args,
  ]
    .map(quoteCommandArg)
    .join(" ");
  await fsp.writeFile(
    logPath,
    `$ ${command}\nstartedAt=${now}\nrepoRoot=${availability.repoRoot}\n\n`,
  );

  const record: DeploymentJobRecord = {
    id,
    action: action.id,
    args,
    command,
    status: "running",
    startedAt: now,
    updatedAt: now,
    logPath,
  };
  await writeJobRecord(options?.dataDir, record);

  const logFd = fs.openSync(logPath, "a");

  // On Windows the deploy entrypoint is a PowerShell script, so we must invoke
  // powershell explicitly. On POSIX we exec the script directly.
  const spawnCommand =
    process.platform === "win32" ? "powershell" : availability.scriptPath;
  const spawnArgs =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          availability.scriptPath,
          ...args,
        ]
      : args;

  const child = spawn(spawnCommand, spawnArgs, {
    cwd: availability.repoRoot,
    detached: true,
    // 剥离 WorkBuddy 安全删除守卫，避免 vite build 在 emptyDir 时卡在 trash 确认。
    env: cleanEnv(),
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);

  const spawnedRecord: DeploymentJobRecord = {
    ...record,
    pid: child.pid,
    updatedAt: new Date().toISOString(),
  };
  await writeJobRecord(options?.dataDir, spawnedRecord);
  await pruneOldJobs(options?.dataDir);

  child.on("exit", (exitCode, signal) => {
    const finishedAt = new Date().toISOString();
    void writeJobRecord(options?.dataDir, {
      ...spawnedRecord,
      status: exitCode === 0 ? "succeeded" : "failed",
      exitCode,
      signal,
      updatedAt: finishedAt,
      finishedAt,
    });
  });

  child.on("error", (err) => {
    const finishedAt = new Date().toISOString();
    fs.appendFileSync(logPath, `\n[deploy-api] spawn error: ${err.message}\n`);
    void writeJobRecord(options?.dataDir, {
      ...spawnedRecord,
      status: "failed",
      exitCode: null,
      signal: null,
      updatedAt: finishedAt,
      finishedAt,
    });
  });

  child.unref();

  return hydrateJob(options?.dataDir, spawnedRecord);
}

export function createDeployRoutes(options?: DeployRoutesOptions): Hono {
  const routes = new Hono();

  routes.get("/status", async (c) => {
    const fresh =
      c.req.query("fresh") === "1" || c.req.query("fresh") === "true";
    return c.json(await buildStatus(options, fresh));
  });

  routes.get("/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const record = await readJobRecord(options?.dataDir, id);
    if (!record) {
      return c.json({ error: "Deploy job not found" }, 404);
    }
    return c.json({ job: await hydrateJob(options?.dataDir, record) });
  });

  routes.get("/apk/download", async (c) => {
    const availability = getDeploymentAvailability(options);
    if (!availability.available || !availability.repoRoot) {
      return c.json(
        { error: availability.reason ?? "Remote deploy is not available." },
        404,
      );
    }

    let artifact: (DeploymentApkInfo & { filePath: string }) | null;
    try {
      const buildType = parseApkBuildType(c.req.query("buildType"));
      const successfulApkBuildTimes = await readSuccessfulApkBuildTimes(
        options?.dataDir,
      );
      artifact = buildType
        ? await readApkInfo(
            availability.repoRoot,
            buildType,
            successfulApkBuildTimes,
          )
        : await readLatestApkInfo(
            availability.repoRoot,
            successfulApkBuildTimes,
          );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }

    if (!artifact) {
      return c.json({ error: "APK artifact not found." }, 404);
    }

    c.header("Content-Type", "application/vnd.android.package-archive");
    c.header("Content-Length", artifact.size.toString());
    c.header(
      "Content-Disposition",
      `attachment; filename="${artifact.fileName}"`,
    );
    c.header("Cache-Control", "no-store");

    return stream(c, async (s) => {
      const readable = fs.createReadStream(artifact.filePath);
      for await (const chunk of readable) {
        await s.write(chunk);
      }
    });
  });

  routes.post("/jobs", async (c) => {
    try {
      const body = await c.req.json<StartDeploymentRequest>().catch(() => ({}));
      const job = await startDeploymentJob(options, body);
      return c.json({ job }, 202);
    } catch (err) {
      const status =
        typeof (err as { status?: unknown }).status === "number"
          ? ((err as { status: number }).status as 400 | 409 | 500)
          : 400;
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, status);
    }
  });

  return routes;
}
