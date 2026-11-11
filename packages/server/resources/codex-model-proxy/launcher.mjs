import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import {
  directEnvironment,
  selectOpenAiBase,
  startModelRelay,
} from "./relay.mjs";

const PROBE_REQUEST_TIMEOUT_MS = 20_000;
const PROBE_TOTAL_TIMEOUT_MS = 25_000;

/**
 * fd 0/1 are the Codex JSON-RPC channel, inherited by the real app-server.
 * Node initializes process.stdin/stdout lazily, and that init sets O_NONBLOCK
 * on the shared open file description (even a bare `Readable#pipe` reads
 * `process.stdout` to decide `doEnd`, which the model relay triggers on its
 * first request). Codex's blocking stdout writer then hits EAGAIN on a large
 * message, its writer thread exits, and the app-server silently stops sending
 * notifications while the turn keeps running. Pin inert streams so this
 * process never opens a handle on the protocol descriptors.
 */
export function isolateProtocolStdio(target = process) {
  const streams = {
    stdin: new Readable({ read() {} }),
    stdout: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  };
  for (const [name, value] of Object.entries(streams)) {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }
}

/** Only pass configuration flags to the read-only probe, never its command. */
export function configArguments(args) {
  const result = [];
  const flags = new Set([
    "-c",
    "--config",
    "-C",
    "--cd",
    "-p",
    "--profile",
    "--enable",
    "--disable",
  ]);
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    const arg = args[i];
    if (flags.has(arg) && i + 1 < args.length) result.push(arg, args[++i]);
    else if (/^--(config|cd|profile|enable|disable)=/.test(arg))
      result.push(arg);
  }
  return result;
}

/** Ask the installed CLI for its effective config/auth mode; no model turn. */
export async function readLaunchContext(command, args, env) {
  const child = spawn(
    command,
    [
      "app-server",
      ...configArguments(args),
      "--disable",
      "respect_system_proxy",
      "--listen",
      "stdio://",
    ],
    { env, stdio: ["pipe", "pipe", "ignore"] },
  );
  const pending = new Map();
  let closed = false;
  const exited = new Promise((resolve) => child.once("close", resolve));
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.error)
      handler.reject(new Error("Codex routing configuration probe failed"));
    else handler.resolve(message.result);
  });
  function rejectPending() {
    closed = true;
    for (const handler of pending.values())
      handler.reject(new Error("Codex routing configuration probe exited"));
    pending.clear();
  }
  child.on("error", rejectPending);
  child.on("exit", rejectPending);
  child.stdin.on("error", rejectPending);
  // One budget for the whole probe: three sequential 20s waits could outlast
  // the caller's own 30s startup wait.
  const deadline = Date.now() + PROBE_TOTAL_TIMEOUT_MS;
  async function request(method, params) {
    if (closed) throw new Error("Codex routing configuration probe exited");
    const id = ++nextId;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Codex routing configuration probe timed out (${method})`,
              ),
            ),
          Math.max(
            1,
            Math.min(PROBE_REQUEST_TIMEOUT_MS, deadline - Date.now()),
          ),
        );
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  try {
    await request("initialize", {
      clientInfo: { name: "yep-model-routing", version: "1" },
      capabilities: {},
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const { config } = await request("config/read", { includeLayers: false });
    const { account } = await request("account/read", { refreshToken: false });
    return { config, account };
  } finally {
    lines.close();
    child.stdin.end();
    // This disposable probe belongs to this invocation; no resident session
    // or existing service is touched. Closing stdin normally exits immediately.
    const term = setTimeout(() => child.kill("SIGTERM"), 1_000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try {
      await exited;
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
    }
  }
}

export function routedArguments(args, baseUrl) {
  const separator = args.indexOf("--");
  const split = separator < 0 ? args.length : separator;
  return [
    ...args.slice(0, split),
    "--disable",
    "respect_system_proxy",
    ...(baseUrl ? ["-c", `openai_base_url=${JSON.stringify(baseUrl)}`] : []),
    ...args.slice(split),
  ];
}

/**
 * One-line failure report: the stage that failed and the error's name, code
 * and message, with URL credentials removed (the proxy URL may carry them).
 */
export function describeLaunchFailure(error) {
  const stage = error?.launchStage ?? "launch";
  const name = error?.name ?? "Error";
  const code = typeof error?.code === "string" ? ` ${error.code}` : "";
  const message = String(error?.message ?? error ?? "")
    .replace(/\/\/[^/@\s]*@/g, "//***@")
    .slice(0, 300);
  return `Codex model routing failed during ${stage} (${name}${code}: ${message}); no direct model fallback was attempted.`;
}

export async function launch(command, args, environment = process.env) {
  const env = directEnvironment(environment);
  let relay;
  let stage = "configuration probe";
  try {
    if (
      environment.YEP_CODEX_MODEL_PROXY_URL &&
      !args.some((arg) => ["--version", "-V", "--help", "-h"].includes(arg))
    ) {
      const { config, account } = await readLaunchContext(command, args, env);
      stage = "upstream selection";
      const base = selectOpenAiBase(config, account);
      if (base) {
        stage = "CA certificate read";
        const caPath =
          environment.CODEX_CA_CERTIFICATE || environment.SSL_CERT_FILE;
        const ca = caPath
          ? [...rootCertificates, await readFile(caPath, "utf8")]
          : undefined;
        stage = "model relay start";
        relay = await startModelRelay({
          upstreamBase: base,
          proxyUrl: environment.YEP_CODEX_MODEL_PROXY_URL,
          ca,
        });
      }
    }
    stage = "Codex start";
    const child = spawn(command, routedArguments(args, relay?.baseUrl), {
      env,
      stdio: "inherit",
    });
    const signals = new Map(
      ["SIGTERM", "SIGINT", "SIGHUP"].map((signal) => [
        signal,
        () => child.kill(signal),
      ]),
    );
    for (const [signal, handler] of signals) process.on(signal, handler);
    try {
      return await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });
    } finally {
      for (const [signal, handler] of signals) process.off(signal, handler);
    }
  } catch (error) {
    if (error && typeof error === "object" && !("launchStage" in error))
      error.launchStage = stage;
    throw error;
  } finally {
    await relay?.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  isolateProtocolStdio();
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error(
      "Usage: launcher.mjs <real-codex-executable> [Codex arguments...]",
    );
    process.exitCode = 1;
  } else {
    try {
      process.exitCode = await launch(command, args);
    } catch (error) {
      console.error(describeLaunchFailure(error));
      process.exitCode = 1;
    }
  }
}
