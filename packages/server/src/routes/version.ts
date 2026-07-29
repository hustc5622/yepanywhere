import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Hono } from "hono";
import { type RuntimeBuildInfo, getRuntimeBuildInfo } from "../build-info.js";
import { isNewerSemver } from "../utils/semver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

/**
 * Get version from git describe (for dev mode)
 * Returns something like "v0.1.7" or "v0.1.7-3-g050bfd2" (3 commits after tag)
 */
async function getGitVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git describe --tags --always", {
      encoding: "utf-8",
    });
    const version = stdout.trim();
    return version?.replace(/^v/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Read the current package version from package.json
 */
async function getCurrentVersion(): Promise<string> {
  try {
    // In production (npm package), package.json is in the parent of dist/
    // In development, it's in packages/server/
    const packageJsonPath = path.resolve(__dirname, "../../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const version = packageJson.version || "unknown";

    // 0.0.1 is the workspace version - we're in dev mode, use git instead
    if (version === "0.0.1") {
      return (await getGitVersion()) || "dev";
    }

    return version;
  } catch {
    return "unknown";
  }
}

// GitHub repository for version checking (can be overridden via env)
const GITHUB_REPO =
  process.env.YEP_UPDATE_GITHUB_REPO || "Gumekn/yepanywhere_pb_fork";

// Cache for update server check (24 hour TTL for routine app traffic)
let cachedLatestVersion: { version: string; timestamp: number } | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch the latest version from GitHub Releases API.
 * Falls back to null if no releases are found or on error.
 */
async function getLatestVersion(
  currentVersion: string,
  options?: { forceRefresh?: boolean },
): Promise<string | null> {
  // Return cached value if fresh
  if (
    !options?.forceRefresh &&
    cachedLatestVersion &&
    Date.now() - cachedLatestVersion.timestamp < CACHE_TTL_MS
  ) {
    return cachedLatestVersion.version;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "yepanywhere-version-check",
    };

    // Fetch latest release from GitHub
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        signal: controller.signal,
        headers,
      },
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      // 404 means no releases published yet
      if (response.status === 404) {
        cachedLatestVersion = {
          version: currentVersion,
          timestamp: Date.now(),
        };
        return currentVersion;
      }
      return null;
    }

    const data = (await response.json()) as {
      tag_name?: string;
      name?: string;
    };

    // Extract version from tag_name (e.g., "v0.1.11" -> "0.1.11")
    let version = data.tag_name || data.name || null;
    if (version) {
      version = version.replace(/^v/, ""); // Remove leading 'v' if present
      cachedLatestVersion = { version, timestamp: Date.now() };
    }

    return version;
  } catch {
    // Network error, timeout, etc. - fail silently
    return null;
  }
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Build metadata for the server process currently handling requests. */
  build: RuntimeBuildInfo;
  /** Session resume protocol version supported by this server. */
  resumeProtocolVersion: number;
  /** Feature capabilities supported by this server. Used by clients to show/hide UI. */
  capabilities: string[];
  /** Device bridge availability and update state. */
  deviceBridgeState?: DeviceBridgeState;
  /** Installed managed bridge binary version when known. */
  deviceBridgeVersion?: string | null;
  /** Latest bridge release version when known. */
  latestDeviceBridgeVersion?: string | null;
}

/** Resume protocol version with nonce challenge + proof binding. */
export const RESUME_PROTOCOL_VERSION = 2;

/** Base capabilities always advertised. */
const BASE_CAPABILITIES = ["git-status"];

export type DeviceBridgeState =
  | "available"
  | "downloadable"
  | "update-available"
  | "unavailable";

export interface DeviceBridgeStatus {
  state: DeviceBridgeState;
  installedVersion?: string | null;
  latestVersion?: string | null;
}

