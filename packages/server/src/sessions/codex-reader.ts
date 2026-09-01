/**
 * CodexSessionReader - Reads Codex sessions from disk.
 *
 * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * with a different format than Claude:
 * - session_meta: Session initialization (id, cwd, timestamp)
 * - response_item: Messages, reasoning, function calls
 * - event_msg: User/agent messages, token counts
 * - turn_context: Per-turn configuration
 *
 * Unlike Claude's DAG structure, Codex sessions are linear.
 */

import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import {
  type AgentMapping,
  type AgentStatus,
  type CodexBranchOption,
  type CodexBranchState,
  type CodexEventMsgEntry,
  type CodexFunctionCallOutputPayload,
  type CodexFunctionCallPayload,
  type CodexMessagePayload,
  type CodexReasoningPayload,
  type CodexResponseItemEntry,
  type CodexSessionEntry,
  type CodexSessionMetaEntry,
  type CodexTurnContextEntry,
  type ContextCompactEvent,
  type ContextCumulativeUsage,
  SESSION_TITLE_MAX_LENGTH,
  type SessionQuestion,
  type SubagentDescriptor,
  type SubagentStatus,
  type UnifiedSession,
  type UrlProjectId,
  getModelContextWindow,
  parseCodexSessionEntry,
} from "@yep-anywhere/shared";
import { isCodexImageGenerationRecord } from "../codex/image-generation.js";
import { canonicalizeCodexToolName } from "../codex/normalization.js";
import {
  codexEventUserMessageClientId,
  codexUserMessageIdentity,
  collectCodexResponseUserClientIds,
} from "../codex/user-message-identity.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type {
  ContentBlock,
  ContextUsage,
  Message,
  Session,
  SessionSummary,
} from "../supervisor/types.js";
import { readSharedCodexEntries } from "./codex-entries-reader.js";
import {
  attachCodexEntryByteOffset,
  codexEntryAnchor,
  getCodexEntryByteOffset,
} from "./codex-entry-anchor.js";
import { buildCodexBranchView } from "./codex-rollback.js";
import {
  CodexRolloutScanError,
  codexRolloutRevision,
  iterateCodexRolloutLines,
  sameCodexRolloutRevision,
} from "./codex-rollout-file.js";
import {
  type CodexSessionManifest,
  type CodexSessionManifestEntry,
  getCodexSessionManifest,
  invalidateCodexSessionManifest,
} from "./codex-session-manifest.js";
import { isCodexTurnAbortedNoticeText } from "./codex-turn-aborted.js";
import { convertCodexEntries } from "./normalization.js";
import type { PaginationInfo } from "./pagination.js";
import {
  sanitizeCodexPublicUserPrompt,
  sanitizeCodexUserContentBlockText,
} from "./public-user-prompt.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";
import {
  isSessionSetupText,
  isSyntheticUserPromptText,
} from "./user-prompt-classification.js";
import { createSessionQuestion } from "./user-questions.js";

export interface CodexSessionReaderOptions {
  /**
   * Base directory for Codex sessions (~/.codex/sessions).
   * Sessions are stored in YYYY/MM/DD/rollout-*.jsonl structure.
   */
  sessionsDir: string;
  /**
   * The project path (cwd) to filter sessions by.
   * Only sessions with this cwd will be listed.
   */
  projectPath?: string;
}

type CodexSessionFile = CodexSessionManifestEntry;

const CODEX_SESSION_FILE_CACHE_TTL_MS = 5000;
const CODEX_COMPACTION_EVENT_DEDUPE_WINDOW_MS = 5_000;

/**
 * Codex `model_provider` ids that run models locally (Ollama/LM Studio). These
 * map to the `codex-oss` provider; every other explicit provider is a cloud
 * Codex source and stays under `codex`.
 */
const LOCAL_CODEX_MODEL_PROVIDERS = new Set(["ollama", "lmstudio", "local"]);

const CODEX_DEFAULT_PAGE_MESSAGES = 100;
const CODEX_MAX_ROLLOUT_LINE_BYTES = positiveEnvInt(
  "YEP_CODEX_MAX_ROLLOUT_LINE_BYTES",
  8 * 1024 * 1024,
);
const CODEX_MAX_ROLLOUT_SCAN_BYTES = positiveEnvInt(
  "YEP_CODEX_MAX_ROLLOUT_SCAN_BYTES",
  512 * 1024 * 1024,
);
const CODEX_MAX_PAGE_BYTES = positiveEnvInt(
  "YEP_CODEX_MAX_PAGE_BYTES",
  64 * 1024 * 1024,
);
const CODEX_MAX_SUMMARY_ITEMS = positiveEnvInt(
  "YEP_CODEX_MAX_SUMMARY_ITEMS",
  2048,
);
const CODEX_MAX_SUMMARY_TEXT_CHARS = positiveEnvInt(
  "YEP_CODEX_MAX_SUMMARY_TEXT_CHARS",
  16 * 1024,
);
const CODEX_MAX_BRANCH_ITEMS = positiveEnvInt(
  "YEP_CODEX_MAX_BRANCH_ITEMS",
  20_000,
);
const CODEX_ROLLBACK_FULL_READ_MAX_BYTES = positiveEnvInt(
  "YEP_CODEX_ROLLBACK_FULL_READ_MAX_BYTES",
  32 * 1024 * 1024,
);

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function codexQuestionTurnId(payload: CodexResponseItemEntry["payload"]): {
  turnId?: string;
} {
  if (payload.type !== "message") return {};
  const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
  return typeof turnId === "string" && turnId
    ? { turnId: `turn:${turnId}` }
    : {};
}

function boundCodexSummaryText(value: string): string {
  return value.length <= CODEX_MAX_SUMMARY_TEXT_CHARS
    ? value
    : `${value.slice(0, CODEX_MAX_SUMMARY_TEXT_CHARS - 1)}…`;
}

interface CodexUserTurnScan {
  offset: number;
  prompt: string;
  timestamp?: string;
}

interface CodexSummaryScan {
  stats: Stats;
  revisionKey: string;
  logicalBytes: number;
  metaEntry?: CodexSessionMetaEntry;
  hasResponseItemUser: boolean;
  hasRollbackMarker: boolean;
  messageCount: number;
  eventUserMessageCount: number;
  responseMessageCount: number;
  responseQuestions: SessionQuestion[];
  eventQuestions: SessionQuestion[];
  responseQuestionsTruncated: boolean;
  eventQuestionsTruncated: boolean;
  responseTitle: { title: string; fullTitle: string } | null;
  eventTitle: { title: string; fullTitle: string } | null;
  model?: string;
  firstTurnContext?: CodexTurnContextEntry;
  latestTurnContext?: CodexTurnContextEntry;
  latestVisibleEntryTimestamp: string | null;
  contextUsage?: ContextUsage;
  cumulativeUsage?: ContextCumulativeUsage;
  compactCount: number;
  compactEvents?: ContextCompactEvent[];
  compactionOffsets: number[];
  responseUserTurns: CodexUserTurnScan[];
  eventUserTurns: CodexUserTurnScan[];
  /** Bounded semantic hints used to keep page counts/conversion parity. */
  patchApplyCallIds: Set<string>;
  directEditCallIds: Set<string>;
  responseImageGenerationIds: Set<string>;
  imageGenerationEndIds: Set<string>;
}

interface CodexPageScan {
  entries: CodexSessionEntry[];
  totalMessageCount: number;
  totalCompactions: number;
  hasOlderMessages: boolean;
  hasNewerMessages: boolean;
  targetMessageFound: boolean;
  revisionKey: string;
}

export class CodexHistoryUnavailableError extends Error {
  readonly code = "SESSION_HISTORY_UNAVAILABLE";

  constructor(message = "Codex rollback history exceeds the safe load budget") {
    super(message);
    this.name = "CodexHistoryUnavailableError";
  }
}

interface CodexEntryRecord {
  entry: CodexSessionEntry;
  offset: number;
  byteLength: number;
  outputCount: number;
}

const inFlightCodexSummaryScans = new Map<string, Promise<CodexSummaryScan>>();
const CODEX_MAX_ADMISSION_BYTES = positiveEnvInt(
  "YEP_CODEX_ROLLOUT_ADMISSION_BYTES",
  512 * 1024 * 1024,
);
let codexReservedAdmissionBytes = 0;
const codexAdmissionWaiters: Array<{
  bytes: number;
  resolve: () => void;
}> = [];

async function reserveCodexRolloutAdmission(
  filePath: string,
): Promise<() => void> {
  const fileStats = await stat(filePath);
  const bytes = Math.max(1, fileStats.size);
  if (bytes > CODEX_MAX_ADMISSION_BYTES) {
    throw new CodexRolloutScanError(
      "scan_budget_exceeded",
      `Codex rollout exceeds the ${CODEX_MAX_ADMISSION_BYTES}-byte admission budget`,
      0,
    );
  }

  while (codexReservedAdmissionBytes + bytes > CODEX_MAX_ADMISSION_BYTES) {
    await new Promise<void>((resolve) => {
      codexAdmissionWaiters.push({ bytes, resolve });
    });
  }
  codexReservedAdmissionBytes += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    codexReservedAdmissionBytes -= bytes;
    for (let index = 0; index < codexAdmissionWaiters.length; index += 1) {
      const waiter = codexAdmissionWaiters[index];
      if (!waiter) continue;
      if (
        codexReservedAdmissionBytes + waiter.bytes >
        CODEX_MAX_ADMISSION_BYTES
      ) {
        continue;
      }
      codexAdmissionWaiters.splice(index, 1);
      waiter.resolve();
      break;
    }
  };
}

async function withCodexRolloutAdmission<T>(
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const release = await reserveCodexRolloutAdmission(filePath);
  try {
    return await run();
  } finally {
    release();
  }
}

function codexCursorOffset(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /@([0-9]+)/.exec(value);
  if (!match) return undefined;
  const offset = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
}

function getNormalizedMessageId(
  message: Message | undefined,
): string | undefined {
  return (
    message?.uuid ?? (typeof message?.id === "string" ? message.id : undefined)
  );
}

function hasLegacyCodexCursor(value: string | undefined): boolean {
  return value !== undefined && codexCursorOffset(value) === undefined;
}

function codexTailStartOffset(
  offsets: readonly number[],
  tailCompactions: number | undefined,
  beforeOffset: number | undefined,
): number {
  if (!tailCompactions || tailCompactions <= 0) return 0;
  const eligible = offsets.filter(
    (offset) => beforeOffset === undefined || offset < beforeOffset,
  );
  if (eligible.length <= tailCompactions) return 0;
  return eligible[eligible.length - tailCompactions] ?? 0;
}

interface CodexPageSemanticHints {
  patchApplyCallIds: ReadonlySet<string>;
  directEditCallIds: ReadonlySet<string>;
  responseImageGenerationIds: ReadonlySet<string>;
  imageGenerationEndIds: ReadonlySet<string>;
}

