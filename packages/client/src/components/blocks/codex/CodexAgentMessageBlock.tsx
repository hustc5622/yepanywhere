import { useOptionalI18n } from "../../../i18n";
import { codexAgentFallbackText } from "../../../lib/codexAgentStatus";
import { TextBlock } from "../TextBlock";

interface Props {
  kind?: string;
  sender?: string;
  recipient?: string;
  text?: string;
  encrypted: boolean;
  truncated?: boolean;
  resultAlreadyShown?: boolean;
  timestamp?: string;
}

/** A routed message is a handoff, not another answer from the current agent. */
export function CodexAgentMessageBlock({
  kind,
  sender,
  recipient,
  text,
  encrypted,
  truncated,
  resultAlreadyShown,
  timestamp,
}: Props) {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? codexAgentFallbackText;
  const title = t(
    kind === "task"
      ? "codexAgentAssignedTask"
      : kind === "result"
        ? "codexAgentReturnedResult"
        : "codexAgentCommunication",
  );
  const agentLabel = (path: string) =>
    path === "/root" ? t("codexAgentMainAgent") : path;
  const date = timestamp ? new Date(timestamp) : undefined;
  const validDate = date && Number.isFinite(date.getTime()) ? date : undefined;

  return (
    <section
      className={`codex-agent-message codex-agent-message-${kind ?? "message"}`}
      aria-label={title}
    >
      <div className="codex-agent-message-heading">
        <strong>{title}</strong>
        {validDate && (
          <time
            dateTime={timestamp}
            title={validDate.toLocaleString(i18n?.locale)}
          >
            {validDate.toLocaleTimeString(i18n?.locale, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
        )}
      </div>
      {sender && recipient && (
        <p className="codex-agent-message-route">
          {t("codexAgentMessageRoute", {
            sender: agentLabel(sender),
            recipient: agentLabel(recipient),
          })}
        </p>
      )}
      {text && <TextBlock text={text} />}
      {encrypted && (
        <p className="codex-agent-message-note">
          {t("codexAgentEncryptedMessage")}
        </p>
      )}
      {truncated && (
        <p className="codex-agent-message-note">
          {t("codexAgentMessageTruncated")}
        </p>
      )}
      {resultAlreadyShown && (
        <p className="codex-agent-message-note">
          {t("codexAgentResultDelivered")}
        </p>
      )}
      {!text && !encrypted && !resultAlreadyShown && (
        <p className="codex-agent-message-note">
          {t("codexAgentMessageUnavailable")}
        </p>
      )}
    </section>
  );
}
