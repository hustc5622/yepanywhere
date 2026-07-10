#!/usr/bin/env node

/**
 * Dev server wrapper script with configurable reload behavior.
 *
 * Usage:
 *   pnpm dev                      # Default: supervised backend reload + frontend HMR
 *   pnpm dev --no-watch           # Backend manual reload (banner), no auto-restart
 *   pnpm dev --no-frontend-reload # Frontend watches but doesn't HMR
 *
 * Environment:
 *   Create a .env file in the project root to set defaults:
 *     LOG_LEVEL=debug
 *     PORT=4000
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getBackendReloadPlan } from "./runtime-reload-classifier.js";
import { exitIfUnsafeHome } from "./safe-home.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const serverDir = join(rootDir, "packages", "server");
const isWindows = process.platform === "win32";
const pnpmBin = isWindows ? "pnpm.cmd" : "pnpm";
// Node 24+ on Windows requires shell:true to spawn .cmd files (CVE-2024-27980).
// DEP0190 warns about unescaped args, but all args here are hardcoded literals.
const shellOption = isWindows ? { shell: true } : {};

exitIfUnsafeHome({ entrypoint: "pnpm dev" });

function isSuppressedViteBannerLine(line) {
  return (
    /^\s*VITE v.+ready in /.test(line) ||
    /^\s*➜\s+Local:/.test(line) ||
    /^\s*➜\s+Network:/.test(line) ||
    /^\s*➜\s+press h \+ enter to show help/.test(line)
  );
}

function forwardWithLineFilter(stream, output, shouldSuppressLine) {
  if (!stream) return;
  let buffered = "";

  stream.on("data", (chunk) => {
    buffered += chunk.toString();

    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      if (!shouldSuppressLine(line)) {
        output.write(`${line}\n`);
      }
    }
  });

  stream.on("end", () => {
    if (buffered && !shouldSuppressLine(buffered)) {
      output.write(buffered);
    }
  });
}

// Load .env file if it exists (simple parser, no dependencies)
function loadEnvFile() {
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Only set if not already in environment (CLI overrides .env)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

// Parse CLI arguments
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: pnpm dev [options]

Options:
  --no-watch          Disable backend auto-reload (manual restart mode)
  --no-frontend-reload Frontend watches but doesn't HMR
  -h, --help          Show this help message

By default, supervised backend auto-reload and frontend HMR are both enabled.
Use --no-watch to switch the backend to manual restart mode (shows a reload
banner on file changes instead of auto-restarting).
`);
  process.exit(0);
}

// Backend auto-reload is ON by default (dev.js supervises the backend process).
// Use --no-watch to disable it and fall back to the manual reload banner.
// (--watch is accepted as a no-op for backwards compatibility with callers
// like dev-8022.js that used to opt in explicitly.)
const backendWatch = !args.includes("--no-watch");
const noFrontendReload = args.includes("--no-frontend-reload");

// Port configuration: PORT + 0 = server, +1 = maintenance, +2 = vite,
// +3 = long-lived agent runtime.
const basePort = process.env.PORT
  ? Number.parseInt(process.env.PORT, 10)
  : 3400;
const vitePort = process.env.VITE_PORT
  ? Number.parseInt(process.env.VITE_PORT, 10)
  : basePort + 2;
const maintenancePort =
  process.env.MAINTENANCE_PORT !== undefined
    ? Number.parseInt(process.env.MAINTENANCE_PORT, 10)
    : basePort + 1;
const runtimeMode =
  process.env.YEP_RUNTIME_MODE?.trim().toLowerCase() === "external"
    ? "external"
    : "embedded";
const runtimePort = process.env.YEP_RUNTIME_PORT
  ? Number.parseInt(process.env.YEP_RUNTIME_PORT, 10)
  : basePort + 3;
const runtimeControlUrl =
  process.env.YEP_RUNTIME_CONTROL_URL ?? `http://127.0.0.1:${runtimePort}`;
const yepDataDir =
  process.env.YEP_ANYWHERE_DATA_DIR ??
  join(
    homedir(),
    process.env.YEP_ANYWHERE_PROFILE
      ? `.yep-anywhere-${process.env.YEP_ANYWHERE_PROFILE}`
      : ".yep-anywhere",
  );
const runtimeTokenFile =
  process.env.YEP_RUNTIME_TOKEN_FILE ?? join(yepDataDir, "runtime", "token");
const runtimeDirtyFile = join(yepDataDir, "runtime", "dirty.json");
const protocol = process.env.HTTPS_SELF_SIGNED === "true" ? "https" : "http";
const configuredHost = process.env.HOST?.trim();
const displayHost =
  configuredHost && configuredHost !== "0.0.0.0" && configuredHost !== "::"
    ? configuredHost
    : "localhost";

console.log("Starting dev server...");
console.log(`  Access at: ${protocol}://${displayHost}:${basePort}`);
console.log(
  `  Ports: server=${basePort}, maintenance=${maintenancePort}, vite=${vitePort}, runtime=${runtimePort}`,
);
console.log(`  Agent runtime: ${runtimeMode.toUpperCase()}`);
console.log(
  `  Note: Vite output on :${vitePort} is internal HMR only; browse ${protocol}://${displayHost}:${basePort}`,
);
if (backendWatch) console.log("  Backend auto-reload: ENABLED");
if (noFrontendReload) console.log("  Frontend HMR: DISABLED");
if (!backendWatch && !noFrontendReload)
  console.log("  Frontend HMR: ENABLED, Backend: manual restart only");

// Build environment for child processes
const env = {
  ...process.env,
  // When backend watch is disabled, enable manual reload mode (shows banner on file changes)
  NO_BACKEND_RELOAD: backendWatch ? "" : "true",
  NO_FRONTEND_RELOAD: noFrontendReload ? "true" : "",
  // Pass vite port to both server and client for consistency
  VITE_PORT: String(vitePort),
  VITE_API_PORT: String(basePort),
  MAINTENANCE_PORT: String(maintenancePort),
  YEP_RUNTIME_MODE: runtimeMode,
  YEP_RUNTIME_PORT: String(runtimePort),
  YEP_RUNTIME_CONTROL_URL: runtimeControlUrl,
  YEP_RUNTIME_TOKEN_FILE: runtimeTokenFile,
  YEP_RUNTIME_MANAGED_BY_DEV: runtimeMode === "external" ? "true" : "",
};

// Track child processes for cleanup
const children = [];
const backendSourceWatchers = [];
const pendingBackendFiles = new Set();
let serverProcess = null;
let runtimeProcess = null;
let backendRestartTimer = null;
let restartRequested = false;
let restartReason = "";
let isCleaningUp = false;
let runtimeReloadRequested = false;

function cleanup() {
  isCleaningUp = true;
  stopBackendSourceWatchers();
  for (const child of children) {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

/**
 * Spawn a server process
 */
