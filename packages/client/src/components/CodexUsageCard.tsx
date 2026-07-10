import { useCallback, useEffect, useState } from "react";
import {
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
        <span>{getWindowLabel(window, t)}</span>
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
      {resetAt && (
        <span className="codex-usage-reset">
          {t("newSessionCodexUsageResetAt", { time: resetAt })}
        </span>
      )}
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
    <div className="codex-usage-additional-bucket">
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
    </div>
  );
}

export function CodexUsageCard() {
  const { t } = useI18n();
  const [response, setResponse] = useState<CodexUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUsage = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      setResponse(await api.getCodexUsage({ fresh }));
    } catch {
      setResponse({ usage: null, error: "request-failed" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const usage = response?.usage;
  const windows = [usage?.primary, usage?.secondary].filter(
    (window): window is CodexUsageWindow => Boolean(window),
  );

  return (
    <section className="codex-usage-card" aria-live="polite">
      <div className="codex-usage-header">
        <div>
          <h3>{t("newSessionCodexUsageTitle")}</h3>
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
        <p className="codex-usage-state">{t("newSessionCodexUsageLoading")}</p>
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
          {t("newSessionCodexUsageUnavailable")}
        </p>
      )}
    </section>
  );
}
