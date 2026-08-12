import { useState } from "react";
import { api } from "../../api/client";
import { AllowedHostsManager } from "../../components/AllowedHostsManager";
import { FilterDropdown } from "../../components/FilterDropdown";
import { useOptionalAuth } from "../../contexts/AuthContext";
import {
  MOBILE_SHELL_NODES,
  formatMobileShellNodeLabel,
  formatMobileShellNodeOrigin,
  useMobileShellChannel,
} from "../../hooks/useMobileShellChannel";
import { useNetworkBinding } from "../../hooks/useNetworkBinding";
import { useServerInfo } from "../../hooks/useServerInfo";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { LocalAccessAuthCard } from "./LocalAccessAuthCard";

function MobileShellChannelSettings() {
  const { t } = useI18n();
  const { isMobileShell, channel, nodeOrigin, setChannel, setNode } =
    useMobileShellChannel();

  if (!isMobileShell) return null;

  return (
    <div className="settings-group">
      <div className="settings-item settings-item-stacked">
        <div className="settings-item-row">
          <div className="settings-item-info">
            <strong>{t("localAccessMobileNodeTitle")}</strong>
            <p>{t("localAccessMobileNodeDescription")}</p>
          </div>
        </div>
        <div
          className="settings-mobile-node-options"
          role="group"
          aria-label={t("localAccessMobileNodeTitle")}
        >
          {MOBILE_SHELL_NODES.map((node) => {
            const isActive = channel === "tcp" && nodeOrigin === node.origin;
            return (
              <button
                key={node.origin}
                type="button"
                className={`settings-button settings-mobile-node-button ${isActive ? "active" : ""}`}
                aria-pressed={isActive}
                onClick={() => {
                  if (!isActive) setNode(node);
                }}
              >
                {formatMobileShellNodeLabel(node)}
              </button>
            );
          })}
          <button
            type="button"
            className={`settings-button settings-mobile-node-button ${channel === "http" ? "active" : ""}`}
            aria-pressed={channel === "http"}
            onClick={() => {
              if (channel !== "http") setChannel("http");
            }}
          >
            {t("localAccessMobileRelay")}
          </button>
        </div>
        <div className="settings-mobile-node-current">
          {channel === "http"
            ? t("localAccessMobileCurrentHttp")
            : t("localAccessMobileCurrentNode", {
                node: formatMobileShellNodeOrigin(nodeOrigin),
              })}
        </div>
      </div>
    </div>
  );
}

