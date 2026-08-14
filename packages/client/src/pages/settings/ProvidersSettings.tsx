import { useCallback, useEffect, useState } from "react";
import { type OhMyRouterThroughputStatus, api } from "../../api/client";
import { useProviders } from "../../hooks/useProviders";
import { useI18n } from "../../i18n";
import { getAllProviders } from "../../providers/registry";

function formatMilliseconds(value: number | undefined): string {
  if (value === undefined) return "—";
  return `${Math.round(value).toLocaleString()} ms`;
}

function OhMyRouterThroughputBenchmark() {
  const { t } = useI18n();
  const [status, setStatus] = useState<OhMyRouterThroughputStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getOhMyRouterThroughputBenchmark();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (status?.benchmark?.status !== "running") return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh, status?.benchmark?.status]);

  const start = async () => {
    setStarting(true);
    try {
      const response = await api.startOhMyRouterThroughputBenchmark();
      setStatus((current) => ({
        available: current?.available ?? true,
        unavailableReason: current?.unavailableReason,
        benchmark: response.benchmark,
      }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const benchmark = status?.benchmark;
  const isRunning = benchmark?.status === "running";
  const buttonLabel = benchmark
    ? t("ohmyrouterBenchmarkRetest")
    : t("ohmyrouterBenchmarkStart");

  return (
    <section className="settings-section">
      <h2>{t("ohmyrouterBenchmarkTitle")}</h2>
      <p className="settings-section-description">
        {t("ohmyrouterBenchmarkDescription")}
      </p>

      {loading ? (
        <p className="settings-hint">{t("ohmyrouterBenchmarkLoading")}</p>
      ) : !status?.available ? (
        <p className="settings-hint">
          {t("ohmyrouterBenchmarkUnavailable", {
            reason: status?.unavailableReason ?? "",
          })}
        </p>
      ) : (
        <div className="settings-group">
          <div className="settings-item settings-item-stacked">
            <div className="settings-item-row">
              <div className="settings-item-info">
                <strong>
                  {isRunning
                    ? t("ohmyrouterBenchmarkRunning", {
                        completed: benchmark.completedModels,
                        total: benchmark.totalModels,
                      })
                    : benchmark?.status === "completed"
                      ? t("ohmyrouterBenchmarkCompleted")
                      : benchmark?.status === "interrupted"
                        ? t("ohmyrouterBenchmarkInterrupted")
                        : benchmark?.status === "failed"
                          ? t("ohmyrouterBenchmarkFailed")
                          : t("ohmyrouterBenchmarkReady")}
                </strong>
                {benchmark?.completedAt && (
                  <p>
                    {t("ohmyrouterBenchmarkTestedAt", {
                      date: new Date(benchmark.completedAt).toLocaleString(),
                    })}
                  </p>
                )}
                {benchmark?.error && (
                  <p className="form-error">{benchmark.error}</p>
                )}
              </div>
              <button
                type="button"
                className="settings-button"
                disabled={starting || isRunning}
                onClick={() => void start()}
              >
                {starting ? t("ohmyrouterBenchmarkStarting") : buttonLabel}
              </button>
            </div>

            {benchmark && benchmark.results.length > 0 && (
              <div className="throughput-benchmark-results">
                {benchmark.results.map((result) => (
                  <div
                    key={`${benchmark.id}-${result.modelId}`}
                    className="throughput-benchmark-result"
                  >
                    <div>
                      <strong>{result.modelName}</strong>
                      <code>{result.modelId}</code>
                    </div>
                    {result.error ? (
                      <span className="throughput-benchmark-error">
                        {t("ohmyrouterBenchmarkModelFailed", {
                          error: result.error,
                        })}
                      </span>
                    ) : (
                      <span className="throughput-benchmark-metrics">
                        {t("ohmyrouterBenchmarkMetrics", {
                          rate: result.tokensPerSecond?.toFixed(1) ?? "—",
                          tokens: result.outputTokens?.toLocaleString() ?? "—",
                          ttft: formatMilliseconds(result.timeToFirstTokenMs),
                        })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {benchmark && benchmark.results.length === 0 && !isRunning && (
              <p className="settings-hint">
                {t("ohmyrouterBenchmarkNoResults")}
              </p>
            )}
          </div>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

export function ProvidersSettings() {
  const { t } = useI18n();
  const { providers: serverProviders } = useProviders();

  // Merge server detection status with client-side metadata
  const registeredProviders = getAllProviders();
  const providerDisplayList = registeredProviders.map((clientProvider) => {
    const serverInfo = serverProviders.find(
      (p) => p.name === clientProvider.id,
    );
    return {
      ...clientProvider,
      installed: serverInfo?.installed ?? false,
      authenticated: serverInfo?.authenticated ?? false,
    };
  });

  return (
    <>
      <section className="settings-section">
        <h2>{t("providersSectionTitle")}</h2>
        <p className="settings-section-description">
          {t("providersSectionDescription")}
        </p>
        <div className="settings-group">
          {providerDisplayList.map((provider) => (
            <div key={provider.id} className="settings-item">
              <div className="settings-item-info">
                <div className="settings-item-header">
                  <strong>{provider.displayName}</strong>
                  {provider.installed ? (
                    <span className="settings-status-badge settings-status-detected">
                      {t("providersDetected")}
                    </span>
                  ) : (
                    <span className="settings-status-badge settings-status-not-detected">
                      {t("providersNotDetected")}
                    </span>
                  )}
                </div>
                <p>{provider.metadata.description}</p>
                {provider.metadata.limitations.length > 0 && (
                  <ul className="settings-limitations">
                    {provider.metadata.limitations.map((limitation) => (
                      <li key={limitation}>{limitation}</li>
                    ))}
                  </ul>
                )}
              </div>
              {provider.metadata.website && (
                <a
                  href={provider.metadata.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="settings-link"
                >
                  {t("providersWebsite")}
                </a>
              )}
            </div>
          ))}
        </div>
      </section>
      <OhMyRouterThroughputBenchmark />
    </>
  );
}