function startServer() {
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "--conditions", "source", "src/index.ts"],
    {
      cwd: serverDir,
      env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    },
  );

  serverProcess = server;
  children.push(server);

  server.on("exit", (code, signal) => {
    if (serverProcess === server) serverProcess = null;

    // Remove from children list
    const idx = children.indexOf(server);
    if (idx !== -1) children.splice(idx, 1);

    if (isCleaningUp) return;

    // Restart after a clean self-shutdown (/server/restart or /reload), or
    // after the wrapper requested a source-change restart.
    if (restartRequested || (code === 0 && signal === null)) {
      const reason = restartReason ? ` (${restartReason})` : "";
      restartRequested = false;
      restartReason = "";
      console.log(`\nRestarting server${reason}...`);
      startServer();
    } else if (code !== null && code !== 0) {
      console.error(`Server exited with code ${code}`);
    }
  });

  server.on("message", (message) => {
    if (
      message &&
      typeof message === "object" &&
      message.type === "runtime-reload"
    ) {
      void reloadExternalRuntime().catch((error) => {
        console.error(
          `[AgentRuntime] Reload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  });

  return server;
}

async function getRuntimeStatus() {
  if (!existsSync(runtimeTokenFile)) return null;
  const token = readFileSync(runtimeTokenFile, "utf8").trim();
  if (!token) return null;

  try {
    const response = await fetch(`${runtimeControlUrl}/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1000),
    });
    if (response.status === 401) {
      throw new Error(
        `Agent runtime at ${runtimeControlUrl} rejected ${runtimeTokenFile}`,
      );
    }
    if (!response.ok) return null;
    return response.json();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Agent runtime at")
    ) {
      throw error;
    }
    return null;
  }
}

