import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const runtimeLock = JSON.parse(
  fs.readFileSync(
    path.join(rootDir, "scripts/runtime-package-lock.json"),
    "utf8",
  ),
);
const dependencies = runtimeLock.packages[""].dependencies;
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "yep-runtime-bundle-"));

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

try {
  writeJson(path.join(bundleDir, "package.json"), { dependencies });
  writeJson(path.join(bundleDir, "npm-shrinkwrap.json"), {
    lockfileVersion: 3,
    packages: { "": { dependencies } },
  });

  for (const [name, version] of Object.entries(dependencies)) {
    writeJson(path.join(bundleDir, "node_modules", name, "package.json"), {
      name,
      version,
    });
  }

  const nativePackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  writeJson(
    path.join(
      bundleDir,
      "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    ),
    {
      name: "@anthropic-ai/claude-agent-sdk",
      version: dependencies["@anthropic-ai/claude-agent-sdk"],
      optionalDependencies: { [nativePackage]: "0.0.0" },
    },
  );
  writeJson(
    path.join(bundleDir, "node_modules", nativePackage, "package.json"),
    {
      name: nativePackage,
      version: "0.0.0",
    },
  );
  fs.writeFileSync(
    path.join(
      bundleDir,
      "node_modules",
      nativePackage,
      process.platform === "win32" ? "claude.exe" : "claude",
    ),
    "",
  );

  writeJson(path.join(bundleDir, "node_modules/hono/package.json"), {
    name: "hono",
    version: dependencies.hono,
    type: "module",
    exports: { "./ws": "./dist/helper/websocket/index.js" },
  });
  writeJson(path.join(bundleDir, "node_modules/@hono/node-ws/package.json"), {
    name: "@hono/node-ws",
    version: dependencies["@hono/node-ws"],
    type: "module",
  });
  fs.mkdirSync(path.join(bundleDir, "node_modules/@hono/node-ws/dist"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(bundleDir, "node_modules/@hono/node-ws/dist/index.js"),
    "import 'hono/ws';\n",
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(rootDir, "node_modules/tsx/dist/cli.mjs"),
      path.join(rootDir, "scripts/verify-runtime-bundle.ts"),
      bundleDir,
    ],
    { cwd: rootDir, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "缺失 Hono 模块的 Bundle 必须校验失败");
  assert.match(`${result.stdout}${result.stderr}`, /websocket[\\/]index\.js/);
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true });
}
