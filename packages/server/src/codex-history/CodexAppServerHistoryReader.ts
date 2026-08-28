import type { UrlProjectId } from "@yep-anywhere/shared";
import {
  buildCodexEditInput,
  publicCodexFileChanges,
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
const LOCAL_MODEL_PROVIDERS = new Set(["ollama", "lmstudio", "local"]);
const KNOWN_THREAD_ITEM_TYPES = new Set([
  "userMessage",
  "hookPrompt",
  "agentMessage",
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

export type CodexAppServerHistoryReadResult =
  | { kind: "loaded"; session: LoadedSession }
  | {
      kind: "fallback";
      reason: CodexHistoryFallbackReason;
      historyCapabilityMs?: number;
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
): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const turn = turnsById.get(entry.turnId);
    messages.push(...projectThreadItem(sessionId, entry, turn, workspaceRoot));
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
): Message[] {
  const item = entry.item;
  const uuid = `${item.id}-${entry.turnId}`;
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
          message: { role: "user", content: userInputBlocks(item.content) },
        },
      ];
    case "agentMessage":
      return [
        {
          ...base,
          type: "assistant",
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
    case "webSearch":
      return toolMessages(base, "WebSearch", { query: item.query }, item.id, {
        content: JSON.stringify(item.results ?? []),
        isError: false,
        completed: item.results !== null,
      });
    case "imageView":
    case "imageGeneration":
    case "hookPrompt":
    case "sleep":
    case "enteredReviewMode":
    case "exitedReviewMode":
      // These need managed local-media materialization or a real renderer.
      // A label/status-only projection would silently lose the artifact or
      // transcript semantics, so let the existing rollout path handle them.
      throw new CodexHistoryParityError();
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
      throw new CodexHistoryParityError();
  }
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
  result: { content: string; isError: boolean; completed: boolean },
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
    },
  ];
}

function userInputBlocks(
  inputs: Extract<ThreadItem, { type: "userMessage" }>["content"],
): ContentBlock[] {
  return inputs.map((input): ContentBlock => {
    switch (input.type) {
      case "text":
        return { type: "text", text: input.text };
      case "image":
        if (!publicCodexImageUrl(input.url)) {
          throw new CodexHistoryParityError();
        }
        return {
          type: "input_image",
          image_url: input.url,
          ...(input.detail ? { detail: input.detail } : {}),
        };
      case "localImage":
        throw new CodexHistoryParityError();
      case "audio":
        if (!publicCodexImageUrl(input.url)) {
          throw new CodexHistoryParityError();
        }
        return { type: "input_audio", audio_url: input.url };
      case "localAudio":
        throw new CodexHistoryParityError();
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
