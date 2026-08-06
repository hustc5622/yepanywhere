import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findCodexCliPath,
  getCodexCommonPaths,
} from "../../src/sdk/cli-detection.js";

describe("Codex CLI detection", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const path of tempDirs.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("discovers NVM global installs newest version first", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-cli-home-"));
    tempDirs.push(home);
    mkdirSync(join(home, ".nvm/versions/node/v20.19.0"), {
      recursive: true,
    });
    mkdirSync(join(home, ".nvm/versions/node/v22.22.2"), {
      recursive: true,
    });

    const nvmPaths = getCodexCommonPaths(home).filter((path) =>
      path.includes("/.nvm/versions/node/"),
    );
    expect(nvmPaths).toEqual([
      join(home, ".nvm/versions/node/v22.22.2/bin/codex"),
      join(home, ".nvm/versions/node/v20.19.0/bin/codex"),
    ]);
  });

  it("honors an explicit Yep Codex path before PATH lookup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-cli-explicit-"));
    tempDirs.push(dir);
    const codexPath = join(dir, "codex");
    writeFileSync(codexPath, "#!/bin/sh\n");
    vi.stubEnv("YEP_CODEX_PATH", codexPath);

    expect(await findCodexCliPath()).toBe(codexPath);
  });
});
