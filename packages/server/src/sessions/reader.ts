import type { Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentStatus,
  type ContextCompactEvent,
  type ContextCumulativeUsage,
  type ProviderName,
  SESSION_TITLE_MAX_LENGTH,
  type SessionQuestion,
  type UrlProjectId,
  escalateContextWindow,
  getModelContextWindow,
  isIdeMetadata,
  stripBridgeMetadata,
  stripIdeMetadata,
} from "@yep-anywhere/shared";
import type {
  ContentBlock,
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";
import {
  createSessionQuestion,
  extractQuestionTextFromContent,
} from "./user-questions.js";

// Re-export interface types
export type { GetSessionOptions, ISessionReader } from "./types.js";

import {
  type ClaudeSessionEntry,
  getMessageContent,
  isCompactBoundary,
  isConversationEntry,
} from "@yep-anywhere/shared";
import type { SubagentDescriptor, SubagentMetrics } from "@yep-anywhere/shared";
import {
  buildClaudeBranchView,
  collectVisibleClaudeEntries,
} from "./claude-messages.js";
import { buildDag } from "./dag.js";

export interface ClaudeSessionReaderOptions {
  sessionDir: string;
  /** Additional session dirs from cross-machine merged projects */
  additionalDirs?: string[];
  /** Optional context window resolver (from ModelInfoService) */
  getContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
    sessionId?: string,
  ) => number;
}

/** @deprecated Use ClaudeSessionReaderOptions */
export type SessionReaderOptions = ClaudeSessionReaderOptions;

// Re-export AgentStatus for backwards compatibility
export type { AgentStatus } from "@yep-anywhere/shared";

/**
 * Agent session content returned by getAgentSession.
 * Uses the server's Message type (loosely-typed JSONL pass-through).
 */
export interface AgentSession {
  messages: Message[];
  status: AgentStatus;
  /** Agent type from meta.json (SDK 0.2.76+), e.g. "Explore", "Plan" */
  agentType?: string;
  /**
   * Derived run metrics (usage breakdown, tool/step counts, duration).
   * Providers that cannot measure them omit the field.
   */
  metrics?: SubagentMetrics;
  /** Rich identity + lifecycle descriptor, when the provider can supply it. */
  descriptor?: SubagentDescriptor;
}

/**
 * Mapping of toolUseId to agentId.
 * Used to find agent sessions for pending Tasks on page reload.
 */
export interface AgentMapping {
  toolUseId: string;
  agentId: string;
  /** Agent type from meta.json (SDK 0.2.76+), e.g. "Explore", "Plan" */
  agentType?: string;
}

type UsageFields = {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

function latestEntryTimestamp(entries: ClaudeSessionEntry[]): string | null {
  let latestMs = Number.NEGATIVE_INFINITY;
  let latestTimestamp: string | null = null;

  for (const entry of entries) {
    if (!("timestamp" in entry) || typeof entry.timestamp !== "string") {
      continue;
    }

    const ms = Date.parse(entry.timestamp);
    if (!Number.isFinite(ms) || ms <= latestMs) continue;
    latestMs = ms;
    latestTimestamp = new Date(ms).toISOString();
  }

  return latestTimestamp;
}

/**
 * Get the total input tokens from a usage object.
 * Total = fresh input + cached reads + cache creation.
 */
function getTotalInputTokens(usage: UsageFields): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Compute the token overhead hidden from API-reported usage after compaction.
 *
 * When the Claude SDK compacts context, it writes a compact_boundary entry with
 * compactMetadata.preTokens — the actual context window fill level at compaction time.
 * However, the Anthropic API's usage.input_tokens on subsequent assistant messages only
 * reports the tokens actually sent (summary + new messages), which is much lower.
 * The difference is "overhead" — system prompt, tool definitions, and other context
 * the SDK tracks but the API doesn't include in usage.
 *
 * For sessions with compaction, we compute:
 *   overhead = preTokens - lastPreCompactionAssistantTokens
 *
 * This overhead is then added to post-compaction usage to get accurate context fill.
 *
 * @param messages - All messages on the active branch (not just user/assistant)
 * @returns Token overhead to add to API-reported input_tokens (0 if no compaction)
 */
export function computeCompactionOverhead(
  messages: ClaudeSessionEntry[],
): number {
  // Find the last compact_boundary with compactMetadata
  let lastCompactIdx = -1;
  let preTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && isCompactBoundary(msg)) {
      const metadata = (msg as { compactMetadata?: { preTokens?: number } })
        .compactMetadata;
      if (metadata?.preTokens) {
        lastCompactIdx = i;
        preTokens = metadata.preTokens;
        break;
      }
    }
  }

  if (lastCompactIdx === -1) {
    return 0; // No compaction, no overhead
  }

  // Find the last assistant message BEFORE the compaction boundary with non-zero usage
  for (let i = lastCompactIdx - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.type === "assistant") {
      const usage = (msg as { message?: { usage?: UsageFields } }).message
        ?.usage;
      if (usage) {
        const lastPreCompactionTokens = getTotalInputTokens(usage);
        if (lastPreCompactionTokens > 0) {
          const overhead = preTokens - lastPreCompactionTokens;
          return overhead > 0 ? overhead : 0;
        }
      }
    }
  }

  return 0; // No pre-compaction assistant message found
}

