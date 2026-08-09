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
  type UnifiedSession,
  type UrlProjectId,
  getModelContextWindow,
  parseCodexSessionEntry,
} from "@yep-anywhere/shared";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type {
  ContentBlock,
  ContextUsage,
  Message,
  Session,
  SessionSummary,
} from "../supervisor/types.js";
import { readJsonlLines } from "../utils/jsonl.js";
import { buildCodexBranchView } from "./codex-rollback.js";
import {
  type CodexSessionManifest,
  type CodexSessionManifestEntry,
  getCodexSessionManifest,
  invalidateCodexSessionManifest,
} from "./codex-session-manifest.js";
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
import { isSyntheticUserPromptText } from "./user-prompt-classification.js";
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
    const loaded = await this.loadSessionEntries(sessionId);
    if (!loaded) return null;
    return this.buildSummaryFromEntries(
      loaded.entries,
      loaded.stats,
      sessionId,
      projectId,
    );
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
    entries: CodexSessionEntry[];
  } | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const lines = await readJsonlLines(sessionFile.filePath);
      if (lines.length === 0 || (lines.length === 1 && !lines[0])) return null;

      const entries: CodexSessionEntry[] = [];
      for (const line of lines) {
        const entry = parseCodexSessionEntry(line);
        if (entry) {
          entries.push(entry);
        }
      }
      if (entries.length === 0) return null;

      const stats = await stat(sessionFile.filePath);
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
    entries: CodexSessionEntry[],
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
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    // Read + parse the rollout file exactly once, then derive both the summary
    // and the branch projection from the same entries. Previously this called
    // getSessionSummary() (which read + parsed via readJsonlLines) and then
    // re-read + re-parsed the whole file for buildCodexBranchView, doubling the
    // I/O and parse cost on every open / page / branch switch.
    const loaded = await this.loadSessionEntries(sessionId);
    if (!loaded) return null;

    const summary = this.buildSummaryFromEntries(
      loaded.entries,
      loaded.stats,
      sessionId,
      projectId,
    );
    if (!summary) return null;

    const entries = loaded.entries;

    // Filter entries if needed (for incremental fetching)
    // Note: Codex entries are not 1:1 with messages, so standard ID filtering is tricky
    // with raw format. We return all entries for now.
    // Ideally the client handles diffing/appending.
    const branchView = buildCodexBranchView(
      entries,
      sessionId,
      options?.branchId,
    );
    const finalEntries = branchView.entries;
    if (afterMessageId) {
      // Logic to filter entries would go here if strict incremental loading is needed
    }

    return {
      summary,
      data: {
        provider: this.determineProviderFromEntries(entries),
        session: {
          entries: finalEntries,
        },
      },
      branchState: branchView.branchState,
      codexBranchState: branchView.branchState,
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
   * Codex doesn't have subagent sessions like Claude.
   * Returns empty array for compatibility.
   */
  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  /**
   * Codex doesn't have subagent sessions like Claude.
   * Returns null for compatibility.
   */
  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
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
          const question = createSessionQuestion(
            {
              id: `codex-${currentIndex}-${entry.timestamp}`,
              text: this.extractCodexUserMessageText(payload.content),
              timestamp: entry.timestamp,
            },
            `codex-user-${currentIndex}`,
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
        const question = createSessionQuestion(
          {
            id: `codex-event-${messageIndex}-${entry.timestamp}`,
            text: [
              sanitizeCodexPublicUserPrompt(entry.payload.message),
              ...(entry.payload.images?.length ? ["[image]"] : []),
            ].join("\n"),
            timestamp: entry.timestamp,
          },
          `codex-event-user-${messageIndex}`,
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
  private extractModel(entries: CodexSessionEntry[]): string | undefined {
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
    entries: CodexSessionEntry[],
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
