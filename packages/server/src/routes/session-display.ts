import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  type InputRequest,
  type ProviderName,
  SESSION_DISPLAY_INITIAL_TURN_LIMIT,
  SESSION_DISPLAY_TOOL_DETAIL_PAGE_LIMIT,
  type SessionBranchState,
  type SessionDisplayPage,
  type SessionQuestionPage,
  SessionQuestionPageSchema,
  type SessionThinkingDetail,
  type SessionToolGroupDetailPage,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { Context, Hono } from "hono";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import type { CodexAppServerHistoryReader } from "../codex-history/CodexAppServerHistoryReader.js";
import type { ProjectScanner } from "../projects/scanner.js";
import {
  buildSessionDisplayProjection,
  decodeSessionDisplayDetailRef,
  selectSessionDisplayToolMessages,
} from "../sessions/display-projection.js";
import {
  annotateBranchMessages,
  normalizeSession,
} from "../sessions/normalization.js";
import { augmentPersistedSessionMessages } from "../sessions/persisted-augments.js";
import {
  type ProviderResolutionDeps,
  type SessionSource,
  findSessionSummaryAcrossProviders,
} from "../sessions/provider-resolution.js";
import type { GetSessionOptions, LoadedSession } from "../sessions/types.js";
import { compactQuestionText } from "../sessions/user-questions.js";
import type {
  Message,
  Project,
  Session,
  SessionSummary,
} from "../supervisor/types.js";

const DISPLAY_READER_MESSAGE_PAGE = 200;
const DISPLAY_ACTIVE_READER_MESSAGE_PAGE = 1_000;
const DISPLAY_MAX_READER_PAGES = 25;
const QUESTION_PAGE_LIMIT = 100;
const DETAIL_AROUND_MESSAGE_LIMIT = 5_000;

type CursorKind = "display" | "questions" | "details";
type CursorSource = "app-server" | "reader" | "memory";

interface SessionDisplayCursor {
  version: 1;
  kind: CursorKind;
  revision: string;
  source: CursorSource;
  anchor?: string;
  branchId?: string;
  detailRef?: string;
  offset?: number;
}

export interface SessionDisplayRuntimeState {
  provider?: ProviderName;
  toolsMayBeActive: boolean;
  pendingInputRequest?: InputRequest | null;
}

export interface SessionDisplayRoutesDeps {
  scanner: Pick<ProjectScanner, "getOrCreateProject">;
  providerResolution: ProviderResolutionDeps;
  codexAppServerHistoryReader?: Pick<
    CodexAppServerHistoryReader,
    "getSemanticTurnsPage" | "getSemanticTurn"
  >;
  getCanonicalSessionId?: (sessionId: string) => string;
  getPersistedProvider?: (sessionId: string) => ProviderName | undefined;
  getRuntimeState?: (sessionId: string) => Promise<SessionDisplayRuntimeState>;
  getBranchState?: (
    project: Project,
    sessionId: string,
    currentSummary: SessionSummary,
    selectedBranchId?: string,
  ) => Promise<SessionBranchState | undefined>;
}

interface ResolvedDisplaySession {
  project: Project;
  sessionId: string;
  source: SessionSource;
  summary: SessionSummary;
  runtime: SessionDisplayRuntimeState;
}

