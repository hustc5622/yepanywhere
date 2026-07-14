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
            multiple: true,
            custom: false,
            options: [
              { label: "放宽列表规则", description: "允许深层 md" },
              { label: "补充测试", description: "覆盖嵌套 fence" },
            ],
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
            id: "question-0",
            question: "怎么修?",
            header: "修复方式",
            multiSelect: true,
            custom: false,
          },
        ],
      },
    });

    await expect(
      bridge.respondToInput("ses_1", "question-1", "approve", {
        "question-0": ["放宽列表规则", "补充测试"],
      }),
    ).resolves.toBe(true);
    expect(replyBody).toEqual({
      answers: [["放宽列表规则", "补充测试"]],
    });
  });

  it("rejects OpenCode questions without a request body", async () => {
    let rejectBody = "not received";
    let rejectContentType: string | undefined;
    const opencodeServer = createServer((req, res) => {
      if (
        req.method === "POST" &&
        req.url === "/question/question-deny/reject"
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on("end", () => {
          rejectBody = Buffer.concat(chunks).toString("utf-8");
          rejectContentType = req.headers["content-type"];
          res.writeHead(200, { "content-type": "application/json" });
          res.end("true");
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
        id: "question-deny",
        sessionID: "ses_deny",
        questions: [{ question: "Continue?", options: [] }],
      },
    });

    await expect(
      bridge.respondToInput("ses_deny", "question-deny", "deny"),
    ).resolves.toBe(true);
    expect(rejectBody).toBe("");
    expect(rejectContentType).toBeUndefined();
  });

  it("does not consume a newer question or send duplicate replies", async () => {
    let requestCount = 0;
    let markRequestStarted: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let releaseResponse: () => void = () => undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const opencodeServer = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/question/question-old/reply") {
        requestCount += 1;
        req.resume();
        markRequestStarted();
        await responseReleased;
        const handleOpenCodeEvent = (
          bridge as unknown as {
            handleOpenCodeEvent: (event: unknown) => void;
          }
        ).handleOpenCodeEvent.bind(bridge);
        handleOpenCodeEvent({
          type: "question.replied",
          properties: {
            sessionID: "ses_race",
            requestID: "question-old",
          },
        });
        handleOpenCodeEvent({
          type: "question.asked",
          properties: {
            id: "question-new",
            sessionID: "ses_race",
            questions: [{ question: "Second question", options: [] }],
          },
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("true");
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
        id: "question-old",
        sessionID: "ses_race",
        questions: [{ question: "First question", options: [] }],
      },
    });

    const firstResponse = bridge.respondToInput(
      "ses_race",
      "question-old",
      "approve",
      { "question-0": "First answer" },
    );
    await requestStarted;
    const duplicateResponse = bridge.respondToInput(
      "ses_race",
      "question-old",
      "approve",
      { "question-0": "Duplicate answer" },
    );
    expect(requestCount).toBe(1);
    releaseResponse();

    await expect(
      Promise.all([firstResponse, duplicateResponse]),
    ).resolves.toEqual([true, true]);
    expect(requestCount).toBe(1);
    expect(bridge.getPendingInputRequest("ses_race")).toMatchObject({
      id: "question-new",
      type: "question",
      prompt: "Second question",
    });
    expect(bridge.listSessions()[0]).toMatchObject({
      activity: "waiting-input",
      pendingInputType: "user-question",
    });

    (
      bridge as unknown as {
        handleOpenCodeEvent: (event: unknown) => void;
      }
    ).handleOpenCodeEvent({
      type: "question.replied",
      properties: {
        sessionID: "ses_race",
        requestID: "question-old",
      },
    });
    expect(bridge.getPendingInputRequest("ses_race")?.id).toBe("question-new");
    expect(bridge.listSessions()[0]).toMatchObject({
      activity: "waiting-input",
      pendingInputType: "user-question",
    });
  });

  it("keeps a failed question response pending so it can be retried", async () => {
    let requestCount = 0;
    const opencodeServer = createServer((req, res) => {
      if (
        req.method === "POST" &&
        req.url === "/question/question-retry/reply"
      ) {
        requestCount += 1;
        req.resume();
        if (requestCount === 1) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temporary failure" }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("true");
        }
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
        id: "question-retry",
        sessionID: "ses_retry",
        questions: [{ question: "Retry?", options: [] }],
      },
    });

    await expect(
      bridge.respondToInput("ses_retry", "question-retry", "approve", {
        "question-0": "Yes",
      }),
    ).rejects.toThrow("temporary failure");
    expect(bridge.getPendingInputRequest("ses_retry")?.id).toBe(
      "question-retry",
    );
    expect(bridge.listSessions()[0]).toMatchObject({
      activity: "waiting-input",
      pendingInputType: "user-question",
    });

    await expect(
      bridge.respondToInput("ses_retry", "question-retry", "approve", {
        "question-0": "Yes",
      }),
    ).resolves.toBe(true);
    expect(requestCount).toBe(2);
    expect(bridge.getPendingInputRequest("ses_retry")).toBeNull();
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

  it("preserves upstream timestamps across repeated runtime status updates", () => {
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
    });
    const handleEvent = (
      bridge as unknown as {
        handleOpenCodeEvent: (event: unknown) => void;
      }
    ).handleOpenCodeEvent.bind(bridge);

    handleEvent({
      type: "session.created",
      properties: {
        sessionID: "ses_timestamp",
        info: {
          title: "Timestamped session",
          time: { updated: 1_783_673_406_957 },
        },
      },
    });
    const createdAt = bridge.listSessions()[0]?.updatedAt;
    expect(createdAt).toBe("2026-07-10T08:50:06.957Z");

    handleEvent({
      type: "session.status",
      properties: {
        sessionID: "ses_timestamp",
        status: { type: "running" },
      },
    });
    handleEvent({
      type: "session.status",
      properties: {
        sessionID: "ses_timestamp",
        status: { type: "running" },
      },
    });

    expect(bridge.listSessions()[0]?.updatedAt).toBe(createdAt);

    handleEvent({
      type: "session.updated",
      properties: {
        sessionID: "ses_timestamp",
        info: { time: { updated: 1_783_673_500_000 } },
      },
    });

    expect(bridge.listSessions()[0]?.updatedAt).toBe(
      "2026-07-10T08:51:40.000Z",
    );
  });

  it("preserves the prior title for titleless and boilerplate title events", () => {
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
    });
    const handleEvent = (
      bridge as unknown as {
        handleOpenCodeEvent: (event: unknown) => void;
      }
    ).handleOpenCodeEvent.bind(bridge);

    handleEvent({
      type: "session.created",
      properties: {
        sessionID: "ses_title",
        info: { title: "New session - 2026-07-10T08:38:04.689Z" },
      },
    });
    handleEvent({
      type: "message.updated",
      properties: { sessionID: "ses_title", info: {} },
    });
    handleEvent({
      type: "session.updated",
      properties: {
        sessionID: "ses_title",
        info: { title: "Here's a title for this conversation:" },
      },
    });

    expect(bridge.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ses_title",
          title: "New session - 2026-07-10T08:38:04.689Z",
        }),
      ]),
    );

    handleEvent({
      type: "session.updated",
      properties: {
        sessionID: "ses_title",
        info: { title: "Fix OpenCode session title fallback" },
      },
    });

    expect(bridge.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ses_title",
          title: "Fix OpenCode session title fallback",
        }),
      ]),
    );
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

  it("buffers the OpenAI-compatible SSE gateway route for managed OpenCode", async () => {
    let forwardedBody = "";
    let forwardedAuthorization: string | undefined;
    let forwardedSubModule: string | undefined;
    const upstream = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/global/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("\n");
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        forwardedBody = Buffer.concat(chunks).toString("utf8");
        forwardedAuthorization = req.headers.authorization;
        forwardedSubModule = req.headers["x-sub-module"];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const upstreamUrl = await listen(upstream);
    const bridgePort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: upstreamUrl,
      gatewayConfig: {
        apiKey: "test-key",
        apiBase: `${upstreamUrl}/v1`,
        subModule: "claude-code-internal",
      },
    });

    await bridge.start();
    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/gateway/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer forwarded-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "glm-5.2", stream: true }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
    );
    expect(forwardedAuthorization).toBe("Bearer forwarded-key");
    expect(forwardedSubModule).toBe("claude-code-internal");
    expect(JSON.parse(forwardedBody)).toEqual({
      model: "glm-5.2",
      stream: true,
    });
    await bridge.shutdown();
  });

  it("forwards the selected OpenCode reasoning variant to the Yep API", async () => {
    let forwardedBody: Record<string, unknown> | undefined;
    const upstream = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/global/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("\n");
        return;
      }
      if (req.method === "POST" && req.url?.includes("/sessions")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        forwardedBody = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "ses_variant",
            processId: "proc_variant",
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const upstreamUrl = await listen(upstream);
    const bridgePort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      serverUrl: upstreamUrl,
      opencodeServerUrl: upstreamUrl,
    });

    await bridge.start();
    const response = await fetch(`http://127.0.0.1:${bridgePort}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        message: "think deeply",
        reasoningEffort: "max",
      }),
    });

    expect(response.status).toBe(200);
    expect(forwardedBody).toMatchObject({
      message: "think deeply",
      provider: "opencode",
      reasoningEffort: "max",
    });
    await bridge.shutdown();
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
