#!/usr/bin/env node

/**
 * Development hot-reload entrypoint for the local 8022 deployment.
 *
 * This preserves the Codex bridge sidecar on 4510 and only replaces the
 * web/API process on 8022 when --replace is explicitly passed.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyDevCutover,
  classifyMaintenanceOwner,
  findDuplicateDevPort,
  formatDevCutoverWait,
  hasUnknownViteOwner,
} from "./dev-8022-cutover.js";
import { exitIfUnsafeHome } from "./safe-home.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const DEFAULT_PORT = 8022;
const DEFAULT_BASE_PATH = "/yep";
const DEFAULT_CODEX_BRIDGE_PORT = 4510;
const DEFAULT_OPENCODE_BRIDGE_PORT = 4520;

exitIfUnsafeHome({ entrypoint: "pnpm dev:8022" });

function showHelp() {
  console.log(`Usage: pnpm dev:8022 [options]

Options:
  --replace                    Stop the current 8022 web/API process first
  --allow-yep-session-interrupt
                               Allow replacing 8022 when Yep-managed sessions are active
  --wait-for-yep-sessions      Wait for active embedded-runtime turns to become idle
  --no-backend-watch           Disable supervised backend reloads
  --no-frontend-reload         Disable frontend HMR and show reload banners
  --check                      Run preflight checks without starting or stopping anything
  -h, --help                   Show this help message
`);
}

function parseArgs(argv) {
  const options = {
    replace: false,
    allowYepSessionInterrupt: false,
    waitForYepSessions: false,
    backendWatch: true,
    noFrontendReload: false,
    check: false,
  };

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--replace") {
      options.replace = true;
    } else if (arg === "--allow-yep-session-interrupt") {
      options.allowYepSessionInterrupt = true;
    } else if (arg === "--wait-for-yep-sessions") {
      options.waitForYepSessions = true;
    } else if (arg === "--no-backend-watch") {
      options.backendWatch = false;
    } else if (arg === "--no-frontend-reload") {
      options.noFrontendReload = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--help" || arg === "-h") {
      showHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBasePath(value) {
  const raw = (value ?? DEFAULT_BASE_PATH).trim();
  if (!raw || raw === "/") return "";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function getListenPids(port) {
  const result = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  );
  if (result.status !== 0 && !result.stdout.trim()) {
    return [];
  }
  return result.stdout
    .split(/\s+/)
    .map((pid) => pid.trim())
    .filter(Boolean);
}

function getCommand(pid) {
  const result = spawnSync("ps", ["-p", pid, "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function getParentPid(pid) {
  const result = spawnSync("ps", ["-p", pid, "-o", "ppid="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function getDevSupervisorPidsForServerPids(serverPids) {
  const supervisors = new Set();

  for (const pid of serverPids) {
    let current = pid;
    for (let depth = 0; depth < 8; depth += 1) {
      const parentPid = getParentPid(current);
      if (!parentPid || parentPid === "1" || parentPid === current) break;

      const command = getCommand(parentPid);
      if (
        command.includes(`${rootDir}/scripts/dev.js`) ||
        command.includes(`${rootDir}/scripts/dev-8022.js`)
      ) {
        supervisors.add(parentPid);
      }

      current = parentPid;
    }
  }

  return Array.from(supervisors);
}

/**
 * Vite processes serving this repo's client on OUR vite port only. An
 * unrelated `pnpm dev` (e.g. the default 3402 instance) must survive an 8022
 * hot-reload start, so ownership is decided by the listening port, not just
 * the command line.
 */
function getRepoClientVitePids(vitePort) {
  const listenPids = new Set(getListenPids(vitePort));
  if (listenPids.size === 0) return [];

  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];

  const pids = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;

    const [, pid, command] = match;
    if (
      listenPids.has(pid) &&
      command.includes(`${rootDir}/packages/client`) &&
      command.includes("vite")
    ) {
      pids.add(pid);
    }
  }

  return Array.from(pids);
}