async function ensureExternalRuntime() {
  if (runtimeMode !== "external") return;

  const existing = await getRuntimeStatus();
  if (existing) {
    console.log(
      `[AgentRuntime] Reusing ${runtimeControlUrl} (${existing.processCount ?? 0} process(es))`,
    );
    return;
  }

  const runtime = spawn(
    process.execPath,
    ["--import", "tsx", "--conditions", "source", "src/runtime/standalone.ts"],
    {
      cwd: serverDir,
      env,
      stdio: "inherit",
      detached: !isWindows,
    },
  );
  runtimeProcess = runtime;
  runtime.unref();
  runtime.on("exit", (code, signal) => {
    if (runtimeProcess === runtime) runtimeProcess = null;
    if (!isCleaningUp && !runtimeReloadRequested) {
      console.error(
        `[AgentRuntime] Exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
      );
    }
  });

  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const status = await getRuntimeStatus();
    if (status) {
      console.log(`[AgentRuntime] Ready at ${runtimeControlUrl}`);
      return;
    }
    if (runtime.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Agent runtime failed to start at ${runtimeControlUrl}`);
}

async function reloadExternalRuntime() {
  if (runtimeMode !== "external" || runtimeReloadRequested) return;
  runtimeReloadRequested = true;
  try {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline && (await getRuntimeStatus())) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (await getRuntimeStatus()) {
      throw new Error("Existing agent runtime did not stop before reload");
    }
    runtimeProcess = null;
    await ensureExternalRuntime();
    clearRuntimeDirty();
    requestServerRestart("agent runtime reloaded");
  } finally {
    runtimeReloadRequested = false;
  }
}

function isBackendSourceFile(filename) {
  return (
    (filename.endsWith(".ts") || filename.endsWith(".tsx")) &&
    !filename.includes("node_modules") &&
    !filename.includes("dist")
  );
}

function summarizeFiles(files) {
  const shown = files.slice(0, 3).join(", ");
  return files.length > 3 ? `${shown}, +${files.length - 3} more` : shown;
}

function markRuntimeDirty(files) {
  mkdirSync(dirname(runtimeDirtyFile), { recursive: true, mode: 0o700 });
  writeFileSync(
    runtimeDirtyFile,
    `${JSON.stringify({ files, timestamp: new Date().toISOString() }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function clearRuntimeDirty() {
  try {
    unlinkSync(runtimeDirtyFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function requestServerRestart(reason) {
  if (isCleaningUp) return;

  restartRequested = true;
  restartReason = reason;

  if (!serverProcess || serverProcess.exitCode !== null) {
    restartRequested = false;
    restartReason = "";
    console.log(`\nStarting server (${reason})...`);
    startServer();
    return;
  }

  if (!serverProcess.killed) {
    serverProcess.kill("SIGTERM");
  }
}

function scheduleBackendRestart() {
  if (backendRestartTimer) clearTimeout(backendRestartTimer);

  backendRestartTimer = setTimeout(() => {
    const files = Array.from(pendingBackendFiles);
    pendingBackendFiles.clear();
    backendRestartTimer = null;

    if (files.length > 0) {
      console.log(`[BackendWatch] Source changed: ${summarizeFiles(files)}`);
    }
    if (runtimeMode !== "external") {
      requestServerRestart("source change");
      return;
    }

    const reloadPlan = getBackendReloadPlan(files);
    const { runtimeImpactingFiles } = reloadPlan;
    if (runtimeImpactingFiles.length > 0) {
      markRuntimeDirty(runtimeImpactingFiles);
      console.log(
        `[BackendWatch] Agent runtime marked dirty: ${summarizeFiles(runtimeImpactingFiles)}`,
      );
    }

    if (reloadPlan.shouldReloadShell) {
      requestServerRestart("shell source change");
    } else {
      console.log(
        "[BackendWatch] Runtime-impacting changes are waiting for an explicit runtime reload",
      );
    }
  }, 300);
}

function createWatchHandler(watchDir) {
  return (_eventType, filename) => {
    if (!filename) return;

    const file = filename.toString();
    if (!isBackendSourceFile(file)) return;

    pendingBackendFiles.add(relative(rootDir, join(watchDir, file)));
    scheduleBackendRestart();
  };
}

function watchTree(root, handler) {
  const watchers = [];

  const visit = (dir) => {
    watchers.push(watch(dir, handler));

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      visit(join(dir, entry.name));
    }
  };

  visit(root);
  return watchers;
}

function startWatchingBackendDir(watchDir) {
  const handler = createWatchHandler(watchDir);

  try {
    return [watch(watchDir, { recursive: true }, handler)];
  } catch (error) {
    console.warn(
      `[BackendWatch] Recursive watch unavailable for ${relative(
        rootDir,
        watchDir,
      )}; watching existing subdirectories instead.`,
    );
    return watchTree(watchDir, handler);
  }
}

function startBackendSourceWatchers() {
  if (!backendWatch || backendSourceWatchers.length > 0) return;

  const watchDirs = [
    join(rootDir, "packages", "server", "src"),
    join(rootDir, "packages", "shared", "src"),
  ];

  for (const watchDir of watchDirs) {
    if (!existsSync(watchDir) || !statSync(watchDir).isDirectory()) continue;

    const watchers = startWatchingBackendDir(watchDir);
    for (const watcher of watchers) {
      watcher.on("error", (error) => {
        console.error("[BackendWatch] Error:", error);
      });
      backendSourceWatchers.push(watcher);
    }

    console.log(`[BackendWatch] Watching ${relative(rootDir, watchDir)}`);
  }
}

function stopBackendSourceWatchers() {
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }
  pendingBackendFiles.clear();

  while (backendSourceWatchers.length > 0) {
    backendSourceWatchers.pop()?.close();
  }
}

/**
 * Start the client dev server
 */
function startClient() {
  const client = spawn(pnpmBin, ["--filter", "client", "dev"], {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...shellOption,
  });

  forwardWithLineFilter(
    client.stdout,
    process.stdout,
    isSuppressedViteBannerLine,
  );
  forwardWithLineFilter(
    client.stderr,
    process.stderr,
    isSuppressedViteBannerLine,
  );

  children.push(client);

  client.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`Client exited with code ${code}`);
    }
  });

  return client;
}

async function main() {
  await ensureExternalRuntime();
  startServer();
  startBackendSourceWatchers();
  startClient();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  cleanup();
  process.exitCode = 1;
});
