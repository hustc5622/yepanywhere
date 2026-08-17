import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ALL_PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
} from "@yep-anywhere/shared";
import type { Level as LogLevel } from "pino";
import {
  CODEX_CLEAR_MCP_APP_SERVER_ARGS,
  CODEX_FULL_MCP_APP_SERVER_ARGS,
  CODEX_STANDARD_MCP_APP_SERVER_ARGS,
} from "./codex/mcp-profile.js";
import {
  getDefaultCodexHomeDir,
  getDefaultCodexSessionsDir,
} from "./projects/codex-scanner.js";

/**
 * Get the data directory for yep-anywhere state files.
 * Supports profiles for running multiple instances (like Chrome profiles).
 *
 * Priority:
 * 1. YEP_ANYWHERE_DATA_DIR - Full path override
 * 2. YEP_ANYWHERE_PROFILE - Appends suffix: ~/.yep-anywhere-{profile}
 * 3. Default: ~/.yep-anywhere
 */
export function getDataDir(): string {
  if (process.env.YEP_ANYWHERE_DATA_DIR) {
    return process.env.YEP_ANYWHERE_DATA_DIR;
  }
  const profile = process.env.YEP_ANYWHERE_PROFILE;
  if (profile) {
    return path.join(os.homedir(), `.yep-anywhere-${profile}`);
  }
  return path.join(os.homedir(), ".yep-anywhere");
}

/**
 * Server configuration loaded from environment variables.
 */
