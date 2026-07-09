import type {
  AgentActivity,
  BrowserProfilesResponse,
  CodexMcpMode,
  ConnectionsResponse,
  ContextCompactEvent,
  ContextCumulativeUsage,
  ContextStatusResponse,
  ContextUsage,
  DeviceInfo,
  EnrichedRecentEntry,
  FileContentResponse,
  GitStatusInfo,
  NewSessionDefaults,
  OpenCodeModelLimits,
  PendingInputType,
  ProviderInfo,
  ProviderName,
  ReportDocumentResponse,
  ReportUploadResponse,
  ReportsListResponse,
  SessionCreatedBy,
  SessionKind,
  SessionQuestion,
  SessionRuntime,
  SlashCommand,
  ThinkingOption,
  UploadedFile,
} from "@yep-anywhere/shared";
import { authEvents } from "../lib/authEvents";
import type {
  AgentSession,
  InputRequest,
  Message,
  PermissionMode,
  Project,
  Session,
  SessionStatus,
  SessionSummary,
} from "../types";

/** Pagination metadata for compact-boundary-based session loading */
export interface PaginationInfo {
  hasOlderMessages: boolean;
  hasNewerMessages?: boolean;
  totalMessageCount: number;
  returnedMessageCount: number;
  truncatedBeforeMessageId?: string;
  truncatedAfterMessageId?: string;
  totalCompactions: number;
  targetMessageId?: string;
  targetMessageFound?: boolean;
}

/**
 * An item in the inbox representing a session that may need attention.
 */
export interface InboxItem {
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle: string | null;
  updatedAt: string;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  runtime?: SessionRuntime;
  hasUnread?: boolean;
  createdBy?: SessionCreatedBy;
  originator?: string;
  source?: string;
}

/**
 * Inbox response with sessions categorized into priority tiers.
 */
export interface InboxResponse {
  badgeCount: number;
  badgeSessionIds: string[];
  needsAttention: InboxItem[];
  active: InboxItem[];
  recentActivity: InboxItem[];
  unread8h: InboxItem[];
  unread24h: InboxItem[];
}

/**
 * An item in the global sessions list.
 */
export interface GlobalSessionItem {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  userQuestions?: SessionQuestion[];
  provider: ProviderName;
  projectId: string;
  projectName: string;
  ownership: SessionStatus;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  runtime?: SessionRuntime;
  hasUnread?: boolean;
  customTitle?: string;
  aiTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Explicit creation owner recorded by Yep metadata. */
  createdBy?: SessionCreatedBy;
  /** Launcher identifier from session metadata (e.g. "Codex Desktop", "yep-anywhere") */
  originator?: string;
  /** Session source from provider metadata (e.g. "appServer", "exec") */
  source?: string;
  /** Cached context window usage if the server has it. */
  contextUsage?: ContextUsage;
  /** Cumulative token spend across the whole session, when available. */
  cumulativeUsage?: ContextCumulativeUsage;
  /** Number of context compactions recorded in the active session history. */
  compactCount?: number;
  /** Best-effort details for each recorded context compaction. */
  compactEvents?: ContextCompactEvent[];
  /** Model name from the session summary (e.g. "opus", "gpt-5.5"). */
  model?: string;
  /** Provider-specific reasoning effort (e.g. Claude "max", Codex "xhigh"). */
  reasoningEffort?: string;
  /** Provider-specific service tier / speed label (e.g. "fast"). */
  serviceTier?: string;
  /**
   * True when the session's last turn was interrupted (e.g. by a server
   * restart) and it can be resumed. Only set for owner==="none" sessions.
   */
  interrupted?: boolean;
}

/** Stats about all sessions (computed during full scan on server) */
export interface GlobalSessionStats {
  totalCount: number;
  unreadCount: number;
  starredCount: number;
  archivedCount: number;
  /** Counts per provider (non-archived only) */
  providerCounts: Partial<Record<ProviderName, number>>;
  /** Counts per executor host (non-archived only, "local" key for sessions without executor) */
  executorCounts: Record<string, number>;
}

/** Minimal project info for filter dropdowns */
export interface ProjectOption {
  id: string;
  name: string;
}

/**
 * Response from the global sessions API.
 */
export interface GlobalSessionsResponse {
  sessions: GlobalSessionItem[];
  hasMore: boolean;
  /** Global stats computed from all sessions (not just paginated results) */
  stats: GlobalSessionStats;
  /** All projects for filter dropdown */
  projects: ProjectOption[];
}

/** A single snippet match within a session message (for content search). */
export interface SearchMatch {
  messageId: string;
  role: string;
  /** Snippet of surrounding context containing the match. */
  snippet: string;
  /** Char offset of the match start within the snippet (for highlight). */
  matchStart: number;
  /** Char length of the matched substring. */
  matchLength: number;
}

/** One session's grouped search results. */
export interface SearchResultSession {
  sessionId: string;
  projectId: string;
  projectName: string;
  provider: ProviderName;
  title: string;
  customTitle?: string;
  aiTitle?: string;
  updatedAt: string;
  matchCount: number;
  matches: SearchMatch[];
}

export interface SearchResponse {
  query: string;
  results: SearchResultSession[];
  totalSessions: number;
  totalMatches: number;
  searchDurationMs: number;
}

