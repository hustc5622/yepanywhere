import { useCallback, useEffect, useState } from "react";
import {
  type DeploymentStatusResponse,
  api,
  fetchJSON,
} from "../../api/client";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useOnboarding } from "../../hooks/useOnboarding";
import { usePwaInstall } from "../../hooks/usePwaInstall";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { activityBus } from "../../lib/activityBus";

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AboutSettings() {
  const { t } = useI18n();
  const { canInstall, isInstalled, install } = usePwaInstall();
  const {
    version: versionInfo,
    loading: versionLoading,
    error: versionError,
    refetchFresh: refetchVersionFresh,
  } = useVersion({ freshOnMount: true });
  const { resetOnboarding } = useOnboarding();
  const { remoteLogCollectionEnabled, setRemoteLogCollectionEnabled } =
    useDeveloperMode();
  const deploymentCapable =
    versionInfo?.capabilities?.includes("deployment") ?? false;

  // Server restart state
  const [restarting, setRestarting] = useState(false);
  const [restartJobId, setRestartJobId] = useState<string | null>(null);
  const [activeWorkers, setActiveWorkers] = useState(0);
  const [deploymentStatus, setDeploymentStatus] =
    useState<DeploymentStatusResponse | null>(null);
  const [deploymentLoading, setDeploymentLoading] = useState(false);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);

  // Fetch worker activity on mount
  useEffect(() => {
    fetchJSON<{ activeWorkers: number; hasActiveWork: boolean }>(
      "/status/workers",
    )
      .then((data) => setActiveWorkers(data.activeWorkers))
      .catch(() => {});
  }, []);

  const refreshDeploymentStatus = useCallback(async () => {
    if (!deploymentCapable) return;

    setDeploymentLoading(true);
    try {
      setDeploymentStatus(await api.getDeploymentStatus());
      setDeploymentError(null);
    } catch (err) {
      setDeploymentError(getErrorMessage(err));
    } finally {
      setDeploymentLoading(false);
    }
  }, [deploymentCapable]);

  // When activity bus reconnects after restart, clear restarting state
  useEffect(() => {
    if (!restarting) return;
    return activityBus.on("reconnect", () => {
      setRestarting(false);
      setRestartJobId(null);
      void refetchVersionFresh();
      void refreshDeploymentStatus();
    });
  }, [refetchVersionFresh, refreshDeploymentStatus, restarting]);

  useEffect(() => {
    void refreshDeploymentStatus();
  }, [refreshDeploymentStatus]);

  const handleCheckUpdates = useCallback(async () => {
    await Promise.allSettled([
      refetchVersionFresh(),
      refreshDeploymentStatus(),
    ]);
  }, [refetchVersionFresh, refreshDeploymentStatus]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    setDeploymentError(null);
    try {
      if (deploymentCapable) {
        const { job } = await api.startDeployment({ action: "server-restart" });
        setRestartJobId(job.id);
        setDeploymentStatus((current) =>
          current ? { ...current, currentJob: job } : current,
        );
      } else {
        await api.restartServer();
      }
    } catch (err) {
      if (deploymentCapable) {
        setDeploymentError(getErrorMessage(err));
        setRestarting(false);
      }
      // Non-deploy restart commonly drops the connection before a response.
    }
  }, [deploymentCapable]);

  useEffect(() => {
    if (!restarting || !restartJobId) return;

    const interval = window.setInterval(() => {
      void api
        .getDeploymentJob(restartJobId)
        .then(({ job }) => {
          setDeploymentStatus((current) =>
            current ? { ...current, currentJob: job } : current,
          );

          if (job.status === "running") return;

          setRestartJobId(null);
          setRestarting(false);

          if (job.status === "failed") {
            setDeploymentError(t("aboutRestartDeployFailed"));
            return;
          }

          void refetchVersionFresh();
          void refreshDeploymentStatus();
        })
        .catch(() => {
          // The server can be unavailable briefly while the deploy job restarts it.
        });
    }, 2500);

    return () => window.clearInterval(interval);
  }, [
    refetchVersionFresh,
    refreshDeploymentStatus,
    restartJobId,
    restarting,
    t,
  ]);

  const localPackageVersion = deploymentStatus?.packageVersion ?? null;
  const stagedBuildVersion = deploymentStatus?.stagedBuild?.version ?? null;
  const localPackageDiffers =
    !!versionInfo?.current &&
    !!localPackageVersion &&
    localPackageVersion !== versionInfo.current;
  const stagedBuildDiffers =
    !!versionInfo?.current &&
    !!stagedBuildVersion &&
    stagedBuildVersion !== versionInfo.current;
  const checkingUpdates = versionLoading || deploymentLoading;
  const usesLocalDeployment =
    deploymentCapable || deploymentStatus?.available === true;
  const hasRegistryUpdate =
    !!versionInfo?.updateAvailable && !!versionInfo.latest;
  const showRegistryUpdate = hasRegistryUpdate && !usesLocalDeployment;

  return (
    <section className="settings-section">
      <h2>{t("aboutTitle")}</h2>
      <div className="settings-group">
        {/* Only show Install option if install is possible or already installed */}
        {(canInstall || isInstalled) && (
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("aboutInstallTitle")}</strong>
              <p>
                {isInstalled
                  ? t("aboutInstalledDescription")
                  : t("aboutInstallDescription")}
              </p>
            </div>
            {isInstalled ? (
              <span className="settings-status-badge">
                {t("aboutInstalled")}
              </span>
            ) : (
              <button
                type="button"
                className="settings-button"
                onClick={install}
              >
                {t("aboutInstall")}
              </button>
            )}
          </div>
        )}
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("aboutVersionTitle")}</strong>
            <p>
              {t("aboutServerVersion")}{" "}
              {versionInfo ? (
                <>
                  v{versionInfo.current}
                  {showRegistryUpdate ? (
                    <span className="settings-update-available">
                      {" "}
                      {t("aboutVersionAvailable", {
                        version: versionInfo.latest ?? "",
                      })}
                    </span>
                  ) : !hasRegistryUpdate && versionInfo.latest ? (
                    <span className="settings-up-to-date">
                      {" "}
                      {t("aboutUpToDate")}
                    </span>
                  ) : null}
                </>
              ) : (
                t("loginLoading")
              )}
            </p>
            <p>
              {t("aboutClientVersion")} v{__APP_VERSION__}
              <br />
              <span style={{ opacity: 0.7 }}>
                {new Date(__BUILD_DATE__).toLocaleString()}
              </span>
            </p>
            {versionError && (
              <p className="settings-warning">{t("aboutUnableRefresh")}</p>
            )}
            {showRegistryUpdate && (
              <p className="settings-update-hint">{t("aboutUpdateHint")}</p>
            )}
            {deploymentStatus?.available && (
              <p>
                {t("deploymentRepoVersion")}{" "}
                {localPackageVersion ? `v${localPackageVersion}` : "unknown"}
                {localPackageDiffers && (
                  <span className="settings-update-available">
                    {" "}
                    {t("aboutLocalRepoUpdateAvailable")}
                  </span>
                )}
                {deploymentStatus.stagedBuild && (
                  <>
                    <br />
                    {t("deploymentStagedVersion")} v
                    {deploymentStatus.stagedBuild.version}
                    {stagedBuildDiffers && (
                      <span className="settings-pending">
                        {" "}
                        {t("aboutStagedBundleOutdated")}
                      </span>
                    )}
                  </>
                )}
              </p>
            )}
            {deploymentError && (
              <p className="settings-warning">{deploymentError}</p>
            )}
          </div>
          <button
            type="button"
            className="settings-button"
            onClick={() => void handleCheckUpdates()}
            disabled={checkingUpdates}
          >
            {checkingUpdates ? t("aboutChecking") : t("aboutCheckUpdates")}
          </button>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("developmentRestartTitle")}</strong>
            <p>{t("developmentRestartDescription")}</p>
            {activeWorkers > 0 && !restarting && (
              <p className="settings-warning">
                {t("developmentInterruptedWarning", {
                  count: activeWorkers,
                  suffix: activeWorkers !== 1 ? "s " : " ",
                })}
              </p>
            )}
          </div>
          <button
            type="button"
            className={`settings-button ${activeWorkers > 0 ? "settings-button-danger" : ""}`}
            onClick={handleRestart}
            disabled={restarting}
          >
            {restarting
              ? t("developmentRestarting")
              : activeWorkers > 0
                ? t("developmentRestartAnyway")
                : t("developmentRestart")}
          </button>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("aboutReportBugTitle")}</strong>
            <p>{t("aboutReportBugDescription")}</p>
          </div>
          <a
            href="https://github.com/hustc5622/yepanywhere/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="settings-button"
          >
            {t("aboutReportBug")}
          </a>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("aboutSetupWizardTitle")}</strong>
            <p>{t("aboutSetupWizardDescription")}</p>
          </div>
          <button
            type="button"
            className="settings-button"
            onClick={resetOnboarding}
          >
            {t("aboutLaunchWizard")}
          </button>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("aboutDiagnosticsTitle")}</strong>
            <p>{t("aboutDiagnosticsDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={remoteLogCollectionEnabled}
              onChange={(e) => setRemoteLogCollectionEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>
    </section>
  );
}
