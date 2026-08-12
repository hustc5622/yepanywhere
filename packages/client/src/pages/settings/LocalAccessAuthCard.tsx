import { useEffect, useRef, useState } from "react";
import type { AuthContextValue } from "../../contexts/AuthContext";
import { useI18n } from "../../i18n";

type PasswordAction = "enable" | "change" | "disable" | null;

const ERROR_KEYS: Record<string, string> = {
  AUTH_ADMIN_NOT_CONFIGURED: "authErrorAdminNotConfigured",
  AUTH_ADMIN_INVALID: "authErrorAdminInvalid",
  AUTH_LOGIN_INVALID: "authErrorLoginInvalid",
  AUTH_LOCAL_REQUIRED: "authErrorLocalRequired",
  AUTH_PASSWORD_INVALID: "authErrorPasswordInvalid",
  AUTH_CONFIG_ERROR: "authErrorConfig",
};

export interface LocalAccessAuthCardProps {
  auth: AuthContextValue;
}

export function LocalAccessAuthCard({ auth }: LocalAccessAuthCardProps) {
  const { t } = useI18n();
  const [adminPassword, setAdminPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [action, setAction] = useState<PasswordAction>(
    auth.authEnabled ? null : "enable",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sensitive = useRef({
    adminPassword: "",
    newPassword: "",
    confirmPassword: "",
  });

  sensitive.current = { adminPassword, newPassword, confirmPassword };

  function clearSensitiveFields(): void {
    sensitive.current = {
      adminPassword: "",
      newPassword: "",
      confirmPassword: "",
    };
    setAdminPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  useEffect(
    () => () => {
      sensitive.current = {
        adminPassword: "",
        newPassword: "",
        confirmPassword: "",
      };
    },
    [],
  );

  if (!auth.localManagementAllowed) {
    return (
      <div className="settings-group">
        <div className="settings-item settings-item-stacked">
          <div className="settings-item-row">
            <div className="settings-item-info">
              <strong>{t("localAccessPasswordManagementTitle")}</strong>
              <p>{t("localAccessPasswordManagementLocalOnly")}</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={auth.authEnabled}
                disabled
                aria-label={t("localAccessRequirePasswordDescription")}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>
    );
  }

  const selectAction = (nextAction: PasswordAction) => {
    clearSensitiveFields();
    setError(null);
    setAction(nextAction);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!action) return;
    setError(null);

    if (action !== "disable" && newPassword !== confirmPassword) {
      setError(t("localAccessErrorPasswordMismatch"));
      clearSensitiveFields();
      return;
    }

    setPending(true);
    try {
      if (action === "enable") {
        await auth.enableAuth(adminPassword, newPassword);
      } else if (action === "change") {
        await auth.changePassword(adminPassword, newPassword);
      } else {
        await auth.disableAuth(adminPassword);
      }
      setAction(auth.authEnabled ? null : action);
    } catch (cause) {
      const code = (cause as { code?: string } | null)?.code;
      const key = code ? ERROR_KEYS[code] : undefined;
      setError(key ? t(key as never) : t("authErrorConfig"));
    } finally {
      clearSensitiveFields();
      setPending(false);
    }
  };

  return (
    <form className="settings-group" onSubmit={handleSubmit}>
      <div className="settings-item settings-item-stacked">
        <div className="settings-item-row">
          <div className="settings-item-info">
            <strong>{t("localAccessPasswordManagementTitle")}</strong>
            <p>{t("localAccessRequirePasswordDescription")}</p>
          </div>
          {auth.authEnabled && action === null && (
            <div>
              <button
                type="button"
                className="settings-button"
                onClick={() => selectAction("change")}
              >
                {t("localAccessChangePassword")}
              </button>{" "}
              <button
                type="button"
                className="settings-button settings-button-danger"
                onClick={() => selectAction("disable")}
              >
                {t("localAccessDisablePassword")}
              </button>
            </div>
          )}
        </div>

        {action && (
          <div className="settings-nested-content">
            <div className="settings-item">
              <div className="settings-item-info">
                <label htmlFor={`admin-password-${action}`}>
                  <strong>{t("localAccessAdminPasswordLabel")}</strong>
                </label>
              </div>
              <input
                id={`admin-password-${action}`}
                type="password"
                className="settings-input"
                value={adminPassword}
                onChange={(event) => setAdminPassword(event.target.value)}
                disabled={pending}
                autoComplete="current-password"
              />
            </div>

            {action !== "disable" && (
              <>
                <div className="settings-item">
                  <div className="settings-item-info">
                    <label htmlFor={`new-password-${action}`}>
                      <strong>{t("localAccessPasswordTitle")}</strong>
                    </label>
                  </div>
                  <input
                    id={`new-password-${action}`}
                    type="password"
                    className="settings-input"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    disabled={pending}
                    autoComplete="new-password"
                    placeholder={t("localAccessPasswordNewPlaceholder")}
                  />
                </div>
                <div className="settings-item">
                  <div className="settings-item-info">
                    <label htmlFor={`confirm-password-${action}`}>
                      <strong>{t("localAccessConfirmPasswordTitle")}</strong>
                    </label>
                  </div>
                  <input
                    id={`confirm-password-${action}`}
                    type="password"
                    className="settings-input"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    disabled={pending}
                    autoComplete="new-password"
                  />
                </div>
              </>
            )}

            {error && <p className="form-error">{error}</p>}
            <div className="settings-item">
              <button
                type="submit"
                className="settings-button"
                disabled={pending}
              >
                {action === "enable"
                  ? t("localAccessEnablePassword")
                  : action === "change"
                    ? t("localAccessChangePassword")
                    : t("localAccessDisablePassword")}
              </button>
              {auth.authEnabled && (
                <button
                  type="button"
                  className="settings-button"
                  disabled={pending}
                  onClick={() => selectAction(null)}
                >
                  {t("actionCancel")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </form>
  );
}