function codexEntryOutputCount(
  entry: CodexSessionEntry,
  hasResponseItemUser: boolean,
  compactedTimestamps: readonly number[],
  semantic?: CodexPageSemanticHints,
): number {
  if (entry.type === "response_item") {
    switch (entry.payload.type) {
      case "message":
        return entry.payload.role === "developer" ? 0 : 1;
      case "reasoning":
      case "function_call":
      case "web_search_call":
        return 1;
      case "function_call_output":
      case "custom_tool_call_output":
        return semantic?.patchApplyCallIds.has(entry.payload.call_id ?? "")
          ? 0
          : 1;
      case "custom_tool_call":
        return 1;
      case "image_generation":
      case "imageGeneration":
      case "image_generation_call": {
        const imageId = (entry.payload as { id?: unknown }).id;
        if (
          entry.payload.type === "image_generation_call" &&
          typeof imageId === "string" &&
          semantic?.imageGenerationEndIds.has(imageId)
        ) {
          return 0;
        }
        return 2;
      }
      default:
        return 0;
    }
  }
  if (entry.type === "compacted") return 1;
  if (entry.type !== "event_msg") return 0;

  switch (entry.payload.type) {
    case "token_count":
    case "agent_message":
    case "agent_reasoning":
    case "task_complete":
      return 0;
    case "user_message":
      return hasResponseItemUser ? 0 : 1;
    case "turn_aborted":
      return 1;
    case "context_compacted":
      return hasNearbyCodexCompactedEntry(
        compactedTimestamps as number[],
        entry.timestamp,
      )
        ? 0
        : 1;
    case "patch_apply_end": {
      const callId = (entry.payload as { call_id?: unknown }).call_id;
      return typeof callId === "string" &&
        semantic?.directEditCallIds.has(callId)
        ? 1
        : 2;
    }
    case "image_generation_end":
      return 2;
    case "item_completed": {
      const item = entry.payload.item;
      const itemId =
        isRecord(item) && typeof item.id === "string" ? item.id : undefined;
      if (!isRecord(item) || !isCodexImageGenerationRecord(item)) return 0;
      return itemId && semantic?.responseImageGenerationIds.has(itemId) ? 0 : 2;
    }
    default:
      return 0;
  }
}

/**
 * Derive a sub-agent lifecycle status from its rollout entries.
 *
 * Codex sub-agents are independent threads that end with either a
 * `task_complete` event (completed), a `turn_aborted` event (interrupted), or
 * neither while still running (`running`). We scan the event_msg entries in
 * reverse to find the last terminal marker.
 */
function deriveCodexSubagentStatus(entries: readonly CodexSessionEntry[]): {
  status: AgentStatus;
  descriptorStatus: SubagentStatus;
} {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "event_msg") continue;
    const payload = entry.payload as { type?: unknown; error?: unknown };
    if (payload.type === "task_complete") {
      return payload.error !== undefined && payload.error !== null
        ? { status: "failed", descriptorStatus: "failed" }
        : { status: "completed", descriptorStatus: "completed" };
    }
    if (payload.type === "turn_aborted") {
      return { status: "failed", descriptorStatus: "interrupted" };
    }
    if (payload.type === "error") {
      return { status: "failed", descriptorStatus: "failed" };
    }
  }
  return { status: "running", descriptorStatus: "running" };
}

function addCodexSpawnMapping(
  callIdByChildThread: Map<string, string>,
  entry: CodexSessionEntry,
): void {
  if (entry.type !== "event_msg") return;
  const payload = entry.payload as Record<string, unknown>;
  let childThreadId: unknown;
  let callId: unknown;
  if (payload.type === "item_completed") {
    const item =
      payload.item && typeof payload.item === "object"
        ? (payload.item as Record<string, unknown>)
        : undefined;
    const tool = item?.tool;
    if (
      item?.type !== "CollabAgentToolCall" ||
      (tool !== "spawn_agent" && tool !== "spawnAgent" && tool !== "SpawnAgent")
    ) {
      return;
    }
    childThreadId = Array.isArray(item.receiver_thread_ids)
      ? item.receiver_thread_ids[0]
      : undefined;
    callId = item.id;
  } else if (payload.type === "collab_agent_spawn_end") {
    // Compatibility for older rollout fixtures that persisted the legacy
    // terminal event directly.
    childThreadId = payload.new_thread_id;
    callId = payload.call_id;
  } else {
    return;
  }
  if (typeof childThreadId === "string" && typeof callId === "string") {
    callIdByChildThread.set(childThreadId, callId);
  }
}

async function scanCodexSpawnMapping(
  filePath: string,
): Promise<Map<string, string>> {
  return withCodexRolloutAdmission(filePath, async () => {
    const mapping = new Map<string, string>();
    for await (const line of iterateCodexRolloutLines(filePath, {
      maxLineBytes: CODEX_MAX_ROLLOUT_LINE_BYTES,
      maxBytes: CODEX_MAX_ROLLOUT_SCAN_BYTES,
    })) {
      if (!line.line) continue;
      const entry = parseCodexSessionEntry(line.line);
      if (entry) addCodexSpawnMapping(mapping, entry);
    }
    return mapping;
  });
}

async function readCodexEntries(
  filePath: string,
): Promise<readonly CodexSessionEntry[]> {
  const { entries } = await readSharedCodexEntries(filePath);
  return entries;
}