class SessionDisplayRouteError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function registerSessionDisplayRoutes(
  routes: Hono,
  deps: SessionDisplayRoutesDeps,
): void {
  routes.get("/projects/:projectId/sessions/:sessionId/display", async (c) => {
    try {
      const resolved = await resolveDisplaySession(
        deps,
        c.req.param("projectId"),
        c.req.param("sessionId"),
      );
      const cursor = parseOptionalCursor(
        resolved.sessionId,
        c.req.query("cursor"),
        "display",
      );
      const branchId = c.req.query("branchId") || undefined;
      assertCursorBranch(cursor, branchId);
      const requestedLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(100, requestedLimit))
        : SESSION_DISPLAY_INITIAL_TURN_LIMIT;
      const page = await readDisplayPage(
        deps,
        resolved,
        cursor,
        branchId,
        limit,
      );
      return c.json(page);
    } catch (error) {
      return displayErrorResponse(c, error);
    }
  });

  routes.get(
    "/projects/:projectId/sessions/:sessionId/display/questions",
    async (c) => {
      try {
        const resolved = await resolveDisplaySession(
          deps,
          c.req.param("projectId"),
          c.req.param("sessionId"),
          false,
        );
        const cursor = parseOptionalCursor(
          resolved.sessionId,
          c.req.query("cursor"),
          "questions",
        );
        const branchId = c.req.query("branchId") || undefined;
        assertCursorBranch(cursor, branchId);
        const page = await readQuestionPage(deps, resolved, cursor, branchId);
        return c.json(page);
      } catch (error) {
        return displayErrorResponse(c, error);
      }
    },
  );

  routes.get(
    "/projects/:projectId/sessions/:sessionId/display/tool-groups/:detailRef",
    async (c) => {
      try {
        const resolved = await resolveDisplaySession(
          deps,
          c.req.param("projectId"),
          c.req.param("sessionId"),
        );
        const revision = c.req.query("revision");
        if (!revision) {
          throw new SessionDisplayRouteError(
            400,
            "SESSION_DISPLAY_REVISION_REQUIRED",
            "revision is required for tool details",
          );
        }
        const branchId = c.req.query("branchId") || undefined;
        const detailRef = c.req.param("detailRef");
        const cursor = parseOptionalCursor(
          resolved.sessionId,
          c.req.query("cursor"),
          "details",
        );
        assertCursorBranch(cursor, branchId);
        if (
          cursor &&
          (cursor.revision !== revision || cursor.detailRef !== detailRef)
        ) {
          throw staleDisplayError();
        }
        const page = await readToolGroupDetails(
          deps,
          resolved,
          revision,
          detailRef,
          cursor?.offset ?? 0,
          branchId,
        );
        return c.json(page);
      } catch (error) {
        return displayErrorResponse(c, error);
      }
    },
  );
  routes.get(
    "/projects/:projectId/sessions/:sessionId/display/thinking/:detailRef",
    async (c) => {
      try {
        const resolved = await resolveDisplaySession(
          deps,
          c.req.param("projectId"),
          c.req.param("sessionId"),
        );
        const revision = c.req.query("revision");
        if (!revision) {
          throw new SessionDisplayRouteError(
            400,
            "SESSION_DISPLAY_REVISION_REQUIRED",
            "revision is required for reasoning details",
          );
        }
        const branchId = c.req.query("branchId") || undefined;
        const detail = await readThinkingDetail(
          deps,
          resolved,
          revision,
          c.req.param("detailRef"),
          branchId,
        );
        return c.json(detail);
      } catch (error) {
        return displayErrorResponse(c, error);
      }
    },
  );
}

async function resolveDisplaySession(
  deps: SessionDisplayRoutesDeps,
  projectId: string,
  requestedSessionId: string,
  includeRuntime = true,
): Promise<ResolvedDisplaySession> {
  if (!isUrlProjectId(projectId)) {
    throw new SessionDisplayRouteError(
      400,
      "INVALID_PROJECT_ID",
      "Invalid project ID format",
    );
  }
  const project = await deps.scanner.getOrCreateProject(projectId);
  if (!project) {
    throw new SessionDisplayRouteError(
      404,
      "PROJECT_NOT_FOUND",
      "Project not found",
    );
  }
  const sessionId =
    deps.getCanonicalSessionId?.(requestedSessionId) ?? requestedSessionId;
  const runtime = includeRuntime
    ? ((await deps.getRuntimeState?.(sessionId)) ?? {
        toolsMayBeActive: false,
      })
    : { toolsMayBeActive: false };
  const preferredProvider =
    runtime.provider ?? deps.getPersistedProvider?.(sessionId);
  const resolved = await findSessionSummaryAcrossProviders(
    project,
    sessionId,
    project.id,
    deps.providerResolution,
    preferredProvider,
  );
  if (!resolved) {
    throw new SessionDisplayRouteError(
      404,
      "SESSION_NOT_FOUND",
      "Session not found",
    );
  }
  return {
    project,
    sessionId,
    source: resolved.source,
    summary: resolved.summary,
    runtime,
  };
}

