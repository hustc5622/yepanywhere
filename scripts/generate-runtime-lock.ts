#!/usr/bin/env tsx

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RUNTIME_LOCK_PATH,
  assertRuntimeLockMatchesDependencies,
  getRuntimeDependencies,
} from "./runtime-package.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yep-runtime-lock-"));

try {
  const packageJson = {
    name: "yepanywhere",
    version: "0.0.0",
    private: true,
    dependencies: getRuntimeDependencies(),
  };
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  execFileSync(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      `--cache=${path.join(tempDir, ".npm-cache")}`,
    ],
    { cwd: tempDir, stdio: "inherit" },
  );
  fs.copyFileSync(path.join(tempDir, "package-lock.json"), RUNTIME_LOCK_PATH);
  assertRuntimeLockMatchesDependencies();
  console.log("Bundle 运行时锁已更新: scripts/runtime-package-lock.json");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