/**
 * Claude-specific session reader for Claude Code JSONL files.
 *
 * Handles Claude's DAG-based conversation structure with parentUuid,
 * agent sessions, orphaned tool detection, and context window tracking.
 */
export class ClaudeSessionReader implements ISessionReader {
  private sessionDir: string;
  private allSessionDirs: string[];
  private resolveContextWindow: (
    model: string | undefined,
    provider?: ProviderName,
    sessionId?: string,
  ) => number;

  constructor(options: ClaudeSessionReaderOptions) {
    this.sessionDir = options.sessionDir;
    this.allSessionDirs = [
      options.sessionDir,
      ...(options.additionalDirs ?? []),
    ];
    this.resolveContextWindow =
      options.getContextWindow ?? getModelContextWindow;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const seenIds = new Set<string>();

    for (const dir of this.allSessionDirs) {
      try {
        const files = await readdir(dir);
        // Filter out agent-* files (internal subagent warmup sessions)
        const jsonlFiles = files.filter(
          (f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
        );

        for (const file of jsonlFiles) {
          const sessionId = file.replace(".jsonl", "");
          if (seenIds.has(sessionId)) continue;
          seenIds.add(sessionId);
          const summary = await this.getSessionSummaryFromDir(
            dir,
            sessionId,
            projectId,
          );
          if (summary) {
            summaries.push(summary);
          }
        }
      } catch {
        // Directory doesn't exist or not readable — continue to next
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
    for (const dir of this.allSessionDirs) {
      const result = await this.getSessionSummaryFromDir(
        dir,
        sessionId,
        projectId,
      );
      if (result) return result;
    }
    return null;
  }

  private async getSessionSummaryFromDir(
    dir: string,
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const loaded = await this.loadSessionEntriesFromDir(dir, sessionId);
    if (!loaded) return null;
    return this.buildSummaryFromEntries(
      loaded.messages,
      loaded.stats,
      sessionId,
      projectId,
    );
  }

  /**
   * Read and parse a session JSONL file exactly once.
   *
   * Returns the parsed entries alongside the file stats so callers can derive
   * both the summary and the branch projection without re-reading or
   * re-parsing the file. Returns null when the file is missing or empty.
   */
  private async loadSessionEntriesFromDir(
    dir: string,
    sessionId: string,
  ): Promise<{
    filePath: string;
    stats: Stats;
    messages: ClaudeSessionEntry[];
  } | null> {
    const filePath = join(dir, `${sessionId}.jsonl`);

    try {
      const content = await readFile(filePath, "utf-8");
      const trimmed = content.trim();

      // Skip empty files
      if (!trimmed) {
        return null;
      }

      const lines = trimmed.split("\n");
      const messages = lines
        .map((line) => {
          try {
            return JSON.parse(line) as ClaudeSessionEntry;
          } catch {
            return null;
          }
        })
        .filter((m): m is ClaudeSessionEntry => m !== null);

      const stats = await stat(filePath);
      return { filePath, stats, messages };
    } catch {
      return null;
    }
  }

  /**
   * Derive a session summary from already-parsed entries.
   *
   * Pure with respect to I/O — the file has already been read and stat'd by
   * {@link loadSessionEntriesFromDir}. Returns null for metadata-only files
   * that have no user/assistant conversation messages yet.
   */
  private buildSummaryFromEntries(
    messages: ClaudeSessionEntry[],
    stats: Stats,
    sessionId: string,
    projectId: UrlProjectId,
  ): SessionSummary | null {
    try {
      // Build DAG and get active branch (filters out dead branches from rewinds, etc.)
      const { activeBranch } = buildDag(messages);

      // Filter active branch to user/assistant messages only
      const conversationMessages = activeBranch
        .filter(
          (node) => node.raw.type === "user" || node.raw.type === "assistant",
        )
        .map((node) => node.raw);

      // Skip sessions with no actual conversation messages (metadata-only files).
      // Note: Newly created sessions may not have user/assistant messages yet (SDK writes async).
      // These are handled separately in the projects route by adding owned processes.
      if (conversationMessages.length === 0) {
        return null;
      }

      const firstUserMessage = this.findFirstUserMessage(messages);
      const fullTitle = firstUserMessage || null;
      const model = this.extractModel(conversationMessages);
      const activeBranchMessages = activeBranch.map((node) => node.raw);
      const userQuestions = this.extractUserQuestions(activeBranchMessages);

      // claude-ollama sessions use the same JSONL format but have non-Claude
      // model IDs (e.g. "qwen3-coder-128k:latest" vs "claude-opus-4-5-20251101")
      const provider =
        model && !model.startsWith("claude-") ? "claude-ollama" : "claude";

      const contextUsage = this.extractContextUsage(
        activeBranchMessages,
        model,
        provider,
        sessionId,
      );
      const runtimeConfig = this.extractRuntimeConfig(activeBranchMessages);

      const cumulativeUsage =
        this.extractCumulativeTokenUsage(activeBranchMessages);
      const compactCount = this.countCompactions(activeBranchMessages);
      const compactEvents = this.extractCompactEvents(activeBranchMessages);

      // A session is "interrupted" when its last turn was cut short (e.g. by a
      // server restart) and the session can be resumed. The reliable signal is
      // the active branch ending on a user message (the user sent a prompt but
      // never got an assistant reply), or on an assistant message with no
      // stop_reason (streaming was severed mid-turn). A trailing assistant
      // message with end_turn/tool_use is a completed turn, not interrupted.
      const interrupted = this.isBranchInterrupted(conversationMessages);

      return {
        id: sessionId,
        projectId,
        title: this.extractTitle(firstUserMessage),
        fullTitle,
        createdAt: stats.birthtime.toISOString(),
        updatedAt:
          latestEntryTimestamp(conversationMessages) ??
          stats.mtime.toISOString(),
        messageCount: conversationMessages.length,
        userQuestions,
        ownership: { owner: "none" }, // Will be updated by Supervisor
        contextUsage,
        cumulativeUsage,
        compactCount,
        compactEvents,
        provider,
        model,
        serviceTier: runtimeConfig.serviceTier,
        interrupted,
      };
    } catch {
      return null;
    }
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    // Read + parse the session file exactly once, then derive both the summary
    // and the branch projection from the same entries. Previously this method
    // called getSessionSummary() (which read + parsed the file) and then
    // re-read + re-parsed the same file for buildClaudeBranchView, doubling the
    // I/O and JSON.parse cost on every open / page / branch switch.
    for (const dir of this.allSessionDirs) {
      const loaded = await this.loadSessionEntriesFromDir(dir, sessionId);
      if (!loaded) continue;

      const summary = this.buildSummaryFromEntries(
        loaded.messages,
        loaded.stats,
        sessionId,
        projectId,
      );
      // Skip metadata-only files with no conversation yet, matching the
      // dir-scanning behaviour of getSessionSummary().
      if (!summary) continue;

      const branchView = buildClaudeBranchView(
        loaded.messages,
        sessionId,
        _options?.branchId,
        { includeOrphans: _options?.includeOrphans },
      );

      // Filter messages for incremental fetching if needed. Use the selected
      // branch projection so a historical branch does not append active-branch
      // siblings during branch navigation.
      let finalMessages = branchView.entries;
      if (afterMessageId) {
        const afterIndex = finalMessages.findIndex(
          (m) => "uuid" in m && m.uuid === afterMessageId,
        );
        if (afterIndex !== -1) {
          finalMessages = finalMessages.slice(afterIndex + 1);
        }
      }

      return {
        summary,
        data: {
          provider: summary.provider as "claude" | "claude-ollama",
          session: {
            messages: finalMessages,
          },
        },
        messagesAlreadyProjected: true,
        orphanedToolUses: branchView.orphanedToolUses,
        branchState: branchView.branchState,
      };
    }

    return null;
  }

  /**
   * Get agent session content for lazy-loading completed Tasks/Agents.
   *
   * Agent JSONL files are stored at:
   * - SDK 0.2.76+: {sessionDir}/subagents/agent-{agentId}.jsonl
   * - Legacy: {sessionDir}/agent-{agentId}.jsonl
   *
   * @param agentId - The agent session ID (used as filename: agent-{agentId}.jsonl)
   * @returns Agent session with messages and inferred status
   */
  async getAgentSession(agentId: string): Promise<AgentSession> {
    // Find the agent file across all dirs, checking subagents/ subdir first (new SDK),
    // then root (legacy)
    let filePath: string | null = null;
    for (const dir of this.allSessionDirs) {
      for (const candidate of [
        join(dir, "subagents", `agent-${agentId}.jsonl`),
        join(dir, `agent-${agentId}.jsonl`),
      ]) {
        try {
          await stat(candidate);
          filePath = candidate;
          break;
        } catch {
          // Not here
        }
      }
      if (filePath) break;
    }
    if (!filePath) return { messages: [], status: "pending" };

    try {
      const content = await readFile(filePath, "utf-8");
      const trimmed = content.trim();

      if (!trimmed) {
        return { messages: [], status: "pending" };
      }

      const lines = trimmed.split("\n");
      const rawMessages: ClaudeSessionEntry[] = [];

      for (const line of lines) {
        try {
          rawMessages.push(JSON.parse(line) as ClaudeSessionEntry);
        } catch {
          // Skip malformed lines
        }
      }

      const { entries, orphanedToolUses } = collectVisibleClaudeEntries(
        rawMessages,
        { includeOrphans: false },
      );

      const messages: Message[] = entries.map((raw, index) =>
        this.convertMessage(raw, index, orphanedToolUses),
      );

      // Infer status from messages
      const status = this.inferAgentStatus(messages);

      // Read agent metadata (agentType from meta.json, SDK 0.2.76+)
      const meta = await this.readAgentMeta(filePath);

      return { messages, status, ...meta };
    } catch {
      // File doesn't exist or not readable - agent is pending
      return { messages: [], status: "pending" };
    }
  }

  /**
   * Get mappings of toolUseId → agentId for all agent files in the session directory.
   *
   * This is used to find agent sessions for pending Tasks/Agents on page reload.
   * Scans agent-*.jsonl files in both:
   * - {sessionDir}/subagents/ (SDK 0.2.76+)
   * - {sessionDir}/ (legacy)
   *
   * For legacy sessions, extracts parent_tool_use_id from first few lines.
   * For new SDK sessions, parent_tool_use_id is no longer present in subagent
   * messages — mapping is done at the caller level via agentId in tool result text.
   *
   * @returns Array of toolUseId → agentId mappings
   */
  async getAgentMappings(): Promise<AgentMapping[]> {
    const mappings: AgentMapping[] = [];
    const seenAgentIds = new Set<string>();

    for (const dir of this.allSessionDirs) {
      // Check both subagents/ subdir (new SDK) and root dir (legacy)
      const dirsToScan = [join(dir, "subagents"), dir];

      for (const scanDir of dirsToScan) {
        try {
          const files = await readdir(scanDir);
          const agentFiles = files.filter(
            (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
          );

          for (const file of agentFiles) {
            // Extract agentId from filename: agent-{agentId}.jsonl
            const agentId = file.slice(6, -6); // Remove "agent-" prefix and ".jsonl" suffix
            if (seenAgentIds.has(agentId)) continue;
            seenAgentIds.add(agentId);
            const filePath = join(scanDir, file);

            // Read agent metadata (agentType from meta.json, SDK 0.2.76+)
            const meta = await this.readAgentMeta(filePath);

            try {
              const content = await readFile(filePath, "utf-8");
              const trimmed = content.trim();
              if (!trimmed) continue;

              // Check first few lines for parent_tool_use_id (legacy format)
              const lines = trimmed.split("\n").slice(0, 5);
              let foundToolUseId = false;
              for (const line of lines) {
                try {
                  const msg = JSON.parse(line) as ClaudeSessionEntry & {
                    parent_tool_use_id?: string;
                  };
                  if (msg.parent_tool_use_id) {
                    mappings.push({
                      toolUseId: msg.parent_tool_use_id,
                      agentId,
                      ...meta,
                    });
                    foundToolUseId = true;
                    break;
                  }
                } catch {
                  // Skip malformed lines
                }
              }

              // SDK 0.2.76+: no parent_tool_use_id in subagent files.
              // Still register the agent so callers know it exists.
              // The toolUseId mapping comes from the main session's tool result text.
              if (!foundToolUseId) {
                mappings.push({
                  toolUseId: agentId, // Use agentId as placeholder
                  agentId,
                  ...meta,
                });
              }
            } catch {
              // Skip unreadable files
            }
          }
        } catch {
          // Directory doesn't exist or not readable
        }
      }
    }

    return mappings;
  }

  /**
   * Infer agent status from its messages.
   *
   * Status inference:
   * - pending: no messages
   * - failed: last message has is_error or error type
   * - completed: has a 'result' type message
   * - running: has messages but no result (still in progress or interrupted)
   */
  private inferAgentStatus(messages: Message[]): AgentStatus {
    if (messages.length === 0) {
      return "pending";
    }

    // Look for result message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;

      // Check for result type message (SDK's final message)
      if (msg.type === "result") {
        // Check for error in result
        if ("is_error" in msg && msg.is_error === true) {
          return "failed";
        }
        return "completed";
      }
    }

    // No result message - still running or interrupted
    return "running";
  }

  /**
   * Determine whether a session's active branch looks interrupted (resumable
   * after a server restart). True when the branch ends on a user message with
   * no assistant reply, or on an assistant message whose turn never reached a
   * stop_reason (streaming severed mid-turn). A trailing assistant message
   * with end_turn/tool_use/etc. is a completed turn.
   */
  private isBranchInterrupted(messages: ClaudeSessionEntry[]): boolean {
    if (messages.length === 0) return false;
    const last = messages[messages.length - 1];
    if (!last) return false;

    // Last message is a user prompt that never got a reply.
    if (last.type === "user") return true;

    if (last.type === "assistant") {
      const stopReason = (last as { message?: { stop_reason?: string } })
        .message?.stop_reason;
      // No stop_reason = assistant was mid-stream when severed.
      // end_turn / tool_use / tool_use etc. mean the turn completed (or paused
      // normally for tool use), so it's not an interruption.
      return !stopReason;
    }

    return false;
  }

  /**
   * Read agent metadata from meta.json file (SDK 0.2.76+).
   * Returns agentType if available, e.g. "Explore", "Plan".
   */
  private async readAgentMeta(
    agentFilePath: string,
  ): Promise<{ agentType?: string }> {
    const metaPath = agentFilePath.replace(/\.jsonl$/, ".meta.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(raw) as { agentType?: string };
      return { agentType: meta.agentType };
    } catch {
      return {};
    }
  }

  /** Find the session file across all session dirs, returning the first match. */
  private async findSessionFile(sessionId: string): Promise<string | null> {
    for (const dir of this.allSessionDirs) {
      const candidate = join(dir, `${sessionId}.jsonl`);
      try {
        await stat(candidate);
        return candidate;
      } catch {
        // Not in this dir
      }
    }
    return null;
  }

  private findFirstUserMessage(messages: ClaudeSessionEntry[]): string | null {
    for (const msg of messages) {
      if (msg.type === "user") {
        const content = msg.message.content;
        if (content) {
          // Content can be string or array of content blocks
          if (typeof content === "string") {
            return this.extractTitleContent(content);
          }
          // Filter to object blocks only (skip string items), cast for compatibility
          const objectBlocks = content.filter(
            (b) => typeof b !== "string",
          ) as Array<{ type: string; text?: string }>;
          return this.extractTitleContent(objectBlocks);
        }
      }
    }
    return null;
  }

  private extractUserQuestions(
    messages: ClaudeSessionEntry[],
  ): SessionQuestion[] {
    const questions: SessionQuestion[] = [];

    for (let index = 0; index < messages.length; index++) {
      const msg = messages[index];
      if (!msg || msg.type !== "user") continue;

      const content = msg.message.content;
      if (!content) continue;
      const questionText =
        typeof content === "string"
          ? extractQuestionTextFromContent(content)
          : extractQuestionTextFromContent(
              content.filter((block) => typeof block !== "string") as Array<{
                type?: unknown;
                text?: unknown;
              }>,
            );
      const question = createSessionQuestion(
        {
          id: msg.uuid,
          text: questionText,
          timestamp: msg.timestamp,
        },
        `claude-user-${index}`,
      );
      if (question) {
        questions.push(question);
      }
    }

    return questions;
  }

  /**
   * Extract context usage from the last assistant message.
   * Usage data is stored in message.usage with input_tokens, cache_read_input_tokens, etc.
   *
   * After compaction, the API's input_tokens only reflects tokens sent in the compacted
   * request (summary + new messages), which is much less than the actual context window
   * fill level. We use compactMetadata.preTokens from compact_boundary entries to compute
   * the hidden overhead (system prompt, tools, etc.) and add it to post-compaction usage.
   *
   * @param messages - All active branch messages (including system entries for compaction detection)
   * @param model - Model ID for determining context window size
   */
  private extractContextUsage(
    messages: ClaudeSessionEntry[],
    model: string | undefined,
    provider?: ProviderName,
    sessionId?: string,
  ): ContextUsage | undefined {
    const contextWindowSize = this.resolveContextWindow(
      model,
      provider,
      sessionId,
    );

    // Compute token overhead from compaction metadata.
    // After compaction, the API reports fewer input_tokens because old messages are
    // compressed into a summary. But the SDK's actual context window fill is higher.
    // compactMetadata.preTokens tells us the true fill level at compaction time.
    const overhead = computeCompactionOverhead(messages);

    // Find the last assistant message (iterate backwards)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.type === "assistant") {
        const usage = msg.message.usage as
          | {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            }
          | undefined;

        if (usage) {
          // Total input = fresh tokens + cached tokens + new cache creation
          const rawInputTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);

          // Skip messages with zero input tokens (incomplete streaming messages)
          if (rawInputTokens === 0) {
            continue;
          }

          // Apply overhead correction for post-compaction messages
          const inputTokens = rawInputTokens + overhead;

          // The Claude Code SDK strips `[1m]` from the model ID it writes to
          // JSONL, so a 1M-context session reads back as a plain model name
          // and scores 200K. If usage exceeds that, escalate so the user
          // doesn't see >100% on perfectly-fine 1M sessions.
          const effectiveWindow = escalateContextWindow(
            contextWindowSize,
            inputTokens,
            provider,
          );

          const percentage = Math.round((inputTokens / effectiveWindow) * 100);

          const result: ContextUsage = {
            inputTokens,
            percentage,
            contextWindow: effectiveWindow,
          };

          // Add optional fields if available
          if (usage.output_tokens !== undefined && usage.output_tokens > 0) {
            result.outputTokens = usage.output_tokens;
          }
          if (
            usage.cache_read_input_tokens !== undefined &&
            usage.cache_read_input_tokens > 0
          ) {
            result.cacheReadTokens = usage.cache_read_input_tokens;
          }
          if (
            usage.cache_creation_input_tokens !== undefined &&
            usage.cache_creation_input_tokens > 0
          ) {
            result.cacheCreationTokens = usage.cache_creation_input_tokens;
          }

          return result;
        }
      }
    }
    return undefined;
  }