export type ArchiveProvider = "claude" | "codex";
export type ArchiveReason = "manual" | "auto";

export interface ArchivedFileRecord {
  kind: "session" | "agent-session" | "agent-meta";
  originalPath: string;
  archivePath: string;
  size: number;
  mtimeMs: number;
}

export interface ArchivedSessionRecord {
  sessionId: string;
  provider: ArchiveProvider;
  projectId: string;
  projectPath: string;
  title?: string | null;
  fullTitle?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  archivedAt: string;
  reason: ArchiveReason;
  files: ArchivedFileRecord[];
}

export interface ArchiveSessionsResponse {
  archiveDir: string;
  sessions: ArchivedSessionRecord[];
}

export interface ArchiveSessionResponse {
  session: ArchivedSessionRecord;
}

export interface SessionMetadataUpdateResponse {
  updated: boolean;
  archive?: {
    physical: boolean;
    action: "archive" | "restore" | "already_archived";
    record?: ArchivedSessionRecord;
  };
}

export interface ApiError extends Error {
  status: number;
  code?: string;
  absolutePath?: string;
  path?: string;
  details?: unknown;
  runtime?: SessionRuntime;
  setupRequired?: boolean;
}

export interface SessionOptions {
  mode?: PermissionMode;
  /** Model ID (e.g., "sonnet", "opus", "qwen2.5-coder:0.5b") */
  model?: string;
  thinking?: ThinkingOption;
  provider?: ProviderName;
  codexMcpMode?: CodexMcpMode;
  /** OpenCode-only per-session model limit override */
  opencodeModelLimits?: OpenCodeModelLimits;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
}

export type { UploadedFile } from "@yep-anywhere/shared";

import { API_BASE } from "../lib/apiPath";

/**
 * Desktop auth token read from URL query parameter (?desktop_token=...).
 * When present, sent as X-Desktop-Token header on every API request.
 * The Tauri desktop app passes this token to authenticate the iframe
 * without cookies or sessions — the token is valid for the server's lifetime.
 */
let desktopAuthToken: string | null = null;
if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("desktop_token");
  if (token) {
    desktopAuthToken = token;
    // Strip token from URL to keep it out of history/bookmarks
    params.delete("desktop_token");
    const cleanUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}${window.location.hash}`
      : `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, "", cleanUrl);
  }
}

/** Get the desktop auth token (if running inside Tauri iframe). */
export function getDesktopAuthToken(): string | null {
  return desktopAuthToken;
}

export interface AuthStatus {
  /** Whether auth is enabled in settings */
  enabled: boolean;
  /** Whether user has a valid session (or auth is disabled) */
  authenticated: boolean;
  /** Whether initial account setup is needed */
  setupRequired: boolean;
  /** Whether auth is bypassed by --auth-disable flag (for recovery) */
  disabledByEnv: boolean;
  /** Path to auth.json file (for recovery instructions) */
  authFilePath: string;
  /** Whether the server has a desktop auth token (Tauri app) */
  hasDesktopToken: boolean;
  /** Whether unauthenticated localhost access is allowed */
  localhostOpen: boolean;
}

export async function fetchJSON<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Yep-Anywhere": "true",
  };
  if (desktopAuthToken) {
    headers["X-Desktop-Token"] = desktopAuthToken;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...headers,
      ...options?.headers,
    },
  });

  if (!res.ok) {
    // Signal login required for 401 errors (but not for auth endpoints themselves)
    if (res.status === 401 && !path.startsWith("/auth/")) {
      console.log("[API] 401 response, signaling login required");
      authEvents.signalLoginRequired();
    }

    // Try to parse error message from response body
    let errorMessage = `API error: ${res.status} ${res.statusText}`;
    let errorBody:
      | {
          error?: unknown;
          message?: unknown;
          code?: unknown;
          absolutePath?: unknown;
          path?: unknown;
          details?: unknown;
          runtime?: unknown;
        }
      | undefined;
    try {
      errorBody = await res.json();
      if (typeof errorBody?.error === "string") {
        errorMessage = errorBody.error;
      } else if (typeof errorBody?.message === "string") {
        errorMessage = errorBody.message;
      }
    } catch {
      // Response body wasn't JSON, use default message
    }

    // Include setup required info in error for auth handling
    const setupRequired = res.headers.get("X-Setup-Required") === "true";
    const error = new Error(errorMessage) as ApiError;
    error.status = res.status;
    if (typeof errorBody?.code === "string") error.code = errorBody.code;
    if (typeof errorBody?.absolutePath === "string") {
      error.absolutePath = errorBody.absolutePath;
    }
    if (typeof errorBody?.path === "string") error.path = errorBody.path;
    if (errorBody?.details !== undefined) error.details = errorBody.details;
    if (errorBody?.runtime !== undefined) {
      error.runtime = errorBody.runtime as SessionRuntime;
    }
    if (setupRequired) error.setupRequired = true;
    throw error;
  }

  return res.json();
}

