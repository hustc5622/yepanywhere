import type {
  SessionBranchState,
  UrlProjectId,
  ZCodeStoredMessage,
} from "@yep-anywhere/shared";
import {
  buildCodexEditInput,
  publicCodexFileChanges,
  publicCodexFilePath,
} from "../codex/file-change.js";
import { codexUserMessageIdentity } from "../codex/user-message-identity.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type { ThreadItem } from "../sdk/providers/codex-protocol/generated/v2/ThreadItem.js";
import type { ThreadItemEntry } from "../sdk/providers/codex-protocol/generated/v2/ThreadItemEntry.js";
import type { Turn } from "../sdk/providers/codex-protocol/generated/v2/Turn.js";
import {
  publicCodexImageUrl,
  publicCodexThreadItem,
} from "../sdk/providers/codex.js";
import type { GetSessionOptions, LoadedSession } from "../sessions/types.js";
import { buildCopiedPrefixForkBranchView } from "../sessions/zcode-branch.js";
import type {
  ContentBlock,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import type { CodexHistoryClient } from "./CodexHistoryClient.js";
import {
  CodexHistoryClientError,
  type CodexHistoryFallbackReason,
  type SessionPageCursor,
} from "./types.js";

const APP_SERVER_CURSOR_NAMESPACE = "yep-codex-history-v";
const APP_SERVER_CURSOR_PREFIX = "yep-codex-history-v2.";
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_ITEM_PAGE_LIMIT = 100;
const MAX_TURN_PAGE_LIMIT = 100;
const SEMANTIC_ITEM_READ_CONCURRENCY = 4;
const MAX_SEMANTIC_ITEMS_PER_TURN = 10_000;
const MAX_FORK_BRANCH_FAMILY_SIZE = 64;
const MAX_FORK_BRANCH_ITEM_PAGES = 100;
const MAX_FORK_BRANCH_ITEMS = 10_000;
const LOCAL_MODEL_PROVIDERS = new Set(["ollama", "lmstudio", "local"]);
const KNOWN_THREAD_ITEM_TYPES = new Set([
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "functionCallOutput",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
]);

class CodexHistoryParityError extends Error {}

type CodexThreadProjectionMode = "strict" | "semantic-display";

export type CodexAppServerHistoryReadResult =
  | { kind: "loaded"; session: LoadedSession }
  | {
      kind: "fallback";
      reason: CodexHistoryFallbackReason;
      historyCapabilityMs?: number;
    };

export type CodexAppServerSemanticPageResult =
  | {
      kind: "loaded";
      messages: Message[];
      summary: SessionSummary;
      provider: "codex" | "codex-oss";
      revision: string;
      nextCursor?: string;
    }
  | {
      kind: "fallback";
      reason: CodexHistoryFallbackReason;
    };

export interface CodexAppServerSemanticPageOptions {
  cursor?: string;
  limit: number;
  itemsView: "summary" | "full";
  expectedRevision?: string;
}

export interface CodexForkBranchCandidate {
  id: string;
  forkParentSessionId?: string;
  forkTargetMessageId?: string;
  createdAt?: string;
  provider?: "codex" | "codex-oss";
}

export type CodexAppServerSemanticTurnResult =
  | {
      kind: "loaded";
      messages: Message[];
      revision: string;
    }
  | {
      kind: "fallback";
      reason: CodexHistoryFallbackReason;
    };

export interface CodexAppServerHistoryReaderOptions {
  client: Pick<
    CodexHistoryClient,
    "readThread" | "listTurns" | "listItems" | "getCapability"
  >;
  mode?: "auto" | "rollout" | "app-server";
}

type AppServerCursorDirection = "older" | "newer";

interface EncodeCursorOptions {
  direction: AppServerCursorDirection;
  sessionId: string;
  overlapItemId?: string;
}

export function encodeCodexAppServerCursor(
  cursor: string,
  options: EncodeCursorOptions,
): string {
  const envelope: SessionPageCursor = {
    source: "codex-app-server",
    cursor,
    direction: options.direction,
    sessionId: options.sessionId,
    ...(options.overlapItemId ? { overlapItemId: options.overlapItemId } : {}),
  };
  return `${APP_SERVER_CURSOR_PREFIX}${Buffer.from(
    JSON.stringify(envelope),
  ).toString("base64url")}`;
}

export function decodeCodexAppServerCursor(
  value: string | undefined,
): SessionPageCursor | null {
  if (!value?.startsWith(APP_SERVER_CURSOR_PREFIX)) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(
        value.slice(APP_SERVER_CURSOR_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    ) as Partial<SessionPageCursor>;
    if (
      decoded.source !== "codex-app-server" ||
      typeof decoded.cursor !== "string" ||
      decoded.cursor.length === 0 ||
      (decoded.direction !== "older" && decoded.direction !== "newer") ||
      typeof decoded.sessionId !== "string" ||
      decoded.sessionId.length === 0 ||
      (decoded.overlapItemId !== undefined &&
        (typeof decoded.overlapItemId !== "string" ||
          decoded.overlapItemId.length === 0))
    ) {
      return null;
    }
    return decoded as SessionPageCursor;
  } catch {
    return null;
  }
}

export class CodexAppServerHistoryReader {
  private readonly mode: "auto" | "rollout" | "app-server";

  constructor(private readonly options: CodexAppServerHistoryReaderOptions) {
    this.mode =
      options.mode ??
      resolveHistoryReadMode(process.env.YEP_CODEX_HISTORY_READ_MODE);
  }

  /**
   * Read provider-native turn pages for the lightweight display/questions API.
   * Each selected turn is hydrated through thread/items/list because Codex's
   * summary view retains only the first user item and would silently omit
   * same-turn steer prompts. Question pages immediately discard non-user
   * items; full pages retain every item for display projection.
   */
  async getSemanticTurnsPage(
    sessionId: string,
    projectId: UrlProjectId,
    projectPath: string,
    options: CodexAppServerSemanticPageOptions,
  ): Promise<CodexAppServerSemanticPageResult> {
    if (this.mode === "rollout") {
      return { kind: "fallback", reason: "disabled" };
    }
    const cursorScoped = Boolean(options.cursor || options.expectedRevision);
    let metadata: Awaited<ReturnType<CodexHistoryClient["readThread"]>>;
    try {
      metadata = await this.options.client.readThread({
        threadId: sessionId,
        includeTurns: false,
      });
    } catch (error) {
      if (cursorScoped) throw staleCursorError();
      return this.semanticClientFailure(error);
    }
    const thread = metadata.thread;
    if (
      canonicalizeProjectPath(thread.cwd) !==
      canonicalizeProjectPath(projectPath)
    ) {
      return cursorScoped
        ? Promise.reject(staleCursorError())
        : semanticFallback("provider_mismatch");
    }
    if (thread.historyMode !== "paginated") {
      return cursorScoped
        ? Promise.reject(staleCursorError())
        : semanticFallback("legacy_history");
    }
    const revision = codexAppServerSemanticRevision(
      thread.id,
      thread.updatedAt,
    );
    if (options.expectedRevision && options.expectedRevision !== revision) {
      throw staleCursorError();
    }

    try {
      const turnsPage = await this.options.client.listTurns({
        threadId: sessionId,
        cursor: options.cursor ?? null,
        limit: Math.max(1, Math.min(MAX_TURN_PAGE_LIMIT, options.limit)),
        sortDirection: "desc",
        itemsView: "summary",
      });
      const newestTurn = turnsPage.data[0];
      const provider = providerFromModelProvider(thread.modelProvider);
      const pageTurns = await mapWithConcurrency(
        turnsPage.data,
        SEMANTIC_ITEM_READ_CONCURRENCY,
        async (turn) => {
          const items = await readAllTurnItems(
            this.options.client,
            sessionId,
            turn.id,
          );
          return {
            ...turn,
            items:
              options.itemsView === "full"
                ? items
                : items.filter((item) => item.type === "userMessage"),
            itemsView: options.itemsView,
          };
        },
      );
      for (const turn of pageTurns) {
        for (const item of turn.items) {
          if (!hasStableThreadItemIdentity(item)) {
            throw new CodexHistoryParityError();
          }
        }
      }
      const messages: Message[] = [];
      for (const turn of [...pageTurns].reverse()) {
        const entries = turn.items.map((item) => ({ turnId: turn.id, item }));
        messages.push(
          ...projectThreadEntries(
            sessionId,
            entries,
            new Map([[turn.id, turn]]),
            true,
            projectPath,
            "semantic-display",
          ),
        );
        if (
          entries.length === 0 &&
          turn.status === "failed" &&
          turn.error?.message
        ) {
          messages.push({
            uuid: `provider-error-${turn.id}`,
            timestamp: turn.completedAt
              ? new Date(turn.completedAt * 1_000).toISOString()
              : undefined,
            type: "error",
            error: turn.error.message,
            content: turn.error.message,
            codexThreadId: sessionId,
            codexTurnId: turn.id,
            _source: "jsonl",
          });
        }
      }

      return {
        kind: "loaded",
        messages,
        summary: threadSummary(
          thread,
          projectId,
          provider,
          messages.length,
          newestTurn,
        ),
        provider,
        revision,
        ...(turnsPage.nextCursor ? { nextCursor: turnsPage.nextCursor } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.message === "ROLLOUT_CURSOR_STALE") {
        throw error;
      }
      if (error instanceof CodexHistoryParityError) {
        return cursorScoped
          ? Promise.reject(staleCursorError())
          : semanticFallback("transcript_parity");
      }
      if (cursorScoped) throw staleCursorError();
      return this.semanticClientFailure(error);
    }
  }

  /** Read one exact native turn for an explicit tool-detail request. */
  async getSemanticTurn(
    sessionId: string,
    projectPath: string,
    turnId: string,
    expectedRevision: string,
  ): Promise<CodexAppServerSemanticTurnResult> {
    if (this.mode === "rollout") {
      return { kind: "fallback", reason: "disabled" };
    }
    let metadata: Awaited<ReturnType<CodexHistoryClient["readThread"]>>;
    try {
      metadata = await this.options.client.readThread({
        threadId: sessionId,
        includeTurns: false,
      });
    } catch {
      throw staleCursorError();
    }
    const thread = metadata.thread;
    if (
      thread.historyMode !== "paginated" ||
      canonicalizeProjectPath(thread.cwd) !==
        canonicalizeProjectPath(projectPath)
    ) {
      throw staleCursorError();
    }
    const revision = codexAppServerSemanticRevision(
      thread.id,
      thread.updatedAt,
    );
    if (revision !== expectedRevision) throw staleCursorError();

    try {
      const items = await readAllTurnItems(
        this.options.client,
        sessionId,
        turnId,
      );
      for (const item of items) {
        if (!hasStableThreadItemIdentity(item)) {
          throw new CodexHistoryParityError();
        }
      }
      const messages = projectThreadEntries(
        sessionId,
        items.map((item) => ({ turnId, item })),
        new Map(),
        true,
        projectPath,
        "semantic-display",
      );
      return { kind: "loaded", messages, revision };
    } catch (error) {
      if (error instanceof CodexHistoryParityError) {
        return { kind: "fallback", reason: "transcript_parity" };
      }
      throw staleCursorError();
    }
  }

  /**
   * Build the provider-neutral b1/b2 branch graph for a native Codex fork
   * family. Paginated forks retain copied turn/item ids, so native identity —
   * not prompt text — proves the shared prefix even when an edit keeps the
   * exact same text.
   */
  async getForkBranchState(
    sessionId: string,
    candidates: readonly CodexForkBranchCandidate[],
    selectedBranchId?: string,
  ): Promise<SessionBranchState | undefined> {
    if (this.mode === "rollout") return undefined;
    const family = findCodexForkBranchFamily(candidates, sessionId);
    if (family.length <= 1 || family.length > MAX_FORK_BRANCH_FAMILY_SIZE) {
      return undefined;
    }

    try {
      const familySessions = await mapWithConcurrency(
        family,
        SEMANTIC_ITEM_READ_CONCURRENCY,
        async (candidate) => ({
          id: candidate.id,
          parentId: candidate.forkParentSessionId ?? null,
          forkBoundaryMessageId: candidate.forkTargetMessageId,
          createdAt: candidate.createdAt,
          messages: await readCodexForkBranchMessages(
            this.options.client,
            candidate.id,
          ),
        }),
      );
      const provider =
        family.find((candidate) => candidate.id === sessionId)?.provider ??
        "codex";
      return buildCopiedPrefixForkBranchView(
        familySessions,
        sessionId,
        selectedBranchId,
        {
          provider,
          sessionRootPrefix: "codex-session-root",
          isCopiedMessage: (child, parent) => child.id === parent.id,
        },
      ).branchState;
    } catch {
      // Branch controls are additive UI metadata. A stale catalog row or an
      // unavailable history page must not make the transcript itself fail.
      return undefined;
    }
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    projectPath: string,
    afterMessageId: string | undefined,
    options: GetSessionOptions,
  ): Promise<CodexAppServerHistoryReadResult> {
    if (this.mode === "rollout") return fallback("disabled");
    const beforeCursor = decodeCodexAppServerCursor(options.beforeMessageId);
    const afterCursor = decodeCodexAppServerCursor(
      options.afterWindowMessageId,
    );
    const hasAppServerCursor =
      isCodexAppServerCursor(options.beforeMessageId) ||
      isCodexAppServerCursor(options.afterWindowMessageId);
    if (
      (isCodexAppServerCursor(options.beforeMessageId) &&
        (!beforeCursor ||
          beforeCursor.direction !== "older" ||
          beforeCursor.sessionId !== sessionId)) ||
      (isCodexAppServerCursor(options.afterWindowMessageId) &&
        (!afterCursor ||
          afterCursor.direction !== "newer" ||
          afterCursor.sessionId !== sessionId))
    ) {
      throw staleCursorError();
    }
    if (
      afterMessageId ||
      options.aroundMessageId ||
      options.branchId ||
      (options.beforeMessageId && !beforeCursor) ||
      (options.afterWindowMessageId && !afterCursor) ||
      (beforeCursor && afterCursor) ||
      options.rolloutRevision
    ) {
      return fallbackOrStale("unsupported_query", hasAppServerCursor);
    }
    const cursor = beforeCursor ?? afterCursor;
    const direction: AppServerCursorDirection = afterCursor ? "newer" : "older";

    const capabilityStartedAt = performance.now();
    let metadata: Awaited<ReturnType<CodexHistoryClient["readThread"]>>;
    try {
      metadata = await this.options.client.readThread({
        threadId: sessionId,
        includeTurns: false,
      });
    } catch (error) {
      const failure = this.clientFailure(error);
      if (hasAppServerCursor) throw staleCursorError();
      return failure.kind === "fallback"
        ? {
            ...failure,
            historyCapabilityMs: performance.now() - capabilityStartedAt,
          }
        : failure;
    }
    const historyCapabilityMs = performance.now() - capabilityStartedAt;
    const thread = metadata.thread;
    if (
      canonicalizeProjectPath(thread.cwd) !==
      canonicalizeProjectPath(projectPath)
    ) {
      return fallbackOrStale(
        "provider_mismatch",
        hasAppServerCursor,
        historyCapabilityMs,
      );
    }
    if (thread.historyMode !== "paginated") {
      return fallbackOrStale(
        "legacy_history",
        hasAppServerCursor,
        historyCapabilityMs,
      );
    }

    const messageLimit = Math.max(
      1,
      options.maxMessages ?? DEFAULT_MESSAGE_LIMIT,
    );
    // A completed tool item can expand into tool_use + tool_result. The rare
    // page whose terminal errors exceed maxMessages falls back atomically
    // below rather than shrinking normal transcript windows or skipping rows.
    const itemLimit = Math.max(
      1,
      Math.min(MAX_ITEM_PAGE_LIMIT, Math.floor(messageLimit / 2)),
    );
    const pageStartedAt = performance.now();
    try {
      const requestedItemLimit = Math.min(
        MAX_ITEM_PAGE_LIMIT,
        itemLimit + (cursor?.overlapItemId ? 1 : 0),
      );
      const [turnsPage, itemsPage] = await Promise.all([
        this.options.client.listTurns({
          threadId: sessionId,
          cursor: null,
          limit: MAX_TURN_PAGE_LIMIT,
          sortDirection: "desc",
          itemsView: "notLoaded",
        }),
        this.options.client.listItems({
          threadId: sessionId,
          turnId: null,
          cursor: cursor?.cursor ?? null,
          limit: requestedItemLimit,
          sortDirection: direction === "older" ? "desc" : "asc",
        }),
      ]);
      const pageReadMs = performance.now() - pageStartedAt;
      const normalizeStartedAt = performance.now();
      const turnsById = new Map(turnsPage.data.map((turn) => [turn.id, turn]));
      const rawEntries = itemsPage.data;
      let entries = rawEntries;
      let droppedOverlap = false;
      if (cursor?.overlapItemId) {
        if (rawEntries[0]?.item.id !== cursor.overlapItemId) {
          throw staleCursorError();
        }
        entries = rawEntries.slice(1);
        droppedOverlap = true;
      }
      for (const entry of entries) {
        const itemType = (entry.item as { type?: unknown }).type;
        if (
          typeof itemType !== "string" ||
          !KNOWN_THREAD_ITEM_TYPES.has(itemType) ||
          !turnsById.has(entry.turnId)
        ) {
          throw new CodexHistoryParityError();
        }
      }
      const chronologicalEntries =
        direction === "older" ? [...entries].reverse() : entries;
      const messages = projectThreadEntries(
        sessionId,
        chronologicalEntries,
        turnsById,
        (direction === "older" && !cursor) ||
          (direction === "newer" && !itemsPage.nextCursor),
        projectPath,
        options.inspectorProjection ? "semantic-display" : "strict",
      );
      if (messages.length > messageLimit) {
        throw new CodexHistoryParityError();
      }
      const normalizeMs = performance.now() - normalizeStartedAt;
      const provider = providerFromModelProvider(thread.modelProvider);
      const summary = threadSummary(
        thread,
        projectId,
        provider,
        messages.length,
        turnsPage.data[0],
      );
      const nextCursor = itemsPage.nextCursor
        ? encodeCodexAppServerCursor(itemsPage.nextCursor, {
            direction,
            sessionId,
          })
        : undefined;
      const backwardsCursor = itemsPage.backwardsCursor
        ? encodeCodexAppServerCursor(itemsPage.backwardsCursor, {
            direction: direction === "older" ? "newer" : "older",
            sessionId,
            ...(!droppedOverlap && rawEntries[0]
              ? { overlapItemId: rawEntries[0].item.id }
              : {}),
          })
        : undefined;
      const olderCursor = direction === "older" ? nextCursor : backwardsCursor;
      const newerCursor = direction === "older" ? backwardsCursor : nextCursor;
      const hasOlderMessages =
        direction === "older" ? Boolean(nextCursor) : Boolean(cursor);
      const hasNewerMessages =
        direction === "older" ? Boolean(cursor) : Boolean(nextCursor);
      return {
        kind: "loaded",
        session: {
          summary,
          data: { provider, session: { entries: [] } },
          projectedMessages: messages,
          paginationApplied: true,
          pagination: {
            hasOlderMessages,
            hasNewerMessages,
            totalMessageCount: messages.length,
            returnedMessageCount: messages.length,
            totalCompactions: 0,
            ...(hasOlderMessages && olderCursor
              ? { truncatedBeforeMessageId: olderCursor }
              : {}),
            ...(hasNewerMessages && newerCursor
              ? { truncatedAfterMessageId: newerCursor }
              : {}),
          },
          historySource: "codex-app-server",
          historyReadTimings: {
            historyCapabilityMs,
            summaryScanMs: 0,
            pageReadMs,
            normalizeMs,
          },
        },
      };
    } catch (error) {
      if (error instanceof Error && error.message === "ROLLOUT_CURSOR_STALE") {
        throw error;
      }
      if (error instanceof CodexHistoryParityError) {
        return fallbackOrStale("transcript_parity", hasAppServerCursor);
      }
      if (hasAppServerCursor) throw staleCursorError();
      return this.clientFailure(error);
    }
  }

  private clientFailure(error: unknown): CodexAppServerHistoryReadResult {
    if (!(error instanceof CodexHistoryClientError)) {
      return fallback("app_server_unavailable");
    }
    switch (error.reason) {
      case "invalid_cursor":
        throw staleCursorError();
      case "unsupported":
        return fallback("unsupported_method");
      case "unmaterialized":
        return fallback("unmaterialized");
      case "timeout":
        return fallback("app_server_timeout");
      case "backoff":
        return fallback("app_server_backoff");
      case "protocol":
        return fallback("protocol_mismatch");
      case "unavailable":
        return fallback("app_server_unavailable");
    }
  }

  private semanticClientFailure(
    error: unknown,
  ): CodexAppServerSemanticPageResult {
    const failure = this.clientFailure(error);
    if (failure.kind !== "fallback") {
      throw new Error("Unexpected loaded result while mapping client failure");
    }
    return semanticFallback(failure.reason);
  }
}

function codexAppServerSemanticRevision(
  threadId: string,
  updatedAt: number,
): string {
  return `cas1.${updatedAt}.${threadId}`;
}

function semanticFallback(
  reason: CodexHistoryFallbackReason,
): CodexAppServerSemanticPageResult {
  return { kind: "fallback", reason };
}

function findCodexForkBranchFamily(
  candidates: readonly CodexForkBranchCandidate[],
  currentSessionId: string,
): CodexForkBranchCandidate[] {
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  if (!byId.has(currentSessionId)) return [];

  const adjacent = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    const neighbors = adjacent.get(left) ?? new Set<string>();
    neighbors.add(right);
    adjacent.set(left, neighbors);
  };
  for (const candidate of byId.values()) {
    const parentId = candidate.forkParentSessionId;
    if (!parentId || !byId.has(parentId) || parentId === candidate.id) continue;
    connect(candidate.id, parentId);
    connect(parentId, candidate.id);
  }

  const family: CodexForkBranchCandidate[] = [];
  const queue = [currentSessionId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const candidate = byId.get(id);
    if (candidate) family.push(candidate);
    if (family.length > MAX_FORK_BRANCH_FAMILY_SIZE) return family;
    queue.push(...(adjacent.get(id) ?? []));
  }
  return family;
}

async function readCodexForkBranchMessages(
  client: Pick<CodexHistoryClient, "listItems">,
  sessionId: string,
): Promise<ZCodeStoredMessage[]> {
  const entries: ThreadItemEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (
    let pageIndex = 0;
    pageIndex < MAX_FORK_BRANCH_ITEM_PAGES;
    pageIndex += 1
  ) {
    const page = await client.listItems({
      threadId: sessionId,
      turnId: null,
      cursor,
      limit: MAX_ITEM_PAGE_LIMIT,
      sortDirection: "asc",
    });
    entries.push(...page.data);
    if (entries.length > MAX_FORK_BRANCH_ITEMS) {
      throw new CodexHistoryParityError();
    }
    if (!page.nextCursor) {
      cursor = null;
      break;
    }
    if (!seenCursors.add(page.nextCursor)) {
      throw new CodexHistoryParityError();
    }
    cursor = page.nextCursor;
  }
  if (cursor) throw new CodexHistoryParityError();

  const messages: ZCodeStoredMessage[] = [];
  for (const entry of entries) {
    if (entry.item.type !== "userMessage") continue;
    const id = codexSemanticMessageId(entry.item.id, entry.turnId);
    messages.push({
      id,
      role: "user",
      parts: [
        {
          id: `${id}:text`,
          messageID: id,
          sessionID: sessionId,
          type: "text",
          text: codexUserPromptText(entry.item),
        },
      ],
    });
  }
  return messages;
}

function codexUserPromptText(
  item: Extract<ThreadItem, { type: "userMessage" }>,
): string {
  return item.content
    .map((input) => {
      if (input.type === "text") return input.text;
      if (input.type === "skill") return `$${input.name}`;
      if (input.type === "mention") return `@${input.name}`;
      return "";
    })
    .join("");
}

function codexSemanticMessageId(itemId: string, turnId: string): string {
  return `${itemId}-${turnId}`;
}

async function readAllTurnItems(
  client: Pick<CodexHistoryClient, "listItems">,
  sessionId: string,
  turnId: string,
): Promise<ThreadItem[]> {
  const items: ThreadItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    if (cursor) {
      if (seenCursors.has(cursor)) throw new CodexHistoryParityError();
      seenCursors.add(cursor);
    }
    const page = await client.listItems({
      threadId: sessionId,
      turnId,
      cursor,
      limit: MAX_ITEM_PAGE_LIMIT,
      sortDirection: "asc",
    });
    for (const entry of page.data) {
      if (entry.turnId !== turnId) throw new CodexHistoryParityError();
      items.push(entry.item);
      if (items.length > MAX_SEMANTIC_ITEMS_PER_TURN) {
        throw new CodexHistoryParityError();
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await mapper(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function isCodexAppServerCursor(value: string | undefined): boolean {
  return value?.startsWith(APP_SERVER_CURSOR_NAMESPACE) === true;
}

function staleCursorError(): Error {
  return new Error("ROLLOUT_CURSOR_STALE");
}

function resolveHistoryReadMode(
  value: string | undefined,
): "auto" | "rollout" | "app-server" {
  return value === "rollout" || value === "app-server" ? value : "auto";
}

function fallback(
  reason: CodexHistoryFallbackReason,
  historyCapabilityMs?: number,
): CodexAppServerHistoryReadResult {
  return {
    kind: "fallback",
    reason,
    ...(historyCapabilityMs === undefined ? {} : { historyCapabilityMs }),
  };
}

function fallbackOrStale(
  reason: CodexHistoryFallbackReason,
  sourceLocked: boolean,
  historyCapabilityMs?: number,
): CodexAppServerHistoryReadResult {
  if (sourceLocked) throw staleCursorError();
  return fallback(reason, historyCapabilityMs);
}

function providerFromModelProvider(
  modelProvider: string,
): "codex" | "codex-oss" {
  return LOCAL_MODEL_PROVIDERS.has(modelProvider.toLowerCase())
    ? "codex-oss"
    : "codex";
}

function sourceName(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  if (source && typeof source === "object") {
    if ("custom" in source && typeof source.custom === "string") {
      return source.custom;
    }
    if ("subAgent" in source) return "subAgent";
  }
  return undefined;
}

function threadSummary(
  thread: Awaited<ReturnType<CodexHistoryClient["readThread"]>>["thread"],
  projectId: UrlProjectId,
  provider: "codex" | "codex-oss",
  messageCount: number,
  newestTurn?: Turn,
): SessionSummary {
  const title = thread.name?.trim() || thread.preview.trim() || null;
  return {
    id: thread.id,
    projectId,
    title,
    fullTitle: title,
    createdAt: new Date(thread.createdAt * 1_000).toISOString(),
    updatedAt: new Date(thread.updatedAt * 1_000).toISOString(),
    messageCount,
    ownership: { owner: "none" },
    provider,
    parentSessionId: thread.parentThreadId ?? undefined,
    forkParentSessionId: thread.forkedFromId ?? undefined,
    codexModelProvider: thread.modelProvider,
    cliVersion: thread.cliVersion,
    source: sourceName(thread.source),
    ...(newestTurn && newestTurn.status !== "inProgress"
      ? { lastTurnStatus: newestTurn.status }
      : {}),
    ...(newestTurn?.status === "failed" && newestTurn.error?.message
      ? { lastErrorMessage: newestTurn.error.message }
      : {}),
  };
}

function projectThreadEntries(
  sessionId: string,
  entries: ThreadItemEntry[],
  turnsById: ReadonlyMap<string, Turn>,
  includeTerminalErrorForLastTurn: boolean,
  workspaceRoot: string,
  projectionMode: CodexThreadProjectionMode = "strict",
): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const turn = turnsById.get(entry.turnId);
    messages.push(
      ...projectThreadItem(
        sessionId,
        entry,
        turn,
        workspaceRoot,
        projectionMode,
      ),
    );
    if (
      turn?.status === "failed" &&
      turn.error?.message &&
      (entries[index + 1]
        ? entries[index + 1]?.turnId !== entry.turnId
        : includeTerminalErrorForLastTurn)
    ) {
      messages.push({
        uuid: `provider-error-${turn.id}`,
        timestamp: turn.completedAt
          ? new Date(turn.completedAt * 1_000).toISOString()
          : undefined,
        type: "error",
        error: turn.error.message,
        content: turn.error.message,
        codexThreadId: sessionId,
        codexTurnId: turn.id,
        _source: "jsonl",
      });
    }
  }
  return messages;
}

function projectThreadItem(
  sessionId: string,
  entry: ThreadItemEntry,
  turn: Turn | undefined,
  workspaceRoot: string,
  projectionMode: CodexThreadProjectionMode,
): Message[] {
  const item = entry.item;
  const uuid = codexSemanticMessageId(item.id, entry.turnId);
  const timestamp = turn?.startedAt
    ? new Date(turn.startedAt * 1_000).toISOString()
    : undefined;
  const base = {
    uuid,
    timestamp,
    codexThreadId: sessionId,
    codexTurnId: entry.turnId,
    codexThreadItemId: item.id,
    codexThreadItemLifecycle: itemIsComplete(item) ? "completed" : "started",
    _source: "jsonl",
  } as const;

  switch (item.type) {
    case "userMessage":
      return [
        {
          ...base,
          ...codexUserMessageIdentity(item.clientId),
          type: "user",
          message: {
            role: "user",
            content: userInputBlocks(
              item.content,
              projectionMode,
              workspaceRoot,
            ),
          },
        },
      ];
    case "agentMessage":
      return [
        {
          ...base,
          type: "assistant",
          codexCorrelationKey: `codex:${entry.turnId}:agent-message:${item.id}`,
          ...(item.phase ? { codexMessagePhase: item.phase } : {}),
          message: { role: "assistant", content: item.text },
        },
      ];
    case "reasoning": {
      const thinking = (item.content.length > 0 ? item.content : item.summary)
        .join("\n")
        .trim();
      return thinking
        ? [
            {
              ...base,
              codexRawReasoningAllowed: true,
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "thinking", thinking }],
              },
            },
          ]
        : [];
    }
    case "commandExecution":
      return toolMessages(base, "Bash", { command: item.command }, item.id, {
        content: item.aggregatedOutput ?? "",
        isError:
          item.status === "failed" ||
          (item.exitCode !== null && item.exitCode !== 0),
        completed: item.status !== "inProgress",
      });
    case "fileChange": {
      const safeChanges = publicCodexFileChanges(item.changes, {
        workspaceRoot,
      });
      return toolMessages(
        base,
        "Edit",
        buildCodexEditInput(safeChanges),
        item.id,
        {
          content: item.status,
          isError: item.status === "failed" || item.status === "declined",
          completed: item.status !== "inProgress",
        },
      );
    }
    case "mcpToolCall":
      return toolMessages(
        base,
        `${item.server}:${item.tool}`,
        item.arguments,
        item.id,
        {
          content:
            item.status === "completed"
              ? JSON.stringify(item.result)
              : (item.error?.message ?? "MCP tool call failed"),
          isError: item.status !== "completed",
          completed: item.status !== "inProgress",
        },
      );
    case "dynamicToolCall":
      return toolMessages(
        base,
        item.namespace ? `${item.namespace}:${item.tool}` : item.tool,
        item.arguments,
        item.id,
        {
          content: JSON.stringify(item.contentItems ?? []),
          isError: item.success === false,
          completed: item.status !== "inProgress",
        },
      );
    case "webSearch": {
      const actionLabel = codexWebSearchActionLabel(item.action);
      const query = item.query.trim() || actionLabel || "";
      // Hosted `web_search_call` items never carry structured `results`
      // (Codex maps them with `results: None`), so completion must be inferred
      // from the end payload (query/action) instead of `results`. Only the
      // web-search *begin* placeholder has an empty query, a null action and
      // null results.
      const completed =
        item.results !== null || item.action !== null || query.length > 0;
      return toolMessages(
        base,
        "WebSearch",
        {
          query,
          ...(item.action ? { action: item.action } : {}),
        },
        item.id,
        {
          content:
            item.results !== null
              ? JSON.stringify(item.results)
              : actionLabel
                ? `Codex web search completed: ${actionLabel}`
                : "Codex web search completed",
          isError: false,
          completed,
          toolUseResult: {
            query: query || "Codex web search",
            results: item.results ?? [],
            ...(actionLabel ? { codexActionLabel: actionLabel } : {}),
            ...(item.action ? { codexAction: item.action } : {}),
          },
        },
      );
    }
    case "imageView": {
      if (projectionMode === "strict") {
        throw new CodexHistoryParityError();
      }
      const publicPath = publicCodexFilePath(item.path, { workspaceRoot });
      return toolMessages(base, "ViewImage", { path: publicPath }, item.id, {
        content: `Viewed image: ${publicPath}`,
        isError: false,
        completed: true,
      });
    }
    case "imageGeneration": {
      if (projectionMode === "strict") {
        throw new CodexHistoryParityError();
      }
      const publicPath = item.savedPath
        ? publicCodexFilePath(item.savedPath, { workspaceRoot })
        : undefined;
      const failed = item.failure !== null || item.status === "failed";
      return toolMessages(
        base,
        "ViewImage",
        {
          title: "Generated image",
          status: item.status,
          ...(item.revisedPrompt ? { revised_prompt: item.revisedPrompt } : {}),
          ...(publicPath ? { path: publicPath } : {}),
        },
        item.id,
        {
          content: failed
            ? `Image generation failed: ${item.status}`
            : publicPath
              ? `Generated image: ${publicPath}`
              : `Image generation status: ${item.status}`,
          isError: failed,
          completed: itemIsComplete(item),
        },
      );
    }
    case "hookPrompt":
    case "sleep":
    case "enteredReviewMode":
    case "exitedReviewMode": {
      if (projectionMode === "semantic-display") {
        return [opaqueNativeSystemMessage(base, item.type)];
      }
      // These need managed local-media materialization or a real renderer.
      // A label/status-only projection would silently lose the artifact or
      // transcript semantics, so let the existing rollout path handle them.
      throw new CodexHistoryParityError();
    }
    case "contextCompaction":
      return [
        {
          ...base,
          type: "system",
          subtype: "compact_boundary",
          content: "Context compacted",
        },
      ];
    case "plan":
    case "collabAgentToolCall":
    case "subAgentActivity":
      return [nativeSystemMessage(base, item)];
    default:
      if (projectionMode === "semantic-display") {
        return [opaqueNativeSystemMessage(base, threadItemType(entry.item))];
      }
      throw new CodexHistoryParityError();
  }
}

