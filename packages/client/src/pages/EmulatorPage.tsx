import type { DeviceInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { EmulatorNavButtons } from "../components/EmulatorNavButtons";
import { EmulatorStream } from "../components/EmulatorStream";
import { PageHeader } from "../components/PageHeader";
import { useEmulatorSettings } from "../hooks/useEmulatorSettings";
import { useEmulatorStream } from "../hooks/useEmulatorStream";
import { useEmulators } from "../hooks/useEmulators";
import { useServerSettings } from "../hooks/useServerSettings";
import { useVersion } from "../hooks/useVersion";
import { useNavigationLayout } from "../layouts";

const DEVICE_TYPE_ORDER: DeviceInfo["type"][] = [
  "emulator",
  "android",
  "chromeos",
  "ios-simulator",
];

export function deviceLabel(device: DeviceInfo): string {
  return device.label || device.avd || device.id;
}

function deviceTypeLabel(type: DeviceInfo["type"]): string {
  switch (type) {
    case "emulator":
      return "Android Emulators";
    case "android":
      return "Android Devices";
    case "chromeos":
      return "ChromeOS Devices";
    case "ios-simulator":
      return "iOS Simulators";
    default:
      return "Devices";
  }
}

export function hasAction(
  device: DeviceInfo,
  action: "stream" | "start" | "stop",
) {
  if (device.actions?.length) {
    return device.actions.includes(action);
  }

  if (action === "stream") {
    return device.state !== "stopped";
  }
  if (action === "start") {
    return device.type === "emulator" && device.state === "stopped";
  }
  if (action === "stop") {
    return device.type === "emulator" && device.state !== "stopped";
  }
  return false;
}

type NavigatorKeyboard = {
  lock?: (keyCodes?: string[]) => Promise<void>;
  unlock?: () => void;
};

function getNavigatorKeyboard(): NavigatorKeyboard | undefined {
  return (navigator as Navigator & { keyboard?: NavigatorKeyboard }).keyboard;
}

function EmulatorListItem({
  device,
  onConnect,
  onStart,
  onStop,
}: {
  device: DeviceInfo;
  onConnect: (device: DeviceInfo) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const canConnect = hasAction(device, "stream");
  const canStart = hasAction(device, "start");
  const canStop = hasAction(device, "stop");

  return (
    <div className="emulator-list-item">
      <div className="emulator-list-item-info">
        <span className="emulator-list-item-name">{deviceLabel(device)}</span>
        <span
          className={`emulator-list-item-status ${device.state === "stopped" ? "stopped" : "running"}`}
        >
          {device.state}
        </span>
      </div>
      <div className="emulator-list-item-actions">
        {canConnect && (
          <button
            type="button"
            className="emulator-btn emulator-btn-primary"
            onClick={() => onConnect(device)}
          >
            Connect
          </button>
        )}
        {canStop && (
          <button
            type="button"
            className="emulator-btn emulator-btn-secondary"
            onClick={() => onStop(device.id)}
          >
            Stop
          </button>
        )}
        {!canStop && canStart && (
          <button
            type="button"
            className="emulator-btn emulator-btn-secondary"
            onClick={() => onStart(device.id)}
          >
            Start
          </button>
        )}
        {!canConnect && !canStop && !canStart && (
          <span className="emulator-list-item-status">No actions</span>
        )}
      </div>
    </div>
  );
}

function DeviceList({
  devices,
  onConnect,
  onStart,
  onStop,
}: {
  devices: DeviceInfo[];
  onConnect: (device: DeviceInfo) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<DeviceInfo["type"], DeviceInfo[]>();
    for (const type of DEVICE_TYPE_ORDER) {
      groups.set(type, []);
    }
    for (const device of devices) {
      const bucket = groups.get(device.type);
      if (bucket) {
        bucket.push(device);
      } else {
        groups.set(device.type, [device]);
      }
    }
    return groups;
  }, [devices]);

  return (
    <div className="emulator-list">
      {Array.from(grouped.entries()).map(([type, entries]) => {
        if (entries.length === 0) return null;
        return (
          <section key={type} className="emulator-list-group">
            <h3 className="emulator-list-group-title">
              {deviceTypeLabel(type)}
            </h3>
            {entries.map((device) => (
              <EmulatorListItem
                key={device.id}
                device={device}
                onConnect={onConnect}
                onStart={onStart}
                onStop={onStop}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function DeviceBridgeUsageGuide() {
  return (
    <ol className="emulator-usage-guide">
      <li>Enable Device Bridge.</li>
      <li>Download the bridge runtime when prompted.</li>
      <li>
        Start an Android emulator or connect an Android device that appears in{" "}
        <code>adb devices</code>. For ChromeOS, add an SSH host alias in
        Settings.
      </li>
      <li>Return to this page, choose the device, and click Connect.</li>
    </ol>
  );
}

function DeviceBridgeDisabledPrompt({
  busy,
  error,
  onEnable,
}: {
  busy: boolean;
  error: string | null;
  onEnable: () => void;
}) {
  return (
    <div className="emulator-download-prompt">
      <h2>Device Bridge is off</h2>
      <p>
        This page streams Android emulators, Android devices, and ChromeOS
        testbeds from this machine to your browser over WebRTC.
      </p>
      <DeviceBridgeUsageGuide />
      {error && <div className="emulator-error">{error}</div>}
      <div className="emulator-setup-actions">
        <button
          type="button"
          className="emulator-btn emulator-btn-primary"
          onClick={onEnable}
          disabled={busy}
        >
          {busy ? "Enabling..." : "Enable Device Bridge"}
        </button>
        <Link
          to="/settings/emulator"
          className="emulator-btn emulator-btn-secondary"
        >
          Open Settings
        </Link>
      </div>
    </div>
  );
}

function DeviceBridgeUnavailablePrompt() {
  return (
    <div className="emulator-download-prompt">
      <h2>Device Bridge is unavailable</h2>
      <p>
        Yep did not detect <code>adb</code> when the server started. Install
        Android Platform Tools, make sure <code>adb</code> is on PATH, then
        restart Yep Anywhere.
      </p>
      <DeviceBridgeUsageGuide />
    </div>
  );
}

export function StreamView({
  device,
  onBack,
}: { device: DeviceInfo; onBack: () => void }) {
  const {
    remoteStream,
    dataChannel,
    peerConnection,
    connectionState,
    error,
    latestProfileEvent,
    profileEventHistory,
    connect,
    disconnect,
  } = useEmulatorStream();
  const { adaptiveFps, maxFps } = useEmulatorSettings();
  const streamViewRef = useRef<HTMLDivElement>(null);
  const [immersiveKeyboardActive, setImmersiveKeyboardActive] = useState(false);
  const [immersiveKeyboardBusy, setImmersiveKeyboardBusy] = useState(false);
  const [immersiveKeyboardError, setImmersiveKeyboardError] = useState<
    string | null
  >(null);
  const keyboardDevice =
    device.type === "emulator" || device.type === "android";
  const supportsImmersiveKeyboard =
    keyboardDevice &&
    document.fullscreenEnabled &&
    typeof getNavigatorKeyboard()?.lock === "function";

  // Auto-connect when entering stream view
  useEffect(() => {
    connect({ id: device.id, type: device.type });
    return () => disconnect();
  }, [device.id, device.type, connect, disconnect]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = document.fullscreenElement === streamViewRef.current;
      setImmersiveKeyboardActive(active);
      if (!active) {
        getNavigatorKeyboard()?.unlock?.();
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      getNavigatorKeyboard()?.unlock?.();
    };
  }, []);

  const exitImmersiveKeyboard = useCallback(async () => {
    setImmersiveKeyboardBusy(true);
    setImmersiveKeyboardError(null);
    try {
      getNavigatorKeyboard()?.unlock?.();
      if (document.fullscreenElement === streamViewRef.current) {
        await document.exitFullscreen();
      }
      setImmersiveKeyboardActive(false);
    } catch (err) {
      setImmersiveKeyboardError(
        `Failed to exit immersive keyboard: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImmersiveKeyboardBusy(false);
    }
  }, []);

  const enterImmersiveKeyboard = useCallback(async () => {
    if (!supportsImmersiveKeyboard || !streamViewRef.current) return;

    setImmersiveKeyboardBusy(true);
    setImmersiveKeyboardError(null);
    try {
      if (document.fullscreenElement !== streamViewRef.current) {
        await streamViewRef.current.requestFullscreen();
      }
      await getNavigatorKeyboard()?.lock?.();
      setImmersiveKeyboardActive(true);
    } catch (err) {
      getNavigatorKeyboard()?.unlock?.();
      setImmersiveKeyboardActive(false);
      setImmersiveKeyboardError(
        `Immersive keyboard failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImmersiveKeyboardBusy(false);
    }
  }, [supportsImmersiveKeyboard]);

  const handleBack = () => {
    void exitImmersiveKeyboard();
    disconnect();
    onBack();
  };

  return (
    <div className="emulator-stream-view" ref={streamViewRef}>
      <div className="emulator-stream-header">
        <button
          type="button"
          className="emulator-btn emulator-btn-secondary"
          onClick={handleBack}
        >
          Back
        </button>
        <span className="emulator-connection-state">
          {deviceLabel(device)} - {connectionState}
        </span>
        <div className="emulator-stream-header-actions">
          {supportsImmersiveKeyboard && (
            <button
              type="button"
              className="emulator-btn emulator-btn-secondary"
              onClick={() => {
                if (immersiveKeyboardActive) {
                  void exitImmersiveKeyboard();
                } else {
                  void enterImmersiveKeyboard();
                }
              }}
              disabled={immersiveKeyboardBusy}
              title="Request fullscreen and keyboard lock"
            >
              {immersiveKeyboardBusy
                ? "Working..."
                : immersiveKeyboardActive
                  ? "Exit Immersive Keyboard"
                  : "Immersive Keyboard"}
            </button>
          )}
        </div>
      </div>

      {supportsImmersiveKeyboard && (
        <div className="emulator-keyboard-state">
          Keyboard mode:{" "}
          {immersiveKeyboardActive ? "immersive (fullscreen)" : "standard"}
        </div>
      )}

      {immersiveKeyboardError && (
        <div className="emulator-error">{immersiveKeyboardError}</div>
      )}

      {latestProfileEvent && (
        <div className="emulator-profile-state">
          Profile {latestProfileEvent.direction}: tier {latestProfileEvent.tier}
          /{latestProfileEvent.totalTiers} ({latestProfileEvent.width}x
          {latestProfileEvent.height}@{latestProfileEvent.fps}fps,{" "}
          {Math.round(latestProfileEvent.bitrate / 1000)} kbps)
        </div>
      )}

      {profileEventHistory.length > 0 && (
        <div
          className="emulator-profile-timeline"
          data-testid="profile-timeline"
        >
          {profileEventHistory.map((event, idx) => (
            <div
              key={`${event.receivedAt}-${event.direction}-${event.tier}-${idx}`}
              className={`emulator-profile-timeline-item ${idx === 0 ? "latest" : ""}`}
            >
              <span className="emulator-profile-timeline-time">
                {new Date(event.receivedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
              <span className="emulator-profile-timeline-detail">
                {event.direction} tier {event.tier}/{event.totalTiers} (
                {event.width}x{event.height}@{event.fps})
              </span>
            </div>
          ))}
        </div>
      )}

      {error && <div className="emulator-error">{error}</div>}

      {connectionState === "connecting" && (
        <div className="emulator-connecting">Connecting...</div>
      )}

      <div className="emulator-stream-container">
        <EmulatorStream
          stream={remoteStream}
          dataChannel={dataChannel}
          deviceType={device.type}
          peerConnection={peerConnection}
          adaptiveFps={adaptiveFps}
          configuredFps={maxFps}
        />
      </div>

      <EmulatorNavButtons dataChannel={dataChannel} deviceType={device.type} />
    </div>
  );
}

export function BridgeRuntimePrompt({
  mode,
  installedVersion,
  latestVersion,
  onDownloaded,
}: {
  mode: "download" | "update";
  installedVersion?: string | null;
  latestVersion?: string | null;
  onDownloaded: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const result = await api.downloadDeviceBridge();
      if (result.ok) {
        onDownloaded();
      } else {
        setError(result.error ?? "Download failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="emulator-download-prompt">
      <p>
        {mode === "update" ? (
          <>
            Device streaming needs a bridge runtime update before use.
            {installedVersion && latestVersion
              ? ` Installed: v${installedVersion}. Latest: v${latestVersion}.`
              : null}
          </>
        ) : (
          <>
            Device streaming requires bridge runtime downloads (sidecar binary +
            Android server APK).
          </>
        )}
      </p>
      <DeviceBridgeUsageGuide />
      {error && <div className="emulator-error">{error}</div>}
      <button
        type="button"
        className="emulator-btn emulator-btn-primary"
        onClick={handleDownload}
        disabled={downloading}
      >
        {downloading
          ? mode === "update"
            ? "Updating..."
            : "Downloading..."
          : mode === "update"
            ? "Update Bridge"
            : "Download Bridge"}
      </button>
    </div>
  );
}

export function EmulatorPage() {
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const {
    version: versionInfo,
    loading: versionLoading,
    error: versionError,
    refetch: refetchVersion,
  } = useVersion();
  const {
    settings,
    isLoading: settingsLoading,
    error: settingsError,
    updateSetting,
  } = useServerSettings();
  const [enableBridgeBusy, setEnableBridgeBusy] = useState(false);
  const [enableBridgeError, setEnableBridgeError] = useState<string | null>(
    null,
  );
  const capabilities = versionInfo?.capabilities ?? [];
  const deviceBridgeEnabled = settings?.deviceBridgeEnabled ?? false;
  const deviceBridgeState = versionInfo?.deviceBridgeState;
  const bridgeRuntimeMode =
    deviceBridgeEnabled && deviceBridgeState === "update-available"
      ? "update"
      : deviceBridgeEnabled &&
          (deviceBridgeState === "downloadable" ||
            (capabilities.includes("deviceBridge-download") &&
              !capabilities.includes("deviceBridge")))
        ? "download"
        : null;
  const needsDownload = bridgeRuntimeMode !== null;
  const bridgeReady =
    deviceBridgeEnabled &&
    !needsDownload &&
    (deviceBridgeState === "available" ||
      capabilities.includes("deviceBridge"));
  const canLoadDevices =
    !!versionInfo && !versionLoading && !settingsLoading && bridgeReady;

  const { emulators, loading, error, startEmulator, stopEmulator } =
    useEmulators({ enabled: canLoadDevices });
  const [activeDevice, setActiveDevice] = useState<DeviceInfo | null>(null);

  const handleEnableBridge = useCallback(async () => {
    setEnableBridgeBusy(true);
    setEnableBridgeError(null);
    try {
      await updateSetting("deviceBridgeEnabled", true);
      await refetchVersion();
    } catch (err) {
      setEnableBridgeError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnableBridgeBusy(false);
    }
  }, [refetchVersion, updateSetting]);

  // ?auto — auto-connect to the first streamable running device.
  useEffect(() => {
    if (activeDevice || loading || !canLoadDevices) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("auto")) return;
    const streamable = emulators.find((d) => hasAction(d, "stream"));
    if (streamable) setActiveDevice(streamable);
  }, [emulators, loading, activeDevice, canLoadDevices]);

  if (activeDevice) {
    return (
      <div className="main-content-wrapper">
        <div className="main-content-constrained">
          <StreamView
            device={activeDevice}
            onBack={() => setActiveDevice(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="main-content-wrapper">
      <div className="main-content-constrained">
        <PageHeader
          title="Devices"
          onOpenSidebar={openSidebar}
          isWideScreen={isWideScreen}
        />
        <main className="page-scroll-container">
          <div className="page-content-inner">
            {(versionLoading || settingsLoading) && (
              <div className="emulator-loading">Loading device bridge...</div>
            )}
            {!versionLoading && versionError && (
              <div className="emulator-error">
                Failed to load device bridge status: {versionError.message}
              </div>
            )}
            {!settingsLoading && settingsError && (
              <div className="emulator-error">
                Failed to load device bridge settings: {settingsError}
              </div>
            )}
            {!versionLoading &&
            !settingsLoading &&
            !versionError &&
            deviceBridgeState === "unavailable" ? (
              <DeviceBridgeUnavailablePrompt />
            ) : !versionLoading &&
              !settingsLoading &&
              !versionError &&
              !deviceBridgeEnabled ? (
              <DeviceBridgeDisabledPrompt
                busy={enableBridgeBusy}
                error={enableBridgeError}
                onEnable={handleEnableBridge}
              />
            ) : !versionLoading &&
              !settingsLoading &&
              !versionError &&
              bridgeRuntimeMode ? (
              <BridgeRuntimePrompt
                mode={bridgeRuntimeMode}
                installedVersion={versionInfo?.deviceBridgeVersion}
                latestVersion={versionInfo?.latestDeviceBridgeVersion}
                onDownloaded={refetchVersion}
              />
            ) : canLoadDevices ? (
              <>
                {loading && <div className="emulator-loading">Loading...</div>}
                {error && <div className="emulator-error">{error}</div>}
                {!loading && emulators.length === 0 && (
                  <div className="emulator-empty">
                    No devices detected. Connect an Android emulator/device or
                    add a ChromeOS SSH host alias in Settings.
                  </div>
                )}
                {emulators.length > 0 && (
                  <DeviceList
                    devices={emulators}
                    onConnect={setActiveDevice}
                    onStart={startEmulator}
                    onStop={stopEmulator}
                  />
                )}
              </>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
