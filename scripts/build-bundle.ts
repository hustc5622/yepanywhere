#!/usr/bin/env tsx

/**
 * Build script for npm package distribution
 *
 * This script prepares a single bundle for npm publishing by:
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

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const CLIENT_DIST = path.join(ROOT_DIR, "packages/client/dist");
const SERVER_PACKAGE = path.join(ROOT_DIR, "packages/server");
const SERVER_DIST = path.join(SERVER_PACKAGE, "dist");
const SHARED_DIST = path.join(ROOT_DIR, "packages/shared/dist");

// Staging directory for npm publishing (keeps workspace package.json intact)
const STAGING_DIR = path.join(ROOT_DIR, "dist/npm-package");

// Version for npm package - set via NPM_VERSION env var (from git tag in CI) or fallback
const NPM_VERSION = process.env.NPM_VERSION || "0.4.8";
const BUILD_DATE = process.env.YEP_BUILD_DATE || new Date().toISOString();

function commandOutput(command: string): string | null {
  try {
    const output = execSync(command, {
      cwd: ROOT_DIR,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return output.length > 0 ? output : null;
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
  execStep("pnpm --filter @yep-anywhere/shared build");
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
  execStep("pnpm --filter @yep-anywhere/client build", undefined, {
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
  execStep("pnpm --filter @yep-anywhere/server build");

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
  log("  Written to: dist/npm-package/build-info.json");
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

// Generate package.json for publishing (in staging, not modifying original)
step("Generate package.json for npm", () => {
  log("Generating package.json for npm publishing...");

  const sourcePackageJsonPath = path.join(SERVER_PACKAGE, "package.json");
  const sourcePackageJson = JSON.parse(
    fs.readFileSync(sourcePackageJsonPath, "utf-8"),
  );

  // Create a new package.json for publishing
  const npmPackageJson: Record<string, unknown> = {
    name: "yepanywhere",
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
    files: ["dist", "client-dist", "bundled", "README.md"],
    // Copy dependencies from source, excluding workspace deps
    dependencies: Object.fromEntries(
      Object.entries(sourcePackageJson.dependencies || {}).filter(
        ([name]) => !name.startsWith("@yep-anywhere/"),
      ),
    ),
    repository: {
      type: "git",
      url: "git+https://github.com/kzahel/yepanywhere.git",
    },
    homepage: "https://github.com/kzahel/yepanywhere#readme",
    bugs: {
      url: "https://github.com/kzahel/yepanywhere/issues",
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

  log("  Package name: yepanywhere");
  log(`  Version: ${NPM_VERSION}`);
  log("  Written to: dist/npm-package/package.json");
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

\`\`\`bash
npm install -g yepanywhere
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
  log("\nThe npm package is ready for publishing:");
  log(`  Location: ${path.relative(ROOT_DIR, STAGING_DIR)}`);
  log("\nNext steps:");
  log("  1. cd dist/npm-package");
  log("  2. Test: npm pack");
  log("  3. Publish: npm publish");
  log("\nNote: packages/server/package.json is unchanged (workspace intact)");
} else {
  error("\n✗ Build failed. See errors above.");
  process.exit(1);
}