function opaqueNativeSystemMessage(
  base: Record<string, unknown> & { uuid: string },
  itemType: string,
): Message {
  return {
    ...base,
    type: "system",
    subtype: "codex_native_item",
    codexThreadItem: { type: publicThreadItemType(itemType) },
  } as Message;
}

function publicThreadItemType(value: string): string {
  const normalized = value.trim().slice(0, 128);
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(normalized) ? normalized : "unknown";
}

function threadItemType(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? type : "unknown";
}

function hasStableThreadItemIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as { id?: unknown; type?: unknown };
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.type === "string" &&
    item.type.length > 0
  );
}

function nativeSystemMessage(
  base: Record<string, unknown> & { uuid: string },
  item: Extract<
    ThreadItem,
    { type: "plan" | "collabAgentToolCall" | "subAgentActivity" }
  >,
): Message {
  return {
    ...base,
    type: "system",
    subtype: "codex_native_item",
    codexThreadItem: safeDedicatedNativeThreadItem(item),
  } as Message;
}

function toolMessages(
  base: Record<string, unknown> & { uuid: string },
  name: string,
  input: unknown,
  toolUseId: string,
  result: {
    content: string;
    isError: boolean;
    completed: boolean;
    toolUseResult?: unknown;
  },
): Message[] {
  const toolUse: Message = {
    ...base,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name, input }],
    },
  };
  if (!result.completed) return [toolUse];
  const resultBlock: ContentBlock = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: result.content,
    ...(result.isError ? { is_error: true } : {}),
  };
  return [
    toolUse,
    {
      ...base,
      uuid: `${base.uuid}-result`,
      type: "user",
      message: { role: "user", content: [resultBlock] },
      ...(result.toolUseResult !== undefined
        ? { toolUseResult: result.toolUseResult }
        : {}),
    },
  ];
}

