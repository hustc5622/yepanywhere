import * as fs from "node:fs";
import * as path from "node:path";

export const ROOT_DIR = path.resolve(import.meta.dirname, "..");
export const SERVER_PACKAGE_JSON = path.join(
  ROOT_DIR,
  "packages/server/package.json",
);
export const RUNTIME_LOCK_PATH = path.join(
  ROOT_DIR,
  "scripts/runtime-package-lock.json",
);

export function resolveBundleOutputDir(
  environment: Record<string, string | undefined> = process.env,
  repoRoot = ROOT_DIR,
): string {
  const configuredOutput = environment.YEP_BUNDLE_OUTPUT_DIR;
  return configuredOutput !== undefined
    ? path.resolve(configuredOutput)
    : path.join(repoRoot, "dist", "npm-package");
}

type Dependencies = Record<string, string>;

interface PackageJson {
  dependencies?: Dependencies;
}

interface PackageLock {
  name?: string;
  version?: string;
  packages?: Record<
    string,
    { name?: string; version?: string; dependencies?: Dependencies }
  >;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function getRuntimeDependencies(): Dependencies {
  const sourcePackage = readJson<PackageJson>(SERVER_PACKAGE_JSON);
  const dependencies = Object.fromEntries(
    Object.entries(sourcePackage.dependencies ?? {}).filter(
      ([name]) => !name.startsWith("@yep-anywhere/"),
    ),
  );

  const nonExact = Object.entries(dependencies).filter(
    ([, version]) =>
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version),
  );
  if (nonExact.length > 0) {
    throw new Error(
      `Bundle 运行时依赖必须使用精确版本: ${nonExact
        .map(([name, version]) => `${name}@${version}`)
        .join(", ")}`,
    );
  }

  return dependencies;
}

export function getRuntimeLock(): PackageLock {
  if (!fs.existsSync(RUNTIME_LOCK_PATH)) {
    throw new Error(
      `缺少 Bundle 运行时锁 ${path.relative(ROOT_DIR, RUNTIME_LOCK_PATH)}，请运行 pnpm bundle:lock`,
    );
  }
  return readJson<PackageLock>(RUNTIME_LOCK_PATH);
}

export function assertRuntimeLockMatchesDependencies(
  dependencies = getRuntimeDependencies(),
  lock = getRuntimeLock(),
): void {
  const lockedDependencies = lock.packages?.[""]?.dependencies ?? {};
  if (JSON.stringify(lockedDependencies) !== JSON.stringify(dependencies)) {
    throw new Error(
      "Bundle 运行时锁与 packages/server/package.json 不一致，请运行 pnpm bundle:lock",
    );
  }
}

export function createRuntimeShrinkwrap(version: string): PackageLock {
  const lock = structuredClone(getRuntimeLock());
  assertRuntimeLockMatchesDependencies(undefined, lock);
  lock.name = "yepanywhere";
  lock.version = version;
  if (!lock.packages?.[""]) {
    throw new Error("Bundle 运行时锁缺少根 package 元数据");
  }
  lock.packages[""].name = "yepanywhere";
  lock.packages[""].version = version;
  return lock;
}
