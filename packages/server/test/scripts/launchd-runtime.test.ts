import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(process.cwd(), "../..");

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

describe("LaunchAgent runtime isolation", () => {
  let testDir: string;
  let repoRoot: string;
  let homeDir: string;
  let fakeBin: string;
  let runtimeDir: string;
  let syncScript: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "yep-launchd-runtime-"));
    repoRoot = join(testDir, "repo");
    homeDir = join(testDir, "home");
    fakeBin = join(testDir, "bin");
    runtimeDir = join(homeDir, ".yep-anywhere/runtime/npm-package");
    syncScript = join(repoRoot, "scripts/sync-launchd-runtime.sh");
    mkdirSync(join(repoRoot, "scripts"), { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    copyFileSync(
      join(workspaceRoot, "scripts/sync-launchd-runtime.sh"),
      syncScript,
    );
    chmodSync(syncScript, 0o755);
    executable(
      join(fakeBin, "uname"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "Darwin"\n',
    );
    executable(
      join(fakeBin, "ditto"),
      '#!/usr/bin/env bash\n/bin/cp -R "$1/." "$2"\n',
    );
    writeBundle("first");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeBundle(marker: string): void {
    const bundle = join(repoRoot, "dist/npm-package");
    mkdirSync(join(bundle, "dist"), { recursive: true });
    mkdirSync(join(bundle, "node_modules"), { recursive: true });
    writeFileSync(join(bundle, "package.json"), JSON.stringify({ marker }));
    writeFileSync(join(bundle, "dist/cli.js"), `// ${marker}\n`);
    writeFileSync(join(bundle, "marker.txt"), marker);
  }

  function runSync(target = runtimeDir) {
    return spawnSync("/bin/bash", [syncScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        YEP_LAUNCHD_RUNTIME_DIR: target,
      },
    });
  }

  it("publishes outside the repository and retains one previous bundle", () => {
    const first = runSync();
    expect(first.status).toBe(0);
    expect(readFileSync(join(runtimeDir, "marker.txt"), "utf8")).toBe("first");

    writeBundle("second");
    const second = runSync();

    expect(second.status).toBe(0);
    expect(readFileSync(join(runtimeDir, "marker.txt"), "utf8")).toBe("second");
    expect(
      readFileSync(join(`${runtimeDir}.previous`, "marker.txt"), "utf8"),
    ).toBe("first");
    expect(second.stdout).toContain(
      `previous=${join(realpathSync(dirname(runtimeDir)), `${basename(runtimeDir)}.previous`)}`,
    );

    const unchanged = runSync();
    expect(unchanged.status).toBe(0);
    expect(unchanged.stdout).toContain("unchanged=true");
    expect(
      readFileSync(join(`${runtimeDir}.previous`, "marker.txt"), "utf8"),
    ).toBe("first");

    writeBundle("third");
    expect(runSync().status).toBe(0);
    expect(readFileSync(join(runtimeDir, "marker.txt"), "utf8")).toBe("third");
    expect(
      readFileSync(join(`${runtimeDir}.previous`, "marker.txt"), "utf8"),
    ).toBe("second");
    expect(
      readdirSync(dirname(runtimeDir)).filter(
        (entry) => entry.includes(".sync.") || entry.includes(".retired."),
      ),
    ).toEqual([]);
  });

  it("keeps the current runtime when staging fails", () => {
    expect(runSync().status).toBe(0);
    writeBundle("second");
    executable(join(fakeBin, "ditto"), "#!/usr/bin/env bash\nexit 42\n");

    const failed = runSync();

    expect(failed.status).not.toBe(0);
    expect(readFileSync(join(runtimeDir, "marker.txt"), "utf8")).toBe("first");
  });

  it("refuses a runtime target inside the repository", () => {
    const unsafeTarget = join(repoRoot, "runtime/npm-package");
    mkdirSync(unsafeTarget, { recursive: true });
    writeFileSync(join(unsafeTarget, "keep.txt"), "preserve");

    const result = runSync(unsafeTarget);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must stay outside the repository");
    expect(readFileSync(join(unsafeTarget, "keep.txt"), "utf8")).toBe(
      "preserve",
    );
  });

  it("refuses to replace an unrecognized external directory", () => {
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "keep.txt"), "preserve");

    const result = runSync();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unrecognized LaunchAgent runtime");
    expect(readFileSync(join(runtimeDir, "keep.txt"), "utf8")).toBe("preserve");
  });

  it("loads deploy env credentials into a no-start server plist", () => {
    const installScript = join(repoRoot, "scripts/install-launchagents.sh");
    copyFileSync(
      join(workspaceRoot, "scripts/install-launchagents.sh"),
      installScript,
    );
    chmodSync(installScript, 0o755);
    // The installer sources the shared deploy-env loader so a standalone
    // reinstall still picks up .env.deploy.local credentials.
    const libDir = join(repoRoot, "scripts/lib");
    mkdirSync(libDir, { recursive: true });
    copyFileSync(
      join(workspaceRoot, "scripts/lib/deploy-env.sh"),
      join(libDir, "deploy-env.sh"),
    );
    copyFileSync(
      join(workspaceRoot, "scripts/lib/deploy-lock.sh"),
      join(libDir, "deploy-lock.sh"),
    );
    writeFileSync(
      join(repoRoot, ".env.deploy.local"),
      [
        "ALLOWED_HOSTS=ignored.example",
        "SESSION_TITLE_LLM_API_KEY=fixture-title-key-from-file",
        "OPENCODE_LLM_API_KEY=fixture-opencode-key-from-file",
        "CUSTOM_GATEWAY_KEY=fixture-extra-key-from-file",
        // Extra Pi gateway channels reference their key by env var name, so
        // this value itself carries no credential.
        "YEP_LLM_GATEWAYS=aitl=https://fixture.example/v1|CUSTOM_GATEWAY_KEY",
        // Empty is meaningful: show the gateway's complete model catalog.
        "YEP_LLM_GATEWAY_MODELS=",
        `YEP_FCM_SERVICE_ACCOUNT_JSON='{"project_id":"fixture-project"}'`,
      ].join("\n"),
    );
    const fakeNode = join(fakeBin, "node");
    const fakeCodex = join(fakeBin, "codex");
    executable(
      fakeNode,
      `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    );
    executable(fakeCodex, "#!/usr/bin/env bash\nexit 0\n");

    // Keep credentials inherited from the developer environment from masking
    // whether the standalone installer loaded this sandbox's deploy env file.
    const parentEnv = { ...process.env };
    for (const key of [
      "YEP_DEPLOY_ENV_FILE",
      "YEP_FCM_SERVICE_ACCOUNT_FILE",
      "YEP_FCM_SERVICE_ACCOUNT_JSON",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "SESSION_TITLE_LLM_API_KEY",
      "LLM_API_KEY",
      "OPENCODE_LLM_API_KEY",
      "CUSTOM_GATEWAY_KEY",
      "YEP_LLM_GATEWAYS",
      "YEP_LLM_GATEWAY_MODELS",
      "YEP_DEPLOY_ENV_FILE_PRECEDENCE",
      "YEP_REPORTS_DIR",
      "RESEARCH_TASKS_DIR",
    ]) {
      delete parentEnv[key];
    }
    const installEnv = {
      ...parentEnv,
      ALLOWED_HOSTS: "example.test,127.0.0.1",
      HOME: homeDir,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      YEP_CODEX_PATH: fakeCodex,
      YEP_LAUNCHD_NODE: fakeNode,
      YEP_LAUNCHD_RUNTIME_DIR: runtimeDir,
    };
    const result = spawnSync(
      "/bin/bash",
      [installScript, "--server-only", "--no-start"],
      {
        encoding: "utf8",
        env: installEnv,
      },
    );

    expect(result.status).toBe(0);
    const plistPath = join(
      homeDir,
      "Library/LaunchAgents/com.yueyuan.yepanywhere.server.plist",
    );
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain(`<string>${runtimeDir}</string>`);
    expect(plist).toContain(
      `<string>${join(runtimeDir, "dist/cli.js")}</string>`,
    );
    expect(plist).toContain("<key>YEP_REPORTS_DIR</key>");
    expect(plist).toContain(
      `<string>${join(dirname(repoRoot), "research_tasks")}</string>`,
    );
    expect(plist).toContain("<key>ALLOWED_HOSTS</key>");
    expect(plist).toContain("<string>example.test,127.0.0.1</string>");
    expect(plist).toContain("<key>YEP_CODEX_PATH</key>");
    expect(plist).toContain(`<string>${fakeCodex}</string>`);
    expect(plist).toContain("<key>SESSION_TITLE_LLM_API_KEY</key>");
    expect(plist).toContain("<string>fixture-title-key-from-file</string>");
    expect(plist).toContain("<key>OPENCODE_LLM_API_KEY</key>");
    expect(plist).toContain("<string>fixture-opencode-key-from-file</string>");
    expect(plist).toContain("<key>YEP_LLM_GATEWAYS</key>");
    expect(plist).toContain(
      "<string>aitl=https://fixture.example/v1|CUSTOM_GATEWAY_KEY</string>",
    );
    expect(plist.match(/<key>CUSTOM_GATEWAY_KEY<\/key>/g)).toHaveLength(1);
    expect(plist).toContain("<string>fixture-extra-key-from-file</string>");
    expect(plist).toMatch(
      /<key>YEP_LLM_GATEWAY_MODELS<\/key>\s*<string><\/string>/,
    );
    expect(plist).toContain("<key>YEP_FCM_SERVICE_ACCOUNT_JSON</key>");
    expect(plist).toContain("fixture-project");
    expect(readFileSync(join(runtimeDir, "marker.txt"), "utf8")).toBe("first");
    expect(statSync(plistPath).mode & 0o777).toBe(0o600);
    expect(
      statSync(join(homeDir, ".yep-anywhere/logs/server-launchd.out.log"))
        .mode & 0o777,
    ).toBe(0o600);
    const serverStdoutLog = join(
      homeDir,
      ".yep-anywhere/logs/server-launchd.out.log",
    );
    writeFileSync(serverStdoutLog, "oversized fixture log");

    const filePrecedenceResult = spawnSync(
      "/bin/bash",
      [installScript, "--server-only", "--no-start"],
      {
        encoding: "utf8",
        env: {
          ...installEnv,
          YEP_DEPLOY_ENV_FILE_PRECEDENCE: "true",
          YEP_LAUNCHD_LOG_MAX_BYTES: "1",
        },
      },
    );
    expect(filePrecedenceResult.status).toBe(0);
    expect(readFileSync(plistPath, "utf8")).toContain(
      "<string>ignored.example</string>",
    );
    expect(readFileSync(`${serverStdoutLog}.1`, "utf8")).toBe(
      "oversized fixture log",
    );

    const configuredReportsDir = "fixtures/custom-reports";
    const overrideResult = spawnSync(
      "/bin/bash",
      [installScript, "--server-only", "--no-start"],
      {
        encoding: "utf8",
        env: {
          ...installEnv,
          YEP_REPORTS_DIR: configuredReportsDir,
        },
      },
    );
    expect(overrideResult.status).toBe(0);
    const overriddenPlist = readFileSync(plistPath, "utf8");
    expect(overriddenPlist).toContain(
      `<string>${repoRoot}/${configuredReportsDir}</string>`,
    );
  });
});