function codexWebSearchActionLabel(action: unknown): string | undefined {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  if (!isRecord(action)) return undefined;
  const type = typeof action.type === "string" ? action.type : undefined;
  const first = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  switch (type) {
    case "search": {
      const query =
        first(action.query) ??
        (Array.isArray(action.queries) ? first(action.queries[0]) : undefined);
      return query ? `Search: ${query}` : "Search";
    }
    case "openPage":
    case "open_page": {
      const url = first(action.url);
      return url ? `Open page: ${url}` : "Open page";
    }
    case "findInPage":
    case "find_in_page": {
      const target = [first(action.pattern), first(action.url)]
        .filter(Boolean)
        .join(" @ ");
      return target ? `Find in page: ${target}` : "Find in page";
    }
    default:
      return type && type !== "other" ? type : undefined;
  }
}

function userInputBlocks(
  inputs: Extract<ThreadItem, { type: "userMessage" }>["content"],
  projectionMode: CodexThreadProjectionMode,
  workspaceRoot: string,
): ContentBlock[] {
  return inputs.map((input): ContentBlock => {
    switch (input.type) {
      case "text":
        return { type: "text", text: input.text };
      case "image":
        if (!publicCodexImageUrl(input.url)) {
          if (projectionMode === "semantic-display") {
            return {
              type: "input_image",
              deferred: true,
              ...(input.detail ? { detail: input.detail } : {}),
            };
          }
          throw new CodexHistoryParityError();
        }
        return {
          type: "input_image",
          image_url: input.url,
          ...(input.detail ? { detail: input.detail } : {}),
        };
      case "localImage": {
        if (projectionMode === "semantic-display") {
          return {
            type: "input_image",
            file_path: publicCodexFilePath(input.path, { workspaceRoot }),
            deferred: true,
            ...(input.detail ? { detail: input.detail } : {}),
          };
        }
        throw new CodexHistoryParityError();
      }
      case "audio":
        if (!publicCodexImageUrl(input.url)) {
          if (projectionMode === "semantic-display") {
            return { type: "input_audio", deferred: true };
          }
          throw new CodexHistoryParityError();
        }
        return { type: "input_audio", audio_url: input.url };
      case "localAudio": {
        if (projectionMode === "semantic-display") {
          return {
            type: "input_audio",
            file_path: publicCodexFilePath(input.path, { workspaceRoot }),
            deferred: true,
          };
        }
        throw new CodexHistoryParityError();
      }
      case "skill":
        return { type: "text", text: `$${input.name}` };
      case "mention":
        return { type: "text", text: `@${input.name}` };
    }
  });
}

