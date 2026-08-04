/**
 * Pure formatting helpers for subagent (Agent / AgentSwarm) stat chips.
 *
 * The golden rule enforced here: a value that was never measured is OMITTED,
 * never rendered as `0ms` / `0 tokens`. Callers pass a {@link SubagentMetrics}
 * whose fields are all optional; every formatter returns `undefined` when its
 * input is missing so the UI can hide the chip entirely.
 */
import type { SubagentMetrics, SubagentUsage } from "@yep-anywhere/shared";

/** Localizable labels used by the stat-chip formatter. */
export interface SubagentStatLabels {
  seconds: (count: number) => string;
  minutesSeconds: (minutes: number, seconds: number) => string;
  hoursMinutes: (hours: number, minutes: number) => string;
  tools: (count: number) => string;
  context: (tokens: string) => string;
  total: (tokens: string) => string;
}

const DEFAULT_SUBAGENT_STAT_LABELS: SubagentStatLabels = {
  seconds: (count) => `${count}s`,
  minutesSeconds: (minutes, seconds) => `${minutes}m ${seconds}s`,
  hoursMinutes: (hours, minutes) => `${hours}h ${minutes}m`,
  tools: (count) => `${count} tools`,
  context: (tokens) => `${tokens} ctx`,
  total: (tokens) => `${tokens} total`,
};

/** Compact a token count: 596509 → "596.5K", 1234567 → "1.2M", 940 → "940". */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) {
    // One decimal, trailing .0 trimmed: 43000→"43K", 66963→"67K", 596509→"596.5K".
    return `${trimZero((n / 1000).toFixed(1))}K`;
  }
  const m = n / 1_000_000;
  return `${trimZero(m.toFixed(m < 10 ? 1 : 0))}M`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * Human-readable elapsed duration: 265103 → "4m 25s", 45000 → "45s",
 * 3_665_000 → "1h 1m". Sub-second durations render as "0s" (they are only
 * shown when a real duration was measured).
 */
export function formatSubagentDuration(
  ms: number,
  labels: SubagentStatLabels = DEFAULT_SUBAGENT_STAT_LABELS,
): string {
  if (!Number.isFinite(ms) || ms < 0) return labels.seconds(0);
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return labels.hoursMinutes(hours, minutes);
  if (minutes > 0) return labels.minutesSeconds(minutes, seconds);
  return labels.seconds(seconds);
}

/**
 * Cumulative throughput = inputOther + inputCacheRead + inputCacheCreation +
 * output. Prefers the explicit `totalTokens` when the provider supplied it.
 * Returns undefined when no usage was recorded.
 */
export function subagentTotalTokens(
  usage: SubagentUsage | undefined,
): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  const parts = [
    usage.inputOther,
    usage.inputCacheRead,
    usage.inputCacheCreation,
    usage.output,
  ].filter((v): v is number => typeof v === "number");
  if (parts.length === 0) return undefined;
  return parts.reduce((a, b) => a + b, 0);
}

export interface SubagentStatChip {
  /** Machine key for testing / keys. */
  key: "elapsed" | "tools" | "steps" | "ctx" | "total";
  /** Rendered label, e.g. "4m 25s", "33 tools", "67K ctx", "596.5K total". */
  label: string;
}

/**
 * Build the compact stat chips shown in a subagent header. Missing metrics are
 * omitted (no zero-filled placeholders).
 *
 * Running example:  `2m 14s` · `18 tools` · `43K ctx`
 * Completed example:`4m 25s` · `33 tools` · `67K ctx` · `596.5K total`
 *
 * @param elapsedMs optional live elapsed override (a ticking clock for running
 *   agents); falls back to `metrics.durationMs`.
 */
export function buildSubagentStatChips(
  metrics: SubagentMetrics | undefined,
  options?: {
    elapsedMs?: number;
    showTotal?: boolean;
    labels?: SubagentStatLabels;
  },
): SubagentStatChip[] {
  const chips: SubagentStatChip[] = [];
  const labels = options?.labels ?? DEFAULT_SUBAGENT_STAT_LABELS;
  const durationMs = options?.elapsedMs ?? metrics?.durationMs;
  if (typeof durationMs === "number" && durationMs > 0) {
    chips.push({
      key: "elapsed",
      label: formatSubagentDuration(durationMs, labels),
    });
  }
  if (typeof metrics?.toolUseCount === "number" && metrics.toolUseCount > 0) {
    chips.push({ key: "tools", label: labels.tools(metrics.toolUseCount) });
  }
  const ctx = metrics?.usage?.contextTokens;
  if (typeof ctx === "number" && ctx > 0) {
    chips.push({ key: "ctx", label: labels.context(formatCompactTokens(ctx)) });
  }
  // The cumulative total is most meaningful once the run is done; callers pass
  // showTotal=false while running to avoid a moving number competing with ctx.
  if (options?.showTotal !== false) {
    const total = subagentTotalTokens(metrics?.usage);
    if (typeof total === "number" && total > 0) {
      chips.push({
        key: "total",
        label: labels.total(formatCompactTokens(total)),
      });
    }
  }
  return chips;
}

/** Join stat chips with the middot separator used across the renderer. */
export function joinStatChips(chips: SubagentStatChip[]): string {
  return chips.map((c) => c.label).join(" · ");
}
