import { useCallback, useEffect, useState } from "react";
import {
  type CodexAccountEntry,
  type CodexLoginMode,
  type CodexLoginState,
  type CodexUsageBucket,
  type CodexUsageResponse,
  type CodexUsageWindow,
  api,
} from "../api/client";
import { useI18n } from "../i18n";

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function formatResetTime(timestamp: number | null): string | null {
  if (!timestamp) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1_000));
}

function getWindowLabel(
  window: CodexUsageWindow,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (window.windowDurationMins === 300) {
    return t("newSessionCodexUsageFiveHours");
  }
  if (window.windowDurationMins === 10_080) {
    return t("newSessionCodexUsageWeekly");
  }
  if (window.windowDurationMins && window.windowDurationMins % 60 === 0) {
    return t("newSessionCodexUsageHours", {
      count: window.windowDurationMins / 60,
    });
  }
  return t("newSessionCodexUsageMinutes", {
    count: window.windowDurationMins ?? 0,
  });
}

function UsageWindow({ window }: { window: CodexUsageWindow }) {
  const { t } = useI18n();
  const usedPercent = clampPercent(window.usedPercent);
  const resetAt = formatResetTime(window.resetsAt);

  return (
    <div className="codex-usage-window">
      <div className="codex-usage-window-heading">
        <span>
          {getWindowLabel(window, t)}
          {resetAt && (
            <span className="codex-usage-reset">
              {t("newSessionCodexUsageResetAt", { time: resetAt })}
            </span>
          )}
        </span>
        <strong>
          {t("newSessionCodexUsageUsed", { percent: usedPercent })}
        </strong>
      </div>
      <div
        className="codex-usage-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedPercent}
        aria-label={getWindowLabel(window, t)}
        tabIndex={0}
      >
        <span
          className="codex-usage-progress-value"
          style={{ width: `${usedPercent}%` }}
        />
      </div>
    </div>
  );
}

function AdditionalBucket({ bucket }: { bucket: CodexUsageBucket }) {
  const { t } = useI18n();
  const windows = [bucket.primary, bucket.secondary].filter(
    (window): window is CodexUsageWindow => Boolean(window),
  );
  if (windows.length === 0) return null;

  return (
    <span className="codex-usage-additional-bucket">
      <span className="codex-usage-additional-name">
        {bucket.name ?? bucket.id}
      </span>
      <span className="codex-usage-additional-values">
        {windows
          .map((window) =>
            t("newSessionCodexUsageAdditionalValue", {
              window: getWindowLabel(window, t),
              percent: clampPercent(window.usedPercent),
            }),
          )
          .join(" · ")}
      </span>
    </span>
  );
}

interface ProviderUsageCardProps {
  provider: "claude" | "codex";
  load: (options?: { fresh?: boolean }) => Promise<CodexUsageResponse>;
}

