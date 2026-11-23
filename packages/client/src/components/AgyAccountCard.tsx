import type {
  AgyAccountResponse,
  AgyLoginState,
  AgyUsageBucket,
  AgyUsageGroup,
  AgyUsageResponse,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";

const POLL_MS = 4_000;
const INSTALL_COMMAND =
  "curl -fsSL https://antigravity.google/cli/install.sh | bash";
/** 5-hour window first, as Codex shows primary before secondary. */
const WINDOW_ORDER = ["5h", "weekly"];

interface Props {
  /** Reload provider discovery (models, auth badge) after a change. */
  onRefresh?: () => void | Promise<void>;
  /** Settings shows the details open; the new-session form starts collapsed. */
  defaultExpanded?: boolean;
}

type T = ReturnType<typeof useI18n>["t"];

function windowLabel(bucket: AgyUsageBucket, t: T): string {
  if (bucket.window === "5h") return t("newSessionCodexUsageFiveHours");
  if (bucket.window === "weekly") return t("newSessionCodexUsageWeekly");
  return bucket.name;
}

function formatResetTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function sortBuckets(buckets: AgyUsageBucket[]): AgyUsageBucket[] {
  const rank = (bucket: AgyUsageBucket) => {
    const index = WINDOW_ORDER.indexOf(bucket.window);
    return index === -1 ? WINDOW_ORDER.length : index;
  };
  return [...buckets].sort((a, b) => rank(a) - rank(b));
}

function UsageBucket({ bucket }: { bucket: AgyUsageBucket }) {
  const { t } = useI18n();
  // agy reports what is left; Codex shows what is used — align on "used".
  const usedPercent = Math.round((1 - bucket.remainingFraction) * 100);
  const resetAt = formatResetTime(bucket.resetTime);
  const label = windowLabel(bucket, t);
  return (
    <div className="codex-usage-window">
      <div className="codex-usage-window-heading">
        <span>
          {label}
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
        aria-label={label}
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

function UsageGroup({ group }: { group: AgyUsageGroup }) {
  const { t } = useI18n();
  if (group.buckets.length === 0) return null;
  return (
    <div className="agy-usage-group">
      <div className="agy-usage-group-heading">
        <strong>{group.name}</strong>
        {group.models.length > 0 && (
          <span className="codex-usage-plan">
            {t("agyUsageSharedModels", { models: group.models.join(", ") })}
          </span>
        )}
      </div>
      <div className="codex-usage-windows">
        {sortBuckets(group.buckets).map((bucket) => (
          <UsageBucket key={bucket.id} bucket={bucket} />
        ))}
      </div>
    </div>
  );
}

function UsageSection({
  usage,
  loading,
}: {
  usage: AgyUsageResponse | null;
  loading: boolean;
}) {
  const { t } = useI18n();
  if (!usage) {
    return loading ? (
      <p className="codex-usage-state">{t("agyUsageLoading")}</p>
    ) : null;
  }
  if (usage.state === "not-installed") return null;
  if (usage.state === "signed-out") {
    return <p className="codex-usage-state">{t("agyUsageSignedOut")}</p>;
  }
  if (usage.state !== "ok") {
    return (
      <p className="codex-usage-state">
        {usage.message
          ? t("agyUsageUnavailableWithReason", { error: usage.message })
          : t("agyUsageUnavailable")}
      </p>
    );
  }
  return (
    <div className="agy-usage">
      {usage.stale && (
        <p className="codex-usage-state" role="status">
          {usage.message
            ? t("agyUsageStaleWithReason", { reason: usage.message })
            : t("agyUsageStale")}
        </p>
      )}
      {usage.groups.map((group) => (
        <UsageGroup key={group.name} group={group} />
      ))}
      {usage.credits && (
        <p className="codex-usage-reset-credit agy-usage-credits">
          <span>
            {t("agyUsageCredits", { count: usage.credits.remaining })}
          </span>
          {usage.credits.upgradeUrl && (
            <a
              href={usage.credits.upgradeUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("agyUsageUpgrade")}
            </a>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Antigravity usage and sign-in for the Yep host, collapsible like the
 * Codex card. Quota comes from agy's read-only `/usage` and `/credits`
 * answers and is only read once the details are opened.
 *
 * agy's terminal sign-in prints a Google link and waits for the
 * authorization code; Yep runs it on the host, the user opens the link on
 * this device and pastes the code back.
 */
export function AgyAccountCard({ onRefresh, defaultExpanded = false }: Props) {
  const { t } = useI18n();
  const headingId = useId();
  const detailsId = useId();
  const codeId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [account, setAccount] = useState<AgyAccountResponse | null>(null);
  const [login, setLogin] = useState<AgyLoginState | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<AgyUsageResponse | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const usageRequested = useRef(false);

  const load = useCallback(async (fresh = false) => {
    try {
      const next = await api.getAgyAccount({ fresh });
      setAccount(next);
      // Keep a finished local result unless the server reports one; a
      // pending attempt the server no longer knows about is dropped.
      setLogin(
        (current) =>
          next.login ??
          (current &&
          current.status !== "pending" &&
          current.status !== "submitting"
            ? current
            : null),
      );
      setError(null);
    } catch (loadError) {
      setError((loadError as Error).message);
    }
  }, []);

  const loadUsage = useCallback(async (fresh = false) => {
    usageRequested.current = true;
    setUsageLoading(true);
    try {
      setUsage(await api.getAgyUsage({ fresh }));
    } catch (usageError) {
      setUsage((previous) => {
        if (previous && previous.state === "ok") {
          return {
            ...previous,
            stale: true,
            message: (usageError as Error).message,
          };
        }
        return {
          state: "error",
          groups: [],
          credits: null,
          message: (usageError as Error).message,
          fetchedAt: null,
        };
      });
    } finally {
      setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Reading quota spawns agy on the host; only do it once someone looks.
  const signedIn = Boolean(account?.installed && account.authenticated);
  useEffect(() => {
    if (expanded && signedIn && !usageRequested.current) void loadUsage();
  }, [expanded, signedIn, loadUsage]);

  const settle = useCallback(async () => {
    await load(true);
    await onRefresh?.();
  }, [load, onRefresh]);

  const settleAll = useCallback(async () => {
    await settle();
    await loadUsage(true);
  }, [settle, loadUsage]);

  // A pending sign-in can time out on the server or finish in another tab.
  const pending = login?.status === "pending" || login?.status === "submitting";
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.getAgyLogin();
        setLogin(next.login);
        if (next.login?.status === "completed") void settleAll();
      } catch {
        // Transient network errors are expected on mobile; keep polling.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, settleAll]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const startLogin = () =>
    run(async () => {
      setCode("");
      const response = await api.startAgyLogin();
      if (response.error) throw new Error(response.error);
      setLogin(response.login);
    });

  const submitCode = () =>
    run(async () => {
      setLogin((current) =>
        current ? { ...current, status: "submitting" } : current,
      );
      const response = await api.submitAgyLoginCode(code.trim());
      setLogin(response.login);
      setCode("");
      if (response.login?.status === "completed") await settleAll();
    });

  const cancelLogin = () =>
    run(async () => {
      await api.cancelAgyLogin();
      setLogin(null);
      setCode("");
    });

  const signOut = () => {
    if (!window.confirm(t("agyAccountSignOutConfirm"))) return;
    void run(async () => {
      await api.logoutAgy();
      await settle();
      setUsage(null);
      usageRequested.current = false;
    });
  };

  const refresh = () =>
    void run(async () => {
      await settle();
      // Signed-out or uninstalled hosts have no quota to read.
      if (usageRequested.current || signedIn) await loadUsage(true);
    });

  const statusText = !account
    ? t("agyAccountChecking")
    : !account.installed
      ? null
      : account.authenticated
        ? t("agyAccountSignedIn")
        : t("agyAccountSignedOut");

  return (
    <section
      className="codex-usage-card codex-usage-card-collapsible agy-account-card"
      aria-labelledby={headingId}
      aria-busy={busy || usageLoading}
    >
      <h3 className="codex-usage-disclosure-heading">
        <button
          type="button"
          id={headingId}
          className="codex-usage-disclosure"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{t("agyUsageTitle")}</span>
          <span className="codex-usage-disclosure-action">
            {expanded
              ? t("newSessionCodexUsageCollapse")
              : t("newSessionCodexUsageExpand")}
            <svg
              className="codex-usage-disclosure-chevron"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </button>
      </h3>
      {/* Keep login polling alive while collapsed. */}
      <div id={detailsId} className="codex-usage-details" hidden={!expanded}>
        <div className="codex-account-block agy-account-body">
          <div className="codex-account-heading">
            <div className="codex-account-identity">
              <strong>{t("agyAccountTitle")}</strong>
              {statusText && (
                <span className="codex-usage-plan">{statusText}</span>
              )}
            </div>
            <div className="codex-account-actions">
              <button
                type="button"
                className="codex-usage-refresh"
                disabled={busy || usageLoading}
                onClick={refresh}
              >
                {usageLoading
                  ? t("newSessionCodexUsageRefreshing")
                  : t("agyAccountRefresh")}
              </button>
            </div>
          </div>

          <div aria-live="polite">
            {signedIn && <UsageSection usage={usage} loading={usageLoading} />}
          </div>

          <p className="codex-usage-state">{t("agyAccountHint")}</p>

          {account && !account.installed && (
            <div className="agy-account-install">
              <p className="codex-usage-state">{t("agyAccountNotInstalled")}</p>
              <code>{INSTALL_COMMAND}</code>
            </div>
          )}

          {account?.installed &&
            login?.status === "pending" &&
            login.authUrl && (
              <ol className="agy-account-steps">
                <li>
                  <span>{t("agyAccountStepOpen")}</span>
                  <a
                    className="codex-usage-refresh"
                    href={login.authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("agyAccountOpenLink")}
                  </a>
                </li>
                <li>
                  <label htmlFor={codeId}>{t("agyAccountStepPaste")}</label>
                  <form
                    className="agy-account-code-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (code.trim()) void submitCode();
                    }}
                  >
                    <input
                      id={codeId}
                      type="text"
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={code}
                      placeholder={t("agyAccountCodePlaceholder")}
                      onChange={(event) => setCode(event.target.value)}
                      disabled={busy}
                    />
                    <div className="codex-account-login">
                      <button
                        type="submit"
                        className="codex-usage-refresh"
                        disabled={busy || !code.trim()}
                      >
                        {t("agyAccountSubmit")}
                      </button>
                      <button
                        type="button"
                        className="codex-usage-refresh"
                        disabled={busy}
                        onClick={() => void cancelLogin()}
                      >
                        {t("agyAccountCancel")}
                      </button>
                    </div>
                  </form>
                </li>
              </ol>
            )}

          {login?.status === "submitting" && (
            <p className="codex-usage-state" role="status">
              {t("agyAccountVerifying")}
            </p>
          )}

          {account?.installed && !pending && (
            <div className="codex-account-login">
              <button
                type="button"
                className="codex-usage-refresh"
                disabled={busy}
                onClick={() => void startLogin()}
              >
                {account.authenticated
                  ? t("agyAccountSignInAgain")
                  : t("agyAccountSignIn")}
              </button>
              {account.authenticated && (
                <button
                  type="button"
                  className="codex-usage-refresh"
                  disabled={busy}
                  onClick={signOut}
                >
                  {t("agyAccountSignOut")}
                </button>
              )}
            </div>
          )}

          <div aria-live="polite">
            {login?.status === "completed" && (
              <p className="codex-usage-state">
                {t("agyAccountLoginCompleted")}
              </p>
            )}
            {login?.status === "failed" && (
              <p className="codex-usage-state">
                {t("agyAccountLoginFailed", { error: login.error ?? "" })}
              </p>
            )}
            {login?.status === "canceled" && (
              <p className="codex-usage-state">
                {t("agyAccountLoginCanceled")}
              </p>
            )}
            {error && <p className="codex-usage-state">{error}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
