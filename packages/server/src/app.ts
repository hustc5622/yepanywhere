import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { Hono } from "hono";
import {
  ArchiveError,
  type ArchiveProvider,
  type ArchivedSessionRecord,
  type SessionArchiveService,
} from "./archive/index.js";
import type { AuthService } from "./auth/AuthService.js";
import { createAuthRoutes } from "./auth/routes.js";
import type { CodexBridgeController } from "./codex-bridge/types.js";
import type { SessionTitleGenerationConfig } from "./config.js";
import type { DeviceBridgeService } from "./device/DeviceBridgeService.js";
import type { FrontendProxy } from "./frontend/index.js";
import type {
  SessionContentIndexService,
  SessionIndexService,
} from "./indexes/index.js";
import { getLogger } from "./logging/logger.js";
import type {
  ProjectMetadataService,
  SessionMetadata,
  SessionMetadataService,
} from "./metadata/index.js";
import { updateAllowedHosts } from "./middleware/allowed-hosts.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import {
  corsMiddleware,
  hostCheckMiddleware,
  requireCustomHeader,
} from "./middleware/security.js";
import type { NotificationService } from "./notifications/index.js";
import {
  CODEX_SESSIONS_DIR,
  CodexSessionScanner,
} from "./projects/codex-scanner.js";
import {
  GEMINI_TMP_DIR,
  GeminiSessionScanner,
} from "./projects/gemini-scanner.js";
import {
  OPENCODE_DB_PATH,
  OpenCodeSessionScanner,
} from "./projects/opencode-scanner.js";
import { CLAUDE_PROJECTS_DIR } from "./projects/paths.js";
import { ProjectScanner } from "./projects/scanner.js";
import {
  type NativePushService,
  PushNotifier,
  type PushService,
} from "./push/index.js";
import { createPushRoutes } from "./push/routes.js";
import type { RecentsService } from "./recents/index.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createBrowserProfilesRoutes } from "./routes/browser-profiles.js";
import { createClientLogsRoutes } from "./routes/client-logs.js";
import { createCodexBridgeRoutes } from "./routes/codex-bridge.js";
import { createConnectionsRoutes } from "./routes/connections.js";
import { createDebugStreamingRoutes } from "./routes/debug-streaming.js";
import {
  createDeployRoutes,
  getDeploymentAvailability,
} from "./routes/deploy.js";
import { createDevRoutes } from "./routes/dev.js";
import { createDeviceRoutes } from "./routes/devices.js";
import { createFilesRoutes } from "./routes/files.js";
import { createGitStatusRoutes } from "./routes/git-status.js";
import { createGlobalSessionsRoutes } from "./routes/global-sessions.js";
import { health } from "./routes/health.js";
import { createInboxRoutes } from "./routes/inbox.js";
import { createNetworkBindingRoutes } from "./routes/network-binding.js";
import { createOnboardingRoutes } from "./routes/onboarding.js";
import { createOpenCodeBridgeRoutes } from "./routes/opencode-bridge.js";
import { createProcessesRoutes } from "./routes/processes.js";
import { createProjectsRoutes } from "./routes/projects.js";
import { buildProviderProjectCatalog } from "./routes/provider-catalog.js";
import { createProvidersRoutes } from "./routes/providers.js";
import { createRecentsRoutes } from "./routes/recents.js";
import { createReportsRoutes } from "./routes/reports.js";
import { createSearchRoutes } from "./routes/search.js";
import { createServerAdminRoutes } from "./routes/server-admin.js";
import { createServerInfoRoutes } from "./routes/server-info.js";
import { createSessionsRoutes } from "./routes/sessions.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createSharingRoutes } from "./routes/sharing.js";
import { ClaudeOllamaProvider } from "./sdk/providers/claude-ollama.js";

import type { OpenCodeBridgeController } from "./opencode-bridge/types.js";
import { createLocalFileRoutes } from "./routes/local-file.js";
import { createLocalImageRoutes } from "./routes/local-image.js";
import { type UploadDeps, createUploadRoutes } from "./routes/upload.js";
import { createVersionRoutes } from "./routes/version.js";
import type {
  ClaudeSDK,
  PermissionMode,
  RealClaudeSDKInterface,
} from "./sdk/types.js";
import type { BrowserProfileService } from "./services/BrowserProfileService.js";
import type { ConnectedBrowsersService } from "./services/ConnectedBrowsersService.js";
import type { ModelInfoService } from "./services/ModelInfoService.js";
import type { NetworkBindingService } from "./services/NetworkBindingService.js";
import type { ServerSettingsService } from "./services/ServerSettingsService.js";
import { SessionTitleService } from "./services/SessionTitleService.js";
import type { SharingService } from "./services/SharingService.js";
import { CodexSessionReader } from "./sessions/codex-reader.js";
import { GeminiSessionReader } from "./sessions/gemini-reader.js";
import { normalizeSession } from "./sessions/normalization.js";
import { OpenCodeSessionReader } from "./sessions/opencode-reader.js";
import {
  findSessionSummaryAcrossProviders,
  resolveSessionSources,
} from "./sessions/provider-resolution.js";
import { ClaudeSessionReader } from "./sessions/reader.js";
import type { ISessionReader } from "./sessions/types.js";
import { ExternalSessionTracker } from "./supervisor/ExternalSessionTracker.js";
import { Supervisor } from "./supervisor/Supervisor.js";
import type { Project, SessionSummary } from "./supervisor/types.js";
import type { EventBus } from "./watcher/index.js";
import { LifecycleWebhookService } from "./webhooks/LifecycleWebhookService.js";