function ProviderUsageCard({ provider, load }: ProviderUsageCardProps) {
  const { t } = useI18n();
  const [response, setResponse] = useState<CodexUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUsage = useCallback(
    async (fresh = false) => {
      setLoading(true);
      try {
        setResponse(await load({ fresh }));
      } catch {
        setResponse({ usage: null, error: "request-failed" });
      } finally {
        setLoading(false);
      }
    },
    [load],
  );

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const usage = response?.usage;
  const windows = [usage?.primary, usage?.secondary].filter(
    (window): window is CodexUsageWindow => Boolean(window),
  );

  return (
    <section
      className={`codex-usage-card ${provider === "claude" ? "claude-usage-card" : ""}`}
      aria-live="polite"
    >
      <div className="codex-usage-header">
        <div>
          <h3>
            {provider === "claude"
              ? t("newSessionClaudeUsageTitle")
              : t("newSessionCodexUsageTitle")}
          </h3>
          {usage?.planType && (
            <span className="codex-usage-plan">
              {t("newSessionCodexUsagePlan", { plan: usage.planType })}
            </span>
          )}
        </div>
        <button
          type="button"
          className="codex-usage-refresh"
          onClick={() => void loadUsage(true)}
          disabled={loading}
        >
          {loading
            ? t("newSessionCodexUsageRefreshing")
            : t("newSessionCodexUsageRefresh")}
        </button>
      </div>

      {loading && !usage ? (
        <p className="codex-usage-state">
          {provider === "claude"
            ? t("newSessionClaudeUsageLoading")
            : t("newSessionCodexUsageLoading")}
        </p>
      ) : windows.length > 0 ? (
        <>
          <div className="codex-usage-windows">
            {windows.map((window) => (
              <UsageWindow
                key={`${window.windowDurationMins}-${window.resetsAt}`}
                window={window}
              />
            ))}
          </div>
          {usage?.resetCredits && usage.resetCredits.availableCount > 0 && (
            <p className="codex-usage-reset-credit">
              {t("newSessionCodexUsageResetCredits", {
                count: usage.resetCredits.availableCount,
              })}
            </p>
          )}
          {usage && usage.additionalBuckets.length > 0 && (
            <div className="codex-usage-additional">
              <span className="codex-usage-additional-title">
                {provider === "claude"
                  ? t("newSessionClaudeUsageAdditionalTitle")
                  : t("newSessionCodexUsageAdditionalTitle")}
              </span>
              {usage.additionalBuckets.map((bucket) => (
                <AdditionalBucket key={bucket.id} bucket={bucket} />
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="codex-usage-state">
          {provider === "claude"
            ? t("newSessionClaudeUsageUnavailable")
            : t("newSessionCodexUsageUnavailable")}
        </p>
      )}
    </section>
  );
}

function AccountBlock({
  entry,
  busy,
  onRefresh,
  onBusyChange,
}: {
  entry: CodexAccountEntry;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [login, setLogin] = useState<CodexLoginState | null>(entry.login);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setLogin(entry.login);
  }, [entry.login]);

  // Poll the login flow until Codex reports success/failure.
  useEffect(() => {
    if (login?.status !== "pending") return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await api.getCodexAccountLogin(entry.id);
        if (cancelled) return;
        setLogin(next.login);
        if (next.login && next.login.status !== "pending") {
          clearInterval(timer);
          void onRefresh();
        }
      } catch {
        // keep polling; transient network errors are expected on mobile
      }
    }, 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [login?.status, entry.id, onRefresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>, refresh = true) => {
      onBusyChange(true);
      setActionError(null);
      try {
        await action();
        if (refresh) await onRefresh();
      } catch (error) {
        setActionError((error as Error).message);
      } finally {
        onBusyChange(false);
      }
    },
    [onBusyChange, onRefresh],
  );

  const startLogin = (mode: CodexLoginMode) =>
    run(async () => {
      const response = await api.startCodexAccountLogin(entry.id, mode);
      if (response.error) throw new Error(response.error);
      setLogin(response.login);
      const url = response.login?.authUrl ?? response.login?.verificationUrl;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    }, false);

  const usage = entry.usage;
  const windows = [usage?.primary, usage?.secondary].filter(
    (window): window is CodexUsageWindow => Boolean(window),
  );
  const title =
    entry.account?.email ??
    entry.label ??
    (entry.isDefault
      ? t("codexAccountsDefaultName")
      : t("codexAccountsUnnamed"));
  const signedIn = Boolean(entry.account) || windows.length > 0;
  const loginUrl = login?.authUrl ?? login?.verificationUrl ?? null;

  return (
    <div className="codex-account-block">
      <div className="codex-account-heading">
        <div className="codex-account-identity">
          <strong>{title}</strong>
          <span className="codex-usage-plan">
            {[
              entry.account?.planType
                ? t("newSessionCodexUsagePlan", {
                    plan: entry.account.planType,
                  })
                : null,
              entry.isActive ? t("codexAccountsActiveBadge") : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="codex-account-actions">
          {signedIn && !entry.isActive && (
            <button
              type="button"
              className="codex-usage-refresh"
              disabled={busy}
              onClick={() => void run(() => api.activateCodexAccount(entry.id))}
            >
              {t("codexAccountsUseAccount")}
            </button>
          )}
          {!entry.isDefault && (
            <button
              type="button"
              className="codex-usage-refresh"
              disabled={busy}
              onClick={() => void run(() => api.removeCodexAccount(entry.id))}
            >
              {t("codexAccountsRemove")}
            </button>
          )}
        </div>
      </div>

      {windows.length > 0 ? (
        <>
          <div className="codex-usage-windows">
            {windows.map((window) => (
              <UsageWindow
                key={`${window.windowDurationMins}-${window.resetsAt}`}
                window={window}
              />
            ))}
          </div>
          {usage?.resetCredits && usage.resetCredits.availableCount > 0 && (
            <p className="codex-usage-reset-credit">
              {t("newSessionCodexUsageResetCredits", {
                count: usage.resetCredits.availableCount,
              })}
            </p>
          )}
          {usage && usage.additionalBuckets.length > 0 && (
            <div className="codex-usage-additional">
              <span className="codex-usage-additional-title">
                {t("newSessionCodexUsageAdditionalTitle")}
              </span>
              {usage.additionalBuckets.map((bucket) => (
                <AdditionalBucket key={bucket.id} bucket={bucket} />
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="codex-usage-state">
          {entry.error === "not-signed-in"
            ? t("codexAccountsNotSignedIn")
            : (entry.error ?? t("newSessionCodexUsageUnavailable"))}
        </p>
      )}

      {login?.status === "pending" && loginUrl ? (
        <div className="codex-account-login">
          <a href={loginUrl} target="_blank" rel="noopener noreferrer">
            {login.mode === "deviceCode"
              ? t("codexAccountsOpenDeviceUrl")
              : t("codexAccountsOpenAuthUrl")}
          </a>
          {login.userCode && (
            <span className="codex-account-code">
              {t("codexAccountsUserCode", { code: login.userCode })}
            </span>
          )}
          <span className="codex-usage-state">{t("codexAccountsWaiting")}</span>
          <button
            type="button"
            className="codex-usage-refresh"
            onClick={() =>
              void run(() => api.cancelCodexAccountLogin(entry.id), false).then(
                () => setLogin(null),
              )
            }
          >
            {t("codexAccountsCancelLogin")}
          </button>
        </div>
      ) : (
        <div className="codex-account-login">
          <button
            type="button"
            className="codex-usage-refresh"
            disabled={busy}
            onClick={() => void startLogin("deviceCode")}
          >
            {signedIn
              ? t("codexAccountsReloginDevice")
              : t("codexAccountsLoginDevice")}
          </button>
          <button
            type="button"
            className="codex-usage-refresh"
            disabled={busy}
            onClick={() => void startLogin("browser")}
          >
            {t("codexAccountsLoginBrowser")}
          </button>
          {signedIn && (
            <button
              type="button"
              className="codex-usage-refresh"
              disabled={busy}
              onClick={() => void run(() => api.logoutCodexAccount(entry.id))}
            >
              {t("codexAccountsSignOut")}
            </button>
          )}
        </div>
      )}

      {login && login.status !== "pending" && login.status !== "none" && (
        <p className="codex-usage-state">
          {login.status === "completed"
            ? t("codexAccountsLoginCompleted")
            : t("codexAccountsLoginFailed", {
                error: login.error ?? login.status,
              })}
        </p>
      )}
      {actionError && <p className="codex-usage-state">{actionError}</p>}
    </div>
  );
}

export function CodexUsageCard() {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<CodexAccountEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const response = await api.getCodexAccounts({ fresh });
      setAccounts(response.accounts);
      setError(response.error);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  return (
    <section className="codex-usage-card" aria-live="polite">
      <div className="codex-usage-header">
        <h3>{t("newSessionCodexUsageTitle")}</h3>
        <div className="codex-account-actions">
          <button
            type="button"
            className="codex-usage-refresh"
            disabled={loading || busy}
            onClick={() => void refresh()}
          >
            {loading
              ? t("newSessionCodexUsageRefreshing")
              : t("newSessionCodexUsageRefresh")}
          </button>
          <button
            type="button"
            className="codex-usage-refresh"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  await api.addCodexAccount();
                  await load(true);
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {t("codexAccountsAdd")}
          </button>
        </div>
      </div>

      {loading && accounts.length === 0 ? (
        <p className="codex-usage-state">{t("newSessionCodexUsageLoading")}</p>
      ) : (
        <div className="codex-account-list">
          {accounts.map((entry) => (
            <AccountBlock
              key={entry.id}
              entry={entry}
              busy={busy}
              onRefresh={refresh}
              onBusyChange={setBusy}
            />
          ))}
        </div>
      )}
      {error && <p className="codex-usage-state">{error}</p>}
    </section>
  );
}

export function ClaudeUsageCard() {
  return <ProviderUsageCard provider="claude" load={api.getClaudeUsage} />;
}
