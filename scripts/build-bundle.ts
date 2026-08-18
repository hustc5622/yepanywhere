#!/usr/bin/env tsx

/**
 * Build script for the self-contained Node.js distribution bundle
 *
 * This script prepares a single bundle for local deployment and GitHub Release by:
 * 1. Building the shared package (types)
 * 2. Building the client (React app)
 * 3. Building the server (Node.js app)
 * 4. Copying client dist into server package for embedded serving
 *
 * The resulting server package contains everything needed for distribution.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  promoteStagedDirectory,
  resolveBundleOutputDirectory,
} from "./promote-staged-directory.js";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const CLIENT_DIST = path.join(ROOT_DIR, "packages/client/dist");
const SERVER_PACKAGE = path.join(ROOT_DIR, "packages/server");
const SERVER_DIST = path.join(SERVER_PACKAGE, "dist");
const SHARED_DIST = path.join(ROOT_DIR, "packages/shared/dist");
const PI_EXTENSION_SOURCE = path.join(
  SERVER_PACKAGE,
  "resources/pi-yep-extension.mjs",
);

// Build into an unpublished sibling first. The currently running 8022 process
// serves files directly from dist/npm-package/client-dist, so deleting or
// mutating that directory during compilation creates real asset 404s.
// YEP_BUNDLE_OUTPUT_DIR is primarily for isolated verification and packaging.
const PUBLISHED_DIR = resolveBundleOutputDirectory(
  ROOT_DIR,
  process.env.YEP_BUNDLE_OUTPUT_DIR,
);
const STAGING_DIR = path.join(
  path.dirname(PUBLISHED_DIR),
  `.${path.basename(PUBLISHED_DIR)}.build-${process.pid}-${Date.now()}`,
);
let stagingPublished = false;

// A normal build failure must leave the published bundle intact and should not
// leave a partially assembled staging tree behind.
process.once("exit", () => {
  if (!stagingPublished && fs.existsSync(STAGING_DIR)) {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  }
});

// Version for the bundle. Normally supplied via NPM_VERSION (release tag in CI,
// root package.json in redeploy-server.sh). When absent we read the root
// package.json rather than falling back to a hardcoded string: a stale constant
// silently produces a bundle that misreports its own version, which then
// defeats every downstream version check. Failing loudly is the point.
function resolveBundleVersion(): string {
  const fromEnv = process.env.NPM_VERSION?.trim();
  if (fromEnv) return fromEnv;

  const rootPackageJson = path.join(ROOT_DIR, "package.json");
  let version: unknown;
  try {
    version = JSON.parse(fs.readFileSync(rootPackageJson, "utf-8")).version;
  } catch (error) {
    console.error(
      `Failed to read a version from ${rootPackageJson}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    console.error(
      "Set NPM_VERSION explicitly, or repair the root package.json.",
    );
    process.exit(1);
  }

  if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error(
      `Root package.json has no usable "version" (got: ${JSON.stringify(version)}).`,
    );
    console.error(
      "Set NPM_VERSION explicitly, or repair the root package.json.",
    );
    process.exit(1);
  }

  return version;
}

const NPM_VERSION = resolveBundleVersion();

// Which release line this bundle belongs to. This repository is the fork line,
// so that is the default; YEP_RELEASE_CHANNEL exists for the rare case of
// building an upstream-channel artifact. An unrecognised value is a typo that
// would silently re-enable upstream update prompts, so reject it outright.
const RELEASE_CHANNELS = ["upstream", "fork", "dev"];
const RELEASE_CHANNEL = process.env.YEP_RELEASE_CHANNEL ?? "fork";
if (!RELEASE_CHANNELS.includes(RELEASE_CHANNEL)) {
  console.error(
    `Unknown YEP_RELEASE_CHANNEL "${RELEASE_CHANNEL}" (expected: ${RELEASE_CHANNELS.join(" | ")}).`,
  );
  process.exit(1);
}
const BUILD_DATE = process.env.YEP_BUILD_DATE || new Date().toISOString();

function commandOutput(command: string): string | null {
  try {
    return execSync(command, {
      cwd: ROOT_DIR,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === "/") return "/";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function createBuildInfo() {
  const gitDescribe = commandOutput("git describe --tags --always")?.replace(
    /^v/,
    "",
  );
  const gitCommit = commandOutput("git rev-parse HEAD");
  const gitBranch = commandOutput("git branch --show-current");
  const gitStatus = commandOutput("git status --porcelain");
  const shortCommit = gitCommit?.slice(0, 12) ?? "nogit";
  const compactDate = BUILD_DATE.replace(/\D/g, "").slice(0, 14) || "unknown";

  return {
    schemaVersion: 1,
    buildId: `${NPM_VERSION}-${shortCommit}-${compactDate}`,
    version: NPM_VERSION,
    releaseChannel: RELEASE_CHANNEL,
    gitDescribe: gitDescribe ?? null,
    gitCommit: gitCommit ?? null,
    gitBranch: gitBranch ?? null,
    gitDirty: gitStatus !== null ? gitStatus.length > 0 : null,
    builtAt: BUILD_DATE,
    buildProfile: process.env.YEP_BUILD_PROFILE ?? "production",
    basePath: normalizeBasePath(process.env.BASE_PATH ?? "/yep"),
  };
}

const BUILD_INFO = createBuildInfo();

interface StepResult {
  step: string;
  success: boolean;
  error?: string;
}

const results: StepResult[] = [];

function log(message: string): void {
  console.log(`[build-bundle] ${message}`);
}

function error(message: string): void {
  console.error(`[build-bundle] ERROR: ${message}`);
}

function execStep(
  command: string,
  cwd?: string,
  env?: Record<string, string | undefined>,
): void {
  execSync(command, {
    stdio: "inherit",
    cwd: cwd || ROOT_DIR,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function step(name: string, fn: () => void): void {
  log(`\n${"=".repeat(60)}`);
  log(`Step: ${name}`);
  log("=".repeat(60));

  try {
    fn();
    results.push({ step: name, success: true });
    log(`✓ ${name} completed`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    results.push({ step: name, success: false, error: errorMsg });
    error(`✗ ${name} failed: ${errorMsg}`);
    throw err;
  }
}

// Clean previous build artifacts
step("Clean previous builds", () => {
  log("Removing old dist directories...");

  // Never clean PUBLISHED_DIR here. It is still serving the current UI while
  // shared/client/server compilation runs.
  const dirsToClean = [SHARED_DIST, CLIENT_DIST, SERVER_DIST, STAGING_DIR];

  for (const dir of dirsToClean) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`  Removed: ${path.relative(ROOT_DIR, dir)}`);
    }
  }
});

// Build shared package (types/schemas)
step("Build shared package", () => {
  log("Building @yep-anywhere/shared (TypeScript compilation)...");
  execStep("corepack pnpm --filter @yep-anywhere/shared build");
});

// Build client
step("Build client", () => {
  // Vite's `base` is baked into asset URLs at build time. The server starts with
  // BASE_PATH=/yep (see scripts/redeploy-server.sh) so the two must match;
  // otherwise index.html references /assets/* while the server only serves
  // /yep/assets/*, and the SPA fails to bootstrap. Honor an explicit BASE_PATH
  // override but default to /yep to match the deployed Caddy route.
  const clientBasePath = process.env.BASE_PATH ?? "/yep";
  log(
    `Building @yep-anywhere/client (Vite production build, BASE_PATH=${clientBasePath || "/"})...`,
  );
  execStep("corepack pnpm --filter @yep-anywhere/client build", undefined, {
    BASE_PATH: clientBasePath,
    YEP_BUILD_ID: BUILD_INFO.buildId,
    YEP_BUILD_VERSION: BUILD_INFO.version,
    YEP_BUILD_DATE: BUILD_INFO.builtAt,
    YEP_BUILD_GIT_DESCRIBE: BUILD_INFO.gitDescribe ?? BUILD_INFO.version,
    YEP_BUILD_PROFILE: BUILD_INFO.buildProfile,
  });

  // Verify client dist exists
  if (!fs.existsSync(CLIENT_DIST)) {
    throw new Error(
      `Client dist not found at ${CLIENT_DIST} after build. Vite build may have failed.`,
    );
  }

  const indexHtml = path.join(CLIENT_DIST, "index.html");
  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      "Client dist exists but index.html not found. Incomplete build?",
    );
  }

  fs.writeFileSync(
    path.join(CLIENT_DIST, "build-info.json"),
    `${JSON.stringify(BUILD_INFO, null, 2)}\n`,
  );

  log(`  Client built successfully: ${path.relative(ROOT_DIR, CLIENT_DIST)}`);
  log(`  Client build id: ${BUILD_INFO.buildId}`);
});

// Build server
step("Build server", () => {
  log("Building @yep-anywhere/server (TypeScript compilation)...");
  execStep("corepack pnpm --filter @yep-anywhere/server build");

  // Verify server dist exists
  const serverDist = path.join(SERVER_PACKAGE, "dist");
  if (!fs.existsSync(serverDist)) {
    throw new Error(
      `Server dist not found at ${serverDist} after build. TypeScript compilation may have failed.`,
    );
  }

  log(`  Server built successfully: ${path.relative(ROOT_DIR, serverDist)}`);
});

// Create staging directory structure
step("Create staging directory", () => {
  log(
    `Creating staging directory at ${path.relative(ROOT_DIR, STAGING_DIR)}...`,
  );
  fs.mkdirSync(STAGING_DIR, { recursive: true });
});

// Write build metadata for the running server to expose through /api/version.
step("Write build metadata", () => {
  fs.writeFileSync(
    path.join(STAGING_DIR, "build-info.json"),
    `${JSON.stringify(BUILD_INFO, null, 2)}\n`,
  );
  log(`  Build id: ${BUILD_INFO.buildId}`);
  log(
    `  Staged at: ${path.relative(ROOT_DIR, path.join(STAGING_DIR, "build-info.json"))}`,
  );
});

// Copy server dist to staging
step("Copy server dist to staging", () => {
  const stagingDist = path.join(STAGING_DIR, "dist");
  log(`Copying server dist to ${path.relative(ROOT_DIR, stagingDist)}...`);
  copyRecursive(SERVER_DIST, stagingDist);
  log("  Server dist copied to staging");
});

// Rewrite @yep-anywhere/shared imports to relative paths into bundled/
// This eliminates the need for a postinstall symlink, which fails with some
// package managers (Volta) and on platforms with limited symlink support (WSL).
step("Rewrite @yep-anywhere/shared imports", () => {
  const stagingDist = path.join(STAGING_DIR, "dist");
  const sharedEntry = path.join(
    STAGING_DIR,
    "bundled/@yep-anywhere/shared/dist/index.js",
  );

  function rewriteImports(dir: string): number {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += rewriteImports(fullPath);
      } else if (entry.name.endsWith(".js")) {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (!content.includes("@yep-anywhere/shared")) continue;

        let relPath = path.relative(path.dirname(fullPath), sharedEntry);
        // Ensure it starts with ./ for Node.js ESM resolution
        if (!relPath.startsWith(".")) relPath = `./${relPath}`;

        const rewritten = content.replace(
          /(?<=(from\s+|import\(\s*))(["'])@yep-anywhere\/shared\2/g,
          `$2${relPath}$2`,
        );
        fs.writeFileSync(fullPath, rewritten);
        count++;
      }
    }
    return count;
  }

  const rewritten = rewriteImports(stagingDist);
  log(`  Rewrote imports in ${rewritten} files`);
});

// Copy shared dist into staging (for @yep-anywhere/shared imports)
// We put it in 'bundled/' instead of 'node_modules/' because npm ignores node_modules
step("Bundle shared into staging", () => {
  const bundledSharedPath = path.join(
    STAGING_DIR,
    "bundled/@yep-anywhere/shared",
  );
  const bundledSharedDist = path.join(bundledSharedPath, "dist");

  log(
    `Copying shared dist to ${path.relative(ROOT_DIR, bundledSharedDist)}...`,
  );

  // Create directory structure
  fs.mkdirSync(bundledSharedDist, { recursive: true });

  // Copy shared dist files
  copyRecursive(SHARED_DIST, bundledSharedDist);

  // Create a minimal package.json for the shared package
  const sharedPackageJson = {
    name: "@yep-anywhere/shared",
    version: NPM_VERSION,
    type: "module",
    main: "dist/index.js",
    types: "dist/index.d.ts",
  };
  fs.writeFileSync(
    path.join(bundledSharedPath, "package.json"),
    JSON.stringify(sharedPackageJson, null, 2),
  );

  log("  Shared types and runtime bundled into staging");
});

// Copy client dist into staging
step("Bundle client into staging", () => {
  const stagingClientDist = path.join(STAGING_DIR, "client-dist");
  log(
    `Copying client dist to ${path.relative(ROOT_DIR, stagingClientDist)}...`,
  );

  // Create staging client-dist directory
  fs.mkdirSync(stagingClientDist, { recursive: true });

  // Copy all client dist files
  copyRecursive(CLIENT_DIST, stagingClientDist);

  // Verify critical files were copied
  const copiedIndexHtml = path.join(stagingClientDist, "index.html");
  if (!fs.existsSync(copiedIndexHtml)) {
    throw new Error("Failed to copy client dist: index.html not found");
  }

  log("  Client assets bundled into staging");
});

// Pi loads this extension explicitly for every Yep-owned RPC process. It is
// bundled as data (not installed into ~/.pi), keeping user configuration
// untouched while making packaged and source runs behave identically.
step("Bundle Pi RPC extension", () => {
  const extensionDest = path.join(
    STAGING_DIR,
    "resources/pi-yep-extension.mjs",
  );
  if (!fs.existsSync(PI_EXTENSION_SOURCE)) {
    throw new Error(`Pi extension not found at ${PI_EXTENSION_SOURCE}`);
  }
  fs.mkdirSync(path.dirname(extensionDest), { recursive: true });
  fs.copyFileSync(PI_EXTENSION_SOURCE, extensionDest);
  log("  Pi RPC extension bundled into staging");
});

// Generate the bundle package.json in staging without modifying the workspace.
step("Generate bundle package.json", () => {
  log("Generating bundle package.json...");

  const sourcePackageJsonPath = path.join(SERVER_PACKAGE, "package.json");
  const sourcePackageJson = JSON.parse(
    fs.readFileSync(sourcePackageJsonPath, "utf-8"),
  );

  // Create a package.json for the self-contained bundle. This repository does
  // not publish the bundle to a package registry.
  // The bare `yepanywhere` name belongs to the upstream release line, which we
  // have no publish rights to and do not want to shadow. Scoping the name adds
  // a second defense against registry mistakes. The bin names are deliberately
  // unchanged — redeploy-server.sh invokes `yepanywhere --codex-bridge-only`.
  const npmPackageJson: Record<string, unknown> = {
    name: "@hustc5622/yepanywhere",
    version: NPM_VERSION,
    description: "A mobile-first supervisor for Claude Code agents",
    type: "module",
    bin: {
      yepanywhere: "./dist/cli.js",
      yc: "./dist/cli.js",
    },
    scripts: {
      postinstall:
        "chmod +x node_modules/node-pty/prebuilds/*/spawn-helper node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true",
    },
    main: "./dist/index.js",
    exports: {
      ".": "./dist/index.js",
    },
    files: ["dist", "client-dist", "bundled", "resources", "README.md"],
    // Copy dependencies from source, excluding workspace deps
    dependencies: Object.fromEntries(
      Object.entries(sourcePackageJson.dependencies || {}).filter(
        ([name]) => !name.startsWith("@yep-anywhere/"),
      ),
    ),
    repository: {
      type: "git",
      url: "git+https://github.com/hustc5622/yepanywhere.git",
    },
    homepage: "https://github.com/hustc5622/yepanywhere#readme",
    bugs: {
      url: "https://github.com/hustc5622/yepanywhere/issues",
    },
    keywords: ["claude", "ai", "agent", "supervisor", "mobile"],
    license: "MIT",
    engines: {
      node: ">=22.13.0",
    },
  };

  // Write to staging directory
  const stagingPackageJsonPath = path.join(STAGING_DIR, "package.json");
  fs.writeFileSync(
    stagingPackageJsonPath,
    `${JSON.stringify(npmPackageJson, null, 2)}\n`,
  );

  log(`  Package name: ${npmPackageJson.name}`);
  log(`  Version: ${NPM_VERSION}`);
  log(`  Release channel: ${RELEASE_CHANNEL}`);
  log(
    `  Staged at: ${path.relative(ROOT_DIR, path.join(STAGING_DIR, "package.json"))}`,
  );
  log("  (Original packages/server/package.json unchanged)");
});

