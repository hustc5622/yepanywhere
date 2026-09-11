import type {
  FeishuAccountPublicView,
  FeishuUserAuthView,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { fetchJSON } from "../../api/client";
import { useI18n } from "../../i18n";

export function FeishuAuthorizationSettings() {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<FeishuAccountPublicView[]>([]);
  const [users, setUsers] = useState<FeishuUserAuthView[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connector, setConnector] = useState("");
  const reload = useCallback(async () => {
    const [a, u] = await Promise.all([
      fetchJSON<{ accounts: FeishuAccountPublicView[] }>(
        "/channels/feishu/accounts",
      ),
      fetchJSON<{ users: FeishuUserAuthView[] }>("/channels/feishu/user-auth"),
    ]);
    setAccounts(a.accounts);
    setUsers(u.users);
  }, []);
  useEffect(() => {
    void reload().catch((e) => setError(String(e)));
    const timer = setInterval(() => {
      void reload().catch((e) => setError(String(e)));
    }, 10_000);
    return () => clearInterval(timer);
  }, [reload]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const action = async (
    user: FeishuUserAuthView,
    kind: string,
    workspace?: string,
  ) => {
    const result = await fetchJSON<
      FeishuUserAuthView & { mcpServer?: { command: string; args: string[] } }
    >(
      `/channels/feishu/accounts/${encodeURIComponent(user.accountId)}/user-auth/${encodeURIComponent(user.userOpenId)}/action`,
      { method: "POST", body: JSON.stringify({ action: kind, workspace }) },
    );
    if (result.mcpServer) {
      setConnector(
        `[mcp_servers.yep-feishu]\ncommand = ${JSON.stringify(result.mcpServer.command)}\nargs = ${JSON.stringify(result.mcpServer.args)}\ntool_timeout_sec = 240\n`,
      );
    }
  };
  return (
    <section className="settings-section">
      <h2>{t("feishuAuthTitle")}</h2>
      <p className="settings-section-description">
        {t("feishuAuthDescription")}
      </p>
      {error && <p role="alert">{error}</p>}
      {accounts.length === 0 && <p>{t("feishuAuthNoAccounts")}</p>}
      {accounts.map((account) => (
        <div className="settings-group" key={account.id}>
          <h3>{account.name}</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void run(async () => {
                await fetchJSON(
                  `/channels/feishu/accounts/${encodeURIComponent(account.id)}/user-auth`,
                  {
                    method: "PUT",
                    body: JSON.stringify({
                      enabled: data.get("enabled") === "on",
                      redirectUri:
                        String(data.get("redirectUri") ?? "").trim() ||
                        undefined,
                      scopes: String(data.get("scopes") ?? "")
                        .split(/\s+/)
                        .filter(Boolean),
                    }),
                  },
                );
              });
            }}
          >
            <label>
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={account.userAuth?.enabled ?? false}
              />{" "}
              {t("feishuAuthEnable")}
            </label>
            <p>
              <label>
                {t("feishuAuthCallback")}
                <input
                  className="settings-input"
                  name="redirectUri"
                  type="url"
                  defaultValue={account.userAuth?.redirectUri ?? ""}
                  placeholder="https://example.com/yep/api/auth/feishu/callback"
                />
              </label>
            </p>
            <p>{t("feishuAuthCallbackHelp")}</p>
            <p>
              <label>
                {t("feishuAuthScopes")}
                <textarea
                  className="settings-input"
                  name="scopes"
                  rows={3}
                  defaultValue={(
                    account.userAuth?.scopes ?? [
                      "offline_access",
                      "contact:user.base:readonly",
                      "drive:file:download",
                      "space:document:retrieve",
                      "drive:drive.metadata:readonly",
                      "docx:document:readonly",
                    ]
                  ).join(" ")}
                />
              </label>
            </p>
            <button type="submit" disabled={busy}>
              {t("feishuAuthSave")}
            </button>
          </form>
          {users
            .filter((user) => user.accountId === account.id)
            .map((user) => (
              <div
                className="settings-item"
                key={user.userOpenId}
                style={{ display: "block" }}
              >
                <p>
                  {user.userOpenId} · {t(`feishuAuthState_${user.status}`)}
                </p>
                {user.lastRefreshedAt && (
                  <p>
                    {t("feishuAuthLastRefresh")}:{" "}
                    {new Date(user.lastRefreshedAt).toLocaleString()}
                  </p>
                )}
                {user.lastError && <p>{user.lastError}</p>}
                {user.authorizationUrl && (
                  <p>
                    <a
                      href={user.authorizationUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("feishuAuthOpen")}
                    </a>
                  </p>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => action(user, "connect"))}
                >
                  {t("feishuAuthConnect")}
                </button>{" "}
                {user.authorizationUrl && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => action(user, "cancel"))}
                  >
                    {t("feishuAuthCancel")}
                  </button>
                )}
                {account.defaultProjectPath && (
                  <p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          action(
                            user,
                            "mcp-config",
                            account.defaultProjectPath,
                          ),
                        )
                      }
                    >
                      {t("feishuAuthConnector")}
                    </button>
                  </p>
                )}
              </div>
            ))}
        </div>
      ))}
      {connector && (
        <div>
          <p>{t("feishuAuthConnectorHelp")}</p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {connector}
          </pre>
        </div>
      )}
    </section>
  );
}
