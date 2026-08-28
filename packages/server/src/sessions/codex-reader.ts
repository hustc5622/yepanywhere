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
  SESSION_TITLE_MAX_LENGTH,
  type SessionQuestion,
  type UnifiedSession,
  type UrlProjectId,
  getModelContextWindow,
  parseCodexSessionEntry,
  parseUserPromptMetadata,
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
import {
  applyCodexRollbackMarkers,
  buildCodexBranchView,
} from "./codex-rollback.js";
import {
  type CodexSessionManifest,
  type CodexSessionManifestEntry,
  getCodexSessionManifest,
  invalidateCodexSessionManifest,
} from "./codex-session-manifest.js";

import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";
import { isSyntheticUserPromptText } from "./user-prompt-classification.js";
import { createSessionQuestion } from "./user-questions.js";

function normalizeCodexSessionSource(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  if (!source || typeof source !== "object") return undefined;
  if ("subagent" in source || "subAgent" in source) return "subagent";
  if ("custom" in source && typeof source.custom === "string") {
    return source.custom;
  }
  return undefined;
}

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
      const entries = await this.readSessionEntries(sessionFile);
      return this.createSessionSummary(
        sessionId,
        projectId,
        sessionFile,
        entries,
      );
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
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    let entries: CodexSessionEntry[];
    let summary: SessionSummary | null;
    try {
      entries = await this.readSessionEntries(sessionFile);
      summary = await this.createSessionSummary(
        sessionId,
        projectId,
        sessionFile,
        entries,
      );
    } catch {
      return null;
    }
    if (!summary) return null;

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

  private async readSessionEntries(
    sessionFile: CodexSessionFile,
  ): Promise<CodexSessionEntry[]> {
    const lines = await readJsonlLines(sessionFile.filePath);
    if (lines.length === 0 || (lines.length === 1 && !lines[0])) return [];

    const entries: CodexSessionEntry[] = [];
    for (const line of lines) {
      const entry = parseCodexSessionEntry(line);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private async createSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
    sessionFile: CodexSessionFile,
    entries: CodexSessionEntry[],
  ): Promise<SessionSummary | null> {
    if (entries.length === 0) return null;
    const visibleEntries = applyCodexRollbackMarkers(entries);
    const metaEntry = entries.find((e) => e.type === "session_meta") as
      | CodexSessionMetaEntry
      | undefined;
    if (!metaEntry) return null;

    const stats = await stat(sessionFile.filePath);
    const { title, fullTitle } = this.extractTitle(visibleEntries);
    const userQuestions = this.extractUserQuestions(visibleEntries);
    const messageCount = this.countMessages(visibleEntries);
    if (messageCount === 0) return null;

    const model = this.extractModel(visibleEntries);
    const provider = this.determineProvider(metaEntry, model);
    const turnContext = this.extractTurnContext(visibleEntries);
    const runtimeConfig = this.extractRuntimeConfig(visibleEntries);
    const contextUsage = this.extractContextUsage(
      visibleEntries,
      model,
      provider,
    );

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
      provider,
      model,
      reasoningEffort: runtimeConfig.reasoningEffort,
      serviceTier: runtimeConfig.serviceTier,
      originator: metaEntry.payload.originator,
      cliVersion: metaEntry.payload.cli_version,
      source: normalizeCodexSessionSource(metaEntry.payload.source),
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
    if (!session) return null;

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
        const fullTitle = this.extractVisibleUserPrompt(entry.payload.message);
        if (!fullTitle) {
          continue;
        }
        if (skipLeadingSystemPrompts && isSyntheticUserPromptText(fullTitle)) {
          continue;
        }
        const title =
          fullTitle.length <= SESSION_TITLE_MAX_LENGTH
            ? fullTitle
            : `${fullTitle.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
        return { title, fullTitle };
      }

      if (entry.type === "response_item") {
        const payload = entry.payload;
        if (payload.type === "message" && payload.role === "user") {
          const rawText = payload.content
            .map((c) => ("text" in c ? c.text : ""))
            .join("\n")
            .trim();
          const text = this.extractVisibleUserPrompt(rawText);
          if (
            text &&
            !(skipLeadingSystemPrompts && isSyntheticUserPromptText(text))
          ) {
            const title =
              text.length <= SESSION_TITLE_MAX_LENGTH
                ? text
                : `${text.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
            return { title, fullTitle: text };
          }
        }
      }
    }

    return { title: null, fullTitle: null };
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
              entry.payload.message,
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
    const rawText = content
      .map((block) => {
        if (block.type === "input_text") {
          return block.text;
        }
        if (block.type === "input_image") {
          return "[image]";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return this.extractVisibleUserPrompt(rawText);
  }

  private extractVisibleUserPrompt(text: string): string {
    const parsed = parseUserPromptMetadata(text);
    return (
      parsed.text || parsed.mentionedFiles.map((file) => file.name).join(", ")
    ).trim();
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
    // Check explicit provider field if available
    if (metaEntry.payload.model_provider) {
      const provider = metaEntry.payload.model_provider.toLowerCase();
      if (
        provider === "ollama" ||
        provider === "lmstudio" ||
        provider === "local"
      ) {
        return "codex-oss";
      }
      if (provider === "openai" || provider === "azure") {
        return "codex";
      }
    }

    // fallback: check model name for known local models if provider not set
    if (model) {
      const lowerModel = model.toLowerCase();
      // Heuristic: models starting with "gpt-" or "o1-" are usually OpenAI
      if (lowerModel.startsWith("gpt-") || lowerModel.startsWith("o1-")) {
        return "codex";
      }
      // Heuristic: other models often implying local usage (llama, mistral, qwen, etc)
      // or if we just default to everything else being oss?
      // For safety, let's just stick to specific local keywords for now to avoid false positives.
      if (
        lowerModel.includes("llama") ||
        lowerModel.includes("mistral") ||
        lowerModel.includes("qwen") ||
        lowerModel.includes("gemma") ||
        lowerModel.includes("deepseek") ||
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

  /**
   * Convert Codex JSONL entries to Message format.
   *
   * Codex sessions contain both streaming events (event_msg) and aggregated
   * response_item entries. We prefer response_item for messages since they
   * contain the complete text, and only use event_msg for user_message events.
   *
   * Unlike Claude's DAG structure, Codex sessions are linear. We create a
   * parentUuid chain by linking each message to the previous one, which
   * enables proper ordering and deduplication in the client.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   * This method may be removed once we confirm it's no longer called.
   */
  private convertEntriesToMessages(entries: CodexSessionEntry[]): Message[] {
    const messages: Message[] = [];
    let messageIndex = 0;
    let lastMessageUuid: string | null = null;
    const hasResponseItemUser = this.hasResponseItemUserMessages(entries);

    // Track function calls for pairing with outputs
    const pendingCalls = new Map<
      string,
      { name: string; arguments: string; timestamp: string }
    >();

    for (const entry of entries) {
      if (entry.type === "response_item") {
        const msg = this.convertResponseItem(
          entry,
          messageIndex++,
          pendingCalls,
        );
        if (msg) {
          // Set parentUuid to create linear chain for ordering/dedup
          msg.parentUuid = lastMessageUuid;
          lastMessageUuid = msg.uuid ?? null;
          messages.push(msg);
        }
      } else if (entry.type === "event_msg") {
        // Only process user_message events - agent_message events are
        // duplicates of the response_item data (streaming tokens)
        if (entry.payload.type === "user_message" && !hasResponseItemUser) {
          const msg = this.convertEventMsg(entry, messageIndex++);
          if (msg) {
            // Set parentUuid to create linear chain for ordering/dedup
            msg.parentUuid = lastMessageUuid;
            lastMessageUuid = msg.uuid ?? null;
            messages.push(msg);
          }
        }
        // Skip agent_message, agent_reasoning, token_count - these are
        // streaming events that duplicate response_item content
      }
      // Skip session_meta and turn_context for now
    }

    return messages;
  }

  private hasResponseItemUserMessages(entries: CodexSessionEntry[]): boolean {
    return entries.some(
      (entry) =>
        entry.type === "response_item" &&
        entry.payload.type === "message" &&
        entry.payload.role === "user",
    );
  }

  /**
   * Convert a response_item entry to a Message.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertResponseItem(
    entry: CodexResponseItemEntry,
    index: number,
    pendingCalls: Map<
      string,
      { name: string; arguments: string; timestamp: string }
    >,
  ): Message | null {
    const payload = entry.payload;
    const uuid = `codex-${index}-${entry.timestamp}`;

    switch (payload.type) {
      case "message":
        if (payload.role === "developer") {
          return null;
        }
        return this.convertMessagePayload(payload, uuid, entry.timestamp);

      case "reasoning":
        return this.convertReasoningPayload(payload, uuid, entry.timestamp);

      case "function_call":
        // Store for pairing with output
        pendingCalls.set(payload.call_id, {
          name: payload.name,
          arguments: payload.arguments,
          timestamp: entry.timestamp,
        });
        // Create tool_use message
        return this.convertFunctionCallPayload(payload, uuid, entry.timestamp);

      case "function_call_output":
        return this.convertFunctionCallOutputPayload(
          payload,
          uuid,
          entry.timestamp,
          pendingCalls,
        );

      case "ghost_snapshot":
        // Skip git snapshot entries for now
        return null;

      default:
        return null;
    }
  }

  /**
   * Convert a message payload (user or assistant).
   *
   * Codex streams tokens as separate output_text blocks, so we concatenate
   * them into a single text block for proper rendering.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertMessagePayload(
    payload: CodexMessagePayload,
    uuid: string,
    timestamp: string,
  ): Message {
    // Concatenate all text blocks into a single string
    const fullText = payload.content.map((c) => c.text).join("");

    // Skip empty messages
    if (!fullText.trim()) {
      return {
        uuid,
        type: payload.role,
        message: {
          role: payload.role,
          content: [],
        },
        timestamp,
      };
    }

    const content: ContentBlock[] = [
      {
        type: "text" as const,
        text: fullText,
      },
    ];

    return {
      uuid,
      type: payload.role,
      message: {
        role: payload.role,
        content,
      },
      timestamp,
    };
  }

  /**
   * Convert a reasoning payload (thinking).
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertReasoningPayload(
    payload: CodexReasoningPayload,
    uuid: string,
    timestamp: string,
  ): Message {
    // Extract text from summary or encrypted content indicator
    const summaryText = payload.summary
      ?.map((s) => s.text)
      .join("\n")
      .trim();

    const content: ContentBlock[] = [];

    if (summaryText) {
      content.push({
        type: "thinking",
        thinking: summaryText,
      });
    }

    if (payload.encrypted_content) {
      content.push({
        type: "text",
        text: "[Encrypted reasoning content]",
      });
    }

    return {
      uuid,
      type: "assistant",
      message: {
        role: "assistant",
        content,
      },
      timestamp,
    };
  }

  /**
   * Convert a function_call payload to tool_use.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertFunctionCallPayload(
    payload: CodexFunctionCallPayload,
    uuid: string,
    timestamp: string,
  ): Message {
    let input: unknown;
    try {
      input = JSON.parse(payload.arguments);
    } catch {
      input = { raw: payload.arguments };
    }

    const content: ContentBlock[] = [
      {
        type: "tool_use",
        id: payload.call_id,
        name: payload.name,
        input,
      },
    ];

    return {
      uuid,
      type: "assistant",
      message: {
        role: "assistant",
        content,
      },
      timestamp,
    };
  }

  /**
   * Convert a function_call_output payload to tool_result.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertFunctionCallOutputPayload(
    payload: CodexFunctionCallOutputPayload,
    uuid: string,
    timestamp: string,
    _pendingCalls: Map<
      string,
      { name: string; arguments: string; timestamp: string }
    >,
  ): Message {
    return {
      uuid,
      type: "tool_result",
      toolUseResult: {
        tool_use_id: payload.call_id,
        content: payload.output,
      },
      timestamp,
    };
  }

  /**
   * Convert an event_msg entry to a Message.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertEventMsg(
    entry: CodexEventMsgEntry,
    index: number,
  ): Message | null {
    const payload = entry.payload;
    const uuid = `codex-event-${index}-${entry.timestamp}`;

    switch (payload.type) {
      case "user_message":
        return {
          uuid,
          type: "user",
          message: {
            role: "user",
            content: payload.message,
          },
          timestamp: entry.timestamp,
        };

      case "agent_message":
        return {
          uuid,
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: payload.message }],
          },
          timestamp: entry.timestamp,
        };

      case "agent_reasoning":
        return {
          uuid,
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: payload.text }],
          },
          timestamp: entry.timestamp,
        };

      case "token_count":
        // Skip token count events in messages
        return null;

      default:
        return null;
    }
  }
}
