import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ])(
    "refreshes launch definitions only for cutover: server=%s bridge=%s runtime=%s",
    (server, bridge, runtime) => {
      const source = readFileSync(
        join(root, "scripts/redeploy-server.sh"),
        "utf8",
      );
      const branch = source.slice(
        source.indexOf("# Build-only runs can precede"),
        source.indexOf("# ----- restart -----"),
      );
      const result = run(`
DO_BUILD=true
DO_RESTART=${server}
RESTART_CODEX_BRIDGE=${bridge}
RESTART_RUNTIME=${runtime}
wait_for_yep_sessions_before_cutover() { echo probe; }
refresh_installed_bridge_launchagents() { echo bridge; }
refresh_installed_runtime_launchagent() { echo runtime; }
${branch}
`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        `${server ? "probe\n" : ""}${server || bridge || runtime ? "bridge\nruntime\n" : ""}`,
      );
    },
  );

  it.each([
    {
      response:
        '{"hasActiveWork":true,"queueLength":0,"runtimeMode":"external"}',
      state: "idle",
    },
    {
      response:
        '{"hasActiveWork":true,"queueLength":0,"runtimeMode":"embedded"}',
      state: "active",
    },
    { response: '{"hasActiveWork":false,"queueLength":1}', state: "active" },
    { response: '{"hasActiveWork":false,"queueLength":0}', state: "idle" },
    ...[
      "{}",
      "null",
      "[]",
      "<html>fallback</html>",
      '{"hasActiveWork":false,"queueLength":-1}',
      '{"hasActiveWork":false,"queueLength":0,"runtimeMode":"typo"}',
    ].map((response) => ({ response, state: "unknown" })),
  ])("classifies worker status safely: $response", ({ response, state }) => {
    const source = readFileSync(
      join(root, "scripts/redeploy-server.sh"),
      "utf8",
    );
    const probe = source.slice(
      source.indexOf("server_activity_state() {"),
      source.indexOf("\nwait_port_released()"),
    );
    const result = run(
      `
SERVER_PORT=8022
SERVER_BASE_URL=http://unused/yep
lsof() { return 0; }
curl() { printf '%s' "$TEST_RESPONSE"; }
${probe}
server_activity_state
`,
      {},
      { TEST_RESPONSE: response },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(state);
  });

  it.each([false, true])(
    "retries transient failures and refuses persistent failures: %s",
    (persistent) => {
      const source = readFileSync(
        join(root, "scripts/redeploy-server.sh"),
        "utf8",
      );
      const probe = source.slice(
        source.indexOf("server_activity_state() {"),
        source.indexOf("\nwait_port_released()"),
      );
      const result = run(`
SERVER_PORT=8022
SERVER_BASE_URL=http://unused/yep
ALLOW_YEP_SESSION_INTERRUPT=false
warn() { echo "$*" >&2; }
err() { echo "$*" >&2; }
log() { :; }
sleep() { :; }
lsof() { return 0; }
curl() {
  local count=0
  [[ ! -f "$TEST_LOG" ]] || count="$(cat "$TEST_LOG")"
  count=$((count + 1))
  echo "$count" > "$TEST_LOG"
  if ${persistent} || (( count < 3 )); then return 28; fi
  printf '%s' '{"hasActiveWork":false,"queueLength":0}'
}
${probe}
wait_for_yep_sessions_before_cutover
`);
      expect(result.status === 0).toBe(!persistent);
      expect(
        readFileSync(join(result.dir, "fallback.log"), "utf8").trim(),
      ).toBe(persistent ? "10" : "3");
      if (persistent)
        expect(result.stderr).toContain(
          "Refusing to stop an unverified service",
        );
    },
  );

  it.each([
    {
      server: false,
      bridge: false,
      runtime: false,
      verified: true,
      expected: [],
    },
    {
      server: true,
      bridge: false,
      runtime: false,
      verified: false,
      expected: ["probe"],
    },
    {
      server: true,
      bridge: false,
      runtime: false,
      verified: true,
      expected: [
        "probe",
        "refresh-bridge",
        "refresh-runtime",
        "stop",
        "publish",
      ],
    },
    {
      server: false,
      bridge: true,
      runtime: false,
      verified: true,
      expected: ["refresh-bridge", "refresh-runtime", "publish"],
    },
    {
      server: false,
      bridge: false,
      runtime: true,
      verified: true,
      expected: ["refresh-bridge", "refresh-runtime", "publish"],
    },
    {
      build: false,
      server: true,
      bridge: false,
      runtime: false,
      verified: true,
      expected: [
        "probe",
        "refresh-bridge",
        "refresh-runtime",
        "stop",
        "publish",
      ],
    },
  ])(
    "publishes only during a verified cutover: $server/$bridge/$runtime/$verified",
    ({ build = true, server, bridge, runtime, verified, expected }) => {
      const source = readFileSync(
        join(root, "scripts/redeploy-server.sh"),
        "utf8",
      );
      // Execute the real build/cutover branches with all process and build
      // operations stubbed. Stop before any startup code can run.
      const flow = `${source.slice(
        source.indexOf("# ----- build -----"),
        source.indexOf('  log "Starting yepanywhere ..."'),
      )}\nfi\n`;
      const result = run(`
DO_BUILD=${build}
DO_RESTART=${server}
RESTART_CODEX_BRIDGE=${bridge}
RESTART_RUNTIME=${runtime}
USE_CODEX_BRIDGE_SIDECAR=true
NPM_VERSION=fixture
SERVER_BASE_PATH=/yep
SERVER_PORT=8022
SERVER_LAUNCHD_PLIST="$TEST_PLIST"
SERVER_CLI_JS="$TEST_PLIST"
ensure_pnpm() { :; }
pnpm() { :; }
install_runtime_dependencies() { :; }
ensure_bundle_ready() { :; }
node() { echo fixture; }
log() { :; }
warn() { :; }
dim() { :; }
wait_for_yep_sessions_before_cutover() { echo probe; ${verified}; }
refresh_installed_bridge_launchagents() { echo refresh-bridge; }
refresh_installed_runtime_launchagent() { echo refresh-runtime; }
sync_launchd_runtime_if_installed() { echo publish; }
lsof() {
  case "$*" in
    *4510*) echo 99999992 ;;
    *8022*) [[ -f "$TEST_LOG" ]] && return 1; echo 99999991 ;;
    *) return 1 ;;
  esac
}
server_process_pids() { :; }
dev_supervisor_pids_for_server_listeners() { :; }
pid_sets_overlap() { return 1; }
external_runtime_installed() { return 1; }
resolve_deploy_runtime() { DEPLOY_RUNTIME_PORT=8025; }
kill() { echo stop; touch "$TEST_LOG"; }
wait_port_released() { :; }
wait_server_processes_stopped() { :; }
${flow}
`);
      expect(result.status === 0, result.stderr).toBe(verified);
      expect(result.stdout.trim().split("\n").filter(Boolean)).toEqual(
        expected,
      );
    },
  );
  it.each([
    {
      runtime: true,
      server: false,
      expected: ["--restart", "--restart-runtime", "--no-restart"],
    },
    {
      runtime: true,
      server: true,
      expected: ["--restart", "--restart-runtime"],
    },
    { runtime: false, server: true, expected: ["--restart"] },
    { runtime: false, server: false, expected: null },
  ])(
    "dispatches selected services safely: runtime=$runtime server=$server",
    ({ runtime, server, expected }) => {
      const source = readFileSync(join(root, "scripts/deploy.sh"), "utf8");
      const dir = mkdtempSync(join(tmpdir(), "yep-deploy-dispatch-"));
      dirs.push(dir);
      mkdirSync(join(dir, "scripts"));
      // Run the actual dispatch branch against an argument-printing fixture.
      // No production deploy script, launchd, port, or service is executed.
      writeFileSync(
        join(dir, "scripts/redeploy-server.sh"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n',
        { mode: 0o755 },
      );
      const helperStart = source.indexOf("server_args_contain() {");
      const helper = source.slice(
        helperStart,
        source.indexOf("\n}", helperStart) + 2,
      );
      const guard = source.slice(
        source.indexOf("if ! $DO_SERVER && ! $DO_CODEX_BRIDGE && ! $DO_APK"),
        source.indexOf("\nacquire_deploy_lock\n"),
      );
      const dispatch = source.slice(
        source.indexOf("if $DO_DEV_SERVER; then\n  start_dev_server"),
        source.indexOf('\nif $DO_APK; then\n  log "Building/installing APK'),
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
set -eu
DO_SERVER=${server}
DO_CODEX_BRIDGE=false
DO_APK=false
DO_DEV_SERVER=false
ALLOW_YEP_SESSION_INTERRUPT=false
SERVER_ARGS=(--restart ${runtime ? "--restart-runtime" : ""})
log() { :; }
warn() { :; }
err() { printf '%s\\n' "$*" >&2; }
${helper}
${guard}
${dispatch}
`,
        ],
        { cwd: dir, encoding: "utf8" },
      );
      const failure = result.error?.message ?? result.stderr;
      if (expected) {
        expect(result.status, failure).toBe(0);
        expect(result.stdout.trim().split("\n")).toEqual(expected);
      } else {
        expect(result.status, failure).toBe(2);
        expect(result.stderr).toContain("Nothing to deploy");
      }
    },
  );
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
