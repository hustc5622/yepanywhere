import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CodexBridgeService } from "../../src/codex-bridge/CodexBridgeService.js";
import { getCodexMcpAppServerArgs } from "../../src/codex/mcp-profile.js";

const CONFIGURED_MCP_SERVERS = ["node_repl", "lark", "web"];

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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const debugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    tempDir = await mkdtemp(join(process.cwd(), ".tmp-codex-bridge-profile-"));
    const codexPath = join(tempDir, "fake-codex.mjs");
    const argsLogPath = join(tempDir, "args.jsonl");
    const sensitiveArg =
      "--config=mcp.token=profile-wire-secret,path=/private/profile.json";
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
      lightUpstreamArgs: [sensitiveArg],
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
        ...getCodexMcpAppServerArgs("clear", ["--clear-profile"]),
        "--listen",
        expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      ]);
      expect(args[1]).toEqual([
        "app-server",
        ...getCodexMcpAppServerArgs("standard", [sensitiveArg]),
        "--listen",
        expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      ]);
      expect(args[2]).toEqual([
        "app-server",
        ...getCodexMcpAppServerArgs("full", ["--full-profile"]),
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
        args: [sensitiveArg],
      });
      expect(status.upstreams.full).toMatchObject({
        profile: "full",
        running: true,
        starting: false,
        args: ["--full-profile"],
      });
      expect(JSON.stringify(status)).toContain("profile-wire-secret");
      expect(JSON.stringify(status)).toContain("/private/profile.json");
      await waitFor(() => debugSpy.mock.calls.length >= 6);
      const ordinaryLogs = JSON.stringify([
        ...logSpy.mock.calls,
        ...debugSpy.mock.calls,
      ]);
      expect(ordinaryLogs).toContain("profile-wire-secret");
      expect(ordinaryLogs).toContain("/private/profile.json");
      expect(ordinaryLogs).not.toContain(codexPath);
      expect(status.upstreams.light.url).not.toBe(status.upstreams.full.url);
      expect(status.upstreams.clear.url).not.toBe(status.upstreams.light.url);

      clearClient.send(JSON.stringify({ method: "initialized" }));
      lightClient.send(JSON.stringify({ method: "initialized" }));
      fullClient.send(JSON.stringify({ method: "initialized" }));

      const clearRequest = await sendAndReceive(clearClient, {
        jsonrpc: "2.0",
        id: 101,
        method: "thread/start",
        params: { config: { preserved: true } },
      });
      const lightRequest = await sendAndReceive(lightClient, {
        jsonrpc: "2.0",
        id: 102,
        method: "thread/start",
        params: {},
      });
      const fullRequest = await sendAndReceive(fullClient, {
        jsonrpc: "2.0",
        id: 103,
        method: "thread/resume",
        params: { threadId: "thread-existing" },
      });
      const forkRequest = await sendAndReceive(lightClient, {
        jsonrpc: "2.0",
        id: 104,
        method: "thread/fork",
        params: { threadId: "thread-existing" },
      });
      expect(clearRequest.params).toMatchObject({
        config: {
          preserved: true,
          mcp_servers: {
            lark: { command: "fake-mcp", enabled: false },
            node_repl: { command: "fake-mcp", enabled: false },
            web: { command: "fake-mcp", enabled: false },
          },
        },
      });
      expect(lightRequest.params).toMatchObject({
        config: {
          mcp_servers: {
            lark: { enabled: true },
            node_repl: { enabled: true },
            web: { enabled: false },
          },
        },
      });
      expect(fullRequest.params).toMatchObject({
        config: {
          mcp_servers: {
            lark: { enabled: true },
            node_repl: { enabled: true },
            web: { enabled: true },
          },
        },
      });
      expect(forkRequest.params).toMatchObject({
        config: {
          mcp_servers: {
            lark: { enabled: true },
            node_repl: { enabled: true },
            web: { enabled: false },
          },
        },
      });

      const batchedRequest = await sendAndReceive(fallbackClient, [
        { method: "initialized" },
        {
          jsonrpc: "2.0",
          id: 105,
          method: "thread/start",
          params: { cwd: "/tmp/batched-codex-project" },
        },
      ]);
      expect(batchedRequest.params).toMatchObject({
        config: {
          mcp_servers: {
            lark: { enabled: true },
            node_repl: { enabled: true },
            web: { enabled: false },
          },
        },
      });

      const compatibilityMessages = receiveMessages(lightClient, 4);
      lightClient.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 106,
          method: "thread/start",
          params: {
            cwd: "/tmp/mcp-startup-compatibility",
            compatibilityTest: true,
          },
        }),
      );
      const [startResponse, compatibilityStatus, larkStatus, nodeStatus] =
        await compatibilityMessages;
      expect(startResponse).toMatchObject({
        id: 106,
        result: { thread: { id: "thread-mcp-startup-compatibility" } },
      });
      expect(compatibilityStatus).toEqual({
        method: "mcpServer/startupStatus/updated",
        params: {
          threadId: "thread-mcp-startup-compatibility",
          name: "web",
          status: "ready",
          error: null,
          failureReason: null,
        },
      });
      expect([larkStatus, nodeStatus]).toEqual([
        expect.objectContaining({
          method: "mcpServer/startupStatus/updated",
          params: expect.objectContaining({ name: "lark", status: "ready" }),
        }),
        expect.objectContaining({
          method: "mcpServer/startupStatus/updated",
          params: expect.objectContaining({
            name: "node_repl",
            status: "ready",
          }),
        }),
      ]);
      await waitFor(
        () => bridge?.getStatus().recentMcpStartupEvents.length === 2,
      );
      expect(
        bridge.getStatus().recentMcpStartupEvents.map((event) => event.name),
      ).toEqual(["lark", "node_repl"]);
    } finally {
      lightClient.close();
      fullClient.close();
      clearClient.close();
      fallbackClient.close();
      logSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });
});

