import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type InputRequest,
  type ProviderName,
  SESSION_DISPLAY_INITIAL_TURN_LIMIT,
  SESSION_DISPLAY_TOOL_DETAIL_PAGE_LIMIT,
  type SessionBranchState,
  type SessionDisplayPage,
  type SessionFileActivityIndex,
  type SessionQuestionPage,
  SessionQuestionPageSchema,
  type SessionThinkingDetail,
  type SessionToolGroupDetailPage,
  isUrlProjectId,
  normalizeSessionFilePath,
} from "@yep-anywhere/shared";
import { parsePatch } from "diff";
import type { Context, Hono } from "hono";
import {
  computeEditAugment,
  computeStructuredPatchDiffHtml,
} from "../augments/edit-augments.js";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import type { CodexAppServerHistoryReader } from "../codex-history/CodexAppServerHistoryReader.js";
import { getDataDir } from "../config.js";
import type {
  DisplaySelection,
  SessionDisplayService,
  SessionDisplaySource,
} from "../display/SessionDisplayService.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { getSessionFileOperationStore } from "../session-files/codex-operations.js";
import {
  importCodexFileHistory,
  importStructuredFileHistory,
} from "../session-files/history-operations.js";
import {
  countOperationPatch,
  projectFileOperations,
  selectFileOperations,
} from "../session-files/operation-projection.js";
import type { SessionFileOperationStore } from "../session-files/operation-store.js";
import { importPiFileOperations } from "../session-files/pi-operations.js";
import {
  addSavedFileLineCounts,
  decodeSavedText,
  readSavedFileRecords,
  savedFileActivities,
  savedFileChangeComplete,
} from "../session-files/reader.js";
import { SessionFileStore } from "../session-files/store.js";
import { RelativePathSchema } from "../session-files/types.js";
import {
  buildSessionDisplayProjection,
  decodeSessionDisplayDetailRef,
  selectSessionDisplayToolMessages,
} from "../sessions/display-projection.js";
import { FileIndexCache } from "../sessions/file-index-cache.js";
import {
  annotateBranchMessages,
  normalizeSession,
} from "../sessions/normalization.js";
import { augmentPersistedSessionMessages } from "../sessions/persisted-augments.js";
import { normalizeProviderGroup } from "../sessions/provider-groups.js";
import {
  type ProviderResolutionDeps,
  type SessionSource,
  findSessionSummaryAcrossProviders,
  resolveSessionSources,
} from "../sessions/provider-resolution.js";
import { buildSessionFileActivity } from "../sessions/session-file-activity.js";
import {
  type FileEditOp,
  collectSessionFileEdits,
  reconstructSessionBaseline,
} from "../sessions/session-file-changes.js";
import type { GetSessionOptions, LoadedSession } from "../sessions/types.js";
import { isUserPromptMessage } from "../sessions/user-prompt-message.js";
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
  projectId?: string;
  provider?: ProviderName;
  toolsMayBeActive: boolean;
  pendingInputRequest?: InputRequest | null;
}

export interface SessionDisplayRoutesDeps {
  sessionFileStore?: SessionFileStore;
  sessionFileOperationStore?: SessionFileOperationStore;
  displayService?: SessionDisplayService;
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
    readonly status: 400 | 404 | 409 | 413 | 415 | 503,
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
  // Cache ownership follows this app's readers/store, not the whole process.
  const fileIndexCaches: FileIndexCaches = {
    saved: new FileIndexCache(16),
    activity: new FileIndexCache(32),
    operations: new FileIndexCache(16),
    fileSessions: new FileIndexCache(16),
  };

  if (deps.displayService) {
    const service = deps.displayService;
    service.configureSource(createSessionDisplaySource(deps));
    const selection = (c: Context): DisplaySelection => ({
      projectId: c.req.param("projectId") ?? "",
      sessionId: c.req.param("sessionId") ?? "",
      ...(c.req.query("branchId") ? { branchId: c.req.query("branchId") } : {}),
    });
    routes.get(
      "/projects/:projectId/sessions/:sessionId/display/view",
      async (c) => {
        try {
          const cursor = c.req.query("cursor");
          return c.json(
            cursor
              ? await service.older(selection(c), cursor)
              : await service.snapshot(
                  selection(c),
                  c.req.query("reset") === "true",
                ),
          );
        } catch (error) {
          return displayErrorResponse(c, error);
        }
      },
    );
    routes.get(
      "/projects/:projectId/sessions/:sessionId/display/groups/:groupId",
      async (c) => {
        try {
          return c.json(
            await service.group(
              selection(c),
              c.req.param("groupId"),
              c.req.query("cursor"),
            ),
          );
        } catch (error) {
          return displayErrorResponse(c, error);
        }
      },
    );
    routes.get(
      "/projects/:projectId/sessions/:sessionId/display/tools/:toolId/output",
      async (c) => {
        try {
          c.header("Cache-Control", "no-store");
          return c.json(
            await service.output(
              selection(c),
              c.req.param("toolId"),
              c.req.query("since"),
            ),
          );
        } catch (error) {
          return displayErrorResponse(c, error);
        }
      },
    );
    routes.get(
      "/projects/:projectId/sessions/:sessionId/display/tools/:toolId",
      async (c) => {
        try {
          return c.json(
            await service.detail(
              selection(c),
              c.req.param("toolId"),
              c.req.query("cursor"),
            ),
          );
        } catch (error) {
          return displayErrorResponse(c, error);
        }
      },
    );
  }
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

