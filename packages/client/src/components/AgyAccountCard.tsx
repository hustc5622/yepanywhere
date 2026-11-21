import type { AgyAccountResponse, AgyLoginState } from "@yep-anywhere/shared";
import { useCallback, useEffect, useId, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";

const POLL_MS = 4_000;
const INSTALL_COMMAND =
  "curl -fsSL https://antigravity.google/cli/install.sh | bash";

interface Props {
  /** Reload provider discovery (models, auth badge) after a change. */
  onRefresh?: () => void | Promise<void>;
}

/**
 * Antigravity CLI sign-in for the Yep host. agy's terminal sign-in prints a
 * Google link and waits for the authorization code; Yep runs it on the host,
 * the user opens the link on this device and pastes the code back.
 */
export function AgyAccountCard({ onRefresh }: Props) {
  const { t } = useI18n();
  const headingId = useId();
  const codeId = useId();
  const [account, setAccount] = useState<AgyAccountResponse | null>(null);
  const [login, setLogin] = useState<AgyLoginState | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    void load();
  }, [load]);

  const settle = useCallback(async () => {
    await load(true);
    await onRefresh?.();
  }, [load, onRefresh]);

  // A pending sign-in can time out on the server or finish in another tab.
  const pending = login?.status === "pending" || login?.status === "submitting";
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.getAgyLogin();
        setLogin(next.login);
        if (next.login?.status === "completed") void settle();
      } catch {
        // Transient network errors are expected on mobile; keep polling.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, settle]);

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
      if (response.login?.status === "completed") await settle();
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
    });
  };

  const statusText = !account
    ? t("agyAccountChecking")
    : !account.installed
      ? null
      : account.authenticated
        ? t("agyAccountSignedIn")
        : t("agyAccountSignedOut");

  return (
    <section
      className="codex-usage-card agy-account-card"
      aria-labelledby={headingId}
      aria-busy={busy}
    >
      <div className="codex-account-heading">
        <div className="codex-account-identity">
          <strong id={headingId}>{t("agyAccountTitle")}</strong>
          {statusText && <span className="codex-usage-plan">{statusText}</span>}
        </div>
        <div className="codex-account-actions">
          <button
            type="button"
            className="codex-usage-refresh"
            disabled={busy}
            onClick={() => void run(settle)}
          >
            {t("agyAccountRefresh")}
          </button>
        </div>
      </div>
      <p className="codex-usage-state">{t("agyAccountHint")}</p>

      {account && !account.installed && (
        <div className="agy-account-install">
          <p className="codex-usage-state">{t("agyAccountNotInstalled")}</p>
          <code>{INSTALL_COMMAND}</code>
        </div>
      )}

      {account?.installed && login?.status === "pending" && login.authUrl && (
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
          <p className="codex-usage-state">{t("agyAccountLoginCompleted")}</p>
        )}
        {login?.status === "failed" && (
          <p className="codex-usage-state">
            {t("agyAccountLoginFailed", { error: login.error ?? "" })}
          </p>
        )}
        {login?.status === "canceled" && (
          <p className="codex-usage-state">{t("agyAccountLoginCanceled")}</p>
        )}
        {error && <p className="codex-usage-state">{error}</p>}
      </div>
    </section>
  );
}