export interface Config {
  /** Data directory for yep-anywhere state files (indexes, metadata, uploads, etc.) */
  dataDir: string;
  /** Directory where Claude projects are stored */
  claudeProjectsDir: string;
  /** Claude sessions directory (~/.claude/projects) */
  claudeSessionsDir: string;
  /** Gemini sessions directory (~/.gemini/tmp) */
  geminiSessionsDir: string;
  /** Codex sessions directory (~/.codex/sessions) */
  codexSessionsDir: string;
  /** Kimi sessions directory (~/.kimi-code/sessions) */
  kimiSessionsDir: string;
  /** AI title generation for completed first-turn sessions. */
  sessionTitleGeneration: SessionTitleGenerationConfig;
  /** Whether to run the local Codex CLI bridge for `codex --remote ws://...`. */
  codexBridgeEnabled: boolean;
  /** How the Codex CLI bridge is hosted. */
  codexBridgeMode: "embedded" | "external" | "disabled";
  /** Host/interface for the Codex bridge. Defaults to localhost for safety. */
  codexBridgeHost: string;
  /** Port for the Codex bridge WebSocket listener. */
  codexBridgePort: number;
  /** HTTP control URL for an externally managed Codex bridge sidecar. */
  codexBridgeControlUrl: string;
  /** Optional fixed upstream app-server URL. Defaults to a managed local app-server. */
  codexBridgeUpstreamUrl?: string;
  /** First port to try for the managed upstream app-server. */
  codexBridgeUpstreamStartPort: number;
  /** Extra args passed to the managed light `codex app-server` upstream. */
  codexBridgeLightUpstreamArgs: string[];
  /** Extra args passed to the managed clear `codex app-server` upstream. */
  codexBridgeClearUpstreamArgs: string[];
  /** Extra args passed to the managed full `codex app-server` upstream. */
  codexBridgeFullUpstreamArgs: string[];
  /** Host/interface for the OpenCode bridge. Defaults to localhost for safety. */
  opencodeBridgeHost: string;
  /** Port for the OpenCode bridge HTTP listener. */
  opencodeBridgePort: number;
  /** HTTP control URL for the OpenCode CLI bridge sidecar. */
  opencodeBridgeControlUrl: string;
  /** Yep server URL that the OpenCode CLI bridge sidecar forwards requests to. */
  opencodeBridgeServerUrl: string;
  /** Optional fixed OpenCode CLI upstream URL. Defaults to a managed local server. */
  opencodeServerUrl?: string;
  /** First port to try for the managed OpenCode server. */
  opencodeServerStartPort: number;
  /**
   * Periodic full-tree rescan interval for codex session watcher (ms).
   * Helps recover from missed fs.watch events on macOS. 0 disables it.
   */
  codexWatchPeriodicRescanMs: number;
  /**
   * Session index full validation interval (ms).
   * 0 = validate every request (legacy behavior).
   */
  sessionIndexFullValidationMs: number;
  sessionIndexFullValidationMinMs: number;
  sessionIndexMaxConcurrentFullValidations: number;
  /** Session index write lock timeout (ms) for cross-process coordination. */
  sessionIndexWriteLockTimeoutMs: number;
  /** Session index lock staleness threshold (ms). */
  sessionIndexWriteLockStaleMs: number;
  /** Project scanner cache TTL (ms). 0 = rescan every request. */
  projectScanCacheTtlMs: number;
  /** Idle timeout in milliseconds before process cleanup */
  idleTimeoutMs: number;
  /** Default permission mode for new sessions */
  defaultPermissionMode: PermissionMode;
  /** Whether live agent processes are embedded in this server or external. */
  runtimeMode: "embedded" | "external";
  /** Loopback control URL for the external agent runtime. */
  runtimeControlUrl: string;
  /** External agent runtime control port. */
  runtimePort: number;
  /** Bearer token file shared with the external agent runtime. */
  runtimeTokenFile: string;
  /** Server port */
  port: number;
  /** File to write the actual port to after binding (for test harnesses) */
  portFile: string | null;
  /** Host/interface to bind to (default: 127.0.0.1). Use 0.0.0.0 to bind all interfaces. */
  host: string;
  /** Maintenance server port (default: 0 = disabled). Set to enable (e.g., PORT + 1). */
  maintenancePort: number;
  /** File to write the actual maintenance port to after binding (for test harnesses) */
  maintenancePortFile: string | null;
  /** Use mock SDK instead of real Claude SDK */
  useMockSdk: boolean;
  /** Maximum concurrent workers. 0 = unlimited (default for backward compat) */
  maxWorkers: number;
  /** Idle threshold in milliseconds for preemption. Workers idle longer than this can be preempted. */
  idlePreemptThresholdMs: number;
  /** Whether to serve frontend (proxy in dev, static in prod) */
  serveFrontend: boolean;
  /** Vite dev server port for frontend proxy */
  vitePort: number;
  /** Path to built client dist directory */
  clientDistPath: string;
  /** Path to stable (emergency) client dist directory */
  stableDistPath: string;
  /** Maximum upload file size in bytes. 0 = unlimited (default: 100MB) */
  maxUploadSizeBytes: number;
  /** Maximum queue size for pending requests. 0 = unlimited (default: 100) */
  maxQueueSize: number;
  /** Directory for log files. Default: ~/.yep-anywhere/logs */
  logDir: string;
  /** Log filename. Default: server.log */
  logFile: string;
  /** Minimum log level for console. Default: info */
  logLevel: LogLevel;
  /** Minimum log level for file. Default: same as logLevel or LOG_FILE_LEVEL */
  logFileLevel: LogLevel;
  /** Whether to log to file. Default: false */
  logToFile: boolean;
  /** Whether to pretty-print console logs. Default: true */
  logPretty: boolean;
  /** Enabled provider names. Empty = all providers enabled. */
  enabledProviders: string[];
  /** Whether voice input is enabled. Default: true */
  voiceInputEnabled: boolean;
  /** Allowed directory prefixes for serving local images (e.g., ["/tmp"]). Empty = disabled. */
  allowedImagePaths: string[];
  /** Allowed directory prefixes for serving local markdown/text files. Empty = disabled. */
  allowedLocalFilePaths: string[];

  /** Whether cookie-based auth is disabled by env var (--auth-disable or AUTH_DISABLED=true). Used for recovery. */
  authDisabled: boolean;
  /** Cookie signing secret. Auto-generated if not provided. */
  authCookieSecret?: string;
  /** Session TTL in milliseconds. Default: 30 days */
  authSessionTtlMs: number;
  /** Whether port was explicitly set via CLI (prevents runtime changes) */
  cliPortOverride: boolean;
  /** Whether host was explicitly set via CLI (prevents runtime changes) */
  cliHostOverride: boolean;
  /** Whether to open the dashboard in the default browser on startup */
  openBrowser: boolean;
  /** Enable HTTPS with an auto-generated self-signed certificate. */
  httpsSelfSigned: boolean;
  /** Desktop auth token for Tauri app. Requests with matching X-Desktop-Token header bypass auth. */
  desktopAuthToken?: string;
  /**
   * URL path prefix to serve under (e.g. "/yep" when behind a reverse proxy
   * that exposes the server at https://host/yep/...). Empty string = no
   * prefix (default).
   */
  basePath: string;
}

