import { useEffect } from "react";
import type { CodexAccountEntry } from "../api/client";
import { useCodexAccounts } from "../hooks/useCodexAccounts";
import { useI18n } from "../i18n";
import { visibleCodexAccounts } from "../lib/codexAccounts";
import { NewSessionAccountSkeleton } from "./NewSessionSkeleton";

const DEFAULT_ACCOUNT_ID = "default";

interface CodexAccountSelectProps {
  /** Selected account id; `null`/"default" means the machine-wide login. */
  value: string | null;
  onChange: (accountId: string | null) => void;
  disabled?: boolean;
}

function usageSummary(
  entry: CodexAccountEntry,
  t: ReturnType<typeof useI18n>["t"],
): string | null {
  const windows = [entry.usage?.primary, entry.usage?.secondary].filter(
    (window): window is NonNullable<typeof window> => Boolean(window),
  );
  if (windows.length === 0) return null;
  return windows
    .map((window) => {
      const percent = Math.round(
        Math.min(100, Math.max(0, window.usedPercent)),
      );
      const label =
        window.windowDurationMins === 300
          ? t("newSessionCodexUsageFiveHours")
          : window.windowDurationMins === 10_080
            ? t("newSessionCodexUsageWeekly")
            : t("newSessionCodexUsageMinutes", {
                count: window.windowDurationMins ?? 0,
              });
      return `${label} ${percent}%`;
    })
    .join(" · ");
}

/**
 * Picks which Codex account (isolated `CODEX_HOME`) runs the new session.
 *
 * Accounts without credentials are listed but not selectable: signing in
 * happens in the usage card below, which owns the login flow.
 */
export function CodexAccountSelect({
  value,
  onChange,
  disabled,
}: CodexAccountSelectProps) {
  const { t } = useI18n();
  const { accounts: snapshot, loading, error } = useCodexAccounts();
  const accounts = snapshot ?? [];

  const selectedId = value ?? DEFAULT_ACCOUNT_ID;
  const visibleAccounts = visibleCodexAccounts(accounts);
  const selectedAccount = accounts.find((entry) => entry.id === selectedId);
  const displayedSelectedId =
    selectedAccount?.isActive && accounts.some((entry) => entry.isDefault)
      ? DEFAULT_ACCOUNT_ID
      : selectedId;

  // Fall back to the machine account when the saved selection disappeared
  // (account removed) or lost its credentials.
  useEffect(() => {
    if (loading || error || accounts.length === 0) return;
    const selected = accounts.find((entry) => entry.id === selectedId);
    const usable =
      selected && (selected.isDefault || Boolean(selected.account));
    if (!usable && selectedId !== DEFAULT_ACCOUNT_ID) {
      onChange(null);
    }
  }, [accounts, loading, error, selectedId, onChange]);

  if (loading && snapshot === null) {
    return <NewSessionAccountSkeleton provider="codex" />;
  }

  // A single machine account is the common case; no need for a picker.
  if (visibleAccounts.length <= 1) return null;

  return (
    <div className="new-session-codex-account-section" aria-busy={loading}>
      <h3>{t("newSessionCodexAccountTitle")}</h3>
      <p className="new-session-section-hint">
        {t("newSessionCodexAccountDescription")}
      </p>
      <div className="codex-mcp-options">
        {visibleAccounts.map((entry) => {
          const signedIn = entry.isDefault || Boolean(entry.account);
          const summary = usageSummary(entry, t);
          const name =
            entry.account?.email ??
            entry.label ??
            (entry.isDefault
              ? t("codexAccountsDefaultName")
              : t("codexAccountsUnnamed"));
          return (
            <button
              key={entry.id}
              type="button"
              className={`mode-option codex-mcp-option ${
                displayedSelectedId === entry.id ? "selected" : ""
              }`}
              onClick={() =>
                onChange(entry.id === DEFAULT_ACCOUNT_ID ? null : entry.id)
              }
              disabled={disabled || loading || !signedIn}
              aria-pressed={displayedSelectedId === entry.id}
            >
              <span
                className="mode-option-dot codex-mcp-standard"
                aria-hidden
              />
              <div className="mode-option-content">
                <span className="mode-option-label">{name}</span>
                <span className="mode-option-desc">
                  {signedIn
                    ? [
                        entry.account?.planType
                          ? t("newSessionCodexUsagePlan", {
                              plan: entry.account.planType,
                            })
                          : null,
                        summary,
                      ]
                        .filter(Boolean)
                        .join(" · ") || t("newSessionCodexAccountReady")
                    : t("codexAccountsNotSignedIn")}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