function timestampToMs(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function hasNearbyCodexCompactedEntry(
  compactedTimestamps: number[],
  timestamp: string | undefined,
): boolean {
  const eventTimestamp = timestampToMs(timestamp);
  if (eventTimestamp === null) return false;

  return compactedTimestamps.some(
    (compactedTimestamp) =>
      Math.abs(compactedTimestamp - eventTimestamp) <=
      CODEX_COMPACTION_EVENT_DEDUPE_WINDOW_MS,
  );
}

function latestVisibleEntryTimestamp(
  entries: CodexSessionEntry[],
): string | null {
  let latestMs = Number.NEGATIVE_INFINITY;
  let latestTimestamp: string | null = null;

  for (const entry of entries) {
    if (entry.type !== "response_item" && entry.type !== "event_msg") {
      continue;
    }

    const ms = timestampToMs(entry.timestamp);
    if (ms === null || ms <= latestMs) continue;
    latestMs = ms;
    latestTimestamp = new Date(ms).toISOString();
  }

  return latestTimestamp;
}

/**
 * Codex-specific session reader for Codex CLI JSONL files.
 *
 * Handles Codex's linear conversation structure with session_meta,
 * response_item, event_msg, and turn_context entries.
 */
export class CodexSessionReader implements ISessionReader {
  private sessionsDir: string;
  private projectPath?: string;

  // Cache of session ID -> file path for quick lookups
  private sessionFileCache: Map<string, CodexSessionFile> = new Map();
  private cacheTimestamp = 0;

  constructor(options: CodexSessionReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
  }

  invalidateCache(): void {
    this.sessionFileCache.clear();
    this.cacheTimestamp = 0;
    invalidateCodexSessionManifest(this.sessionsDir);
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const sessions = await this.scanSessions();

    for (const session of sessions) {
      const summary = await this.getSessionSummary(session.id, projectId);
      if (summary) {
        summaries.push(summary);
      }
    }

    // Sort by updatedAt descending
    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const scan = await this.scanCodexRolloutSummary(sessionFile.filePath);
      if (!scan.metaEntry) return null;

      // Rollback markers change the meaning of every preceding turn. Keep the
      // battle-tested branch reducer for small historical files until the
      // rollback semantic index lands; never put a large rollback rollout back
      // through the unbounded reader.
      if (scan.hasRollbackMarker) {
        if (scan.stats.size > CODEX_ROLLBACK_FULL_READ_MAX_BYTES) return null;
        const loaded = await this.loadSessionEntries(sessionId);
        return loaded
          ? this.buildSummaryFromEntries(
              loaded.entries,
              loaded.stats,
              sessionId,
              projectId,
            )
          : null;
      }

      return this.buildSummaryFromScan(scan, sessionId, projectId);
    } catch (error) {
      if (error instanceof CodexRolloutScanError) {
        return null;
      }
      return null;
    }
  }

  private async scanCodexRolloutSummary(
    filePath: string,
  ): Promise<CodexSummaryScan> {
    const existing = inFlightCodexSummaryScans.get(filePath);
    if (existing) return existing;

    const tracked = this.scanCodexRolloutSummaryUnshared(filePath).finally(
      () => {
        if (inFlightCodexSummaryScans.get(filePath) === tracked) {
          inFlightCodexSummaryScans.delete(filePath);
        }
      },
    );
    inFlightCodexSummaryScans.set(filePath, tracked);
    return tracked;
  }

  private async scanCodexRolloutSummaryUnshared(
    filePath: string,
  ): Promise<CodexSummaryScan> {
    return withCodexRolloutAdmission(filePath, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await stat(filePath);
        const revision = codexRolloutRevision(before);
        const scan = await this.scanCodexRolloutSummaryOnce(
          filePath,
          before,
          revision.key,
        );
        const after = await stat(filePath);
        const afterRevision = codexRolloutRevision(after);
        if (sameCodexRolloutRevision(revision, afterRevision)) {
          return { ...scan, stats: after, revisionKey: afterRevision.key };
        }
      }

      throw new Error("ROLLOUT_CHANGED_DURING_SCAN");
    });
  }

  private async scanCodexRolloutSummaryOnce(
    filePath: string,
    stats: Stats,
    revisionKey: string,
  ): Promise<CodexSummaryScan> {
    const responseQuestions: SessionQuestion[] = [];
    const eventQuestions: SessionQuestion[] = [];
    const responseUserTurns: CodexUserTurnScan[] = [];
    const eventUserTurns: CodexUserTurnScan[] = [];
    const patchApplyCallIds = new Set<string>();
    const directEditCallIds = new Set<string>();
    const responseImageGenerationIds = new Set<string>();
    const imageGenerationEndIds = new Set<string>();
    const compactedTimestamps: number[] = [];
    const compactionOffsets: number[] = [];
    const compactEvents: ContextCompactEvent[] = [];
    const pendingCompactEvents: ContextCompactEvent[] = [];

    let metaEntry: CodexSessionMetaEntry | undefined;
    let hasResponseItemUser = false;
    let hasRollbackMarker = false;
    let responseMessageCount = 0;
    let eventUserMessageCount = 0;
    let responseQuestionIndex = 0;
    let eventQuestionIndex = 0;
    let responseQuestionsTruncated = false;
    let eventQuestionsTruncated = false;
    let pendingResponseQuestion: SessionQuestion | null = null;
    let responseTitle: { title: string; fullTitle: string } | null = null;
    let eventTitle: { title: string; fullTitle: string } | null = null;
    let model: string | undefined;
    let firstTurnContext: CodexTurnContextEntry | undefined;
    let latestTurnContext: CodexTurnContextEntry | undefined;
    let latestVisibleMs = Number.NEGATIVE_INFINITY;
    let latestVisibleEntryTimestamp: string | null = null;
    let logicalBytes = 0;
    let contextUsage: ContextUsage | undefined;
    let compactCount = 0;
    let lastContextTokens: number | undefined;
    let tokenCountAfterCompaction = false;
    let tokenCountTurns = 0;
    let currentSegment: {
      total_tokens: number;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens?: number;
    } | null = null;
    const cumulativeSegments: Array<{
      total_tokens: number;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens?: number;
    }> = [];
    let cumulativeTruncated = false;

    const finishSegment = (): void => {
      if (currentSegment) {
        cumulativeSegments.push(currentSegment);
        if (cumulativeSegments.length > CODEX_MAX_SUMMARY_ITEMS) {
          cumulativeSegments.shift();
          cumulativeTruncated = true;
        }
      }
      currentSegment = null;
    };

    const addCompactionEvent = (
      entry: CodexSessionEntry,
      trigger: "compacted" | "context_compacted",
    ): void => {
      const event: ContextCompactEvent = {
        trigger,
        ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
        ...(lastContextTokens !== undefined
          ? { beforeTokens: lastContextTokens }
          : {}),
      };
      pendingCompactEvents.push(event);
      if (pendingCompactEvents.length > CODEX_MAX_SUMMARY_ITEMS) {
        pendingCompactEvents.shift();
      }
    };

    const resolveCompactionAfterTokens = (afterTokens: number): void => {
      if (pendingCompactEvents.length === 0) return;
      for (const event of pendingCompactEvents) {
        event.afterTokens = afterTokens;
        if (
          event.beforeTokens !== undefined &&
          event.beforeTokens > afterTokens
        ) {
          event.reclaimedTokens = event.beforeTokens - afterTokens;
        }
        if (compactEvents.length < CODEX_MAX_SUMMARY_ITEMS) {
          compactEvents.push(event);
        }
      }
      pendingCompactEvents.length = 0;
    };

    const addRecentCompactionTimestamp = (timestamp: string | undefined) => {
      const ms = timestampToMs(timestamp);
      if (ms === null) return;
      compactedTimestamps.push(ms);
      const cutoff = ms - CODEX_COMPACTION_EVENT_DEDUPE_WINDOW_MS;
      while (compactedTimestamps.length > 0) {
        const first = compactedTimestamps[0];
        if (first === undefined || first >= cutoff) break;
        compactedTimestamps.shift();
      }
    };

    const addQuestion = (
      target: SessionQuestion[],
      question: SessionQuestion | null,
    ): boolean => {
      if (!question) return false;
      if (target.length >= CODEX_MAX_SUMMARY_ITEMS) return true;
      target.push(question);
      return false;
    };

    const addBranchTurn = (
      target: CodexUserTurnScan[],
      entry: CodexSessionEntry,
      prompt: string,
    ): void => {
      if (target.length >= CODEX_MAX_BRANCH_ITEMS) return;
      const publicPrompt = boundCodexSummaryText(prompt.trim());
      if (
        !publicPrompt ||
        isCodexTurnAbortedNoticeText(publicPrompt) ||
        isSessionSetupText(publicPrompt) ||
        isSyntheticUserPromptText(publicPrompt)
      ) {
        return;
      }
      target.push({
        offset: getCodexEntryByteOffset(entry) ?? 0,
        prompt: publicPrompt,
        ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      });
    };

    for await (const line of iterateCodexRolloutLines(filePath, {
      maxLineBytes: CODEX_MAX_ROLLOUT_LINE_BYTES,
      maxBytes: CODEX_MAX_ROLLOUT_SCAN_BYTES,
    })) {
      logicalBytes = Math.max(logicalBytes, line.offset + line.byteLength + 1);
      if (!line.line) continue;
      const entry = parseCodexSessionEntry(line.line);
      if (!entry) continue;
      attachCodexEntryByteOffset(entry, line.offset);

      if (entry.type === "session_meta") {
        metaEntry ??= entry;
        continue;
      }

      if (entry.type === "turn_context") {
        firstTurnContext ??= entry;
        latestTurnContext = entry;
        if (!model && entry.payload.model) model = entry.payload.model;
        continue;
      }

      const visibleMs = timestampToMs(entry.timestamp);
      if (
        visibleMs !== null &&
        visibleMs > latestVisibleMs &&
        (entry.type === "response_item" || entry.type === "event_msg")
      ) {
        latestVisibleMs = visibleMs;
        latestVisibleEntryTimestamp = new Date(visibleMs).toISOString();
      }

      if (entry.type === "response_item") {
        const isUserResponse =
          entry.payload.type === "message" && entry.payload.role === "user";
        if (!isUserResponse) pendingResponseQuestion = null;
        if (entry.payload.type === "message") {
          if (entry.payload.role === "user") {
            hasResponseItemUser = true;
            const text = boundCodexSummaryText(
              this.extractCodexUserMessageText(entry.payload.content),
            );
            const title = this.buildTitleFromText(text);
            if (
              title &&
              responseTitle === null &&
              !isCodexTurnAbortedNoticeText(text) &&
              !isSessionSetupText(text) &&
              !isSyntheticUserPromptText(text)
            ) {
              responseTitle = title;
            }
            addBranchTurn(responseUserTurns, entry, text);

            const anchor = codexEntryAnchor(
              entry,
              `${responseQuestionIndex}-${entry.timestamp}`,
            );
            const question = createSessionQuestion(
              {
                id: `codex-${anchor}`,
                ...codexQuestionTurnId(entry.payload),
                text,
                timestamp: entry.timestamp,
              },
              `codex-user-${anchor}`,
            );
            responseQuestionsTruncated =
              addQuestion(responseQuestions, question) ||
              responseQuestionsTruncated;
            pendingResponseQuestion = question;
            responseQuestionIndex += 1;
          }
          if (
            entry.payload.role === "user" ||
            entry.payload.role === "assistant"
          ) {
            responseMessageCount += 1;
          }
        }

        const payload = entry.payload as Record<string, unknown>;
        if (
          (payload.type === "function_call" ||
            payload.type === "custom_tool_call") &&
          typeof payload.name === "string"
        ) {
          const callId =
            typeof payload.call_id === "string"
              ? payload.call_id
              : typeof payload.id === "string"
                ? payload.id
                : undefined;
          if (
            callId &&
            canonicalizeCodexToolName(
              payload.name,
              typeof payload.namespace === "string"
                ? payload.namespace
                : undefined,
            ) === "Edit" &&
            directEditCallIds.size < CODEX_MAX_BRANCH_ITEMS
          ) {
            directEditCallIds.add(callId);
          }
        }
        if (
          (payload.type === "image_generation" ||
            payload.type === "imageGeneration" ||
            payload.type === "image_generation_call") &&
          typeof payload.id === "string" &&
          responseImageGenerationIds.size < CODEX_MAX_BRANCH_ITEMS
        ) {
          responseImageGenerationIds.add(payload.id);
        }
        continue;
      }

      if (entry.type === "compacted") {
        compactCount += 1;
        compactionOffsets.push(getCodexEntryByteOffset(entry) ?? 0);
        if (compactionOffsets.length > CODEX_MAX_BRANCH_ITEMS) {
          compactionOffsets.shift();
        }
        finishSegment();
        addRecentCompactionTimestamp(entry.timestamp);
        addCompactionEvent(entry, "compacted");
        tokenCountAfterCompaction = true;
        continue;
      }

      if (entry.type !== "event_msg") continue;
      const payload = entry.payload;
      const payloadType = (payload as { type?: unknown }).type;
      const userClientId = codexEventUserMessageClientId(payload);
      if (userClientId) {
        if (pendingResponseQuestion) {
          Object.assign(
            pendingResponseQuestion,
            codexUserMessageIdentity(userClientId),
          );
        }
        pendingResponseQuestion = null;
      }

      if (payloadType === "thread_rolled_back") {
        hasRollbackMarker = true;
      }

      if (payloadType === "patch_apply_end") {
        const callId = (payload as { call_id?: unknown }).call_id;
        if (
          typeof callId === "string" &&
          patchApplyCallIds.size < CODEX_MAX_BRANCH_ITEMS
        ) {
          patchApplyCallIds.add(callId);
        }
      }

      if (payloadType === "image_generation_end") {
        const imageId = (payload as { id?: unknown }).id;
        if (
          typeof imageId === "string" &&
          imageGenerationEndIds.size < CODEX_MAX_BRANCH_ITEMS
        ) {
          imageGenerationEndIds.add(imageId);
        }
      }

      if (payloadType === "user_message") {
        const message = (payload as { message?: unknown }).message;
        if (typeof message !== "string") continue;
        eventUserMessageCount += 1;
        const publicPrompt = boundCodexSummaryText(
          sanitizeCodexPublicUserPrompt(message).trim(),
        );
        const title = this.buildTitleFromText(publicPrompt);
        if (
          title &&
          eventTitle === null &&
          !isCodexTurnAbortedNoticeText(publicPrompt) &&
          !isSessionSetupText(publicPrompt) &&
          !isSyntheticUserPromptText(publicPrompt)
        ) {
          eventTitle = title;
        }
        addBranchTurn(eventUserTurns, entry, publicPrompt);

        const anchor = codexEntryAnchor(
          entry,
          `${eventQuestionIndex}-${entry.timestamp}`,
        );
        eventQuestionsTruncated =
          addQuestion(
            eventQuestions,
            createSessionQuestion(
              {
                id: `codex-event-${anchor}`,
                ...codexUserMessageIdentity(
                  (payload as { client_id?: unknown }).client_id,
                ),
                text: [
                  publicPrompt,
                  ...((payload as { images?: unknown[] }).images?.length
                    ? ["[image]"]
                    : []),
                ].join("\n"),
                timestamp: entry.timestamp,
              },
              `codex-event-user-${anchor}`,
            ),
          ) || eventQuestionsTruncated;
        eventQuestionIndex += 1;
        continue;
      }

      if (payloadType === "token_count") {
        tokenCountTurns += 1;
        const info = (payload as { info?: unknown }).info as
          | {
              last_token_usage?: {
                total_tokens: number;
                input_tokens: number;
                output_tokens: number;
                cached_input_tokens?: number;
              };
              total_token_usage?: {
                total_tokens: number;
                input_tokens: number;
                output_tokens: number;
                cached_input_tokens?: number;
              };
              model_context_window?: number;
            }
          | null
          | undefined;
        const usage = info?.last_token_usage ?? info?.total_token_usage;
        const cumulativeUsage =
          info?.total_token_usage ?? info?.last_token_usage;
        if (!usage || !cumulativeUsage) continue;

        let inputTokens = usage.input_tokens;
        if (
          inputTokens === 0 &&
          usage.total_tokens > 0 &&
          tokenCountAfterCompaction
        ) {
          inputTokens = usage.total_tokens;
        }
        if (inputTokens > 0) {
          const contextWindow =
            info?.model_context_window && info.model_context_window > 0
              ? info.model_context_window
              : getModelContextWindow(
                  model,
                  this.determineProvider(
                    metaEntry ?? ({} as CodexSessionMetaEntry),
                    model,
                  ),
                );
          contextUsage = {
            inputTokens,
            percentage: Math.min(
              100,
              Math.round((inputTokens / contextWindow) * 100),
            ),
            contextWindow,
            ...(usage.output_tokens > 0
              ? { outputTokens: usage.output_tokens }
              : {}),
            ...((usage.cached_input_tokens ?? 0) > 0
              ? { cacheReadTokens: usage.cached_input_tokens }
              : {}),
          };
          lastContextTokens = inputTokens;
          resolveCompactionAfterTokens(inputTokens);
        }

        currentSegment = cumulativeUsage;
        tokenCountAfterCompaction = false;
        continue;
      }

      if (payloadType === "context_compacted") {
        const pairedWithCompacted = hasNearbyCodexCompactedEntry(
          compactedTimestamps,
          entry.timestamp,
        );
        if (!pairedWithCompacted) {
          compactCount += 1;
          compactionOffsets.push(getCodexEntryByteOffset(entry) ?? 0);
          if (compactionOffsets.length > CODEX_MAX_BRANCH_ITEMS) {
            compactionOffsets.shift();
          }
          finishSegment();
          addCompactionEvent(entry, "context_compacted");
          tokenCountAfterCompaction = false;
        }
        // A context_compacted event immediately following a persisted
        // `compacted` marker is a duplicate notification. Keep the marker's
        // post-compaction token rule alive for the following token_count.
      }
    }

    finishSegment();
    for (const event of pendingCompactEvents) {
      if (compactEvents.length < CODEX_MAX_SUMMARY_ITEMS) {
        compactEvents.push(event);
      }
    }

    const cumulativeTotals =
      this.sumCodexCumulativeSegments(cumulativeSegments);
    const cumulativeUsage =
      cumulativeTruncated ||
      (cumulativeTotals.totalTokens === 0 &&
        cumulativeTotals.inputTokens === 0 &&
        cumulativeTotals.outputTokens === 0 &&
        cumulativeTotals.cacheReadTokens === 0)
        ? undefined
        : {
            ...cumulativeTotals,
            cacheCreationTokens: 0,
            turnCount: tokenCountTurns,
          };

    return {
      stats,
      revisionKey,
      logicalBytes,
      metaEntry,
      hasResponseItemUser,
      hasRollbackMarker,
      messageCount:
        responseMessageCount +
        (hasResponseItemUser ? 0 : eventUserMessageCount),
      eventUserMessageCount,
      responseMessageCount,
      responseQuestions,
      eventQuestions,
      responseQuestionsTruncated,
      eventQuestionsTruncated,
      responseTitle,
      eventTitle,
      model,
      firstTurnContext,
      latestTurnContext,
      latestVisibleEntryTimestamp,
      contextUsage,
      cumulativeUsage,
      compactCount,
      compactEvents: compactEvents.length > 0 ? compactEvents : undefined,
      compactionOffsets,
      responseUserTurns,
      eventUserTurns,
      patchApplyCallIds,
      directEditCallIds,
      responseImageGenerationIds,
      imageGenerationEndIds,
    };
  }

  private buildCodexBranchState(
    scan: CodexSummaryScan,
    sessionId: string,
    selectedBranchId?: string,
  ): CodexBranchState {
    const turns = scan.hasResponseItemUser
      ? scan.responseUserTurns
      : scan.eventUserTurns;
    const branches: CodexBranchOption[] = turns.map((turn, index) => ({
      id: `codex-branch-@${turn.offset}`,
      sessionId,
      parentId:
        index > 0 ? `codex-branch-@${turns[index - 1]?.offset ?? 0}` : null,
      prompt: turn.prompt,
      title: this.buildCodexBranchTitle(turn.prompt),
      depth: index + 1,
      index: index + 1,
      siblingIndex: 1,
      siblingCount: 1,
      isActive: true,
      createdAt: turn.timestamp,
    }));
    const activeBranchId = branches.at(-1)?.id ?? null;
    const selected =
      selectedBranchId &&
      branches.some((branch) => branch.id === selectedBranchId)
        ? selectedBranchId
        : activeBranchId;
    return {
      sessionId,
      activeBranchId,
      selectedBranchId: selected,
      branches,
    };
  }

  private buildCodexBranchTitle(prompt: string): string {
    const firstLine = prompt
      .split("\\n")
      .map((line) => line.trim())
      .find(Boolean);
    const text = firstLine ?? prompt.trim();
    return text.length <= 28 ? text : `${text.slice(0, 25)}...`;
  }

  private async scanCodexRolloutPage(
    filePath: string,
    summaryScan: CodexSummaryScan,
    options: GetSessionOptions,
    afterMessageId?: string,
  ): Promise<CodexPageScan> {
    return withCodexRolloutAdmission(filePath, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await stat(filePath);
        const revision = codexRolloutRevision(before);
        const result = await this.scanCodexRolloutPageOnce(
          filePath,
          summaryScan,
          options,
          afterMessageId,
          revision.key,
        );
        const after = await stat(filePath);
        const afterRevision = codexRolloutRevision(after);
        if (sameCodexRolloutRevision(revision, afterRevision)) {
          return { ...result, revisionKey: afterRevision.key };
        }
      }
      throw new Error("ROLLOUT_CHANGED_DURING_SCAN");
    });
  }

  private async scanCodexRolloutPageOnce(
    filePath: string,
    summaryScan: CodexSummaryScan,
    options: GetSessionOptions,
    afterMessageId: string | undefined,
    revisionKey: string,
  ): Promise<CodexPageScan> {
    const beforeOffset = codexCursorOffset(options.beforeMessageId);
    const aroundOffset = codexCursorOffset(options.aroundMessageId);
    const afterWindowOffset = codexCursorOffset(options.afterWindowMessageId);
    const incrementalOffset = codexCursorOffset(afterMessageId);
    const isAround = aroundOffset !== undefined;
    const isBefore = options.beforeMessageId !== undefined;
    const isAfterWindow = options.afterWindowMessageId !== undefined;
    const isIncremental = afterMessageId !== undefined;
    const maxMessages = Math.max(
      1,
      options.maxMessages ??
        (isIncremental ? 10_000 : CODEX_DEFAULT_PAGE_MESSAGES),
    );
    const aroundBeforeLimit = Math.floor((maxMessages - 1) / 2);
    const aroundAfterLimit = maxMessages - aroundBeforeLimit - 1;
    const tailStartOffset = codexTailStartOffset(
      summaryScan.compactionOffsets,
      options.tailCompactions,
      beforeOffset,
    );

    const branchState = this.buildCodexBranchState(
      summaryScan,
      "codex-session",
      options.branchId,
    );
    const turns = summaryScan.hasResponseItemUser
      ? summaryScan.responseUserTurns
      : summaryScan.eventUserTurns;
    const selectedBranch = branchState.selectedBranchId;
    const selectedBranchIndex = selectedBranch
      ? turns.findIndex(
          (turn) => `codex-branch-@${turn.offset}` === selectedBranch,
        )
      : -1;
    const visibleEndOffset =
      selectedBranchIndex >= 0
        ? (turns[selectedBranchIndex + 1]?.offset ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY;

    const compactedTimestamps: number[] = [];
    const prefixEntries: CodexSessionEntry[] = [];
    const selected: CodexEntryRecord[] = [];
    const beforeWindow: CodexEntryRecord[] = [];
    const afterWindow: CodexEntryRecord[] = [];
    const afterCursorWindow: CodexEntryRecord[] = [];
    let targetRecord: CodexEntryRecord | undefined;
    let selectedHead = 0;
    let selectedOutputCount = 0;
    let selectedBytes = 0;
    let beforeHead = 0;
    let beforeOutputCount = 0;
    let beforeBytes = 0;
    let afterOutputCount = 0;
    let afterBytes = 0;
    let afterCursorOutputCount = 0;
    let afterCursorBytes = 0;
    let droppedAfterCursor = false;
    let totalMessageCount = 0;
    let totalCompactions = 0;
    let droppedOlder = false;
    let droppedAroundOlder = false;
    let droppedNewer = false;
    let targetMessageFound = false;
    let hasMessagesBeforeTail = false;
    let targetEntrySeen = false;
    let outputAtOrAfterTarget = false;

    const dropSelectedHead = (): void => {
      while (
        selectedHead < selected.length &&
        selectedOutputCount > maxMessages
      ) {
        const record = selected[selectedHead];
        if (!record) break;
        selectedOutputCount -= record.outputCount;
        selectedBytes -= record.byteLength;
        selectedHead += 1;
        droppedOlder = true;
      }
      while (
        selectedHead < selected.length &&
        selected[selectedHead]?.outputCount === 0 &&
        selectedOutputCount === 0
      ) {
        const record = selected[selectedHead];
        if (!record) break;
        selectedBytes -= record.byteLength;
        selectedHead += 1;
      }
      if (selectedHead > 1024 && selectedHead * 2 > selected.length) {
        selected.splice(0, selectedHead);
        selectedHead = 0;
      }
    };

    const appendSelected = (record: CodexEntryRecord): void => {
      if (record.outputCount === 0 && selectedOutputCount === 0) return;
      selected.push(record);
      selectedOutputCount += record.outputCount;
      selectedBytes += record.byteLength;
      dropSelectedHead();
      if (selectedBytes > CODEX_MAX_PAGE_BYTES) {
        throw new CodexRolloutScanError(
          "scan_budget_exceeded",
          `Codex page exceeds ${CODEX_MAX_PAGE_BYTES} bytes`,
          record.offset,
        );
      }
    };

    const dropBeforeHead = (): void => {
      while (
        beforeHead < beforeWindow.length &&
        beforeOutputCount > aroundBeforeLimit
      ) {
        const record = beforeWindow[beforeHead];
        if (!record) break;
        beforeOutputCount -= record.outputCount;
        beforeBytes -= record.byteLength;
        beforeHead += 1;
        droppedAroundOlder = true;
      }
      while (
        beforeHead < beforeWindow.length &&
        beforeWindow[beforeHead]?.outputCount === 0 &&
        beforeOutputCount === 0
      ) {
        const record = beforeWindow[beforeHead];
        if (!record) break;
        beforeBytes -= record.byteLength;
        beforeHead += 1;
      }
      if (beforeHead > 1024 && beforeHead * 2 > beforeWindow.length) {
        beforeWindow.splice(0, beforeHead);
        beforeHead = 0;
      }
    };

    const appendBefore = (record: CodexEntryRecord): void => {
      if (record.outputCount === 0 && beforeOutputCount === 0) return;
      beforeWindow.push(record);
      beforeOutputCount += record.outputCount;
      beforeBytes += record.byteLength;
      dropBeforeHead();
      if (beforeBytes > CODEX_MAX_PAGE_BYTES) {
        throw new CodexRolloutScanError(
          "scan_budget_exceeded",
          `Codex page exceeds ${CODEX_MAX_PAGE_BYTES} bytes`,
          record.offset,
        );
      }
    };

    const appendAfter = (record: CodexEntryRecord): void => {
      if (record.outputCount === 0 && afterOutputCount === 0) return;
      afterWindow.push(record);
      afterOutputCount += record.outputCount;
      afterBytes += record.byteLength;
      while (afterOutputCount > aroundAfterLimit) {
        const dropped = afterWindow.pop();
        if (!dropped) break;
        afterOutputCount -= dropped.outputCount;
        afterBytes -= dropped.byteLength;
        droppedNewer = true;
      }
      if (afterBytes > CODEX_MAX_PAGE_BYTES) {
        throw new CodexRolloutScanError(
          "scan_budget_exceeded",
          `Codex page exceeds ${CODEX_MAX_PAGE_BYTES} bytes`,
          record.offset,
        );
      }
    };

    const appendAfterCursor = (record: CodexEntryRecord): void => {
      if (record.outputCount === 0 && afterCursorOutputCount === 0) return;
      afterCursorWindow.push(record);
      afterCursorOutputCount += record.outputCount;
      afterCursorBytes += record.byteLength;
      while (afterCursorOutputCount > maxMessages) {
        const dropped = afterCursorWindow.pop();
        if (!dropped) break;
        afterCursorOutputCount -= dropped.outputCount;
        afterCursorBytes -= dropped.byteLength;
        if (dropped.outputCount > 0) droppedAfterCursor = true;
      }
      if (afterCursorBytes > CODEX_MAX_PAGE_BYTES) {
        throw new CodexRolloutScanError(
          "scan_budget_exceeded",
          `Codex page exceeds ${CODEX_MAX_PAGE_BYTES} bytes`,
          record.offset,
        );
      }
    };

    for await (const line of iterateCodexRolloutLines(filePath, {
      maxLineBytes: CODEX_MAX_ROLLOUT_LINE_BYTES,
      maxBytes: CODEX_MAX_ROLLOUT_SCAN_BYTES,
    })) {
      if (!line.line) continue;
      const entry = parseCodexSessionEntry(line.line);
      if (!entry) continue;
      attachCodexEntryByteOffset(entry, line.offset);
      if (line.offset >= visibleEndOffset) break;
      if (
        (entry.type === "session_meta" || entry.type === "turn_context") &&
        prefixEntries.length < 2
      ) {
        prefixEntries.push(entry);
      }

      if (entry.type === "compacted") {
        const compactedMs = timestampToMs(entry.timestamp);
        if (compactedMs !== null) {
          compactedTimestamps.push(compactedMs);
          const cutoff = compactedMs - CODEX_COMPACTION_EVENT_DEDUPE_WINDOW_MS;
          while (
            compactedTimestamps.length > 0 &&
            (compactedTimestamps[0] ?? Number.POSITIVE_INFINITY) < cutoff
          ) {
            compactedTimestamps.shift();
          }
        }
        totalCompactions += 1;
      }
      const outputCount = codexEntryOutputCount(
        entry,
        summaryScan.hasResponseItemUser,
        compactedTimestamps,
        summaryScan,
      );
      if (
        entry.type === "event_msg" &&
        entry.payload.type === "context_compacted"
      ) {
        if (
          !hasNearbyCodexCompactedEntry(compactedTimestamps, entry.timestamp)
        ) {
          totalCompactions += 1;
        }
      }
      const record: CodexEntryRecord = {
        entry,
        offset: line.offset,
        byteLength: line.byteLength,
        outputCount,
      };
      totalMessageCount += outputCount;
      if (line.offset < tailStartOffset && outputCount > 0) {
        hasMessagesBeforeTail = true;
      }
      const eligibleForTail = line.offset >= tailStartOffset;

      if (
        (beforeOffset !== undefined && line.offset === beforeOffset) ||
        (aroundOffset !== undefined && line.offset === aroundOffset) ||
        (afterWindowOffset !== undefined &&
          line.offset === afterWindowOffset) ||
        (incrementalOffset !== undefined && line.offset === incrementalOffset)
      ) {
        targetEntrySeen = true;
        targetMessageFound = outputCount > 0;
        if (isAround && outputCount > 0) targetRecord = record;
      }

      if (isAround && aroundOffset !== undefined) {
        if (line.offset < aroundOffset) {
          if (eligibleForTail) appendBefore(record);
        } else if (line.offset === aroundOffset) {
          // Keep the cursor entry itself in the centered window.
          if (!targetRecord) targetRecord = record;
        } else if (targetEntrySeen) {
          appendAfter(record);
        }
        continue;
      }

      if (isBefore && beforeOffset !== undefined) {
        if (line.offset < beforeOffset) {
          if (eligibleForTail) appendSelected(record);
        } else if (line.offset === beforeOffset && outputCount > 0) {
          outputAtOrAfterTarget = true;
        } else if (line.offset > beforeOffset && outputCount > 0) {
          outputAtOrAfterTarget = true;
        }
        continue;
      }

      if (isAfterWindow && afterWindowOffset !== undefined) {
        if (line.offset > afterWindowOffset && targetEntrySeen) {
          appendAfterCursor(record);
        }
        continue;
      }

      if (isIncremental && incrementalOffset !== undefined) {
        if (line.offset > incrementalOffset && targetEntrySeen) {
          appendAfterCursor(record);
        }
        continue;
      }

      if (eligibleForTail) appendSelected(record);
    }

    const materialize = (records: CodexEntryRecord[], head: number) =>
      records.slice(head).map((record) => record.entry);

    let entries: CodexSessionEntry[];
    let hasOlderMessages = false;
    let hasNewerMessages = false;
    if (isAround) {
      const beforeEntries = materialize(beforeWindow, beforeHead);
      entries = [
        ...prefixEntries,
        ...beforeEntries,
        ...(targetRecord ? [targetRecord.entry] : []),
        ...afterWindow.map((record) => record.entry),
      ];
      hasOlderMessages = droppedAroundOlder;
      hasNewerMessages = droppedNewer;
    } else if (isAfterWindow || isIncremental) {
      entries = [
        ...prefixEntries,
        ...afterCursorWindow.map((record) => record.entry),
      ];
      hasOlderMessages = targetEntrySeen;
      hasNewerMessages = droppedAfterCursor;
    } else {
      entries = [...prefixEntries, ...materialize(selected, selectedHead)];
      hasOlderMessages = droppedOlder || hasMessagesBeforeTail;
      hasNewerMessages = isBefore
        ? targetEntrySeen && outputAtOrAfterTarget
        : droppedNewer;
    }

    if (
      (isBefore || isAround || isAfterWindow || isIncremental) &&
      !targetEntrySeen
    ) {
      targetMessageFound = false;
    }

    return {
      entries,
      totalMessageCount,
      totalCompactions:
        totalCompactions > 0 ? totalCompactions : summaryScan.compactCount,
      hasOlderMessages,
      hasNewerMessages,
      targetMessageFound,
      revisionKey,
    };
  }

  private buildSummaryFromScan(
    scan: CodexSummaryScan,
    sessionId: string,
    projectId: UrlProjectId,
  ): SessionSummary | null {
    const metaEntry = scan.metaEntry;
    if (!metaEntry) return null;
    if (scan.messageCount === 0) return null;

    const provider = this.determineProvider(metaEntry, scan.model);
    const runtimeConfig = scan.latestTurnContext
      ? {
          reasoningEffort:
            scan.latestTurnContext.payload.effort ??
            scan.latestTurnContext.payload.collaboration_mode?.settings
              ?.reasoning_effort ??
            undefined,
          serviceTier:
            scan.latestTurnContext.payload.service_tier ??
            scan.latestTurnContext.payload.serviceTier ??
            undefined,
        }
      : {};
    const turnContext = scan.firstTurnContext;
    const title = scan.responseTitle ?? scan.eventTitle;
    const cumulativeUsage = scan.cumulativeUsage
      ? {
          ...scan.cumulativeUsage,
          // Summary scans deliberately do not retain every token_count entry;
          // the count remains bounded and is still useful for the status card.
          turnCount: scan.cumulativeUsage.turnCount,
        }
      : undefined;

    return {
      id: sessionId,
      projectId,
      title: title?.title ?? null,
      fullTitle: title?.fullTitle ?? null,
      createdAt: metaEntry.payload.timestamp,
      updatedAt:
        scan.latestVisibleEntryTimestamp ?? scan.stats.mtime.toISOString(),
      messageCount: scan.messageCount,
      userQuestions:
        (scan.hasResponseItemUser
          ? scan.responseQuestions
          : scan.eventQuestions
        ).length > 0
          ? scan.hasResponseItemUser
            ? scan.responseQuestions
            : scan.eventQuestions
          : undefined,
      userQuestionCoverage: (
        scan.hasResponseItemUser
          ? scan.responseQuestionsTruncated
          : scan.eventQuestionsTruncated
      )
        ? "partial"
        : "complete",
      ownership: { owner: "none" },
      contextUsage: scan.contextUsage,
      cumulativeUsage,
      compactCount: scan.compactCount,
      compactEvents: scan.compactEvents,
      provider,
      ...(metaEntry.payload.forked_from_id
        ? { forkParentSessionId: metaEntry.payload.forked_from_id }
        : {}),
      model: scan.model,
      codexModelProvider: metaEntry.payload.model_provider ?? undefined,
      reasoningEffort: runtimeConfig.reasoningEffort,
      serviceTier: runtimeConfig.serviceTier,
      originator: metaEntry.payload.originator,
      cliVersion: metaEntry.payload.cli_version,
      source:
        typeof metaEntry.payload.source === "string"
          ? metaEntry.payload.source
          : undefined,
      approvalPolicy: turnContext?.payload.approval_policy,
      sandboxPolicy: turnContext?.payload.sandbox_policy
        ? {
            type: turnContext.payload.sandbox_policy.type,
            networkAccess: turnContext.payload.sandbox_policy.network_access,
            excludeTmpdirEnvVar:
              turnContext.payload.sandbox_policy.exclude_tmpdir_env_var,
            excludeSlashTmp:
              turnContext.payload.sandbox_policy.exclude_slash_tmp,
          }
        : undefined,
    };
  }

  /**
   * Locate, read and parse a Codex session file exactly once.
   *
   * Returns the parsed entries with the file stats so callers derive both the
   * summary and the branch projection without re-reading (readJsonlLines) and
   * re-parsing the whole rollout file. Returns null when the file is missing or
   * has no parseable entries.
   */
  private async loadSessionEntries(sessionId: string): Promise<{
    stats: Stats;
    entries: readonly CodexSessionEntry[];
  } | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const { entries, stats } = await readSharedCodexEntries(
        sessionFile.filePath,
      );
      // An empty or unparseable rollout yields no entries; both cases are "not a
      // readable session" for every caller here.
      if (entries.length === 0) return null;
      return { stats, entries };
    } catch {
      return null;
    }
  }

  /**
   * Derive a session summary from already-parsed Codex entries.
   *
   * Pure with respect to I/O — the file has already been read and stat'd by
   * {@link loadSessionEntries}. Returns null for files without session_meta or
   * with no conversation messages.
   */
  private buildSummaryFromEntries(
    entries: readonly CodexSessionEntry[],
    stats: Stats,
    sessionId: string,
    projectId: UrlProjectId,
  ): SessionSummary | null {
    try {
      const branchView = buildCodexBranchView(entries, sessionId);
      const visibleEntries = branchView.entries;

      // Extract session metadata from first entry
      const metaEntry = entries.find((e) => e.type === "session_meta") as
        | CodexSessionMetaEntry
        | undefined;
      if (!metaEntry) return null;

      const extractedTitle = this.extractTitle(visibleEntries);
      const { title, fullTitle } =
        extractedTitle.title === null
          ? this.extractTitleFromBranchFallback(branchView.branchState.branches)
          : extractedTitle;
      const userQuestions = this.extractUserQuestions(visibleEntries);
      const messageCount = this.countMessages(visibleEntries);
      const model = this.extractModel(visibleEntries);
      const provider = this.determineProvider(metaEntry, model);
      const turnContext = this.extractTurnContext(visibleEntries);
      const runtimeConfig = this.extractRuntimeConfig(visibleEntries);
      const contextUsage = this.extractContextUsage(
        visibleEntries,
        model,
        provider,
      );
      const cumulativeUsage = this.extractCumulativeTokenUsage(visibleEntries);
      const compactCount = this.countCompactions(visibleEntries);
      const compactEvents = this.extractCompactEvents(visibleEntries);

      // Skip sessions with no actual conversation messages
      if (messageCount === 0) return null;

      return {
        id: sessionId,
        projectId,
        title,
        fullTitle,
        createdAt: metaEntry.payload.timestamp,
        updatedAt:
          latestVisibleEntryTimestamp(visibleEntries) ??
          stats.mtime.toISOString(),
        messageCount,
        userQuestions,
        userQuestionCoverage: "complete",
        ownership: { owner: "none" },
        contextUsage,
        cumulativeUsage,
        compactCount,
        compactEvents,
        provider,
        ...(metaEntry.payload.forked_from_id
          ? { forkParentSessionId: metaEntry.payload.forked_from_id }
          : {}),
        model,
        codexModelProvider: metaEntry.payload.model_provider ?? undefined,
        reasoningEffort: runtimeConfig.reasoningEffort,
        serviceTier: runtimeConfig.serviceTier,
        originator: metaEntry.payload.originator,
        cliVersion: metaEntry.payload.cli_version,
        source:
          typeof metaEntry.payload.source === "string"
            ? metaEntry.payload.source
            : undefined,
        approvalPolicy: turnContext?.payload.approval_policy,
        sandboxPolicy: turnContext?.payload.sandbox_policy
          ? {
              type: turnContext.payload.sandbox_policy.type,
              networkAccess: turnContext.payload.sandbox_policy.network_access,
              excludeTmpdirEnvVar:
                turnContext.payload.sandbox_policy.exclude_tmpdir_env_var,
              excludeSlashTmp:
                turnContext.payload.sandbox_policy.exclude_slash_tmp,
            }
          : undefined,
      };
    } catch {
      return null;
    }
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    options: GetSessionOptions = {},
  ): Promise<LoadedSession | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    const summaryScanStartedAt = performance.now();
    const scan = await this.scanCodexRolloutSummary(sessionFile.filePath);
    const summaryScanMs = performance.now() - summaryScanStartedAt;
    if (!scan.metaEntry) return null;

    if (
      options.rolloutRevision &&
      options.rolloutRevision !== scan.revisionKey
    ) {
      throw new Error("ROLLOUT_CURSOR_STALE");
    }

    // Rollback markers need a complete turn tree. Until the bounded rollback
    // index is available, keep the reference implementation for small files
    // and fail closed for large ones rather than returning a plausible but
    // wrong branch transcript.
    if (
      scan.hasRollbackMarker ||
      hasLegacyCodexCursor(afterMessageId) ||
      hasLegacyCodexCursor(options.beforeMessageId) ||
      hasLegacyCodexCursor(options.aroundMessageId) ||
      hasLegacyCodexCursor(options.afterWindowMessageId) ||
      hasLegacyCodexCursor(options.branchId)
    ) {
      if (scan.logicalBytes > CODEX_ROLLBACK_FULL_READ_MAX_BYTES) {
        throw new CodexHistoryUnavailableError();
      }
      const pageReadStartedAt = performance.now();
      const loaded = await this.loadSessionEntries(sessionId);
      const pageReadMs = performance.now() - pageReadStartedAt;
      if (
        options.rolloutRevision &&
        codexRolloutRevision(loaded?.stats ?? scan.stats).key !==
          options.rolloutRevision
      ) {
        throw new Error("ROLLOUT_CURSOR_STALE");
      }
      if (!loaded) return null;
      const summary = this.buildSummaryFromEntries(
        loaded.entries,
        loaded.stats,
        sessionId,
        projectId,
      );
      if (!summary) return null;
      const branchView = buildCodexBranchView(
        loaded.entries,
        sessionId,
        options.branchId,
      );
      return {
        summary,
        data: {
          provider: this.determineProviderFromEntries(loaded.entries),
          session: { entries: branchView.entries },
        },
        branchState: branchView.branchState,
        codexBranchState: branchView.branchState,
        codexRolloutBytes: scan.stats.size,
        historySource: "codex-rollout",
        historyReadTimings: { summaryScanMs, pageReadMs },
      };
    }

    const summary = this.buildSummaryFromScan(scan, sessionId, projectId);
    if (!summary) return null;
    const codexProvider = this.determineProvider(scan.metaEntry, scan.model);

    const pageReadStartedAt = performance.now();
    const page = await this.scanCodexRolloutPage(
      sessionFile.filePath,
      scan,
      options,
      afterMessageId,
    );
    const pageReadMs = performance.now() - pageReadStartedAt;
    if (page.revisionKey !== scan.revisionKey) {
      throw new Error("ROLLOUT_CHANGED_DURING_SCAN");
    }
    if (
      options.rolloutRevision &&
      options.rolloutRevision !== page.revisionKey
    ) {
      throw new Error("ROLLOUT_CURSOR_STALE");
    }

    const branchState = this.buildCodexBranchState(
      scan,
      sessionId,
      options.branchId,
    );
    const normalizeStartedAt = performance.now();
    const projectedMessages = convertCodexEntries(
      page.entries,
      sessionId,
      branchState,
      {
        model: summary.model,
        provider: codexProvider,
        workspaceRoot: scan.metaEntry.payload.cwd,
        hasResponseItemUser: scan.hasResponseItemUser,
        patchApplyCallIds: scan.patchApplyCallIds,
        directEditCallIds: scan.directEditCallIds,
        responseImageGenerationIds: scan.responseImageGenerationIds,
        imageGenerationEndIds: scan.imageGenerationEndIds,
      },
    );
    const normalizeMs = performance.now() - normalizeStartedAt;
    const pagination = this.buildCodexPagination(
      page,
      projectedMessages,
      options,
      afterMessageId,
    );

    return {
      summary,
      data: {
        provider: codexProvider,
        session: { entries: page.entries },
      },
      branchState,
      codexBranchState: branchState,
      projectedMessages,
      pagination,
      paginationApplied: true,
      codexRolloutBytes: scan.stats.size,
      historySource: "codex-rollout",
      historyReadTimings: { summaryScanMs, pageReadMs, normalizeMs },
    };
  }

  private buildCodexPagination(
    page: CodexPageScan,
    messages: Message[],
    options: GetSessionOptions,
    afterMessageId?: string,
  ): PaginationInfo {
    const firstId = getNormalizedMessageId(messages[0]);
    const lastId = getNormalizedMessageId(messages.at(-1));
    const around = options.aroundMessageId;
    const targetFound = around
      ? messages.some((message) => getNormalizedMessageId(message) === around)
      : undefined;

    return {
      hasOlderMessages: page.hasOlderMessages,
      ...(page.hasNewerMessages
        ? { hasNewerMessages: true }
        : { hasNewerMessages: false }),
      totalMessageCount: page.totalMessageCount,
      returnedMessageCount: messages.length,
      ...(page.hasOlderMessages && firstId
        ? { truncatedBeforeMessageId: firstId }
        : {}),
      ...(page.hasNewerMessages && lastId
        ? { truncatedAfterMessageId: lastId }
        : {}),
      totalCompactions: page.totalCompactions,
      ...(around
        ? { targetMessageId: around, targetMessageFound: targetFound }
        : {}),
      ...(page.revisionKey ? { rolloutRevision: page.revisionKey } : {}),
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const stats = await stat(sessionFile.filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // If mtime and size match cached values, return null (no change)
      if (mtime === cachedMtime && size === cachedSize) {
        return null;
      }

      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null;
    }
  }

  /**
   * Return sub-agent sessions for the given parent session id.
   *
   * Codex sub-agents are independent threads with their own rollout files,
   * linked to the parent via `session_meta.parent_thread_id` /
   * `source.subagent.thread_spawn.parent_thread_id`. The manifest indexes
   * these as `byParentThread`. The parent rollout's persisted
   * paginated `item_completed` SpawnAgent item supplies the real spawning call
   * id; children without that durable linkage are omitted rather than assigned
   * a fake id. A sub-agent can itself be the parent of nested children.
   */
  async getAgentMappings(sessionId?: string): Promise<AgentMapping[]> {
    if (!sessionId) return [];
    const manifest = await getCodexSessionManifest(this.sessionsDir);
    const parent = manifest.byId.get(sessionId);
    if (!parent || !this.isManifestEntryInScope(parent)) return [];
    const parentProjectPath = canonicalizeProjectPath(parent.cwd);
    const children = (manifest.byParentThread.get(sessionId) ?? []).filter(
      (child) =>
        child.isSubagent &&
        child.parentThreadId === sessionId &&
        this.isManifestEntryInScope(child) &&
        canonicalizeProjectPath(child.cwd) === parentProjectPath,
    );
    if (children.length === 0) return [];

    try {
      const spawnMappings = await scanCodexSpawnMapping(parent.filePath);
      return children.flatMap((child) => {
        const toolUseId = spawnMappings.get(child.id);
        if (!toolUseId) return [];
        return [
          {
            toolUseId,
            agentId: child.id,
            ...(child.agentRole ? { agentType: child.agentRole } : {}),
          },
        ];
      });
    } catch {
      return [];
    }
  }

  /**
   * Load a sub-agent session transcript by its thread id.
   *
   * Reads the child thread's rollout JSONL and normalizes it into the same
   * `AgentSession` shape used by other providers, so the client can render
   * the sub-agent transcript through the shared agent-tree UI.
   */
  async getAgentSession(
    agentId: string,
    sessionId?: string,
  ): Promise<{
    messages: Message[];
    status: AgentStatus;
    agentType?: string;
    descriptor?: SubagentDescriptor;
  } | null> {
    if (!sessionId) return null;
    const manifest = await getCodexSessionManifest(this.sessionsDir);
    const parent = manifest.byId.get(sessionId);
    if (!parent || !this.isManifestEntryInScope(parent)) return null;
    const parentProjectPath = canonicalizeProjectPath(parent.cwd);
    const entry = manifest.byParentThread
      .get(sessionId)
      ?.find(
        (candidate) =>
          candidate.id === agentId &&
          candidate.isSubagent &&
          candidate.parentThreadId === sessionId &&
          this.isManifestEntryInScope(candidate) &&
          canonicalizeProjectPath(candidate.cwd) === parentProjectPath,
      );
    if (!entry) return null;

    try {
      const childScan = await this.scanCodexRolloutSummary(entry.filePath);
      if (childScan.logicalBytes > CODEX_ROLLBACK_FULL_READ_MAX_BYTES) {
        return null;
      }
      const entries = await readCodexEntries(entry.filePath);
      const messages = convertCodexEntries(entries, agentId);
      const lifecycle = deriveCodexSubagentStatus(entries);
      const parentToolUseId = (await this.getAgentMappings(sessionId)).find(
        (mapping) => mapping.agentId === agentId,
      )?.toolUseId;
      const descriptor: SubagentDescriptor = {
        agentId,
        parentAgentId: sessionId,
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(entry.agentRole ? { type: entry.agentRole } : {}),
        ...(entry.agentPath || entry.agentNickname
          ? { description: entry.agentPath ?? entry.agentNickname }
          : {}),
        status: lifecycle.descriptorStatus,
      };
      return {
        messages,
        status: lifecycle.status,
        ...(entry.agentRole ? { agentType: entry.agentRole } : {}),
        descriptor,
      };
    } catch {
      return null;
    }
  }

  private isManifestEntryInScope(entry: CodexSessionManifestEntry): boolean {
    return (
      this.projectPath === undefined ||
      canonicalizeProjectPath(entry.cwd) === this.projectPath
    );
  }

  /**
   * Scan the sessions directory and find all session files.
   */
  private async scanSessions(): Promise<CodexSessionFile[]> {
    const now = Date.now();
    if (now - this.cacheTimestamp < CODEX_SESSION_FILE_CACHE_TTL_MS) {
      return Array.from(this.sessionFileCache.values());
    }

    const manifest = await getCodexSessionManifest(this.sessionsDir);
    const sessions = this.getManifestSessionsForScope(manifest).filter(
      (session) => !session.isSubagent,
    );
    this.replaceSessionFileCache(sessions);
    return sessions;
  }

  private replaceSessionFileCache(sessions: CodexSessionFile[]): void {
    this.sessionFileCache.clear();
    for (const session of sessions) {
      this.sessionFileCache.set(session.id, session);
    }
    this.cacheTimestamp = Date.now();
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    return sessionFile?.filePath ?? null;
  }

  getIndexScopeKey(sessionDir: string): string {
    return `codex::${sessionDir}::${this.projectPath ?? "*"}`;
  }

  async listSessionFiles(_sessionDir: string): Promise<SessionFileEntry[]> {
    const sessions = await this.scanSessions();

    return sessions.map((session) => ({
      sessionId: session.id,
      filePath: session.filePath,
      mtime: session.mtime,
      size: session.size,
    }));
  }

  /**
   * Find a session file by ID.
   */
  private async findSessionFile(
    sessionId: string,
  ): Promise<CodexSessionFile | null> {
    // Check cache first
    const cached = this.sessionFileCache.get(sessionId);
    if (cached) return cached;

    const manifest = await getCodexSessionManifest(this.sessionsDir);
    const session = manifest.byId.get(sessionId);
    if (!session || session.isSubagent) return null;

    if (
      this.projectPath &&
      canonicalizeProjectPath(session.cwd) !== this.projectPath
    ) {
      return null;
    }

    this.sessionFileCache.set(session.id, session);
    return session;
  }

  private getManifestSessionsForScope(
    manifest: CodexSessionManifest,
  ): CodexSessionFile[] {
    if (!this.projectPath) {
      return manifest.sessions;
    }
    return manifest.byProjectPath.get(this.projectPath) ?? [];
  }

  /**
   * Extract title from entries (first user message).
   */
  private extractTitle(entries: CodexSessionEntry[]): {
    title: string | null;
    fullTitle: string | null;
  } {
    const hasResponseItemUser = this.hasResponseItemUserMessages(entries);
    const skipLeadingSystemPrompts = true;

    // Find first user message
    for (const entry of entries) {
      if (
        !hasResponseItemUser &&
        entry.type === "event_msg" &&
        entry.payload.type === "user_message"
      ) {
        const fullTitle = sanitizeCodexPublicUserPrompt(
          entry.payload.message,
        ).trim();
        if (skipLeadingSystemPrompts && isSyntheticUserPromptText(fullTitle)) {
          continue;
        }
        const title = this.buildTitleFromText(fullTitle);
        if (title) return title;
      }

      if (entry.type === "response_item") {
        const payload = entry.payload;
        if (payload.type === "message" && payload.role === "user") {
          const text = this.extractCodexUserMessageText(payload.content).trim();
          if (
            text &&
            !(skipLeadingSystemPrompts && isSyntheticUserPromptText(text))
          ) {
            const title = this.buildTitleFromText(text);
            if (title) return title;
          }
        }
      }
    }

    return { title: null, fullTitle: null };
  }

  private extractTitleFromBranchFallback(
    branches: Array<{ prompt?: string | null }>,
  ): { title: string | null; fullTitle: string | null } {
    for (let index = branches.length - 1; index >= 0; index--) {
      const prompt = branches[index]?.prompt;
      if (typeof prompt !== "string") continue;
      const publicPrompt = sanitizeCodexPublicUserPrompt(prompt);
      if (isSyntheticUserPromptText(publicPrompt)) continue;

      const title = this.buildTitleFromText(publicPrompt);
      if (title) return title;
    }

    return { title: null, fullTitle: null };
  }

  private buildTitleFromText(
    text: string,
  ): { title: string; fullTitle: string } | null {
    const fullTitle = sanitizeCodexPublicUserPrompt(text).trim();
    if (!fullTitle) return null;

    const title =
      fullTitle.length <= SESSION_TITLE_MAX_LENGTH
        ? fullTitle
        : `${fullTitle.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
    return { title, fullTitle };
  }

  private extractUserQuestions(
    entries: CodexSessionEntry[],
  ): SessionQuestion[] {
    const questions: SessionQuestion[] = [];
    const hasResponseItemUser = this.hasResponseItemUserMessages(entries);
    const responseUserClientIds = collectCodexResponseUserClientIds(entries);
    const compactedTimestamps = entries
      .filter((entry) => entry.type === "compacted")
      .map((entry) => timestampToMs(entry.timestamp))
      .filter((timestamp): timestamp is number => timestamp !== null);
    let messageIndex = 0;

    for (const entry of entries) {
      if (entry.type === "response_item") {
        const currentIndex = messageIndex;
        messageIndex += 1;

        const payload = entry.payload;
        if (payload.type === "message" && payload.role === "user") {
          // Question ids intentionally mirror the message uuid so the inspector
          // can jump to the message; they must use the same anchor scheme.
          const anchor = codexEntryAnchor(
            entry,
            `${currentIndex}-${entry.timestamp}`,
          );
          const question = createSessionQuestion(
            {
              id: `codex-${anchor}`,
              ...codexQuestionTurnId(payload),
              ...codexUserMessageIdentity(responseUserClientIds.get(entry)),
              text: this.extractCodexUserMessageText(payload.content),
              timestamp: entry.timestamp,
            },
            `codex-user-${anchor}`,
          );
          if (question) {
            questions.push(question);
          }
        }
        continue;
      }

      if (entry.type === "compacted") {
        messageIndex += 1;
        continue;
      }

      if (entry.type !== "event_msg") {
        continue;
      }

      if (entry.payload.type === "user_message" && !hasResponseItemUser) {
        const anchor = codexEntryAnchor(
          entry,
          `${messageIndex}-${entry.timestamp}`,
        );
        const question = createSessionQuestion(
          {
            id: `codex-event-${anchor}`,
            ...codexUserMessageIdentity(entry.payload.client_id),
            text: [
              sanitizeCodexPublicUserPrompt(entry.payload.message),
              ...(entry.payload.images?.length ? ["[image]"] : []),
            ].join("\n"),
            timestamp: entry.timestamp,
          },
          `codex-event-user-${anchor}`,
        );
        messageIndex += 1;
        if (question) {
          questions.push(question);
        }
        continue;
      }

      if (entry.payload.type === "turn_aborted") {
        messageIndex += 1;
      }

      if (
        entry.payload.type === "context_compacted" &&
        !hasNearbyCodexCompactedEntry(compactedTimestamps, entry.timestamp)
      ) {
        messageIndex += 1;
      }
    }

    return questions;
  }

  private extractCodexUserMessageText(
    content: CodexMessagePayload["content"],
  ): string {
    return sanitizeCodexPublicUserPrompt(
      content
        .map((block) => {
          if (block.type === "input_text") {
            return sanitizeCodexUserContentBlockText(block.text);
          }
          if (block.type === "input_image") {
            return "[image]";
          }
          if (block.type === "input_audio") {
            return "[audio]";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n"),
    );
  }

  /**
   * Count user/assistant messages in entries.
   *
   * Matches the logic in convertEntriesToMessages - we count user_message
   * events and response_item messages, but not agent_message events since
   * those are streaming duplicates.
   */
  private countMessages(entries: CodexSessionEntry[]): number {
    let count = 0;
    const hasResponseItemUser = this.hasResponseItemUserMessages(entries);

    for (const entry of entries) {
      if (entry.type === "event_msg") {
        // Only count user_message events (not agent_message streaming tokens)
        if (entry.payload.type === "user_message" && !hasResponseItemUser) {
          count++;
        }
      } else if (entry.type === "response_item") {
        if (entry.payload.type === "message") {
          if (
            entry.payload.role === "user" ||
            entry.payload.role === "assistant"
          ) {
            count++;
          }
        }
      }
    }

    return count;
  }

  /**
   * Extract context usage from token_count events.
   *
   * @param entries - Codex session entries
   * @param model - Model ID for determining context window size (fallback)
   * @param provider - Provider for model-less context-window fallback
   */
  private extractContextUsage(
    entries: CodexSessionEntry[],
    model: string | undefined,
    provider: "codex" | "codex-oss",
  ): ContextUsage | undefined {
    // Find last token_count event
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry &&
        entry.type === "event_msg" &&
        entry.payload.type === "token_count"
      ) {
        const info = entry.payload.info;
        if (info?.last_token_usage || info?.total_token_usage) {
          // Codex context meter is based on the latest turn's input_tokens,
          // not cumulative totals and not cached-input totals.
          const usage = info.last_token_usage ?? info.total_token_usage;
          if (!usage) continue;
          let inputTokens = usage.input_tokens;

          // After /compact, Codex writes a token_count with input_tokens=0 and
          // total_tokens set to the compacted summary size. Treat that as the
          // current context fill instead of falling through to pre-compaction
          // token_count values.
          if (
            inputTokens === 0 &&
            usage.total_tokens > 0 &&
            this.isTokenCountImmediatelyAfterCompaction(entries, i)
          ) {
            inputTokens = usage.total_tokens;
          }

          if (inputTokens === 0) continue;

          // Prefer model_context_window from Codex if available, fall back to model-based lookup
          const contextWindow =
            info.model_context_window && info.model_context_window > 0
              ? info.model_context_window
              : getModelContextWindow(model, provider);
          const percentage = Math.min(
            100,
            Math.round((inputTokens / contextWindow) * 100),
          );

          return { inputTokens, percentage, contextWindow };
        }
      }
    }

    return undefined;
  }

  private isTokenCountImmediatelyAfterCompaction(
    entries: CodexSessionEntry[],
    tokenCountIndex: number,
  ): boolean {
    for (let i = tokenCountIndex - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry) continue;
      if (entry.type === "compacted") return true;
      if (entry.type === "event_msg" && entry.payload.type === "token_count") {
        return false;
      }
    }

    return false;
  }

  private extractCumulativeTokenUsage(
    entries: CodexSessionEntry[],
  ): ContextCumulativeUsage | undefined {
    type SegmentUsage = NonNullable<
      NonNullable<
        Extract<CodexEventMsgEntry["payload"], { type: "token_count" }>["info"]
      >["total_token_usage"]
    >;

    const compactedTimestamps = this.getCompactedTimestamps(entries);
    const segments: SegmentUsage[] = [];
    let currentSegment: SegmentUsage | null = null;

    for (const entry of entries) {
      if (this.isLogicalCompactionBoundary(entry, compactedTimestamps)) {
        if (currentSegment) {
          segments.push(currentSegment);
          currentSegment = null;
        }
        continue;
      }

      if (entry.type === "event_msg" && entry.payload.type === "token_count") {
        currentSegment =
          entry.payload.info?.total_token_usage ?? currentSegment;
      }
    }

    if (currentSegment) {
      segments.push(currentSegment);
    }

    if (segments.length === 0) return undefined;

    const totals = this.sumCodexCumulativeSegments(segments);

    if (
      totals.totalTokens === 0 &&
      totals.inputTokens === 0 &&
      totals.outputTokens === 0 &&
      totals.cacheReadTokens === 0
    ) {
      return undefined;
    }

    return {
      ...totals,
      cacheCreationTokens: 0,
      turnCount: this.countTokenUsageTurns(entries),
    };
  }

  private countTokenUsageTurns(entries: CodexSessionEntry[]): number {
    return entries.reduce((count, entry) => {
      if (entry.type !== "event_msg" || entry.payload.type !== "token_count") {
        return count;
      }
      return entry.payload.info?.last_token_usage ? count + 1 : count;
    }, 0);
  }

  private sumCodexCumulativeSegments(
    segments: Array<{
      total_tokens: number;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens?: number;
    }>,
  ): {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  } {
    const addUsage = (
      acc: {
        totalTokens: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
      },
      usage: {
        total_tokens: number;
        input_tokens: number;
        output_tokens: number;
        cached_input_tokens?: number;
      },
    ) => {
      const cachedInputTokens = usage.cached_input_tokens ?? 0;
      acc.totalTokens += usage.total_tokens;
      acc.inputTokens += Math.max(0, usage.input_tokens - cachedInputTokens);
      acc.outputTokens += usage.output_tokens;
      acc.cacheReadTokens += cachedInputTokens;
    };

    const totals = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    };
    let current = segments[0];
    if (!current) return totals;

    for (const next of segments.slice(1)) {
      if (next.total_tokens < current.total_tokens) {
        addUsage(totals, current);
      }
      current = next;
    }

    addUsage(totals, current);
    return totals;
  }

  private getCompactedTimestamps(entries: CodexSessionEntry[]): number[] {
    return entries
      .filter((entry) => entry.type === "compacted")
      .map((entry) => timestampToMs(entry.timestamp))
      .filter((timestamp): timestamp is number => timestamp !== null);
  }

  private countCompactions(entries: CodexSessionEntry[]): number {
    const compactedTimestamps = this.getCompactedTimestamps(entries);
    let count = compactedTimestamps.length;

    for (const entry of entries) {
      if (
        entry.type === "event_msg" &&
        entry.payload.type === "context_compacted" &&
        !hasNearbyCodexCompactedEntry(compactedTimestamps, entry.timestamp)
      ) {
        count += 1;
      }
    }

    return count;
  }

  private extractCompactEvents(
    entries: CodexSessionEntry[],
  ): ContextCompactEvent[] | undefined {
    const compactedTimestamps = this.getCompactedTimestamps(entries);
    const events: ContextCompactEvent[] = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (
        !entry ||
        !this.isLogicalCompactionBoundary(entry, compactedTimestamps)
      ) {
        continue;
      }

      const beforeTokens = this.findCodexContextTokens(entries, index - 1, -1);
      const afterTokens = this.findCodexContextTokens(entries, index + 1, 1);
      const event: ContextCompactEvent = {};

      if ("timestamp" in entry && typeof entry.timestamp === "string") {
        event.timestamp = entry.timestamp;
      }
      event.trigger =
        entry.type === "compacted" ? "compacted" : "context_compacted";
      if (beforeTokens !== undefined) {
        event.beforeTokens = beforeTokens;
      }
      if (afterTokens !== undefined) {
        event.afterTokens = afterTokens;
      }
      if (beforeTokens !== undefined && afterTokens !== undefined) {
        const reclaimedTokens = beforeTokens - afterTokens;
        if (reclaimedTokens > 0) {
          event.reclaimedTokens = reclaimedTokens;
        }
      }

      events.push(event);
    }

    return events.length > 0 ? events : undefined;
  }

  private findCodexContextTokens(
    entries: CodexSessionEntry[],
    startIndex: number,
    direction: -1 | 1,
  ): number | undefined {
    for (
      let index = startIndex;
      index >= 0 && index < entries.length;
      index += direction
    ) {
      const tokens = this.getCodexContextTokensAt(entries, index);
      if (tokens !== undefined) return tokens;
    }

    return undefined;
  }

  private getCodexContextTokensAt(
    entries: CodexSessionEntry[],
    index: number,
  ): number | undefined {
    const entry = entries[index];
    if (
      !entry ||
      entry.type !== "event_msg" ||
      entry.payload.type !== "token_count"
    ) {
      return undefined;
    }

    const info = entry.payload.info;
    const usage = info?.last_token_usage ?? info?.total_token_usage;
    if (!usage) return undefined;

    let inputTokens = usage.input_tokens;
    if (
      inputTokens === 0 &&
      usage.total_tokens > 0 &&
      this.isTokenCountImmediatelyAfterCompaction(entries, index)
    ) {
      inputTokens = usage.total_tokens;
    }

    return inputTokens > 0 ? inputTokens : undefined;
  }

  private isLogicalCompactionBoundary(
    entry: CodexSessionEntry,
    compactedTimestamps: number[],
  ): boolean {
    if (entry.type === "compacted") return true;
    return (
      entry.type === "event_msg" &&
      entry.payload.type === "context_compacted" &&
      !hasNearbyCodexCompactedEntry(compactedTimestamps, entry.timestamp)
    );
  }

  /**
   * Extract the model from turn_context entries.
   */
  private extractModel(
    entries: readonly CodexSessionEntry[],
  ): string | undefined {
    // Find first turn_context entry with a model
    for (const entry of entries) {
      if (entry.type === "turn_context" && entry.payload.model) {
        return entry.payload.model;
      }
    }
    return undefined;
  }

  /**
   * Extract the first turn_context entry, which captures session launch policy.
   */
  private extractTurnContext(
    entries: CodexSessionEntry[],
  ): CodexTurnContextEntry | undefined {
    for (const entry of entries) {
      if (entry.type === "turn_context") {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Extract provider runtime settings from the latest turn_context entry.
   */
  private extractRuntimeConfig(entries: CodexSessionEntry[]): {
    reasoningEffort?: string;
    serviceTier?: string;
  } {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry || entry.type !== "turn_context") continue;

      const payload = entry.payload;
      const reasoningEffort =
        payload.effort ??
        payload.collaboration_mode?.settings?.reasoning_effort ??
        undefined;
      const serviceTier = payload.service_tier ?? payload.serviceTier;

      return {
        reasoningEffort: reasoningEffort ?? undefined,
        serviceTier: serviceTier ?? undefined,
      };
    }

    return {};
  }

  /**
   * Determine provider based on session metadata or model.
   */
  private determineProvider(
    metaEntry: CodexSessionMetaEntry,
    model?: string,
  ): "codex" | "codex-oss" {
    // An explicit model_provider is the authoritative signal. Only known LOCAL
    // provider ids map to codex-oss; any other explicit provider (including
    // cloud custom providers like "deepseek") is a cloud Codex source. A model
    // brand name (e.g. "deepseek") must never override an explicit cloud
    // provider — see docs/project/2026-07-31-codex-model-source-selection.md.
    if (metaEntry.payload.model_provider) {
      const provider = metaEntry.payload.model_provider.toLowerCase();
      return LOCAL_CODEX_MODEL_PROVIDERS.has(provider) ? "codex-oss" : "codex";
    }

    // Fallback only when model_provider is absent: limited legacy model-name
    // heuristic for older local sessions that predate the provider field.
    if (model) {
      const lowerModel = model.toLowerCase();
      if (lowerModel.startsWith("gpt-") || lowerModel.startsWith("o1-")) {
        return "codex";
      }
      if (
        lowerModel.includes("llama") ||
        lowerModel.includes("mistral") ||
        lowerModel.includes("qwen") ||
        lowerModel.includes("gemma") ||
        lowerModel.includes("phi")
      ) {
        return "codex-oss";
      }
    }

    // Default to codex if we can't be sure
    return "codex";
  }

  /**
   * Helper to determine provider from a list of entries.
   */
  private determineProviderFromEntries(
    entries: readonly CodexSessionEntry[],
  ): "codex" | "codex-oss" {
    const metaEntry = entries.find((e) => e.type === "session_meta") as
      | CodexSessionMetaEntry
      | undefined;

    if (!metaEntry) return "codex";

    const model = this.extractModel(entries);
    return this.determineProvider(metaEntry, model);
  }

  private hasResponseItemUserMessages(entries: CodexSessionEntry[]): boolean {
    return entries.some(
      (entry) =>
        entry.type === "response_item" &&
        entry.payload.type === "message" &&
        entry.payload.role === "user",
    );
  }
}
