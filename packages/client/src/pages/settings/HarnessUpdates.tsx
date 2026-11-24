import type { HarnessId, HarnessUpdateInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { SettingsListSkeleton } from "../../components/SettingsSkeleton";
import { useI18n } from "../../i18n";
import "./HarnessUpdates.css";

type PendingAction = HarnessId | "all-check" | "all-update" | null;

export function HarnessUpdates() {
  const { t } = useI18n();
  const [harnesses, setHarnesses] = useState<HarnessUpdateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDshStop, setConfirmDshStop] = useState(false);
  const mounted = useRef(false);
  // Invalidate an older poll when a button action returns newer state.
  const generation = useRef(0);
  const actionInFlight = useRef(false);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await api.getHarnessUpdates();
      if (!mounted.current || request !== generation.current) return;
      setHarnesses(result.harnesses);
      setError(null);
    } catch (err) {
      if (mounted.current && request === generation.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Keep polling after network errors and while another client runs an update.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      timer = setTimeout(async () => {
        if (!actionInFlight.current && document.visibilityState !== "hidden")
          await refresh();
        if (!cancelled) poll();
      }, 3_000);
    };
    poll();
    const onVisible = () => {
      if (document.visibilityState === "visible" && !actionInFlight.current)
        void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      generation.current++;
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const act = async (id: HarnessId, action: "check" | "update") => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    ++generation.current;
    setPending(id);
    setError(null);
    try {
      if (action === "check") {
        const { harness } = await api.checkHarnessUpdate(id);
        if (mounted.current)
          setHarnesses((current) =>
            current.map((item) => (item.id === id ? harness : item)),
          );
      } else {
        const { job } = await api.updateHarness(id);
        if (mounted.current)
          setHarnesses((current) =>
            current.map((item) => (item.id === id ? { ...item, job } : item)),
          );
      }
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const actAll = async (action: "check" | "update") => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    ++generation.current;
    setPending(action === "check" ? "all-check" : "all-update");
    setError(null);
    try {
      if (action === "check") {
        const { harnesses: updated } = await api.checkAllHarnessUpdates();
        if (mounted.current) setHarnesses(updated);
      } else {
        const { jobs } = await api.updateAllHarnesses();
        if (mounted.current) {
          setHarnesses((current) =>
            current.map((item) =>
              jobs[item.id] ? { ...item, job: jobs[item.id] } : item,
            ),
          );
        }
      }
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const controlDsh = async (action: "start" | "stop") => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    ++generation.current;
    setPending("dsh");
    setError(null);
    setConfirmDshStop(false);
    try {
      if (action === "stop") await api.stopDshWeb();
      else await api.launchDshWeb();
      await refresh();
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const running = harnesses.some(
    (item) => item.job?.status === "running" || item.job?.status === "queued",
  );
  const anyCheckable = harnesses.some((item) => item.supportsCheck !== false);
  const anyUpdatable = harnesses.some((item) => item.canUpdate);

  return (
    <section
      className="settings-section harness-updates"
      aria-labelledby="harness-updates-title"
    >
      <div className="harness-updates-header">
        <div>
          <h2 id="harness-updates-title">{t("harnessUpdatesTitle")}</h2>
          <p className="settings-section-description">
            {t("harnessUpdatesDescription")}
          </p>
        </div>
        {!loading && harnesses.length > 0 && (
          <div className="settings-item-actions harness-updates-batch-actions">
            {anyCheckable && (
              <button
                type="button"
                className="settings-button settings-button-secondary"
                disabled={!!pending || running}
                onClick={() => void actAll("check")}
              >
                {pending === "all-check"
                  ? t("harnessUpdatesWorking")
                  : t("harnessUpdatesCheckAll")}
              </button>
            )}
            <button
              type="button"
              className="settings-button"
              disabled={!!pending || running || !anyUpdatable}
              onClick={() => void actAll("update")}
            >
              {pending === "all-update" || running
                ? t("harnessUpdatesRunning")
                : t("harnessUpdatesUpdateAll")}
            </button>
          </div>
        )}
      </div>
      <p className="settings-hint">{t("harnessUpdatesEffect")}</p>
      {loading && <SettingsListSkeleton label={t("harnessUpdatesLoading")} />}
      {!loading && harnesses.length === 0 && !error && (
        <p className="settings-hint">{t("harnessUpdatesEmpty")}</p>
      )}
      <div className="settings-group">
        {harnesses.map((item) => {
          const isRunning = item.job?.status === "running";
          const isQueued = item.job?.status === "queued";
          const supportsCheck = item.supportsCheck !== false;
          const blockMessages = {
            not_installed: "harnessUpdatesNotInstalled",
            unsupported_install: "harnessUpdatesUnsupported",
            unsupported_platform: "harnessUpdatesPlatform",
            package_manager_missing: "harnessUpdatesManagerMissing",
            busy: "harnessUpdatesBusy",
          } as const;
          const unchangedCompletion =
            item.job?.status === "completed" &&
            Boolean(item.job.fromVersion) &&
            item.job.fromVersion === item.job.toVersion;
          return (
            <div className="settings-item settings-item-stacked" key={item.id}>
              <div className="settings-item-row">
                <div className="settings-item-info">
                  <strong>{item.displayName}</strong>
                  <p>
                    {t("harnessUpdatesCurrent", {
                      version:
                        item.currentVersion ?? t("harnessUpdatesUnknown"),
                    })}
                  </p>
                  {supportsCheck && item.latestVersion && (
                    <p>
                      {item.updateAvailable || !item.currentVersion
                        ? t("harnessUpdatesAvailable", {
                            version: item.latestVersion,
                          })
                        : t(
                            item.id === "dsh"
                              ? "harnessUpdatesDshCurrentLatest"
                              : "harnessUpdatesCurrentLatest",
                          )}
                    </p>
                  )}
                  {!supportsCheck && item.manager === "self" && (
                    <p className="settings-hint">
                      {t("harnessUpdatesSelfUpdaterHint")}
                    </p>
                  )}
                </div>
                <div className="settings-item-actions">
                  {supportsCheck && (
                    <button
                      type="button"
                      className="settings-button settings-button-secondary"
                      disabled={!!pending || running}
                      aria-label={t("harnessUpdatesCheckFor", {
                        name: item.displayName,
                      })}
                      onClick={() => void act(item.id, "check")}
                    >
                      {pending === item.id
                        ? t("harnessUpdatesWorking")
                        : t("harnessUpdatesCheck")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="settings-button"
                    disabled={
                      !!pending ||
                      running ||
                      !item.canUpdate ||
                      (supportsCheck &&
                        !item.updateAvailable &&
                        item.job?.status !== "failed")
                    }
                    aria-label={t("harnessUpdatesUpdateFor", {
                      name: item.displayName,
                    })}
                    onClick={() => void act(item.id, "update")}
                  >
                    {isRunning
                      ? t("harnessUpdatesRunning")
                      : isQueued
                        ? t("harnessUpdatesQueued")
                        : item.job?.status === "failed"
                          ? t("harnessUpdatesRetry")
                          : t("harnessUpdatesUpdate")}
                  </button>
                </div>
              </div>
              {item.id === "dsh" && (
                <>
                  <p className="settings-hint">
                    {t("harnessUpdatesDshChannels")}
                  </p>
                  <p className="settings-hint">
                    {t(
                      item.webRunning
                        ? "harnessUpdatesDshRunning"
                        : "harnessUpdatesDshStopped",
                    )}
                  </p>
                  {confirmDshStop ? (
                    <div role="alert">
                      <p>{t("harnessUpdatesDshStopConfirm")}</p>
                      <div className="settings-item-actions">
                        <button
                          type="button"
                          className="settings-button"
                          disabled={!!pending || running}
                          onClick={() => void controlDsh("stop")}
                        >
                          {t("harnessUpdatesDshConfirmStop")}
                        </button>
                        <button
                          type="button"
                          className="settings-button settings-button-secondary"
                          onClick={() => setConfirmDshStop(false)}
                        >
                          {t("harnessUpdatesDshCancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="settings-item-actions">
                      <button
                        type="button"
                        className="settings-button settings-button-secondary"
                        disabled={
                          !!pending ||
                          running ||
                          (!item.webRunning && !item.path)
                        }
                        onClick={() =>
                          item.webRunning
                            ? setConfirmDshStop(true)
                            : void controlDsh("start")
                        }
                      >
                        {t(
                          item.webRunning
                            ? "harnessUpdatesDshStop"
                            : "harnessUpdatesDshStart",
                        )}
                      </button>
                    </div>
                  )}
                </>
              )}
              {item.blockedReason && !isRunning && !isQueued && (
                <p className="settings-hint">
                  {t(
                    item.id === "dsh" && item.blockedReason === "busy"
                      ? "harnessUpdatesDshStopBeforeUpdate"
                      : blockMessages[item.blockedReason],
                  )}
                </p>
              )}
              {item.checkedAt && (
                <p className="settings-hint">
                  {t("harnessUpdatesChecked", {
                    date: new Date(item.checkedAt).toLocaleString(),
                  })}
                </p>
              )}
              <div role="status" aria-live="polite">
                {isRunning && (
                  <p className="settings-hint">
                    {t("harnessUpdatesContinues")}
                  </p>
                )}
                {isQueued && (
                  <p className="settings-hint">
                    {t("harnessUpdatesQueuedHint")}
                  </p>
                )}
                {item.job?.status === "completed" && (
                  <p className="settings-hint">
                    {unchangedCompletion
                      ? t("harnessUpdatesAlreadyLatest", {
                          version: item.job.toVersion ?? "",
                        })
                      : t(
                          item.id === "dsh"
                            ? "harnessUpdatesDshCompleted"
                            : "harnessUpdatesCompleted",
                          {
                            version: item.job.toVersion ?? "",
                          },
                        )}
                  </p>
                )}
                {item.job?.status === "failed" && (
                  <p className="form-error">
                    {t("harnessUpdatesFailed", { error: item.job.error ?? "" })}
                  </p>
                )}
                {item.error && <p className="form-error">{item.error}</p>}
              </div>
              {(item.path || item.job?.log) && (
                <details className="harness-update-details">
                  <summary>{t("harnessUpdatesDetails")}</summary>
                  {item.path && (
                    <p>
                      <code>{item.path}</code>
                      {item.resolvedPath && item.resolvedPath !== item.path && (
                        <>
                          {" → "}
                          <code>{item.resolvedPath}</code>
                        </>
                      )}
                      {item.manager && ` · ${item.manager}`}
                    </p>
                  )}
                  {item.job?.log && <pre>{item.job.log}</pre>}
                </details>
              )}
            </div>
          );
        })}
      </div>
      {error && (
        <div role="alert" className="harness-update-error">
          <p className="form-error">{error}</p>
          <button
            type="button"
            className="settings-button"
            disabled={!!pending}
            onClick={() => void refresh()}
          >
            {t("harnessUpdatesRefresh")}
          </button>
        </div>
      )}
    </section>
  );
}
