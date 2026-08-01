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
  const [deploymentSuccess, setDeploymentSuccess] = useState<string | null>(
    null,
  );

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
    setDeploymentSuccess(null);
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

    // 兜底：轮询超过 15 分钟仍未拿到终态（极端情况下服务端彻底失联），
    // 强制解除“更新中”，避免按钮永久卡死。
    const MAX_ATTEMPTS = 360; // 2.5s * 360 ≈ 15 分钟
    let attempts = 0;

    const interval = window.setInterval(() => {
      attempts += 1;
      void api
        .getDeploymentJob(restartJobId)
        .then(({ job }) => {
          setDeploymentStatus((current) =>
            current ? { ...current, currentJob: job } : current,
          );

          if (job.status === "running") return;

          // 任务结束：无论成功/失败都先解除“更新中”状态
          setRestartJobId(null);
          setRestarting(false);

          if (job.status === "failed") {
            setDeploymentSuccess(null);
            setDeploymentError(
              job.errorReason
                ? `更新失败：${job.errorReason}`
                : t("aboutRestartDeployFailed"),
            );
            return;
          }

          // 更新成功
          setDeploymentError(null);
          setDeploymentSuccess(t("aboutDeploySuccess"));
          void refetchVersionFresh();
          void refreshDeploymentStatus();
        })
        .catch(() => {
          // 服务端在重启过程中可能短暂不可用，继续轮询；超过上限则兜底退出。
          if (attempts >= MAX_ATTEMPTS) {
            window.clearInterval(interval);
            setRestartJobId(null);
            setRestarting(false);
            setDeploymentError(t("aboutDeployStatusUnknown"));
          }
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

  // Handler for "Update Now" button
  const handleUpdateNow = useCallback(async () => {
    setRestarting(true);
    setDeploymentError(null);
    setDeploymentSuccess(null);
    try {
      const { job } = await api.startDeployment({ action: "git-pull-update" });
      setRestartJobId(job.id);
      setDeploymentStatus((current) =>
        current ? { ...current, currentJob: job } : current,
      );
    } catch (err) {
      setDeploymentError(getErrorMessage(err));
      setRestarting(false);
    }
  }, []);

  // Handler for "Update to Local" button
  const handleUpdateToLocal = useCallback(async () => {
    setRestarting(true);
    setDeploymentError(null);
    setDeploymentSuccess(null);
    try {
      const { job } = await api.startDeployment({ action: "server" });
      setRestartJobId(job.id);
      setDeploymentStatus((current) =>
        current ? { ...current, currentJob: job } : current,
      );
    } catch (err) {
      setDeploymentError(getErrorMessage(err));
      setRestarting(false);
    }
  }, []);

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

            {/* Git Version Information */}
            {deploymentStatus?.available && (
              <>
                {/* Local Git Version */}
                {deploymentStatus.localGitVersion && (
                  <div style={{ marginTop: "12px" }}>
                    <p style={{ fontWeight: "500" }}>
                      {t("aboutLocalGitVersion")}
                    </p>
                    <p
                      style={{
                        marginLeft: "12px",
                        fontSize: "0.9em",
                        opacity: 0.8,
                      }}
                    >
                      {t("aboutBranch")}:{" "}
                      {deploymentStatus.localGitVersion.branch}
                      <br />
                      {t("aboutCommitHash")}:{" "}
                      {deploymentStatus.localGitVersion.commitHash}
                      <br />
                      {t("aboutCommitDate")}:{" "}
                      {new Date(
                        deploymentStatus.localGitVersion.commitDate,
                      ).toLocaleString()}
                    </p>
                  </div>
                )}

                {/* GitHub Version */}
                {deploymentStatus.githubVersion && (
                  <div style={{ marginTop: "12px" }}>
                    <p style={{ fontWeight: "500" }}>
                      {t("aboutGithubVersion")}
                    </p>
                    <p
                      style={{
                        marginLeft: "12px",
                        fontSize: "0.9em",
                        opacity: 0.8,
                      }}
                    >
                      {t("aboutBranch")}:{" "}
                      {deploymentStatus.githubVersion.branch}
                      <br />
                      {t("aboutCommitHash")}:{" "}
                      {deploymentStatus.githubVersion.commitHash}
                      <br />
                      {t("aboutCommitDate")}:{" "}
                      {new Date(
                        deploymentStatus.githubVersion.commitDate,
                      ).toLocaleString()}
                    </p>
                  </div>
                )}

                {/* Stable Version */}
                {deploymentStatus.stableVersion && (
                  <div style={{ marginTop: "12px" }}>
                    <p style={{ fontWeight: "500" }}>
                      {t("aboutStableVersion")}
                    </p>
                    <p
                      style={{
                        marginLeft: "12px",
                        fontSize: "0.9em",
                        opacity: 0.8,
                      }}
                    >
                      {t("aboutBranch")}:{" "}
                      {deploymentStatus.stableVersion.branch}
                      <br />
                      {t("aboutCommitHash")}:{" "}
                      {deploymentStatus.stableVersion.commitHash}
                      <br />
                      {t("aboutCommitDate")}:{" "}
                      {new Date(
                        deploymentStatus.stableVersion.commitDate,
                      ).toLocaleString()}
                    </p>
                  </div>
                )}
              </>
            )}

            {/* Legacy version display for non-deployment mode */}
            {!deploymentStatus?.available && (
              <>
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
              </>
            )}

            {versionError && (
              <p className="settings-warning">{t("aboutUnableRefresh")}</p>
            )}
            {showRegistryUpdate && (
              <p className="settings-update-hint">{t("aboutUpdateHint")}</p>
            )}
            {deploymentError && (
              <p className="settings-warning">{deploymentError}</p>
            )}
            {deploymentSuccess && (
              <p className="settings-update-success">{deploymentSuccess}</p>
            )}
          </div>
          <div style={{ display: "flex", gap: "8px", flexDirection: "column" }}>
            <button
              type="button"
              className="settings-button"
              onClick={() => void handleCheckUpdates()}
              disabled={checkingUpdates}
            >
              {checkingUpdates ? t("aboutChecking") : t("aboutCheckUpdates")}
            </button>
            {deploymentStatus?.hasGithubUpdate && (
              <button
                type="button"
                className="settings-button settings-button-primary"
                onClick={() => {
                  if (window.confirm(t("aboutUpdateConfirmGithub"))) {
                    void handleUpdateNow();
                  }
                }}
                disabled={restarting}
                style={{
                  backgroundColor: "#4CAF50",
                  color: "white",
                  fontWeight: "bold",
                }}
              >
                {restarting ? t("aboutUpdating") : t("aboutUpdateToGithub")}
              </button>
            )}
            {deploymentStatus?.hasLocalUpdate && (
              <button
                type="button"
                className="settings-button settings-button-primary"
                onClick={() => {
                  if (window.confirm(t("aboutUpdateConfirmLocal"))) {
                    void handleUpdateToLocal();
                  }
                }}
                disabled={restarting}
                style={{
                  backgroundColor: "#2196F3",
                  color: "white",
                  fontWeight: "bold",
                }}
              >
                {restarting ? t("aboutUpdating") : t("aboutUpdateToLocal")}
              </button>
            )}
          </div>
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
            href="https://github.com/kzahel/yepanywhere/issues"
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
