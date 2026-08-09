import type {
  FeishuAccountConfig,
  FeishuAccountPublicView,
  FeishuAccountStatus,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type FeishuDoctorResult,
  type FeishuPermissionRequirements,
  api,
} from "../../api/client";
import { useI18n } from "../../i18n";

interface AccountForm {
  id: string;
  name: string;
  enabled: boolean;
  domain: "feishu" | "lark";
  appId: string;
  appSecret: string;
  tenantKey: string;
  defaultProjectPath: string;
  allowedWorkspaceRoots: string;
  allowedUsers: string;
  adminUsers: string;
  allowedChats: string;
  requireMentionInGroup: boolean;
  groupSessionMode: "chat" | "thread-when-available";
  defaultModel: string;
  defaultReasoningEffort: string;
  defaultCodexMcpMode: FeishuAccountConfig["defaultCodexMcpMode"];
  defaultPermissionMode: FeishuAccountConfig["defaultPermissionMode"];
  replyMode: FeishuAccountConfig["replyMode"];
}

const EMPTY_FORM: AccountForm = {
  id: "",
  name: "",
  enabled: false,
  domain: "feishu",
  appId: "",
  appSecret: "",
  tenantKey: "",
  defaultProjectPath: "",
  allowedWorkspaceRoots: "",
  allowedUsers: "",
  adminUsers: "",
  allowedChats: "",
  requireMentionInGroup: true,
  groupSessionMode: "thread-when-available",
  defaultModel: "",
  defaultReasoningEffort: "",
  defaultCodexMcpMode: "standard",
  defaultPermissionMode: "default",
  replyMode: "card",
};

