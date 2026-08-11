#!/usr/bin/env node
/**
 * win-update-build.mjs — Windows-only detached wrapper for the in-process update flow.
 *
 * Background:
 *   `git-pull-deploy.ts` runs the entire update (git pull / build / npm ci / restart)
 *   inside the 8022 production server process. On macOS, deleting an already-open
 *   file is an advisory lock, so `fs.rmSync` of dist/npm-package/node_modules
 *   succeeds and `npm ci` can run in-process. On Windows the running server holds
 *   a MANDATORY file lock on native modules (e.g. bcrypt's .node), so rmSync cannot
 *   delete node_modules and `npm ci` fails with EPERM -4048 ("更新到本地/GitHub
 *   在 Windows 失效" 的根因). And stopping the server in-process == killing the
 *   process that is running the build, so it cannot be done in-process.
 *
 *   This script is spawned DETACHED + unref from the server. It is a separate
 *   process, so it survives the 8022 server being killed. It:
 *     1. stops the 8022 listener (releasing the mandatory file locks),
 *     2. removes the stale node_modules,
 *     3. runs `npm ci` (unless runNpmCi=0, the server-restart path),
 *     4. restarts 8022 via `deploy.ps1 --restart-only`,
 *     5. health-checks /api/version,
 *     6. writes the FINAL job status (succeeded / failed) back to the job file.
 *
 *   The in-process code already wrote `succeeded` (build stage) before handing off,
 *   so hydrateJob never auto-finalizes the job as failed when the server dies.
 *   This mirrors the macOS model (restart-and-report.mjs) exactly.
 *
 * Usage:
 *   node win-update-build.mjs <jobFile> <port> <repoRoot> <npmPackageDir> <deployPs1> <runNpmCi>
 *     runNpmCi = "1"  for github / local updates (needs npm ci)
 *              = "0"  for server-restart (no runtime reinstall)
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const [jobFile, portArg, repoRoot, npmPackageDir, deployPs1, runNpmCiArg] =
  process.argv.slice(2);

const port = Number(portArg) || 8022;
const runNpmCi = runNpmCiArg !== "0";

function readJob() {
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf-8"));
  } catch {
    return {};
  }
}

function writeJob(patch) {
  const j = readJob();
  Object.assign(j, patch, { updatedAt: new Date().toISOString() });
  if (patch.status && patch.status !== "running") {
    j.finishedAt = new Date().toISOString();
  }
  fs.writeFileSync(jobFile, JSON.stringify(j, null, 2));
}

function log(msg) {
  process.stderr.write(`\n[win-update-build] ${msg}\n`);
}

function getListeningPids() {
  try {
    const out =
      spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf-8" })
        .stdout || "";
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m && Number(m[1]) === port) pids.add(Number(m[2]));
    }
    if (pids.size > 0) return [...pids];
  } catch {
    /* fall through to powershell */
  }
  try {
    const out =
      spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess`,
        ],
        { encoding: "utf-8" },
      ).stdout || "";
    return [
      ...new Set(
        out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /^\d+$/.test(l))
          .map(Number),
      ),
    ];
  } catch {
    return [];
  }
}

function stopPids(pids) {
  for (const pid of pids) {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/F", "/T"], {
        stdio: "ignore",
      });
    } catch (e) {
      log(`taskkill ${pid} failed: ${e}`);
    }
  }
}

async function waitPortReleased(tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (getListeningPids().length === 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return getListeningPids().length === 0;
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`exit ${code}: ${out.slice(-2000)}`)),
    );
  });
}

(async () => {
  try {
    log(
      `Windows update wrapper started (port=${port}, runNpmCi=${runNpmCi}, job=${jobFile})`,
    );

    // 1) Stop 8022 to release mandatory file locks on dist/npm-package/node_modules.
    const pids = getListeningPids();
    if (pids.length > 0) {
      log(
        `Stopping yepanywhere on port ${port} (pids: ${pids.join(", ")}) to release file locks...`,
      );
      stopPids(pids);
      const released = await waitPortReleased();
      if (!released) {
        log(
          `Port ${port} still held after stop; npm ci may still hit EPERM. Continuing.`,
        );
      }
    } else {
      log(`No listener on port ${port}; nothing to stop.`);
    }

    // 2) Clean stale node_modules (server stopped, lock released now).
    if (runNpmCi) {
      const nm = path.join(npmPackageDir, "node_modules");
      if (fs.existsSync(nm)) {
        log("Removing stale node_modules (lock released)...");
        fs.rmSync(nm, { recursive: true, force: true });
      }

      // 3) Install runtime dependencies.
      log("Running npm ci in dist/npm-package...");
      await run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
        cwd: npmPackageDir,
        env: process.env,
        shell: true,
      });
    } else {
      log("runNpmCi=0: skipping npm ci (restart-only path).");
    }

    // 4) Restart production server (deploy.ps1 --restart-only stops + starts +
    //    runs its own Wait-Health on /api/version, respecting BASE_PATH). If that
    //    fails, `run` rejects and we mark the job failed below — so no extra HTTP
    //    health check is needed here (it would ignore BASE_PATH and false-fail).
    log("Restarting production server via deploy.ps1 --restart-only ...");
    await run(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        deployPs1,
        "--restart-only",
      ],
      { cwd: repoRoot, env: process.env },
    );

    log("Update succeeded.");
    writeJob({ status: "succeeded", exitCode: 0 });
    process.exit(0);
  } catch (e) {
    const reason = `更新失败: ${e instanceof Error ? e.message : String(e)}`;
    log(reason);
    writeJob({ status: "failed", exitCode: 1, errorReason: reason });
    process.exit(1);
  }
})();