  // Session-scoped file index. Derived server-side from the *whole* session so
  // it does not depend on how much of the transcript the client has paged in.
  routes.get("/projects/:projectId/sessions/:sessionId/files", async (c) => {
    try {
      const resolved = await resolveDisplaySession(
        deps,
        c.req.param("projectId"),
        c.req.param("sessionId"),
        false,
      );
      const branchId = c.req.query("branchId") || undefined;
      if (
        resolved.source.provider === "codex" ||
        resolved.source.provider === "pi"
      ) {
        const operations = await operationSelection(
          deps,
          fileIndexCaches,
          resolved,
          branchId,
        );
        if (
          operations.snapshot.operations.length > 0 &&
          c.req.query("source") !== "snapshot"
        ) {
          return c.json(operations.index);
        }
        const { selected, session, files, fileCount } =
          await savedRecordsForSession(
            deps,
            fileIndexCaches,
            resolved,
            branchId,
          );
        if (files.length === 0 && c.req.query("source") !== "snapshot")
          return c.json(operations.index);
        return c.json({
          projectId: resolved.project.id,
          sessionId: resolved.sessionId,
          files,
          source: "snapshot",
          coverageIncomplete: selected.incomplete || session.hasOlderMessages,
          coverageReasons: selected.coverageReasons,
          truncated:
            selected.truncated || session.hasOlderMessages || fileCount > 500,
          generatedAt: new Date().toISOString(),
        });
      }
      // Other providers remain on their existing path until their full adapter
      // acceptance is complete. An explicit source enables compatibility verification.
      if (c.req.query("source") === "operation") {
        const operationIndex = await operationSelection(
          deps,
          fileIndexCaches,
          resolved,
          branchId,
        );
        return c.json(operationIndex.index);
      }
      const index = await readSessionFileIndex(
        resolved,
        branchId,
        fileIndexCaches.activity,
      );
      return c.json(index);
    } catch (error) {
      return displayErrorResponse(c, error);
    }
  });

  routes.get(
    "/projects/:projectId/sessions/:sessionId/files/content",
    async (c) => {
      try {
        const resolved = await resolveDisplaySession(
          deps,
          c.req.param("projectId"),
          c.req.param("sessionId"),
          false,
        );
        const path = c.req.query("path") ?? "";
        const recordId = c.req.query("recordId");
        if (recordId?.startsWith("op:")) {
          const { store, change } = await selectOperationChange(
            deps,
            fileIndexCaches,
            resolved,
            c.req.query("branchId"),
            path,
            recordId,
          );
          const ref = change.after ?? change.before;
          if (!ref)
            throw new SessionDisplayRouteError(
              404,
              "SESSION_FILE_CONTENT_NOT_RECORDED",
              "Full file content was not recorded; view the operation diff instead",
            );
          const bytes = await store.readContent(ref);
          const content = decodeSavedText(bytes, true);
          return c.json({
            path,
            recordId,
            content,
            renderedMarkdownHtml:
              content !== undefined && /\.(md|markdown)$/i.test(path)
                ? await renderMarkdownToHtml(content)
                : undefined,
            binary: content === undefined,
            bytes: bytes.length,
            deleted: change.kind === "deleted",
            complete: true,
          });
        }
        const { store, selected, change } = await selectSavedChange(
          deps,
          fileIndexCaches,
          resolved,
          c.req.query("branchId"),
          path,
          c.req.query("recordId"),
        );
        const version = change.after ?? change.before;
        if (!version)
          throw new SessionDisplayRouteError(
            404,
            "SESSION_FILE_VERSION_MISSING",
            "Saved version is unavailable",
          );
        const bytes = await store.readBlob(version.blob);
        const content = decodeSavedText(bytes);
        const renderedMarkdownHtml =
          content !== undefined && /\.(md|markdown)$/i.test(path)
            ? await renderMarkdownToHtml(content)
            : undefined;
        return c.json({
          path,
          recordId: selected.id,
          content,
          renderedMarkdownHtml,
          binary: content === undefined,
          bytes: bytes.length,
          deleted: !change.after,
          complete: savedFileChangeComplete(selected.record),
        });
      } catch (error) {
        return displayErrorResponse(c, error);
      }
    },
  );