async function readDisplayPage(
  deps: SessionDisplayRoutesDeps,
  resolved: ResolvedDisplaySession,
  cursor: SessionDisplayCursor | null,
  branchId: string | undefined,
  limit: number,
): Promise<SessionDisplayPage> {
  const appServer = deps.codexAppServerHistoryReader;
  const codexSource =
    resolved.source.provider === "codex" ||
    resolved.source.provider === "codex-oss";
  if (appServer && codexSource && (!cursor || cursor.source === "app-server")) {
    const native = await appServer.getSemanticTurnsPage(
      resolved.sessionId,
      resolved.project.id,
      resolved.project.path,
      {
        cursor: cursor?.anchor,
        limit,
        itemsView: "full",
        expectedRevision: cursor?.revision,
      },
    );
    if (native.kind === "loaded") {
      const branchState = await deps.getBranchState?.(
        resolved.project,
        resolved.sessionId,
        resolved.summary,
        branchId,
      );
      const projection = buildSessionDisplayProjection({
        sessionId: resolved.sessionId,
        revision: native.revision,
        messages: branchState
          ? annotateBranchMessages(native.messages, branchState, {
              includeCodexAlias: true,
            })
          : native.messages,
        questionCoverage: native.nextCursor ? "partial" : "complete",
        ...(!cursor && resolved.runtime.pendingInputRequest
          ? { pendingInputRequest: resolved.runtime.pendingInputRequest }
          : {}),
        toolsMayBeActive: !cursor && resolved.runtime.toolsMayBeActive,
      });
      if (
        !nativeCompletePageMissesIndexedQuestions(
          resolved,
          projection.questions.questions.length,
          cursor,
          branchId,
          native.nextCursor,
        )
      ) {
        const page: SessionDisplayPage = {
          ...projection.page,
          ...(native.nextCursor
            ? {
                nextCursor: encodeCursor(resolved.sessionId, {
                  version: 1,
                  kind: "display",
                  revision: native.revision,
                  source: "app-server",
                  anchor: native.nextCursor,
                  ...(branchId ? { branchId } : {}),
                }),
              }
            : {}),
        };
        return augmentDisplayAssistantText(page);
      }
    }
    if (cursor) throw staleDisplayError();
  } else if (cursor?.source === "app-server") {
    throw staleDisplayError();
  }

  return readGenericDisplayPage(deps, resolved, cursor, branchId, limit);
}

/**
 * A lagging Codex thread-history projection can still answer turns/list with
 * no cursor, making a truncated prefix look complete. The rollout summary is
 * scanned independently, so a complete question index proves when that
 * native page omitted durable user turns. Only compare the first active-branch
 * page: branch and cursor pages intentionally contain subsets. A native page
 * with more questions is accepted because the summary may lag a live append.
 */
function nativeCompletePageMissesIndexedQuestions(
  resolved: ResolvedDisplaySession,
  nativeQuestionCount: number,
  cursor: SessionDisplayCursor | null,
  branchId: string | undefined,
  nativeNextCursor: string | undefined,
): boolean {
  if (
    cursor ||
    branchId ||
    nativeNextCursor ||
    resolved.summary.userQuestionCoverage !== "complete"
  ) {
    return false;
  }
  return nativeQuestionCount < (resolved.summary.userQuestions?.length ?? 0);
}

