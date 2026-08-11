import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(process.cwd(), "../..");
const lockLibrary = join(workspaceRoot, "scripts/lib/deploy-lock.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function acquire(lockDir: string) {
  return acquireWithEnv({ YEP_DEPLOY_LOCK_DIR: lockDir });
}

function acquireWithEnv(overrides: Record<string, string>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCK_LIBRARY: lockLibrary,
    REPO_ROOT: workspaceRoot,
  };
  for (const key of [
    "YEP_DEPLOY_LOCK_DIR",
    "YEP_DEPLOY_LOCK_HELD",
    "YEP_DEPLOY_LOCK_OWNED",
    "YEP_ANYWHERE_DATA_DIR",
    "YEP_ANYWHERE_PROFILE",
  ]) {
    delete env[key];
  }
  Object.assign(env, overrides);

  return spawnSync(
    "/bin/bash",
    [
      "-c",
      'set -e; err() { printf "%s\\n" "$*" >&2; }; warn() { printf "%s\\n" "$*" >&2; }; source "$LOCK_LIBRARY"; acquire_deploy_lock; printf "acquired\\n"',
    ],
    {
      encoding: "utf8",
      env,
    },
  );
}

describe("deploy lock", () => {
  it("rejects a live owner and recovers a stale owner", () => {
    const testDir = mkdtempSync(join(tmpdir(), "yep-deploy-lock-"));
    tempDirs.push(testDir);
    const lockDir = join(testDir, "operation.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner"), `pid=${process.pid}\n`);

    const busy = acquire(lockDir);
    expect(busy.status).toBe(1);
    expect(busy.stderr).toContain("already running");

    writeFileSync(join(lockDir, "owner"), "pid=99999999\n");
    const stale = acquire(lockDir);
    expect(stale.status).toBe(0);
    expect(stale.stdout).toContain("acquired");
    expect(stale.stderr).toContain("Removing stale deployment lock");
  });

  it("shares the default lock across profiles and custom data directories", () => {
    const testDir = mkdtempSync(join(tmpdir(), "yep-deploy-lock-scope-"));
    tempDirs.push(testDir);
    const homeDir = join(testDir, "home");
    const lockDir = join(homeDir, ".yep-anywhere", "deploy", "operation.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner"), `pid=${process.pid}\n`);

    const profiled = acquireWithEnv({
      HOME: homeDir,
      YEP_ANYWHERE_PROFILE: "review-profile",
    });
    expect(profiled.status).toBe(1);
    expect(profiled.stderr).toContain(`Lock: ${lockDir}`);

    const customDataDir = acquireWithEnv({
      HOME: homeDir,
      YEP_ANYWHERE_DATA_DIR: join(testDir, "custom-data"),
    });
    expect(customDataDir.status).toBe(1);
    expect(customDataDir.stderr).toContain(`Lock: ${lockDir}`);
  });
});
