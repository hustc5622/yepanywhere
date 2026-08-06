import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Which release line this build belongs to.
 *
 * - `upstream` — the public kzahel/yepanywhere line, served by the public
 *   update service.
 * - `fork` — this repository's independent line, tagged `ya-v*`.
 * - `dev` — local development or ad-hoc verification; not a release at all.
 *
 * Decided at build time and baked into build-info.json. Never inferred at
 * runtime from version numbers: fork and upstream versions overlap numerically,
 * so the number alone cannot identify the line. See docs/project/versioning.md.
 */
export type ReleaseChannel = "upstream" | "fork" | "dev";

const RELEASE_CHANNELS: readonly string[] = ["upstream", "fork", "dev"];

export function parseReleaseChannel(value: unknown): ReleaseChannel | null {
  return typeof value === "string" && RELEASE_CHANNELS.includes(value)
    ? (value as ReleaseChannel)
    : null;
}

export interface BuildInfo {
  schemaVersion: 1;
  buildId: string;
  version: string;
  releaseChannel: ReleaseChannel;
  gitDescribe: string | null;
  gitCommit: string | null;
  gitBranch: string | null;
  gitDirty: boolean | null;
  builtAt: string;
  buildProfile: string;
  basePath: string;
}

export interface RuntimeBuildInfo extends BuildInfo {
  source: "bundle" | "dev";
  entrypoint: string | null;
  nodeEnv: string | null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLED_BUILD_INFO_PATH = path.resolve(__dirname, "../build-info.json");

let cachedBuildInfo: RuntimeBuildInfo | null = null;

function parseBundledBuildInfo(raw: unknown): BuildInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const info = raw as Partial<BuildInfo>;
  if (
    info.schemaVersion !== 1 ||
    typeof info.buildId !== "string" ||
    typeof info.version !== "string" ||
    typeof info.builtAt !== "string" ||
    typeof info.buildProfile !== "string" ||
    typeof info.basePath !== "string"
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    buildId: info.buildId,
    version: info.version,
    // Bundles built before releaseChannel existed carry no such field. They can
    // only have come from this repository, so they belong to the fork line —
    // and defaulting to `fork` keeps the update check disabled, which is the
    // safe direction to fail. `schemaVersion` deliberately stays at 1: bumping
    // it would make this parser reject every already-deployed bundle.
    releaseChannel: parseReleaseChannel(info.releaseChannel) ?? "fork",
    gitDescribe: typeof info.gitDescribe === "string" ? info.gitDescribe : null,
    gitCommit: typeof info.gitCommit === "string" ? info.gitCommit : null,
    gitBranch: typeof info.gitBranch === "string" ? info.gitBranch : null,
    gitDirty: typeof info.gitDirty === "boolean" ? info.gitDirty : null,
    builtAt: info.builtAt,
    buildProfile: info.buildProfile,
    basePath: info.basePath,
  };
}

function readBundledBuildInfo(): BuildInfo | null {
  try {
    if (!fs.existsSync(BUNDLED_BUILD_INFO_PATH)) return null;
    return parseBundledBuildInfo(
      JSON.parse(fs.readFileSync(BUNDLED_BUILD_INFO_PATH, "utf-8")),
    );
  } catch {
    return null;
  }
}

async function git(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: process.cwd(),
      encoding: "utf-8",
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function createDevBuildInfo(): Promise<BuildInfo> {
  const [gitDescribe, gitCommit, gitBranch, gitStatus] = await Promise.all([
    git(["describe", "--tags", "--always"]),
    git(["rev-parse", "HEAD"]),
    git(["branch", "--show-current"]),
    git(["status", "--porcelain"]),
  ]);
  const builtAt = new Date().toISOString();
  const version = gitDescribe?.replace(/^v/, "") ?? "dev";
  const shortCommit = gitCommit?.slice(0, 12) ?? "nogit";

  return {
    schemaVersion: 1,
    buildId: `dev-${shortCommit}`,
    version,
    // A dev tree is not a release. YEP_RELEASE_CHANNEL is an explicit escape
    // hatch (tests, reproducing channel-specific behaviour), not inference.
    releaseChannel:
      parseReleaseChannel(process.env.YEP_RELEASE_CHANNEL) ?? "dev",
    gitDescribe: gitDescribe?.replace(/^v/, "") ?? null,
    gitCommit,
    gitBranch,
    gitDirty: gitStatus !== null ? gitStatus.length > 0 : null,
    builtAt,
    buildProfile: process.env.YEP_BUILD_PROFILE ?? "dev",
    basePath: process.env.BASE_PATH ?? "/",
  };
}

export async function getRuntimeBuildInfo(): Promise<RuntimeBuildInfo> {
  if (cachedBuildInfo) return cachedBuildInfo;

  const bundled = readBundledBuildInfo();
  const base = bundled ?? (await createDevBuildInfo());
  cachedBuildInfo = {
    ...base,
    source: bundled ? "bundle" : "dev",
    entrypoint: process.argv[1] ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
  };
  return cachedBuildInfo;
}