async function readGenericDisplayPage(
  deps: SessionDisplayRoutesDeps,
  resolved: ResolvedDisplaySession,
  cursor: SessionDisplayCursor | null,
  branchId: string | undefined,
  limit: number,
): Promise<SessionDisplayPage> {
  if (cursor?.source === "app-server") throw staleDisplayError();
  let beforeMessageId = cursor?.source === "reader" ? cursor.anchor : undefined;
  let rawRolloutRevision: string | undefined;
  let revision: string | undefined;
  let mergedMessages: Message[] = [];
  let hasOlderMessages = false;
  let readerWindowed = false;
  const activeTailSnapshot =
    !cursor && resolved.runtime.toolsMayBeActive && !branchId;
  const branchState = await deps.getBranchState?.(
    resolved.project,
    resolved.sessionId,
    resolved.summary,
    branchId,
  );

  for (
    let pageIndex = 0;
    pageIndex < DISPLAY_MAX_READER_PAGES;
    pageIndex += 1
  ) {
    const options: GetSessionOptions = {
      includeOrphans: false,
      branchId,
      deferMedia: true,
      deferThinking: true,
      maxMessages: activeTailSnapshot
        ? DISPLAY_ACTIVE_READER_MESSAGE_PAGE
        : DISPLAY_READER_MESSAGE_PAGE,
      beforeMessageId,
      rolloutRevision: rawRolloutRevision,
    };
    const loaded = await resolved.source.reader.getSession(
      resolved.sessionId,
      resolved.project.id,
      undefined,
      options,
    );
    if (!loaded) throw sessionNotFoundError();
    const session = normalizeSession(loaded, {
      deferMedia: true,
      deferThinking: true,
    });
    const pageRevision = await computeGenericRevision(
      resolved.source,
      loaded,
      session,
      branchId,
    );
    revision ??= pageRevision;
    if (pageRevision !== revision || (cursor && cursor.revision !== revision)) {
      throw staleDisplayError();
    }
    readerWindowed = loaded.paginationApplied === true && !!loaded.pagination;
    if (
      cursor &&
      ((cursor.source === "reader" && !readerWindowed) ||
        (cursor.source === "memory" && readerWindowed))
    ) {
      throw staleDisplayError();
    }
    rawRolloutRevision ??= loaded.pagination?.rolloutRevision;
    mergedMessages = mergeChronologicalMessages(
      branchState
        ? annotateBranchMessages(session.messages, branchState, {
            includeCodexAlias: true,
          })
        : session.messages,
      mergedMessages,
    );
    hasOlderMessages = loaded.pagination?.hasOlderMessages === true;
    const provisional = buildSessionDisplayProjection({
      sessionId: resolved.sessionId,
      revision,
      messages: mergedMessages,
      questionCoverage: hasOlderMessages ? "partial" : "complete",
      toolsMayBeActive: resolved.runtime.toolsMayBeActive,
      provider: resolved.source.provider,
    });
    if (activeTailSnapshot) break;
    if (
      !readerWindowed ||
      provisional.questions.questions.length >= limit ||
      !hasOlderMessages
    ) {
      break;
    }
    beforeMessageId = loaded.pagination?.truncatedBeforeMessageId;
    if (!beforeMessageId) {
      throw new SessionDisplayRouteError(
        503,
        "SESSION_DISPLAY_BOUNDARY_UNAVAILABLE",
        "Could not reach a complete user turn boundary",
      );
    }
    if (pageIndex === DISPLAY_MAX_READER_PAGES - 1) {
      throw new SessionDisplayRouteError(
        413,
        "SESSION_DISPLAY_TURN_TOO_LARGE",
        "A user turn exceeds the safe display scan budget",
      );
    }
  }

  if (!revision) throw sessionNotFoundError();
  const projection = buildSessionDisplayProjection({
    sessionId: resolved.sessionId,
    revision,
    ...(rawRolloutRevision ? { detailSourceRevision: rawRolloutRevision } : {}),
    messages: mergedMessages,
    questionCoverage: hasOlderMessages ? "partial" : "complete",
    ...(!cursor && resolved.runtime.pendingInputRequest
      ? { pendingInputRequest: resolved.runtime.pendingInputRequest }
      : {}),
    toolsMayBeActive: !cursor && resolved.runtime.toolsMayBeActive,
    provider: resolved.source.provider,
  });
  const selected = selectDisplayTurns(
    projection.page,
    limit,
    cursor?.source === "memory" ? cursor.anchor : undefined,
    hasOlderMessages,
  );
  const firstQuestion = selected.turns.find((turn) => turn.question)?.question;
  const hasOlder = selected.hasOlder || hasOlderMessages;
  if (hasOlder && !firstQuestion) {
    throw new SessionDisplayRouteError(
      503,
      "SESSION_DISPLAY_BOUNDARY_UNAVAILABLE",
      "Could not identify the next user turn cursor",
    );
  }
  const page: SessionDisplayPage = {
    sessionId: resolved.sessionId,
    revision,
    turns: selected.turns,
    ...(hasOlder && firstQuestion
      ? {
          nextCursor: encodeCursor(resolved.sessionId, {
            version: 1,
            kind: "display",
            revision,
            source: readerWindowed ? "reader" : "memory",
            anchor: readerWindowed
              ? firstQuestion.messageId
              : selected.firstTurnId,
            ...(branchId ? { branchId } : {}),
          }),
        }
      : {}),
  };
  return augmentDisplayAssistantText(page);
}

/**
 * Keep the compact display projection renderer-complete for the text that is
 * actually visible. Tool bodies remain lazy, while assistant Markdown retains
 * links, lists, code blocks and the same sanitized HTML used by legacy reads.
 */
async function augmentDisplayAssistantText(
  page: SessionDisplayPage,
): Promise<SessionDisplayPage> {
  await Promise.all(
    page.turns.flatMap((turn) =>
      turn.segments.map(async (segment) => {
        if (segment.type !== "assistant_text" || !segment.content.trim()) {
          return;
        }
        try {
          segment.renderedHtml = await renderMarkdownToHtml(segment.content);
        } catch {
          // Rendering is best-effort; the client retains a readable plain-text
          // fallback if an individual Markdown augment cannot be generated.
        }
      }),
    ),
  );
  return page;
}