// Re-export upload functions
export {
  buildUploadUrl,
  fileToChunks,
  UploadError,
  uploadChunks,
  uploadFile,
  type UploadOptions,
} from "./upload";

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Build metadata for the server process currently handling requests. */
  build?: {
    version: string;
    buildId: string;
    gitCommit?: string | null;
    gitDescribe?: string | null;
    gitDirty?: boolean;
    builtAt: string;
    source: "bundle" | "dev";
  };
  /** Session resume protocol version supported by server (undefined on older servers). */
  resumeProtocolVersion?: number;
  /** Feature capabilities supported by the server. Undefined on older servers. */
  capabilities?: string[];
  /** Device bridge availability and update state. Undefined on older servers. */
  deviceBridgeState?:
    | "available"
    | "downloadable"
    | "update-available"
    | "unavailable";
  /** Installed managed bridge binary version when known. */
  deviceBridgeVersion?: string | null;
  /** Latest bridge release version when known. */
  latestDeviceBridgeVersion?: string | null;
}

export interface ServerInfo {
  /** The host/interface the server is bound to (e.g., "127.0.0.1" or "0.0.0.0") */
  host: string;
  /** The port the server is listening on */
  port: number;
  /** Whether the server is bound to all interfaces (0.0.0.0) */
  boundToAllInterfaces: boolean;
  /** Whether the server is localhost-only */
  localhostOnly: boolean;
}

export interface NetworkInterface {
  /** Interface name (e.g., "eth0", "wlan0") */
  name: string;
  /** IP address */
  address: string;
  /** IPv4 or IPv6 */
  family: "IPv4" | "IPv6";
  /** Whether this is a loopback/internal interface */
  internal: boolean;
  /** Human-readable display name */
  displayName: string;
}

export interface NetworkBindingState {
  localhost: { port: number; overriddenByCli: boolean };
  network: {
    enabled: boolean;
    host: string | null;
    port: number | null;
    overriddenByCli: boolean;
  };
  interfaces: NetworkInterface[];
}

export interface UpdateBindingRequest {
  localhostPort?: number;
  network?: {
    enabled: boolean;
    host?: string;
    port?: number;
  };
}

export interface UpdateBindingResponse {
  success: boolean;
  error?: string;
  redirectUrl?: string;
}

export type DeploymentActionId =
  | "full"
  | "server"
  | "server-dev"
  | "server-restart"
  | "services-restart"
  | "server-build"
  | "apk"
  | "apk-build"
  | "apk-install-existing";

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
}

export interface StartDeploymentRequest {
  action: DeploymentActionId;
  buildType?: "debug" | "release";
  install?: boolean;
  deviceId?: string;
  skipChecks?: boolean;
  allowSessionInterrupt?: boolean;
  restartTargets?: DeploymentRestartTargets;
}

export interface DeploymentRestartTargets {
  server?: boolean;
  codexBridge?: boolean;
  opencodeBridge?: boolean;
  /** Deprecated alias accepted by older servers. */
  claudeBridge?: boolean;
}

export interface GetVersionOptions {
  /** Bypass the server's routine version cache and refresh from the update service. */
  fresh?: boolean;
}

function parseContentDispositionFilename(value: string | null): string | null {
  if (!value) return null;

  const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      return encodedMatch[1];
    }
  }

  const quotedMatch = value.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1];

  const plainMatch = value.match(/filename=([^;]+)/i);
  return plainMatch?.[1]?.trim() ?? null;
}