export interface SessionTitleGenerationConfig {
  /** Enabled only when an API key is available unless explicitly disabled. */
  enabled: boolean;
  /** OpenAI-compatible API base URL. May include or omit /v1. */
  apiBase: string;
  /** API key for the OpenAI-compatible endpoint. */
  apiKey?: string;
  /** Model used to produce compact session titles. */
  model: string;
  /** Optional gateway submodule header for internal OpenAI-compatible routers. */
  subModule?: string;
  /** Request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Total model attempts for a recoverable title failure. */
  retryMaxAttempts: number;
  /** Initial retry delay; subsequent attempts use exponential backoff. */
  retryBaseDelayMs: number;
  /** Upper bound for retry backoff and Retry-After delays. */
  retryMaxDelayMs: number;
  /** How far back startup title recovery may inspect sessions. */
  startupBackfillWindowMs: number;
  /** Maximum sessions considered for title recovery per startup. */
  startupBackfillLimit: number;
  /** Maximum concurrent startup title recovery workers. */
  startupBackfillConcurrency: number;
  /** Maximum recent projects whose session indexes are inspected per startup. */
  startupBackfillMaxProjects: number;
}

/**
 * Load configuration from environment variables with defaults.
 */
export function loadConfig(): Config {
  // SERVE_FRONTEND defaults to true (unified server mode)
  // Set SERVE_FRONTEND=false to disable frontend serving (API-only mode)
  const serveFrontend = process.env.SERVE_FRONTEND !== "false";

  // Get data directory (supports profiles for multiple instances)
  const dataDir = getDataDir();
  const serverPort = parseIntOrDefault(process.env.PORT, 3400);
  const runtimeMode =
    process.env.YEP_RUNTIME_MODE?.trim().toLowerCase() === "external"
      ? "external"
      : "embedded";
  const runtimePort = parseIntOrDefault(
    process.env.YEP_RUNTIME_PORT,
    serverPort + 3,
  );

  // Session directories can be overridden via env vars for test isolation
  const claudeSessionsDir =
    process.env.CLAUDE_SESSIONS_DIR ??
    path.join(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
      "projects",
    );
  const geminiSessionsDir =
    process.env.GEMINI_SESSIONS_DIR ??
    path.join(os.homedir(), ".gemini", "tmp");
  const codexSessionsDir =
    process.env.CODEX_SESSIONS_DIR ?? getDefaultCodexSessionsDir();
  // Empty env values must not become an empty local-image allowlist prefix:
  // `${prefix}/` would be "/" and match every absolute path.
  const configuredKimiSessionsDir = process.env.KIMI_SESSIONS_DIR?.trim();
  const configuredKimiCodeHome = process.env.KIMI_CODE_HOME?.trim();
  const kimiSessionsDir =
    configuredKimiSessionsDir ||
    path.join(
      configuredKimiCodeHome || path.join(os.homedir(), ".kimi-code"),
      "sessions",
    );
  const codexBridgePort = parseIntOrDefault(
    process.env.YEP_CODEX_BRIDGE_PORT ?? process.env.CODEX_BRIDGE_PORT,
    4510,
  );
  const opencodeBridgePort = parseIntOrDefault(
    process.env.YEP_OPENCODE_BRIDGE_PORT ?? process.env.OPENCODE_BRIDGE_PORT,
    4520,
  );
  const codexBridgeMode = parseCodexBridgeMode(
    process.env.YEP_CODEX_BRIDGE_MODE ??
      process.env.CODEX_BRIDGE_MODE ??
      process.env.YEP_CODEX_BRIDGE ??
      process.env.CODEX_BRIDGE,
  );
  const legacyCodexBridgeUpstreamArgs =
    process.env.YEP_CODEX_BRIDGE_UPSTREAM_ARGS ??
    process.env.CODEX_BRIDGE_UPSTREAM_ARGS;
  // Enable periodic rescan on macOS (fs.watch misses deep file writes)
  // and Windows (fs.watch({ recursive: true }) can be unreliable for deep trees)
  const defaultCodexWatchPeriodicRescanMs =
    process.platform === "darwin" || process.platform === "win32" ? 5000 : 0;
  const codexWatchPeriodicRescanMs = Math.max(
    0,
    parseIntOrDefault(
      process.env.CODEX_WATCH_PERIODIC_RESCAN_MS,
      defaultCodexWatchPeriodicRescanMs,
    ),
  );
  const sessionIndexFullValidationMs = Math.max(
    0,
    parseIntOrDefault(process.env.SESSION_INDEX_FULL_VALIDATION_MS, 30000),
  );
  // Watcher events for non-Claude providers mark every scope of that provider
  // dirty, which used to force a full validation per scope per event. This is
  // the floor between dir-dirty-driven full passes for one scope.
  const sessionIndexFullValidationMinMs = Math.max(
    0,
    parseIntOrDefault(process.env.SESSION_INDEX_FULL_VALIDATION_MIN_MS, 5000),
  );
  const sessionIndexMaxConcurrentFullValidations = Math.max(
    1,
    parseIntOrDefault(
      process.env.SESSION_INDEX_MAX_CONCURRENT_FULL_VALIDATIONS,
      1,
    ),
  );
  const sessionIndexWriteLockTimeoutMs = Math.max(
    0,
    parseIntOrDefault(process.env.SESSION_INDEX_WRITE_LOCK_TIMEOUT_MS, 2000),
  );
  const sessionIndexWriteLockStaleMs = Math.max(
    1000,
    parseIntOrDefault(process.env.SESSION_INDEX_WRITE_LOCK_STALE_MS, 10000),
  );
  const projectScanCacheTtlMs = Math.max(
    0,
    parseIntOrDefault(process.env.PROJECT_SCAN_CACHE_TTL_MS, 5000),
  );
  const managedUploadsDir = path.join(dataDir, "uploads");
  const extraAllowedImagePaths =
    process.env.ALLOWED_IMAGE_PATHS !== undefined
      ? process.env.ALLOWED_IMAGE_PATHS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : ["/tmp"];
  const codexGeneratedImagesDir = path.join(
    getDefaultCodexHomeDir(),
    "generated_images",
  );
  const codexHomeDir = getDefaultCodexHomeDir();
  const extraAllowedLocalFilePaths =
    process.env.ALLOWED_LOCAL_FILE_PATHS !== undefined
      ? process.env.ALLOWED_LOCAL_FILE_PATHS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const sessionTitleApiKey =
    process.env.SESSION_TITLE_LLM_API_KEY ?? process.env.LLM_API_KEY;
  const sessionTitleApiBase =
    process.env.SESSION_TITLE_LLM_API_BASE ??
    process.env.LLM_API_BASE ??
    "https://api.ohmyrouter.com";
  const sessionTitleGenerationRequested = parseBooleanOrDefault(
    process.env.SESSION_TITLE_GENERATION,
    Boolean(sessionTitleApiKey),
  );
  const sessionTitleGeneration: SessionTitleGenerationConfig = {
    enabled: sessionTitleGenerationRequested && Boolean(sessionTitleApiKey),
    apiBase: sessionTitleApiBase,
    apiKey: sessionTitleApiKey,
    model: process.env.SESSION_TITLE_MODEL ?? "deepseek-v4-pro",
    subModule:
      process.env.SESSION_TITLE_SUB_MODULE ??
      process.env.LLM_SUB_MODULE ??
      getDefaultSessionTitleSubModule(sessionTitleApiBase),
    requestTimeoutMs: Math.max(
      1000,
      parseIntOrDefault(process.env.SESSION_TITLE_TIMEOUT_MS, 120000),
    ),
    retryMaxAttempts: Math.max(
      1,
      parseIntOrDefault(process.env.SESSION_TITLE_RETRY_MAX_ATTEMPTS, 3),
    ),
    retryBaseDelayMs: Math.max(
      0,
      parseIntOrDefault(process.env.SESSION_TITLE_RETRY_BASE_DELAY_MS, 5000),
    ),
    retryMaxDelayMs: Math.max(
      0,
      parseIntOrDefault(process.env.SESSION_TITLE_RETRY_MAX_DELAY_MS, 60000),
    ),
    startupBackfillWindowMs: Math.max(
      0,
      parseIntOrDefault(
        process.env.SESSION_TITLE_BACKFILL_WINDOW_MS,
        7 * 24 * 60 * 60 * 1000,
      ),
    ),
    startupBackfillLimit: Math.max(
      0,
      parseIntOrDefault(process.env.SESSION_TITLE_BACKFILL_LIMIT, 25),
    ),
    startupBackfillConcurrency: Math.max(
      1,
      parseIntOrDefault(process.env.SESSION_TITLE_BACKFILL_CONCURRENCY, 2),
    ),
    startupBackfillMaxProjects: Math.max(
      1,
      parseIntOrDefault(process.env.SESSION_TITLE_BACKFILL_MAX_PROJECTS, 20),
    ),
  };

  return {
    dataDir,
    claudeProjectsDir: process.env.CLAUDE_PROJECTS_DIR ?? claudeSessionsDir,
    claudeSessionsDir,
    geminiSessionsDir,
    codexSessionsDir,
    kimiSessionsDir,
    sessionTitleGeneration,
    codexBridgeEnabled: codexBridgeMode !== "disabled",
    codexBridgeMode,
    codexBridgeHost:
      process.env.YEP_CODEX_BRIDGE_HOST ??
      process.env.CODEX_BRIDGE_HOST ??
      "127.0.0.1",
    codexBridgePort,
    codexBridgeControlUrl:
      process.env.YEP_CODEX_BRIDGE_CONTROL_URL ??
      process.env.CODEX_BRIDGE_CONTROL_URL ??
      `http://127.0.0.1:${codexBridgePort}`,
    codexBridgeUpstreamUrl:
      process.env.YEP_CODEX_BRIDGE_UPSTREAM_URL ??
      process.env.CODEX_BRIDGE_UPSTREAM_URL,
    codexBridgeUpstreamStartPort: parseIntOrDefault(
      process.env.YEP_CODEX_BRIDGE_UPSTREAM_START_PORT ??
        process.env.CODEX_BRIDGE_UPSTREAM_START_PORT,
      codexBridgePort + 1,
    ),
    codexBridgeLightUpstreamArgs: parseCodexBridgeUpstreamArgs(
      process.env.YEP_CODEX_BRIDGE_LIGHT_UPSTREAM_ARGS ??
        legacyCodexBridgeUpstreamArgs,
      DEFAULT_CODEX_BRIDGE_LIGHT_UPSTREAM_ARGS,
    ),
    codexBridgeClearUpstreamArgs: parseCodexBridgeUpstreamArgs(
      process.env.YEP_CODEX_BRIDGE_CLEAR_UPSTREAM_ARGS,
      DEFAULT_CODEX_BRIDGE_CLEAR_UPSTREAM_ARGS,
    ),
    codexBridgeFullUpstreamArgs: parseCodexBridgeUpstreamArgs(
      process.env.YEP_CODEX_BRIDGE_FULL_UPSTREAM_ARGS,
      DEFAULT_CODEX_BRIDGE_FULL_UPSTREAM_ARGS,
    ),
    opencodeBridgeHost:
      process.env.YEP_OPENCODE_BRIDGE_HOST ??
      process.env.OPENCODE_BRIDGE_HOST ??
      "127.0.0.1",
    opencodeBridgePort,
    opencodeBridgeControlUrl:
      process.env.YEP_OPENCODE_BRIDGE_CONTROL_URL ??
      process.env.OPENCODE_BRIDGE_CONTROL_URL ??
      `http://127.0.0.1:${opencodeBridgePort}`,
    opencodeBridgeServerUrl:
      process.env.YEP_SERVER_URL ??
      process.env.YEP_ANYWHERE_SERVER_URL ??
      `http://127.0.0.1:${parseIntOrDefault(process.env.PORT, 3400)}`,
    opencodeServerUrl:
      process.env.YEP_OPENCODE_BRIDGE_UPSTREAM_URL ??
      process.env.OPENCODE_BRIDGE_UPSTREAM_URL,
    opencodeServerStartPort: parseIntOrDefault(
      process.env.YEP_OPENCODE_SERVER_START_PORT ??
        process.env.YEP_OPENCODE_PORT ??
        process.env.OPENCODE_SERVER_START_PORT ??
        process.env.OPENCODE_PORT,
      opencodeBridgePort + 1,
    ),
    codexWatchPeriodicRescanMs,
    sessionIndexFullValidationMs,
    sessionIndexFullValidationMinMs,
    sessionIndexMaxConcurrentFullValidations,
    sessionIndexWriteLockTimeoutMs,
    sessionIndexWriteLockStaleMs,
    projectScanCacheTtlMs,
    idleTimeoutMs: parseIntOrDefault(process.env.IDLE_TIMEOUT, 5 * 60) * 1000,
    defaultPermissionMode: parsePermissionMode(process.env.PERMISSION_MODE),
    runtimeMode,
    runtimeControlUrl:
      process.env.YEP_RUNTIME_CONTROL_URL ?? `http://127.0.0.1:${runtimePort}`,
    runtimePort,
    runtimeTokenFile:
      process.env.YEP_RUNTIME_TOKEN_FILE ??
      path.join(dataDir, "runtime", "token"),
    port: serverPort,
    portFile: process.env.PORT_FILE ?? null,
    // Host defaults to 127.0.0.1 for security and consistency (avoids IPv6 ambiguity with "localhost")
    host: process.env.HOST ?? "127.0.0.1",
    // Maintenance port disabled by default, set to enable (e.g., PORT + 1)
    maintenancePort: parseIntOrDefault(process.env.MAINTENANCE_PORT, 0),
    maintenancePortFile: process.env.MAINTENANCE_PORT_FILE ?? null,
    useMockSdk: process.env.USE_MOCK_SDK === "true",
    maxWorkers: parseIntOrDefault(process.env.MAX_WORKERS, 0),
    idlePreemptThresholdMs:
      parseIntOrDefault(process.env.IDLE_PREEMPT_THRESHOLD, 10) * 1000,
    serveFrontend,
    // Vite port defaults to main port + 2, keeping all ports sequential
    vitePort: parseIntOrDefault(
      process.env.VITE_PORT,
      parseIntOrDefault(process.env.PORT, 3400) + 2,
    ),
    // Client dist path: Check bundled location first (npm package), then monorepo (dev)
    clientDistPath:
      process.env.CLIENT_DIST_PATH ??
      (() => {
        // When published to npm, client assets are bundled into ./client-dist
        const bundledPath = path.resolve(import.meta.dirname, "../client-dist");
        if (fs.existsSync(bundledPath)) {
          return bundledPath;
        }
        // In development (monorepo), use ../client/dist
        return path.resolve(import.meta.dirname, "../../client/dist");
      })(),
    // Stable (emergency) UI build with /_stable/ base path
    stableDistPath:
      process.env.STABLE_DIST_PATH ??
      path.resolve(import.meta.dirname, "../../client/dist-stable"),
    // Default 100MB max upload size
    maxUploadSizeBytes:
      parseIntOrDefault(process.env.MAX_UPLOAD_SIZE_MB, 100) * 1024 * 1024,
    // Default 100 max queue size
    maxQueueSize: parseIntOrDefault(process.env.MAX_QUEUE_SIZE, 100),
    // Logging configuration (uses dataDir as base)
    logDir: process.env.LOG_DIR ?? path.join(dataDir, "logs"),
    logFile: process.env.LOG_FILE ?? "server.log",
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
    logFileLevel: parseLogLevel(
      process.env.LOG_FILE_LEVEL ?? process.env.LOG_LEVEL,
    ),
    logToFile: process.env.LOG_TO_FILE === "true",
    logPretty: parseBooleanOrDefault(process.env.LOG_PRETTY, true),
    // Enabled providers (comma-separated). Empty = all providers.
    enabledProviders: process.env.ENABLED_PROVIDERS
      ? process.env.ENABLED_PROVIDERS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    // Voice input (default: true, set VOICE_INPUT=false to disable)
    voiceInputEnabled: process.env.VOICE_INPUT !== "false",
    // Always allow yep-managed uploads. ALLOWED_IMAGE_PATHS adds external paths
    // like /tmp; an empty value disables only those extras.
    // kimiSessionsDir is included so transcripts can render the prompt images
    // Kimi persists content-addressed under `<session>/agents/*/blobs/`.
    allowedImagePaths: Array.from(
      new Set(
        [
          managedUploadsDir,
          codexGeneratedImagesDir,
          kimiSessionsDir,
          ...extraAllowedImagePaths,
        ].filter((allowedPath) => allowedPath.trim().length > 0),
      ),
    ),
    allowedLocalFilePaths: Array.from(
      new Set([codexHomeDir, ...extraAllowedLocalFilePaths]),
    ),
    // Auth disabled override (for recovery if user forgets password)
    authDisabled: process.env.AUTH_DISABLED === "true",
    authCookieSecret: process.env.AUTH_COOKIE_SECRET,
    authSessionTtlMs:
      parseIntOrDefault(process.env.AUTH_SESSION_TTL_DAYS, 30) *
      24 *
      60 *
      60 *
      1000,
    // CLI override flags (set by cli.ts when --port or --host are used)
    // Also treat PORT env var as an override when explicitly set (e.g., PORT=0 for test harnesses)
    cliPortOverride:
      process.env.CLI_PORT_OVERRIDE === "true" ||
      process.env.PORT !== undefined,
    cliHostOverride: process.env.CLI_HOST_OVERRIDE === "true",
    openBrowser: process.env.OPEN_BROWSER === "true",
    httpsSelfSigned: process.env.HTTPS_SELF_SIGNED === "true",
    desktopAuthToken:
      process.env.YEP_DESKTOP_AUTH_TOKEN ??
      process.env.DESKTOP_AUTH_TOKEN ??
      undefined,
    // Optional reverse-proxy prefix; Caddy in air.yueyuan.uk/yep/* mounts us
    // here. Stripped of any trailing slash so callers can confidently template
    // `${basePath}/api/...`. Empty string keeps the legacy "no prefix" mode.
    basePath: normalizeBasePath(process.env.BASE_PATH),
  };
}