export function LocalAccessSettings() {
  const { t } = useI18n();
  const auth = useOptionalAuth();
  const { serverInfo, loading: serverInfoLoading } = useServerInfo();
  const {
    binding,
    loading: bindingLoading,
    error: bindingError,
    applying,
    updateBinding,
  } = useNetworkBinding();
  const { settings: serverSettings, isLoading: settingsLoading } =
    useServerSettings();

  // Network binding form state
  const [localhostPort, setLocalhostPort] = useState<string>("");
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [selectedInterface, setSelectedInterface] = useState<string>("");
  const [customIp, setCustomIp] = useState("");

  const [localhostOpenToggle, setLocalhostOpenToggle] = useState(false);

  // Allowed hosts form state
  const [allowAllHostsToggle, setAllowAllHostsToggle] = useState(false);
  const [customHosts, setCustomHosts] = useState<string[]>([]);

  // Form state
  const [formError, setFormError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  // Initialize the network form from binding, auth, and settings state.
  const [formInitialized, setFormInitialized] = useState(false);
  if (binding && auth && serverSettings && !formInitialized) {
    setLocalhostPort(String(binding.localhost.port));
    setNetworkEnabled(binding.network.enabled);
    setSelectedInterface(binding.network.host ?? "");
    setLocalhostOpenToggle(auth.localhostOpen);
    // Initialize allowed hosts from server settings
    const ah = serverSettings.allowedHosts;
    if (ah === "*") {
      setAllowAllHostsToggle(true);
      setCustomHosts([]);
    } else {
      setAllowAllHostsToggle(false);
      // 将逗号分隔的字符串转换为数组
      const hosts = ah
        ? ah
            .split(",")
            .map((h) => h.trim())
            .filter(Boolean)
        : [];
      setCustomHosts(hosts);
    }
    setFormInitialized(true);
  }

  // Compute the effective allowedHosts value for comparison/saving
  const getAllowedHostsValue = (
    toggle: boolean,
    hosts: string[],
  ): string | undefined => {
    if (toggle) return "*";
    const hostsString = hosts.join(",");
    return hostsString || undefined;
  };

  // Track network, localhost-open, and allowed-host changes.
  const checkForChanges = (
    newPort: string,
    newNetworkEnabled: boolean,
    newInterface: string,
    newAllowAllHosts: boolean,
    newCustomHosts: string[],
    newLocalhostOpen: boolean,
  ) => {
    if (!binding || !auth || !serverSettings) return false;
    const portChanged = newPort !== String(binding.localhost.port);
    const networkEnabledChanged = newNetworkEnabled !== binding.network.enabled;
    const interfaceChanged = newInterface !== (binding.network.host ?? "");
    const localhostOpenChanged = newLocalhostOpen !== auth.localhostOpen;
    const newValue = getAllowedHostsValue(newAllowAllHosts, newCustomHosts);
    const oldValue = serverSettings.allowedHosts;
    const allowedHostsChanged = (newValue ?? "") !== (oldValue ?? "");
    return (
      portChanged ||
      networkEnabledChanged ||
      interfaceChanged ||
      localhostOpenChanged ||
      allowedHostsChanged
    );
  };

  // Helper for onChange handlers
  const updateHasChanges = (overrides: {
    port?: string;
    networkEnabled?: boolean;
    iface?: string;
    allowAll?: boolean;
    customHosts?: string[];
    localhostOpen?: boolean;
  }) => {
    setHasChanges(
      checkForChanges(
        overrides.port ?? localhostPort,
        overrides.networkEnabled ?? networkEnabled,
        overrides.iface ?? selectedInterface,
        overrides.allowAll ?? allowAllHostsToggle,
        overrides.customHosts ?? customHosts,
        overrides.localhostOpen ?? localhostOpenToggle,
      ),
    );
  };

  const handleApplyChanges = async () => {
    if (!auth) return;
    setFormError(null);

    // Validate port
    const portNum = Number.parseInt(localhostPort, 10);
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setFormError(t("localAccessErrorPortRange"));
      return;
    }

    const effectiveInterface =
      selectedInterface === "custom" ? customIp : selectedInterface;

    setIsApplying(true);
    try {
      // Apply network binding changes (skip overridden fields to avoid 400 errors)
      const bindingUpdate: Parameters<typeof updateBinding>[0] = {};
      if (!binding?.localhost.overriddenByCli) {
        bindingUpdate.localhostPort = portNum;
      }
      if (!binding?.network.overriddenByCli) {
        bindingUpdate.network = {
          enabled: networkEnabled,
          host: networkEnabled ? effectiveInterface : undefined,
        };
      }
      const result = await updateBinding(bindingUpdate);

      // Apply localhost access changes (desktop token floor bypass)
      if (localhostOpenToggle !== auth.localhostOpen) {
        await auth.setLocalhostOpen(localhostOpenToggle);
      }

      // Apply allowed hosts changes
      const newAllowedHosts = getAllowedHostsValue(
        allowAllHostsToggle,
        customHosts,
      );
      await api.updateServerSettings({
        allowedHosts: newAllowedHosts ?? "",
      });

      if (result.redirectUrl) {
        // Server changed port, redirect to new URL preserving current path
        const newUrl = new URL(result.redirectUrl);
        newUrl.pathname = window.location.pathname;
        newUrl.search = window.location.search;
        window.location.href = newUrl.toString();
      } else {
        setHasChanges(false);
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : t("localAccessErrorApplyFailed"),
      );
    } finally {
      setIsApplying(false);
    }
  };

  // Non-remote mode (cookie-based auth)
  if (auth) {
    // Show loading state until data is ready
    const isLoading =
      serverInfoLoading ||
      bindingLoading ||
      settingsLoading ||
      auth.isLoading ||
      !formInitialized;

    if (isLoading) {
      return (
        <section className="settings-section">
          <h2>{t("settingsLocalAccessTitle")}</h2>
          <p className="settings-section-description">
            {t("localAccessLoading")}
          </p>
        </section>
      );
    }

    return (
      <section className="settings-section">
        <h2>{t("settingsLocalAccessTitle")}</h2>
        <p className="settings-section-description">
          {t("localAccessDescription")}
        </p>

        <MobileShellChannelSettings />

        {/* Current status */}
        <div className="settings-group">
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("localAccessStatusTitle")}</strong>
              <p>
                {serverInfo
                  ? (() => {
                      const networkHost = binding?.network.host;
                      const networkPort =
                        binding?.network.port ?? serverInfo.port;
                      const isAllInterfaces =
                        networkHost === "0.0.0.0" || networkHost === "::";
                      const samePort = networkPort === serverInfo.port;

                      // If bound to all interfaces on same port, just show that
                      if (
                        binding?.network.enabled &&
                        isAllInterfaces &&
                        samePort
                      ) {
                        return (
                          <>
                            {t("localAccessListeningOn")}{" "}
                            <code>
                              {networkHost}:{networkPort}
                            </code>
                          </>
                        );
                      }

                      // Otherwise show localhost, and optionally network
                      return (
                        <>
                          {t("localAccessListeningOn")}{" "}
                          <code>
                            {serverInfo.host}:{serverInfo.port}
                          </code>
                          {binding?.network.enabled && networkHost && (
                            <>
                              {" "}
                              {t("localAccessListeningAnd")}{" "}
                              <code>
                                {networkHost}:{networkPort}
                              </code>
                            </>
                          )}
                        </>
                      );
                    })()
                  : t("localAccessUnableToFetch")}
              </p>
            </div>
            {serverInfo?.localhostOnly && !binding?.network.enabled && (
              <span className="settings-status-badge settings-status-detected">
                {t("localAccessBadgeLocalOnly")}
              </span>
            )}
            {(serverInfo?.boundToAllInterfaces || binding?.network.enabled) &&
              !auth.authEnabled && (
                <span className="settings-status-badge settings-status-warning">
                  {t("localAccessBadgeNetworkExposed")}
                </span>
              )}
          </div>
        </div>

        {/* Network Configuration */}
        <form
          className="settings-group"
          onSubmit={(e) => {
            e.preventDefault();
            handleApplyChanges();
          }}
        >
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("localAccessListeningPortTitle")}</strong>
              <p>{t("localAccessListeningPortDescription")}</p>
            </div>
            {binding?.localhost.overriddenByCli ? (
              <span className="settings-value-readonly">
                {binding.localhost.port}{" "}
                <span className="settings-hint">
                  {t("localAccessSetViaPort")}
                </span>
              </span>
            ) : (
              <input
                type="number"
                className="settings-input-small"
                value={localhostPort}
                onChange={(e) => {
                  setLocalhostPort(e.target.value);
                  updateHasChanges({ port: e.target.value });
                }}
                min={1}
                max={65535}
                autoComplete="off"
              />
            )}
          </div>

          {/* Network binding - consolidated into one card */}
          <div className="settings-item settings-item-stacked">
            <div className="settings-item-row">
              <div className="settings-item-info">
                <strong>{t("localAccessNetworkTitle")}</strong>
                <p>{t("localAccessNetworkDescription")}</p>
              </div>
              {binding?.network.overriddenByCli ? (
                <span className="settings-value-readonly">
                  {binding.network.host}:{binding.network.port}{" "}
                  <span className="settings-hint">
                    {t("localAccessSetViaHost")}
                  </span>
                </span>
              ) : (
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={networkEnabled}
                    onChange={(e) => {
                      setNetworkEnabled(e.target.checked);
                      updateHasChanges({ networkEnabled: e.target.checked });
                    }}
                  />
                  <span className="toggle-slider" />
                </label>
              )}
            </div>

            {/* Network interface selector - shown when network is enabled */}
            {networkEnabled && !binding?.network.overriddenByCli && binding && (
              <div className="settings-nested-content">
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>{t("localAccessInterfaceTitle")}</strong>
                    <p>{t("localAccessInterfaceDescription")}</p>
                  </div>
                  <FilterDropdown
                    label={t("localAccessInterfaceTitle")}
                    placeholder={t("localAccessInterfacePlaceholder")}
                    multiSelect={false}
                    align="right"
                    options={[
                      ...binding.interfaces.map((iface) => ({
                        value: iface.address,
                        label: iface.displayName,
                      })),
                      {
                        value: "0.0.0.0",
                        label: t("localAccessInterfaceAll"),
                      },
                      {
                        value: "custom",
                        label: t("localAccessInterfaceCustom"),
                      },
                    ]}
                    selected={selectedInterface ? [selectedInterface] : []}
                    onChange={(values) => {
                      const newInterface = values[0] ?? "";
                      setSelectedInterface(newInterface);
                      updateHasChanges({ iface: newInterface });
                    }}
                  />
                </div>

                {/* Custom IP input - shown when custom interface is selected */}
                {selectedInterface === "custom" && (
                  <div className="settings-item">
                    <div className="settings-item-info">
                      <strong>{t("localAccessCustomIpTitle")}</strong>
                      <p>{t("localAccessCustomIpDescription")}</p>
                    </div>
                    <input
                      type="text"
                      className="settings-input"
                      placeholder="192.168.1.100"
                      value={customIp}
                      onChange={(e) => setCustomIp(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Allowed Hosts — consolidated into one card with radio selection */}
          <div className="settings-item settings-item-stacked">
            <div className="settings-item-info">
              <strong>{t("localAccessAllowedHostsTitle")}</strong>
              <p>{t("localAccessAllowedHostsDescription")}</p>
            </div>

            {/* Host access mode selector */}
            <div className="settings-radio-group">
              <label className="settings-radio-option">
                <input
                  type="radio"
                  name="hostAccessMode"
                  checked={!allowAllHostsToggle}
                  onChange={() => {
                    setAllowAllHostsToggle(false);
                    updateHasChanges({ allowAll: false });
                  }}
                />
                <div className="settings-radio-label">
                  <strong>{t("localAccessModeCustom")}</strong>
                  <span>{t("localAccessModeCustomDescription")}</span>
                </div>
              </label>

              <label className="settings-radio-option">
                <input
                  type="radio"
                  name="hostAccessMode"
                  checked={allowAllHostsToggle}
                  onChange={() => {
                    setAllowAllHostsToggle(true);
                    updateHasChanges({ allowAll: true });
                  }}
                />
                <div className="settings-radio-label">
                  <strong>{t("localAccessModeAllowAll")}</strong>
                  <span>{t("localAccessModeAllowAllDescription")}</span>
                </div>
              </label>
            </div>

            {/* Custom hosts manager - shown when custom mode is selected */}
            {!allowAllHostsToggle && (
              <div className="settings-nested-content">
                <AllowedHostsManager
                  customHosts={customHosts}
                  onChange={(newHosts) => {
                    setCustomHosts(newHosts);
                    updateHasChanges({ customHosts: newHosts });
                  }}
                  disabled={isApplying || applying}
                />
              </div>
            )}
          </div>

          {/* Allow Localhost Access - shown in desktop mode when password auth is off */}
          {auth.hasDesktopToken && !auth.authEnabled && (
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("localAccessLocalhostOpenTitle")}</strong>
                <p>{t("localAccessLocalhostOpenDescription")}</p>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={localhostOpenToggle}
                  onChange={(e) => {
                    setLocalhostOpenToggle(e.target.checked);
                    updateHasChanges({ localhostOpen: e.target.checked });
                  }}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          )}

          {/* Apply button - always visible */}
          <div className="settings-item">
            {formError && <p className="form-error">{formError}</p>}
            <button
              type="submit"
              className="settings-button"
              disabled={!hasChanges || isApplying || applying}
            >
              {isApplying || applying
                ? t("localAccessApplying")
                : t("localAccessApply")}
            </button>
          </div>
        </form>

        <LocalAccessAuthCard auth={auth} />

        {/* Logout - shown when auth is enabled */}
        {auth.authEnabled && auth.isAuthenticated && (
          <div className="settings-group">
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("remoteAccessLogoutTitle")}</strong>
                <p>{t("localAccessLogoutDescription")}</p>
              </div>
              <button
                type="button"
                className="settings-button settings-button-danger"
                onClick={auth.logout}
              >
                {t("remoteAccessLogout")}
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  // No auth context available
  return null;
}