export interface AppOptions {
  /** Legacy SDK interface for mock SDK (for testing) */
  sdk?: ClaudeSDK;
  /** Real SDK interface with full features */
  realSdk?: RealClaudeSDKInterface;
  projectsDir?: string; // override for testing
  idleTimeoutMs?: number;
  defaultPermissionMode?: PermissionMode;
  /** EventBus for file change events */
  eventBus?: EventBus;
  /** WebSocket upgrader from @hono/node-ws (optional) */
  upgradeWebSocket?: UploadDeps["upgradeWebSocket"];
  /** NotificationService for tracking session read state */
  notificationService?: NotificationService;
  /** SessionMetadataService for custom titles and archive status */
  sessionMetadataService?: SessionMetadataService;
  /** ProjectMetadataService for persisting added projects */
  projectMetadataService?: ProjectMetadataService;
  /** SessionIndexService for caching session summaries */
  sessionIndexService?: SessionIndexService;
  /** SessionContentIndexService for full-text content search */
  sessionContentIndexService?: SessionContentIndexService;
  /** Physical cold archive service for moving old provider JSONL files out of hot scan paths */
  sessionArchiveService?: SessionArchiveService;
  /** Project scanner cache TTL in ms (0 = rescan every request). */
  projectScanCacheTtlMs?: number;
  /** Maximum concurrent workers. 0 = unlimited (default) */
  maxWorkers?: number;
  /** Idle threshold in milliseconds for preemption */
  idlePreemptThresholdMs?: number;
  /** Frontend proxy for dev mode (proxies non-API requests to Vite) */
  frontendProxy?: FrontendProxy;
  /** PushService for web push notifications */
  pushService?: PushService;
  /** NativePushService for Android FCM notifications */
  nativePushService?: NativePushService;
  /** RecentsService for tracking recently visited sessions */
  recentsService?: RecentsService;
  /** Maximum upload file size in bytes. 0 = unlimited */
  maxUploadSizeBytes?: number;
  /** Maximum queue size for pending requests. 0 = unlimited */
  maxQueueSize?: number;
  /** AuthService for cookie-based auth (optional) */
  authService?: AuthService;
  /** Whether auth is disabled by env var (--auth-disable). Bypasses all auth. */
  authDisabled?: boolean;
  /** Desktop auth token for Tauri app. Requests with matching X-Desktop-Token header bypass auth. */
  desktopAuthToken?: string;
  /** Server host (for server-info endpoint) */
  serverHost?: string;
  /** Server port (for server-info endpoint) */
  serverPort?: number;
  /** Unique installation identifier (for server-info endpoint) */
  installId?: string;
  /** Data directory for persistent state (for onboarding state) */
  dataDir?: string;
  /** NetworkBindingService for runtime binding configuration */
  networkBindingService?: NetworkBindingService;
  /**
   * Holder for network binding change callbacks.
   * The callbacks are set after startServer() initializes the servers.
   */
  networkBindingCallbackHolder?: {
    onLocalhostPortChange?: (
      port: number,
    ) => Promise<{ success: boolean; error?: string; redirectUrl?: string }>;
    onNetworkBindingChange?: (
      config: { host: string; port: number } | null,
    ) => Promise<{ success: boolean; error?: string }>;
  };
  /** ConnectedBrowsersService for tracking active browser connections */
  connectedBrowsers?: ConnectedBrowsersService;
  /** BrowserProfileService for tracking browser profile origins */
  browserProfileService?: BrowserProfileService;
  /** ServerSettingsService for server-wide settings */
  serverSettingsService?: ServerSettingsService;
  /** ModelInfoService for cached model metadata (context windows, etc.) */
  modelInfoService?: ModelInfoService;
  /** SharingService for session sharing */
  sharingService?: SharingService;
  /** DeviceBridgeService for Android emulator streaming */
  deviceBridgeService?: DeviceBridgeService;
  /** Codex bridge for externally launched `codex --remote` TUI sessions. */
  codexBridgeService?: CodexBridgeController;
  /** OpenCode bridge for OpenCode CLI sessions. */
  opencodeBridgeService?: OpenCodeBridgeController;
  /** AI title generation settings. */
  sessionTitleGeneration?: SessionTitleGenerationConfig;
  /** If non-empty, only these provider names are exposed via the API. */
  enabledProviders?: string[];
  /** Whether voice input is enabled. Default: true */
  voiceInputEnabled?: boolean;
  /** Allowed directory prefixes for serving local images. Default: ["/tmp"] */
  allowedImagePaths?: string[];
  /** Allowed directory prefixes for serving local markdown/text files. */
  allowedLocalFilePaths?: string[];
  /** Directory containing Markdown report documents for the Reports page. */
  reportsDir?: string;
  /**
   * Optional reverse-proxy URL prefix (e.g. "/yep" when Caddy mounts us at
   * https://host/yep/...). Empty string / omitted = serve at root.
   */
  basePath?: string;
}