function getDefaultSessionTitleSubModule(apiBase: string): string | undefined {
  try {
    const hostname = new URL(apiBase).hostname;
    if (hostname === "api.ohmyrouter.com") {
      return "claude-code-internal";
    }
  } catch {
    // Invalid API bases are handled by fetch at request time.
  }
  return undefined;
}

function normalizeBasePath(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "/") return "";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

/**
 * Parse an integer from string or return default value.
 */
function parseIntOrDefault(
  value: string | undefined,
  defaultValue: number,
): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse boolean-ish env values with a default fallback.
 */
function parseBooleanOrDefault(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  return defaultValue;
}

/**
 * Parse permission mode from string or return default.
 */
function parsePermissionMode(value: string | undefined): PermissionMode {
  const normalized = value?.trim();
  if (
    normalized &&
    ALL_PERMISSION_MODES.includes(normalized as PermissionMode)
  ) {
    return normalized as PermissionMode;
  }
  return DEFAULT_PERMISSION_MODE;
}

function parseCodexBridgeMode(
  value: string | undefined,
): "embedded" | "external" | "disabled" {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "off" ||
    normalized === "disabled" ||
    normalized === "disable"
  ) {
    return "disabled";
  }
  if (normalized === "external" || normalized === "sidecar") {
    return "external";
  }
  return "embedded";
}

const DEFAULT_CODEX_BRIDGE_LIGHT_UPSTREAM_ARGS = [
  ...CODEX_STANDARD_MCP_APP_SERVER_ARGS,
];

const DEFAULT_CODEX_BRIDGE_CLEAR_UPSTREAM_ARGS = [
  ...CODEX_CLEAR_MCP_APP_SERVER_ARGS,
];

const DEFAULT_CODEX_BRIDGE_FULL_UPSTREAM_ARGS = [
  ...CODEX_FULL_MCP_APP_SERVER_ARGS,
];

function parseCodexBridgeUpstreamArgs(
  value: string | undefined,
  defaultValue: string[],
): string[] {
  if (value === undefined) {
    return [...defaultValue];
  }

  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.every((item) => typeof item === "string")
      ) {
        return parsed;
      }
    } catch {
      // Fall through to whitespace parsing below.
    }
  }

  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * Parse log level from string or return default.
 */
function parseLogLevel(value: string | undefined): LogLevel {
  const validLevels: LogLevel[] = [
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
  ];
  if (value && validLevels.includes(value as LogLevel)) {
    return value as LogLevel;
  }
  return "info";
}
