import { useCallback, useEffect, useState } from "react";
import { SettingsFormSkeleton } from "../../components/SettingsSkeleton";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

const MAX_URL_LENGTH = 2000;
const MAX_TOKEN_LENGTH = 5000;

export function LifecycleWebhooksSettings() {
  const { t } = useI18n();
  const { settings, isLoading, error, updateSetting } = useServerSettings();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setUrl(settings.lifecycleWebhookUrl ?? "");
    setToken(settings.lifecycleWebhookToken ?? "");
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await Promise.all([
        updateSetting("lifecycleWebhookUrl", url.trim() || undefined),
        updateSetting("lifecycleWebhookToken", token.trim() || undefined),
      ]);
      setHasChanges(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("lifecycleWebhooksSaveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [t, token, updateSetting, url]);

  if (isLoading) {
    return (
      <section className="settings-section">
        <h2>{t("lifecycleWebhooksTitle")}</h2>
        <p className="settings-section-description">
          {t("lifecycleWebhooksDescription")}
        </p>
        <SettingsFormSkeleton
          label={t("lifecycleWebhooksLoading")}
          fields={[
            {
              title: t("lifecycleWebhooksEnableTitle"),
              description: t("lifecycleWebhooksEnableDescription"),
              control: "toggle",
            },
            {
              title: t("lifecycleWebhooksUrlTitle"),
              description: t("lifecycleWebhooksUrlDescription"),
              control: "input",
            },
            {
              title: t("lifecycleWebhooksTokenTitle"),
              description: t("lifecycleWebhooksTokenDescription"),
              control: "input",
            },
            {
              title: t("lifecycleWebhooksDryRunTitle"),
              description: t("lifecycleWebhooksDryRunDescription"),
              control: "toggle",
            },
          ]}
          actions
        />
      </section>
    );
  }

  const serverUrl = settings?.lifecycleWebhookUrl ?? "";
  const serverToken = settings?.lifecycleWebhookToken ?? "";
  const enabled = settings?.lifecycleWebhooksEnabled ?? false;
  const dryRun = settings?.lifecycleWebhookDryRun ?? true;

  return (
    <section className="settings-section">
      <h2>{t("lifecycleWebhooksTitle")}</h2>
      <p className="settings-section-description">
        {t("lifecycleWebhooksDescription")}
      </p>

      <div className="settings-group">
        <label className="settings-item">
          <div className="settings-item-info">
            <strong>{t("lifecycleWebhooksEnableTitle")}</strong>
            <p>{t("lifecycleWebhooksEnableDescription")}</p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) =>
              void updateSetting("lifecycleWebhooksEnabled", e.target.checked)
            }
          />
        </label>

        <div
          className="settings-item"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="settings-item-info">
            <strong>{t("lifecycleWebhooksUrlTitle")}</strong>
            <p>{t("lifecycleWebhooksUrlDescription")}</p>
          </div>
          <input
            type="url"
            className="settings-input"
            value={url}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_URL_LENGTH);
              setUrl(value);
              setHasChanges(value !== serverUrl || token !== serverToken);
              setSaveError(null);
            }}
            placeholder="https://example.com/hooks/yep"
          />
        </div>

        <div
          className="settings-item"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="settings-item-info">
            <strong>{t("lifecycleWebhooksTokenTitle")}</strong>
            <p>{t("lifecycleWebhooksTokenDescription")}</p>
          </div>
          <input
            type="password"
            className="settings-input"
            value={token}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_TOKEN_LENGTH);
              setToken(value);
              setHasChanges(url !== serverUrl || value !== serverToken);
              setSaveError(null);
            }}
            placeholder={t("lifecycleWebhooksTokenPlaceholder")}
          />
        </div>

        <label className="settings-item">
          <div className="settings-item-info">
            <strong>{t("lifecycleWebhooksDryRunTitle")}</strong>
            <p>{t("lifecycleWebhooksDryRunDescription")}</p>
          </div>
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) =>
              void updateSetting("lifecycleWebhookDryRun", e.target.checked)
            }
          />
        </label>

        <div
          className="settings-item"
          style={{ justifyContent: "flex-end", gap: "var(--space-2)" }}
        >
          <button
            type="button"
            className="settings-button"
            disabled={!hasChanges || isSaving}
            onClick={handleSave}
          >
            {isSaving ? t("providersSaving") : t("providersSave")}
          </button>
        </div>

        {(saveError || error) && (
          <p className="settings-warning">{saveError || error}</p>
        )}
      </div>
    </section>
  );
}