function selectDisplayTurns(
  page: SessionDisplayPage,
  limit: number,
  beforeTurnId: string | undefined,
  hasOlderUnderlying: boolean,
): {
  turns: SessionDisplayPage["turns"];
  hasOlder: boolean;
  firstTurnId?: string;
} {
  let eligible = page.turns;
  if (beforeTurnId) {
    const beforeIndex = eligible.findIndex((turn) => turn.id === beforeTurnId);
    if (beforeIndex < 0) throw staleDisplayError();
    eligible = eligible.slice(0, beforeIndex);
  }
  const questionIndices = eligible.flatMap((turn, index) =>
    turn.question ? [index] : [],
  );
  if (questionIndices.length === 0) {
    return {
      turns: hasOlderUnderlying ? [] : eligible,
      hasOlder: hasOlderUnderlying,
    };
  }
  const selectedQuestionOffset = Math.max(0, questionIndices.length - limit);
  const firstQuestionIndex = questionIndices[selectedQuestionOffset] ?? 0;
  const includePreamble = firstQuestionIndex === 0 && !hasOlderUnderlying;
  const startIndex = includePreamble ? 0 : firstQuestionIndex;
  const turns = eligible.slice(startIndex);
  return {
    turns,
    hasOlder: selectedQuestionOffset > 0,
    firstTurnId: turns.find((turn) => turn.question)?.id,
  };
}

async function readQuestionPage(
  deps: SessionDisplayRoutesDeps,
  resolved: ResolvedDisplaySession,
  cursor: SessionDisplayCursor | null,
  branchId: string | undefined,
): Promise<SessionQuestionPage> {
  const appServer = deps.codexAppServerHistoryReader;
  const codexSource =
    resolved.source.provider === "codex" ||
    resolved.source.provider === "codex-oss";
  if (appServer && codexSource && (!cursor || cursor.source === "app-server")) {
    const native = await appServer.getSemanticTurnsPage(
      resolved.sessionId,
      resolved.project.id,
      resolved.project.path,
      {
        cursor: cursor?.anchor,
        limit: QUESTION_PAGE_LIMIT,
        itemsView: "summary",
        expectedRevision: cursor?.revision,
      },
    );
    if (native.kind === "loaded") {
      const projection = buildSessionDisplayProjection({
        sessionId: resolved.sessionId,
        revision: native.revision,
        messages: native.messages,
        questionCoverage: native.nextCursor ? "partial" : "complete",
      });
      if (
        !nativeCompletePageMissesIndexedQuestions(
          resolved,
          projection.questions.questions.length,
          cursor,
          branchId,
          native.nextCursor,
        )
      ) {
        return SessionQuestionPageSchema.parse({
          ...projection.questions,
          ...(native.nextCursor
            ? {
                nextCursor: encodeCursor(resolved.sessionId, {
                  version: 1,
                  kind: "questions",
                  revision: native.revision,
                  source: "app-server",
                  anchor: native.nextCursor,
                  ...(branchId ? { branchId } : {}),
                }),
              }
            : {}),
        });
      }
    }
    if (cursor) throw staleDisplayError();
  } else if (cursor?.source === "app-server") {
    throw staleDisplayError();
  }

  const directSummary =
    (await resolved.source.reader.getSessionSummary(
      resolved.sessionId,
      resolved.project.id,
    )) ?? resolved.summary;
  const revision = await computeSummaryRevision(resolved.source, directSummary);
  if (cursor && cursor.revision !== revision) throw staleDisplayError();
  let questions = branchId
    ? undefined
    : directSummary.userQuestions?.map((question) => ({
        messageId: question.id,
        turnId: question.turnId ?? `turn:${question.id}`,
        ...(question.clientUserMessageId
          ? { clientUserMessageId: question.clientUserMessageId }
          : {}),
        ...(question.codexCorrelationKey
          ? { codexCorrelationKey: question.codexCorrelationKey }
          : {}),
        // Older indexes may contain question text created before the public
        // preview bound was enforced. Normalize it again at the API boundary.
        preview: compactQuestionText(question.text),
        ...(question.timestamp ? { timestamp: question.timestamp } : {}),
      }));
  if (directSummary.userQuestionCoverage === "partial") {
    // The bounded summary index intentionally caps very large Codex sessions.
    // Fall back to the complete normalized read instead of presenting that cap
    // as authoritative coverage.
    questions = undefined;
  }
  if (!questions) {
    const loaded = await resolved.source.reader.getSession(
      resolved.sessionId,
      resolved.project.id,
      undefined,
      { branchId, deferMedia: true, deferThinking: true },
    );
    if (!loaded) throw sessionNotFoundError();
    const session = normalizeSession(loaded, {
      deferMedia: true,
      deferThinking: true,
    });
    questions = buildSessionDisplayProjection({
      sessionId: resolved.sessionId,
      revision,
      messages: session.messages,
      questionCoverage: "complete",
    }).questions.questions;
  }
  const requestedEnd = cursor?.anchor
    ? Number.parseInt(cursor.anchor, 10)
    : questions.length;
  if (
    !Number.isSafeInteger(requestedEnd) ||
    requestedEnd < 0 ||
    requestedEnd > questions.length
  ) {
    throw staleDisplayError();
  }
  const start = Math.max(0, requestedEnd - QUESTION_PAGE_LIMIT);
  return SessionQuestionPageSchema.parse({
    questions: questions.slice(start, requestedEnd),
    coverage: start === 0 ? "complete" : "partial",
    ...(start > 0
      ? {
          nextCursor: encodeCursor(resolved.sessionId, {
            version: 1,
            kind: "questions",
            revision,
            source: "memory",
            anchor: String(start),
            ...(branchId ? { branchId } : {}),
          }),
        }
      : {}),
  });
}

