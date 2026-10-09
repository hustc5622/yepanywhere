import { BrowserNotificationToggle } from "../../components/BrowserNotificationToggle";
import { NativePushNotificationToggle } from "../../components/NativePushNotificationToggle";
import { PushNotificationToggle } from "../../components/PushNotificationToggle";
import { SettingsListSkeleton } from "../../components/SettingsSkeleton";
import { useBrowserNotifications } from "../../hooks/useBrowserNotifications";
import { useConnectedDevices } from "../../hooks/useConnectedDevices";
import { useNotificationSettings } from "../../hooks/useNotificationSettings";
import {
  type SubscribedDevice,
  useSubscribedDevices,
} from "../../hooks/useSubscribedDevices";
import { useI18n } from "../../i18n";
import { isMobileShellDocument } from "../../lib/nativePushBridge";
import { LEGACY_KEYS, getServerScoped } from "../../lib/storageKeys";

/**
 * Unified device that merges subscribed device info with connection status.
 */
interface UnifiedDevice {
  browserProfileId: string;
  /** Device name from push subscription, or truncated UUID */
  displayName: string;
  /** Browser type suffix (e.g., "(Android/Chrome)") */
  browserType: string;
  /** True if device has push subscription */
  isSubscribed: boolean;
  /** True if device is currently connected */
  isConnected: boolean;
  /** Number of connected tabs (0 if not connected) */
  tabCount: number;
  /** Subscription date (if subscribed) */
  subscribedAt?: string;
  /** True if this is the current device */
  isCurrentDevice: boolean;
  /** Web Push or Android native push. */
  pushKind: "web" | "native";
}

/**
 * Format a device name with its domain for display.
 * Returns the display name and browser type separately.
 */
function formatDeviceName(
  deviceName: string | undefined,
  endpointDomain: string | undefined,
  pushKind: "web" | "native" | undefined,
): { displayName: string; browserType: string } {
  const name = deviceName || "Unknown device";

  if (pushKind === "native") {
    return {
      displayName: deviceName || "Android APK",
      browserType: "(Android native)",
    };
  }

  // Extract push service type from domain
  if (endpointDomain?.includes("google")) {
    return { displayName: name, browserType: "(Android/Chrome)" };
  }
  if (
    endpointDomain?.includes("apple") ||
    endpointDomain?.includes("push.apple")
  ) {
    return { displayName: name, browserType: "(iOS/Safari)" };
  }
  if (
    endpointDomain?.includes("mozilla") ||
    endpointDomain?.includes("push.services.mozilla")
  ) {
    return { displayName: name, browserType: "(Firefox)" };
  }
  return { displayName: name, browserType: "" };
}

/**
 * Format a date string to a relative or absolute format.
 */
function formatDate(
  dateString: string,
  t: (key: never, vars?: Record<string, string | number>) => string,
): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return new Date().toLocaleDateString();
  }
  if (diffDays === 1) {
    return new Date(Date.now() - 86400000).toLocaleDateString();
  }
  if (diffDays < 7) {
    return t("hostPickerLastConnectedDays" as never, { count: diffDays });
  }
  return date.toLocaleDateString();
}

/**
 * Merge subscribed devices with connected devices into a unified list.
 * Sorts: current device first, then connected devices, then offline subscribed.
 */
function mergeDevices(
  subscribedDevices: SubscribedDevice[],
  connectedDevices: Map<
    string,
    { connectionCount: number; deviceName?: string }
  >,
  currentBrowserProfileId: string | null,
): UnifiedDevice[] {
  const deviceMap = new Map<string, UnifiedDevice>();

  // Add subscribed devices first
  for (const device of subscribedDevices) {
    const { displayName, browserType } = formatDeviceName(
      device.deviceName,
      device.endpointDomain,
      device.pushKind,
    );
    const connection = connectedDevices.get(device.browserProfileId);

    deviceMap.set(device.browserProfileId, {
      browserProfileId: device.browserProfileId,
      displayName,
      browserType,
      isSubscribed: true,
      isConnected: !!connection,
      tabCount: connection?.connectionCount ?? 0,
      subscribedAt: device.createdAt,
      isCurrentDevice: device.browserProfileId === currentBrowserProfileId,
      pushKind: device.pushKind ?? "web",
    });
  }

  // Add connected-but-not-subscribed devices
  for (const [browserProfileId, connection] of connectedDevices) {
    if (!deviceMap.has(browserProfileId)) {
      // Not subscribed, show truncated UUID
      const truncatedId = browserProfileId.slice(0, 8);
      deviceMap.set(browserProfileId, {
        browserProfileId,
        displayName: truncatedId,
        browserType: "",
        isSubscribed: false,
        isConnected: true,
        tabCount: connection.connectionCount,
        isCurrentDevice: browserProfileId === currentBrowserProfileId,
        pushKind: "web",
      });
    }
  }

  // Convert to array and sort
  const devices = Array.from(deviceMap.values());

  devices.sort((a, b) => {
    // Current device first
    if (a.isCurrentDevice && !b.isCurrentDevice) return -1;
    if (!a.isCurrentDevice && b.isCurrentDevice) return 1;

    // Then connected devices (sorted by tab count descending)
    if (a.isConnected && !b.isConnected) return -1;
    if (!a.isConnected && b.isConnected) return 1;
    if (a.isConnected && b.isConnected) {
      return b.tabCount - a.tabCount;
    }

    // Then offline subscribed (sorted by subscription date, newest first)
    if (a.subscribedAt && b.subscribedAt) {
      return (
        new Date(b.subscribedAt).getTime() - new Date(a.subscribedAt).getTime()
      );
    }

    return 0;
  });

  return devices;
}