export interface AppResult {
  app: Hono<{ Bindings: HttpBindings }>;
  /** Supervisor instance for debug API access */
  supervisor: Supervisor;
  /** Project scanner for debug API access */
  scanner: ProjectScanner;
  /** Session reader factory for debug API access */
  readerFactory: (project: Project) => ISessionReader;
}

const AUTO_ARCHIVE_AGE_DAYS = 7;
const AUTO_ARCHIVE_AGE_MS = AUTO_ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000;

function normalizeArchiveProviderName(
  provider: string | undefined,
): ArchiveProvider | null {
  if (provider === "claude" || provider === "claude-ollama") return "claude";
  if (provider === "codex" || provider === "codex-oss") return "codex";
  return null;
}

async function findSessionFileForArchive(
  project: Project,
  reader: ISessionReader,
  sourceSessionDir: string,
  sessionId: string,
): Promise<string | null> {
  const direct = await reader.getSessionFilePath?.(sessionId);
  if (direct) return direct;

  const dirs = [
    sourceSessionDir,
    project.sessionDir,
    ...(project.mergedSessionDirs ?? []),
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, `${sessionId}.jsonl`);
    try {
      const stats = await stat(candidate);
      if (stats.isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function emitArchiveFileChange(
  eventBus: EventBus | undefined,
  record: ArchivedSessionRecord,
  roots: { claudeProjectsDir: string; codexSessionsDir: string },
  changeType: "create" | "delete",
): void {
  if (!eventBus) return;

  const providerRoot =
    record.provider === "codex"
      ? roots.codexSessionsDir
      : roots.claudeProjectsDir;

  for (const file of record.files) {
    if (file.kind !== "session") continue;
    eventBus.emit({
      type: "file-change",
      provider: record.provider,
      path: file.originalPath,
      relativePath: relative(providerRoot, file.originalPath),
      changeType,
      timestamp: new Date().toISOString(),
      fileType: "session",
    });
  }
}

export function shouldSkipAutoArchiveForStarredSession(
  session: Pick<SessionSummary, "isStarred">,
  metadata: Pick<SessionMetadata, "isStarred"> | undefined,
): boolean {
  return metadata?.isStarred ?? session.isStarred ?? false;
}

export function createApp(options: AppOptions): AppResult {
  // When running behind a reverse proxy that adds a path prefix (Caddy
  // exposes us at /yep/), wrap the Hono instance so every subsequent
  // .use/.route/.get call matches the prefixed URL automatically — we
  // never have to remember to template `${basePath}/api/...` anywhere
  // below.
  const basePath = options.basePath ?? "";
  const root = new Hono<{ Bindings: HttpBindings }>();
  const app = basePath ? root.basePath(basePath) : root;

  // Security middleware: host validation, CORS, custom header requirement
  app.use("/api/*", hostCheckMiddleware);
  app.use("/api/*", corsMiddleware);
  app.use("/api/*", requireCustomHeader);

  // Auth middleware (if authService is provided)
  // The middleware checks authService.isEnabled() dynamically
  if (options.authService) {
    app.use(
      "/api/*",
      createAuthMiddleware({
        authService: options.authService,
        authDisabled: options.authDisabled,
        desktopAuthToken: options.desktopAuthToken,
      }),
    );
  }

  // Auth routes (always mounted if authService is provided)
  // This allows checking auth status and enabling/disabling from settings
  if (options.authService) {
    app.route(
      "/api/auth",
      createAuthRoutes({
        authService: options.authService,
        authDisabled: options.authDisabled,
        desktopAuthToken: options.desktopAuthToken,
      }),
    );
  }

  // Create dependencies
  const codexScanner = new CodexSessionScanner();
  const geminiScanner = new GeminiSessionScanner();
  const opencodeScanner = new OpenCodeSessionScanner();
  const scanner = new ProjectScanner({
    projectsDir: options.projectsDir,
    codexScanner,
    geminiScanner,
    opencodeScanner,
    projectMetadataService: options.projectMetadataService,
    eventBus: options.eventBus,
    cacheTtlMs: options.projectScanCacheTtlMs,
  });
  const readerCache = new Map<string, ISessionReader>();
  const maxReaderCacheSize = 500;

  const getOrCreateReader = <T extends ISessionReader>(
    key: string,
    factory: () => T,
  ): T => {
    const cached = readerCache.get(key);
    if (cached) return cached as T;

    const reader = factory();
    readerCache.set(key, reader);

    while (readerCache.size > maxReaderCacheSize) {
      const oldestKey = readerCache.keys().next().value;
      if (!oldestKey) break;
      readerCache.delete(oldestKey);
    }

    return reader;
  };

  /**
   * Create a session reader appropriate for the project's provider.
   * Routes call this with the project to get the right reader.
   */
  const readerFactory = (project: Project): ISessionReader => {
    const mergedKey =
      project.mergedSessionDirs && project.mergedSessionDirs.length > 0
        ? `::merged=${project.mergedSessionDirs.join(",")}`
        : "";

    switch (project.provider) {
      case "codex":
      case "codex-oss":
        return getOrCreateReader(
          `codex::${project.sessionDir}::${project.path}`,
          () =>
            new CodexSessionReader({
              sessionsDir: project.sessionDir,
              projectPath: project.path,
            }),
        );
      case "gemini":
      case "gemini-acp":
        return getOrCreateReader(
          `gemini::${GEMINI_TMP_DIR}::${project.path}`,
          () =>
            new GeminiSessionReader({
              sessionsDir: GEMINI_TMP_DIR,
              projectPath: project.path,
              hashToCwd: geminiScanner.getHashToCwd(),
            }),
        );
      case "claude":
      case "claude-ollama": {
        const mis = options.modelInfoService;
        return getOrCreateReader(
          `claude::${project.sessionDir}${mergedKey}`,
          () =>
            new ClaudeSessionReader({
              sessionDir: project.sessionDir,
              additionalDirs: project.mergedSessionDirs,
              getContextWindow: mis
                ? (model, provider, sessionId) =>
                    mis.getContextWindow(model, provider, sessionId)
                : undefined,
            }),
        );
      }
      case "opencode": {
        const mis = options.modelInfoService;
        return getOrCreateReader(
          `opencode::${project.path}`,
          () =>
            new OpenCodeSessionReader({
              projectPath: project.path,
              getContextWindow: mis
                ? (model, provider, sessionId) =>
                    mis.getCachedContextWindow(model, provider, sessionId)
                : undefined,
            }),
        );
      }
    }
  };
  const codexReaderFactory = (projectPath: string): CodexSessionReader =>
    getOrCreateReader(
      `codex-extra::${CODEX_SESSIONS_DIR}::${projectPath}`,
      () =>
        new CodexSessionReader({
          sessionsDir: CODEX_SESSIONS_DIR,
          projectPath,
        }),
    );
  const geminiReaderFactory = (projectPath: string): GeminiSessionReader =>
    getOrCreateReader(
      `gemini-extra::${GEMINI_TMP_DIR}::${projectPath}`,
      () =>
        new GeminiSessionReader({
          sessionsDir: GEMINI_TMP_DIR,
          projectPath,
          hashToCwd: geminiScanner.getHashToCwd(),
        }),
    );
  const opencodeReaderFactory = (projectPath: string): OpenCodeSessionReader =>
    getOrCreateReader(
      `opencode-extra::${OPENCODE_DB_PATH}::${projectPath}`,
      () => {
        const mis = options.modelInfoService;
        return new OpenCodeSessionReader({
          dbPath: OPENCODE_DB_PATH,
          projectPath,
          getContextWindow: mis
            ? (model, provider, sessionId) =>
                mis.getCachedContextWindow(model, provider, sessionId)
            : undefined,
        });
      },
    );
  const getSessionSummary = async (sessionId: string, projectId: string) => {
    const project = await scanner.getProject(projectId);
    if (!project) return null;
    const resolved = await findSessionSummaryAcrossProviders(
      project,
      sessionId,
      project.id,
      {
        readerFactory,
        codexSessionsDir: CODEX_SESSIONS_DIR,
        codexReaderFactory,
        geminiSessionsDir: GEMINI_TMP_DIR,
        geminiReaderFactory,
        geminiHashToCwd: geminiScanner.getHashToCwd(),
        opencodeDbPath: OPENCODE_DB_PATH,
        opencodeReaderFactory,
      },
      options.sessionMetadataService?.getProvider(sessionId),
    );
    return resolved?.summary ?? null;
  };
  const supervisor = new Supervisor({
    sdk: options.sdk,
    realSdk: options.realSdk,
    idleTimeoutMs: options.idleTimeoutMs,
    defaultPermissionMode: options.defaultPermissionMode,
    eventBus: options.eventBus,
    maxWorkers: options.maxWorkers,
    idlePreemptThresholdMs: options.idlePreemptThresholdMs,
    maxQueueSize: options.maxQueueSize,
    // Save executor for remote sessions to support resume
    onSessionExecutor: options.sessionMetadataService
      ? (sessionId, executor) =>
          options.sessionMetadataService?.setExecutor(sessionId, executor) ??
          Promise.resolve()
      : undefined,
    onSessionSummary: getSessionSummary,
  });

  // Create external session tracker if eventBus is available
  const externalTracker = options.eventBus
    ? new ExternalSessionTracker({
        eventBus: options.eventBus,
        supervisor,
        scanner,
        decayMs: 30000, // 30 seconds
        // Callback to get session summary for new external sessions
        // projectId is now UrlProjectId (base64url) - ExternalSessionTracker converts it
        getSessionSummary,
      })
    : undefined;

  if (
    options.eventBus &&
    options.sessionMetadataService &&
    options.sessionTitleGeneration?.enabled
  ) {
    const sessionTitleService = new SessionTitleService({
      eventBus: options.eventBus,
      metadataService: options.sessionMetadataService,
      ...options.sessionTitleGeneration,
      loadSession: async (sessionId, projectId) => {
        const project = await scanner.getProject(projectId);
        if (!project) return null;
        const resolved = await findSessionSummaryAcrossProviders(
          project,
          sessionId,
          project.id,
          {
            readerFactory,
            codexSessionsDir: CODEX_SESSIONS_DIR,
            codexReaderFactory,
            geminiSessionsDir: GEMINI_TMP_DIR,
            geminiReaderFactory,
            geminiHashToCwd: geminiScanner.getHashToCwd(),
            opencodeDbPath: OPENCODE_DB_PATH,
            opencodeReaderFactory,
          },
          options.sessionMetadataService?.getProvider(sessionId),
        );
        const loaded = await resolved?.source.reader.getSession(
          sessionId,
          project.id,
          undefined,
          { includeOrphans: false },
        );
        if (!loaded) return null;

        const session = normalizeSession(loaded);
        const metadata = options.sessionMetadataService?.getMetadata(sessionId);
        return {
          ...session,
          customTitle: metadata?.customTitle ?? session.customTitle,
          aiTitle: metadata?.aiTitle ?? session.aiTitle,
        };
      },
    });
    sessionTitleService.start();
    getLogger().info(
      {
        model: options.sessionTitleGeneration.model,
        apiBase: options.sessionTitleGeneration.apiBase,
        subModule: options.sessionTitleGeneration.subModule,
      },
      "[SessionTitleService] Enabled",
    );
  }

  if (options.sessionArchiveService) {
    const archiveService = options.sessionArchiveService;
    archiveService.startDailyScheduler(async () => {
      const cutoffMs = Date.now() - AUTO_ARCHIVE_AGE_MS;
      const projects = await scanner.listProjects();
      const providerCatalog = await buildProviderProjectCatalog({
        projects,
        codexScanner,
        geminiScanner,
        opencodeScanner,
      });
      const roots = {
        claudeProjectsDir: options.projectsDir ?? CLAUDE_PROJECTS_DIR,
        codexSessionsDir: CODEX_SESSIONS_DIR,
      };
      const resolutionDeps = {
        readerFactory,
        codexSessionsDir: CODEX_SESSIONS_DIR,
        codexReaderFactory,
        geminiSessionsDir: GEMINI_TMP_DIR,
        geminiReaderFactory,
        geminiHashToCwd: geminiScanner.getHashToCwd(),
        opencodeDbPath: OPENCODE_DB_PATH,
        opencodeReaderFactory,
      };
      const seenSessionIds = new Set<string>();
      let archivedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;

      getLogger().info(
        `[SessionArchiveService] Auto-archive scan started (olderThanDays=${AUTO_ARCHIVE_AGE_DAYS})`,
      );

      for (const project of projects) {
        const sources = resolveSessionSources(
          project,
          resolutionDeps,
          providerCatalog,
        );

        for (const source of sources) {
          const archiveProvider = normalizeArchiveProviderName(source.provider);
          if (!archiveProvider) continue;

          let sessions: SessionSummary[];
          try {
            sessions = options.sessionIndexService
              ? await options.sessionIndexService.getSessionsWithCache(
                  source.sessionDir,
                  project.id,
                  source.reader,
                  { allowStale: true },
                )
              : await source.reader.listSessions(project.id);
          } catch (error) {
            failedCount++;
            getLogger().warn(
              { err: error, projectId: project.id, provider: source.provider },
              "[SessionArchiveService] Failed to list sessions for auto-archive",
            );
            continue;
          }

          for (const session of sessions) {
            if (seenSessionIds.has(session.id)) continue;
            seenSessionIds.add(session.id);

            const updatedAtMs = new Date(session.updatedAt).getTime();
            if (!Number.isFinite(updatedAtMs) || updatedAtMs >= cutoffMs) {
              skippedCount++;
              continue;
            }
            if (archiveService.isArchived(session.id)) {
              skippedCount++;
              continue;
            }
            const metadata = options.sessionMetadataService?.getMetadata(
              session.id,
            );
            if (shouldSkipAutoArchiveForStarredSession(session, metadata)) {
              skippedCount++;
              continue;
            }
            if (
              supervisor.getProcessForSession(session.id) ||
              externalTracker?.isExternal(session.id)
            ) {
              skippedCount++;
              continue;
            }

            try {
              const sessionFilePath = await findSessionFileForArchive(
                project,
                source.reader,
                source.sessionDir,
                session.id,
              );
              if (!sessionFilePath) {
                skippedCount++;
                continue;
              }

              const record = await archiveService.archiveSession({
                sessionId: session.id,
                provider: archiveProvider,
                project,
                summary: session,
                sessionFilePath,
                reason: "auto",
              });
              archivedCount++;

              await options.sessionMetadataService?.setArchived(
                session.id,
                true,
              );
              options.eventBus?.emit({
                type: "session-metadata-changed",
                sessionId: session.id,
                projectId: session.projectId,
                archived: true,
                timestamp: new Date().toISOString(),
              });
              emitArchiveFileChange(options.eventBus, record, roots, "delete");
            } catch (error) {
              if (
                error instanceof ArchiveError &&
                error.code === "already_archived"
              ) {
                skippedCount++;
                continue;
              }
              failedCount++;
              getLogger().warn(
                { err: error, sessionId: session.id },
                "[SessionArchiveService] Failed to auto-archive session",
              );
            }
          }
        }
      }

      if (archivedCount > 0) {
        scanner.invalidateCache();
        codexScanner.invalidateCache();
      }
      getLogger().info(
        `[SessionArchiveService] Auto-archive scan finished archived=${archivedCount} skipped=${skippedCount} failed=${failedCount}`,
      );
    });
  }

  // Create PushNotifier if push notifications are enabled
  // This sends push notifications when sessions need user input
  if (options.eventBus && options.pushService) {
    new PushNotifier({
      eventBus: options.eventBus,
      pushService: options.pushService,
      nativePushService: options.nativePushService,
      notificationService: options.notificationService,
      supervisor,
      connectedBrowsers: options.connectedBrowsers,
    });
  }

  if (options.eventBus && options.serverSettingsService) {
    new LifecycleWebhookService({
      eventBus: options.eventBus,
      supervisor,
      serverSettingsService: options.serverSettingsService,
    });
  }

  // Health check (outside /api — needs CORS for Tauri desktop app)
  app.use("/health/*", corsMiddleware);
  app.route("/health", health);

  // Version check (outside /api for easy access)
  app.route(
    "/api/version",
    createVersionRoutes({
      getDeviceBridgeState: () => {
        if (!options.deviceBridgeService) return "unavailable";
        return options.deviceBridgeService.hasBinary()
          ? "available"
          : "downloadable";
      },
      getDeviceBridgeStatus: ({ forceRefresh } = {}) => {
        if (!options.deviceBridgeService) {
          return Promise.resolve({ state: "unavailable" as const });
        }
        return options.deviceBridgeService.getBridgeStatus({ forceRefresh });
      },
      isDeviceBridgeEnabled: () =>
        options.serverSettingsService?.getSetting("deviceBridgeEnabled") ??
        false,
      installId: options.installId,
      voiceInputEnabled: options.voiceInputEnabled,
      isDeploymentAvailable: () =>
        getDeploymentAvailability({ dataDir: options.dataDir }).available,
    }),
  );

  // Server info (host/port binding info for Local Access settings)
  if (options.serverHost && options.serverPort) {
    app.route(
      "/api/server-info",
      createServerInfoRoutes({
        host: options.serverHost,
        port: options.serverPort,
        installId: options.installId,
        deviceBridgeAvailable: !!options.deviceBridgeService?.hasBinary(),
      }),
    );
  }

  // Server admin routes (restart, always available for remote clients)
  app.route(
    "/api/server",
    createServerAdminRoutes({
      supervisor,
      notificationService: options.notificationService,
      dataDir: options.dataDir,
    }),
  );

  app.route(
    "/api/deploy",
    createDeployRoutes({
      dataDir: options.dataDir,
    }),
  );

  // Network binding routes (runtime port/interface configuration)
  if (
    options.networkBindingService &&
    options.networkBindingCallbackHolder &&
    options.eventBus
  ) {
    app.route(
      "/api/network-binding",
      createNetworkBindingRoutes({
        networkBindingService: options.networkBindingService,
        eventBus: options.eventBus,
        onLocalhostPortChange: async (port) => {
          const callback =
            options.networkBindingCallbackHolder?.onLocalhostPortChange;
          if (!callback) {
            return { success: false, error: "Callback not configured" };
          }
          return callback(port);
        },
        onNetworkBindingChange: async (config) => {
          const callback =
            options.networkBindingCallbackHolder?.onNetworkBindingChange;
          if (!callback) {
            return { success: false, error: "Callback not configured" };
          }
          return callback(config);
        },
      }),
    );
  }

  // Onboarding routes (first-run wizard state)
  if (options.dataDir) {
    app.route(
      "/api/onboarding",
      createOnboardingRoutes({ dataDir: options.dataDir }),
    );
  }

  // Client logs routes (remote log collection for connection diagnostics)
  if (options.dataDir) {
    app.route(
      "/api/client-logs",
      createClientLogsRoutes({ dataDir: options.dataDir }),
    );
  }

  if (options.codexBridgeService) {
    app.route(
      "/api/codex-bridge",
      createCodexBridgeRoutes({
        codexBridgeService: options.codexBridgeService,
      }),
    );
  }

  if (options.opencodeBridgeService) {
    app.route(
      "/api/opencode-bridge",
      createOpenCodeBridgeRoutes({
        opencodeBridgeService: options.opencodeBridgeService,
      }),
    );
  }

  // Mount API routes
  app.route(
    "/api/projects",
    createProjectsRoutes({
      scanner,
      readerFactory,
      supervisor,
      externalTracker,
      notificationService: options.notificationService,
      sessionMetadataService: options.sessionMetadataService,
      projectMetadataService: options.projectMetadataService,
      sessionIndexService: options.sessionIndexService,
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
      opencodeScanner,
      opencodeDbPath: OPENCODE_DB_PATH,
      opencodeReaderFactory,
      codexBridgeService: options.codexBridgeService,
      opencodeBridgeService: options.opencodeBridgeService,
    }),
  );
  app.route(
    "/api",
    createSessionsRoutes({
      supervisor,
      scanner,
      readerFactory,
      externalTracker,
      notificationService: options.notificationService,
      sessionMetadataService: options.sessionMetadataService,
      eventBus: options.eventBus,
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
      opencodeScanner,
      opencodeDbPath: OPENCODE_DB_PATH,
      opencodeReaderFactory,
      serverSettingsService: options.serverSettingsService,
      modelInfoService: options.modelInfoService,
      codexBridgeService: options.codexBridgeService,
      opencodeBridgeService: options.opencodeBridgeService,
      sessionArchiveService: options.sessionArchiveService,
      claudeProjectsDir: options.projectsDir ?? CLAUDE_PROJECTS_DIR,
    }),
  );
  app.route(
    "/api/processes",
    createProcessesRoutes({
      supervisor,
      scanner,
      readerFactory,
      processSessionSourceFactory: (process, project) => {
        const persistedProvider = options.sessionMetadataService?.getProvider(
          process.sessionId,
        );
        const provider = persistedProvider ?? process.provider;

        switch (provider) {
          case "codex":
          case "codex-oss":
            return {
              reader: codexReaderFactory(project.path),
              sessionDir: CODEX_SESSIONS_DIR,
            };
          case "gemini":
          case "gemini-acp":
            return {
              reader: geminiReaderFactory(project.path),
              sessionDir: GEMINI_TMP_DIR,
            };
          case "opencode":
            return {
              reader: opencodeReaderFactory(project.path),
              sessionDir: OPENCODE_DB_PATH,
            };
          default:
            return {
              reader: readerFactory(project),
              sessionDir: project.sessionDir,
            };
        }
      },
      sessionIndexService: options.sessionIndexService,
      sessionMetadataService: options.sessionMetadataService,
    }),
  );

  // Inbox routes (cross-project session aggregation)
  app.route(
    "/api/inbox",
    createInboxRoutes({
      scanner,
      readerFactory,
      supervisor,
      notificationService: options.notificationService,
      sessionIndexService: options.sessionIndexService,
      sessionMetadataService: options.sessionMetadataService,
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
      opencodeScanner,
      opencodeDbPath: OPENCODE_DB_PATH,
      opencodeReaderFactory,
      codexBridgeService: options.codexBridgeService,
      opencodeBridgeService: options.opencodeBridgeService,
    }),
  );

  // Global sessions route (flat list of all sessions for navigation)
  app.route(
    "/api/sessions",
    createGlobalSessionsRoutes({
      scanner,
      readerFactory,
      supervisor,
      externalTracker,
      notificationService: options.notificationService,
      sessionIndexService: options.sessionIndexService,
      sessionMetadataService: options.sessionMetadataService,
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
      opencodeScanner,
      opencodeDbPath: OPENCODE_DB_PATH,
      opencodeReaderFactory,
      eventBus: options.eventBus,
      codexBridgeService: options.codexBridgeService,
      opencodeBridgeService: options.opencodeBridgeService,
    }),
  );

  // Search routes (full-text content search across sessions)
  if (options.sessionContentIndexService) {
    app.route(
      "/api/search",
      createSearchRoutes({
        scanner,
        readerFactory,
        sessionContentIndexService: options.sessionContentIndexService,
        sessionMetadataService: options.sessionMetadataService,
        codexScanner,
        codexSessionsDir: CODEX_SESSIONS_DIR,
        codexReaderFactory,
        geminiScanner,
        geminiSessionsDir: GEMINI_TMP_DIR,
        geminiReaderFactory,
        opencodeScanner,
        opencodeDbPath: OPENCODE_DB_PATH,
        opencodeReaderFactory,
      }),
    );
  }

  // Files routes (file browser)
  app.route("/api/projects", createFilesRoutes({ scanner }));

  // Git status routes
  app.route("/api/projects", createGitStatusRoutes({ scanner }));

  // Recents routes (recently visited sessions)
  if (options.recentsService) {
    app.route(
      "/api/recents",
      createRecentsRoutes({
        recentsService: options.recentsService,
        notificationService: options.notificationService,
        scanner,
        readerFactory,
        sessionIndexService: options.sessionIndexService,
        codexScanner,
        codexSessionsDir: CODEX_SESSIONS_DIR,
        codexReaderFactory,
        geminiScanner,
        geminiSessionsDir: GEMINI_TMP_DIR,
        geminiReaderFactory,
        opencodeScanner,
        opencodeDbPath: OPENCODE_DB_PATH,
        opencodeReaderFactory,
      }),
    );
  }

  // Reports routes (report document listing, reading, and uploads)
  app.route(
    "/api/reports",
    createReportsRoutes({
      reportsDir: options.reportsDir,
      maxUploadSizeBytes: options.maxUploadSizeBytes,
    }),
  );

  // Provider routes (multi-provider detection)
  app.route(
    "/api/providers",
    createProvidersRoutes({
      modelInfoService: options.modelInfoService,
      enabledProviders: options.enabledProviders,
    }),
  );

  // Server settings routes
  if (options.serverSettingsService) {
    app.route(
      "/api/settings",
      createSettingsRoutes({
        serverSettingsService: options.serverSettingsService,
        onAllowedHostsChanged: updateAllowedHosts,
        onOllamaUrlChanged: (url) => {
          ClaudeOllamaProvider.setOllamaUrl(url);
        },
        onOllamaSystemPromptChanged: (prompt) => {
          ClaudeOllamaProvider.setSystemPrompt(prompt);
        },
        onOllamaUseFullSystemPromptChanged: (enabled) => {
          ClaudeOllamaProvider.setUseFullSystemPrompt(enabled);
        },
      }),
    );
  }

  // Sharing routes (session snapshot sharing via Worker)
  if (options.sharingService) {
    app.route(
      "/api/sharing",
      createSharingRoutes({ sharingService: options.sharingService }),
    );
  }

  // Connections routes (list connected browser profiles)
  if (options.connectedBrowsers) {
    app.route(
      "/api/connections",
      createConnectionsRoutes({
        connectedBrowsers: options.connectedBrowsers,
        pushService: options.pushService,
      }),
    );
  }

  // Browser profiles routes (list browser profiles with origins)
  if (options.browserProfileService) {
    app.route(
      "/api/browser-profiles",
      createBrowserProfilesRoutes({
        browserProfileService: options.browserProfileService,
        pushService: options.pushService,
      }),
    );
  }

  // Emulator streaming routes (Android emulator remote control)
  if (options.deviceBridgeService) {
    app.route(
      "/api/devices",
      createDeviceRoutes({
        deviceBridgeService: options.deviceBridgeService,
        serverSettingsService: options.serverSettingsService,
      }),
    );
  }

  // Upload routes (WebSocket file uploads)
  if (options.upgradeWebSocket) {
    app.route(
      "/api",
      createUploadRoutes({
        scanner,
        upgradeWebSocket: options.upgradeWebSocket,
        maxUploadSizeBytes: options.maxUploadSizeBytes,
      }),
    );
  }

  // Local image serving (opt-in, restricted to allowed paths)
  if (options.allowedImagePaths && options.allowedImagePaths.length > 0) {
    app.route(
      "/api/local-image",
      createLocalImageRoutes({
        allowedPaths: options.allowedImagePaths,
      }),
    );
  }

  // Local markdown/text file serving (opt-in, restricted to allowed paths)
  if (
    options.allowedLocalFilePaths &&
    options.allowedLocalFilePaths.length > 0
  ) {
    app.route(
      "/api/local-file",
      createLocalFileRoutes({
        allowedPaths: options.allowedLocalFilePaths,
      }),
    );
  }

  // Push notification routes
  if (options.pushService) {
    app.route(
      "/api/push",
      createPushRoutes({
        pushService: options.pushService,
        nativePushService: options.nativePushService,
      }),
    );
  }

  // Activity routes (file watching)
  if (options.eventBus) {
    app.route(
      "/api/activity",
      createActivityRoutes({
        eventBus: options.eventBus,
        connectedBrowsers: options.connectedBrowsers,
        browserProfileService: options.browserProfileService,
      }),
    );

    // Dev routes (manual reload workflow) - mounted when manual reload is enabled
    const isDevMode =
      process.env.NO_BACKEND_RELOAD === "true" ||
      process.env.NO_FRONTEND_RELOAD === "true";
    if (isDevMode) {
      console.log("[Dev] Mounting dev routes at /api/dev");
      app.route("/api/dev", createDevRoutes({ eventBus: options.eventBus }));
    }
  }

  // Debug streaming routes (always mounted in dev, useful for debugging markdown rendering)
  if (process.env.NODE_ENV !== "production") {
    app.route("/api/debug", createDebugStreamingRoutes());
  }

  // Frontend proxy fallback: proxy all non-API requests to Vite dev server
  // This must be the last route to act as a catch-all
  if (options.frontendProxy) {
    const proxy = options.frontendProxy;
    app.all("*", (c) => {
      const { incoming, outgoing } = c.env;
      proxy.web(incoming, outgoing);
      return RESPONSE_ALREADY_SENT;
    });
  }

  return { app, supervisor, scanner, readerFactory };
}

// Default app for backwards compatibility (health check only)
// Full API requires createApp() with SDK injection
export const app = new Hono();
app.route("/health", health);
