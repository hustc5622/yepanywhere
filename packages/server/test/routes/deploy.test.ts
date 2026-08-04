import { describe, expect, it } from "vitest";
import { buildDeployArgs } from "../../src/routes/deploy.js";

describe("deploy route argument mapping", () => {
  it("keeps server restart scoped to the 8022 web/API service by default", () => {
    expect(buildDeployArgs({ action: "server-restart" }).args).toEqual([
      "--server-only",
      "--restart-only",
    ]);
  });

  it("can replace 8022 with dev hot reload", () => {
    expect(buildDeployArgs({ action: "server-dev" }).args).toEqual([
      "--dev-server",
    ]);
  });

  it("can explicitly allow dev hot reload to interrupt active work", () => {
    expect(
      buildDeployArgs({
        action: "server-dev",
        allowSessionInterrupt: true,
      }).args,
    ).toEqual(["--dev-server", "--allow-yep-session-interrupt"]);
  });

  it("rejects session interrupt override for non-dev actions", () => {
    expect(() =>
      buildDeployArgs({
        action: "server",
        allowSessionInterrupt: true,
      }),
    ).toThrow(
      "allowSessionInterrupt is only supported for the server-dev action.",
    );
  });

  it("can restart selected services with 8022 selected", () => {
    expect(
      buildDeployArgs({
        action: "services-restart",
        restartTargets: { server: true },
      }).args,
    ).toEqual(["--restart-only", "--server-only"]);
  });

  it("can restart selected bridge sidecars without restarting 8022", () => {
    expect(
      buildDeployArgs({
        action: "services-restart",
        restartTargets: {
          server: false,
          codexBridge: true,
          opencodeBridge: true,
        },
      }).args,
    ).toEqual([
      "--restart-only",
      "--no-server",
      "--no-apk",
      "--restart-codex-bridge",
      "--restart-opencode-bridge",
    ]);
  });

  it("can include bridge sidecars in a normal server restart", () => {
    expect(
      buildDeployArgs({
        action: "server-restart",
        restartTargets: {
          codexBridge: true,
          opencodeBridge: true,
        },
      }).args,
    ).toEqual([
      "--server-only",
      "--restart-only",
      "--restart-codex-bridge",
      "--restart-opencode-bridge",
    ]);
  });

  it("can rebuild the server bundle and restart selected bridge sidecars", () => {
    expect(
      buildDeployArgs({
        action: "server",
        restartTargets: {
          codexBridge: true,
          opencodeBridge: true,
        },
      }).args,
    ).toEqual([
      "--server-only",
      "--restart-codex-bridge",
      "--restart-opencode-bridge",
    ]);
  });

  it("rejects selected-services restart without any selected service", () => {
    expect(() =>
      buildDeployArgs({
        action: "services-restart",
        restartTargets: {},
      }),
    ).toThrow("Select at least one service to restart.");
  });

  it("rejects restart target options for APK actions", () => {
    expect(() =>
      buildDeployArgs({
        action: "apk",
        restartTargets: { codexBridge: true },
      }),
    ).toThrow("Restart target options are not supported for this action.");
  });
});
