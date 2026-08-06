import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceBridgeService } from "../../src/device/DeviceBridgeService.js";

type DeviceBridgeServiceTestShim = DeviceBridgeService & {
  ensureStarted: () => Promise<void>;
  ensureAndroidServerAPK: () => Promise<string>;
  sendToSidecar: (msg: Record<string, unknown>) => void;
  getInstalledBinaryVersion: (binaryPath: string) => Promise<string | null>;
  shutdown: () => Promise<void>;
  port: number | null;
};

describe("DeviceBridgeService", () => {
  const originalFetch = global.fetch;
  const originalUseApkForEmulator =
    process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR;

  /**
   * Load the service against a specific release channel.
   *
   * Both the build info and the bridge version are cached in module scope, so
   * the channel has to be set before the module is first evaluated — hence the
   * reset plus dynamic import rather than a bare stubEnv.
   */
  async function importServiceOnChannel(channel: string) {
    vi.stubEnv("YEP_RELEASE_CHANNEL", channel);
    vi.resetModules();
    const mod = await import("../../src/device/DeviceBridgeService.js");
    return mod.DeviceBridgeService;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    global.fetch = originalFetch;
    if (originalUseApkForEmulator === undefined) {
      process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR = undefined;
    } else {
      process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR =
        originalUseApkForEmulator;
    }
  });

  it("sends session.start with deviceId only (no legacy emulatorId)", async () => {
    const service = new DeviceBridgeService({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim;

    const sendToSidecar = vi.fn();
    shim.ensureStarted = vi.fn().mockResolvedValue(undefined);
    shim.sendToSidecar = sendToSidecar;

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-1",
        deviceId: "emulator-5554",
        options: { maxFps: 20, maxWidth: 480, quality: 28 },
      },
      vi.fn(),
    );

    expect(sendToSidecar).toHaveBeenCalledTimes(1);
    const payload = sendToSidecar.mock.calls[0]?.[0];
    expect(payload).toEqual({
      type: "session.start",
      sessionId: "session-1",
      deviceId: "emulator-5554",
      options: { maxFps: 20, maxWidth: 480, quality: 28 },
    });
    expect(payload).not.toHaveProperty("emulatorId");
  });

  it("does not fall back to /emulators when /devices returns 404", async () => {
    const service = new DeviceBridgeService({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim;

    shim.ensureStarted = vi.fn().mockResolvedValue(undefined);
    shim.port = 48765;

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(service.listDevices()).rejects.toThrow("Sidecar error: 404");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestedUrls).toEqual(["http://127.0.0.1:48765/devices"]);
    expect(requestedUrls.some((url) => url.includes("/emulators"))).toBe(false);
  });

  it("ensures Android APK before starting a physical Android stream", async () => {
    const service = new DeviceBridgeService({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim;

    const sendToSidecar = vi.fn();
    const ensureAndroidServerAPK = vi
      .fn()
      .mockResolvedValue("/tmp/yep-device-server.apk");
    const ensureStarted = vi.fn().mockResolvedValue(undefined);
    shim.ensureAndroidServerAPK = ensureAndroidServerAPK;
    shim.ensureStarted = ensureStarted;
    shim.sendToSidecar = sendToSidecar;

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-android",
        deviceId: "R3CN90ABCDE",
      },
      vi.fn(),
    );

    expect(ensureAndroidServerAPK).toHaveBeenCalledTimes(1);
    expect(ensureStarted).toHaveBeenCalledTimes(1);
    expect(ensureAndroidServerAPK.mock.invocationCallOrder[0]).toBeLessThan(
      ensureStarted.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(sendToSidecar).toHaveBeenCalledWith({
      type: "session.start",
      sessionId: "session-android",
      deviceId: "R3CN90ABCDE",
      options: undefined,
    });
  });

  it("does not ensure Android APK for default emulator streams", async () => {
    process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR = undefined;

    const service = new DeviceBridgeService({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim;

    shim.ensureAndroidServerAPK = vi
      .fn()
      .mockResolvedValue("/tmp/yep-device-server.apk");
    shim.ensureStarted = vi.fn().mockResolvedValue(undefined);
    shim.sendToSidecar = vi.fn();

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-emu",
        deviceId: "emulator-5554",
      },
      vi.fn(),
    );

    expect(shim.ensureAndroidServerAPK).not.toHaveBeenCalled();
  });

  it("ensures Android APK for emulator streams when APK override mode is enabled", async () => {
    process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR = "true";

    const service = new DeviceBridgeService({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim;

    shim.ensureAndroidServerAPK = vi
      .fn()
      .mockResolvedValue("/tmp/yep-device-server.apk");
    shim.ensureStarted = vi.fn().mockResolvedValue(undefined);
    shim.sendToSidecar = vi.fn();

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-emu-apk",
        deviceId: "emulator-5554",
      },
      vi.fn(),
    );

    expect(shim.ensureAndroidServerAPK).toHaveBeenCalledTimes(1);
  });

  it("reports update-available for stale managed binaries", async () => {
    // The bridge update service only tracks the upstream release line, so this
    // contract is only exercised on that channel.
    const DeviceBridgeServiceOnUpstream =
      await importServiceOnChannel("upstream");
    const service = new DeviceBridgeServiceOnUpstream({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim & {
      findBinaryCandidate: () => {
        path: string;
        source: "prod" | "dev";
      } | null;
    };

    shim.findBinaryCandidate = vi.fn().mockReturnValue({
      path: "/tmp/yep-anywhere-test/bin/device-bridge-darwin-arm64",
      source: "prod",
    });
    shim.getInstalledBinaryVersion = vi.fn().mockResolvedValue("0.1.0");

    global.fetch = vi.fn((url) => {
      if (String(url) === "https://updates.yepanywhere.com/bridge/version") {
        return Promise.resolve(
          new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 }),
        );
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    }) as unknown as typeof fetch;

    await expect(service.getBridgeStatus()).resolves.toEqual({
      state: "update-available",
      installedVersion: "0.1.0",
      latestVersion: "0.2.0",
    });
  });

  it("reports update-available when managed binary version probe fails", async () => {
    const DeviceBridgeServiceOnUpstream =
      await importServiceOnChannel("upstream");
    const service = new DeviceBridgeServiceOnUpstream({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim & {
      findBinaryCandidate: () => {
        path: string;
        source: "prod" | "dev";
      } | null;
    };

    shim.findBinaryCandidate = vi.fn().mockReturnValue({
      path: "/tmp/yep-anywhere-test/bin/device-bridge-darwin-arm64",
      source: "prod",
    });
    shim.getInstalledBinaryVersion = vi.fn().mockResolvedValue(null);

    global.fetch = vi.fn((url) => {
      if (String(url) === "https://updates.yepanywhere.com/bridge/version") {
        return Promise.resolve(
          new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 }),
        );
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    }) as unknown as typeof fetch;

    await expect(service.getBridgeStatus()).resolves.toEqual({
      state: "update-available",
      installedVersion: null,
      latestVersion: "0.2.0",
    });
  });

  for (const channel of ["fork", "dev"] as const) {
    it(`does not contact the upstream bridge update service on the ${channel} channel`, async () => {
      // Asking it from a fork build returns upstream's bridge version, which we
      // would then try to download from our own repo under a tag that does not
      // exist there.
      const DeviceBridgeServiceOnChannel =
        await importServiceOnChannel(channel);
      const service = new DeviceBridgeServiceOnChannel({
        adbPath: "adb",
        dataDir: "/tmp/yep-anywhere-test",
      });
      const shim = service as unknown as DeviceBridgeServiceTestShim & {
        findBinaryCandidate: () => {
          path: string;
          source: "prod" | "dev";
        } | null;
      };

      shim.findBinaryCandidate = vi.fn().mockReturnValue({
        path: "/tmp/yep-anywhere-test/bin/device-bridge-darwin-arm64",
        source: "prod",
      });
      shim.getInstalledBinaryVersion = vi.fn().mockResolvedValue("0.1.0");

      let fetchCount = 0;
      global.fetch = vi.fn(() => {
        fetchCount++;
        return Promise.resolve(
          new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }),
        );
      }) as unknown as typeof fetch;

      const status = await service.getBridgeStatus();

      expect(fetchCount).toBe(0);
      expect(status.latestVersion).toBe("0.0.1");
    });
  }

  it("restarts a running managed sidecar after downloading updates", async () => {
    const service = new DeviceBridgeService({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim & {
      activeBinaryPath: string | null;
      available: boolean;
      getProdBinaryPath: () => string;
      downloadBinary: () => Promise<string>;
      downloadAndroidServerAPK: () => Promise<string>;
    };
    const prodBinaryPath = shim.getProdBinaryPath();

    shim.activeBinaryPath = prodBinaryPath;
    shim.available = true;
    shim.downloadBinary = vi.fn().mockResolvedValue(prodBinaryPath);
    shim.downloadAndroidServerAPK = vi
      .fn()
      .mockResolvedValue("/tmp/yep-anywhere-test/bin/yep-device-server.apk");
    shim.shutdown = vi.fn().mockResolvedValue(undefined);
    shim.ensureStarted = vi.fn().mockResolvedValue(undefined);

    await expect(service.downloadRuntimeDependencies()).resolves.toEqual({
      binaryPath: prodBinaryPath,
      apkPath: "/tmp/yep-anywhere-test/bin/yep-device-server.apk",
    });

    expect(shim.shutdown).toHaveBeenCalledTimes(1);
    expect(shim.ensureStarted).toHaveBeenCalledTimes(1);
    expect(shim.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      shim.ensureStarted.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });
});