  /**
   * Walk every assistant message in the active branch and sum the per-turn
   * `usage` blocks. Returns the cumulative input/output/cache figures shown
   * in the context-status modal — the same numbers Claude Code prints for
   * `/status`.
   *
   * Synthetic / error messages (model === "<synthetic>") and entries
   * without a usage block are skipped so a single failed turn doesn't
   * inflate the totals.
   */
  private extractCumulativeTokenUsage(
    messages: ClaudeSessionEntry[],
  ): ContextCumulativeUsage | undefined {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let turnCount = 0;

    for (const msg of messages) {
      if (msg.type !== "assistant") continue;
      if (msg.message.model === "<synthetic>") continue;

      const usage = msg.message.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;
      if (!usage) continue;

      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      turnCount += 1;
    }

    if (turnCount === 0) return undefined;
    return {
      totalTokens:
        inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      turnCount,
    };
  }

  private countCompactions(messages: ClaudeSessionEntry[]): number {
    return messages.reduce(
      (count, msg) => count + (isCompactBoundary(msg) ? 1 : 0),
      0,
    );
  }

  private extractCompactEvents(
    messages: ClaudeSessionEntry[],
  ): ContextCompactEvent[] | undefined {
    const events: ContextCompactEvent[] = [];

    for (let index = 0; index < messages.length; index += 1) {
      const msg = messages[index];
      if (!msg || !isCompactBoundary(msg)) continue;

      const metadata = (
        msg as {
          compactMetadata?: {
            preTokens?: number;
            trigger?: string;
          };
        }
      ).compactMetadata;
      const previousAssistantTokens = this.findAssistantInputTokens(
        messages,
        index - 1,
        -1,
      );
      const preTokens =
        typeof metadata?.preTokens === "number" && metadata.preTokens > 0
          ? metadata.preTokens
          : undefined;
      const overhead =
        preTokens !== undefined && previousAssistantTokens !== undefined
          ? Math.max(0, preTokens - previousAssistantTokens)
          : 0;
      const beforeTokens =
        preTokens !== undefined ? preTokens : previousAssistantTokens;
      const afterAssistantTokens = this.findAssistantInputTokens(
        messages,
        index + 1,
        1,
      );
      const afterTokens =
        afterAssistantTokens !== undefined
          ? afterAssistantTokens + overhead
          : undefined;
      const event: ContextCompactEvent = {};

      if ("timestamp" in msg && typeof msg.timestamp === "string") {
        event.timestamp = msg.timestamp;
      }
      if (typeof metadata?.trigger === "string" && metadata.trigger) {
        event.trigger = metadata.trigger;
      }
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

  private findAssistantInputTokens(
    messages: ClaudeSessionEntry[],
    startIndex: number,
    direction: -1 | 1,
  ): number | undefined {
    for (
      let index = startIndex;
      index >= 0 && index < messages.length;
      index += direction
    ) {
      const msg = messages[index];
      if (!msg || msg.type !== "assistant") continue;

      const usage = (msg as { message?: { usage?: UsageFields } }).message
        ?.usage;
      if (!usage) continue;

      const inputTokens = getTotalInputTokens(usage);
      if (inputTokens > 0) return inputTokens;
    }

    return undefined;
  }

  /**
   * Extract the model from the first assistant message.
   * The model is stored in message.model (e.g., "claude-opus-4-5-20251101").
   */
  private extractModel(messages: ClaudeSessionEntry[]): string | undefined {
    // Find the first assistant message with a real model field.
    // Skip "<synthetic>" which the SDK uses for error messages (e.g., 500 errors).
    for (const msg of messages) {
      if (msg.type === "assistant") {
        const model = msg.message.model;
        if (model && model !== "<synthetic>") {
          return model;
        }
      }
    }
    return undefined;
  }

  /**
   * Extract provider runtime settings from the latest assistant usage block.
   */
  private extractRuntimeConfig(messages: ClaudeSessionEntry[]): {
    serviceTier?: string;
  } {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.type !== "assistant") continue;

      const usage = msg.message.usage as
        | { service_tier?: string | null; speed?: string | null }
        | undefined;
      const serviceTier = usage?.speed ?? usage?.service_tier ?? undefined;
      if (serviceTier) {
        return { serviceTier };
      }
    }

    return {};
  }

