/**
 * LoginPage - Login form for cookie-based auth and one-time pairing links.
 *
 * Shows setup form when no account exists, automatically redeems `#pair=`
 * one-time device pairing tokens, and otherwise shows the password login form.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ApiError } from "../api/client";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useAuth } from "../contexts/AuthContext";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import { useI18n } from "../i18n";

type Translate = ReturnType<typeof useI18n>["t"];

/** Seconds left before a retry is allowed, rendered as m:ss. */
function formatCountdown(totalSec: number): string {
  const clamped = Math.max(0, Math.ceil(totalSec));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Lockout length in the coarsest unit that stays exact enough to act on. */
function formatLockout(seconds: number, t: Translate): string {
  if (seconds < 60) {
    return t("loginDurationSeconds", {
      count: Math.max(1, Math.round(seconds)),
    });
  }
  return t("loginDurationMinutes", { count: Math.round(seconds / 60) });
}

interface LockoutState {
  /** Epoch ms at which the client may retry. */
  deadline: number;
  /** Full length of the applied lockout, for the "how long" message. */
  durationSec: number;
  tier: "soft" | "hard" | "global";
}

interface AttemptWarning {
  /** Failed attempts still allowed before the next lockout. */
  remaining: number;
  /** Lockout the next failure triggers. */
  lockoutSec: number;
}

function sanitizeRedirectTarget(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/projects";
  }
  return raw;
}

function extractPairingToken(): string | null {
  if (typeof window === "undefined") return null;

  const hash = window.location.hash;
  if (hash) {
    const hashParams = new URLSearchParams(
      hash.startsWith("#") ? hash.slice(1) : hash,
    );
    const fromHash = hashParams.get("pair")?.trim();
    if (fromHash) return fromHash;
  }

  const searchParams = new URLSearchParams(window.location.search);
  const fromQuery = searchParams.get("pair")?.trim();
  return fromQuery || null;
}

function scrubPairingTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;

  if (url.hash) {
    const hashParams = new URLSearchParams(
      url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
    );
    if (hashParams.has("pair")) {
      hashParams.delete("pair");
      const nextHash = hashParams.toString();
      url.hash = nextHash ? `#${nextHash}` : "";
      changed = true;
    }
  }

  if (url.searchParams.has("pair")) {
    url.searchParams.delete("pair");
    changed = true;
  }

  if (changed) {
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
}

function isInsecureNonLocalHttp(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.protocol !== "http:") return false;
  const host = window.location.hostname.toLowerCase();
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
}