function setsOverlap(left, right) {
  const rightSet = new Set(right);
  return left.some((pid) => rightSet.has(pid));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPortRelease(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getListenPids(port).length === 0) return true;
    await sleep(250);
  }
  return getListenPids(port).length === 0;
}

function fetchJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 120)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
  });
}

async function getWorkerActivity(serverBaseUrl) {
  try {
    return await fetchJson(`${serverBaseUrl}/api/status/workers`);
  } catch {
    return null;
  }
}

async function waitForSafeCutover(serverBaseUrl, port) {
  let lastMessage = "";
  let unknownChecks = 0;

  while (getListenPids(port).length > 0) {
    const activity = await getWorkerActivity(serverBaseUrl);
    const cutover = classifyDevCutover(activity);
    if (cutover === "safe") {
      return activity;
    }

    if (cutover === "unknown") {
      unknownChecks += 1;
      if (unknownChecks >= 10) {
        throw new Error(
          `${serverBaseUrl}/api/status/workers remained unavailable while waiting for a safe cutover.`,
        );
      }
      await sleep(1000);
      continue;
    }
    unknownChecks = 0;

    const message = formatDevCutoverWait(activity);
    if (message !== lastMessage) {
      console.log(message);
      console.log(
        "Yep has active embedded-runtime work. The dev cutover will continue automatically after all turns become idle.",
      );
      lastMessage = message;
    }
    await sleep(1000);
  }

  return null;
}

