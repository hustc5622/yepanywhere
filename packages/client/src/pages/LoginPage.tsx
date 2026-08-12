/**
 * LoginPage - Login form for cookie-based auth.
 *
 * Shows the ordinary login form. Local requests can also use the
 * administrator credential as a recovery login.
 */

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useAuth } from "../contexts/AuthContext";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import { useI18n } from "../i18n";

export function LoginPage() {
  const { t } = useI18n();
  const { login, isLoading, authEnabled, localManagementAllowed } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Login pages are terminal screens, dismiss the cold-start splash.
  useHideSplashOnReady(!isLoading);

  // Get the page they were trying to access before being redirected
  const from =
    (location.state as { from?: string } | null)?.from ?? "/projects";

  // If auth is not enabled, redirect away from the login page.
  useEffect(() => {
    if (!isLoading && !authEnabled) {
      navigate("/projects", { replace: true });
    }
  }, [isLoading, authEnabled, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!password) {
      setError(t("loginErrorPasswordRequired"));
      return;
    }

    setIsSubmitting(true);

    try {
      await login(password);
      navigate(from, { replace: true });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "AUTH_LOGIN_INVALID") {
        setError(
          localManagementAllowed
            ? t("loginErrorInvalidPasswordOrAdmin")
            : t("loginErrorInvalidPassword"),
        );
      } else {
        setError(t("loginErrorAuthFailed"));
      }
    } finally {
      setPassword("");
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="login-page">
        <div className="login-container">
          <div className="login-loading">{t("loginLoading")}</div>
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
        <p className="login-subtitle">{t("loginSubtitle")}</p>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label htmlFor="password">{t("loginPasswordLabel")}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("loginPasswordPlaceholder")}
              disabled={isSubmitting}
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <button
            type="submit"
            className="login-button"
            disabled={isSubmitting}
          >
            {isSubmitting ? t("loginSubmitPending") : t("loginSubmit")}
          </button>
        </form>

        {localManagementAllowed && (
          <p className="login-recovery-hint">{t("loginAdminRecoveryHint")}</p>
        )}
      </div>
    </div>
  );
}
