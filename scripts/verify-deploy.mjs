#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";

function usage() {
  console.log(`Usage: node scripts/verify-deploy.mjs [options]

Options:
  --base-url <url>     Server base URL, including BASE_PATH if any
                       (default: http://127.0.0.1:8022/yep)
  --maintenance-url <url>
                       Optional loopback maintenance server base URL
  --build-info <path>  Expected build metadata JSON
                       (default: dist/npm-package/build-info.json)
  -h, --help           Show this help message
`);
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.YEP_DEPLOY_BASE_URL || "http://127.0.0.1:8022/yep",
    maintenanceUrl: undefined,
    buildInfo: "dist/npm-package/build-info.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--base-url":
        args.baseUrl = argv[++index];
        break;
      case "--build-info":
        args.buildInfo = argv[++index];
        break;
      case "--maintenance-url":
        args.maintenanceUrl = argv[++index];
        break;
      case "-h":
        usage();
        process.exit(0);
        break;
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.baseUrl) {
    throw new Error("--base-url requires a value");
  }
  if (!args.buildInfo) {
    throw new Error("--build-info requires a value");
  }
  if (args.maintenanceUrl === "") {
    throw new Error("--maintenance-url requires a value");
  }

  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  if (args.maintenanceUrl) {
    args.maintenanceUrl = args.maintenanceUrl.replace(/\/+$/, "");
  }
  return args;
}

function readJson(filePath) {
  const absolutePath = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf-8"));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    throw new Error(
      `${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expected = readJson(args.buildInfo);
  if (!expected?.buildId) {
    throw new Error(`Expected build info at ${args.buildInfo} has no buildId`);
  }

  const cacheBust = `deployVerify=${Date.now()}`;
  const serverVersion = await fetchJson(
    `${args.baseUrl}/api/version?fresh=1&${cacheBust}`,
  );
  const serverBuild = serverVersion?.build;
  if (!serverBuild?.buildId) {
    throw new Error(
      "Server /api/version did not include build.buildId. The running server is probably an old build.",
    );
  }

  assertEqual(
    "Server /api/version buildId",
    serverBuild.buildId,
    expected.buildId,
  );
  assertEqual(
    "Server /api/version gitCommit",
    serverBuild.gitCommit,
    expected.gitCommit,
  );

  const clientBuild = await fetchJson(
    `${args.baseUrl}/build-info.json?${cacheBust}`,
  );
  if (!clientBuild?.buildId) {
    throw new Error(
      "Client /build-info.json did not include buildId. The served frontend is probably an old bundle.",
    );
  }

  assertEqual(
    "Client /build-info.json buildId",
    clientBuild.buildId,
    expected.buildId,
  );
  assertEqual(
    "Client /build-info.json gitCommit",
    clientBuild.gitCommit,
    expected.gitCommit,
  );

  const workers = await fetchJson(
    `${args.baseUrl}/api/status/workers?${cacheBust}`,
  );
  if (
    typeof workers?.activeWorkers !== "number" ||
    typeof workers?.queueLength !== "number" ||
    typeof workers?.hasActiveWork !== "boolean"
  ) {
    throw new Error(
      "Server /api/status/workers returned an invalid readiness payload.",
    );
  }

  if (args.maintenanceUrl) {
    const health = await fetchJson(
      `${args.maintenanceUrl}/health?${cacheBust}`,
    );
    if (health?.status !== "ok") {
      throw new Error("Maintenance /health did not return status=ok.");
    }
  }

  console.log(
    `[verify-deploy] OK buildId=${expected.buildId} version=${expected.version} baseUrl=${args.baseUrl} activeWorkers=${workers.activeWorkers} queueLength=${workers.queueLength} maintenanceUrl=${args.maintenanceUrl ?? "not-requested"}`,
  );
  console.log(
    `[verify-deploy] server source=${serverBuild.source ?? "unknown"} entrypoint=${serverBuild.entrypoint ?? "unknown"}`,
  );
}

main().catch((error) => {
  console.error(`[verify-deploy] ERROR: ${error.message}`);
  process.exit(1);
});
