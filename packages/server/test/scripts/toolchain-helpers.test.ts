import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(process.cwd(), "../..");
const nodeHelper = join(workspaceRoot, "scripts/lib/node.sh");
const pnpmHelper = join(workspaceRoot, "scripts/lib/pnpm.sh");

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runHelper(
  helperPath: string,
  functionName: string,
  repoRoot: string,
  path: string,
) {
  return spawnSync(
    "/bin/bash",
    [
      "-c",
      [
        "set -euo pipefail",
        'err() { printf "%s\\n" "$*" >&2; }',
        'dim() { printf "%s\\n" "$*"; }',
        'source "$TEST_HELPER_PATH"',
        functionName,
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: join(repoRoot, "home"),
        NVM_DIR: join(repoRoot, "home/.nvm"),
        PATH: path,
        REPO_ROOT: repoRoot,
        TEST_HELPER_PATH: helperPath,
      },
    },
  );
}

describe("deployment toolchain helpers", () => {
  let testDir: string;
  let repoRoot: string;
  let fakeBin: string;
  let basePath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "yep-toolchain-"));
    repoRoot = join(testDir, "repo");
    fakeBin = join(testDir, "bin");
    mkdirSync(join(repoRoot, "home"), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    basePath = `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("accepts the exact Node version when both repository pins agree", () => {
    writeFileSync(join(repoRoot, ".nvmrc"), "22.22.2\n");
    writeFileSync(join(repoRoot, ".node-version"), "22.22.2\n");
    executable(
      join(fakeBin, "node"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "v22.22.2"\n',
    );

    const result = runHelper(
      nodeHelper,
      "ensure_project_node",
      repoRoot,
      basePath,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails closed when .nvmrc and .node-version drift", () => {
    writeFileSync(join(repoRoot, ".nvmrc"), "22.22.2\n");
    writeFileSync(join(repoRoot, ".node-version"), "20\n");

    const result = runHelper(
      nodeHelper,
      "ensure_project_node",
      repoRoot,
      basePath,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".nvmrc requires v22.22.2 but .node-version requires v20",
    );
  });

  it("moves the pinned NVM runtime ahead of an earlier PATH Node", () => {
    writeFileSync(join(repoRoot, ".nvmrc"), "22.22.2\n");
    writeFileSync(join(repoRoot, ".node-version"), "22.22.2\n");
    executable(
      join(fakeBin, "node"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "v25.9.0"\n',
    );
    const pinnedBin = join(repoRoot, "home/.nvm/versions/node/v22.22.2/bin");
    mkdirSync(pinnedBin, { recursive: true });
    executable(
      join(pinnedBin, "node"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "v22.22.2"\n',
    );

    const result = runHelper(
      nodeHelper,
      "ensure_project_node\ncommand -v node\nnode --version",
      repoRoot,
      basePath,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`${pinnedBin}/node`);
    expect(result.stdout.trim().endsWith("v22.22.2")).toBe(true);
  });

  it("selects the repository Corepack shim and verifies pinned pnpm", () => {
    writeFileSync(
      join(repoRoot, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.15.1" }),
    );
    const shimDir = join(repoRoot, "scripts/corepack-shims");
    mkdirSync(shimDir, { recursive: true });
    executable(
      join(shimDir, "pnpm"),
      '#!/usr/bin/env bash\nexec corepack pnpm "$@"\n',
    );
    executable(
      join(fakeBin, "corepack"),
      '#!/usr/bin/env bash\n[[ "$1" == "pnpm" && "$2" == "--version" ]]\nprintf "%s\\n" "9.15.1"\n',
    );

    const result = runHelper(
      pnpmHelper,
      "ensure_pnpm\npnpm --version",
      repoRoot,
      basePath,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("repository Corepack shim (9.15.1)");
    expect(result.stdout.trim().endsWith("9.15.1")).toBe(true);
  });

  it("rejects a Corepack pnpm version that differs from packageManager", () => {
    writeFileSync(
      join(repoRoot, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.15.1" }),
    );
    const shimDir = join(repoRoot, "scripts/corepack-shims");
    mkdirSync(shimDir, { recursive: true });
    executable(join(shimDir, "pnpm"), "#!/usr/bin/env bash\nexit 0\n");
    executable(
      join(fakeBin, "corepack"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "9.14.0"\n',
    );

    const result = runHelper(pnpmHelper, "ensure_pnpm", repoRoot, basePath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "pnpm 9.15.1 is required by packageManager",
    );
  });
});
