import type { KimiGoalSnapshot } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { useOptionalI18n } from "../../i18n";

type Translate = NonNullable<ReturnType<typeof useOptionalI18n>>["t"];

const STATUS_META: Record<
  KimiGoalSnapshot["status"],
  { className: string; icon: string }
> = {
  active: { className: "kimi-goal-status-active", icon: "▶" },
  paused: { className: "kimi-goal-status-paused", icon: "⏸" },
  blocked: {
    className: "kimi-goal-status-blocked",
    icon: "⛔",
  },
  complete: {
    className: "kimi-goal-status-complete",
    icon: "✓",
  },
  cleared: {
    className: "kimi-goal-status-cleared",
    icon: "•",
  },
};

function statusLabel(
  status: KimiGoalSnapshot["status"],
  t: Translate | undefined,
): string {
  switch (status) {
    case "active":
      return t?.("kimiGoalStatusActive") ?? "Active";
    case "paused":
      return t?.("kimiGoalStatusPaused") ?? "Paused";
    case "blocked":
      return t?.("kimiGoalStatusBlocked") ?? "Blocked";
    case "complete":
      return t?.("kimiGoalStatusComplete") ?? "Complete";
    case "cleared":
      return t?.("kimiGoalStatusCleared") ?? "Cleared";
  }
}

function actorLabel(actor: string, t: Translate | undefined): string {
  switch (actor) {
    case "user":
      return t?.("kimiGoalActorUser") ?? "user";
    case "model":
      return t?.("kimiGoalActorModel") ?? "model";
    case "runtime":
      return t?.("kimiGoalActorRuntime") ?? "runtime";
    case "system":
      return t?.("kimiGoalActorSystem") ?? "system";
    default:
      return actor;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function BudgetBar({
  used,
  budget,
  label,
  formatValue,
}: {
  used: number | undefined;
  budget: number | undefined;
  label: string;
  formatValue: (v: number) => string;
}): ReactNode {
  if (budget === undefined) {
    if (used === undefined || used === 0) return null;
    return (
      <div className="kimi-goal-metric">
        <span className="kimi-goal-metric-label">{label}</span>
        <span className="kimi-goal-metric-value">{formatValue(used)}</span>
      </div>
    );
  }
  const percentage =
    budget <= 0
      ? (used ?? 0) > 0
        ? 100
        : 0
      : used !== undefined
        ? Math.min(100, (used / budget) * 100)
        : 0;
  const warning = percentage >= 80;
  return (
    <div className="kimi-goal-metric kimi-goal-metric-budget">
      <div className="kimi-goal-metric-header">
        <span className="kimi-goal-metric-label">{label}</span>
        <span
          className={`kimi-goal-metric-value ${warning ? "kimi-goal-metric-warning" : ""}`}
        >
          {used !== undefined ? formatValue(used) : "0"} / {formatValue(budget)}
        </span>
      </div>
      <div className="kimi-goal-progress-bar">
        <div
          className={`kimi-goal-progress-fill ${warning ? "kimi-goal-progress-warning" : ""}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Inline renderer for Kimi goal lifecycle snapshots.
 *
 * Renders a compact card showing the goal objective, status badge, and budget
 * consumption (turns / tokens / wall-clock). `created` snapshots show the full
 * objective; `progress` snapshots show a lightweight metric update; `status`
 * snapshots highlight the transition; `cleared` shows the final tally.
 */
export function GoalInlineBlock({
  snapshot,
}: {
  snapshot: KimiGoalSnapshot;
}): ReactNode {
  const i18n = useOptionalI18n();
  const t = i18n?.t;
  const meta = STATUS_META[snapshot.status] ?? STATUS_META.active;
  const isCreated = snapshot.change === "created";
  const isCleared = snapshot.change === "cleared";
  const isStatusChange = snapshot.change === "status";

  if (isCleared) {
    return (
      <div className="kimi-goal-card kimi-goal-card-cleared">
        <span className="kimi-goal-status-badge kimi-goal-status-cleared">
          {meta.icon} {t?.("kimiGoalCleared") ?? "Goal cleared"}
        </span>
        {snapshot.objective && (
          <span className="kimi-goal-objective kimi-goal-objective-muted">
            {snapshot.objective}
          </span>
        )}
        <div className="kimi-goal-metrics-row">
          <BudgetBar
            used={snapshot.turnsUsed}
            budget={snapshot.budgetLimits?.turnBudget}
            label={t?.("kimiGoalTurns") ?? "Turns"}
            formatValue={String}
          />
          <BudgetBar
            used={snapshot.tokensUsed}
            budget={snapshot.budgetLimits?.tokenBudget}
            label={t?.("kimiGoalTokens") ?? "Tokens"}
            formatValue={formatTokens}
          />
          {snapshot.wallClockMs !== undefined && (
            <div className="kimi-goal-metric">
              <span className="kimi-goal-metric-label">
                {t?.("kimiGoalWallClock") ?? "Wall clock"}
              </span>
              <span className="kimi-goal-metric-value">
                {formatDuration(snapshot.wallClockMs)}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`kimi-goal-card ${isStatusChange ? "kimi-goal-card-status" : ""} ${isCreated ? "kimi-goal-card-created" : ""}`}
    >
      <div className="kimi-goal-header">
        <span className={`kimi-goal-status-badge ${meta.className}`}>
          {meta.icon} {statusLabel(snapshot.status, t)}
        </span>
        {snapshot.actor && (
          <span className="kimi-goal-actor">
            {t?.("kimiGoalBy", {
              actor: actorLabel(snapshot.actor, t),
            }) ?? `by ${snapshot.actor}`}
          </span>
        )}
      </div>
      {snapshot.objective && (
        <div className="kimi-goal-objective">{snapshot.objective}</div>
      )}
      {snapshot.reason && isStatusChange && (
        <div className="kimi-goal-reason">
          {t?.("kimiGoalReason", { reason: snapshot.reason }) ??
            `Reason: ${snapshot.reason}`}
        </div>
      )}
      {snapshot.completionCriterion && isCreated && (
        <div className="kimi-goal-criterion">
          {t?.("kimiGoalCompletionCriterion", {
            criterion: snapshot.completionCriterion,
          }) ?? `Completion criterion: ${snapshot.completionCriterion}`}
        </div>
      )}
      <div className="kimi-goal-metrics-row">
        <BudgetBar
          used={snapshot.turnsUsed}
          budget={snapshot.budgetLimits?.turnBudget}
          label={t?.("kimiGoalTurns") ?? "Turns"}
          formatValue={String}
        />
        <BudgetBar
          used={snapshot.tokensUsed}
          budget={snapshot.budgetLimits?.tokenBudget}
          label={t?.("kimiGoalTokens") ?? "Tokens"}
          formatValue={formatTokens}
        />
        {snapshot.wallClockMs !== undefined && (
          <div className="kimi-goal-metric">
            <span className="kimi-goal-metric-label">
              {t?.("kimiGoalWallClock") ?? "Wall clock"}
            </span>
            <span className="kimi-goal-metric-value">
              {formatDuration(snapshot.wallClockMs)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