export function FeishuSettings() {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<FeishuAccountPublicView[]>([]);
  const [statuses, setStatuses] = useState<FeishuAccountStatus[]>([]);
  const [doctor, setDoctor] = useState<FeishuDoctorResult | null>(null);
  const [permissions, setPermissions] =
    useState<FeishuPermissionRequirements | null>(null);
  const [form, setForm] = useState<AccountForm | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [accountResult, statusResult, doctorResult] =
      await Promise.allSettled([
        api.getFeishuAccounts(),
        api.getFeishuStatuses(),
        api.getFeishuDoctor(),
      ]);

    if (accountResult.status === "fulfilled") {
      setAccounts(accountResult.value.accounts);
    }
    if (statusResult.status === "fulfilled") {
      setStatuses(statusResult.value.accounts);
    }
    if (doctorResult.status === "fulfilled") {
      setDoctor(doctorResult.value);
    }

    const failure = [accountResult, statusResult, doctorResult].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    setError(failure ? errorMessage(failure.reason) : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const statusByAccount = useMemo(
    () => new Map(statuses.map((status) => [status.accountId, status])),
    [statuses],
  );

  const editAccount = async (account: FeishuAccountPublicView) => {
    setForm(toForm(account));
    setEditingExisting(true);
    setNotice(null);
    setError(null);
    try {
      setPermissions(await api.getFeishuPermissions(account.id));
    } catch {
      setPermissions(null);
    }
  };

  const setField = <K extends keyof AccountForm>(
    key: K,
    value: AccountForm[K],
  ) => setForm((current) => (current ? { ...current, [key]: value } : current));

  const save = async () => {
    if (!form || busy) return;
    const id = form.id.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      setError(t("feishuInvalidAccountId"));
      return;
    }

    const account: Omit<FeishuAccountConfig, "secretRef"> = {
      id,
      name: form.name.trim(),
      enabled: form.enabled,
      domain: form.domain,
      appId: form.appId.trim(),
      ...(form.tenantKey.trim() ? { tenantKey: form.tenantKey.trim() } : {}),
      ...(form.defaultProjectPath.trim()
        ? { defaultProjectPath: form.defaultProjectPath.trim() }
        : {}),
      allowedWorkspaceRoots: parseList(form.allowedWorkspaceRoots),
      allowedUsers: parseList(form.allowedUsers),
      adminUsers: parseList(form.adminUsers),
      allowedChats: parseList(form.allowedChats),
      requireMentionInGroup: form.requireMentionInGroup,
      groupSessionMode: form.groupSessionMode,
      defaultProvider: "codex",
      ...(form.defaultModel.trim()
        ? { defaultModel: form.defaultModel.trim() }
        : {}),
      ...(form.defaultReasoningEffort.trim()
        ? { defaultReasoningEffort: form.defaultReasoningEffort.trim() }
        : {}),
      defaultCodexMcpMode: form.defaultCodexMcpMode,
      defaultPermissionMode: form.defaultPermissionMode,
      replyMode: form.replyMode,
    };
    const appSecret = form.appSecret.trim();

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Never start/restart an enabled account with a missing or stale secret.
      // Stage it disabled, write the secret through its dedicated endpoint,
      // then apply the requested enabled state.
      if (appSecret && account.enabled) {
        await api.saveFeishuAccount({ ...account, enabled: false });
        await api.setFeishuSecret(id, appSecret);
        await api.saveFeishuAccount(account);
      } else {
        await api.saveFeishuAccount(account);
        if (appSecret) await api.setFeishuSecret(id, appSecret);
      }
      setNotice(t("feishuSaved"));
      setForm(null);
      setPermissions(null);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const runAccountAction = async (
    action: () => Promise<unknown>,
    successMessage: string,
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await refresh();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const exportDiagnostics = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      downloadDiagnostics(await api.getFeishuDiagnostics());
      setNotice(t("feishuDiagnosticsExported"));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const allowedUsers = form
    ? [...parseList(form.allowedUsers), ...parseList(form.adminUsers)]
    : [];
  const allowedChats = form ? parseList(form.allowedChats) : [];

  return (
    <>
      <section className="settings-section">
        <h2>{t("feishuSettingsTitle")}</h2>
        <p className="settings-section-description">
          {t("feishuSettingsDescription")}
        </p>
        {loading ? (
          <p className="settings-hint">{t("feishuLoading")}</p>
        ) : (
          <div className="settings-group">
            {accounts.map((account) => {
              const status = statusByAccount.get(account.id);
              return (
                <div key={account.id} className="settings-item">
                  <div className="settings-item-info">
                    <div className="settings-item-header">
                      <strong>{account.name}</strong>
                      <span
                        className={`settings-status-badge ${status?.state === "connected" ? "settings-status-detected" : "settings-status-warning"}`}
                      >
                        {connectionStateLabel(status?.state ?? "stopped", t)}
                      </span>
                    </div>
                    <p>
                      {account.id} · {account.domain} · {account.appId} ·{" "}
                      {account.secret.configured
                        ? t("feishuSecretConfigured")
                        : t("feishuSecretMissing")}
                    </p>
                    {status?.lastErrorCode && (
                      <p className="form-error">{status.lastErrorCode}</p>
                    )}
                    {status && (
                      <p>
                        {t("feishuStatusTimes", {
                          connected: formatTimestamp(status.connectedAt),
                          event: formatTimestamp(status.lastEventAt),
                          api: formatTimestamp(status.lastApiSuccessAt),
                        })}
                      </p>
                    )}
                    {status?.metrics && (
                      <p>
                        {t("feishuMetricsSummary", {
                          accepted: status.metrics.messagesAccepted,
                          duplicate: status.metrics.messagesDuplicateDropped,
                          rejected: status.metrics.messagesRejected,
                          failed: status.metrics.messagesFailed,
                          degraded: status.metrics.cardUpdateDegraded,
                          pending: status.metrics.pendingApprovals,
                          queue: status.metrics.scopeQueueDepth,
                        })}
                      </p>
                    )}
                  </div>
                  <div className="settings-item-actions">
                    <button
                      type="button"
                      className="settings-button"
                      onClick={() => void editAccount(account)}
                    >
                      {t("feishuEdit")}
                    </button>
                    {status?.state === "connected" ? (
                      <button
                        type="button"
                        className="settings-button"
                        disabled={busy || !account.enabled}
                        onClick={() =>
                          void runAccountAction(
                            () => api.disconnectFeishuAccount(account.id),
                            t("feishuDisconnected"),
                          )
                        }
                      >
                        {t("feishuDisconnect")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="settings-button"
                        disabled={busy || !account.enabled}
                        onClick={() =>
                          void runAccountAction(
                            () => api.connectFeishuAccount(account.id),
                            t("feishuConnectRequested"),
                          )
                        }
                      >
                        {t("feishuConnect")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="settings-button"
                      disabled={busy || !account.enabled}
                      onClick={() =>
                        void runAccountAction(
                          () => api.reconnectFeishuAccount(account.id),
                          t("feishuReconnectRequested"),
                        )
                      }
                    >
                      {t("feishuReconnect")}
                    </button>
                    <button
                      type="button"
                      className="settings-button"
                      disabled={busy}
                      onClick={() =>
                        void runAccountAction(async () => {
                          const result = await api.testFeishuAccount(
                            account.id,
                          );
                          if (!result.ok) {
                            throw new Error(t("feishuTestFailed"));
                          }
                        }, t("feishuTestPassed"))
                      }
                    >
                      {t("feishuTest")}
                    </button>
                  </div>
                </div>
              );
            })}
            {accounts.length === 0 && (
              <p className="settings-hint">{t("feishuNoAccounts")}</p>
            )}
            <button
              type="button"
              className="settings-button"
              onClick={() => {
                setForm({ ...EMPTY_FORM });
                setEditingExisting(false);
                setPermissions(null);
                setNotice(null);
                setError(null);
              }}
            >
              {t("feishuAddAccount")}
            </button>
          </div>
        )}
        {notice && <p className="settings-hint">{notice}</p>}
        {error && <p className="form-error">{error}</p>}
      </section>

      {form && (
        <section className="settings-section">
          <h2>
            {editingExisting
              ? t("feishuEditAccountTitle")
              : t("feishuAddAccountTitle")}
          </h2>
          {form.enabled && allowedUsers.length === 0 && (
            <p className="form-error">{t("feishuNoUsersWarning")}</p>
          )}
          {form.enabled && allowedChats.length === 0 && (
            <p className="form-error">{t("feishuNoChatsWarning")}</p>
          )}
          <div className="settings-item settings-item-stacked">
            <div className="feishu-settings-form-grid">
              <Field
                label={t("feishuAccountId")}
                value={form.id}
                disabled={editingExisting}
                onChange={(value) => setField("id", value)}
              />
              <Field
                label={t("feishuAccountName")}
                value={form.name}
                onChange={(value) => setField("name", value)}
              />
              <label>
                <span>{t("feishuDomain")}</span>
                <select
                  className="remote-executor-input"
                  value={form.domain}
                  onChange={(event) =>
                    setField("domain", event.target.value as "feishu" | "lark")
                  }
                >
                  <option value="feishu">Feishu</option>
                  <option value="lark">Lark</option>
                </select>
              </label>
              <Field
                label={t("feishuAppId")}
                value={form.appId}
                placeholder="cli_<16 hexadecimal characters>"
                onChange={(value) => setField("appId", value)}
              />
              <Field
                label={t("feishuAppSecret")}
                value={form.appSecret}
                type="password"
                placeholder={t("feishuSecretPlaceholder")}
                onChange={(value) => setField("appSecret", value)}
              />
              <Field
                label={t("feishuTenantKey")}
                value={form.tenantKey}
                onChange={(value) => setField("tenantKey", value)}
              />
              <Field
                wide
                label={t("feishuDefaultProject")}
                value={form.defaultProjectPath}
                placeholder="/workspace/project"
                onChange={(value) => setField("defaultProjectPath", value)}
              />
              <TextAreaField
                label={t("feishuWorkspaceRoots")}
                value={form.allowedWorkspaceRoots}
                onChange={(value) => setField("allowedWorkspaceRoots", value)}
              />
              <TextAreaField
                label={t("feishuAllowedUsers")}
                value={form.allowedUsers}
                onChange={(value) => setField("allowedUsers", value)}
              />
              <TextAreaField
                label={t("feishuAdminUsers")}
                value={form.adminUsers}
                onChange={(value) => setField("adminUsers", value)}
              />
              <TextAreaField
                label={t("feishuAllowedChats")}
                value={form.allowedChats}
                onChange={(value) => setField("allowedChats", value)}
              />
              <label>
                <span>{t("feishuSessionMode")}</span>
                <select
                  className="remote-executor-input"
                  value={form.groupSessionMode}
                  onChange={(event) =>
                    setField(
                      "groupSessionMode",
                      event.target.value as AccountForm["groupSessionMode"],
                    )
                  }
                >
                  <option value="thread-when-available">
                    {t("feishuSessionModeThread")}
                  </option>
                  <option value="chat">{t("feishuSessionModeChat")}</option>
                </select>
              </label>
              <label>
                <span>{t("feishuPermissionMode")}</span>
                <select
                  className="remote-executor-input"
                  value={form.defaultPermissionMode}
                  onChange={(event) =>
                    setField(
                      "defaultPermissionMode",
                      event.target
                        .value as AccountForm["defaultPermissionMode"],
                    )
                  }
                >
                  <option value="auto">auto</option>
                  <option value="default">default</option>
                  <option value="plan">plan</option>
                  <option value="acceptEdits">acceptEdits</option>
                </select>
              </label>
              <Field
                label={t("feishuDefaultModel")}
                value={form.defaultModel}
                placeholder={t("feishuProviderDefault")}
                onChange={(value) => setField("defaultModel", value)}
              />
              <Field
                label={t("feishuDefaultReasoning")}
                value={form.defaultReasoningEffort}
                placeholder={t("feishuProviderDefault")}
                onChange={(value) => setField("defaultReasoningEffort", value)}
              />
              <label>
                <span>{t("feishuDefaultMcpProfile")}</span>
                <select
                  className="remote-executor-input"
                  value={form.defaultCodexMcpMode}
                  onChange={(event) =>
                    setField(
                      "defaultCodexMcpMode",
                      event.target.value as AccountForm["defaultCodexMcpMode"],
                    )
                  }
                >
                  <option value="clear">clear</option>
                  <option value="standard">standard</option>
                  <option value="full">full</option>
                </select>
              </label>
              <label>
                <span>{t("feishuReplyMode")}</span>
                <select
                  className="remote-executor-input"
                  value={form.replyMode}
                  onChange={(event) =>
                    setField(
                      "replyMode",
                      event.target.value as AccountForm["replyMode"],
                    )
                  }
                >
                  <option value="card">card</option>
                  <option value="markdown">markdown</option>
                  <option value="text">text</option>
                </select>
              </label>
            </div>
            <div className="settings-item-actions">
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) =>
                    setField("enabled", event.target.checked)
                  }
                />
                {t("feishuEnabled")}
              </label>
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={form.requireMentionInGroup}
                  onChange={(event) =>
                    setField("requireMentionInGroup", event.target.checked)
                  }
                />
                {t("feishuRequireMention")}
              </label>
            </div>
            <div className="settings-item-actions">
              <button
                type="button"
                className="settings-button"
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? t("feishuSaving") : t("feishuSave")}
              </button>
              <button
                type="button"
                className="settings-button"
                disabled={busy}
                onClick={() => {
                  setForm(null);
                  setPermissions(null);
                }}
              >
                {t("feishuCancel")}
              </button>
              {editingExisting && (
                <button
                  type="button"
                  className="settings-button settings-button-danger"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(t("feishuDeleteConfirm"))) return;
                    void runAccountAction(
                      () => api.deleteFeishuAccount(form.id),
                      t("feishuDeleted"),
                    ).then((removed) => {
                      if (removed) {
                        setForm(null);
                        setPermissions(null);
                      }
                    });
                  }}
                >
                  {t("feishuDelete")}
                </button>
              )}
            </div>
          </div>
          {permissions && (
            <div className="settings-item settings-item-stacked">
              <strong>{t("feishuPermissionsTitle")}</strong>
              <code>
                {[...permissions.events, ...permissions.callbacks].join(", ")}
              </code>
              <code>
                {permissions.capabilities
                  .flatMap((capability) => capability.scopes)
                  .join(", ")}
              </code>
            </div>
          )}
        </section>
      )}

      <section className="settings-section">
        <h2>{t("feishuDoctorTitle")}</h2>
        <p className="settings-section-description">
          {doctorSummary(doctor, t)}
        </p>
        <button
          type="button"
          className="settings-button"
          disabled={busy}
          onClick={() => void exportDiagnostics()}
        >
          {t("feishuExportDiagnostics")}
        </button>
      </section>
    </>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  wide?: boolean;
}) {
  return (
    <label className={props.wide ? "feishu-settings-form-wide" : undefined}>
      <span>{props.label}</span>
      <input
        className="remote-executor-input"
        type={props.type}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function TextAreaField(props: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label>
      <span>{props.label}</span>
      <textarea
        className="remote-executor-input"
        rows={3}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function toForm(account: FeishuAccountPublicView): AccountForm {
  return {
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    domain: account.domain,
    appId: account.appId,
    appSecret: "",
    tenantKey: account.tenantKey ?? "",
    defaultProjectPath: account.defaultProjectPath ?? "",
    allowedWorkspaceRoots: account.allowedWorkspaceRoots.join("\n"),
    allowedUsers: account.allowedUsers.join("\n"),
    adminUsers: account.adminUsers.join("\n"),
    allowedChats: account.allowedChats.join("\n"),
    requireMentionInGroup: account.requireMentionInGroup,
    groupSessionMode: account.groupSessionMode,
    defaultModel: account.defaultModel ?? "",
    defaultReasoningEffort: account.defaultReasoningEffort ?? "",
    defaultCodexMcpMode: account.defaultCodexMcpMode,
    defaultPermissionMode: account.defaultPermissionMode,
    replyMode: account.replyMode,
  };
}

function parseList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function downloadDiagnostics(report: Record<string, unknown>): void {
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `yep-feishu-diagnostics-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "—" : timestamp.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Translate = ReturnType<typeof useI18n>["t"];

function connectionStateLabel(
  state: FeishuAccountStatus["state"],
  t: Translate,
): string {
  switch (state) {
    case "disabled":
      return t("feishuConnectionStateDisabled");
    case "locked":
      return t("feishuConnectionStateLocked");
    case "connecting":
      return t("feishuConnectionStateConnecting");
    case "connected":
      return t("feishuConnectionStateConnected");
    case "degraded":
      return t("feishuConnectionStateDegraded");
    case "stopped":
      return t("feishuConnectionStateStopped");
  }
}

function doctorSummary(
  doctor: FeishuDoctorResult | null,
  t: Translate,
): string {
  switch (doctor?.initializationErrorCode) {
    case "STORE_INITIALIZATION_FAILED":
      return t("feishuDoctorStoreInitializationFailed");
    case "CHANNEL_NOT_INITIALIZED":
      return t("feishuDoctorChannelNotInitialized");
    case "CHANNEL_STOPPED":
      return t("feishuDoctorChannelStopped");
    default:
      return doctor?.ok
        ? t("feishuDoctorHealthy")
        : t("feishuDoctorNeedsAttention");
  }
}
