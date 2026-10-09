import { useCallback, useEffect, useState } from "react";
import { SettingsFormSkeleton } from "../../components/SettingsSkeleton";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

const MAX_LENGTH = 10000;

export function AgentContextSettings() {
  const { t } = useI18n();
  const { settings, isLoading, error, updateSetting } = useServerSettings();
  const [instructions, setInstructions] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setInstructions(settings.globalInstructions ?? "");
    }
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateSetting(
        "globalInstructions",
        instructions.trim() || undefined,
      );
      setHasChanges(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("agentContextSaveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [instructions, updateSetting, t]);

  if (isLoading) {
    return (
      <section className="settings-section">
        <h2>{t("agentContextTitle")}</h2>
        <p className="settings-section-description">
          {t("agentContextDescription")}
        </p>
        <SettingsFormSkeleton
          label={t("agentContextLoading")}
          fields={[
            {
              title: t("agentContextGlobalInstructions"),
              description: t("agentContextGlobalInstructionsDescription"),
              control: "textarea",
            },
          ]}
          actions
        />
      </section>
    );
  }

  const serverValue = settings?.globalInstructions ?? "";

  return (
    <section className="settings-section">
      <h2>{t("agentContextTitle")}</h2>
      <p className="settings-section-description">
        {t("agentContextDescription")}
      </p>

      <div className="settings-group">
        <div
          className="settings-item"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="settings-item-info">
            <strong>{t("agentContextGlobalInstructions")}</strong>
            <p>{t("agentContextGlobalInstructionsDescription")}</p>
          </div>
          <textarea
            className="settings-textarea"
            value={instructions}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_LENGTH);
              setInstructions(value);
              setHasChanges(value !== serverValue);
              setSaveError(null);
            }}
            placeholder={t("agentContextPlaceholder")}
            rows={10}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "var(--space-2)",
            }}
          >
            <span className="settings-hint">
              {t("agentContextCharacters", {
                current: instructions.length.toLocaleString(),
                max: MAX_LENGTH.toLocaleString(),
              })}
            </span>
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
      </div>
    </section>
  );
}
