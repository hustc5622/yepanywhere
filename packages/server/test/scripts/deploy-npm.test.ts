import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(process.cwd(), "../..");
const npmLibrary = join(workspaceRoot, "scripts/lib/deploy-npm.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runFakeNpm(overrides: Record<string, string> = {}) {
  const testDir = mkdtempSync(join(tmpdir(), "yep-deploy-npm-"));
  tempDirs.push(testDir);
  const binDir = join(testDir, "bin");
  mkdirSync(binDir);
  const fakeNpm = join(binDir, "npm");
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env bash
printf 'HTTP_PROXY=%s\n' "\${HTTP_PROXY-<unset>}"
printf 'HTTPS_PROXY=%s\n' "\${HTTPS_PROXY-<unset>}"
printf 'ALL_PROXY=%s\n' "\${ALL_PROXY-<unset>}"
printf 'http_proxy=%s\n' "\${http_proxy-<unset>}"
printf 'https_proxy=%s\n' "\${https_proxy-<unset>}"
printf 'all_proxy=%s\n' "\${all_proxy-<unset>}"
printf 'NPM_CONFIG_PROXY=%s\n' "\${NPM_CONFIG_PROXY-<unset>}"
printf 'NPM_CONFIG_HTTPS_PROXY=%s\n' "\${NPM_CONFIG_HTTPS_PROXY-<unset>}"
printf 'NPM_CONFIG_REGISTRY=%s\n' "\${NPM_CONFIG_REGISTRY-<unset>}"
printf 'npm_config_proxy=%s\n' "\${npm_config_proxy-<unset>}"
printf 'npm_config_https_proxy=%s\n' "\${npm_config_https_proxy-<unset>}"
printf 'npm_config_registry=%s\n' "\${npm_config_registry-<unset>}"
printf 'args=%s\n' "$*"
`,
  );
  chmodSync(fakeNpm, 0o755);

  return spawnSync(
    "/bin/bash",
    [
      "-c",
      'set -e; source "$NPM_LIBRARY"; run_deploy_npm_direct install --omit=dev',
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        NPM_LIBRARY: npmLibrary,
        HTTP_PROXY: "http://127.0.0.1:8001",
        HTTPS_PROXY: "http://127.0.0.1:8002",
        ALL_PROXY: "socks5://127.0.0.1:8003",
        http_proxy: "http://127.0.0.1:8004",
        https_proxy: "http://127.0.0.1:8005",
        all_proxy: "socks5://127.0.0.1:8006",
        NPM_CONFIG_PROXY: "http://127.0.0.1:8007",
        NPM_CONFIG_HTTPS_PROXY: "http://127.0.0.1:8008",
        NPM_CONFIG_REGISTRY: "https://invalid-upper.example/",
        npm_config_proxy: "http://127.0.0.1:8009",
        npm_config_https_proxy: "http://127.0.0.1:8010",
        npm_config_registry: "https://invalid-lower.example/",
        ...overrides,
      },
    },
  );
}

describe("deploy npm runtime install", () => {
  it("uses npmmirror directly and strips inherited proxy configuration", () => {
    const result = runFakeNpm();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("HTTP_PROXY=<unset>");
    expect(result.stdout).toContain("HTTPS_PROXY=<unset>");
    expect(result.stdout).toContain("ALL_PROXY=<unset>");
    expect(result.stdout).toContain("http_proxy=<unset>");
    expect(result.stdout).toContain("https_proxy=<unset>");
    expect(result.stdout).toContain("all_proxy=<unset>");
    expect(result.stdout).toContain("NPM_CONFIG_PROXY=<unset>");
    expect(result.stdout).toContain("NPM_CONFIG_HTTPS_PROXY=<unset>");
    expect(result.stdout).toContain("NPM_CONFIG_REGISTRY=<unset>");
    expect(result.stdout).toContain("npm_config_proxy=");
    expect(result.stdout).toContain("npm_config_https_proxy=");
    expect(result.stdout).toContain(
      "npm_config_registry=https://registry.npmmirror.com/",
    );
    expect(result.stdout).toContain("args=install --omit=dev");
  });

  it("accepts an explicit deployment registry override", () => {
    const result = runFakeNpm({
      YEP_DEPLOY_NPM_REGISTRY: "https://registry.example.test/",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "npm_config_registry=https://registry.example.test/",
    );
  });
});
