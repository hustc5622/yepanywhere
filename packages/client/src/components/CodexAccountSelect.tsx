import { useCallback, useEffect, useState } from "react";
import { type CodexAccountEntry, api } from "../api/client";
import { useI18n } from "../i18n";

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
  const [accounts, setAccounts] = useState<CodexAccountEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.getCodexAccounts();
      setAccounts(response.accounts);
    } catch {
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedId = value ?? DEFAULT_ACCOUNT_ID;

  // Fall back to the machine account when the saved selection disappeared
  // (account removed) or lost its credentials.
  useEffect(() => {
    if (loading || accounts.length === 0) return;
    const selected = accounts.find((entry) => entry.id === selectedId);
    const usable =
      selected && (selected.isDefault || Boolean(selected.account));
    if (!usable && selectedId !== DEFAULT_ACCOUNT_ID) {
      onChange(null);
    }
  }, [accounts, loading, selectedId, onChange]);

  // A single machine account is the common case; no need for a picker.
  if (!loading && accounts.length <= 1) return null;

  return (
    <div className="new-session-codex-account-section">
      <h3>{t("newSessionCodexAccountTitle")}</h3>
      <p className="new-session-section-hint">
        {t("newSessionCodexAccountDescription")}
      </p>
      <div className="codex-mcp-options">
        {accounts.map((entry) => {
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
                selectedId === entry.id ? "selected" : ""
              }`}
              onClick={() =>
                onChange(entry.id === DEFAULT_ACCOUNT_ID ? null : entry.id)
              }
              disabled={disabled || !signedIn}
              aria-pressed={selectedId === entry.id}
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
