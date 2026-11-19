import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  type BuildCheckResult,
  CURRENT_BUILD_ID,
  checkForNewBuild,
} from "../lib/buildRefresh";

/**
 * Replaces the raw schema dump when a session payload does not fit this
 * client. A confirmed build mismatch means the tab is stale: the shared build
 * check reloads it, or asks for a manual reload if the loop guard holds back.
 */
export function DisplaySchemaMismatchNotice({ detail }: { detail: string }) {
  const { t } = useI18n();
  const [result, setResult] = useState<BuildCheckResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkForNewBuild().then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const stale = result?.status === "stale" || result?.status === "reloading";
  const serverBuildId =
    result && "serverBuildId" in result ? result.serverBuildId : null;
  const message = !result
    ? t("sessionClientCheckingBuild")
    : result.status === "reloading"
      ? t("sessionClientOutdatedReloading")
      : stale
        ? t("sessionClientOutdatedHint")
        : t("sessionDisplayIncompatibleHint");

  return (
    <div className="error session-schema-mismatch" role="alert">
      <p>
        <strong>
          {stale
            ? t("sessionClientOutdatedTitle")
            : t("sessionDisplayIncompatibleTitle")}
        </strong>
      </p>
      <p>{message}</p>
      <p className="session-schema-mismatch-builds">
        {t("errorBoundaryClientBuild")} {CURRENT_BUILD_ID || "dev"}
        <br />
        {t("errorBoundaryServerBuild")}{" "}
        {serverBuildId ?? t("errorBoundaryUnknown")}
      </p>
      <button
        type="button"
        className="btn-primary"
        onClick={() => window.location.reload()}
      >
        {t("errorBoundaryReload")}
      </button>
      <details className="session-schema-mismatch-details">
        <summary>{t("sessionDisplayMismatchDetails")}</summary>
        <pre>{detail}</pre>
      </details>
    </div>
  );
}
