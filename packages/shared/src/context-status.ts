/**
 * Context usage breakdown shape returned by `GET /api/projects/:projectId/sessions/:sessionId/context-status`.
 *
 * Fields mirror SDKControlGetContextUsageResponse from @anthropic-ai/claude-agent-sdk.
 * When the live SDK Process is available we return `source: "sdk"` with full breakdown;
 * otherwise we fall back to a coarse estimate derived from the persisted JSONL.
 */

import type { ContextUsage } from "./app-types.js";

export interface ContextCategoryEntry {
  name: string;
  tokens: number;
  color?: string;
}

export interface ContextMcpToolEntry {
  name: string;
  serverName: string;
  tokens: number;
  isLoaded?: boolean;
}

export interface ContextMemoryFileEntry {
  path: string;
  type: string;
  tokens: number;
}

export interface ContextSkillFrontmatterEntry {
  name: string;
  source: string;
  tokens: number;
}

export interface ContextSkillsSummary {
  totalSkills: number;
  includedSkills: number;
  tokens: number;
  skillFrontmatter: ContextSkillFrontmatterEntry[];
}

export interface ContextSlashCommandsSummary {
  totalCommands: number;
  includedCommands: number;
  tokens: number;
}

export interface ContextAgentEntry {
  agentType: string;
  source: string;
  tokens: number;
}

export interface ContextSystemPromptSection {
  name: string;
  tokens: number;
}

export interface ContextSystemTool {
  name: string;
  tokens: number;
}

export interface ContextDeferredBuiltinTool {
  name: string;
  tokens: number;
  isLoaded: boolean;
}

/**
 * Cumulative provider-reported token usage across the entire session.
 *
 * Distinct from `ContextUsage`, which represents the **last** turn's
 * snapshot of context-window fill (used for the "X / Y tokens" meter).
 * For Claude this is derived from per-assistant `usage` blocks; for Codex
 * it comes from `token_count.info.total_token_usage`, with compaction
 * boundaries handled by the session reader.
 */
export interface ContextCumulativeUsage {
  /** Provider-reported all-in total when available; otherwise callers can sum fields below. */
  totalTokens?: number;
  /** Sum of usage.input_tokens across all assistant messages — fresh
   *  tokens billed at the input rate (excludes cached). */
  inputTokens: number;
  /** Sum of usage.output_tokens — generated tokens billed at output rate. */
  outputTokens: number;
  /** Sum of usage.cache_read_input_tokens — tokens served from prompt cache
   *  (typically billed at ~10% of fresh input). */
  cacheReadTokens: number;
  /** Sum of usage.cache_creation_input_tokens — new entries written to
   *  prompt cache (billed at ~125% of fresh input). */
  cacheCreationTokens: number;
  /** Total assistant turns counted (excludes synthetic / error entries). */
  turnCount: number;
}

/**
 * Best-effort details for a context compaction observed in persisted session
 * history. Token values describe context-window fill before/after compaction,
 * not cumulative spend.
 */
export interface ContextCompactEvent {
  /** When the compaction marker was written, if the provider recorded it. */
  timestamp?: string;
  /** Context tokens immediately before compaction, if known. */
  beforeTokens?: number;
  /** Context tokens immediately after compaction, if known. */
  afterTokens?: number;
  /** Positive difference between beforeTokens and afterTokens, if known. */
  reclaimedTokens?: number;
  /** Provider-reported trigger/source, e.g. "auto" or "manual". */
  trigger?: string;
}

/**
 * Live, structured breakdown coming straight from the SDK
 * (Query.getContextUsage()).
 */
export interface ContextStatusSdkPayload {
  source: "sdk";
  /** Model id reported by the SDK at query time (may differ from session.model). */
  model: string;
  totalTokens: number;
  /** Effective max tokens (may be reduced by auto-compact threshold). */
  maxTokens: number;
  /** Raw model max tokens (the model's actual context window). */
  rawMaxTokens: number;
  percentage: number;
  autoCompactThreshold?: number;
  categories: ContextCategoryEntry[];
  mcpTools: ContextMcpToolEntry[];
  memoryFiles: ContextMemoryFileEntry[];
  agents: ContextAgentEntry[];
  slashCommands?: ContextSlashCommandsSummary;
  skills?: ContextSkillsSummary;
  systemPromptSections?: ContextSystemPromptSection[];
  systemTools?: ContextSystemTool[];
  deferredBuiltinTools?: ContextDeferredBuiltinTool[];
  /** Cumulative token spend across the whole session (read from JSONL —
   *  the SDK's getContextUsage doesn't surface this). Optional because
   *  some providers' readers haven't implemented it yet. */
  cumulativeUsage?: ContextCumulativeUsage;
  /** Best-effort compact details from persisted JSONL/session history. */
  compactEvents?: ContextCompactEvent[];
}

/**
 * Fallback estimate when no live Process exists (e.g. CLI-started session
 * opened in yepanywhere, or after server restart before the process is revived).
 */
export interface ContextStatusEstimatePayload {
  source: "jsonl";
  /** Model id read from the last assistant message in the JSONL. */
  model?: string;
  /**
   * Best-effort context window: from persisted ModelInfoService cache if known,
   * otherwise the heuristic from getModelContextWindow().
   */
  contextWindow: number;
  /** Whether the contextWindow came from a previously observed SDK value. */
  contextWindowFromCache: boolean;
  /** Same shape as the meter at the bottom of the input toolbar. */
  contextUsage?: ContextUsage;
  /** Cumulative token spend across the whole session (see ContextCumulativeUsage). */
  cumulativeUsage?: ContextCumulativeUsage;
  /** Best-effort compact details from persisted JSONL/session history. */
  compactEvents?: ContextCompactEvent[];
}

export type ContextStatusResponse =
  | ContextStatusSdkPayload
  | ContextStatusEstimatePayload;
