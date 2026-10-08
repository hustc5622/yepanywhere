import { useElapsedLabel } from "../../../hooks/useElapsedLabel";
import { useOptionalI18n } from "../../../i18n";
import { codexAgentFallbackText } from "../../../lib/codexAgentStatus";
import { formatElapsed } from "../../../lib/formatElapsed";

interface Props {
  status?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  outcome?: string;
}

function finishedDuration({
  startedAt,
  completedAt,
  durationMs,
}: Props): number | null {
  if (
    typeof durationMs === "number" &&
    Number.isFinite(durationMs) &&
    durationMs >= 0
  )
    return durationMs;
  if (!startedAt || !completedAt) return null;
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

/** Waiting is an action of this conversation's agent, not a child task. */
export function CodexAgentWaitBlock(props: Props) {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? codexAgentFallbackText;
  const running = props.status === "running";
  const live = useElapsedLabel(props.startedAt, running);
  const elapsed = running ? null : finishedDuration(props);
  const duration = running
    ? live?.label
    : elapsed === null
      ? undefined
      : elapsed < 60_000
        ? `${new Intl.NumberFormat(i18n?.locale ?? "en", { maximumFractionDigits: 1 }).format(elapsed / 1000)}s`
        : formatElapsed(elapsed);
  const label = t(
    running
      ? "codexAgentWaitRunning"
      : props.status === "failed"
        ? "codexAgentWaitFailed"
        : props.outcome === "user_input"
          ? "codexAgentWaitUserInput"
          : props.status === "interrupted"
            ? "codexAgentWaitInterrupted"
            : props.outcome === "timeout"
              ? "codexAgentWaitTimedOut"
              : props.outcome === "message"
                ? "codexAgentWaitUpdate"
                : "codexAgentWaitFinished",
  );

  return (
    <div className={`codex-agent-wait${running ? " is-running" : ""}`}>
      {running ? (
        <span className="codex-agent-wait-spinner" aria-hidden="true" />
      ) : (
        <svg
          className="codex-agent-wait-clock"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="7" />
          <path d="M10 5.5V10l3 1.5" />
        </svg>
      )}
      <span role="status" className="codex-agent-wait-label">
        {label}
      </span>
      <span className="codex-agent-wait-duration" aria-live="off">
        {duration
          ? t("codexAgentWaitElapsed", { duration })
          : t("codexAgentWaitDurationUnavailable")}
      </span>
    </div>
  );
}
