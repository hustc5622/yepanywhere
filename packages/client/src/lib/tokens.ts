import type { ContextCumulativeUsage } from "../types";

export interface TokenUsageBreakdownRow {
  label: string;
  value: string;
  tone?: "muted";
}

/** Compact human-readable token count: 1234 -> "1.2K", 1234567 -> "1.2M". */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

export function getEffectiveTokenTotal(
  usage: ContextCumulativeUsage | undefined,
): number | null {
  if (!usage) return null;

  const total =
    usage.totalTokens !== undefined
      ? usage.totalTokens - usage.cacheReadTokens
      : usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens;

  return total > 0 ? total : null;
}

export function getRawTokenTotal(
  usage: ContextCumulativeUsage | undefined,
): number | null {
  if (!usage) return null;

  const total =
    usage.totalTokens ??
    usage.inputTokens +
      usage.outputTokens +
      usage.cacheReadTokens +
      usage.cacheCreationTokens;

  return total > 0 ? total : null;
}

export function formatTokenUsageBreakdown(
  usage: ContextCumulativeUsage | undefined,
): string | undefined {
  const rows = getTokenUsageBreakdownRows(usage);
  return rows.length > 0
    ? rows.map((row) => `${row.label}: ${row.value}`).join("\n")
    : undefined;
}

export function getTokenUsageBreakdownRows(
  usage: ContextCumulativeUsage | undefined,
): TokenUsageBreakdownRow[] {
  if (!usage) return [];

  const effectiveTotal = getEffectiveTokenTotal(usage);
  const rawTotal = getRawTokenTotal(usage);
  const rows: TokenUsageBreakdownRow[] = [];

  if (effectiveTotal !== null) {
    rows.push({
      label: "Effective",
      value: `${effectiveTotal.toLocaleString()} excl. cache`,
    });
  }
  if (usage.inputTokens > 0) {
    rows.push({ label: "Input", value: usage.inputTokens.toLocaleString() });
  }
  if (usage.cacheReadTokens > 0) {
    rows.push({
      label: "Cache read",
      value: usage.cacheReadTokens.toLocaleString(),
    });
  }
  if (usage.cacheCreationTokens > 0) {
    rows.push({
      label: "Cache create",
      value: usage.cacheCreationTokens.toLocaleString(),
    });
  }
  if (usage.outputTokens > 0) {
    rows.push({ label: "Output", value: usage.outputTokens.toLocaleString() });
  }
  if (rawTotal !== null && rawTotal !== effectiveTotal) {
    rows.push({
      label: "Raw total",
      value: rawTotal.toLocaleString(),
      tone: "muted",
    });
  }

  return rows;
}
