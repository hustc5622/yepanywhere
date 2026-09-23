import { useRef, useState } from "react";
import {
  type CodexAccountEntry,
  type CodexUsageResetCredit,
  api,
} from "../api/client";
import { useI18n } from "../i18n";
import { generateUUID } from "../lib/uuid";
import { Modal } from "./ui/Modal";

export function CodexResetCredits({
  entry,
  busy,
  onBusyChange,
  onRefresh,
}: {
  entry: CodexAccountEntry;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [creditId, setCreditId] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    credit: CodexUsageResetCredit | null;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Keep the key after an uncertain response, even if the dialog is reopened.
  const attempts = useRef(new Map<string, string>());
  const summary = entry.usage?.resetCredits;
  const credits = (summary?.credits ?? [])
    .filter((credit) => credit.status === "available")
    .sort(
      (a, b) =>
        (a.expiresAt ?? Number.POSITIVE_INFINITY) -
        (b.expiresAt ?? Number.POSITIVE_INFINITY),
    )
    .slice(0, Math.max(0, summary?.availableCount ?? 0));

  const expiryLabel = (credit: CodexUsageResetCredit | null): string => {
    if (credit?.expiresAt === null) return t("codexResetNoExpiry");
    if (
      credit?.expiresAt === undefined ||
      !Number.isFinite(new Date(credit.expiresAt * 1000).getTime())
    ) {
      return t("codexResetExpiryUnknown");
    }
    return t("codexResetExpiresAt", {
      time: new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(credit.expiresAt * 1000)),
    });
  };
  const expired = (credit: CodexUsageResetCredit | null) =>
    typeof credit?.expiresAt === "number" &&
    credit.expiresAt * 1000 <= Date.now();
  const selectedCredit =
    credits.find((credit) => credit.id === creditId) ??
    credits.find((credit) => !expired(credit)) ??
    credits[0] ??
    null;
  const creditLabel = (credit: CodexUsageResetCredit | null) =>
    [
      credit?.title,
      expiryLabel(credit),
      expired(credit) ? t("codexResetExpired") : null,
    ]
      .filter(Boolean)
      .join(" · ");

  const confirm = async () => {
    if (!selection || busy || inFlight.current || expired(selection.credit))
      return;
    const creditId = selection.credit?.id;
    const attemptId = creditId ?? "auto";
    let idempotencyKey = attempts.current.get(attemptId);
    if (!idempotencyKey) {
      idempotencyKey = generateUUID();
      attempts.current.set(attemptId, idempotencyKey);
    }
    inFlight.current = true;
    setSending(true);
    onBusyChange(true);
    setError(null);
    try {
      const { outcome } = await api.resetCodexAccountUsage(entry.id, {
        confirmed: true,
        idempotencyKey,
        ...(creditId ? { creditId } : {}),
      });
      const outcomes = {
        reset: "codexResetSuccess",
        alreadyRedeemed: "codexResetAlreadyRedeemed",
        nothingToReset: "codexResetNothingToReset",
        noCredit: "codexResetNoCredit",
      } as const;
      setMessage(t(outcomes[outcome]));
      attempts.current.delete(attemptId);
      setSelection(null);
      await onRefresh();
    } catch (cause) {
      setError(
        t("codexResetFailed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    } finally {
      inFlight.current = false;
      setSending(false);
      onBusyChange(false);
    }
  };

  const account =
    entry.account?.email ?? entry.label ?? t("codexAccountsDefaultName");
  return (
    <div className="codex-reset-credits">
      {summary && summary.availableCount > 0 && (
        <>
          <p className="codex-usage-reset-credit">
            {t("newSessionCodexUsageResetCredits", {
              count: summary.availableCount,
            })}
          </p>
          <div className="codex-reset-credit-row">
            {credits.length > 1 ? (
              <select
                className="codex-reset-credit-select"
                aria-label={t("codexResetSelectCredit")}
                title={creditLabel(selectedCredit)}
                value={selectedCredit?.id ?? ""}
                disabled={busy || sending}
                onChange={(event) => setCreditId(event.target.value)}
              >
                {credits.map((credit) => (
                  <option
                    key={credit.id}
                    value={credit.id}
                    disabled={expired(credit)}
                  >
                    {creditLabel(credit)}
                  </option>
                ))}
              </select>
            ) : (
              <span
                className="codex-reset-credit-detail"
                title={creditLabel(selectedCredit)}
              >
                {creditLabel(selectedCredit)}
              </span>
            )}
            <button
              type="button"
              className="codex-usage-refresh"
              disabled={busy || sending || expired(selectedCredit)}
              onClick={() => {
                setSelection({ credit: selectedCredit });
                setMessage(null);
                setError(null);
              }}
            >
              {t("codexResetAction")}
            </button>
          </div>
          {credits.length > 0 && credits.length < summary.availableCount && (
            <p className="codex-usage-state">{t("codexResetPartialDetails")}</p>
          )}
        </>
      )}
      {message && (
        <p className="codex-usage-state" role="status">
          {message}
        </p>
      )}
      {error && !selection && (
        <p className="codex-usage-state" role="alert">
          {error}
        </p>
      )}
      {selection && (
        <Modal
          title={t("codexResetConfirmTitle")}
          onClose={() => {
            if (!inFlight.current) setSelection(null);
          }}
        >
          <div className="codex-reset-confirm">
            <p>{t("codexResetConfirmBody", { account })}</p>
            <p>{expiryLabel(selection.credit)}</p>
            {selection.credit?.description && (
              <p>{selection.credit.description}</p>
            )}
            {error && <p role="alert">{error}</p>}
            <div className="codex-account-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={sending}
                onClick={() => setSelection(null)}
              >
                {t("codexResetCancel")}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || sending || expired(selection.credit)}
                onClick={() => void confirm()}
              >
                {t(sending ? "codexResetSending" : "codexResetConfirmAction")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
