import { homedir } from "node:os";
import {
  type PermissionMode,
  type ProjectGitStatusSummary,
  type UrlProjectId,
  isUrlProjectId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { listActiveBridgeSessionViews } from "../bridge-common/multi.js";
import type { BridgeSessionView as CommonBridgeSessionView } from "../bridge-common/types.js";
import type { CodexBridgeController } from "../codex-bridge/types.js";
import { getProjectGitStatusSummary } from "../git-status-summary.js";
import type { SessionIndexService } from "../indexes/index.js";
import type {
  ProjectMetadataService,
  SessionMetadataService,
} from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { OpenCodeBridgeController } from "../opencode-bridge/types.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { KimiSessionScanner } from "../projects/kimi-scanner.js";
import type { OpenCodeSessionScanner } from "../projects/opencode-scanner.js";
import { canonicalizeProjectPath, isAbsolutePath } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { RuntimeController } from "../runtime/types.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import type { KimiSessionReader } from "../sessions/kimi-reader.js";
import type { OpenCodeSessionReader } from "../sessions/opencode-reader.js";
import { listSessionsAcrossProviders } from "../sessions/provider-resolution.js";
import type { ISessionReader } from "../sessions/types.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  AgentActivity,
  PendingInputType,
  Project,
  SessionSummary,
} from "../supervisor/types.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";

export interface ProjectsDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  runtimeController?: RuntimeController;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionMetadataService?: SessionMetadataService;
  /** ProjectMetadataService for persisting added projects */
  projectMetadataService?: ProjectMetadataService;
  sessionIndexService?: SessionIndexService;
  /** Optional override for project-list git summaries (primarily for tests). */
  gitStatusProvider?: (
    project: Project,
  ) => Promise<ProjectGitStatusSummary | null>;
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
  /** OpenCode sqlite database path (defaults to ~/.local/share/opencode/opencode.db) */
  opencodeDbPath?: string;
  /** Optional shared OpenCode reader factory for cross-provider session lookups */
  opencodeReaderFactory?: (projectPath: string) => OpenCodeSessionReader;
  /** Kimi scanner for checking if a project has Kimi sessions */
  kimiScanner?: KimiSessionScanner;
  /** Kimi sessions directory */
  kimiSessionsDir?: string;
  /** Optional shared Kimi reader factory for cross-provider session lookups */
  kimiReaderFactory?: (projectPath: string) => KimiSessionReader;
  /** Codex bridge for externally launched `codex --remote` sessions. */
  codexBridgeService?: CodexBridgeController;
  /** OpenCode bridge for OpenCode CLI sessions. */
  opencodeBridgeService?: OpenCodeBridgeController;
}

interface ProjectActivityCounts {
  activeOwnedCount: number;
  activeExternalCount: number;
}

interface OwnedProcessView {
  id: string;
  sessionId: string;
  projectId: UrlProjectId;
  startedAt: string;
  permissionMode?: PermissionMode;
  modeVersion?: number;
  provider: SessionSummary["provider"];
  state: AgentActivity;
  pendingInputType?: PendingInputType;
}

async function loadOwnedProcessViews(
  deps: Pick<ProjectsDeps, "runtimeController" | "supervisor">,
): Promise<OwnedProcessView[]> {
  if (deps.runtimeController) {
    const processes = await deps.runtimeController.listProcessSnapshots();
    return processes.map((process) => {
      const pendingRequest = process.pendingInputRequest;
      return {
        id: process.id,
        sessionId: process.sessionId,
        projectId: process.projectId,
        startedAt: process.startedAt,
        permissionMode: process.permissionMode,
        modeVersion: process.modeVersion,
        provider: process.provider,
        state: process.state,
        pendingInputType: pendingRequest
          ? pendingRequest.type === "tool-approval"
            ? "tool-approval"
            : "user-question"
          : undefined,
      };
    });
  }

  return (deps.supervisor?.getAllProcesses() ?? []).map((process) => {
    const pendingRequest = process.getPendingInputRequest();
    return {
      id: process.id,
      sessionId: process.sessionId,
      projectId: process.projectId,
      startedAt: process.startedAt.toISOString(),
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
      provider: process.provider,
      state: process.state.type,
      pendingInputType: pendingRequest
        ? pendingRequest.type === "tool-approval"
          ? "tool-approval"
          : "user-question"
        : undefined,
    };
  });
}

