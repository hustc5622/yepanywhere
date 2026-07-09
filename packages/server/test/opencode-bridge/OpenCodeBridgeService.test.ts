import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeBridgeService } from "../../src/opencode-bridge/OpenCodeBridgeService.js";

const servers: Array<{ close: () => void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected TCP address"));
        return;
      }
      servers.push(server);
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close();
      if (!address || typeof address === "string") {
        reject(new Error("Expected TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function writeFakeOpenCodeExecutable(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yep-opencode-bridge-test-"));
  tempDirs.push(dir);
  const executable = join(dir, "opencode");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const server = http.createServer((req, res) => {
  if (req.url === "/global/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ healthy: true, version: "test" }));
    return;
  }
  if (req.url === "/global/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    res.write("\\n");
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

describe("OpenCodeBridgeService", () => {
  it("normalizes OpenCode question events and replies with OpenCode answers", async () => {
    let replyBody: unknown = null;
    const opencodeServer = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/question/question-1/reply") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on("end", () => {
          replyBody = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const opencodeServerUrl = await listen(opencodeServer);
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl,
    });

    (
      bridge as unknown as {
        handleOpenCodeEvent: (event: unknown) => void;
      }
    ).handleOpenCodeEvent({
      type: "question.asked",
      properties: {
        id: "question-1",
        sessionID: "ses_1",
        questions: [
          {
            question: "怎么修?",
            header: "修复方式",
            multiple: false,
            options: [{ label: "放宽列表规则", description: "允许深层 md" }],
          },
        ],
      },
    });

    const request = bridge.getPendingInputRequest("ses_1");
    expect(request).toMatchObject({
      id: "question-1",
      sessionId: "ses_1",
      type: "question",
      toolName: "AskUserQuestion",
      source: "opencode-bridge",
      toolInput: {
        questions: [
          {
            question: "怎么修?",
            header: "修复方式",
            multiSelect: false,
          },
        ],
      },
    });

    await expect(
      bridge.respondToInput("ses_1", "question-1", "approve", {
        "怎么修?": "放宽列表规则",
      }),
    ).resolves.toBe(true);
    expect(replyBody).toEqual({ answers: [["放宽列表规则"]] });
  });

  it("unwraps OpenCode global event envelopes", async () => {
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
    });

    (
      bridge as unknown as {
        handleSseLine: (line: string) => void;
      }
    ).handleSseLine(
      `data: ${JSON.stringify({
        directory: "/tmp/project",
        payload: {
          id: "evt_1",
          type: "question.asked",
          properties: {
            requestID: "question-2",
            sessionID: "ses_2",
            questions: [
              {
                question: "选哪个?",
                header: "选择",
                options: [{ label: "A", description: "" }],
              },
            ],
          },
        },
      })}`,
    );

    expect(bridge.getPendingInputRequest("ses_2")).toMatchObject({
      id: "question-2",
      sessionId: "ses_2",
      source: "opencode-bridge",
    });
  });

  it("syncs existing OpenCode questions from the live question endpoint", async () => {
    const opencodeServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/question") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: "que_live",
              sessionID: "ses_live",
              questions: [
                {
                  question: "互动题类型?",
                  header: "类型",
                  multiple: false,
                  options: [{ label: "编程练习题", description: "可运行验证" }],
                },
              ],
              tool: {
                messageID: "msg_1",
                callID: "call_1",
              },
            },
          ]),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const opencodeServerUrl = await listen(opencodeServer);
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl,
    });

    await (
      bridge as unknown as {
        syncOpenCodePendingQuestions: () => Promise<void>;
      }
    ).syncOpenCodePendingQuestions();

    expect(bridge.getPendingInputRequest("ses_live")).toMatchObject({
      id: "que_live",
      sessionId: "ses_live",
      type: "question",
      source: "opencode-bridge",
      toolInput: {
        questions: [
          {
            question: "互动题类型?",
            header: "类型",
            multiSelect: false,
          },
        ],
      },
    });
  });

  it("updates activity from OpenCode session status events", async () => {
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
    });

    (
      bridge as unknown as {
        handleOpenCodeEvent: (event: unknown) => void;
      }
    ).handleOpenCodeEvent({
      type: "session.status",
      properties: {
        sessionID: "ses_status",
        status: { type: "running" },
      },
    });
    expect(bridge.isSessionActive("ses_status")).toBe(true);

    (
      bridge as unknown as {
        handleOpenCodeEvent: (event: unknown) => void;
      }
    ).handleOpenCodeEvent({
      type: "session.status",
      properties: {
        sessionID: "ses_status",
        status: { type: "idle" },
      },
    });
    expect(bridge.isSessionActive("ses_status")).toBe(false);
  });

  it("reconciles cached sessions with the OpenCode active status endpoint", async () => {
    const opencodeServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/session/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.method === "GET" && req.url === "/question") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const opencodeServerUrl = await listen(opencodeServer);
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl,
    });

    (
      bridge as unknown as {
        handleOpenCodeEvent: (event: unknown) => void;
      }
    ).handleOpenCodeEvent({
      type: "session.status",
      properties: {
        sessionID: "ses_stale",
        status: { type: "running" },
      },
    });
    expect(bridge.isSessionActive("ses_stale")).toBe(true);

    await (
      bridge as unknown as {
        syncOpenCodeRuntimeState: () => Promise<void>;
      }
    ).syncOpenCodeRuntimeState();

    expect(bridge.isSessionActive("ses_stale")).toBe(false);
    expect(bridge.listSessions()[0]).toMatchObject({
      id: "ses_stale",
      activity: "idle",
      active: false,
    });
  });

  it("starts and owns a managed OpenCode server when no external URL is configured", async () => {
    const opencodePath = await writeFakeOpenCodeExecutable();
    const startPort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodePath,
      opencodeStartPort: startPort,
    });

    const url = await (
      bridge as unknown as {
        ensureOpenCodeServerUrl: () => Promise<string>;
      }
    ).ensureOpenCodeServerUrl();

    expect(url).toBe(`http://127.0.0.1:${startPort}`);
    expect(bridge.getStatus()).toMatchObject({
      opencodeServerMode: "managed",
      opencodeServerUrl: `http://127.0.0.1:${startPort}`,
      opencodeServerRunning: true,
    });
    expect(bridge.getStatus().opencodeServerPid).toEqual(expect.any(Number));

    await bridge.shutdown();
    expect(bridge.getStatus()).toMatchObject({
      opencodeServerRunning: false,
      opencodeServerPid: null,
    });
  });

  it("reports a clear managed OpenCode start error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yep-opencode-bridge-test-"));
    tempDirs.push(dir);
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodePath: join(dir, "missing-opencode"),
      opencodeStartPort: await getFreePort(),
      startupTimeoutMs: 200,
    });

    await expect(
      (
        bridge as unknown as {
          ensureOpenCodeServerUrl: () => Promise<string>;
        }
      ).ensureOpenCodeServerUrl(),
    ).rejects.toThrow("Failed to start OpenCode server");
    expect(bridge.getStatus()).toMatchObject({
      opencodeServerMode: "managed",
      opencodeServerRunning: false,
      opencodeServerPid: null,
    });
  });
});