async function readToolGroupDetails(
  deps: SessionDisplayRoutesDeps,
  resolved: ResolvedDisplaySession,
  revision: string,
  detailRef: string,
  offset: number,
  branchId: string | undefined,
): Promise<SessionToolGroupDetailPage<Message>> {
  const decoded = decodeSessionDisplayDetailRef(
    resolved.sessionId,
    revision,
    detailRef,
  );
  if (!decoded) {
    throw new SessionDisplayRouteError(
      404,
      "SESSION_TOOL_GROUP_NOT_FOUND",
      "Tool group reference is invalid",
    );
  }
  let messages: Message[];
  let currentRevision: string;

  if (
    revision.startsWith("cas1.") &&
    deps.codexAppServerHistoryReader &&
    (resolved.source.provider === "codex" ||
      resolved.source.provider === "codex-oss")
  ) {
    const nativeTurnId = decoded.turnId.startsWith("turn:")
      ? decoded.turnId.slice("turn:".length)
      : decoded.turnId;
    const native = await deps.codexAppServerHistoryReader.getSemanticTurn(
      resolved.sessionId,
      resolved.project.path,
      nativeTurnId,
      revision,
    );
    if (native.kind !== "loaded") throw staleDisplayError();
    messages = native.messages;
    currentRevision = native.revision;
  } else {
    const aroundMessageId = decoded.turnId.startsWith("turn:")
      ? decoded.turnId.slice("turn:".length)
      : undefined;
    const loaded = await resolved.source.reader.getSession(
      resolved.sessionId,
      resolved.project.id,
      undefined,
      {
        includeOrphans: false,
        branchId,
        deferMedia: true,
        deferThinking: true,
        ...(aroundMessageId && resolved.source.kind === "codex"
          ? {
              aroundMessageId,
              maxMessages: DETAIL_AROUND_MESSAGE_LIMIT,
            }
          : {}),
        ...(decoded.sourceRevision
          ? { rolloutRevision: decoded.sourceRevision }
          : {}),
      },
    );
    if (!loaded) throw sessionNotFoundError();
    const session = normalizeSession(loaded, {
      deferMedia: true,
      deferThinking: true,
    });
    currentRevision = await computeGenericRevision(
      resolved.source,
      loaded,
      session,
      branchId,
      decoded.sourceRevision,
    );
    messages = session.messages;
  }
  if (currentRevision !== revision) throw staleDisplayError();
  const projection = buildSessionDisplayProjection({
    sessionId: resolved.sessionId,
    revision,
    ...(decoded.sourceRevision
      ? { detailSourceRevision: decoded.sourceRevision }
      : {}),
    messages,
    questionCoverage: "partial",
    toolsMayBeActive: resolved.runtime.toolsMayBeActive,
    provider: resolved.source.provider,
  });
  const locator = projection.detailLocators.find(
    (candidate) => candidate.detailRef === detailRef,
  );
  if (!locator) {
    throw new SessionDisplayRouteError(
      404,
      "SESSION_TOOL_GROUP_NOT_FOUND",
      "Tool group is not present in the selected turn",
    );
  }
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= locator.toolRows.length
  ) {
    if (offset !== 0 || locator.toolRows.length !== 0)
      throw staleDisplayError();
  }
  const nextOffset = Math.min(
    locator.toolRows.length,
    offset + SESSION_DISPLAY_TOOL_DETAIL_PAGE_LIMIT,
  );
  const selectedIds = locator.toolRows.slice(offset, nextOffset).flat();
  const selectedMessages = selectSessionDisplayToolMessages(
    messages,
    selectedIds,
  );
  // Keep the compact projection cheap: renderer augments are computed only
  // for the explicit detail page, never for every hidden tool in the turn.
  await augmentPersistedSessionMessages(selectedMessages);
  return {
    sessionId: resolved.sessionId,
    revision,
    detailRef,
    messages: selectedMessages,
    ...(nextOffset < locator.toolRows.length
      ? {
          nextCursor: encodeCursor(resolved.sessionId, {
            version: 1,
            kind: "details",
            revision,
            source: revision.startsWith("cas1.") ? "app-server" : "memory",
            detailRef,
            offset: nextOffset,
            ...(branchId ? { branchId } : {}),
          }),
        }
      : {}),
  };
}

