/**
 * Global sessions route - returns all sessions across all projects.
 *
 * Unlike the inbox route which categorizes sessions into tiers,
 * this returns a flat list suitable for navigation/sidebar use.
 */

import {
  type ContextCompactEvent,
  type ContextCumulativeUsage,
  type ContextUsage,
  type ProviderName,
  type SessionCreatedBy,
  type SessionKind,
  type SessionOriginChannel,
  type SessionQuestion,
  type SessionRuntime,
  isSessionKind,
  sessionMatchesKind,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { listAllBridgeSessionViews } from "../bridge-common/multi.js";
import {
  isActiveBridgeSessionView,
  isLiveBridgeSessionView,
} from "../bridge-common/session-state.js";
import type { BridgeSessionView } from "../bridge-common/types.js";
import type { CodexBridgeController } from "../codex-bridge/types.js";
import type { SessionIndexService } from "../indexes/index.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import type { OpenCodeBridgeController } from "../opencode-bridge/types.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { KimiSessionScanner } from "../projects/kimi-scanner.js";
import type { OpenCodeSessionScanner } from "../projects/opencode-scanner.js";
import type { PiSessionScanner } from "../projects/pi-scanner.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { RuntimeController } from "../runtime/types.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import type { KimiSessionReader } from "../sessions/kimi-reader.js";
import type { OpenCodeSessionReader } from "../sessions/opencode-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import { listSessionsAcrossProviders } from "../sessions/provider-resolution.js";
import {
  type SessionRuntimeProcess,
  deriveSessionRuntime,
  pendingInputTypeFromProcess,
} from "../sessions/session-runtime.js";
import type { ISessionReader } from "../sessions/types.js";
import type { ZCodeSessionReader } from "../sessions/zcode-reader.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  AgentActivity,
  PendingInputType,
  Project,
  SessionLastTurnStatus,
  SessionOwnership,
  SessionRetryStatus,
  SessionSummary,
} from "../supervisor/types.js";
import type { BusEvent, EventBus } from "../watcher/index.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";

export interface GlobalSessionsDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  runtimeController?: RuntimeController;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  /** Codex scanner for checking if a project has Codex sessions */
  codexScanner?: CodexSessionScanner;
  /** Codex sessions directory (defaults to ~/.codex/sessions) */
  codexSessionsDir?: string;
  /** Optional shared Codex reader factory for cross-provider session lookups */
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  /** Gemini scanner for checking if a project has Gemini sessions */
  geminiScanner?: GeminiSessionScanner;
  /** Gemini sessions directory (defaults to ~/.gemini/tmp) */
  geminiSessionsDir?: string;
  /** Optional shared Gemini reader factory for cross-provider session lookups */
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  /** OpenCode scanner for checking if a project has OpenCode sessions */
  opencodeScanner?: OpenCodeSessionScanner;
  /** Pi scanner for checking if a project has Pi sessions */
  piScanner?: PiSessionScanner;
  /** OpenCode sqlite database path (defaults to ~/.local/share/opencode/opencode.db) */
  opencodeDbPath?: string;
  zcodeDbPath?: string;
  /** Optional shared OpenCode reader factory for cross-provider session lookups */
  opencodeReaderFactory?: (projectPath: string) => OpenCodeSessionReader;
  piSessionsDir?: string;
  piReaderFactory?: (projectPath: string) => PiSessionReader;
  zcodeReaderFactory?: (projectPath: string) => ZCodeSessionReader;
  /** Kimi scanner for checking if a project has Kimi sessions */
  kimiScanner?: KimiSessionScanner;
  /** Kimi sessions directory */
  kimiSessionsDir?: string;
  /** Optional shared Kimi reader factory for cross-provider session lookups */
  kimiReaderFactory?: (projectPath: string) => KimiSessionReader;
  /** Event bus for cache invalidation */
  eventBus?: EventBus;
  /** Codex bridge for externally launched `codex --remote` TUI sessions. */
  codexBridgeService?: CodexBridgeController;
  /** OpenCode bridge for OpenCode CLI sessions. */
  opencodeBridgeService?: OpenCodeBridgeController;
}

type AnyBridgeSessionView = BridgeSessionView | null;

async function listBridgeSessionViews(
  deps: Pick<
    GlobalSessionsDeps,
    "codexBridgeService" | "opencodeBridgeService"
  >,
): Promise<BridgeSessionView[]> {
  return listAllBridgeSessionViews([
    deps.codexBridgeService,
    deps.opencodeBridgeService,
  ]);
}