  private extractTitle(content: string | null): string | null {
    if (!content) return null;
    const trimmed = content.trim();
    if (trimmed.length <= SESSION_TITLE_MAX_LENGTH) return trimmed;
    return `${trimmed.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
  }

  private extractContent(
    content: string | Array<{ type: string; text?: string }>,
  ): string {
    if (typeof content === "string") return content;
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }

  /**
   * Extract content for title generation, skipping IDE metadata blocks.
   * This ensures session titles show the actual user message, not IDE metadata
   * like <ide_opened_file> or <ide_selection> tags.
   */
  private extractTitleContent(
    content: string | Array<{ type: string; text?: string }>,
  ): string {
    if (typeof content === "string") {
      return stripBridgeMetadata(stripIdeMetadata(content));
    }
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          block.type === "text" &&
          typeof block.text === "string" &&
          !isIdeMetadata(block.text),
      )
      .map((block) => stripBridgeMetadata(stripIdeMetadata(block.text)))
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Get session summary only if the file has changed since the cached values.
   * Used by SessionIndexService for cache invalidation.
   *
   * @param sessionId - The session ID
   * @param projectId - The project ID
   * @param cachedMtime - The mtime (ms since epoch) from the cache
   * @param cachedSize - The file size (bytes) from the cache
   * @returns Summary with file stats if changed, null if unchanged
   */
  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) return null;

    try {
      const stats = await stat(filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // If mtime and size match cached values, return null (no change)
      if (mtime === cachedMtime && size === cachedSize) {
        return null;
      }

      // Otherwise parse the file and return { summary, mtime, size }
      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null; // File doesn't exist or error
    }
  }

  /**
   * Convert a raw JSONL message to our Message format.
   *
   * We pass through all fields from JSONL without stripping.
   * This preserves debugging info, DAG structure, and metadata.
   * The only transformation is:
   * - Normalize content blocks (pass through all fields)
   * - Add computed orphanedToolUseIds
   */
  private convertMessage(
    raw: ClaudeSessionEntry,
    _index: number,
    orphanedToolUses: Set<string> = new Set(),
  ): Message {
    // Normalize content blocks - pass through all fields
    let content: string | ContentBlock[] | undefined;
    const rawContent = getMessageContent(raw);
    if (typeof rawContent === "string") {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      // Pass through all fields from each content block
      // Filter out string items (which can appear in user message content)
      content = rawContent
        .filter((block) => typeof block !== "string")
        .map((block) => ({ ...(block as object) })) as ContentBlock[];
    }

    // Build message by spreading all raw fields, then override with normalized values
    // Use type assertion since we're converting to a looser Message type
    const rawAny = raw as Record<string, unknown>;
    const message: Message = {
      ...rawAny,
      // Include normalized content if message had content
      ...(isConversationEntry(raw) && {
        message: {
          ...(raw.message as Record<string, unknown>),
          ...(content !== undefined && { content }),
        },
      }),
      // Ensure type is set
      type: raw.type,
    };

    // Identify orphaned tool_use IDs in this message's content
    if (Array.isArray(content)) {
      const orphanedIds = content
        .filter(
          (b): b is ContentBlock & { id: string } =>
            b.type === "tool_use" &&
            typeof b.id === "string" &&
            orphanedToolUses.has(b.id),
        )
        .map((b) => b.id);

      if (orphanedIds.length > 0) {
        message.orphanedToolUseIds = orphanedIds;
      }
    }

    return message;
  }
}

/** @deprecated Use ClaudeSessionReader */
export const SessionReader = ClaudeSessionReader;
/** @deprecated Use ClaudeSessionReader */
export type SessionReader = ClaudeSessionReader;