/**
 * Resolve one reasoning row to its full body.
 *
 * The display page only carries a bounded preview, so this route re-reads the
 * session with full reasoning enabled and rebuilds the same projection. Detail
 * refs are stable across both reads because reasoning rows always exist and
 * always consume a detail index, independent of the preview bound.
 */
async function readThinkingDetail(
  deps: SessionDisplayRoutesDeps,
  resolved: ResolvedDisplaySession,
  revision: string,
  detailRef: string,
  branchId: string | undefined,
): Promise<SessionThinkingDetail> {
  const decoded = decodeSessionDisplayDetailRef(
    resolved.sessionId,
    revision,
    detailRef,
  );
  if (!decoded || decoded.kind !== "thinking") {
    throw new SessionDisplayRouteError(
      404,
      "SESSION_THINKING_NOT_FOUND",
      "Reasoning reference is invalid",
    );
  }
  const loaded = await resolved.source.reader.getSession(
    resolved.sessionId,
    resolved.project.id,
    undefined,
    {
      includeOrphans: false,
      branchId,
      deferMedia: true,
      deferThinking: false,
      ...(decoded.sourceRevision
        ? { rolloutRevision: decoded.sourceRevision }
        : {}),
    },
  );
  if (!loaded) throw sessionNotFoundError();
  const session = normalizeSession(loaded, {
    deferMedia: true,
    deferThinking: false,
  });
  const currentRevision = await computeGenericRevision(
    resolved.source,
    loaded,
    session,
    branchId,
    decoded.sourceRevision,
  );
  if (currentRevision !== revision) throw staleDisplayError();
  const projection = buildSessionDisplayProjection({
    sessionId: resolved.sessionId,
    revision,
    ...(decoded.sourceRevision
      ? { detailSourceRevision: decoded.sourceRevision }
      : {}),
    messages: session.messages,
    questionCoverage: "partial",
    toolsMayBeActive: resolved.runtime.toolsMayBeActive,
    provider: resolved.source.provider,
  });
  const locator = projection.detailLocators.find(
    (candidate) =>
      candidate.detailRef === detailRef && candidate.kind === "thinking",
  );
  if (!locator || locator.thinkingText === undefined) {
    throw new SessionDisplayRouteError(
      404,
      "SESSION_THINKING_NOT_FOUND",
      "Reasoning row is not present in the selected turn",
    );
  }
  return {
    sessionId: resolved.sessionId,
    revision,
    detailRef,
    content: locator.thinkingText,
  };
}

async function computeGenericRevision(
  source: SessionSource,
  loaded: LoadedSession,
  session: Session,
  branchId: string | undefined,
  sourceRevision?: string,
): Promise<string> {
  const rawRevision = sourceRevision ?? loaded.pagination?.rolloutRevision;
  const stats = await getReaderStats(source, session.id);
  return `sdr1.${stableDigest([
    source.kind,
    session.provider,
    session.id,
    rawRevision ?? "",
    String(stats?.mtime ?? ""),
    String(stats?.size ?? ""),
    loaded.summary.updatedAt,
    String(loaded.summary.messageCount),
    branchId ?? "",
  ])}`;
}

