import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(process.cwd(), "../..");

function readWorkspaceFile(path: string): string {
  return readFileSync(join(workspaceRoot, path), "utf8");
}

describe("independent release policy", () => {
  it("keeps the main product on CalVer and ya-v* GitHub Releases", () => {
    const packageJson = JSON.parse(readWorkspaceFile("package.json")) as {
      version: string;
    };
    const releaseWorkflow = readWorkspaceFile(".github/workflows/release.yml");

    expect(packageJson.version).toMatch(/^\d{4}\.\d{1,2}\.\d+$/);
    expect(releaseWorkflow).toContain("- 'ya-v*'");
    expect(releaseWorkflow).not.toMatch(/^\s*- ['\"]v\*/m);
    expect(releaseWorkflow).not.toContain("npm publish");
    expect(
      existsSync(join(workspaceRoot, ".github/workflows/publish.yml")),
    ).toBe(false);
  });

  it("builds a scoped, origin-owned bundle without registry-publish guidance", () => {
    const buildBundle = readWorkspaceFile("scripts/build-bundle.ts");

    expect(buildBundle).toContain('name: "@hustc5622/yepanywhere"');
    expect(buildBundle).toContain("github.com/hustc5622/yepanywhere");
    expect(buildBundle).not.toContain("github.com/kzahel/yepanywhere");
    expect(buildBundle).not.toContain("npm publish");
    expect(buildBundle).toContain(
      "Do not publish this bundle to a package registry.",
    );
  });

  it("retains the fork-owned device bridge and scoped Desktop recovery", () => {
    const goModule = readWorkspaceFile("packages/device-bridge/go.mod");
    const desktopWorkflow = readWorkspaceFile(
      ".github/workflows/desktop-ci.yml",
    );

    expect(goModule).toContain(
      "module github.com/hustc5622/yepanywhere/device-bridge",
    );
    expect(desktopWorkflow).toContain("workflow_dispatch:");
    expect(desktopWorkflow).toContain("steps.build_tauri.outcome == 'failure'");
  });
});