async function fetchBlob(
  path: string,
): Promise<{ blob: Blob; fileName: string | null }> {
  const headers: Record<string, string> = {
    "X-Yep-Anywhere": "true",
  };
  if (desktopAuthToken) {
    headers["X-Desktop-Token"] = desktopAuthToken;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    cache: "no-store",
    headers,
  });

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) {
      console.log("[API] 401 response, signaling login required");
      authEvents.signalLoginRequired();
    }

    let errorMessage = `API error: ${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) {
        errorMessage = body.error;
      } else if (body.message) {
        errorMessage = body.message;
      }
    } catch {
      // Response body was not JSON.
    }

    const error = new Error(errorMessage) as Error & { status: number };
    error.status = res.status;
    throw error;
  }

  return {
    blob: await res.blob(),
    fileName: parseContentDispositionFilename(
      res.headers.get("Content-Disposition"),
    ),
  };
}

async function uploadReportFile(file: File): Promise<ReportUploadResponse> {
  const headers: Record<string, string> = {
    "X-Yep-Anywhere": "true",
  };
  if (desktopAuthToken) {
    headers["X-Desktop-Token"] = desktopAuthToken;
  }

  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_BASE}/reports/upload`, {
    method: "POST",
    credentials: "include",
    headers,
    body: formData,
  });

  if (!res.ok) {
    if (res.status === 401) {
      console.log("[API] 401 response, signaling login required");
      authEvents.signalLoginRequired();
    }

    let errorMessage = `API error: ${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) {
        errorMessage = body.error;
      } else if (body.message) {
        errorMessage = body.message;
      }
    } catch {
      // Response body was not JSON.
    }

    const error = new Error(errorMessage) as Error & { status: number };
    error.status = res.status;
    throw error;
  }

  return res.json();
}

export const api = {
  // Version API
  getVersion: (options?: GetVersionOptions) =>
    fetchJSON<VersionInfo>(options?.fresh ? "/version?fresh=1" : "/version"),

  // Server info API (host/port binding for Local Access settings)
  getServerInfo: () => fetchJSON<ServerInfo>("/server-info"),

  // Network binding API (runtime port/interface configuration)
  getNetworkBinding: () => fetchJSON<NetworkBindingState>("/network-binding"),

  setNetworkBinding: (request: UpdateBindingRequest) =>
    fetchJSON<UpdateBindingResponse>("/network-binding", {
      method: "PUT",
      body: JSON.stringify(request),
    }),

  disableNetworkBinding: () =>
    fetchJSON<UpdateBindingResponse>("/network-binding", {
      method: "DELETE",
    }),

  // Server admin API
  restartServer: () =>
    fetchJSON<{ ok: boolean; message: string }>("/server/restart", {
      method: "POST",
    }),

  getDeploymentStatus: () =>
    fetchJSON<DeploymentStatusResponse>("/deploy/status"),

  startDeployment: (request: StartDeploymentRequest) =>
    fetchJSON<{ job: DeploymentJob }>("/deploy/jobs", {
      method: "POST",
      body: JSON.stringify(request),
    }),

  getDeploymentJob: (id: string) =>
    fetchJSON<{ job: DeploymentJob }>(`/deploy/jobs/${id}`),

  downloadDeploymentApk: (buildType?: ApkBuildType) => {
    const params = new URLSearchParams();
    if (buildType) params.set("buildType", buildType);
    const qs = params.toString();
    return fetchBlob(`/deploy/apk/download${qs ? `?${qs}` : ""}`);
  },

  // Provider API
  getProviders: () => fetchJSON<{ providers: ProviderInfo[] }>("/providers"),

  getProjects: () => fetchJSON<{ projects: Project[] }>("/projects"),

  /**
   * Add a project by file path.
   * Validates the path exists on disk and returns project info.
   * Supports ~ for home directory and normalizes trailing slashes.
   */
  addProject: (path: string) =>
    fetchJSON<{ project: Project }>("/projects", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  getProject: (projectId: string) =>
    fetchJSON<{ project: Project }>(`/projects/${projectId}`),

  getSession: (
    projectId: string,
    sessionId: string,
    afterMessageId?: string,
    options?: {
      tailCompactions?: number;
      beforeMessageId?: string;
      aroundMessageId?: string;
      afterWindowMessageId?: string;
      branchId?: string;
      maxMessages?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (afterMessageId) params.set("afterMessageId", afterMessageId);
    if (options?.tailCompactions !== undefined)
      params.set("tailCompactions", String(options.tailCompactions));
    if (options?.beforeMessageId)
      params.set("beforeMessageId", options.beforeMessageId);
    if (options?.aroundMessageId)
      params.set("aroundMessageId", options.aroundMessageId);
    if (options?.afterWindowMessageId)
      params.set("afterWindowMessageId", options.afterWindowMessageId);
    if (options?.branchId) params.set("branchId", options.branchId);
    if (options?.maxMessages !== undefined)
      params.set("maxMessages", String(options.maxMessages));
    const qs = params.toString();
    return fetchJSON<{
      session: Session;
      messages: Message[];
      ownership: SessionStatus;
      runtime?: SessionRuntime;
      pendingInputRequest?: InputRequest | null;
      slashCommands?: SlashCommand[] | null;
      pagination?: PaginationInfo;
    }>(`/projects/${projectId}/sessions/${sessionId}${qs ? `?${qs}` : ""}`);
  },

  /**
   * Get session metadata only (no messages).
   * Lightweight endpoint for refreshing title, status, etc. without re-fetching all messages.
   */
  getSessionMetadata: (projectId: string, sessionId: string) =>
    fetchJSON<{
      session: Session;
      ownership: SessionStatus;
      runtime?: SessionRuntime;
      pendingInputRequest?: InputRequest | null;
      slashCommands?: SlashCommand[] | null;
    }>(`/projects/${projectId}/sessions/${sessionId}/metadata`),

  /**
   * Get a structured context-window breakdown for a session.
   * Returns the SDK's live breakdown if a Process is active, otherwise a
   * coarse JSONL-based estimate. Use `response.source` to tell them apart.
   */
  getContextStatus: (projectId: string, sessionId: string) =>
    fetchJSON<ContextStatusResponse>(
      `/projects/${projectId}/sessions/${sessionId}/context-status`,
    ),

  /**
   * Get agent session content for lazy-loading completed Tasks.
   * Used to fetch subagent messages on demand when expanding a Task.
   */
  getAgentSession: (projectId: string, sessionId: string, agentId: string) =>
    fetchJSON<AgentSession>(
      `/projects/${projectId}/sessions/${sessionId}/agents/${agentId}`,
    ),

  /**
   * Get mappings of toolUseId → agentId for all agent files.
   * Used to find agent sessions for pending Tasks on page reload.
   */
  getAgentMappings: (projectId: string, sessionId: string) =>
    fetchJSON<{ mappings: Array<{ toolUseId: string; agentId: string }> }>(
      `/projects/${projectId}/sessions/${sessionId}/agents`,
    ),

  startSession: (
    projectId: string,
    message: string,
    options?: SessionOptions,
    attachments?: UploadedFile[],
  ) =>
    fetchJSON<{
      sessionId: string;
      processId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
    }>(`/projects/${projectId}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        message,
        mode: options?.mode,
        model: options?.model,
        thinking: options?.thinking,
        provider: options?.provider,
        codexMcpMode: options?.codexMcpMode,
        opencodeModelLimits: options?.opencodeModelLimits,
        executor: options?.executor,
        attachments,
      }),
    }),

  /**
   * Create a session without sending an initial message.
   * Use this for two-phase flow: create session, upload files, then send message.
   */
  createSession: (projectId: string, options?: SessionOptions) =>
    fetchJSON<{
      sessionId: string;
      processId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
    }>(`/projects/${projectId}/sessions/create`, {
      method: "POST",
      body: JSON.stringify({
        mode: options?.mode,
        model: options?.model,
        thinking: options?.thinking,
        provider: options?.provider,
        codexMcpMode: options?.codexMcpMode,
        opencodeModelLimits: options?.opencodeModelLimits,
        executor: options?.executor,
      }),
    }),

  resumeSession: (
    projectId: string,
    sessionId: string,
    message: string,
    options?: SessionOptions,
    attachments?: UploadedFile[],
    tempId?: string,
    /**
     * Rewind/edit: resume only up to (and including) this message UUID,
     * branching the conversation in place (same session). Pass the edited
     * message's parentUuid. Maps to the SDK `resumeSessionAt` option.
     */
    resumeSessionAt?: string,
    /**
     * Codex app-server rewind/edit: drop this many trailing user turns via
     * `thread/rollback` before sending the edited prompt in the same session.
     */
    rollbackNumTurns?: number,
  ) =>
    fetchJSON<{
      sessionId: string;
      processId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
    }>(`/projects/${projectId}/sessions/${sessionId}/resume`, {
      method: "POST",
      body: JSON.stringify({
        message,
        mode: options?.mode,
        model: options?.model,
        thinking: options?.thinking,
        provider: options?.provider,
        codexMcpMode: options?.codexMcpMode,
        opencodeModelLimits: options?.opencodeModelLimits,
        executor: options?.executor,
        attachments,
        tempId,
        resumeSessionAt,
        rollbackNumTurns,
      }),
    }),

  queueMessage: (
    sessionId: string,
    message: string,
    mode?: PermissionMode,
    attachments?: UploadedFile[],
    tempId?: string,
    thinking?: ThinkingOption,
    deferred?: boolean,
  ) =>
    fetchJSON<{
      queued: boolean;
      restarted?: boolean;
      processId?: string;
      deferred?: boolean;
    }>(`/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message,
        mode,
        attachments,
        tempId,
        thinking,
        deferred,
      }),
    }),

  cancelDeferredMessage: (sessionId: string, tempId: string) =>
    fetchJSON<{ cancelled: boolean }>(
      `/sessions/${sessionId}/deferred/${encodeURIComponent(tempId)}`,
      { method: "DELETE" },
    ),

  abortProcess: (processId: string) =>
    fetchJSON<{ aborted: boolean }>(`/processes/${processId}/abort`, {
      method: "POST",
    }),

  interruptProcess: (processId: string) =>
    fetchJSON<{ interrupted: boolean; supported: boolean }>(
      `/processes/${processId}/interrupt`,
      { method: "POST" },
    ),

  getProcessModels: (processId: string) =>
    fetchJSON<{
      models: Array<{ id: string; name: string; description?: string }>;
    }>(`/processes/${processId}/models`),

  setProcessModel: (processId: string, model?: string) =>
    fetchJSON<{ success: boolean; model?: string }>(
      `/processes/${processId}/model`,
      { method: "POST", body: JSON.stringify({ model }) },
    ),

  respondToInput: (
    sessionId: string,
    requestId: string,
    response:
      | "approve"
      | "approve_accept_edits"
      | "approve_for_session"
      | "approve_always"
      | "deny",
    answers?: Record<string, string>,
    feedback?: string,
  ) =>
    fetchJSON<{ accepted: boolean }>(`/sessions/${sessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ requestId, response, answers, feedback }),
    }),

  setPermissionMode: (sessionId: string, mode: PermissionMode) =>
    fetchJSON<{ permissionMode: PermissionMode; modeVersion: number }>(
      `/sessions/${sessionId}/mode`,
      { method: "PUT", body: JSON.stringify({ mode }) },
    ),

  setHold: (sessionId: string, hold: boolean) =>
    fetchJSON<{ isHeld: boolean; holdSince: string | null; state: string }>(
      `/sessions/${sessionId}/hold`,
      { method: "PUT", body: JSON.stringify({ hold }) },
    ),

  getProcessInfo: (sessionId: string) =>
    fetchJSON<{
      process: {
        id: string;
        sessionId: string;
        projectId: string;
        projectPath: string;
        projectName: string;
        sessionTitle: string | null;
        state: string;
        startedAt: string;
        queueDepth: number;
        idleSince?: string;
        holdSince?: string;
        terminationReason?: string;
        terminatedAt?: string;
        provider: string;
        thinking?: { type: string };
        effort?: string;
        reasoningEffort?: string;
        serviceTier?: string;
        model?: string;
      } | null;
    }>(`/sessions/${sessionId}/process`),

  markSessionSeen: (
    sessionId: string,
    timestamp?: string,
    messageId?: string,
  ) =>
    fetchJSON<{ marked: boolean }>(`/sessions/${sessionId}/mark-seen`, {
      method: "POST",
      body: JSON.stringify({ timestamp, messageId }),
    }),

  markSessionUnread: (sessionId: string) =>
    fetchJSON<{ marked: boolean }>(`/sessions/${sessionId}/mark-seen`, {
      method: "DELETE",
    }),

  getLastSeen: () =>
    fetchJSON<{
      lastSeen: Record<string, { timestamp: string; messageId?: string }>;
    }>("/notifications/last-seen"),

  updateSessionMetadata: (
    sessionId: string,
    updates: { title?: string; archived?: boolean; starred?: boolean },
  ) =>
    fetchJSON<SessionMetadataUpdateResponse>(
      `/sessions/${sessionId}/metadata`,
      {
        method: "PUT",
        body: JSON.stringify(updates),
      },
    ),

  getArchivedSessions: () =>
    fetchJSON<ArchiveSessionsResponse>("/archive/sessions"),

  getArchivedSession: (sessionId: string) =>
    fetchJSON<ArchiveSessionResponse>(
      `/archive/sessions/${encodeURIComponent(sessionId)}`,
    ),

  /**
   * Clone a session, creating a new session with the same conversation history.
   * Supported for Claude and Codex sessions.
   */
  cloneSession: (
    projectId: string,
    sessionId: string,
    title?: string,
    provider?: string,
  ) =>
    fetchJSON<{
      sessionId: string;
      messageCount: number;
      clonedFrom: string;
      provider: string;
    }>(`/projects/${projectId}/sessions/${sessionId}/clone`, {
      method: "POST",
      body: JSON.stringify({ title, provider }),
    }),

  // Push notification API
  getPushPublicKey: () =>
    fetchJSON<{ publicKey: string }>("/push/vapid-public-key"),

  subscribePush: (
    browserProfileId: string,
    subscription: PushSubscriptionJSON,
    deviceName?: string,
  ) =>
    fetchJSON<{ success: boolean; browserProfileId: string }>(
      "/push/subscribe",
      {
        method: "POST",
        body: JSON.stringify({ browserProfileId, subscription, deviceName }),
      },
    ),

  unsubscribePush: (browserProfileId: string) =>
    fetchJSON<{ success: boolean; browserProfileId: string }>(
      "/push/unsubscribe",
      {
        method: "POST",
        body: JSON.stringify({ browserProfileId }),
      },
    ),

  getPushSubscriptions: () =>
    fetchJSON<{
      count: number;
      subscriptions: Array<{
        browserProfileId: string;
        createdAt: string;
        updatedAt?: string;
        deviceName?: string;
        endpointDomain: string;
        platform?: "android";
        pushKind?: "web" | "native";
      }>;
    }>("/push/subscriptions"),

  testPush: (
    browserProfileId: string,
    message?: string,
    urgency?: "normal" | "persistent" | "silent",
  ) =>
    fetchJSON<{ success: boolean }>("/push/test", {
      method: "POST",
      body: JSON.stringify({ browserProfileId, message, urgency }),
    }),

  deletePushSubscription: (browserProfileId: string) =>
    fetchJSON<{ success: boolean }>(
      `/push/subscriptions/${encodeURIComponent(browserProfileId)}`,
      { method: "DELETE" },
    ),

  getNativePushStatus: () =>
    fetchJSON<{ configured: boolean }>("/push/native/status"),

  subscribeNativePush: (
    browserProfileId: string,
    token: string,
    deviceName?: string,
  ) =>
    fetchJSON<{ success: boolean; browserProfileId: string }>(
      "/push/native/subscribe",
      {
        method: "POST",
        body: JSON.stringify({
          browserProfileId,
          platform: "android",
          token,
          deviceName,
        }),
      },
    ),

  unsubscribeNativePush: (browserProfileId: string) =>
    fetchJSON<{ success: boolean; browserProfileId: string }>(
      "/push/native/unsubscribe",
      {
        method: "POST",
        body: JSON.stringify({ browserProfileId }),
      },
    ),

  testNativePush: (
    browserProfileId: string,
    message?: string,
    urgency?: "normal" | "persistent" | "silent",
  ) =>
    fetchJSON<{ success: boolean }>("/push/native/test", {
      method: "POST",
      body: JSON.stringify({ browserProfileId, message, urgency }),
    }),

  deleteNativePushSubscription: (browserProfileId: string) =>
    fetchJSON<{ success: boolean }>(
      `/push/native/subscriptions/${encodeURIComponent(browserProfileId)}`,
      { method: "DELETE" },
    ),

  // Connected devices API
  getConnections: () => fetchJSON<ConnectionsResponse>("/connections"),

  getNotificationSettings: () =>
    fetchJSON<{
      settings: {
        toolApproval: boolean;
        userQuestion: boolean;
        sessionHalted: boolean;
      };
    }>("/push/settings"),

  updateNotificationSettings: (
    settings: Partial<{
      toolApproval: boolean;
      userQuestion: boolean;
      sessionHalted: boolean;
    }>,
  ) =>
    fetchJSON<{
      settings: {
        toolApproval: boolean;
        userQuestion: boolean;
        sessionHalted: boolean;
      };
    }>("/push/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),

  // File API
  getFile: (projectId: string, path: string, highlight = false) => {
    const params = new URLSearchParams({ path });
    if (highlight) params.set("highlight", "true");
    return fetchJSON<FileContentResponse>(
      `/projects/${projectId}/files?${params.toString()}`,
    );
  },

  getFileRawUrl: (projectId: string, path: string, download = false) => {
    const params = new URLSearchParams({ path });
    if (download) params.set("download", "true");
    return `${API_BASE}/projects/${projectId}/files/raw?${params.toString()}`;
  },

  // Reports API
  getReports: () => fetchJSON<ReportsListResponse>("/reports"),

  getReport: (path: string) => {
    const params = new URLSearchParams({ path });
    return fetchJSON<ReportDocumentResponse>(
      `/reports/document?${params.toString()}`,
    );
  },

  uploadReport: uploadReportFile,

  /**
   * Expand diff context to show full file.
   * Returns syntax-highlighted diff with the entire file as context.
   * Uses originalFile from SDK Edit result (never truncated, verified up to 150KB+).
   */
  expandDiffContext: (
    projectId: string,
    filePath: string,
    oldString: string,
    newString: string,
    originalFile: string,
  ) =>
    fetchJSON<{
      structuredPatch: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
      }>;
      diffHtml: string;
    }>(`/projects/${projectId}/diff/expand`, {
      method: "POST",
      body: JSON.stringify({ filePath, oldString, newString, originalFile }),
    }),

  // Git status API
  getGitStatus: (projectId: string) =>
    fetchJSON<GitStatusInfo>(`/projects/${projectId}/git`),

  getGitDiff: (
    projectId: string,
    params: {
      path: string;
      staged: boolean;
      status: string;
      fullContext?: boolean;
    },
  ) =>
    fetchJSON<{
      diffHtml: string;
      structuredPatch: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
      }>;
      markdownHtml?: string;
    }>(`/projects/${projectId}/git/diff`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  // Inbox API
  getInbox: (projectId?: string) =>
    fetchJSON<InboxResponse>(
      projectId
        ? `/inbox?projectId=${encodeURIComponent(projectId)}`
        : "/inbox",
    ),

  // Global Sessions API
  getGlobalSessions: (params?: {
    project?: string;
    q?: string;
    after?: string;
    limit?: number;
    includeArchived?: boolean;
    starred?: boolean;
    includeStats?: boolean;
    kind?: SessionKind;
    excludeKind?: SessionKind;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.project) searchParams.set("project", params.project);
    if (params?.q) searchParams.set("q", params.q);
    if (params?.after) searchParams.set("after", params.after);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.includeArchived) searchParams.set("includeArchived", "true");
    if (params?.starred) searchParams.set("starred", "true");
    if (params?.includeStats) searchParams.set("includeStats", "true");
    if (params?.kind) searchParams.set("kind", params.kind);
    if (params?.excludeKind)
      searchParams.set("excludeKind", params.excludeKind);
    const query = searchParams.toString();
    return fetchJSON<GlobalSessionsResponse>(
      query ? `/sessions?${query}` : "/sessions",
    );
  },
  getGlobalSessionStats: () =>
    fetchJSON<{
      stats: GlobalSessionStats;
    }>("/sessions/stats"),

  /** Full-text content search across sessions (global or per-project). */
  search: (params: { q: string; project?: string; limit?: number }) => {
    const searchParams = new URLSearchParams();
    searchParams.set("q", params.q);
    if (params.project) searchParams.set("project", params.project);
    if (params.limit) searchParams.set("limit", String(params.limit));
    return fetchJSON<SearchResponse>(`/search?${searchParams.toString()}`);
  },

  // Auth API
  getAuthStatus: () => fetchJSON<AuthStatus>("/auth/status"),

  /** Enable auth with a password (fresh setup while auth is currently disabled) */
  enableAuth: (password: string) =>
    fetchJSON<{ success: boolean }>("/auth/enable", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  /** Disable auth (requires authenticated session) */
  disableAuth: () =>
    fetchJSON<{ success: boolean }>("/auth/disable", {
      method: "POST",
    }),

  /** @deprecated Use enableAuth instead */
  setupAccount: (password: string) =>
    fetchJSON<{ success: boolean }>("/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  login: (password: string) =>
    fetchJSON<{ success: boolean }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  logout: () =>
    fetchJSON<{ success: boolean }>("/auth/logout", {
      method: "POST",
    }),

  changePassword: (newPassword: string) =>
    fetchJSON<{ success: boolean }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    }),

  /** Toggle unauthenticated localhost access (desktop token floor bypass) */
  setLocalhostAccess: (open: boolean) =>
    fetchJSON<{ success: boolean; localhostOpen: boolean }>(
      "/auth/localhost-access",
      {
        method: "POST",
        body: JSON.stringify({ open }),
      },
    ),

  // Recents API
  getRecents: (limit?: number) =>
    fetchJSON<{
      recents: Array<EnrichedRecentEntry>;
    }>(limit ? `/recents?limit=${limit}` : "/recents"),

  recordVisit: (sessionId: string, projectId: string) =>
    fetchJSON<{ recorded: boolean }>("/recents/visit", {
      method: "POST",
      body: JSON.stringify({ sessionId, projectId }),
    }),

  clearRecents: () =>
    fetchJSON<{ cleared: boolean }>("/recents", {
      method: "DELETE",
    }),

  // Onboarding API (first-run wizard state)
  getOnboardingStatus: () => fetchJSON<{ complete: boolean }>("/onboarding"),

  completeOnboarding: () =>
    fetchJSON<{ success: boolean }>("/onboarding/complete", {
      method: "POST",
    }),

  resetOnboarding: () =>
    fetchJSON<{ success: boolean }>("/onboarding/reset", {
      method: "POST",
    }),

  // Browser profiles API (device origin tracking)
  getBrowserProfiles: () =>
    fetchJSON<BrowserProfilesResponse>("/browser-profiles"),

  deleteBrowserProfile: (browserProfileId: string) =>
    fetchJSON<{ deleted: boolean }>(
      `/browser-profiles/${encodeURIComponent(browserProfileId)}`,
      { method: "DELETE" },
    ),

  // Server settings API (persistent server configuration)
  getServerSettings: () => fetchJSON<{ settings: ServerSettings }>("/settings"),

  updateServerSettings: (settings: Partial<ServerSettings>) =>
    fetchJSON<{ settings: ServerSettings }>("/settings", {
      method: "PUT",
      body: JSON.stringify(
        settings,
        // Preserve explicit clears for optional settings. The server treats null
        // and empty string as "clear this value", but plain JSON drops undefined keys.
        (_key, value) => (value === undefined ? null : value),
      ),
    }),

  // Remote executors API
  getRemoteExecutors: () =>
    fetchJSON<{ executors: string[] }>("/settings/remote-executors"),

  updateRemoteExecutors: (executors: string[]) =>
    fetchJSON<{ executors: string[] }>("/settings/remote-executors", {
      method: "PUT",
      body: JSON.stringify({ executors }),
    }),

  testRemoteExecutor: (host: string) =>
    fetchJSON<RemoteExecutorTestResult>(
      `/settings/remote-executors/${encodeURIComponent(host)}/test`,
      { method: "POST" },
    ),

  // Sharing API
  getSharingStatus: () => fetchJSON<{ configured: boolean }>("/sharing/status"),

  shareSession: (html: string, title?: string) =>
    fetchJSON<{ url: string }>("/sharing/upload", {
      method: "POST",
      body: JSON.stringify({ html, title }),
    }),

  // Device bridge API
  getDevices: () => fetchJSON<DeviceInfo[]>("/devices"),

  startDevice: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/start`, {
      method: "POST",
    }),

  stopDevice: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/stop`, {
      method: "POST",
    }),

  downloadDeviceBridge: () =>
    fetchJSON<{
      ok: boolean;
      path?: string;
      binaryPath?: string;
      apkPath?: string;
      error?: string;
    }>("/devices/bridge/download", { method: "POST" }),

  // Legacy aliases (kept while UI naming is still emulator-centric)
  getEmulators: () => fetchJSON<DeviceInfo[]>("/devices"),

  startEmulator: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/start`, {
      method: "POST",
    }),

  stopEmulator: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/stop`, {
      method: "POST",
    }),

  downloadEmulatorBridge: () =>
    fetchJSON<{
      ok: boolean;
      path?: string;
      binaryPath?: string;
      apkPath?: string;
      error?: string;
    }>("/devices/bridge/download", { method: "POST" }),
};