  // Diff of one indexed file against the state it had when the session began,
  // reconstructed from the session's own edit calls.
  routes.post(
    "/projects/:projectId/sessions/:sessionId/files/diff",
    async (c) => {
      try {
        const resolved = await resolveDisplaySession(
          deps,
          c.req.param("projectId"),
          c.req.param("sessionId"),
          false,
        );
        let body: {
          path?: unknown;
          fullContext?: unknown;
          branchId?: unknown;
          recordId?: unknown;
        };
        try {
          body = await c.req.json();
        } catch {
          throw new SessionDisplayRouteError(
            400,
            "SESSION_FILE_DIFF_INVALID_BODY",
            "Invalid JSON body",
          );
        }
        const path = typeof body.path === "string" ? body.path.trim() : "";
        if (!path || path.startsWith("/") || path.split("/").includes("..")) {
          throw new SessionDisplayRouteError(
            400,
            "SESSION_FILE_DIFF_INVALID_PATH",
            "path must be a project-relative file path",
          );
        }
        const branchId =
          typeof body.branchId === "string" ? body.branchId : undefined;
        if (
          typeof body.recordId === "string" &&
          body.recordId.startsWith("op:")
        ) {
          const { store, change } = await selectOperationChange(
            deps,
            fileIndexCaches,
            resolved,
            branchId,
            path,
            body.recordId,
          );
          if (change.kind === "mode-change")
            return c.json({
              path,
              exact: true,
              structuredPatch: [],
              diffHtml: "",
            });
          if (change.before?.binary || change.after?.binary)
            throw new SessionDisplayRouteError(
              415,
              "SESSION_FILE_BINARY",
              "Binary file diff is unavailable",
            );
          if (
            change.patch &&
            countOperationPatch(change).availability === "complete"
          ) {
            const structuredPatch = parsePatch(change.patch.text).flatMap(
              (patch) => patch.hunks,
            );
            return c.json({
              path,
              exact: true,
              structuredPatch,
              diffHtml: await computeStructuredPatchDiffHtml(
                path,
                structuredPatch,
              ),
            });
          }
          if (change.before === undefined || change.after === undefined)
            throw new SessionDisplayRouteError(
              404,
              "SESSION_FILE_DIFF_UNAVAILABLE",
              "File operation diff was not recorded",
            );
          const [before, after] = await Promise.all(
            [change.before, change.after].map(async (ref) =>
              ref === null
                ? ""
                : decodeSavedText(await store.readContent(ref), true),
            ),
          );
          if (before === undefined || after === undefined)
            throw new SessionDisplayRouteError(
              415,
              "SESSION_FILE_BINARY",
              "Binary file diff is unavailable",
            );
          const augment = await computeEditAugment(
            "session-operation-diff",
            { file_path: path, old_string: before, new_string: after },
            body.fullContext === true ? 999_999 : 3,
          );
          return c.json({
            path,
            exact: true,
            diffHtml: augment.diffHtml,
            structuredPatch: augment.structuredPatch,
          });
        }
        if (
          resolved.source.provider === "codex" ||
          resolved.source.provider === "pi"
        ) {
          const { store, selected, change } = await selectSavedChange(
            deps,
            fileIndexCaches,
            resolved,
            branchId,
            path,
            typeof body.recordId === "string" ? body.recordId : undefined,
          );
          const before = change.before
            ? decodeSavedText(await store.readBlob(change.before.blob))
            : "";
          const after = change.after
            ? decodeSavedText(await store.readBlob(change.after.blob))
            : "";
          if (before === undefined || after === undefined)
            throw new SessionDisplayRouteError(
              415,
              "SESSION_FILE_BINARY",
              "Binary file diff is unavailable",
            );
          const augment = await computeEditAugment(
            "session-snapshot-diff",
            { file_path: path, old_string: before, new_string: after },
            body.fullContext === true ? 999_999 : 3,
          );
          return c.json({
            path,
            exact: savedFileChangeComplete(selected.record),
            diffHtml: augment.diffHtml,
            structuredPatch: augment.structuredPatch,
          });
        }
        const ops = await readSessionFileEdits(resolved, branchId, path);
        if (!ops || ops.length === 0) {
          throw new SessionDisplayRouteError(
            404,
            "SESSION_FILE_DIFF_NO_EDITS",
            "This session recorded no edits for that file",
          );
        }
        const current = await readWorktreeFile(resolved.project.path, path);
        const baseline = reconstructSessionBaseline(current, ops);
        const augment = await computeEditAugment(
          "session-file-diff",
          {
            file_path: path,
            old_string: baseline.content,
            new_string: current,
          },
          body.fullContext === true ? 999_999 : 3,
        );
        return c.json({
          path,
          exact: baseline.exact,
          diffHtml: augment.diffHtml,
          structuredPatch: augment.structuredPatch,
        });
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
        if (
          deps.displayService &&
          c.req.param("detailRef").startsWith("thinking:")
        ) {
          const detailRef = c.req.param("detailRef");
          const content = await deps.displayService.reasoning(
            {
              projectId: resolved.project.id,
              sessionId: resolved.sessionId,
              branchId,
            },
            detailRef,
          );
          return c.json({
            sessionId: resolved.sessionId,
            revision,
            detailRef,
            content,
          });
        }
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

/** Provider reads stay server-side; the view service owns identity and replay. */
export function createSessionDisplaySource(
  deps: SessionDisplayRoutesDeps,
): SessionDisplaySource {
  const resolvedCache = new Map<string, ResolvedDisplaySession>();
  const resolve = async (selection: DisplaySelection) => {
    const key = JSON.stringify([selection.projectId, selection.sessionId]);
    let resolved = resolvedCache.get(key);
    if (!resolved) {
      resolved = await resolveDisplaySession(
        deps,
        selection.projectId,
        selection.sessionId,
        true,
        true,
      );
      if (resolvedCache.size >= 32) {
        const first = resolvedCache.keys().next().value;
        if (first) resolvedCache.delete(first);
      }
      resolvedCache.set(key, resolved);
    }
    return {
      ...resolved,
      runtime:
        (await deps.getRuntimeState?.(resolved.sessionId)) ?? resolved.runtime,
    };
  };
  const stamp = async (selection: DisplaySelection) => {
    const resolved = await resolve(selection);
    let stats = await resolved.source.reader.getSessionFileStats?.(
      resolved.sessionId,
    );
    if (!stats) {
      const file = await resolved.source.reader.getSessionFilePath?.(
        resolved.sessionId,
      );
      if (file) {
        try {
          const fileStat = await stat(file);
          stats = { mtime: fileStat.mtimeMs, size: fileStat.size };
        } catch {}
      }
    }
    const summary = stats
      ? resolved.summary
      : ((await resolved.source.reader.getSessionSummary(
          resolved.sessionId,
          resolved.project.id,
        )) ?? resolved.summary);
    return JSON.stringify([
      stats?.mtime ?? summary.updatedAt,
      stats?.size,
      resolved.runtime.toolsMayBeActive,
      resolved.runtime.pendingInputRequest?.id,
    ]);
  };
  const activity = (
    resolved: ResolvedDisplaySession,
    lastTurnStatus?: string,
  ) =>
    resolved.runtime.pendingInputRequest
      ? ("waiting-input" as const)
      : resolved.runtime.toolsMayBeActive
        ? ("running" as const)
        : lastTurnStatus === "completed" ||
            lastTurnStatus === "failed" ||
            lastTurnStatus === "interrupted"
          ? lastTurnStatus
          : ("unknown" as const);
  const encode = (source: "native" | "reader", cursor: string) =>
    Buffer.from(JSON.stringify({ source, cursor })).toString("base64url");
  const decode = (
    value?: string,
  ): { source: "native" | "reader"; cursor: string } | undefined => {
    if (!value) return undefined;
    try {
      const obj = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      if (
        (obj.source === "native" || obj.source === "reader") &&
        typeof obj.cursor === "string"
      )
        return obj;
    } catch {}
    throw staleDisplayError();
  };
  return {
    stamp,
    read: async (selection, opaqueCursor) => {
      const resolved = await resolve(selection);
      const sourceStamp = await stamp(selection);
      const cursor = decode(opaqueCursor);
      const codex =
        resolved.source.provider === "codex" ||
        resolved.source.provider === "codex-oss";
      if (
        codex &&
        deps.codexAppServerHistoryReader &&
        (!cursor || cursor.source === "native")
      ) {
        const native =
          await deps.codexAppServerHistoryReader.getSemanticTurnsPage(
            resolved.sessionId,
            resolved.project.id,
            resolved.project.path,
            {
              limit: SESSION_DISPLAY_INITIAL_TURN_LIMIT,
              itemsView: "full",
              cursor: cursor?.cursor,
              toolsMayBeActive: !cursor && resolved.runtime.toolsMayBeActive,
            },
          );
        if (native.kind === "loaded") {
          const turnStatuses = { ...native.turnStatuses };
          const turnStarts = native.messages.flatMap((message) => {
            if (message.type !== "user" || !message.timestamp) return [];
            const timestamp = Date.parse(message.timestamp);
            return Number.isFinite(timestamp) ? [timestamp] : [];
          });
          if (native.inferredLatestTurnId)
            delete turnStatuses[native.inferredLatestTurnId];
          const branch = await deps.getBranchState?.(
            resolved.project,
            resolved.sessionId,
            native.summary,
            selection.branchId,
          );
          return {
            provider: native.provider,
            messages: branch
              ? annotateBranchMessages(native.messages, branch, {
                  includeCodexAlias: true,
                })
              : native.messages,
            turnStatuses,
            ...(!cursor && native.turnStatuses && turnStarts.length > 0
              ? {
                  codexTurnWindow: {
                    turnIds: Object.keys(native.turnStatuses),
                    from: Math.min(...turnStarts),
                    before: Math.max(...turnStarts),
                  },
                }
              : {}),
            activity: activity(
              resolved,
              native.inferredLatestTurnId
                ? undefined
                : native.summary.lastTurnStatus,
            ),
            stamp: sourceStamp,
            ...(native.nextCursor
              ? { cursor: encode("native", native.nextCursor) }
              : {}),
          };
        }
      }
      const loaded = await resolved.source.reader.getSession(
        resolved.sessionId,
        resolved.project.id,
        undefined,
        {
          branchId: selection.branchId,
          maxMessages: 5_000,
          beforeMessageId:
            cursor?.source === "reader" ? cursor.cursor : undefined,
          includeOrphans: false,
          deferMedia: true,
          deferThinking: true,
        },
      );
      if (!loaded && resolved.runtime.toolsMayBeActive && !cursor)
        return {
          provider: resolved.source.provider,
          messages: [],
          activity: activity(resolved),
          stamp: sourceStamp,
        };
      if (!loaded) throw sessionNotFoundError();
      const session = normalizeSession(loaded, {
        deferMedia: true,
        deferThinking: true,
      });
      // Some provider readers return their entire native tree. Apply semantic
      // paging here too, with an append-stable question anchor rather than a
      // whole-file revision or an arbitrary tool-message cutoff.
      let end = session.messages.length;
      if (cursor?.source === "reader" && !loaded.paginationApplied) {
        const found = session.messages.findIndex(
          (message) => (message.uuid ?? message.id) === cursor.cursor,
        );
        if (found < 0) throw staleDisplayError();
        end = found;
      }
      const prompts = session.messages
        .slice(0, end)
        .flatMap((message, index) =>
          isUserPromptMessage(message) ? [index] : [],
        );
      const start =
        prompts.length > SESSION_DISPLAY_INITIAL_TURN_LIMIT
          ? (prompts[prompts.length - SESSION_DISPLAY_INITIAL_TURN_LIMIT] ?? 0)
          : 0;
      const selectedMessages = session.messages.slice(start, end);
      const firstQuestion = selectedMessages.find(isUserPromptMessage);
      const next =
        start > 0
          ? (firstQuestion?.uuid ?? firstQuestion?.id)
          : loaded.pagination?.hasOlderMessages
            ? loaded.pagination.truncatedBeforeMessageId
            : undefined;
      const statuses = loaded.summary.lastTurnStatus;
      return {
        provider: resolved.source.provider,
        messages: selectedMessages,
        ...(!resolved.runtime.toolsMayBeActive &&
        (statuses === "completed" ||
          statuses === "failed" ||
          statuses === "interrupted")
          ? { turnStatuses: { session: statuses } }
          : {}),
        activity: activity(resolved, statuses),
        stamp: sourceStamp,
        ...(typeof next === "string" && next
          ? { cursor: encode("reader", next) }
          : {}),
      };
    },
    reasoning: async (selection, id) => {
      const resolved = await resolve(selection);
      const separator = id.lastIndexOf(":");
      const messageId = id.slice("thinking:".length, separator);
      const blockIndex = Number(id.slice(separator + 1));
      if (
        !id.startsWith("thinking:") ||
        !Number.isSafeInteger(blockIndex) ||
        blockIndex < 0
      )
        throw staleDisplayError();
      const loaded = await resolved.source.reader.getSession(
        resolved.sessionId,
        resolved.project.id,
        undefined,
        {
          branchId: selection.branchId,
          deferMedia: true,
          deferThinking: false,
          maxMessages: DETAIL_AROUND_MESSAGE_LIMIT,
        },
      );
      if (!loaded) throw sessionNotFoundError();
      const message = normalizeSession(loaded, {
        deferMedia: true,
        deferThinking: false,
      }).messages.find((m) => (m.uuid ?? m.id) === messageId);
      const content = message?.message?.content ?? message?.content;
      const block = Array.isArray(content) ? content[blockIndex] : undefined;
      if (block?.type !== "thinking" || typeof block.thinking !== "string")
        throw staleDisplayError();
      return block.thinking;
    },
    detail: async (selection, runId, rawId) => {
      const resolved = await resolve(selection);
      let messages: Message[] | undefined;
      if (
        (resolved.source.provider === "codex" ||
          resolved.source.provider === "codex-oss") &&
        deps.codexAppServerHistoryReader &&
        runId !== "session"
      ) {
        const native = await deps.codexAppServerHistoryReader.getSemanticTurn(
          resolved.sessionId,
          resolved.project.path,
          runId,
        );
        if (native.kind === "loaded") messages = native.messages;
      }
      if (!messages) {
        const loaded = await resolved.source.reader.getSession(
          resolved.sessionId,
          resolved.project.id,
          undefined,
          {
            branchId: selection.branchId,
            deferMedia: true,
            deferThinking: true,
            includeOrphans: false,
            maxMessages: DETAIL_AROUND_MESSAGE_LIMIT,
          },
        );
        if (!loaded) throw sessionNotFoundError();
        messages = normalizeSession(loaded, {
          deferMedia: true,
          deferThinking: true,
        }).messages;
      }
      return rawId
        ? selectSessionDisplayToolMessages(messages, [rawId])
        : messages;
    },
  };
}

async function resolveDisplaySession(
  deps: SessionDisplayRoutesDeps,
  projectId: string,
  requestedSessionId: string,
  includeRuntime = true,
  allowUnpersisted = false,
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
  let resolved = await findSessionSummaryAcrossProviders(
    project,
    sessionId,
    project.id,
    deps.providerResolution,
    preferredProvider,
  );
  if (
    !resolved &&
    allowUnpersisted &&
    runtime.toolsMayBeActive &&
    runtime.projectId === project.id &&
    runtime.provider
  ) {
    // A project may still be classified by an older provider until the new
    // session is persisted. Include the running provider explicitly, just as
    // the summary lookup does, and match variants sharing the same storage.
    const source = resolveSessionSources(
      project,
      deps.providerResolution,
      undefined,
      runtime.provider,
    ).find(
      (s) =>
        normalizeProviderGroup(s.provider) ===
        normalizeProviderGroup(runtime.provider),
    );
    if (source)
      resolved = {
        source,
        summary: {
          id: sessionId,
          projectId: project.id,
          title: null,
          fullTitle: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          ownership: { owner: "none" },
          provider: runtime.provider,
        },
      };
  }
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
        toolsMayBeActive: !cursor && resolved.runtime.toolsMayBeActive,
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
        ...(native.turnStatuses ? { turnStatuses: native.turnStatuses } : {}),
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

interface SavedFileSelection {
  selected: Awaited<ReturnType<typeof readSavedFileRecords>>;
  hasOlderMessages: boolean;
  files: SessionFileActivityIndex["files"];
  fileCount: number;
}

interface FileIndexCaches {
  saved: FileIndexCache<SavedFileSelection>;
  activity: FileIndexCache<SessionFileActivityIndex>;
  operations: FileIndexCache<
    Awaited<ReturnType<typeof buildOperationSelection>>
  >;
  fileSessions: FileIndexCache<
    Awaited<ReturnType<typeof loadSessionForFileIndex>>
  >;
}

async function savedRecordsForSession(
  deps: SessionDisplayRoutesDeps,
  caches: FileIndexCaches,
  resolved: ResolvedDisplaySession,
  branchId?: string,
) {
  const provider = resolved.source.provider;
  if (provider !== "codex" && provider !== "pi")
    throw new SessionDisplayRouteError(
      404,
      "SESSION_FILE_SNAPSHOTS_UNAVAILABLE",
      "Saved files are unavailable for this provider",
    );
  const store =
    deps.sessionFileStore ??
    new SessionFileStore(join(getDataDir(), "session-file-snapshots"));
  const ids = await store.listRecords({
    provider,
    sessionId: resolved.sessionId,
  });
  const stamp = `${await sessionFileIndexStamp(resolved)}:${createHash("sha256").update(ids.join(",")).digest("hex")}`;
  const key = JSON.stringify([
    store.directory,
    resolved.project.path,
    provider,
    resolved.sessionId,
    branchId,
  ]);
  const cached = await caches.saved.get(key, stamp, async () => {
    const session = await cachedFileSession(deps, caches, resolved, branchId);
    const selected = await readSavedFileRecords(
      store,
      provider,
      resolved.sessionId,
      resolved.project.path,
      session.messages,
      ids,
    );
    const all = savedFileActivities(selected.records);
    const files = all.slice(0, 500);
    await addSavedFileLineCounts(store, selected.records, files);
    return {
      selected,
      hasOlderMessages: session.hasOlderMessages,
      files,
      fileCount: all.length,
    };
  });
  return {
    store,
    selected: cached.selected,
    session: { hasOlderMessages: cached.hasOlderMessages },
    files: cached.files,
    fileCount: cached.fileCount,
  };
}

async function selectSavedChange(
  deps: SessionDisplayRoutesDeps,
  caches: FileIndexCaches,
  resolved: ResolvedDisplaySession,
  branchId: string | undefined,
  path: string,
  recordId?: string,
) {
  if (!RelativePathSchema.safeParse(path).success)
    throw new SessionDisplayRouteError(
      400,
      "SESSION_FILE_INVALID_PATH",
      "Expected a workspace-relative path",
    );
  const { store, selected } = await savedRecordsForSession(
    deps,
    caches,
    resolved,
    branchId,
  );
  const match = selected.records.find(
    (entry) =>
      (!recordId || entry.id === recordId) &&
      entry.record.changes.some((change) => change.path === path),
  );
  const change = match?.record.changes.find((entry) => entry.path === path);
  if (!match || !change)
    throw new SessionDisplayRouteError(
      404,
      "SESSION_FILE_VERSION_MISSING",
      "No saved version in the selected session branch",
    );
  return { store, selected: match, change };
}

const SESSION_FILE_INDEX_MAX_MESSAGES = 20_000;

/** Cheap change token so repeated inspector opens do not re-scan the session. */
async function sessionFileIndexStamp(
  resolved: ResolvedDisplaySession,
): Promise<string> {
  let stats = await resolved.source.reader.getSessionFileStats?.(
    resolved.sessionId,
  );
  if (!stats) {
    const file = await resolved.source.reader.getSessionFilePath?.(
      resolved.sessionId,
    );
    if (file) {
      try {
        const fileStat = await stat(file);
        stats = { mtime: fileStat.mtimeMs, size: fileStat.size };
      } catch {}
    }
  }
  return JSON.stringify([
    stats?.mtime ?? resolved.summary.updatedAt,
    stats?.size ?? resolved.summary.messageCount,
  ]);
}

async function readSessionFileIndex(
  resolved: ResolvedDisplaySession,
  branchId: string | undefined,
  cache: FileIndexCache<SessionFileActivityIndex>,
): Promise<SessionFileActivityIndex> {
  const cacheKey = JSON.stringify([
    resolved.source.provider,
    resolved.project.id,
    resolved.sessionId,
    branchId,
  ]);
  const stamp = await sessionFileIndexStamp(resolved);
  return cache.get(cacheKey, stamp, () =>
    scanSessionFileIndex(resolved, branchId),
  );
}

async function scanSessionFileIndex(
  resolved: ResolvedDisplaySession,
  branchId: string | undefined,
): Promise<SessionFileActivityIndex> {
  const session = await loadSessionForFileIndex(resolved, branchId);
  const { files, truncated } = buildSessionFileActivity(session.messages, {
    projectPath: resolved.project.path,
  });
  const index: SessionFileActivityIndex = {
    projectId: resolved.project.id,
    sessionId: resolved.sessionId,
    files,
    truncated: truncated || session.hasOlderMessages,
    generatedAt: new Date().toISOString(),
  };

  return index;
}

async function loadSessionForFileIndex(
  resolved: ResolvedDisplaySession,
  branchId: string | undefined,
  operationStore?: SessionFileOperationStore,
): Promise<{ messages: Message[]; hasOlderMessages: boolean }> {
  const loaded = await resolved.source.reader.getSession(
    resolved.sessionId,
    resolved.project.id,
    undefined,
    {
      branchId,
      maxMessages: SESSION_FILE_INDEX_MAX_MESSAGES,
      includeOrphans: false,
      deferMedia: true,
      deferThinking: true,
    },
  );
  if (!loaded) throw sessionNotFoundError();
  const session = normalizeSession(loaded, {
    deferMedia: true,
    deferThinking: true,
  });
  if (operationStore) {
    if (loaded.data.provider === "codex") {
      await importCodexFileHistory(
        operationStore,
        { sessionId: resolved.sessionId, workspace: resolved.project.path },
        loaded.data.session.entries,
        session.messages,
      );
    } else if (resolved.source.provider !== "pi") {
      await importStructuredFileHistory(
        operationStore,
        {
          provider: resolved.source.provider,
          sessionId: resolved.sessionId,
          workspace: resolved.project.path,
        },
        session.messages,
      );
    }
  }
  return {
    messages: session.messages,
    hasOlderMessages: loaded.pagination?.hasOlderMessages === true,
  };
}

/** Ordered edit operations this session applied to one file. */
async function readSessionFileEdits(
  resolved: ResolvedDisplaySession,
  branchId: string | undefined,
  path: string,
): Promise<FileEditOp[] | undefined> {
  const session = await loadSessionForFileIndex(resolved, branchId);
  const edits = collectSessionFileEdits(session.messages, {
    resolvePath: (rawPath) =>
      normalizeSessionFilePath(rawPath, resolved.project.path)?.path ?? null,
  });
  return edits.get(path);
}

/** Current worktree content, or empty when the session deleted the file. */
async function readWorktreeFile(
  projectPath: string,
  path: string,
): Promise<string> {
  try {
    const target = join(projectPath, path);
    const info = await stat(target);
    if (!info.isFile() || info.size > SESSION_FILE_DIFF_MAX_BYTES) return "";
    return await readFile(target, "utf-8");
  } catch {
    return "";
  }
}

const SESSION_FILE_DIFF_MAX_BYTES = 2 * 1024 * 1024;

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

async function buildOperationSelection(
  resolved: ResolvedDisplaySession,
  branchId: string | undefined,
  store: SessionFileOperationStore,
  snapshot: Awaited<ReturnType<SessionFileOperationStore["snapshot"]>>,
  session: Awaited<ReturnType<typeof loadSessionForFileIndex>>,
) {
  const visibleTurns = new Map<string, string>();
  let questionId: string | undefined;
  for (const message of session.messages) {
    const id =
      message.uuid ?? (typeof message.id === "string" ? message.id : undefined);
    if (isUserPromptMessage(message)) {
      questionId = id;
      if (resolved.source.provider !== "codex" && id) visibleTurns.set(id, id);
    }
    const turn = message.codexTurnId ?? message.turnId;
    if (
      resolved.source.provider === "codex" &&
      typeof turn === "string" &&
      (questionId || id)
    )
      visibleTurns.set(turn.replace(/^turn:/, ""), questionId ?? id ?? turn);
  }
  const selected = selectFileOperations(
    snapshot.operations,
    resolved.project.path,
    visibleTurns,
  );
  const projected = await projectFileOperations(
    store,
    selected,
    resolved.project.path,
    visibleTurns,
  );
  const index: SessionFileActivityIndex = {
    projectId: resolved.project.id,
    sessionId: resolved.sessionId,
    files: projected.files,
    source: "operation",
    schemaVersion: 2,
    operationCoverage: "supported-tools",
    revision: snapshot.revision,
    unavailableOperations: projected.unavailableOperations,
    truncated:
      projected.truncated || snapshot.truncated || session.hasOlderMessages,
    generatedAt: new Date().toISOString(),
  };
  return { visibleTurns, index };
}

async function operationSelection(
  deps: SessionDisplayRoutesDeps,
  caches: FileIndexCaches,
  resolved: ResolvedDisplaySession,
  branchId?: string,
) {
  const store =
    deps.sessionFileOperationStore ?? getSessionFileOperationStore();
  const importFailures =
    resolved.source.provider === "pi"
      ? await importPiFileOperations(store, resolved.sessionId)
      : 0;
  const session = await cachedFileSession(deps, caches, resolved, branchId);
  const snapshot = await store.snapshot({
    provider: resolved.source.provider,
    sourceId: "local",
    sessionId: resolved.sessionId,
  });
  const key = JSON.stringify([
    store.directory,
    resolved.project.path,
    resolved.source.provider,
    resolved.sessionId,
    branchId,
  ]);
  const stamp = `${snapshot.revision}:${await sessionFileIndexStamp(resolved)}`;
  const selection = await caches.operations.get(key, stamp, () =>
    buildOperationSelection(resolved, branchId, store, snapshot, session),
  );
  return {
    store,
    snapshot,
    selected: selectFileOperations(
      snapshot.operations,
      resolved.project.path,
      selection.visibleTurns,
    ),
    ...selection,
    index: importFailures
      ? {
          ...selection.index,
          unavailableOperations:
            (selection.index.unavailableOperations ?? 0) + importFailures,
        }
      : selection.index,
  };
}

async function selectOperationChange(
  deps: SessionDisplayRoutesDeps,
  caches: FileIndexCaches,
  resolved: ResolvedDisplaySession,
  branchId: string | undefined,
  path: string,
  recordId: string,
) {
  if (
    !RelativePathSchema.safeParse(path).success ||
    !/^op:[a-f0-9]{64}$/.test(recordId)
  )
    throw new SessionDisplayRouteError(
      400,
      "SESSION_FILE_INVALID_PATH",
      "Invalid file operation selection",
    );
  const selection = await operationSelection(deps, caches, resolved, branchId);
  const entry = selection.selected.find(
    (entry) => entry.id === recordId.slice(3) && !entry.conflict,
  );
  const change = entry?.record.changes.find(
    (change) =>
      change.outcome === "applied" &&
      normalizeSessionFilePath(change.path, resolved.project.path)?.path ===
        path,
  );
  if (!entry || !change)
    throw new SessionDisplayRouteError(
      404,
      "SESSION_FILE_VERSION_MISSING",
      "No file operation in the selected session branch",
    );
  return { store: selection.store, entry, change };
}

async function cachedFileSession(
  deps: SessionDisplayRoutesDeps,
  caches: FileIndexCaches,
  resolved: ResolvedDisplaySession,
  branchId?: string,
) {
  const store =
    deps.sessionFileOperationStore ?? getSessionFileOperationStore();
  const key = JSON.stringify([
    store.directory,
    resolved.project.path,
    resolved.source.provider,
    resolved.sessionId,
    branchId,
  ]);
  return caches.fileSessions.get(
    key,
    await sessionFileIndexStamp(resolved),
    async () => {
      const session = await loadSessionForFileIndex(resolved, branchId, store);
      // Retain ancestry identities only, not a second cache of full transcript/tool payloads.
      return {
        ...session,
        messages: session.messages.map((message): Message => {
          const prompt = isUserPromptMessage(message);
          return {
            uuid: message.uuid,
            id: message.id,
            type: prompt ? "user" : "assistant",
            codexTurnId: message.codexTurnId,
            turnId: message.turnId,
            message: {
              role: prompt ? "user" : "assistant",
              content: prompt ? "file-index-prompt" : [],
            },
          };
        }),
      };
    },
  );
}