function isLiveAnyBridgeSessionView(
  view: NonNullable<AnyBridgeSessionView>,
): boolean {
  return isLiveBridgeSessionView(view);
}

export interface GlobalSessionItem {
  // From cache (cheap)
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  userQuestions?: SessionQuestion[];
  provider: ProviderName;
  // Project context
  projectId: string;
  projectName: string;
  // Enrichment (all in-memory, cheap)
  ownership: SessionOwnership;
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
  /** Non-identifying inbound channel recorded by Yep metadata. */
  originChannel?: SessionOriginChannel;
  /** Launcher identifier from session metadata (e.g. "Codex Desktop", "yep-anywhere") */
  originator?: string;
  /** Session source from provider metadata (e.g. "appServer", "exec") */
  source?: string;
  /** Latest context-window snapshot from the session summary. Included so
   *  the All Sessions page can render the token count immediately on first
   *  paint, without waiting for a session-updated SSE event. */
  contextUsage?: ContextUsage;
  /** Cumulative token spend across the whole session, when available. */
  cumulativeUsage?: ContextCumulativeUsage;
  /** Number of context compactions recorded in the active session history. */
  compactCount?: number;
  /** Best-effort details for each recorded context compaction. */
  compactEvents?: ContextCompactEvent[];
  /** Model name from the session summary (matches contextUsage's scope). */
  model?: string;
  /** Provider-specific reasoning effort (e.g. Claude "max", Codex "xhigh") */
  reasoningEffort?: string;
  /** Provider-specific service tier / speed label (e.g. "fast") */
  serviceTier?: string;
  /**
   * True when the active branch has messages but no trailing `result` and no
   * live process owns the session — the last turn was interrupted (e.g. by a
   * server restart) and the session can be resumed. Only set when
   * ownership.owner === "none" and the session is not externally active.
   */
  interrupted?: boolean;
  /** Terminal status of the most recent turn (bridge-reported). */
  lastTurnStatus?: SessionLastTurnStatus;
  /** Most recent provider error message, if the last turn failed. */
  lastErrorMessage?: string;
  /** Present while the provider is retrying a failed request (OpenCode). */
  retryStatus?: SessionRetryStatus;
}

/** Stats about all sessions (computed during full scan) */
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

export interface GlobalSessionsResponse {
  sessions: GlobalSessionItem[];
  hasMore: boolean;
  /** Global stats computed from all sessions (not just paginated results) */
  stats: GlobalSessionStats;
  /** All projects for filter dropdown */
  projects: ProjectOption[];
}

/** Default limit for sessions per page */
const DEFAULT_LIMIT = 100;

/** Maximum allowed limit */
const MAX_LIMIT = 500;
/** Stats cache TTL in milliseconds */
const STATS_CACHE_TTL_MS = 5000;

function createEmptyStats(): GlobalSessionStats {
  return {
    totalCount: 0,
    unreadCount: 0,
    starredCount: 0,
    archivedCount: 0,
    providerCounts: {},
    executorCounts: {},
  };
}

function addSessionToStats(
  stats: GlobalSessionStats,
  session: Pick<SessionSummary, "provider">,
  options: {
    isArchived: boolean;
    isStarred: boolean;
    executor?: string;
    hasUnread?: boolean;
  },
): void {
  if (options.isArchived) {
    stats.archivedCount++;
  } else {
    stats.totalCount++;
    if (options.hasUnread) stats.unreadCount++;
    stats.providerCounts[session.provider] =
      (stats.providerCounts[session.provider] ?? 0) + 1;
    const executorKey = options.executor ?? "local";
    stats.executorCounts[executorKey] =
      (stats.executorCounts[executorKey] ?? 0) + 1;
  }
  if (options.isStarred) stats.starredCount++;
}

