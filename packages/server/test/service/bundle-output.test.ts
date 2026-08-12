import path from "node:path";
import { describe, expect, it } from "vitest";
import * as runtimePackage from "../../../../scripts/runtime-package.js";

type ResolveBundleOutputDir = (
  environment: Record<string, string | undefined>,
  repoRoot: string,
) => string;

function requireResolver() {
  const resolver = (
    runtimePackage as typeof runtimePackage & {
      resolveBundleOutputDir?: ResolveBundleOutputDir;
    }
  ).resolveBundleOutputDir;
  expect(resolver).toBeTypeOf("function");
  return resolver as ResolveBundleOutputDir;
}

describe("Bundle 输出目录", () => {
  it("未指定暂存目录时保持现有生产 Bundle 路径", () => {
    const repoRoot = path.resolve("C:/repo/yep-anywhere");

    expect(requireResolver()({}, repoRoot)).toBe(
      path.join(repoRoot, "dist", "npm-package"),
    );
  });

  it("指定暂存目录时所有构建产物使用该目录", () => {
    const repoRoot = path.resolve("C:/repo/yep-anywhere");
    const stagingDir = path.resolve("C:/repo/yep-anywhere/dist/bundle-staging");

    expect(
      requireResolver()({ YEP_BUNDLE_OUTPUT_DIR: stagingDir }, repoRoot),
    ).toBe(stagingDir);
  });

  it("approves only the locked native runtime install scripts", () => {
    const getRuntimeAllowScripts = (
      runtimePackage as typeof runtimePackage & {
        getRuntimeAllowScripts?: () => Record<string, boolean>;
      }
    ).getRuntimeAllowScripts;

    expect(getRuntimeAllowScripts).toBeTypeOf("function");
    expect(getRuntimeAllowScripts?.()).toEqual({
      "bcrypt@6.0.0": true,
      "node-pty@1.1.0": true,
    });
  });
});
