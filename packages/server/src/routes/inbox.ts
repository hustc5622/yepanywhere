/**
 * Inbox route - aggregates sessions across all projects into prioritized tiers.
 *
 * Tiers (in priority order):
 * 1. needsAttention - Sessions with pendingInputType set (tool-approval or user-question)
 * 2. active - Sessions with processState === 'running' but no pending input
 * 3. recentActivity - Sessions updated in the last hour (not in tiers 1-2)
 * 4. unread8h - Sessions with hasUnread and updatedAt within 8 hours (not in tiers 1-3)
 * 5. unread24h - Sessions with hasUnread and updatedAt within 24 hours (not in tiers 1-4)
 */

import {
  type SessionCreatedBy,
  getSessionDisplayTitle,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  getAnyBridgePendingInputRequest,
  listAllBridgeSessionViews,
} from "../bridge-common/multi.js";
import {
  isActiveBridgeSessionView,
  isLiveBridgeSessionView,
} from "../bridge-common/session-state.js";
import type { BridgeSessionView } from "../bridge-common/types.js";
import type { CodexBridgeController } from "../codex-bridge/types.js";
import type { SessionIndexService } from "../indexes/index.js";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import type { OpenCodeBridgeController } from "../opencode-bridge/types.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { KimiSessionScanner } from "../projects/kimi-scanner.js";
import type { OpenCodeSessionScanner } from "../projects/opencode-scanner.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { RuntimeController } from "../runtime/types.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import type { KimiSessionReader } from "../sessions/kimi-reader.js";
import type { OpenCodeSessionReader } from "../sessions/opencode-reader.js";
import { listSessionsAcrossProviders } from "../sessions/provider-resolution.js";
import {
  type SessionRuntimeProcess,
  getProcessActivity,
  pendingInputRequestIdFromProcess,
  pendingInputTypeFromProcess,
} from "../sessions/session-runtime.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  AgentActivity,
  PendingInputType,
  Project,
  SessionSummary,
} from "../supervisor/types.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";

export interface InboxDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  runtimeController?: RuntimeController;
  notificationService?: NotificationService;
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  codexScanner?: CodexSessionScanner;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  opencodeScanner?: OpenCodeSessionScanner;
  opencodeDbPath?: string;
  opencodeReaderFactory?: (projectPath: string) => OpenCodeSessionReader;
  kimiScanner?: KimiSessionScanner;
  kimiSessionsDir?: string;
  kimiReaderFactory?: (projectPath: string) => KimiSessionReader;
  codexBridgeService?: CodexBridgeController;
  opencodeBridgeService?: OpenCodeBridgeController;
}

async function listBridgeSessionViews(
  deps: Pick<InboxDeps, "codexBridgeService" | "opencodeBridgeService">,
): Promise<BridgeSessionView[]> {
  return listAllBridgeSessionViews([
    deps.codexBridgeService,
    deps.opencodeBridgeService,
  ]);
}

/**
 * Request id of a bridge session's pending input. Only called for sessions
 * that already report a pendingInputType, so the extra sidecar round-trip is
 * bounded by the number of sessions actually waiting on the user.
 */
async function getBridgePendingRequestId(
  deps: Pick<InboxDeps, "codexBridgeService" | "opencodeBridgeService">,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const request = await getAnyBridgePendingInputRequest(
      [deps.codexBridgeService, deps.opencodeBridgeService],
      sessionId,
    );
    return request?.id;
  } catch {
    return undefined;
  }
}

function isLiveAnyBridgeSessionView(view: BridgeSessionView): boolean {
  return isLiveBridgeSessionView(view);
}

export interface InboxItem {
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle: string;
  updatedAt: string;
  pendingInputType?: PendingInputType;
  /** Pending request id, so notification actions can respond directly. */
  pendingRequestId?: string;
  activity?: AgentActivity;
  hasUnread?: boolean;
  createdBy?: SessionCreatedBy;
  originator?: string;
  source?: string;
}

export interface InboxResponse {
  badgeCount: number;
  badgeSessionIds: string[];
  needsAttention: InboxItem[];
  active: InboxItem[];
  recentActivity: InboxItem[];
  unread8h: InboxItem[];
  unread24h: InboxItem[];
}

/** Maximum items per tier to keep response size manageable */
const MAX_ITEMS_PER_TIER = 20;

/** Time thresholds in milliseconds */
const ONE_HOUR_MS = 60 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
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