// Copy README to staging
step("Copy README to staging", () => {
  const readmeSrc = path.join(ROOT_DIR, "README.md");
  const readmeDest = path.join(STAGING_DIR, "README.md");

  if (fs.existsSync(readmeSrc)) {
    fs.copyFileSync(readmeSrc, readmeDest);
    log("  Copied README.md from repo root");
  } else {
    // Create a basic README if none exists
    const basicReadme = `# yepanywhere

A mobile-first supervisor for Claude Code agents.

## Installation

This build is not published to a registry. Install it from a checkout:

\`\`\`bash
npm install -g ./dist/npm-package
\`\`\`

## Usage

\`\`\`bash
yepanywhere
\`\`\`

Then open http://localhost:3400 in your browser.

## Features

- **Server-owned processes** — Claude runs on your dev machine; client disconnects don't interrupt work
- **Multi-session dashboard** — See all projects at a glance, no window cycling
- **Mobile supervision** — Push notifications for approvals, respond from your lock screen
- **Zero external dependencies** — No Firebase, no accounts, just Tailscale for network access

## License

MIT
`;
    fs.writeFileSync(readmeDest, basicReadme);
    log("  Created basic README.md (no repo README found)");
  }
});

// Validate everything that the running service needs before the stable path is
// changed. In particular, this catches a client build that omitted favicon
// files or failed to add a fresh favicon URL.
step("Validate staged bundle", () => {
  const requiredFiles = [
    "build-info.json",
    "package.json",
    "dist/cli.js",
    "client-dist/index.html",
    "client-dist/build-info.json",
    "client-dist/favicon.ico",
    "client-dist/icon-192.png",
  ];

  for (const relativePath of requiredFiles) {
    const absolutePath = path.join(STAGING_DIR, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`Required staged file is missing: ${relativePath}`);
    }
    if (fs.statSync(absolutePath).size === 0) {
      throw new Error(`Required staged file is empty: ${relativePath}`);
    }
  }

  for (const relativePath of [
    "build-info.json",
    "client-dist/build-info.json",
  ]) {
    const buildInfo = JSON.parse(
      fs.readFileSync(path.join(STAGING_DIR, relativePath), "utf8"),
    ) as { buildId?: unknown };
    if (buildInfo.buildId !== BUILD_INFO.buildId) {
      throw new Error(
        `${relativePath} has build id ${String(buildInfo.buildId)}, expected ${BUILD_INFO.buildId}`,
      );
    }
  }

  const stagedClientDir = path.join(STAGING_DIR, "client-dist");
  const indexHtml = fs.readFileSync(
    path.join(stagedClientDir, "index.html"),
    "utf8",
  );
  const linkTags = indexHtml.match(/<link\b[^>]*>/gi) ?? [];
  let localIconCount = 0;

  for (const tag of linkTags) {
    const rel = tag.match(/\brel\s*=\s*(["'])([^"']*)\1/i)?.[2];
    const href = tag.match(/\bhref\s*=\s*(["'])([^"']*)\1/i)?.[2];
    const isIcon = rel
      ?.toLowerCase()
      .split(/\s+/)
      .some((token) => token === "icon" || token.endsWith("-icon"));
    if (!isIcon || !href || /^(?:data:|https?:|\/\/)/i.test(href)) continue;

    localIconCount += 1;
    const iconUrl = new URL(href, "http://bundle.invalid");
    if (iconUrl.searchParams.get("v") !== BUILD_INFO.buildId) {
      throw new Error(
        `Icon URL is not versioned with build id ${BUILD_INFO.buildId}: ${href}`,
      );
    }
  }

  if (localIconCount === 0) {
    throw new Error("No local favicon links were found in staged index.html");
  }

  for (const match of indexHtml.matchAll(
    /\b(?:src|href)\s*=\s*(["'])([^"']+)\1/gi,
  )) {
    const reference = match[2];
    if (!reference || /^(?:data:|https?:|\/\/)/i.test(reference)) continue;

    const assetUrl = new URL(reference, "http://bundle.invalid");
    if (!assetUrl.pathname.includes("/assets/")) continue;

    const basePrefix =
      BUILD_INFO.basePath === "/" ? "/" : `${BUILD_INFO.basePath}/`;
    if (!assetUrl.pathname.startsWith(basePrefix)) {
      throw new Error(
        `Client asset URL does not use configured base path ${BUILD_INFO.basePath}: ${reference}`,
      );
    }

    const relativeAssetPath = assetUrl.pathname.slice(basePrefix.length);
    const stagedAssetPath = path.join(stagedClientDir, relativeAssetPath);
    if (!fs.existsSync(stagedAssetPath)) {
      throw new Error(`Referenced client asset is missing: ${reference}`);
    }
  }

  log(`  Validated ${requiredFiles.length} required files`);
  log(`  Validated ${localIconCount} build-versioned icon links`);
});

// Only after every build and validation step succeeds do we expose the new
// directory at the stable path. A failed rename restores the previous bundle.
step("Publish staged bundle", () => {
  // Re-check immediately before the destructive cutover. A long build gives
  // another process time to create or redirect the configured output path.
  resolveBundleOutputDirectory(ROOT_DIR, PUBLISHED_DIR);
  promoteStagedDirectory({
    stagedDir: STAGING_DIR,
    publishedDir: PUBLISHED_DIR,
    onWarning: (message) => log(`WARNING: ${message}`),
  });
  stagingPublished = true;
  log(`  Published at: ${path.relative(ROOT_DIR, PUBLISHED_DIR)}`);
});

// Helper: Recursive copy
function copyRecursive(src: string, dest: string): void {
  const stats = fs.statSync(src);

  if (stats.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      copyRecursive(path.join(src, file), path.join(dest, file));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Print summary
log(`\n${"=".repeat(60)}`);
log("Build Summary");
log("=".repeat(60));

for (const result of results) {
  const status = result.success ? "✓" : "✗";
  log(`${status} ${result.step}`);
  if (result.error) {
    log(`  Error: ${result.error}`);
  }
}

const allSuccess = results.every((r) => r.success);
if (allSuccess) {
  log("\n✓ All build steps completed successfully!");
  log("\nThe self-contained bundle is ready:");
  log(`  Location: ${path.relative(ROOT_DIR, PUBLISHED_DIR)}`);
  log("\nDistribution policy:");
  log(
    "  Attach the bundle to a ya-v* GitHub Release or use an authorized local deploy.",
  );
  log("  Do not publish this bundle to a package registry.");
  log("\nNote: packages/server/package.json is unchanged (workspace intact)");
} else {
  error("\n✗ Build failed. See errors above.");
  process.exit(1);
}