const PROJECT_GIT_STATUS_CONCURRENCY = 6;

type BridgeSessionView = CommonBridgeSessionView;

/**
 * Live bridge sessions for the project list / project session list.
 *
 * Both routes only need "is this bridge session live right now", which the
 * bulk `/session-views` snapshot already answers per entry. This deliberately
 * stays a single bulk request per bridge: probing `/sessions/:id/active` per
 * session made `GET /api/projects` cost `1 + sessions x 2` sidecar requests,
 * and every one of those fanned out inside the OpenCode sidecar into a
 * per-directory reconciliation - enough short-lived sockets to exhaust the
 * host's ephemeral ports (EADDRNOTAVAIL).
 */
async function getActiveBridgeSessionViews(
  deps: Pick<ProjectsDeps, "codexBridgeService" | "opencodeBridgeService">,
): Promise<BridgeSessionView[]> {
  return listActiveBridgeSessionViews([
    deps.codexBridgeService,
    deps.opencodeBridgeService,
  ]);
}

function mergeBridgeSessions(
  sessions: SessionSummary[],
  bridgeViews: BridgeSessionView[],
): SessionSummary[] {
  if (bridgeViews.length === 0) return sessions;

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const existingIds = new Set(sessions.map((session) => session.id));
  for (const view of bridgeViews) {
    const existing = byId.get(view.session.id);
    byId.set(
      view.session.id,
      existing
        ? {
            ...view.session,
            ...existing,
            ownership: view.session.ownership,
            pendingInputType:
              view.session.pendingInputType ??
              view.pendingInputType ??
              existing.pendingInputType,
            activity:
              view.session.activity ?? view.activity ?? existing.activity,
            provider: view.session.provider,
            model: view.session.model ?? existing.model,
            source: view.session.source ?? existing.source,
          }
        : view.session,
    );
  }

  const bridgeOnly = bridgeViews
    .filter((view) => !existingIds.has(view.session.id))
    .map((view) => byId.get(view.session.id))
    .filter((session): session is SessionSummary => Boolean(session));
  const mergedExisting = sessions.map(
    (session) => byId.get(session.id) ?? session,
  );
  return [
    ...bridgeOnly.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    ),
    ...mergedExisting,
  ];
}

/**
 * Get activity counts for all projects.
 * All counts are keyed by UrlProjectId (base64url format).
 */
async function getProjectActivityCounts(
  ownedProcesses: OwnedProcessView[],
  externalTracker: ExternalSessionTracker | undefined,
): Promise<Map<string, ProjectActivityCounts>> {
  const counts = new Map<string, ProjectActivityCounts>();

  for (const process of ownedProcesses) {
    const existing = counts.get(process.projectId) || {
      activeOwnedCount: 0,
      activeExternalCount: 0,
    };
    existing.activeOwnedCount++;
    counts.set(process.projectId, existing);
  }

  // Count external sessions - convert to UrlProjectId for consistent keys
  if (externalTracker) {
    const ownedSessionIds = new Set(
      ownedProcesses.map((process) => process.sessionId),
    );
    for (const sessionId of externalTracker.getExternalSessions()) {
      if (ownedSessionIds.has(sessionId)) continue;
      const info =
        await externalTracker.getExternalSessionInfoWithUrlId(sessionId);
      if (info) {
        const existing = counts.get(info.projectId) || {
          activeOwnedCount: 0,
          activeExternalCount: 0,
        };
        existing.activeExternalCount++;
        counts.set(info.projectId, existing);
      }
    }
  }

  return counts;
}

async function getProjectGitStatusSummaries(
  projects: Project[],
  provider: (project: Project) => Promise<ProjectGitStatusSummary | null>,
): Promise<Map<string, ProjectGitStatusSummary | null>> {
  const summaries = new Map<string, ProjectGitStatusSummary | null>();
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < projects.length) {
      const index = nextIndex;
      nextIndex++;
      const project = projects[index];
      if (!project) continue;

      try {
        summaries.set(project.id, await provider(project));
      } catch {
        summaries.set(project.id, null);
      }
    }
  }

  const workerCount = Math.min(PROJECT_GIT_STATUS_CONCURRENCY, projects.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return summaries;
}

