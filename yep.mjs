#!/usr/bin/env node
/**
 * yep.mjs - Unified cross-platform service manager for Yep Anywhere.
 *
 * This is the SINGLE entry point that works on both macOS/Linux and Windows.
 * Flow:
 *   1. Choose target platform (auto-detected, but can be overridden interactively).
 *   2. Choose a management action from the SAME menu yep.sh exposes.
 *   3. Route the action to yep.sh (macOS/Linux) or scripts/yep.ps1 (Windows).
 *
 * The actual engines (yep.sh on macOS, scripts/yep.ps1 on Windows) are unchanged;
 * this file only selects the platform and dispatches. macOS capabilities are preserved.
 *
 * Usage:
 *   node yep.mjs                 # interactive: pick platform, then action
 *   node yep.mjs status          # direct command (platform auto-detected)
 *   pnpm yep                     # same as `node yep.mjs`
 *
 * Port layout (identical on both platforms):
 *   Dev:    main 3400, maintenance 3401, Vite 3402
 *   Prod:   8022 (Bundle entry dist/npm-package/dist/cli.js)
 *   Bridges: Codex 4510, Claude 4520
 */

import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname);

const DETECTED = process.platform === "win32" ? "windows" : "mac";

// Menu mirrors yep.sh's interactive menu (1-8 + help + quit).
// `disable-autostart` is a Windows-only convenience (Scheduled Task removal);
// it is hidden on macOS so the macOS menu stays identical to yep.sh.
const MENU = [
  {
    key: "1",
    action: "start-dev",
    label: "Start dev mode (port 3400, hot reload)",
  },
  {
    key: "2",
    action: "start-prod",
    label: "Start production server (port 8022, Bundle)",
  },
  { key: "3", action: "stop", label: "Stop all services" },
  { key: "4", action: "restart-dev", label: "Restart dev mode" },
  { key: "5", action: "restart-prod", label: "Restart production server" },
  { key: "6", action: "status", label: "Show service status" },
  { key: "7", action: "rebuild", label: "Rebuild project" },
  {
    key: "8",
    action: "enable-autostart",
    label: "Enable autostart (launchd on macOS / Scheduled Task on Windows)",
  },
  {
    key: "9",
    action: "disable-autostart",
    label: "Disable autostart (Windows only)",
  },
  { key: "h", action: "help", label: "Help" },
  { key: "q", action: "quit", label: "Quit" },
];

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // Some delegated actions are interactive (for example `yep.sh start-dev`
      // asks whether to run in the foreground), so the child needs the terminal.
      child = spawn(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
    } catch (err) {
      console.error(`Failed to launch "${cmd}": ${err.message}`);
      resolve(1);
      return;
    }
    child.on("error", (err) => {
      console.error(`Failed to launch "${cmd}": ${err.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ask(rl, question) {
  return new Promise((resolve) =>
    rl.question(question, (a) => resolve((a || "").trim())),
  );
}

async function selectPlatform(rl) {
  console.log("");
  console.log("Target platform:");
  console.log("  [1] macOS / Linux  (routes to yep.sh, requires bash)");
  console.log(
    "  [2] Windows        (routes to scripts/yep.ps1, requires PowerShell)",
  );
  const def = DETECTED === "windows" ? "2" : "1";
  const ans = await ask(rl, `Select [1/2] (default ${def} = ${DETECTED}): `);
  if (ans === "") return DETECTED;
  if (ans === "1") return "mac";
  if (ans === "2") return "windows";
  console.log(`Invalid selection, falling back to auto-detected: ${DETECTED}`);
  return DETECTED;
}

// Map a unified action name to the engine-specific subcommand.
function macAction(action) {
  if (action === "enable-autostart") return "enable-launchd";
  if (action === "disable-autostart") return "__unsupported__";
  return action;
}

async function dispatch(platform, action, actionArgs = []) {
  if (platform === "windows") {
    const ps1 = path.join(repoRoot, "scripts", "yep.ps1");
    const psExe = "powershell";
    let psAction = action;
    if (action === "enable-autostart") psAction = "enable-autostart";
    if (action === "disable-autostart") psAction = "disable-autostart";
    return runCommand(psExe, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      ps1,
      psAction,
      ...actionArgs,
    ]);
  }

  // macOS / Linux
  const shAction = macAction(action);
  if (shAction === "__unsupported__") {
    console.log("Autostart disable is not exposed by yep.sh on macOS.");
    console.log(
      "Use the macOS LaunchAgent uninstall script instead: scripts/uninstall-launchagents.sh",
    );
    return 0;
  }
  const yepSh = path.join(repoRoot, "yep.sh");
  return runCommand("bash", [yepSh, shAction, ...actionArgs]);
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Direct command shortcut (non-interactive): node yep.mjs <action>
  const direct = process.argv.slice(2);
  if (direct.length > 0) {
    const action =
      direct[0] === "-h" || direct[0] === "--help" ? "help" : direct[0];
    console.log(`[yep] platform auto-detected: ${DETECTED}`);
    await dispatch(DETECTED, action, direct.slice(1));
    rl.close();
    return;
  }

  const platform = await selectPlatform(rl);

  while (true) {
    console.log("");
    console.log("============================================");
    console.log(
      `  Yep Anywhere - ${platform === "windows" ? "Windows" : "macOS/Linux"} service manager`,
    );
    console.log("============================================");
    for (const m of MENU) {
      if (platform === "mac" && m.action === "disable-autostart") continue; // keep macOS menu == yep.sh
      console.log(`  ${m.key}) ${m.label}`);
    }
    console.log("");
    const choice = await ask(rl, "Select an action: ");

    if (choice === "q" || choice === "0") {
      console.log("Bye.");
      break;
    }

    const item = MENU.find((m) => m.key === choice);
    if (!item) {
      console.log("Invalid selection.");
      await sleep(400);
      continue;
    }

    if (item.action === "help") {
      await dispatch(platform, "help");
      await sleep(600);
      continue;
    }
    if (item.action === "quit") break;

    await dispatch(platform, item.action);
    await sleep(600);
  }

  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