function itemIsComplete(item: ThreadItem): boolean {
  if ("status" in item && typeof item.status === "string") {
    return !["inProgress", "in_progress", "running"].includes(item.status);
  }
  return true;
}

function safeDedicatedNativeThreadItem(
  item: Extract<
    ThreadItem,
    { type: "plan" | "collabAgentToolCall" | "subAgentActivity" }
  >,
): Record<string, unknown> {
  if (item.type === "plan" && item.text.length > 64 * 1024) {
    throw new CodexHistoryParityError();
  }
  if (
    item.type === "collabAgentToolCall" &&
    (item.receiverThreadIds.length > 128 ||
      Object.keys(item.agentsStates).length > 128 ||
      collabItemStringLength(item) > 64 * 1024)
  ) {
    throw new CodexHistoryParityError();
  }
  if (
    item.type === "subAgentActivity" &&
    item.id.length + item.agentThreadId.length > 8 * 1024
  ) {
    throw new CodexHistoryParityError();
  }
  return publicCodexThreadItem(item as unknown as Record<string, unknown>);
}

function collabItemStringLength(
  item: Extract<ThreadItem, { type: "collabAgentToolCall" }>,
): number {
  let length =
    item.id.length +
    item.senderThreadId.length +
    (item.model?.length ?? 0) +
    (item.reasoningEffort?.length ?? 0);
  for (const threadId of item.receiverThreadIds) length += threadId.length;
  for (const [threadId, state] of Object.entries(item.agentsStates)) {
    length +=
      threadId.length +
      (state ? String(state.status).length + (state.message?.length ?? 0) : 0);
  }
  return length;
}