function updatedAtMs(session: Pick<GlobalSessionItem, "updatedAt">): number {
  return new Date(session.updatedAt).getTime();
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function addTopSession(
  sessions: GlobalSessionItem[],
  session: GlobalSessionItem,
  maxCount: number,
): void {
  if (maxCount <= 0) return;

  const timestamp = updatedAtMs(session);
  const last = sessions.at(-1);
  if (sessions.length >= maxCount && last && timestamp <= updatedAtMs(last)) {
    return;
  }

  let insertAt = sessions.length;
  for (let i = 0; i < sessions.length; i++) {
    const candidate = sessions[i];
    if (candidate && timestamp > updatedAtMs(candidate)) {
      insertAt = i;
      break;
    }
  }

  sessions.splice(insertAt, 0, session);
  if (sessions.length > maxCount) {
    sessions.pop();
  }
}

function canEnterTopSessions(
  sessions: GlobalSessionItem[],
  session: Pick<GlobalSessionItem, "updatedAt">,
  maxCount: number,
): boolean {
  if (maxCount <= 0) return false;
  if (sessions.length < maxCount) return true;

  const last = sessions.at(-1);
  return !last || updatedAtMs(session) > updatedAtMs(last);
}

function canStopBeforeProject(
  topSessions: GlobalSessionItem[],
  project: Pick<Project, "lastActivity">,
  maxCount: number,
): boolean {
  if (topSessions.length < maxCount) return false;

  const projectLastActivity = timestampMs(project.lastActivity);
  if (projectLastActivity === null) return false;

  const currentBottom = topSessions.at(-1);
  if (!currentBottom) return false;

  return projectLastActivity <= updatedAtMs(currentBottom);
}

function compareProjectsByLastActivityDesc(
  a: Pick<Project, "lastActivity">,
  b: Pick<Project, "lastActivity">,
): number {
  return (
    (timestampMs(b.lastActivity) ?? Number.NEGATIVE_INFINITY) -
    (timestampMs(a.lastActivity) ?? Number.NEGATIVE_INFINITY)
  );
}

function matchesSessionKindFilters(
  session: Pick<SessionSummary, "title"> & { customTitle?: string | null },
  options: {
    includeKind?: SessionKind;
    excludeKind?: SessionKind;
  },
): boolean {
  if (
    options.includeKind &&
    !sessionMatchesKind(session, options.includeKind)
  ) {
    return false;
  }

  if (options.excludeKind && sessionMatchesKind(session, options.excludeKind)) {
    return false;
  }

  return true;
}

export function createGlobalSessionsRoutes(deps: GlobalSessionsDeps): Hono {
  const routes = new Hono();
  let cachedStats: { value: GlobalSessionStats; timestamp: number } | null =
    null;
  let statsDirty = true;
  let inFlightStats: Promise<GlobalSessionStats> | null = null;

  const shouldInvalidateStats = (event: BusEvent): boolean => {
    switch (event.type) {
      case "file-change":
      case "session-created":
      case "session-updated":
      case "session-seen":
      case "session-metadata-changed":
        return true;
      default:
        return false;
    }
  };

  const invalidateStats = (): void => {
    statsDirty = true;
  };

  if (deps.eventBus) {
    deps.eventBus.subscribe((event) => {
      if (shouldInvalidateStats(event)) {
        invalidateStats();
      }
    });
  }

  const listSessionsForProject = async (
    project: Project,
    providerCatalog: Awaited<ReturnType<typeof buildProviderProjectCatalog>>,
  ): Promise<SessionSummary[]> => {
    return listSessionsAcrossProviders(
      project,
      {
        readerFactory: deps.readerFactory,
        sessionMetadataService: deps.sessionMetadataService,
        sessionIndexService: deps.sessionIndexService,
        codexSessionsDir: deps.codexSessionsDir,
        codexReaderFactory: deps.codexReaderFactory,
        geminiSessionsDir: deps.geminiSessionsDir,
        geminiReaderFactory: deps.geminiReaderFactory,
        geminiHashToCwd: providerCatalog.geminiHashToCwd,
        opencodeDbPath: deps.opencodeDbPath,
        opencodeReaderFactory: deps.opencodeReaderFactory,
        piSessionsDir: deps.piSessionsDir,
        piReaderFactory: deps.piReaderFactory,
        kimiSessionsDir: deps.kimiSessionsDir,
        kimiReaderFactory: deps.kimiReaderFactory,
        allowStaleSessionCache: true,
      },
      providerCatalog,
    );
  };

  const computeGlobalStats = async (): Promise<GlobalSessionStats> => {
    const projects = await deps.scanner.listProjects();
    const stats: GlobalSessionStats = createEmptyStats();
    const providerCatalog = await buildProviderProjectCatalog({
      projects,
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
      opencodeScanner: deps.opencodeScanner,
      piScanner: deps.piScanner,
      kimiScanner: deps.kimiScanner,
    });
    const seenSessionIds = new Set<string>();

    for (const project of projects) {
      const sessions = await listSessionsForProject(project, providerCatalog);
      for (const session of sessions) {
        seenSessionIds.add(session.id);
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const isArchived = metadata?.isArchived ?? session.isArchived ?? false;
        const isStarred = metadata?.isStarred ?? session.isStarred ?? false;
        const executor = metadata?.executor;

        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(session.id, session.updatedAt)
          : false;

        addSessionToStats(stats, session, {
          isArchived,
          isStarred,
          executor,
          hasUnread,
        });
      }
    }

    const statsBridgeSessionViews = await listBridgeSessionViews(deps);
    for (const item of statsBridgeSessionViews) {
      if (seenSessionIds.has(item.session.id)) continue;
      const metadata = deps.sessionMetadataService?.getMetadata(
        item.session.id,
      );
      const isArchived =
        metadata?.isArchived ?? item.session.isArchived ?? false;
      const isStarred = metadata?.isStarred ?? item.session.isStarred ?? false;
      const hasUnread = deps.notificationService
        ? deps.notificationService.hasUnread(
            item.session.id,
            item.session.updatedAt,
          )
        : false;

      addSessionToStats(stats, item.session, {
        isArchived,
        isStarred,
        hasUnread,
      });
    }

    return stats;
  };

  const getCachedGlobalStats = async (): Promise<GlobalSessionStats> => {
    const now = Date.now();
    const isFresh =
      cachedStats &&
      !statsDirty &&
      now - cachedStats.timestamp < STATS_CACHE_TTL_MS;
    if (isFresh && cachedStats) {
      return cachedStats.value;
    }

    if (inFlightStats) {
      return inFlightStats;
    }

    const statsPromise = computeGlobalStats()
      .then((stats) => {
        cachedStats = { value: stats, timestamp: Date.now() };
        statsDirty = false;
        return stats;
      })
      .finally(() => {
        if (inFlightStats === statsPromise) {
          inFlightStats = null;
        }
      });

    inFlightStats = statsPromise;
    return statsPromise;
  };

  // GET /api/sessions/stats - Get cached global session stats
  routes.get("/stats", async (c) => {
    const filterProjectId = c.req.query("project");
    if (filterProjectId) {
      return c.json({ stats: createEmptyStats() });
    }

    const stats = await getCachedGlobalStats();
    return c.json({ stats });
  });

  // GET /api/sessions - Get all sessions with pagination
  routes.get("/", async (c) => {
    const processBySessionId = new Map<string, SessionRuntimeProcess>();
    if (deps.runtimeController) {
      for (const process of await deps.runtimeController.listProcessSnapshots()) {
        processBySessionId.set(process.sessionId, process);
      }
    } else {
      for (const process of deps.supervisor?.getAllProcesses?.() ?? []) {
        processBySessionId.set(process.sessionId, process);
      }
    }
    // Parse query params
    const filterProjectId = c.req.query("project");
    const searchQuery = c.req.query("q")?.toLowerCase();
    const kindQuery = c.req.query("kind");
    const excludeKindQuery = c.req.query("excludeKind");
    const includeKind = isSessionKind(kindQuery) ? kindQuery : undefined;
    const excludeKind = isSessionKind(excludeKindQuery)
      ? excludeKindQuery
      : undefined;
    const afterCursor = c.req.query("after");
    const includeArchived = c.req.query("includeArchived") === "true";
    const starredOnly = c.req.query("starred") === "true";
    const includeStats = c.req.query("includeStats") === "true";
    const limitParam = c.req.query("limit");
    const limit = Math.min(
      Math.max(1, Number.parseInt(limitParam || "", 10) || DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    // Get all projects
    const allProjects = await deps.scanner.listProjects();

    // Filter to single project if projectId query param provided
    const projects = filterProjectId
      ? allProjects.filter((p) => p.id === filterProjectId)
      : allProjects;

    // Build project options for filter dropdown (from all projects, sorted by name)
    const projectOptions: ProjectOption[] = allProjects
      .map((p) => ({ id: p.id, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const bridgeSessionViews = await listBridgeSessionViews(deps);
    for (const item of bridgeSessionViews) {
      if (
        !projectOptions.some((project) => project.id === item.session.projectId)
      ) {
        projectOptions.push({
          id: item.session.projectId,
          name: item.projectName,
        });
      }
    }
    projectOptions.sort((a, b) => a.name.localeCompare(b.name));

    const bridgedSessionById = new Map(
      bridgeSessionViews.map((item) => [item.session.id, item]),
    );
    const shouldCollectStats = includeStats && !filterProjectId;
    const stats = createEmptyStats();
    const afterTime = afterCursor ? new Date(afterCursor).getTime() : null;
    const maxCandidates = limit + 1;
    const topSessions: GlobalSessionItem[] = [];
    const knownSessionIds = new Set<string>();
    const providerCatalog = await buildProviderProjectCatalog({
      projects: allProjects,
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
      opencodeScanner: deps.opencodeScanner,
      piScanner: deps.piScanner,
      kimiScanner: deps.kimiScanner,
    });

    const projectsForSessionScan = shouldCollectStats
      ? projects
      : [...projects].sort(compareProjectsByLastActivityDesc);

    for (const project of projectsForSessionScan) {
      if (
        !shouldCollectStats &&
        canStopBeforeProject(topSessions, project, maxCandidates)
      ) {
        break;
      }

      const sessions = await listSessionsForProject(project, providerCatalog);

      // Enrich each session
      for (const session of sessions) {
        knownSessionIds.add(session.id);

        // Get session metadata
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const isArchived = metadata?.isArchived ?? session.isArchived ?? false;
        const isStarred = metadata?.isStarred ?? session.isStarred ?? false;
        const customTitle = metadata?.customTitle ?? session.customTitle;
        const aiTitle = metadata?.aiTitle ?? session.aiTitle;
        const executor = metadata?.executor;
        const createdBy = metadata?.createdBy ?? session.createdBy;
        const originChannel = metadata?.originChannel ?? session.originChannel;

        // Get unread status
        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(session.id, session.updatedAt)
          : undefined;

        if (shouldCollectStats) {
          addSessionToStats(stats, session, {
            isArchived,
            isStarred,
            executor,
            hasUnread,
          });
        }

        // Skip archived sessions unless explicitly requested
        if (isArchived && !includeArchived) continue;

        // Skip non-starred sessions if starred filter is active
        if (starredOnly && !isStarred) continue;

        if (
          !matchesSessionKindFilters(
            { title: session.title, customTitle },
            { includeKind, excludeKind },
          )
        ) {
          continue;
        }

        if (
          afterTime !== null &&
          new Date(session.updatedAt).getTime() >= afterTime
        ) {
          continue;
        }

        // Apply search filter before expensive enrichment so older matching
        // sessions are not displaced by newer non-matching sessions.
        if (searchQuery) {
          const titleMatch = session.title?.toLowerCase().includes(searchQuery);
          const customTitleMatch = customTitle
            ?.toLowerCase()
            .includes(searchQuery);
          const aiTitleMatch = aiTitle?.toLowerCase().includes(searchQuery);
          const projectNameMatch = project.name
            .toLowerCase()
            .includes(searchQuery);

          if (
            !titleMatch &&
            !customTitleMatch &&
            !aiTitleMatch &&
            !projectNameMatch
          ) {
            continue;
          }
        }

        if (!canEnterTopSessions(topSessions, session, maxCandidates)) {
          continue;
        }

        // Compute status
        const process =
          processBySessionId.get(session.id) ??
          deps.supervisor?.getProcessForSession?.(session.id);
        // The bulk `/session-views` snapshot is authoritative here: it already
        // lists every displayable bridge session and ships the sidecar's own
        // liveness verdict per entry. Falling back to `/sessions/:id/view` +
        // `/sessions/:id/active` per candidate session turned one page of
        // global sessions into two sidecar requests per session per bridge.
        const bridgedSession = bridgedSessionById.get(session.id) ?? null;
        const isExternal =
          (deps.externalTracker?.isExternal(session.id) ?? false) ||
          (bridgedSession !== null &&
            isActiveBridgeSessionView(bridgedSession));

        const runtime = deriveSessionRuntime({
          process,
          externalActive: isExternal,
          externalActivity: bridgedSession?.activity,
          fallbackOwnership: session.ownership,
        });
        const ownership: SessionOwnership = runtime.ownership;
        const pendingInputType =
          pendingInputTypeFromProcess(process) ??
          bridgedSession?.pendingInputType;
        const activity = runtime.activity;

        addTopSession(
          topSessions,
          {
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: session.messageCount,
            userQuestions: session.userQuestions,
            provider: session.provider,
            projectId: session.projectId,
            projectName: project.name,
            ownership,
            pendingInputType,
            activity,
            runtime,
            hasUnread,
            customTitle,
            aiTitle,
            isArchived,
            isStarred,
            executor,
            createdBy,
            originChannel,
            originator: session.originator,
            source: session.source,
            contextUsage: session.contextUsage,
            cumulativeUsage: session.cumulativeUsage,
            compactCount: session.compactCount,
            compactEvents: session.compactEvents,
            model: session.model,
            reasoningEffort: session.reasoningEffort,
            serviceTier: session.serviceTier,
            interrupted:
              ownership.owner === "none" ? session.interrupted : undefined,
            lastTurnStatus: bridgedSession
              ? bridgedSession.session.lastTurnStatus
              : session.lastTurnStatus,
            lastErrorMessage: bridgedSession
              ? bridgedSession.session.lastErrorMessage
              : session.lastErrorMessage,
            retryStatus: bridgedSession
              ? bridgedSession.session.retryStatus
              : session.retryStatus,
          },
          maxCandidates,
        );
      }
    }

    for (const item of bridgeSessionViews) {
      const session = item.session;
      if (knownSessionIds.has(session.id)) continue;
      if (filterProjectId && session.projectId !== filterProjectId) continue;

      const metadata = deps.sessionMetadataService?.getMetadata(session.id);
      const isArchived = metadata?.isArchived ?? session.isArchived ?? false;
      const isStarred = metadata?.isStarred ?? session.isStarred ?? false;
      const customTitle = metadata?.customTitle ?? session.customTitle;
      const aiTitle = metadata?.aiTitle ?? session.aiTitle;
      const executor = metadata?.executor;
      const createdBy = metadata?.createdBy ?? session.createdBy;
      const originChannel = metadata?.originChannel ?? session.originChannel;

      const hasUnread = deps.notificationService
        ? deps.notificationService.hasUnread(session.id, session.updatedAt)
        : undefined;

      if (shouldCollectStats) {
        addSessionToStats(stats, session, {
          isArchived,
          isStarred,
          executor,
          hasUnread,
        });
      }

      if (isArchived && !includeArchived) continue;
      if (starredOnly && !isStarred) continue;
      if (
        !matchesSessionKindFilters(
          { title: session.title, customTitle },
          { includeKind, excludeKind },
        )
      ) {
        continue;
      }

      if (
        afterTime !== null &&
        new Date(session.updatedAt).getTime() >= afterTime
      ) {
        continue;
      }

      if (searchQuery) {
        const title = session.title ?? "";
        const custom = customTitle ?? "";
        const ai = aiTitle ?? "";
        const projectName = item.projectName;
        if (
          !title.toLowerCase().includes(searchQuery) &&
          !custom.toLowerCase().includes(searchQuery) &&
          !ai.toLowerCase().includes(searchQuery) &&
          !projectName.toLowerCase().includes(searchQuery)
        ) {
          continue;
        }
      }

      if (!canEnterTopSessions(topSessions, session, maxCandidates)) {
        continue;
      }

      const runtime = deriveSessionRuntime({
        externalActive: isLiveAnyBridgeSessionView(item),
        externalActivity: item.activity,
        fallbackOwnership: session.ownership,
      });

      addTopSession(
        topSessions,
        {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messageCount,
          userQuestions: session.userQuestions,
          provider: session.provider,
          projectId: session.projectId,
          projectName: item.projectName,
          ownership: runtime.ownership,
          pendingInputType: item.pendingInputType,
          activity: runtime.activity,
          runtime,
          hasUnread,
          customTitle,
          aiTitle,
          isArchived,
          isStarred,
          executor,
          createdBy,
          originChannel,
          originator: session.originator,
          source: session.source,
          contextUsage: session.contextUsage,
          cumulativeUsage: session.cumulativeUsage,
          compactCount: session.compactCount,
          compactEvents: session.compactEvents,
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          serviceTier: session.serviceTier,
          lastTurnStatus: session.lastTurnStatus,
          lastErrorMessage: session.lastErrorMessage,
          retryStatus: session.retryStatus,
          interrupted:
            runtime.ownership.owner === "none"
              ? session.interrupted
              : undefined,
        },
        maxCandidates,
      );
    }

    // Get one extra to determine hasMore
    const hasMore = topSessions.length > limit;
    const sessions = topSessions.slice(0, limit);

    if (shouldCollectStats) {
      cachedStats = { value: stats, timestamp: Date.now() };
      statsDirty = false;
    }

    const response: GlobalSessionsResponse = {
      sessions,
      hasMore,
      stats,
      projects: projectOptions,
    };

    return c.json(response);
  });

  return routes;
}