export interface VersionRouteOptions {
  /** Dynamic device bridge state: available (binary exists), downloadable (ADB found, no binary), unavailable (no ADB). */
  getDeviceBridgeState?: () => DeviceBridgeState;
  /** Detailed device bridge status for version-aware update prompts. */
  getDeviceBridgeStatus?: (options?: {
    forceRefresh?: boolean;
  }) => Promise<DeviceBridgeStatus>;
  /** Whether the user has opted into the device bridge feature. */
  isDeviceBridgeEnabled?: () => boolean;
  /** Unique installation ID for update analytics. */
  installId?: string;
  /** Whether voice input is enabled (default: true). */
  voiceInputEnabled?: boolean;
  /** Whether local deploy actions can be triggered through the server. */
  isDeploymentAvailable?: () => boolean;
}

export interface ServerCompatibilityInfo {
  appVersion: string;
  resumeProtocolVersion: number;
  renderProtocolVersion?: number;
  capabilities: string[];
}

function getCapabilitiesForDeviceBridgeState(
  state: DeviceBridgeState,
  enabled: boolean,
): string[] {
  if (state === "unavailable") {
    return [];
  }

  const capabilities = ["deviceBridge-available"];
  if (!enabled) {
    return capabilities;
  }

  if (state === "available") {
    capabilities.push("deviceBridge");
    return capabilities;
  }

  capabilities.push("deviceBridge-download");
  if (state === "update-available") {
    capabilities.push("deviceBridge-update");
  }
  return capabilities;
}

export function getServerCapabilities(options?: VersionRouteOptions): string[] {
  const capabilities = [...BASE_CAPABILITIES];
  if (options?.voiceInputEnabled !== false) {
    capabilities.push("voiceInput");
  }
  if (options?.isDeploymentAvailable?.()) {
    capabilities.push("deployment");
  }
  const deviceBridgeState = options?.getDeviceBridgeState?.() ?? "unavailable";
  const enabled = options?.isDeviceBridgeEnabled?.() ?? false;
  capabilities.push(
    ...getCapabilitiesForDeviceBridgeState(deviceBridgeState, enabled),
  );
  return capabilities;
}

export function getServerCompatibilityInfo(
  options?: VersionRouteOptions,
): Promise<ServerCompatibilityInfo> {
  return getCurrentVersion().then((appVersion) => ({
    appVersion,
    resumeProtocolVersion: RESUME_PROTOCOL_VERSION,
    capabilities: getServerCapabilities(options),
  }));
}

export function createVersionRoutes(options?: VersionRouteOptions): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const current = await getCurrentVersion();
    const build = await getRuntimeBuildInfo();
    const fresh =
      c.req.query("fresh") === "1" || c.req.query("fresh") === "true";
    const deviceBridgeStatus = options?.getDeviceBridgeStatus
      ? await options.getDeviceBridgeStatus({ forceRefresh: fresh })
      : { state: options?.getDeviceBridgeState?.() ?? "unavailable" };
    const enabled = options?.isDeviceBridgeEnabled?.() ?? false;
    const capabilities = [
      ...BASE_CAPABILITIES,
      ...(options?.voiceInputEnabled !== false ? ["voiceInput"] : []),
      ...(options?.isDeploymentAvailable?.() ? ["deployment"] : []),
      ...getCapabilitiesForDeviceBridgeState(deviceBridgeStatus.state, enabled),
    ];

    // For dev versions like "v0.1.7-3-g050bfd2", extract base version "v0.1.7"
    // to compare against the update server.
    const baseVersion = current.split("-")[0] || current;
    const latest = await getLatestVersion(baseVersion, {
      forceRefresh: fresh,
    });
    const updateAvailable = latest ? isNewerSemver(baseVersion, latest) : false;

    const info: VersionInfo = {
      current,
      latest,
      updateAvailable,
      build,
      resumeProtocolVersion: RESUME_PROTOCOL_VERSION,
      capabilities,
      deviceBridgeState: deviceBridgeStatus.state,
      deviceBridgeVersion: deviceBridgeStatus.installedVersion ?? null,
      latestDeviceBridgeVersion: deviceBridgeStatus.latestVersion ?? null,
    };

    return c.json(info);
  });

  return routes;
}