/** Result of testing an SSH connection to a remote executor */
export interface RemoteExecutorTestResult {
  success: boolean;
  error?: string;
  /** SSH host that was tested */
  host?: string;
  /** Remote home directory */
  homeDir?: string;
  /** Whether Claude CLI is available on remote */
  claudeAvailable?: boolean;
  /** Claude CLI version on remote (e.g. "1.0.12") */
  claudeVersion?: string;
}

/** Server-wide settings that persist across restarts */
export interface ServerSettings {
  /** Whether clients should register the service worker */
  serviceWorkerEnabled: boolean;
  /** SSH host aliases for remote executors */
  remoteExecutors?: string[];
  /** SSH host aliases for ChromeOS device bridge targets */
  chromeOsHosts?: string[];
  /** Allowed hostnames for host/origin validation. "*" = allow all, comma-separated = specific hosts. */
  allowedHosts?: string;
  /** Free-form instructions appended to the system prompt for all sessions */
  globalInstructions?: string;
  /** Ollama server URL for claude-ollama provider */
  ollamaUrl?: string;
  /** Custom system prompt for Ollama provider */
  ollamaSystemPrompt?: string;
  /** Whether to use the full Claude system prompt for Ollama */
  ollamaUseFullSystemPrompt?: boolean;
  /** Whether the device bridge (emulator/device streaming) feature is enabled */
  deviceBridgeEnabled?: boolean;
  /** Defaults applied when opening the new session form */
  newSessionDefaults?: NewSessionDefaults;
  /** Whether lifecycle webhook delivery is enabled */
  lifecycleWebhooksEnabled?: boolean;
  /** External webhook URL that receives lifecycle events */
  lifecycleWebhookUrl?: string;
  /** Optional bearer token used for lifecycle webhook delivery */
  lifecycleWebhookToken?: string;
  /** When true, include dryRun=true in lifecycle webhook payloads */
  lifecycleWebhookDryRun?: boolean;
}
