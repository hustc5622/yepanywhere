import { useI18n } from "../i18n";

export function SessionTitleGenerationStatus() {
  const { t } = useI18n();
  const label = t("sessionMenuGeneratingTitle");

  return (
    <span
      className="session-title-generation-status"
      role="status"
      aria-label={label}
      aria-live="polite"
    >
      <span className="session-title-generation-spinner" aria-hidden="true" />
      {label}
    </span>
  );
}