const FAKE_CODEX_APP_SERVER = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
const argsLogPath = process.env.YEP_FAKE_CODEX_ARGS_LOG;
process.stdout.write("diagnostic token=profile-wire-secret path=/private/profile.json\\n");
process.stderr.write("permission denied at /private/profile.json secret=profile-wire-secret\\n");
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
  let initialized = false;
  const handle = (message) => {
    if (message.method === "initialized") {
      initialized = true;
      return;
    }
    if (message.method === "config/read") {
      if (!initialized) {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32600, message: "Not initialized" },
        }));
        return;
      }
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          config: {
            mcp_servers: Object.fromEntries(
              ${JSON.stringify(CONFIGURED_MCP_SERVERS)}.map((name) => [
                name,
                { command: "fake-mcp", args: [name], enabled: true },
              ]),
            ),
          },
          origins: {},
        },
      }));
      return;
    }
    if (message.method === "thread/read") {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          thread: {
            id: message.params.threadId,
            cwd: "/tmp/fake-codex-project",
          },
        },
      }));
      return;
    }
    if (
      ["thread/start", "thread/resume", "thread/fork"].includes(message.method) &&
      message.params?.compatibilityTest === true
    ) {
      const threadId = "thread-mcp-startup-compatibility";
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          thread: {
            id: threadId,
            cwd: message.params.cwd ?? "/tmp/fake-codex-project",
          },
        },
      }));
      for (const name of ["lark", "node_repl"]) {
        ws.send(JSON.stringify({
          method: "mcpServer/startupStatus/updated",
          params: {
            threadId,
            name,
            status: "ready",
            error: null,
            failureReason: null,
          },
        }));
      }
      return;
    }
    ws.send(JSON.stringify(message));
  };
  ws.on("message", (data) => {
    const envelope = JSON.parse(data.toString());
    if (Array.isArray(envelope)) {
      for (const message of envelope) handle(message);
      return;
    }
    handle(envelope);
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

async function sendAndReceive(
  ws: WebSocket,
  message: unknown,
): Promise<{ params?: unknown }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for echoed bridge request")),
      5000,
    );
    ws.once("message", (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()) as { params?: unknown });
    });
    ws.send(JSON.stringify(message));
  });
}

async function receiveMessages(
  ws: WebSocket,
  count: number,
): Promise<Record<string, unknown>[]> {
  return await new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${count} bridge messages`));
    }, 5000);
    const onMessage = (data: WebSocket.RawData) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (messages.length < count) return;
      clearTimeout(timeout);
      ws.off("message", onMessage);
      resolve(messages);
    };
    ws.on("message", onMessage);
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