async function computeSummaryRevision(
  source: SessionSource,
  summary: SessionSummary,
): Promise<string> {
  const stats = await getReaderStats(source, summary.id);
  return `sdq1.${stableDigest([
    source.kind,
    summary.provider,
    summary.id,
    String(stats?.mtime ?? ""),
    String(stats?.size ?? ""),
    summary.updatedAt,
    String(summary.messageCount),
  ])}`;
}

async function getReaderStats(
  source: SessionSource,
  sessionId: string,
): Promise<{ mtime: number; size: number } | null> {
  try {
    const stats = await source.reader.getSessionFileStats?.(sessionId);
    if (stats) return stats;
    const filePath = await source.reader.getSessionFilePath?.(sessionId);
    if (!filePath) return null;
    const fileStats = await stat(filePath);
    return { mtime: fileStats.mtimeMs, size: fileStats.size };
  } catch {
    return null;
  }
}

function mergeChronologicalMessages(
  older: readonly Message[],
  newer: readonly Message[],
): Message[] {
  const seen = new Set<string>();
  const merged: Message[] = [];
  for (const [index, message] of [...older, ...newer].entries()) {
    const id =
      message.uuid ??
      (typeof message.id === "string" ? message.id : `missing:${index}`);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(message);
  }
  return merged;
}

function parseOptionalCursor(
  sessionId: string,
  value: string | undefined,
  kind: CursorKind,
): SessionDisplayCursor | null {
  if (!value) return null;
  const decoded = decodeCursor(sessionId, value);
  if (!decoded || decoded.kind !== kind) {
    throw new SessionDisplayRouteError(
      400,
      "SESSION_DISPLAY_CURSOR_INVALID",
      "Session display cursor is invalid",
    );
  }
  return decoded;
}

function assertCursorBranch(
  cursor: SessionDisplayCursor | null,
  branchId: string | undefined,
): void {
  if (cursor && cursor.branchId !== branchId) throw staleDisplayError();
}

function encodeCursor(sessionId: string, cursor: SessionDisplayCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const checksum = stableDigest([sessionId, payload]).slice(0, 16);
  return `sdc1.${payload}.${checksum}`;
}

function decodeCursor(
  sessionId: string,
  value: string,
): SessionDisplayCursor | null {
  const match = /^sdc1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{16})$/.exec(value);
  const payload = match?.[1];
  if (
    !payload ||
    stableDigest([sessionId, payload]).slice(0, 16) !== match?.[2]
  ) {
    return null;
  }
  try {
    const cursor = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<SessionDisplayCursor>;
    if (
      cursor.version !== 1 ||
      (cursor.kind !== "display" &&
        cursor.kind !== "questions" &&
        cursor.kind !== "details") ||
      typeof cursor.revision !== "string" ||
      !cursor.revision ||
      (cursor.source !== "app-server" &&
        cursor.source !== "reader" &&
        cursor.source !== "memory") ||
      (cursor.anchor !== undefined && typeof cursor.anchor !== "string") ||
      (cursor.branchId !== undefined && typeof cursor.branchId !== "string") ||
      (cursor.detailRef !== undefined &&
        typeof cursor.detailRef !== "string") ||
      (cursor.offset !== undefined &&
        (!Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0))
    ) {
      return null;
    }
    return cursor as SessionDisplayCursor;
  } catch {
    return null;
  }
}

function stableDigest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(":");
    hash.update(part);
    hash.update(";");
  }
  return hash.digest("base64url").slice(0, 32);
}

function staleDisplayError(): SessionDisplayRouteError {
  return new SessionDisplayRouteError(
    409,
    "SESSION_DISPLAY_STALE",
    "Session display revision or cursor is stale",
  );
}

function sessionNotFoundError(): SessionDisplayRouteError {
  return new SessionDisplayRouteError(
    404,
    "SESSION_NOT_FOUND",
    "Session not found",
  );
}

function displayErrorResponse(c: Context, error: unknown) {
  if (error instanceof SessionDisplayRouteError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === "ROLLOUT_CURSOR_STALE") {
    const stale = staleDisplayError();
    return c.json({ error: stale.message, code: stale.code }, stale.status);
  }
  if (message === "ROLLOUT_CHANGED_DURING_SCAN") {
    return c.json(
      {
        error: "Session changed while the display page was being read",
        code: "SESSION_DISPLAY_CHANGED",
      },
      409,
    );
  }
  throw error;
}
