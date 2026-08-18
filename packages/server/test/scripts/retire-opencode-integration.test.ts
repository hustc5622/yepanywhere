import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(process.cwd(), "../..");
const script = join(workspaceRoot, "scripts/retire-opencode-integration.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "yep-retirement-test-"));
  tempDirs.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  mkdirSync(join(home, ".config/opencode/plugin"), { recursive: true });
  mkdirSync(bin);
  const plist = join(
    home,
    "Library/LaunchAgents/com.yueyuan.yepanywhere.opencode-bridge.plist",
  );
  const plugin = join(home, ".config/opencode/plugin/yep-bridge.ts");
  writeFileSync(plist, "legacy plist");
  writeFileSync(plugin, "legacy plugin");
  return { root, home, bin, plist, plugin };
}

function executable(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("retired integration helper", () => {
  it("defaults to a non-mutating dry-run report", () => {
    const { home, bin, plist, plugin } = fixture();
    executable(join(bin, "curl"), "exit 1");
    executable(join(bin, "lsof"), "exit 0");

    const result = spawnSync("/bin/bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        YEP_RETIRED_OPENCODE_REFERENCE_PATH: join(home, "missing-reference"),
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("audit (dry-run)");
    expect(result.stdout).toContain("No changes were made");
    expect(result.stdout).toContain(`${plist} (present)`);
    expect(result.stdout).toContain(`${plugin} (present)`);
    expect(statSync(plist).size).toBeGreaterThan(0);
    expect(statSync(plugin).size).toBeGreaterThan(0);
  });

  it("refuses apply when a listener exists but status is unavailable", () => {
    const { home, bin, plugin } = fixture();
    executable(join(bin, "curl"), "exit 1");
    executable(
      join(bin, "lsof"),
      'if [[ "$*" == *"4520"* ]]; then echo 12345; fi',
    );

    const result = spawnSync("/bin/bash", [script, "--apply"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        YEP_RETIRED_OPENCODE_REFERENCE_PATH: join(home, "missing-reference"),
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("session status is unavailable");
    expect(statSync(plugin).size).toBeGreaterThan(0);
  });
});