export function createInboxRoutes(deps: InboxDeps): Hono {
  const routes = new Hono();

  // GET /api/inbox - Get prioritized inbox of sessions
  // Optional query param: projectId - filter to a single project
  routes.get("/", async (c) => {
    const now = Date.now();
    const filterProjectId = c.req.query("projectId");
    const allProjects = await deps.scanner.listProjects();

    // Filter to single project if projectId query param provided
    const projects = filterProjectId
      ? allProjects.filter((p) => p.id === filterProjectId)
      : allProjects;
    const processBySessionId = new Map<string, SessionRuntimeProcess>();
    const activeProcessProjectIds = new Set<string>();
    if (deps.runtimeController) {
      for (const process of await deps.runtimeController.listProcessSnapshots()) {
        processBySessionId.set(process.sessionId, process);
        activeProcessProjectIds.add(process.projectId);
      }
    } else {
      for (const process of deps.supervisor?.getAllProcesses?.() ?? []) {
        processBySessionId.set(process.sessionId, process);
        activeProcessProjectIds.add(process.projectId);
      }
    }
    const oldestInboxActivityTime = now - TWENTY_FOUR_HOURS_MS;
    const projectsForInboxScan = filterProjectId
      ? projects
      : projects
          .filter((project) => {
            if (activeProcessProjectIds.has(project.id)) return true;
            const lastActivity = timestampMs(project.lastActivity);
            return (
              lastActivity === null || lastActivity >= oldestInboxActivityTime
            );
          })
          .sort(compareProjectsByLastActivityDesc);

    // Collect all sessions with enriched data
    const allSessions: Array<{
      session: SessionSummary;
      projectName: string;
      pendingInputType?: PendingInputType;
      pendingRequestId?: string;
      activity?: AgentActivity;
      hasUnread?: boolean;
      customTitle?: string;
      aiTitle?: string;
      createdBy?: SessionCreatedBy;
      originator?: string;
      source?: string;
    }> = [];

    const logger = getLogger();
    const providerCatalog = await buildProviderProjectCatalog({
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
      opencodeScanner: deps.opencodeScanner,
      kimiScanner: deps.kimiScanner,
    });
    const bridgeSessionViews = await listBridgeSessionViews(deps);
    const bridgedSessionById = new Map(
      bridgeSessionViews.map((item) => [item.session.id, item]),
    );
    // The sidecar's liveness verdict rides along in the bulk snapshot, so this
    // no longer costs one extra bridge request per bridge session. Semantics
    // are unchanged: a stale view that still claims `in-turn` while the CLI
    // holds no connection stays out of the active/needs-attention tiers.
    const activeBridgeSessionIds = new Set(
      bridgeSessionViews
        .filter((item) => isActiveBridgeSessionView(item))
        .map((item) => item.session.id),
    );

    // Fetch sessions from all projects in parallel
    const projectSessionResults = await Promise.all(
      projectsForInboxScan.map(async (project) => {
        try {
          const sessions = await listSessionsAcrossProviders(
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
              allowStaleSessionCache: true,
            },
            providerCatalog,
          );
          return { project, sessions };
        } catch (err) {
          logger.warn(
            { err, projectId: project.id },
            "Failed to fetch sessions for inbox project",
          );
          return { project, sessions: [] as SessionSummary[] };
        }
      }),
    );

    // Enrich each session with process state and notification data
    for (const { project, sessions } of projectSessionResults) {
      for (const session of sessions) {
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const isArchived = metadata?.isArchived ?? session.isArchived ?? false;
        if (isArchived) continue;

        let pendingInputType: PendingInputType | undefined;
        let pendingRequestId: string | undefined;
        let activity: AgentActivity | undefined;

        const process =
          processBySessionId.get(session.id) ??
          deps.supervisor?.getProcessForSession?.(session.id);
        if (process) {
          pendingInputType = pendingInputTypeFromProcess(process);
          pendingRequestId = pendingInputRequestIdFromProcess(process);
          const state = getProcessActivity(process);
          if (state === "in-turn" || state === "waiting-input") {
            activity = state;
          }
        } else {
          const bridgedSession = bridgedSessionById.get(session.id) ?? null;
          if (
            bridgedSession &&
            activeBridgeSessionIds.has(bridgedSession.session.id)
          ) {
            pendingInputType = bridgedSession.pendingInputType;
            activity = bridgedSession.activity;
            if (pendingInputType) {
              pendingRequestId = await getBridgePendingRequestId(
                deps,
                session.id,
              );
            }
          }
        }

        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(session.id, session.updatedAt)
          : undefined;

        allSessions.push({
          session,
          projectName: project.name,
          pendingInputType,
          pendingRequestId,
          activity,
          hasUnread,
          customTitle: metadata?.customTitle ?? session.customTitle,
          aiTitle: metadata?.aiTitle ?? session.aiTitle,
          createdBy: metadata?.createdBy ?? session.createdBy,
          originator: session.originator,
          source: session.source,
        });
      }
    }

    const knownSessionIds = new Set(allSessions.map((item) => item.session.id));
    for (const item of bridgeSessionViews) {
      if (knownSessionIds.has(item.session.id)) continue;
      if (filterProjectId && item.session.projectId !== filterProjectId) {
        continue;
      }

      const metadata = deps.sessionMetadataService?.getMetadata(
        item.session.id,
      );
      const isArchived =
        metadata?.isArchived ?? item.session.isArchived ?? false;
      if (isArchived) continue;

      const hasUnread = deps.notificationService
        ? deps.notificationService.hasUnread(
            item.session.id,
            item.session.updatedAt,
          )
        : undefined;

      const bridgeOnlyActive = activeBridgeSessionIds.has(item.session.id);
      const bridgeOnlyPendingType = bridgeOnlyActive
        ? item.pendingInputType
        : undefined;
      allSessions.push({
        session: item.session,
        projectName: item.projectName,
        pendingInputType: bridgeOnlyPendingType,
        pendingRequestId: bridgeOnlyPendingType
          ? await getBridgePendingRequestId(deps, item.session.id)
          : undefined,
        activity: bridgeOnlyActive ? item.activity : undefined,
        hasUnread,
        customTitle: metadata?.customTitle ?? item.session.customTitle,
        aiTitle: metadata?.aiTitle ?? item.session.aiTitle,
        createdBy: metadata?.createdBy ?? item.session.createdBy,
        originator: item.session.originator,
        source: item.session.source,
      });
    }

    // Build the inbox response by categorizing into tiers
    const needsAttention: InboxItem[] = [];
    const active: InboxItem[] = [];
    const recentActivity: InboxItem[] = [];
    const unread8h: InboxItem[] = [];
    const unread24h: InboxItem[] = [];

    // Track which sessions have been assigned to a tier
    const assignedSessionIds = new Set<string>();

    // Helper to convert to InboxItem
    const toInboxItem = (item: (typeof allSessions)[0]): InboxItem => ({
      sessionId: item.session.id,
      projectId: item.session.projectId,
      projectName: item.projectName,
      sessionTitle: getSessionDisplayTitle({
        customTitle: item.customTitle,
        aiTitle: item.aiTitle,
        title: item.session.title,
      }),
      updatedAt: item.session.updatedAt,
      pendingInputType: item.pendingInputType,
      pendingRequestId: item.pendingRequestId,
      activity: item.activity,
      hasUnread: item.hasUnread,
      createdBy: item.createdBy,
      originator: item.originator,
      source: item.source,
    });

    // Tier 1: needsAttention - sessions with pending input
    for (const item of allSessions) {
      if (item.pendingInputType) {
        needsAttention.push(toInboxItem(item));
        assignedSessionIds.add(item.session.id);
      }
    }

    // Tier 2: active - in-turn sessions without pending input
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      if (item.activity === "in-turn") {
        active.push(toInboxItem(item));
        assignedSessionIds.add(item.session.id);
      }
    }

    // Tier 3: recentActivity - updated in last hour
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      const updatedAt = new Date(item.session.updatedAt).getTime();
      if (now - updatedAt <= ONE_HOUR_MS) {
        recentActivity.push(toInboxItem(item));
        assignedSessionIds.add(item.session.id);
      }
    }

    // Tier 4: unread8h - unread and updated within 8 hours
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      if (item.hasUnread) {
        const updatedAt = new Date(item.session.updatedAt).getTime();
        if (now - updatedAt <= EIGHT_HOURS_MS) {
          unread8h.push(toInboxItem(item));
          assignedSessionIds.add(item.session.id);
        }
      }
    }

    // Tier 5: unread24h - unread and updated within 24 hours
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      if (item.hasUnread) {
        const updatedAt = new Date(item.session.updatedAt).getTime();
        if (now - updatedAt <= TWENTY_FOUR_HOURS_MS) {
          unread24h.push(toInboxItem(item));
          assignedSessionIds.add(item.session.id);
        }
      }
    }

    // Sort each tier by updatedAt descending (most recent first)
    const sortByUpdatedAt = (a: InboxItem, b: InboxItem) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

    needsAttention.sort(sortByUpdatedAt);
    active.sort(sortByUpdatedAt);
    recentActivity.sort(sortByUpdatedAt);
    unread8h.sort(sortByUpdatedAt);
    unread24h.sort(sortByUpdatedAt);

    const badgeSessionIds = new Set(
      needsAttention.map((item) => item.sessionId),
    );

    // Apply limits per tier
    const response: InboxResponse = {
      badgeCount: badgeSessionIds.size,
      badgeSessionIds: Array.from(badgeSessionIds),
      needsAttention: needsAttention.slice(0, MAX_ITEMS_PER_TIER),
      active: active.slice(0, MAX_ITEMS_PER_TIER),
      recentActivity: recentActivity.slice(0, MAX_ITEMS_PER_TIER),
      unread8h: unread8h.slice(0, MAX_ITEMS_PER_TIER),
      unread24h: unread24h.slice(0, MAX_ITEMS_PER_TIER),
    };

    return c.json(response);
  });

  return routes;
}
