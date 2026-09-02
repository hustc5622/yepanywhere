/**
 * Session reader interface for provider-agnostic session reading.
 *
 * Each provider (Claude, Codex, Gemini) has different JSONL formats,
 * but all readers implement this interface to provide a common API.
 */

import type {
  AgentMapping,
  CodexBranchState,
  SessionBranchState,
  SubagentDescriptor,
  SubagentMetrics,
  UnifiedSession,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { Message, Session, SessionSummary } from "../supervisor/types.js";
import type { PaginationInfo } from "./pagination.js";

/**
 * Options for reading a session.
 */
export interface GetSessionOptions {
  /** Include orphaned tool use detection (default: true, only applicable for Claude) */
  includeOrphans?: boolean;
  /** Choose a derived branch id to render instead of the latest branch. */
  branchId?: string;
  /** Omit inline Pi image data from the normalized transcript. */
  deferMedia?: boolean;
  /** Omit Pi thinking blocks from the normalized transcript. */
  deferThinking?: boolean;
  /**
   * Return a body-free Inspector index. Codex may use safe semantic
   * placeholders for media/provider-native items because the route removes
   * those bodies before responding; ordinary transcript reads remain strict.
   */
  inspectorProjection?: boolean;
  /** Return only a bounded message window (Codex uses this before parsing). */
  maxMessages?: number;
  /** Number of compact boundaries to retain at the tail (Codex). */
  tailCompactions?: number;
  /** Return the window before this message cursor (Codex). */
  beforeMessageId?: string;
  /** Return a window centered around this message cursor (Codex). */
  aroundMessageId?: string;
  /** Return the window after this message cursor (Codex). */
  afterWindowMessageId?: string;
  /** Revision attached to a Codex pagination cursor. */
  rolloutRevision?: string;
}

// Return type that includes both the computed summary and the raw provider data
export interface LoadedSession {
  summary: SessionSummary;
  data: UnifiedSession;
  /** Internal: Claude messages have already been projected to the selected visible branch. */
  messagesAlreadyProjected?: boolean;
  /** Internal: orphaned tool IDs computed while projecting Claude messages. */
  orphanedToolUses?: Set<string>;
  /** Internal: Codex page projection, so route normalization does not re-convert it. */
  projectedMessages?: Message[];
  /** Internal: pagination already applied by a bounded Codex reader. */
  pagination?: PaginationInfo;
  paginationApplied?: boolean;
  /** Physical Codex rollout bytes used for large-history admission. */
  codexRolloutBytes?: number;
  /** Public history backend used for this snapshot. */
  historySource?: "codex-app-server" | "codex-rollout";
  /**
   * Internal read-stage timings used to populate the session detail
   * `Server-Timing` header without exposing provider data in the response.
   */
  historyReadTimings?: {
    historyCapabilityMs?: number;
    summaryScanMs?: number;
    pageReadMs?: number;
    normalizeMs?: number;
  };
  /** Provider-agnostic branch state for sessions with editable DAG/rollback history. */
  branchState?: SessionBranchState;
  /** Codex-only branch state derived from thread_rolled_back markers. */
  codexBranchState?: CodexBranchState;
  /**
   * Pi messages projected while deriving the summary, avoiding a second
   * conversion traversal in normalizeSession.
   */
  precomputedPiMessages?: {
    messages: Message[];
    deferMedia: boolean;
    deferThinking: boolean;
  };
}

export interface SessionFileEntry {
  sessionId: string;
  filePath: string;
  /** Optional file mtime in ms. Readers that already scanned file stats can provide this to avoid duplicate stat calls. */
  mtime?: number;
  /** Optional file size in bytes. Readers that already scanned file stats can provide this to avoid duplicate stat calls. */
  size?: number;
}

/**
 * Common interface for session readers across providers.
 *
 * Provider-specific readers may have additional methods beyond this interface.
 * For example, ClaudeSessionReader has getAgentSession() for subagent support.
 */
export interface ISessionReader {
  /**
   * List all sessions in this reader's session directory.
   */
  listSessions(projectId: UrlProjectId): Promise<SessionSummary[]>;

  /**
   * Get summary metadata for a single session.
   */
  getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null>;

  /**
   * Get full session with messages.
   * @param sessionId - The session ID
   * @param projectId - The project ID
   * @param afterMessageId - Only return messages after this ID (for incremental fetching)
   * @param options - Additional options
   */
  getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null>;

  /**
   * Get session summary only if the file has changed since cached values.
   * Used for cache invalidation.
   *
   * @param sessionId - The session ID
   * @param projectId - The project ID
   * @param cachedMtime - The mtime (ms since epoch) from the cache
   * @param cachedSize - The file size (bytes) from the cache
   * @returns Summary with file stats if changed, null if unchanged
   */
  getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null>;

  /**
   * Get mappings from tool use IDs to agent session IDs.
   * Used for Claude's Task tool to link tool_use to subagent sessions.
   * Providers without subagent transcript support should return an empty array.
   *
   * @param sessionId - Optional session scope. Providers whose subagent ids
   *   are only unique within a session (e.g. Kimi's `agent-0`/`agent-1`) use
   *   this to scope the mappings to one session. Providers with globally
   *   unique agent ids (Claude) may ignore it.
   */
  getAgentMappings(sessionId?: string): Promise<AgentMapping[]>;

  /**
   * Get an agent (subagent) session by ID.
   * Used for Claude's Task tool subagent sessions (agent-*.jsonl files).
   * Providers without subagent transcript support should return null.
   *
   * @param sessionId - Optional session scope; see getAgentMappings.
   */
  getAgentSession(
    agentId: string,
    sessionId?: string,
  ): Promise<{
    messages: Message[];
    status: string;
    agentType?: string;
    metrics?: SubagentMetrics;
    descriptor?: SubagentDescriptor;
  } | null>;

  /**
   * Get the file path for a session by ID.
   * Used for operations that need direct file access (e.g., cloning).
   * Returns null if the session is not found.
   */
  getSessionFilePath?(sessionId: string): Promise<string | null>;

  /**
   * Return provider-aware change stats for index caching.
   * Readers whose session metadata spans multiple files can aggregate those
   * files into one mtime/size pair. The index falls back to getSessionFilePath
   * when this method is not implemented.
   */
  getSessionFileStats?(
    sessionId: string,
  ): Promise<{ mtime: number; size: number } | null>;

  /**
   * Enumerate session files in a directory with their IDs.
   * Used by SessionIndexService for providers where the session ID
   * can't be derived from the filename (e.g., Gemini JSON files).
   *
   * When not implemented, the index service falls back to JSONL
   * filename-based enumeration.
   */
  listSessionFiles?(sessionDir: string): Promise<SessionFileEntry[]>;

  /**
   * Return a stable cache/index scope key for this reader.
   *
   * Most providers can use the physical sessionDir directly, but providers like
   * Codex/Gemini share a single root session directory across many projects and
   * rely on reader-level filtering. Those readers should return a key that also
   * includes the logical project scope to avoid cache/index contamination.
   */
  getIndexScopeKey?(sessionDir: string): string;
}
