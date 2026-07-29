#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ROOT_DIR,
  assertRuntimeLockMatchesDependencies,
  getRuntimeDependencies,
} from "./runtime-package.js";

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<string, PackageJson>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message);
  }
}

function getClaudeNativePackage(sdkPackage: PackageJson): string {
  const libcSuffix =
    process.platform === "linux" &&
    !process.report?.getReport().header.glibcVersionRuntime
      ? "-musl"
      : "";
  const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libcSuffix}`;
  if (!sdkPackage.optionalDependencies?.[packageName]) {
    throw new Error(
      `Claude Agent SDK 不支持当前平台: ${process.platform}-${process.arch}`,
    );
  }
  return packageName;
}

const bundleDir = path.resolve(
  process.argv[2] ?? path.join(ROOT_DIR, "dist/npm-package"),
);
const packageJsonPath = path.join(bundleDir, "package.json");
const shrinkwrapPath = path.join(bundleDir, "npm-shrinkwrap.json");
const packageJson = readJson<PackageJson>(packageJsonPath);
const shrinkwrap = readJson<PackageLock>(shrinkwrapPath);
const expectedDependencies = getRuntimeDependencies();

assertRuntimeLockMatchesDependencies();
assertEqual(
  packageJson.dependencies,
  expectedDependencies,
  "Bundle package.json 的运行时依赖与服务端清单不一致",
);
assertEqual(
  shrinkwrap.packages?.[""]?.dependencies,
  expectedDependencies,
  "Bundle npm-shrinkwrap.json 的直接依赖与 package.json 不一致",
);

for (const [name, expectedVersion] of Object.entries(expectedDependencies)) {
  const installedPackagePath = path.join(
    bundleDir,
    "node_modules",
    name,
    "package.json",
  );
  const installedPackage = readJson<PackageJson>(installedPackagePath);
  if (installedPackage.version !== expectedVersion) {
    throw new Error(
      `${name} 安装版本 ${installedPackage.version ?? "unknown"} 与锁定版本 ${expectedVersion} 不一致`,
    );
  }
}

const claudeSdk = readJson<PackageJson>(
  path.join(
    bundleDir,
    "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
  ),
);
const nativePackage = getClaudeNativePackage(claudeSdk);
const nativePackageJson = readJson<PackageJson>(
  path.join(bundleDir, "node_modules", nativePackage, "package.json"),
);
const expectedNativeVersion = claudeSdk.optionalDependencies?.[nativePackage];
if (nativePackageJson.version !== expectedNativeVersion) {
  throw new Error(
    `${nativePackage} 版本 ${nativePackageJson.version ?? "unknown"} 与 SDK 要求 ${expectedNativeVersion} 不一致`,
  );
}

const claudeBinary = path.join(
  bundleDir,
  "node_modules",
  nativePackage,
  process.platform === "win32" ? "claude.exe" : "claude",
);
fs.accessSync(
  claudeBinary,
  process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
);
console.log(
  `Bundle 运行时校验通过: ${Object.keys(expectedDependencies).length} 个直接依赖，Claude 二进制 ${nativePackage}`,
);
