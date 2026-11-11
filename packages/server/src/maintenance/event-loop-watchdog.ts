/**
 * Kill this process when its main thread stops turning the event loop.
 *
 * launchd (KeepAlive.SuccessfulExit=false) restarts a process that exits, but
 * not one that is alive and stuck in synchronous code. A stuck main thread
 * cannot notice its own stall, so the check runs in a worker thread: the main
 * thread bumps a shared counter, and the worker kills the process once the
 * counter has not moved for `stallMs`. Before killing, the worker pauses the
 * main thread through the inspector and writes its JS stack to stderr, so the
 * next stall names the guilty code.
 */

import { Worker } from "node:worker_threads";

export const EVENT_LOOP_WATCHDOG_ENV = "YEP_EVENT_LOOP_WATCHDOG_MS";
const DEFAULT_STALL_MS = 30_000;
const STACK_CAPTURE_TIMEOUT_MS = 5_000;

const WORKER_SOURCE = String.raw`
const { workerData } = require("node:worker_threads");
const inspector = require("node:inspector");
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");

const { beat, name, stallMs, intervalMs, stackTimeoutMs } = workerData;
const counter = new Int32Array(beat);
let lastCount = Atomics.load(counter, 0);
let lastChange = performance.now();
let lastTick = lastChange;

function write(text) {
  try { fs.writeSync(2, text); } catch {}
}

function kill() {
  process.kill(process.pid, "SIGKILL");
}

function captureStackAndKill(stalledMs) {
  write("[EventLoopWatchdog] " + name + " main thread stalled for " + Math.round(stalledMs) + "ms; killing pid " + process.pid + "\n");
  const fallback = setTimeout(kill, stackTimeoutMs);
  try {
    const session = new inspector.Session();
    session.connectToMainThread();
    const scriptUrls = new Map();
    session.on("Debugger.scriptParsed", ({ params }) => {
      scriptUrls.set(params.scriptId, params.url);
    });
    session.on("Debugger.paused", ({ params }) => {
      const frames = params.callFrames.slice(0, 40).map((frame) => {
        const url = frame.url || scriptUrls.get(frame.location.scriptId) || "<unknown>";
        return "    at " + (frame.functionName || "<anonymous>") + " (" + url + ":" + (frame.location.lineNumber + 1) + ":" + (frame.location.columnNumber + 1) + ")";
      });
      write("[EventLoopWatchdog] " + name + " main thread stack:\n" + frames.join("\n") + "\n");
      clearTimeout(fallback);
      kill();
    });
    session.post("Debugger.enable");
    session.post("Debugger.pause");
  } catch (error) {
    write("[EventLoopWatchdog] stack capture failed: " + error + "\n");
    clearTimeout(fallback);
    kill();
  }
}

const timer = setInterval(() => {
  const now = performance.now();
  // The worker itself was not scheduled (system sleep, SIGSTOP): restart the window.
  if (now - lastTick > intervalMs * 5) lastChange = now;
  lastTick = now;
  const count = Atomics.load(counter, 0);
  if (count !== lastCount) {
    lastCount = count;
    lastChange = now;
    return;
  }
  if (now - lastChange < stallMs) return;
  clearInterval(timer);
  captureStackAndKill(now - lastChange);
}, intervalMs);
`;

let started = false;

/** 0 disables. Defaults to on only in production, where launchd restarts us. */
export function eventLoopWatchdogStallMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[EVENT_LOOP_WATCHDOG_ENV]?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return env.NODE_ENV === "production" ? DEFAULT_STALL_MS : 0;
}

export function startEventLoopWatchdog(
  name: string,
  stallMs: number = eventLoopWatchdogStallMs(),
): boolean {
  if (started || stallMs <= 0) return false;
  const intervalMs = Math.max(10, Math.min(1_000, Math.floor(stallMs / 4)));
  const beat = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const counter = new Int32Array(beat);
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        beat,
        name,
        stallMs,
        intervalMs,
        stackTimeoutMs: STACK_CAPTURE_TIMEOUT_MS,
      },
    });
  } catch (error) {
    console.error("[EventLoopWatchdog] Failed to start:", error);
    return false;
  }
  started = true;
  worker.unref();
  worker.on("error", (error) => {
    console.error("[EventLoopWatchdog] Worker failed:", error);
  });
  setInterval(() => Atomics.add(counter, 0, 1), intervalMs).unref();
  console.log(
    `[EventLoopWatchdog] ${name}: kill after ${stallMs}ms without an event-loop turn`,
  );
  return true;
}
