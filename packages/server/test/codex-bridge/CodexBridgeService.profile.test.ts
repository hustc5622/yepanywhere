import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CodexBridgeService } from "../../src/codex-bridge/CodexBridgeService.js";

describe("CodexBridgeService managed upstream profiles", () => {
  let bridge: CodexBridgeService | null = null;
  let tempDir: string | null = null;
  let previousArgsLog: string | undefined;

  afterEach(async () => {
    await bridge?.shutdown();
    bridge = null;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    if (previousArgsLog === undefined) {
      process.env.YEP_FAKE_CODEX_ARGS_LOG = undefined;
    } else {
      process.env.YEP_FAKE_CODEX_ARGS_LOG = previousArgsLog;
    }
  });

  it("routes default connections to light upstream and bearer tokens to profile upstreams", async () => {
    tempDir = await mkdtemp(join(process.cwd(), ".tmp-codex-bridge-profile-"));
    const codexPath = join(tempDir, "fake-codex.mjs");
    const argsLogPath = join(tempDir, "args.jsonl");
    previousArgsLog = process.env.YEP_FAKE_CODEX_ARGS_LOG;
    process.env.YEP_FAKE_CODEX_ARGS_LOG = argsLogPath;

    await writeFile(codexPath, FAKE_CODEX_APP_SERVER, { mode: 0o755 });
    await chmod(codexPath, 0o755);

    const bridgePort = await findAvailablePort();
    const upstreamStartPort = await findAvailablePort();
    bridge = new CodexBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      upstreamStartPort,
      lightUpstreamArgs: ["--light-profile"],
      clearUpstreamArgs: ["--clear-profile"],
      fullUpstreamArgs: ["--full-profile"],
      codexPath,
      startupTimeoutMs: 5000,
    });
    await bridge.start();

    const clearClient = await connect(`ws://127.0.0.1:${bridgePort}`, {
      authorization: "Bearer clear",
    });
    await waitForArgsLog(argsLogPath, 1);
    expect(bridge.getStatus().upstreamRunning).toBe(true);
    const lightClient = await connect(`ws://127.0.0.1:${bridgePort}`);
    await waitForArgsLog(argsLogPath, 2);
    const fullClient = await connect(`ws://127.0.0.1:${bridgePort}`, {
      authorization: "Bearer full",
    });
    await waitForArgsLog(argsLogPath, 3);
    const fallbackClient = await connect(
      `ws://127.0.0.1:${bridgePort}?mcp=unknown`,
    );

    try {
      const args = await readArgsLog(argsLogPath);
      expect(args).toHaveLength(3);
      expect(args[0]).toEqual([
        "app-server",
        "--clear-profile",
        "--listen",
        expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      ]);
      expect(args[1]).toEqual([
        "app-server",
        "--light-profile",
        "--listen",
        expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      ]);
      expect(args[2]).toEqual([
        "app-server",
        "--full-profile",
        "--listen",
        expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      ]);
      expect(args[0]?.at(-1)).not.toBe(args[1]?.at(-1));
      expect(args[0]?.at(-1)).not.toBe(args[2]?.at(-1));
      expect(args[1]?.at(-1)).not.toBe(args[2]?.at(-1));

      const status = bridge.getStatus();
      expect(status.upstreamMode).toBe("managed");
      expect(status.upstreams.clear).toMatchObject({
        profile: "clear",
        running: true,
        starting: false,
        args: ["--clear-profile"],
      });
      expect(status.upstreams.light).toMatchObject({
        profile: "light",
        running: true,
        starting: false,
        args: ["--light-profile"],
      });
      expect(status.upstreams.full).toMatchObject({
        profile: "full",
        running: true,
        starting: false,
        args: ["--full-profile"],
      });
      expect(status.upstreams.light.url).not.toBe(status.upstreams.full.url);
      expect(status.upstreams.clear.url).not.toBe(status.upstreams.light.url);
    } finally {
      lightClient.close();
      fullClient.close();
      clearClient.close();
      fallbackClient.close();
    }
  });
});

const FAKE_CODEX_APP_SERVER = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
const argsLogPath = process.env.YEP_FAKE_CODEX_ARGS_LOG;
if (argsLogPath) {
  appendFileSync(argsLogPath, JSON.stringify(args) + "\\n");
}

const listenIndex = args.indexOf("--listen");
if (args[0] !== "app-server" || listenIndex < 0 || !args[listenIndex + 1]) {
  process.exit(2);
}

const listenUrl = new URL(args[listenIndex + 1]);
const server = createServer();
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => {
    ws.send(data, { binary: isBinary });
  });
});

server.listen(Number(listenUrl.port), listenUrl.hostname || "127.0.0.1");

const shutdown = () => {
  wss.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`;

async function readArgsLog(path: string): Promise<string[][]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function waitForArgsLog(path: string, count: number): Promise<void> {
  await waitFor(async () => (await readArgsLog(path)).length >= count);
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("No port assigned"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function connect(
  url: string,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}
