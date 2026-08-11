import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDeployArgs,
  createDeployRoutes,
  startDeploymentJob,
} from "../../src/routes/deploy.js";

const workspaceRoot = resolve(process.cwd(), "../..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

  it("rejects invalid build types and server-only device options", () => {
    expect(() =>
      buildDeployArgs({
        action: "apk",
        buildType: "invalid" as "release",
      }),
    ).toThrow("Unsupported APK build type.");
    expect(() =>
      buildDeployArgs({ action: "server", deviceId: "emulator-5554" }),
    ).toThrow("deviceId is not supported for this action.");
  });

  it("requires the selected-services action when server is explicitly false", () => {
    expect(() =>
      buildDeployArgs({
        action: "server-restart",
        restartTargets: { server: false },
      }),
    ).toThrow(
      "Use the services-restart action to restart sidecars without the web/API server.",
    );
  });

  it("persists the detached runner exit result with private permissions", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "yep-deploy-route-"));
    tempDirs.push(testDir);
    const repoRoot = join(testDir, "repo");
    const dataDir = join(testDir, "data");
    const scriptsDir = join(repoRoot, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const deployScript = join(scriptsDir, "deploy.sh");
    writeFileSync(
      deployScript,
      "#!/usr/bin/env bash\necho fixture-deploy\nexit 7\n",
    );
    chmodSync(deployScript, 0o755);
    copyFileSync(
      join(workspaceRoot, "scripts/run-deploy-job.mjs"),
      join(scriptsDir, "run-deploy-job.mjs"),
    );

    const started = await startDeploymentJob(
      { repoRoot, dataDir },
      { action: "server-dev" },
    );
    const routes = createDeployRoutes({ repoRoot, dataDir });
    let completed = started;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await routes.request(`/jobs/${started.id}`);
      const body = (await response.json()) as { job: typeof started };
      completed = body.job;
      if (completed.status !== "running") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }

    expect(completed.status).toBe("failed");
    expect(completed.exitCode).toBe(7);
    expect(completed.finishedAt).toBeTruthy();
    expect(completed.log).toContain("fixture-deploy");

    const jobsDir = join(dataDir, "deploy/jobs");
    const logsDir = join(dataDir, "deploy/logs");
    expect(statSync(jobsDir).mode & 0o777).toBe(0o700);
    expect(statSync(logsDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(jobsDir, `${started.id}.json`)).mode & 0o777).toBe(
      0o600,
    );
    expect(statSync(join(logsDir, `${started.id}.log`)).mode & 0o777).toBe(
      0o600,
    );
    expect(
      JSON.parse(readFileSync(join(jobsDir, `${started.id}.result`), "utf8"))
        .exitCode,
    ).toBe(7);
  });
});
