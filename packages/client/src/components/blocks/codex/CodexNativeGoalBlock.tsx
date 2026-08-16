import { useOptionalI18n } from "../../../i18n";

interface Props {
  objective: string | undefined;
  status: string | undefined;
  tokenBudget: number | null | undefined;
  tokensUsed: number | undefined;
  timeUsedSeconds: number | undefined;
}

function statusClassName(status: string | undefined): string {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "complete":
      return "complete";
    case "blocked":
    case "budgetLimited":
    case "usageLimited":
      return "limited";
    default:
      return "unknown";
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatTokens(used: number, budget?: number | null): string {
  const formatNumber = (value: number): string => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return String(value);
  };
  if (budget !== undefined && budget !== null && budget > 0) {
    return `${formatNumber(used)} / ${formatNumber(budget)}`;
  }
  return formatNumber(used);
}

/**
 * Renders a Codex thread-level goal snapshot.
 *
 * Codex emits `thread/goal/updated` with a full goal snapshot on every
 * mutation; the canonical overlay retains only the latest state per thread and
 * projects it as a `threadGoal` native item. This block surfaces the objective,
 * status, token usage/budget, and elapsed time, mirroring the Codex TUI `goal_display.rs`
 * `goal_usage_summary` output.
 */
export function CodexNativeGoalBlock({
  objective,
  status,
  tokenBudget,
  tokensUsed,
  timeUsedSeconds,
}: Props) {
  const i18n = useOptionalI18n();
  const t = i18n?.t;
  if (!objective) return null;

  const statusLabel = (() => {
    switch (status) {
      case "active":
        return t?.("codexNativeGoalStatusActive") ?? "Active";
      case "paused":
        return t?.("codexNativeGoalStatusPaused") ?? "Paused";
      case "blocked":
        return t?.("codexNativeGoalStatusBlocked") ?? "Blocked";
      case "usageLimited":
        return t?.("codexNativeGoalStatusUsageLimited") ?? "Usage limited";
      case "budgetLimited":
        return t?.("codexNativeGoalStatusBudgetLimited") ?? "Budget limited";
      case "complete":
        return t?.("codexNativeGoalStatusComplete") ?? "Complete";
      default:
        return status ?? t?.("codexNativeGoalStatusUnknown") ?? "Unknown";
    }
  })();
  const tokens =
    tokensUsed !== undefined
      ? formatTokens(tokensUsed, tokenBudget)
      : undefined;
  const time =
    timeUsedSeconds !== undefined && timeUsedSeconds > 0
      ? formatDuration(timeUsedSeconds)
      : undefined;

  return (
    <div
      className={`codex-native-goal codex-native-goal-${statusClassName(status)}`}
    >
      <div className="codex-native-goal-header">
        <span className="codex-native-goal-icon">◎</span>
        <span className="codex-native-goal-label">
          {t?.("codexNativeGoal") ?? "Goal"}
        </span>
        <span
          className={`codex-native-goal-status status-${statusClassName(status)}`}
        >
          {statusLabel}
        </span>
      </div>
      <div className="codex-native-goal-objective">{objective}</div>
      {(tokens || time) && (
        <div className="codex-native-goal-usage">
          {tokens && (
            <span className="codex-native-goal-usage-item">
              {t?.("codexNativeTokens", { value: tokens }) ??
                `Tokens: ${tokens}`}
            </span>
          )}
          {time && (
            <span className="codex-native-goal-usage-item">
              {t?.("codexNativeTime", { value: time }) ?? `Time: ${time}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