export function createProjectsRoutes(deps: ProjectsDeps): Hono {
  const routes = new Hono();

  /**
   * Get owned sessions for a project that might not be in the file list yet.
   * New sessions may not have user/assistant messages written to disk yet.
   */
  function getOwnedSessionsForProject(
    projectId: string,
    ownedProcesses: OwnedProcessView[],
  ): Map<string, SessionSummary> {
    const ownedSessions = new Map<string, SessionSummary>();

    for (const process of ownedProcesses) {
      if (process.projectId === projectId) {
        const now = new Date().toISOString();
        ownedSessions.set(process.sessionId, {
          id: process.sessionId,
          projectId: process.projectId,
          title: null, // Title will be populated once file has content
          fullTitle: null,
          createdAt: process.startedAt,
          updatedAt: now,
          messageCount: 0,
          ownership: {
            owner: "self",
            processId: process.id,
            permissionMode: process.permissionMode,
            modeVersion: process.modeVersion,
          },
          provider: process.provider,
        });
      }
    }

    return ownedSessions;
  }

  /**
   * Add missing owned sessions to the session list.
   * Newly created sessions may not have user/assistant messages written yet,
   * but we should still show them in the list if we own the process.
   */
  function addMissingOwnedSessions(
    sessions: SessionSummary[],
    projectId: string,
    ownedProcesses: OwnedProcessView[],
  ): SessionSummary[] {
    const ownedSessions = getOwnedSessionsForProject(projectId, ownedProcesses);
    if (ownedSessions.size === 0) return sessions;

    // Check which owned sessions are already in the list
    const existingIds = new Set(sessions.map((s) => s.id));

    // Add missing owned sessions at the beginning (they're new)
    const missingSessions: SessionSummary[] = [];
    for (const [sessionId, summary] of ownedSessions) {
      if (!existingIds.has(sessionId)) {
        missingSessions.push(summary);
      }
    }

    return [...missingSessions, ...sessions];
  }

  // Helper to enrich sessions with real status, notification state, and metadata
  function enrichSessions(
    sessions: SessionSummary[],
    ownedProcesses: OwnedProcessView[],
  ): SessionSummary[] {
    const processBySessionId = new Map(
      ownedProcesses.map((process) => [process.sessionId, process]),
    );
    return sessions.map((session) => {
      const process = processBySessionId.get(session.id);
      const isExternal = deps.externalTracker?.isExternal(session.id) ?? false;

      // Enrich with ownership
      const ownership = process
        ? {
            owner: "self" as const,
            processId: process.id,
            permissionMode: process.permissionMode,
            modeVersion: process.modeVersion,
          }
        : isExternal
          ? { owner: "external" as const }
          : session.ownership;

      // Enrich with notification data and agent activity
      let pendingInputType: PendingInputType | undefined;
      let activity: AgentActivity | undefined;
      if (process) {
        pendingInputType = process.pendingInputType;
        // Get the current agent activity (in-turn/waiting-input/idle)
        const state = process.state;
        if (state === "in-turn" || state === "waiting-input") {
          activity = state;
        }
      } else {
        pendingInputType = session.pendingInputType;
        activity = session.activity;
      }

      // Get last seen and unread status
      const lastSeenEntry = deps.notificationService?.getLastSeen(session.id);
      const lastSeenAt = lastSeenEntry?.timestamp;
      const hasUnread = deps.notificationService
        ? deps.notificationService.hasUnread(session.id, session.updatedAt)
        : undefined;

      // Get session metadata (custom title, AI title, archived, starred)
      const metadata = deps.sessionMetadataService?.getMetadata(session.id);
      const customTitle = metadata?.customTitle ?? session.customTitle;
      const aiTitle = metadata?.aiTitle ?? session.aiTitle;
      const isArchived = metadata?.isArchived ?? session.isArchived;
      const isStarred = metadata?.isStarred ?? session.isStarred;

      return {
        ...session,
        ownership,
        pendingInputType,
        activity,
        lastSeenAt,
        hasUnread,
        customTitle,
        aiTitle,
        isArchived,
        isStarred,
      };
    });
  }

  // GET /api/projects - List all projects
  routes.get("/", async (c) => {
    const rawProjects = await deps.scanner.listProjects();
    const gitStatusProvider =
      deps.gitStatusProvider ??
      ((project: Project) => getProjectGitStatusSummary(project.path));
    const [ownedProcesses, gitStatusSummaries, activeBridgeViews] =
      await Promise.all([
        loadOwnedProcessViews(deps),
        getProjectGitStatusSummaries(rawProjects, gitStatusProvider),
        getActiveBridgeSessionViews(deps),
      ]);
    const activityCounts = await getProjectActivityCounts(
      ownedProcesses,
      deps.externalTracker,
    );
    for (const view of activeBridgeViews) {
      const existing = activityCounts.get(view.session.projectId) || {
        activeOwnedCount: 0,
        activeExternalCount: 0,
      };
      existing.activeExternalCount++;
      activityCounts.set(view.session.projectId, existing);
    }

    // Enrich projects with active counts (all keyed by UrlProjectId now)
    const projects = rawProjects.map((project) => {
      const counts = activityCounts.get(project.id);
      return {
        ...project,
        activeOwnedCount: counts?.activeOwnedCount ?? 0,
        activeExternalCount: counts?.activeExternalCount ?? 0,
        gitStatus: gitStatusSummaries.get(project.id) ?? null,
      };
    });

    // Sort by lastActivity descending (most recent first), nulls last
    projects.sort((a, b) => {
      if (!a.lastActivity && !b.lastActivity) return 0;
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return (
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );
    });

    return c.json({ projects });
  });

  // GET /api/projects/:projectId - Get project info
  routes.get("/:projectId", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to support new projects without sessions yet
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    return c.json({ project });
  });

  // POST /api/projects - Add a project by path
  // Validates the path exists on disk and returns project info
  routes.post("/", async (c) => {
    let body: { path: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.path || typeof body.path !== "string") {
      return c.json({ error: "path is required" }, 400);
    }

    // Normalize path (remove trailing slashes, expand ~)
    let normalizedPath = body.path.trim();
    if (normalizedPath.startsWith("~")) {
      normalizedPath = normalizedPath.replace("~", homedir());
    }
    // Remove trailing slash/backslash
    if (normalizedPath.length > 1 && /[/\\]$/.test(normalizedPath)) {
      normalizedPath = normalizedPath.slice(0, -1);
    }
    normalizedPath = canonicalizeProjectPath(normalizedPath);

    // Validate path is absolute
    if (!isAbsolutePath(normalizedPath)) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    // Create projectId and try to get/create the project
    const projectId = toUrlProjectId(normalizedPath);
    const project = await deps.scanner.getOrCreateProject(projectId);

    if (!project) {
      return c.json(
        { error: "Path does not exist or is not a directory" },
        404,
      );
    }

    // Persist the project so it appears in future listings
    if (deps.projectMetadataService) {
      await deps.projectMetadataService.addProject(projectId, normalizedPath);
      deps.scanner.invalidateCache();
    }

    return c.json({ project });
  });

  // GET /api/projects/:projectId/sessions - List sessions
  routes.get("/:projectId/sessions", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to support new projects without sessions yet
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const providerCatalog = await buildProviderProjectCatalog({
      projects: [project],
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
      opencodeScanner: deps.opencodeScanner,
      kimiScanner: deps.kimiScanner,
    });
    let sessions = await listSessionsAcrossProviders(
      project,
      {
        readerFactory: deps.readerFactory,
        sessionIndexService: deps.sessionIndexService,
        codexSessionsDir: deps.codexSessionsDir,
        codexReaderFactory: deps.codexReaderFactory,
        geminiSessionsDir: deps.geminiSessionsDir,
        geminiReaderFactory: deps.geminiReaderFactory,
        geminiHashToCwd: providerCatalog.geminiHashToCwd,
        opencodeDbPath: deps.opencodeDbPath,
        opencodeReaderFactory: deps.opencodeReaderFactory,
        kimiSessionsDir: deps.kimiSessionsDir,
        kimiReaderFactory: deps.kimiReaderFactory,
      },
      providerCatalog,
    );

    const activeBridgeViews = (await getActiveBridgeSessionViews(deps)).filter(
      (view) => view.session.projectId === projectId,
    );
    sessions = mergeBridgeSessions(sessions, activeBridgeViews);

    // Add missing owned sessions (new sessions that don't have user/assistant messages yet)
    const ownedProcesses = await loadOwnedProcessViews(deps);
    sessions = addMissingOwnedSessions(sessions, projectId, ownedProcesses);

    return c.json({ sessions: enrichSessions(sessions, ownedProcesses) });
  });

  return routes;
}
