import type { RemoteExecutorConfig } from "@yep-anywhere/shared";
import { useState } from "react";
import type { RemoteExecutorTestResult } from "../../api/client";
import { useRemoteExecutors } from "../../hooks/useRemoteExecutors";
import { useI18n } from "../../i18n";

interface ExecutorStatus {
  testing: boolean;
  result?: RemoteExecutorTestResult;
}

interface ExecutorForm {
  host: string;
  user: string;
  port: string;
  localRoot: string;
  remoteRoot: string;
  claudePath: string;
  remoteClaudeConfigDir: string;
  remoteSessionsDir: string;
  sessionStorageMode: "shared" | "ssh-replica";
  localProjectsDir: string;
  remoteProjectsDir: string;
}

const EMPTY_FORM: ExecutorForm = {
  host: "",
  user: "",
  port: "",
  localRoot: "",
  remoteRoot: "",
  claudePath: "",
  remoteClaudeConfigDir: "",
  remoteSessionsDir: "",
  sessionStorageMode: "shared",
  localProjectsDir: "",
  remoteProjectsDir: "",
};

export function RemoteExecutorsSettings() {
  const { t } = useI18n();
  const {
    executors,
    loading,
    error: loadError,
    addExecutor,
    removeExecutor,
    testExecutor,
  } = useRemoteExecutors();
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ExecutorStatus>>({});

  const buildExecutor = (): RemoteExecutorConfig | null => {
    const host = form.host.trim();
    const localRoot = form.localRoot.trim();
    const remoteRoot = form.remoteRoot.trim();
    if (!host || !localRoot || !remoteRoot) return null;
    if (
      form.sessionStorageMode === "shared" &&
      (!form.localProjectsDir.trim() || !form.remoteProjectsDir.trim())
    ) {
      return null;
    }
    const port = form.port.trim() ? Number(form.port) : undefined;
    return {
      host,
      ...(form.user.trim() ? { user: form.user.trim() } : {}),
      ...(port ? { port } : {}),
      localRoot,
      remoteRoot,
      ...(form.claudePath.trim() ? { claudePath: form.claudePath.trim() } : {}),
      ...(form.sessionStorageMode === "ssh-replica" &&
      form.remoteClaudeConfigDir.trim()
        ? { remoteClaudeConfigDir: form.remoteClaudeConfigDir.trim() }
        : {}),
      ...(form.sessionStorageMode === "ssh-replica" &&
      form.remoteSessionsDir.trim()
        ? { remoteSessionsDir: form.remoteSessionsDir.trim() }
        : {}),
      sessionStorage:
        form.sessionStorageMode === "shared"
          ? {
              mode: "shared",
              localProjectsDir: form.localProjectsDir.trim(),
              remoteProjectsDir: form.remoteProjectsDir.trim(),
            }
          : { mode: "ssh-replica" },
    };
  };

  const add = async () => {
    const rawPort = form.port.trim();
    const port = rawPort ? Number(rawPort) : undefined;
    if (
      port !== undefined &&
      (!Number.isInteger(port) || port < 1 || port > 65_535)
    ) {
      setError(t("remoteExecutorsInvalidPort"));
      return;
    }
    const executor = buildExecutor();
    if (!executor || saving) {
      setError(t("remoteExecutorsRequiredFields"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await addExecutor(executor);
      setForm(EMPTY_FORM);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("remoteExecutorsAddFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const test = async (executor: RemoteExecutorConfig) => {
    setStatuses((current) => ({
      ...current,
      [executor.host]: { testing: true },
    }));
    try {
      const result = await testExecutor(executor);
      setStatuses((current) => ({
        ...current,
        [executor.host]: { testing: false, result },
      }));
    } catch (caught) {
      setStatuses((current) => ({
        ...current,
        [executor.host]: {
          testing: false,
          result: {
            success: false,
            host: executor.host,
            error:
              caught instanceof Error
                ? caught.message
                : t("remoteExecutorsConnectionFailed"),
          },
        },
      }));
    }
  };

  const setField = <K extends keyof ExecutorForm>(
    field: K,
    value: ExecutorForm[K],
  ) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  return (
    <section className="settings-section">
      <h2>{t("remoteExecutorsTitle")}</h2>
      <p className="settings-section-description">
        {t("remoteExecutorsDescription")}
      </p>

      <div className="settings-group">
        <div className="settings-item settings-item-stacked">
          <div className="settings-item-info">
            <strong>{t("remoteExecutorsAddTitle")}</strong>
            <p>{t("remoteExecutorsMappingDescription")}</p>
          </div>
          <div className="remote-executor-form-grid">
            <label>
              <span>{t("remoteExecutorsHostLabel")}</span>
              <input
                className="remote-executor-input"
                value={form.host}
                placeholder="192.168.64.4"
                onChange={(event) => setField("host", event.target.value)}
              />
            </label>
            <label>
              <span>{t("remoteExecutorsUserLabel")}</span>
              <input
                className="remote-executor-input"
                value={form.user}
                placeholder="yueyuan"
                onChange={(event) => setField("user", event.target.value)}
              />
            </label>
            <label>
              <span>{t("remoteExecutorsPortLabel")}</span>
              <input
                className="remote-executor-input"
                inputMode="numeric"
                value={form.port}
                placeholder="22"
                onChange={(event) => setField("port", event.target.value)}
              />
            </label>
            <label className="remote-executor-form-grid-wide">
              <span>{t("remoteExecutorsLocalRootLabel")}</span>
              <input
                className="remote-executor-input"
                value={form.localRoot}
                placeholder="/Users/me/shared/projects"
                onChange={(event) => setField("localRoot", event.target.value)}
              />
            </label>
            <label className="remote-executor-form-grid-wide">
              <span>{t("remoteExecutorsRemoteRootLabel")}</span>
              <input
                className="remote-executor-input"
                value={form.remoteRoot}
                placeholder="/mnt/macos-projects"
                onChange={(event) => setField("remoteRoot", event.target.value)}
              />
            </label>
            <label className="remote-executor-form-grid-wide">
              <span>{t("remoteExecutorsStorageModeLabel")}</span>
              <select
                className="remote-executor-input"
                value={form.sessionStorageMode}
                onChange={(event) =>
                  setField(
                    "sessionStorageMode",
                    event.target.value as ExecutorForm["sessionStorageMode"],
                  )
                }
              >
                <option value="shared">
                  {t("remoteExecutorsStorageShared")}
                </option>
                <option value="ssh-replica">
                  {t("remoteExecutorsStorageReplica")}
                </option>
              </select>
              <small>
                {form.sessionStorageMode === "shared"
                  ? t("remoteExecutorsStorageSharedDescription")
                  : t("remoteExecutorsStorageReplicaDescription")}
              </small>
            </label>
            {form.sessionStorageMode === "shared" && (
              <>
                <label className="remote-executor-form-grid-wide">
                  <span>{t("remoteExecutorsLocalProjectsDirLabel")}</span>
                  <input
                    className="remote-executor-input"
                    value={form.localProjectsDir}
                    placeholder="/Users/me/shared/claude/projects"
                    onChange={(event) =>
                      setField("localProjectsDir", event.target.value)
                    }
                  />
                </label>
                <label className="remote-executor-form-grid-wide">
                  <span>{t("remoteExecutorsRemoteProjectsDirLabel")}</span>
                  <input
                    className="remote-executor-input"
                    value={form.remoteProjectsDir}
                    placeholder="/mnt/shared/claude/projects"
                    onChange={(event) =>
                      setField("remoteProjectsDir", event.target.value)
                    }
                  />
                </label>
                <p className="settings-hint remote-executor-form-grid-wide">
                  {t("remoteExecutorsCredentialBoundaryWarning")}
                </p>
              </>
            )}
            <label className="remote-executor-form-grid-wide">
              <span>{t("remoteExecutorsClaudePathLabel")}</span>
              <input
                className="remote-executor-input"
                value={form.claudePath}
                placeholder="/home/me/.local/bin/claude"
                onChange={(event) => setField("claudePath", event.target.value)}
              />
            </label>
            {form.sessionStorageMode === "ssh-replica" && (
              <>
                <label className="remote-executor-form-grid-wide">
                  <span>{t("remoteExecutorsConfigDirLabel")}</span>
                  <input
                    className="remote-executor-input"
                    value={form.remoteClaudeConfigDir}
                    placeholder="/home/me/.claude"
                    onChange={(event) =>
                      setField("remoteClaudeConfigDir", event.target.value)
                    }
                  />
                </label>
                <label className="remote-executor-form-grid-wide">
                  <span>{t("remoteExecutorsRemoteSessionsDirLabel")}</span>
                  <input
                    className="remote-executor-input"
                    value={form.remoteSessionsDir}
                    placeholder="/home/me/.claude/projects"
                    onChange={(event) =>
                      setField("remoteSessionsDir", event.target.value)
                    }
                  />
                </label>
              </>
            )}
          </div>
          <button
            type="button"
            className="settings-button"
            disabled={saving}
            onClick={() => void add()}
          >
            {saving ? t("remoteExecutorsAdding") : t("remoteExecutorsAdd")}
          </button>
          {error && <p className="form-error">{error}</p>}
        </div>
      </div>

      <h3>{t("remoteExecutorsConfigured")}</h3>
      {loading ? (
        <p className="settings-hint">{t("remoteExecutorsLoading")}</p>
      ) : loadError ? (
        <p className="form-error">{loadError.message}</p>
      ) : executors.length === 0 ? (
        <p className="settings-hint">{t("remoteExecutorsEmpty")}</p>
      ) : (
        <div className="settings-group">
          {executors.map((executor) => {
            const status = statuses[executor.host];
            const ready = Boolean(
              status?.result?.success &&
                status.result.claudeAvailable &&
                status.result.localRootAvailable &&
                status.result.sharedRootAvailable &&
                (executor.sessionStorage?.mode !== "shared" ||
                  (status.result.localProjectsDirAvailable &&
                    status.result.localProjectsDirPermissionsSecure &&
                    status.result.remoteProjectsDirAvailable &&
                    status.result.remoteProjectsDirPermissionsSecure &&
                    status.result.remoteSessionStoreLinked &&
                    status.result.credentialStoragePrivate &&
                    status.result.remoteClaudeConfigDirUnset)),
            );
            return (
              <div key={executor.host} className="settings-item">
                <div className="settings-item-info">
                  <div className="settings-item-header">
                    <strong>
                      {executor.user ? `${executor.user}@` : ""}
                      {executor.host}
                      {executor.port && executor.port !== 22
                        ? `:${executor.port}`
                        : ""}
                    </strong>
                    {status?.result && (
                      <span
                        className={`settings-status-badge ${ready ? "settings-status-detected" : "settings-status-not-detected"}`}
                      >
                        {ready
                          ? t("remoteExecutorsConnected")
                          : t("remoteExecutorsFailed")}
                      </span>
                    )}
                  </div>
                  <code>
                    {executor.localRoot} → {executor.remoteRoot}
                  </code>
                  <p>
                    {executor.sessionStorage?.mode === "shared"
                      ? t("remoteExecutorsStorageShared")
                      : t("remoteExecutorsStorageReplica")}
                  </p>
                  {executor.sessionStorage?.mode === "shared" && (
                    <code>
                      {executor.sessionStorage.localProjectsDir} →{" "}
                      {executor.sessionStorage.remoteProjectsDir}
                    </code>
                  )}
                  {status?.result?.claudeVersion && (
                    <p>{status.result.claudeVersion}</p>
                  )}
                  {status?.result?.error && (
                    <p className="form-error">{status.result.error}</p>
                  )}
                </div>
                <div className="settings-item-actions">
                  <button
                    type="button"
                    className="settings-button"
                    disabled={status?.testing}
                    onClick={() => void test(executor)}
                  >
                    {status?.testing
                      ? t("remoteExecutorsTesting")
                      : t("remoteExecutorsTestConnection")}
                  </button>
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    onClick={() => {
                      void removeExecutor(executor.host).catch((caught) => {
                        setError(
                          caught instanceof Error
                            ? caught.message
                            : t("remoteExecutorsAddFailed"),
                        );
                      });
                    }}
                  >
                    {t("remoteExecutorsRemove")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