export function LoginPage() {
  const { t } = useI18n();
  const {
    isSetupMode,
    login,
    redeemPairing,
    setupAccount,
    isLoading,
    authEnabled,
    authDisabledByEnv,
    isAuthenticated,
  } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attemptWarning, setAttemptWarning] = useState<AttemptWarning | null>(
    null,
  );
  const [lockout, setLockout] = useState<LockoutState | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRedeemingPair, setIsRedeemingPair] = useState(false);
  const pairAttemptedRef = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Login pages are terminal screens, dismiss the cold-start splash.
  useHideSplashOnReady(!isLoading);

  // Preserve the full path (including query string like ?projectId=...) safely
  const from = sanitizeRedirectTarget(
    (location.state as { from?: string } | null)?.from,
  );

  const remainingSec = lockout
    ? Math.max(0, Math.ceil((lockout.deadline - nowMs) / 1000))
    : 0;
  const isLocked = lockout !== null && remainingSec > 0;

  // Tick the countdown while locked so the wait is visible instead of guessed.
  useEffect(() => {
    if (!lockout) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [lockout]);

  // Re-enable the form the moment the lockout expires.
  useEffect(() => {
    if (lockout && remainingSec <= 0) {
      setLockout(null);
      setAttemptWarning(null);
      setError(null);
    }
  }, [lockout, remainingSec]);

  /**
   * Turns a 429/401 from the auth endpoints into an exact wait or an exact
   * "N attempts left" warning, instead of a generic "try again later".
   */
  const applyAuthError = useCallback(
    (err: unknown): boolean => {
      const apiError = err as Partial<ApiError> | null;
      const status = typeof apiError?.status === "number" ? apiError.status : 0;

      if (
        status === 429 &&
        typeof apiError?.retryAfterSec === "number" &&
        apiError.retryAfterSec > 0
      ) {
        const durationSec = apiError.lockoutSec ?? apiError.retryAfterSec;
        setLockout({
          deadline: Date.now() + apiError.retryAfterSec * 1000,
          durationSec,
          tier: apiError.tier ?? "soft",
        });
        setAttemptWarning(null);
        setError(null);
        setPassword("");
        return true;
      }

      if (status === 401) {
        setError(
          isSetupMode
            ? t("loginErrorAuthFailed")
            : t("loginErrorInvalidPassword"),
        );
        const remaining = apiError?.attemptsRemaining;
        const nextLockoutSec = apiError?.nextLockoutSec;
        if (
          typeof remaining === "number" &&
          remaining > 0 &&
          typeof nextLockoutSec === "number" &&
          nextLockoutSec > 0
        ) {
          setAttemptWarning({ remaining, lockoutSec: nextLockoutSec });
        } else {
          setAttemptWarning(null);
        }
        return true;
      }

      setAttemptWarning(null);
      setError(err instanceof Error ? err.message : t("loginErrorAuthFailed"));
      return false;
    },
    [isSetupMode, t],
  );

  // If auth is not enabled, disabled by env, or already authenticated, redirect away
  useEffect(() => {
    if (!isLoading && (!authEnabled || authDisabledByEnv || isAuthenticated)) {
      navigate(from, { replace: true });
    }
  }, [
    isLoading,
    authEnabled,
    authDisabledByEnv,
    isAuthenticated,
    from,
    navigate,
  ]);

  // Automatically redeem one-time `#pair=<token>` device pairing links
  useEffect(() => {
    if (isLoading || !authEnabled || authDisabledByEnv || isAuthenticated) {
      return;
    }
    if (pairAttemptedRef.current) return;
    const token = extractPairingToken();
    if (!token) return;

    pairAttemptedRef.current = true;
    scrubPairingTokenFromUrl();
    setIsRedeemingPair(true);
    setError(null);

    void redeemPairing(token)
      .then(() => {
        navigate(from, { replace: true });
      })
      .catch((err) => {
        if (applyAuthError(err)) return;
        const message =
          err instanceof Error ? err.message : t("loginErrorPairingFailed");
        setError(
          message.includes("expired")
            ? t("loginErrorPairingExpired")
            : t("loginErrorPairingFailed"),
        );
      })
      .finally(() => {
        setIsRedeemingPair(false);
      });
  }, [
    isLoading,
    authEnabled,
    authDisabledByEnv,
    isAuthenticated,
    redeemPairing,
    applyAuthError,
    from,
    navigate,
    t,
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLocked) return;
    setError(null);
    setAttemptWarning(null);

    if (!password) {
      setError(t("loginErrorPasswordRequired"));
      return;
    }

    if (isSetupMode) {
      if (password.length < 8) {
        setError(t("loginErrorPasswordTooShort"));
        return;
      }
      if (password !== confirmPassword) {
        setError(t("loginErrorPasswordMismatch"));
        return;
      }
    }

    setIsSubmitting(true);

    try {
      if (isSetupMode) {
        await setupAccount(password);
      } else {
        await login(password);
      }
      navigate(from, { replace: true });
    } catch (err) {
      applyAuthError(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading || isRedeemingPair) {
    return (
      <div className="login-page">
        <div className="login-container">
          <div className="login-loading">
            {isRedeemingPair ? t("loginPairingRedeeming") : t("loginLoading")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-logo">
          <YepAnywhereLogo />
        </div>
        <p className="login-subtitle">
          {isSetupMode ? t("loginSetupSubtitle") : t("loginSubtitle")}
        </p>

        {isInsecureNonLocalHttp() && (
          <div className="login-insecure-notice" role="status">
            {t("loginInsecureHttpWarning")}
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          {/* Hidden username lets browser / OS password managers (Touch ID / Face ID autofill) save credentials cleanly */}
          <input
            type="text"
            name="username"
            value="yepanywhere"
            readOnly
            autoComplete="username"
            tabIndex={-1}
            aria-hidden="true"
            className="visually-hidden"
          />

          <div className="login-field">
            <label htmlFor="password">{t("loginPasswordLabel")}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSetupMode ? "new-password" : "current-password"}
              placeholder={
                isSetupMode
                  ? t("loginPasswordPlaceholderSetup")
                  : t("loginPasswordPlaceholder")
              }
              disabled={isSubmitting || isLocked}
            />
          </div>

          {isSetupMode && (
            <div className="login-field">
              <label htmlFor="confirmPassword">
                {t("loginConfirmPasswordLabel")}
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                placeholder={t("loginConfirmPasswordPlaceholder")}
                disabled={isSubmitting || isLocked}
              />
            </div>
          )}

          {error && <div className="login-error">{error}</div>}

          {!isLocked && attemptWarning && (
            <div className="login-attempt-warning" role="status">
              {attemptWarning.remaining === 1
                ? t("loginAttemptsLeftOne", {
                    duration: formatLockout(attemptWarning.lockoutSec, t),
                  })
                : t("loginAttemptsLeftMany", {
                    count: attemptWarning.remaining,
                    duration: formatLockout(attemptWarning.lockoutSec, t),
                  })}
            </div>
          )}

          {isLocked && lockout && (
            <div className="login-lockout" role="alert">
              <div className="login-lockout-title">{t("loginLockedTitle")}</div>
              <div className="login-lockout-body">
                {t("loginLockedBody", {
                  duration: formatLockout(lockout.durationSec, t),
                  countdown: formatCountdown(remainingSec),
                })}
              </div>
              <div className="login-lockout-hint">
                {t("loginLockedResetHint")}
              </div>
            </div>
          )}

          <button
            type="submit"
            className="login-button"
            disabled={isSubmitting || isLocked}
          >
            {isLocked
              ? t("loginSubmitLocked", {
                  countdown: formatCountdown(remainingSec),
                })
              : isSubmitting
                ? t("loginSubmitPending")
                : isSetupMode
                  ? t("loginSubmitSetup")
                  : t("loginSubmit")}
          </button>
        </form>

        {isSetupMode && <p className="login-hint">{t("loginSetupHint")}</p>}

        {!isSetupMode && (
          <p className="login-recovery-hint">{t("loginRecoveryHint")}</p>
        )}
      </div>
    </div>
  );
}