export function NotificationsSettings() {
  const { t } = useI18n();
  const { isMobile } = useBrowserNotifications();
  const isMobileShell =
    typeof document !== "undefined" && isMobileShellDocument();
  const browserProfileId = getServerScoped(
    "browserProfileId",
    LEGACY_KEYS.browserProfileId,
  );
  const {
    devices: subscribedDevices,
    isLoading: devicesLoading,
    removeDevice,
  } = useSubscribedDevices();
  const { connections, isLoading: connectionsLoading } = useConnectedDevices();
  const {
    settings,
    isLoading: settingsLoading,
    updateSetting,
  } = useNotificationSettings();

  const hasSubscriptions = subscribedDevices.length > 0;
  const isLoading = devicesLoading || connectionsLoading;

  // Merge subscribed and connected devices
  const unifiedDevices = mergeDevices(
    subscribedDevices,
    connections,
    browserProfileId,
  );

  return (
    <>
      {/* Server-side settings - what types of notifications are sent */}
      <section className="settings-section">
        <h2>{t("notificationsServerTitle")}</h2>
        <p className="settings-section-description">
          {t("notificationsServerDescription")}
        </p>
        <div className="settings-group">
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("notificationsToolApprovalsTitle")}</strong>
              <p>{t("notificationsToolApprovalsDescription")}</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings?.toolApproval ?? true}
                onChange={(e) =>
                  updateSetting("toolApproval", e.target.checked)
                }
                disabled={settingsLoading || !hasSubscriptions}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("notificationsQuestionsTitle")}</strong>
              <p>{t("notificationsQuestionsDescription")}</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings?.userQuestion ?? true}
                onChange={(e) =>
                  updateSetting("userQuestion", e.target.checked)
                }
                disabled={settingsLoading || !hasSubscriptions}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("notificationsSessionHaltedTitle")}</strong>
              <p>{t("notificationsSessionHaltedDescription")}</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings?.sessionHalted ?? true}
                onChange={(e) =>
                  updateSetting("sessionHalted", e.target.checked)
                }
                disabled={settingsLoading || !hasSubscriptions}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {!hasSubscriptions && !devicesLoading && (
            <p className="settings-hint">
              {t("notificationsNoSubscribedDevices")}
            </p>
          )}
        </div>
      </section>

      {/* Desktop notifications - browser Notification API (not available on mobile) */}
      {!isMobile && (
        <section className="settings-section">
          <h2>{t("notificationsDesktopTitle")}</h2>
          <p className="settings-section-description">
            {t("notificationsDesktopDescription")}
          </p>
          <div className="settings-group">
            <BrowserNotificationToggle />
          </div>
        </section>
      )}

      {isMobileShell ? (
        <section className="settings-section">
          <h2>{t("nativePushSectionTitle")}</h2>
          <p className="settings-section-description">
            {t("nativePushSectionDescription")}
          </p>
          <div className="settings-group">
            <NativePushNotificationToggle />
          </div>
        </section>
      ) : (
        <section className="settings-section">
          <h2>{t("notificationsPushTitle")}</h2>
          <p className="settings-section-description">
            {t("notificationsPushDescription")}
          </p>
          <div className="settings-group">
            <PushNotificationToggle />
          </div>
        </section>
      )}

      {/* Unified devices list */}
      <section className="settings-section">
        <h2>{t("notificationsDevicesTitle")}</h2>
        <p className="settings-section-description">
          {t("notificationsDevicesDescription")}
        </p>
        <div className="settings-group">
          {isLoading && unifiedDevices.length === 0 ? (
            <SettingsListSkeleton
              label={t("notificationsLoadingDevices")}
              variant="devices"
            />
          ) : unifiedDevices.length === 0 ? (
            <p className="settings-hint">{t("notificationsNoDevices")}</p>
          ) : (
            <div className="device-list">
              {unifiedDevices.map((device) => (
                <div key={device.browserProfileId} className="device-list-item">
                  <div className="device-list-info">
                    <strong>
                      {device.displayName}
                      {device.browserType && ` ${device.browserType}`}
                      {device.isCurrentDevice && (
                        <span className="device-current-badge">
                          {t("notificationsThisDevice")}
                        </span>
                      )}
                    </strong>
                    <p>
                      {/* Status indicator */}
                      {device.isConnected ? (
                        <span className="device-status device-status-online">
                          {device.tabCount === 1
                            ? t("notificationsOneTab")
                            : t("notificationsTabs", {
                                count: device.tabCount,
                              })}
                        </span>
                      ) : (
                        <span className="device-status device-status-offline">
                          {t("notificationsOffline")}
                        </span>
                      )}
                      {/* No push indicator for connected-only devices */}
                      {!device.isSubscribed && (
                        <span className="device-no-push">
                          {t("notificationsNoPush")}
                        </span>
                      )}
                      {/* Subscription date for subscribed devices */}
                      {device.subscribedAt && (
                        <span className="device-subscribed-date">
                          {t("notificationsSubscribed", {
                            date: formatDate(device.subscribedAt, t),
                          })}
                        </span>
                      )}
                    </p>
                  </div>
                  {/* Only show remove button for subscribed devices */}
                  {device.isSubscribed && (
                    <button
                      type="button"
                      className="settings-button settings-button-danger-subtle"
                      onClick={() =>
                        removeDevice(device.browserProfileId, device.pushKind)
                      }
                      title={
                        device.isCurrentDevice
                          ? t("notificationsRemoveThisDevice")
                          : t("notificationsRemoveDevice")
                      }
                    >
                      {t("notificationsRemove")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
