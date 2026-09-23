import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function run(
  script: string,
  config: Record<string, string> = {},
  overrides: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "yep-runtime-deploy-"));
  dirs.push(dir);
  const plist = join(dir, "server.json");
  writeFileSync(plist, JSON.stringify(config));
  const fakeNode = join(dir, "print-runtime-env");
  writeFileSync(
    fakeNode,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("YEP_RUNTIME_")))));\n`,
    { mode: 0o755 },
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("YEP_RUNTIME_")) delete env[key];
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
# Portable stand-in for macOS plutil, including its missing-key failure.
plutil() {
  node -e 'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); const key = process.argv[1].replace("EnvironmentVariables.", ""); if (!(key in data)) { console.log("missing key"); process.exit(1); } process.stdout.write(data[key]);' "$2" "$4"
}
source "$RUNTIME_LIBRARY"
${script}
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...env,
        RUNTIME_LIBRARY: join(root, "scripts/lib/deploy-runtime.sh"),
        TEST_PLIST: plist,
        TEST_LOG: join(dir, "fallback.log"),
        TEST_NODE: fakeNode,
        ...overrides,
      },
    },
  );
  return { ...result, dir };
}

const printConfig = `
resolve_deploy_runtime "$TEST_PLIST" 8022
printf '%s\\n' "$DEPLOY_RUNTIME_MODE" "$DEPLOY_RUNTIME_PORT" "$DEPLOY_RUNTIME_URL" "$DEPLOY_RUNTIME_TOKEN_FILE"
`;
const external = {
  YEP_RUNTIME_MODE: "external",
  YEP_RUNTIME_PORT: "9025",
  YEP_RUNTIME_CONTROL_URL: "http://127.0.0.1:9025",
  YEP_RUNTIME_TOKEN_FILE: "/tmp/runtime token",
};

describe("deployment runtime wiring", () => {
  it("preserves installed external wiring without requiring another opt-in", () => {
    const result = run(printConfig, external);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(Object.values(external));
  });

  it("defaults a fresh deployment to embedded and derives the port", () => {
    const result = run(printConfig);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("embedded\n8025\nhttp://127.0.0.1:8025\n\n");
  });

  it("honors explicit runtime environment overrides", () => {
    const result = run(printConfig, external, {
      YEP_RUNTIME_MODE: "embedded",
      YEP_RUNTIME_PORT: "10003",
      YEP_RUNTIME_CONTROL_URL: "http://localhost:10003",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "embedded\n10003\nhttp://localhost:10003\n/tmp/runtime token\n",
    );
  });

  it("rejects invalid modes instead of silently selecting embedded", () => {
    const result = run(printConfig, { YEP_RUNTIME_MODE: "externl" });
    expect(result.status).not.toBe(0);
  });

  it.each(["true", "false"])(
    "passes installed wiring through the actual fallback with bridge sidecar=%s",
    (sidecar) => {
      const source = readFileSync(
        join(root, "scripts/redeploy-server.sh"),
        "utf8",
      );
      const fallback = source
        .slice(
          source.indexOf("start_server_fallback() ("),
          source.indexOf("\nstop_launchagent_server_for_fallback()"),
        )
        .replaceAll(">/tmp/yep-server.log", '>"$TEST_LOG"')
        .replaceAll("& disown", "& wait");
      const result = run(
        `
resolve_deploy_runtime "$TEST_PLIST" 8022
server_node_bin() { printf '%s' "$TEST_NODE"; }
log() { :; }
err() { echo "$*" >&2; }
# Exercise nohup with an environment-printing executable, never a service.
SERVER_CLI_JS="$TEST_PLIST"
SERVER_PORT=8022
SERVER_BASE_PATH=/yep
SERVER_ALLOWED_IMAGE_PATHS=/tmp
CODEX_BRIDGE_HTTP_URL=http://127.0.0.1:4510
CODEX_BRIDGE_PORT=4510
USE_CODEX_BRIDGE_SIDECAR=${sidecar}
${fallback}
start_server_fallback
`,
        external,
      );
      expect(result.status, result.stderr).toBe(0);
      // Wait only for the environment-printing stand-in, never a real service.
      expect(
        JSON.parse(readFileSync(join(result.dir, "fallback.log"), "utf8")),
      ).toEqual(external);
    },
  );

  it.each([
    ["", "true"],
    ["false", "false"],
    ["true", "true"],
  ])(
    "server-only installer preserves topology unless explicitly overridden (%s)",
    (override, expected) => {
      const source = readFileSync(
        join(root, "scripts/install-launchagents.sh"),
        "utf8",
      );
      const settings = source.slice(
        source.indexOf('RUNTIME_PORT="$DEPLOY_RUNTIME_PORT"'),
        source.indexOf("CODEX_CLI_PATH="),
      );
      const selection = source.slice(
        source.indexOf("if $INSTALL_RUNTIME_EXPLICIT ||"),
        source.indexOf("if ! $INSTALL_SERVER &&"),
      );
      const result = run(
        `
resolve_deploy_runtime "$TEST_PLIST" 8022
${settings}
INSTALL_RUNTIME_EXPLICIT=false
INSTALL_RUNTIME_ONLY=false
INSTALL_SERVER=true
INSTALL_CODEX_BRIDGE=false
${selection}
printf '%s\\n' "$RUNTIME_EXTERNAL" "$INSTALL_RUNTIME" "$RUNTIME_PORT" "$RUNTIME_URL"
`,
        external,
        { YEP_RUNTIME_EXTERNAL: override },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        `${expected}\nfalse\n9025\nhttp://127.0.0.1:9025\n`,
      );
    },
  );

  it.each(["external", "embedded", "unknown"])(
    "checks reported runtime mode %s after HTTP health succeeds",
    (actual) => {
      const result = run(`
curl() { printf '%s' '{"runtimeMode":"${actual}"}'; }
verify_deploy_runtime http://unused/yep external
`);
      expect(result.status === 0).toBe(actual === "external");
      if (actual !== "external")
        expect(result.stderr).toContain("runtime mode mismatch");
    },
  );
});
