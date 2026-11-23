#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";

function usage() {
  console.log(`Usage: node scripts/verify-deploy.mjs [options]

Options:
  --base-url <url>     Server base URL, including BASE_PATH if any
                       (default: http://127.0.0.1:8022/yep)
  --build-info <path>  Expected build metadata JSON
                       (default: dist/npm-package/build-info.json)
  -h, --help           Show this help message
`);
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.YEP_DEPLOY_BASE_URL || "http://127.0.0.1:8022/yep",
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

  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  return args;
}

function readJson(filePath) {
  const absolutePath = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf-8"));
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertBuild(label, actual, expected) {
  if (!actual?.buildId) {
    throw new Error(`${label} did not include buildId`);
  }
  assertEqual(`${label} buildId`, actual.buildId, expected.buildId);
  assertEqual(`${label} gitCommit`, actual.gitCommit, expected.gitCommit);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expected = readJson(args.buildInfo);
  if (!expected?.buildId) {
    throw new Error(`Expected build info at ${args.buildInfo} has no buildId`);
  }

  const cacheBust = `deployVerify=${Date.now()}`;
  const versionResponse = await fetchText(
    `${args.baseUrl}/api/version?fresh=1&${cacheBust}`,
  );

  const reportOk = () => {
    console.log(
      `[verify-deploy] OK buildId=${expected.buildId} version=${expected.version} baseUrl=${args.baseUrl}`,
    );
  };

  // Password login hides /api/version. The static build file is served by the
  // same process from its bundle, and it is not behind that login.
  if (versionResponse.status === 401) {
    const servedResponse = await fetchText(
      `${args.baseUrl}/build-info.json?${cacheBust}`,
    );
    if (servedResponse.status !== 200) {
      throw new Error(
        `/build-info.json returned ${servedResponse.status} ${servedResponse.statusText}`,
      );
    }
    const servedBuild = parseJson(
      servedResponse.text,
      "Served /build-info.json",
    );
    assertBuild("served build", servedBuild, expected);
    reportOk();
    console.log(
      "[verify-deploy] /api/version requires authentication; verified the build served at /build-info.json",
    );
    return;
  }

  if (versionResponse.status !== 200) {
    throw new Error(`${versionResponse.status} ${versionResponse.statusText}`);
  }
  const serverVersion = parseJson(versionResponse.text, "Server /api/version");
  const serverBuild = serverVersion?.build;
  if (!serverBuild?.buildId) {
    throw new Error(
      "Server /api/version did not include build.buildId. The running server is probably an old build.",
    );
  }

  assertEqual("server buildId", serverBuild.buildId, expected.buildId);
  assertEqual("server gitCommit", serverBuild.gitCommit, expected.gitCommit);

  const clientResponse = await fetchText(
    `${args.baseUrl}/build-info.json?${cacheBust}`,
  );
  if (clientResponse.status !== 200) {
    throw new Error(
      `/build-info.json returned ${clientResponse.status} ${clientResponse.statusText}`,
    );
  }
  const clientBuild = parseJson(clientResponse.text, "Client /build-info.json");
  if (!clientBuild?.buildId) {
    throw new Error(
      "Client /build-info.json did not include buildId. The served frontend is probably an old bundle.",
    );
  }

  assertEqual("client buildId", clientBuild.buildId, expected.buildId);
  assertEqual("client gitCommit", clientBuild.gitCommit, expected.gitCommit);

  reportOk();
  console.log(
    `[verify-deploy] server source=${serverBuild.source ?? "unknown"} entrypoint=${serverBuild.entrypoint ?? "unknown"}`,
  );
}

main().catch((error) => {
  console.error(`[verify-deploy] ERROR: ${error.message}`);
  process.exit(1);
});
