import { Link } from "react-router-dom";
import type { ProcessState } from "../hooks/useSession";
import { useI18n } from "../i18n";
import type { SessionStatus } from "../types";

interface ReadOnlySessionBarProps {
  sessionId: string;
  basePath: string;
  status: SessionStatus;
  processState: ProcessState;
}

/**
 * Replaces the composer for read-only DeepSeek Harness sessions: Yep shows
 * the transcript and live status, and the embedded dsh page owns input.
 */
export function ReadOnlySessionBar({
  sessionId,
  basePath,
  status,
  processState,
}: ReadOnlySessionBarProps) {
  const { t } = useI18n();
  const active = status.owner === "external";
  const message =
    active && processState === "waiting-input"
      ? t("dshSessionWaiting")
      : active
        ? t("dshSessionRunning")
        : t("dshSessionReadOnly");
  const tone = active
    ? processState === "waiting-input"
      ? "waiting"
      : "running"
    : "idle";

  return (
    <footer className="session-input read-only-session-bar">
      <div
        className={`session-input-inner read-only-session-bar-inner ${tone}`}
      >
        <p className="read-only-session-bar-text" role="status">
          {active && (
            <span className="read-only-session-bar-dot" aria-hidden="true" />
          )}
          {message}
        </p>
        <Link
          className="btn-primary read-only-session-bar-open"
          to={`${basePath}/dsh?session=${encodeURIComponent(sessionId)}`}
        >
          {t("dshOpenSession")}
        </Link>
      </div>
    </footer>
  );
}