function acquireCutoverLock(port) {
  const lockFile = join(tmpdir(), `yep-dev-${port}-cutover.lock`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(lockFile, `${process.pid}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return () => {
        try {
          unlinkSync(lockFile);
        } catch {
          // A stale-lock cleanup or process shutdown may already have removed it.
        }
      };
    } catch (error) {
      if (!(error instanceof Error) || !Reflect.has(error, "code")) {
        throw error;
      }
      if (error.code !== "EEXIST") throw error;

      let existingPid = "";
      try {
        existingPid = readFileSync(lockFile, "utf8").trim();
      } catch (readError) {
        if (
          readError instanceof Error &&
          Reflect.has(readError, "code") &&
          readError.code === "ENOENT"
        ) {
          continue;
        }
        throw readError;
      }
      const existingCommand = existingPid ? getCommand(existingPid) : "";
      if (
        existingPid &&
        (existingCommand.includes(`${rootDir}/scripts/dev-8022.js`) ||
          existingCommand.includes("node scripts/dev-8022.js"))
      ) {
        console.log(
          `${formatDevCutoverWait(null)} existing_pid=${existingPid}`,
        );
        console.log(
          `A dev cutover is already waiting for embedded-runtime work to become idle (pid ${existingPid}).`,
        );
        return null;
      }

      try {
        unlinkSync(lockFile);
      } catch (unlinkError) {
        if (
          unlinkError instanceof Error &&
          Reflect.has(unlinkError, "code") &&
          unlinkError.code === "ENOENT"
        ) {
          continue;
        }
        throw unlinkError;
      }
    }
  }

  throw new Error(`Could not acquire dev cutover lock: ${lockFile}`);
}

async function getRuntimeStatus(runtimeControlUrl, runtimeTokenFile) {
  if (!existsSync(runtimeTokenFile)) return null;
  const token = readFileSync(runtimeTokenFile, "utf8").trim();
  if (!token) return null;
  try {
    const response = await fetch(`${runtimeControlUrl}/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function getBridgeStatus(bridgeControlUrl) {
  try {
    return await fetchJson(`${bridgeControlUrl}/status`);
  } catch {
    return null;
  }
}

async function preflightAuxiliaryPorts({
  port,
  maintenancePort,
  vitePort,
  runtimePort,
  bridgePort,
  opencodeBridgePort,
}) {
  const duplicate = findDuplicateDevPort([
    ["server", port],
    ["maintenance", maintenancePort],
    ["vite", vitePort],
    ["runtime", runtimePort],
    ["codex bridge", bridgePort],
    ["opencode bridge", opencodeBridgePort],
  ]);
  if (duplicate) {
    throw new Error(
      `Invalid dev port configuration: ${duplicate.names.join(" and ")} both use ${duplicate.port}.`,
    );
  }

  let maintenanceOwned = false;
  if (maintenancePort !== 0) {
    const maintenancePids = getListenPids(maintenancePort);
    let maintenanceStatus = null;
    if (maintenancePids.length > 0) {
      try {
        maintenanceStatus = await fetchJson(
          `http://127.0.0.1:${maintenancePort}/status`,
        );
      } catch {
        // A listener without the expected status payload belongs to another
        // service and must never receive our POST /reload request.
      }
    }
    const owner = classifyMaintenanceOwner({
      listenPids: maintenancePids,
      status: maintenanceStatus,
      mainServerPort: port,
    });
    if (owner === "conflict") {
      throw new Error(
        `Maintenance port ${maintenancePort} is occupied by PID(s) ${maintenancePids.join(", ")}, but it is not the maintenance service for server ${port}. Choose a free MAINTENANCE_PORT before replacing ${port}.`,
      );
    }
    maintenanceOwned = owner === "owned";
  }

  const vitePids = getListenPids(vitePort);
  const repoVitePids = getRepoClientVitePids(vitePort);
  if (hasUnknownViteOwner(vitePids, repoVitePids)) {
    throw new Error(
      `Vite port ${vitePort} is occupied by unrelated PID(s) ${vitePids.join(", ")}. Choose a free VITE_PORT before replacing ${port}.`,
    );
  }

  return { maintenanceOwned };
}

function printPids(label, pids) {
  if (pids.length === 0) {
    console.log(`${label}: none`);
    return;
  }

  console.log(`${label}: ${pids.join(", ")}`);
  for (const pid of pids) {
    const command = getCommand(pid);
    if (command) console.log(`  ${pid}: ${command}`);
  }
}

async function stopServerPids(port, pids) {
  console.log(`Stopping web/API listener on ${port}: ${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch (error) {
      console.warn(
        `Failed to send SIGTERM to ${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (await waitForPortRelease(port)) {
    return;
  }

  const remaining = getListenPids(port);
  throw new Error(
    `Port ${port} is still in use by ${remaining.join(", ")} after SIGTERM. Stop it manually or disable the LaunchAgent before starting dev hot reload.`,
  );
}

async function stopDevSupervisorPids(port, vitePort, pids) {
  console.log(
    `Stopping existing 8022 dev hot-reload supervisor: ${pids.join(", ")}`,
  );
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch (error) {
      console.warn(
        `Failed to send SIGTERM to dev supervisor ${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (await waitForPortRelease(port, 15000)) {
    await waitForPortRelease(vitePort, 5000);
    return;
  }

  const remaining = getListenPids(port);
  throw new Error(
    `Port ${port} is still in use by ${remaining.join(", ")} after stopping the existing dev supervisor.`,
  );
}

async function stopRepoClientVitePids(vitePort, pids) {
  if (pids.length === 0) return;

  console.log(`Stopping stale Yep client Vite process(es): ${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch (error) {
      console.warn(
        `Failed to send SIGTERM to Vite process ${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await waitForPortRelease(vitePort, 5000);
}

/**
 * Ask the running server to shut down gracefully via its maintenance endpoint
 * (POST /reload). This routes through gracefulShutdown, which aborts active
 * sessions cleanly and lets the CLI flush jsonl before the process exits —
 * preserving session history so the user can resume after the restart.
 *
 * Falls back to stopServerPids (direct SIGTERM) if the maintenance endpoint is
 * unreachable or doesn't release the port in time.
 */
async function stopServerGracefully(
  maintenancePort,
  port,
  pids,
  maintenanceOwned,
) {
  if (maintenancePort === 0 || !maintenanceOwned) {
    await stopServerPids(port, pids);
    return;
  }

  const url = `http://127.0.0.1:${maintenancePort}/reload`;
  console.log(`Asking server to shut down gracefully via ${url}`);
  try {
    const response = await fetch(url, { method: "POST" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn(
      `Graceful reload via maintenance endpoint failed (${
        error instanceof Error ? error.message : String(error)
      }); falling back to SIGTERM`,
    );
    await stopServerPids(port, pids);
    return;
  }

  // gracefulShutdown aborts sessions (5s timeout each) before exiting; give it
  // a generous window, then fall back to SIGTERM if the port is still held.
  if (await waitForPortRelease(port, 15000)) {
    return;
  }

  console.warn(
    `Port ${port} not released after graceful reload; falling back to SIGTERM`,
  );
  await stopServerPids(port, pids);
}

function startDevServer(env, options) {
  const devArgs = [join(rootDir, "scripts/dev.js")];
  if (options.backendWatch) devArgs.push("--watch");
  else devArgs.push("--no-watch");
  if (options.noFrontendReload) devArgs.push("--no-frontend-reload");

  const child = spawn(process.execPath, devArgs, {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const port = parsePort(process.env.PORT, DEFAULT_PORT);
  const basePath = normalizeBasePath(process.env.BASE_PATH);
  const vitePort = parsePort(process.env.VITE_PORT, port + 2);
  const maintenancePort =
    process.env.MAINTENANCE_PORT === "0"
      ? 0
      : parsePort(process.env.MAINTENANCE_PORT, port + 1);
  const runtimePort = parsePort(process.env.YEP_RUNTIME_PORT, port + 3);
  const runtimeControlUrl =
    process.env.YEP_RUNTIME_CONTROL_URL ?? `http://127.0.0.1:${runtimePort}`;
  const dataDir =
    process.env.YEP_ANYWHERE_DATA_DIR ??
    join(
      homedir(),
      process.env.YEP_ANYWHERE_PROFILE
        ? `.yep-anywhere-${process.env.YEP_ANYWHERE_PROFILE}`
        : ".yep-anywhere",
    );
  const runtimeTokenFile =
    process.env.YEP_RUNTIME_TOKEN_FILE ?? join(dataDir, "runtime", "token");
  const bridgePort = parsePort(
    process.env.YEP_CODEX_BRIDGE_PORT ?? process.env.CODEX_BRIDGE_PORT,
    DEFAULT_CODEX_BRIDGE_PORT,
  );
  const bridgeControlUrl =
    process.env.YEP_CODEX_BRIDGE_CONTROL_URL ??
    process.env.CODEX_BRIDGE_CONTROL_URL ??
    `http://127.0.0.1:${bridgePort}`;
  const opencodeBridgePort = parsePort(
    process.env.YEP_OPENCODE_BRIDGE_PORT ?? process.env.OPENCODE_BRIDGE_PORT,
    DEFAULT_OPENCODE_BRIDGE_PORT,
  );
  const opencodeBridgeControlUrl =
    process.env.YEP_OPENCODE_BRIDGE_CONTROL_URL ??
    process.env.OPENCODE_BRIDGE_CONTROL_URL ??
    `http://127.0.0.1:${opencodeBridgePort}`;
  const serverBaseUrl = `http://127.0.0.1:${port}${basePath}`;
  let releaseCutoverLock = null;
  let auxiliaryPorts = { maintenanceOwned: false };

  let serverPids = getListenPids(port);
  const bridgePids = getListenPids(bridgePort);
  const opencodeBridgePids = getListenPids(opencodeBridgePort);

  console.log("Yep Anywhere 8022 hot-reload preflight");
  console.log(`  server: ${serverBaseUrl}`);
  console.log(`  vite:   http://127.0.0.1:${vitePort}`);
  console.log(
    `  maint:  ${maintenancePort === 0 ? "disabled" : `http://127.0.0.1:${maintenancePort}`}`,
  );
  console.log(`  codex bridge: ${bridgeControlUrl}`);
  console.log(`  opencode bridge: ${opencodeBridgeControlUrl}`);
  console.log(`  agent runtime: ${runtimeControlUrl}`);
  printPids(`  ${port} listener`, serverPids);
  if (maintenancePort !== 0) {
    printPids(`  ${maintenancePort} listener`, getListenPids(maintenancePort));
  }
  printPids(`  ${vitePort} listener`, getListenPids(vitePort));
  printPids(`  ${runtimePort} listener`, getListenPids(runtimePort));
  printPids(`  ${bridgePort} listener`, bridgePids);
  printPids(`  ${opencodeBridgePort} listener`, opencodeBridgePids);

  auxiliaryPorts = await preflightAuxiliaryPorts({
    port,
    maintenancePort,
    vitePort,
    runtimePort,
    bridgePort,
    opencodeBridgePort,
  });

  const runtimeStatus = await getRuntimeStatus(
    runtimeControlUrl,
    runtimeTokenFile,
  );
  if (runtimeStatus) {
    console.log(
      `  runtime status: processes=${runtimeStatus.processCount ?? "unknown"}, active=${runtimeStatus.activeWorkers ?? "unknown"}, queue=${runtimeStatus.queueLength ?? "unknown"}`,
    );
  }

  if (bridgePids.length > 0 && setsOverlap(serverPids, bridgePids)) {
    throw new Error(
      `${bridgePort} is owned by the ${port} web/API process. Refusing to start hot reload because replacing ${port} would interrupt existing codex --remote sessions.`,
    );
  }
  if (
    opencodeBridgePids.length > 0 &&
    setsOverlap(serverPids, opencodeBridgePids)
  ) {
    throw new Error(
      `${opencodeBridgePort} is owned by the ${port} web/API process. Refusing to start hot reload because replacing ${port} would interrupt existing OpenCode bridge sessions.`,
    );
  }

  const bridgeStatus = await getBridgeStatus(bridgeControlUrl);
  if (bridgeStatus) {
    console.log(
      `  bridge status: listening=${String(
        bridgeStatus.listening,
      )}, connections=${bridgeStatus.connectionCount ?? "unknown"}, sessions=${
        bridgeStatus.sessionCount ?? "unknown"
      }`,
    );
  } else if (bridgePids.length > 0) {
    console.warn(`  bridge status: ${bridgeControlUrl}/status did not answer`);
  } else {
    console.warn(`  bridge status: no listener on ${bridgePort}`);
  }

  const opencodeBridgeStatus = await getBridgeStatus(opencodeBridgeControlUrl);
  if (opencodeBridgeStatus) {
    console.log(
      `  opencode bridge status: listening=${String(
        opencodeBridgeStatus.listening,
      )}, sessions=${opencodeBridgeStatus.sessionCount ?? "unknown"}, pending=${
        opencodeBridgeStatus.pendingInputCount ?? "unknown"
      }`,
    );
  } else if (opencodeBridgePids.length > 0) {
    console.warn(
      `  opencode bridge status: ${opencodeBridgeControlUrl}/status did not answer`,
    );
  } else {
    console.warn(
      `  opencode bridge status: no listener on ${opencodeBridgePort} (OpenCode sessions will be unavailable)`,
    );
  }

  if (options.check) {
    return;
  }

  if (serverPids.length > 0 && !options.replace) {
    throw new Error(
      `Port ${port} is already in use. Re-run with --replace to stop only the ${port} web/API process while preserving ${bridgePort}.`,
    );
  }

  if (serverPids.length > 0) {
    let activity = await getWorkerActivity(serverBaseUrl);
    if (
      classifyDevCutover(activity) === "unknown" &&
      !options.allowYepSessionInterrupt
    ) {
      throw new Error(
        `${serverBaseUrl}/api/status/workers could not be verified. Refusing to replace an unknown listener on ${port}; check PORT/BASE_PATH or explicitly pass --allow-yep-session-interrupt.`,
      );
    }
    if (
      classifyDevCutover(activity) === "wait" &&
      options.waitForYepSessions &&
      !options.allowYepSessionInterrupt
    ) {
      releaseCutoverLock = acquireCutoverLock(port);
      if (!releaseCutoverLock) return;
      activity = await waitForSafeCutover(serverBaseUrl, port);
      serverPids = getListenPids(port);
    }
    if (
      classifyDevCutover(activity) === "wait" &&
      !options.allowYepSessionInterrupt
    ) {
      throw new Error(
        `Yep currently reports active managed work (managed processes=${activity.activeWorkers}, queue=${activity.queueLength}). Replacing ${port} would abort at least one active turn. Wait for it to finish, pass --wait-for-yep-sessions, or explicitly pass --allow-yep-session-interrupt.`,
      );
    }
    if (
      activity &&
      activity.runtimeMode !== "external" &&
      activity.activeWorkers > 0 &&
      !activity.hasActiveWork
    ) {
      console.warn(
        `Yep reports ${activity.activeWorkers} idle managed process(es). They will be closed by the server restart, but no active turn is running.`,
      );
    }

    // Re-check after a potentially long idle wait. Another process may have
    // claimed an auxiliary port while the cutover was queued.
    auxiliaryPorts = await preflightAuxiliaryPorts({
      port,
      maintenancePort,
      vitePort,
      runtimePort,
      bridgePort,
      opencodeBridgePort,
    });

    const devSupervisorPids = getDevSupervisorPidsForServerPids(serverPids);
    if (devSupervisorPids.length > 0) {
      await stopDevSupervisorPids(port, vitePort, devSupervisorPids);
      serverPids = getListenPids(port);
    }

    if (serverPids.length > 0) {
      await stopServerGracefully(
        maintenancePort,
        port,
        serverPids,
        auxiliaryPorts.maintenanceOwned,
      );
    }

    const bridgePidsAfter = getListenPids(bridgePort);
    if (bridgePids.length > 0 && !setsOverlap(bridgePids, bridgePidsAfter)) {
      console.warn(
        `Codex bridge listener changed while replacing ${port}: before=${bridgePids.join(
          ",",
        )} after=${bridgePidsAfter.join(",") || "none"}`,
      );
    }
  }

  await stopRepoClientVitePids(vitePort, getRepoClientVitePids(vitePort));

  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    BASE_PATH: basePath || "/",
    MAINTENANCE_PORT: String(maintenancePort),
    VITE_PORT: String(vitePort),
    VITE_API_PORT: String(port),
    YEP_CODEX_BRIDGE_MODE: "external",
    YEP_CODEX_BRIDGE_CONTROL_URL: bridgeControlUrl,
    YEP_CODEX_BRIDGE_PORT: String(bridgePort),
    YEP_OPENCODE_BRIDGE_CONTROL_URL: opencodeBridgeControlUrl,
    YEP_OPENCODE_BRIDGE_PORT: String(opencodeBridgePort),
    YEP_RUNTIME_MODE: "external",
    YEP_RUNTIME_PORT: String(runtimePort),
    YEP_RUNTIME_CONTROL_URL: runtimeControlUrl,
    YEP_RUNTIME_TOKEN_FILE: runtimeTokenFile,
  };

  console.log(
    `Starting hot reload on ${serverBaseUrl} (${options.backendWatch ? "backend watch" : "manual backend reload"}, ${options.noFrontendReload ? "frontend manual reload" : "frontend HMR"})`,
  );
  startDevServer(env, options);
  releaseCutoverLock?.();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
