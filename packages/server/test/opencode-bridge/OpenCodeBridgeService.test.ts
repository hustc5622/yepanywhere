import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllEnvs();
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

function requestUrl(req: { url?: string }): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
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
  if (req.url === "/test/env") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      llmApiKey: process.env.LLM_API_KEY ?? null,
      llmApiBase: process.env.LLM_API_BASE ?? null,
      llmSubModule: process.env.LLM_SUB_MODULE ?? null,
      managedApiKey: process.env.YEP_OPENCODE_LLM_API_KEY ?? null,
      managedMarker: process.env.YEP_MANAGED_OPENCODE ?? null,
      managedServerPort: process.env.YEP_MANAGED_OPENCODE_SERVER_PORT ?? null
    }));
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
      if (
        req.method === "POST" &&
        requestUrl(req).pathname === "/question/question-1/reply"
      ) {
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
      bridge.respondToInput("ses_1", "question-1", "approve"),
    ).resolves.toBe(false);
    expect(bridge.getPendingInputRequest("ses_1")?.id).toBe("question-1");
    expect(replyBody).toBeNull();

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
        requestUrl(req).pathname === "/question/question-deny/reject"
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

  it("routes v2 permission and question replies to session-scoped APIs", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const opencodeServer = createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        requests.push({
          url: requestUrl(req).pathname,
          body: text ? JSON.parse(text) : undefined,
        });
        res.writeHead(204);
        res.end();
      });
    });
    const opencodeServerUrl = await listen(opencodeServer);
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl,
    });
    const handleEvent = (
      bridge as unknown as {
        handleOpenCodeEvent: (event: unknown) => void;
      }
    ).handleOpenCodeEvent.bind(bridge);

    handleEvent({
      type: "permission.v2.asked",
      properties: {
        id: "per_v2",
        sessionID: "ses/v2",
        action: "write",
        resources: ["src/app.ts"],
        save: ["*"],
      },
    });
    expect(bridge.getPendingInputRequest("ses/v2")).toMatchObject({
      prompt: expect.stringContaining("write src/app.ts"),
      options: ["Approve", "Approve always", "Deny"],
      toolInput: {
        approvalKind: "opencode_permission",
        approvalProtocol: "v2",
        availableDecisions: ["once", "always", "reject"],
        persistentPatterns: ["*"],
      },
    });
    await expect(
      bridge.respondToInput("ses/v2", "per_v2", "approve_always"),
    ).resolves.toBe(true);

    handleEvent({
      type: "question.v2.asked",
      properties: {
        id: "que_v2",
        sessionID: "ses/v2",
        questions: [{ question: "Continue?", options: [] }],
      },
    });
    await expect(
      bridge.respondToInput("ses/v2", "que_v2", "deny"),
    ).resolves.toBe(true);

    expect(requests).toEqual([
      {
        url: "/api/session/ses%2Fv2/permission/per_v2/reply",
        body: { reply: "always" },
      },
      {
        url: "/api/session/ses%2Fv2/question/que_v2/reject",
        body: undefined,
      },
    ]);
  });

  it("keeps a permission request waiting while OpenCode still reports the turn as busy", async () => {
    const opencodeServer = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (requestUrl(req).pathname === "/session/status") {
        res.end(JSON.stringify({ ses_pending: { type: "busy" } }));
        return;
      }
      if (requestUrl(req).pathname === "/question") {
        res.end("[]");
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    const opencodeServerUrl = await listen(opencodeServer);
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl,
    });
    const internals = bridge as unknown as {
      handleOpenCodeEvent: (event: unknown) => void;
      syncOpenCodeRuntimeState: () => Promise<void>;
    };

    internals.handleOpenCodeEvent({
      type: "permission.asked",
      properties: {
        id: "per_pending",
        sessionID: "ses_pending",
        permission: "external_directory",
        patterns: ["/tmp/*"],
        always: ["/tmp/*"],
      },
    });
    await internals.syncOpenCodeRuntimeState();

    expect(bridge.getSessionView("ses_pending")).toMatchObject({
      activity: "waiting-input",
      pendingInputType: "tool-approval",
      session: {
        activity: "waiting-input",
        pendingInputType: "tool-approval",
      },
    });
    expect(bridge.getPendingInputRequest("ses_pending")).toMatchObject({
      id: "per_pending",
    });

    internals.handleOpenCodeEvent({
      type: "session.error",
      properties: {
        sessionID: "ses_pending",
        error: { data: { message: "provider stopped" } },
      },
    });
    expect(bridge.getSessionView("ses_pending")).toMatchObject({
      activity: "idle",
      session: { activity: "idle", lastErrorMessage: "provider stopped" },
    });
    expect(bridge.getPendingInputRequest("ses_pending")).toBeNull();
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
      if (
        req.method === "POST" &&
        requestUrl(req).pathname === "/question/question-old/reply"
      ) {
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
        requestUrl(req).pathname === "/question/question-retry/reply"
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
    expect(bridge.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ses_2",
          projectPath: "/tmp/project",
        }),
      ]),
    );
  });

  it("syncs existing OpenCode questions from the live question endpoint", async () => {
    const opencodeServer = createServer((req, res) => {
      if (req.method === "GET" && requestUrl(req).pathname === "/question") {
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

  it("reconciles pending questions independently for each OpenCode directory", async () => {
    const requests: Array<{ directory: string | null; header?: string }> = [];
    const opencodeServer = createServer((req, res) => {
      const url = requestUrl(req);
      if (req.method === "GET" && url.pathname === "/question") {
        const directory = url.searchParams.get("directory");
        requests.push({
          directory,
          header: req.headers["x-opencode-directory"] as string | undefined,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            directory === "/repo/a"
              ? [
                  {
                    id: "que_a",
                    sessionID: "ses_a",
                    questions: [{ question: "A?", options: [] }],
                  },
                ]
              : [],
          ),
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
    const handleEvent = (
      bridge as unknown as {
        handleOpenCodeEvent: (
          event: unknown,
          origin?: { directory?: string },
        ) => void;
      }
    ).handleOpenCodeEvent.bind(bridge);

    handleEvent(
      {
        type: "question.asked",
        properties: {
          id: "que_a",
          sessionID: "ses_a",
          questions: [{ question: "A?", options: [] }],
        },
      },
      { directory: "/repo/a" },
    );
    handleEvent(
      {
        type: "question.asked",
        properties: {
          id: "que_b",
          sessionID: "ses_b",
          questions: [{ question: "B?", options: [] }],
        },
      },
      { directory: "/repo/b" },
    );

    await (
      bridge as unknown as {
        syncOpenCodePendingQuestions: () => Promise<void>;
      }
    ).syncOpenCodePendingQuestions();

    expect(bridge.getPendingInputRequest("ses_a")?.id).toBe("que_a");
    expect(bridge.getPendingInputRequest("ses_b")).toBeNull();
    expect(requests).toEqual(
      expect.arrayContaining([
        { directory: "/repo/a", header: "/repo/a" },
        { directory: "/repo/b", header: "/repo/b" },
      ]),
    );
  });

  it("reconciles stale permissions against the live permission endpoint", async () => {
    const opencodeServer = createServer((req, res) => {
      if (req.method === "GET" && requestUrl(req).pathname === "/permission") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: "perm_live",
              sessionID: "ses_perm_live",
              permission: "bash",
              patterns: ["npm *"],
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
    const handleEvent = (
      bridge as unknown as {
        handleOpenCodeEvent: (
          event: unknown,
          origin?: { instanceId: string; directory?: string },
        ) => void;
      }
    ).handleOpenCodeEvent.bind(bridge);

    // Stale permission: answered in the TUI while our SSE stream was down.
    handleEvent({
      type: "permission.asked",
      properties: {
        sessionID: "ses_perm_stale",
        id: "perm_stale",
        permission: "edit",
      },
    });
    // External-instance permission: invisible to the managed snapshot, must survive.
    handleEvent(
      {
        type: "permission.asked",
        properties: {
          sessionID: "ses_perm_ext",
          id: "perm_ext",
          permission: "bash",
        },
      },
      { instanceId: "ext_tui_1", directory: "/tmp/ext" },
    );
    expect(bridge.getPendingInputRequest("ses_perm_stale")).not.toBeNull();
    expect(bridge.getPendingInputRequest("ses_perm_ext")).not.toBeNull();

    await (
      bridge as unknown as {
        syncOpenCodePendingPermissions: () => Promise<void>;
      }
    ).syncOpenCodePendingPermissions();

    // Live permission discovered from the snapshot.
    expect(bridge.getPendingInputRequest("ses_perm_live")).toMatchObject({
      id: "perm_live",
      type: "tool-approval",
    });
    // Stale managed permission cleared; session no longer waiting.
    expect(bridge.getPendingInputRequest("ses_perm_stale")).toBeNull();
    // External-instance permission untouched.
    expect(bridge.getPendingInputRequest("ses_perm_ext")).not.toBeNull();
  });

  it("treats a missing /permission route as nothing to reconcile", async () => {
    const opencodeServer = createServer((_req, res) => {
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
    const handleEvent = (
      bridge as unknown as {
        handleOpenCodeEvent: (event: unknown) => void;
      }
    ).handleOpenCodeEvent.bind(bridge);

    handleEvent({
      type: "permission.asked",
      properties: {
        sessionID: "ses_old_server",
        id: "perm_1",
        permission: "bash",
      },
    });

    // Older OpenCode servers 404 on /permission; the pending must survive.
    await (
      bridge as unknown as {
        syncOpenCodePendingPermissions: () => Promise<void>;
      }
    ).syncOpenCodePendingPermissions();
    expect(bridge.getPendingInputRequest("ses_old_server")).not.toBeNull();
  });

  it("does not sweep external-instance questions absent from the managed snapshot", async () => {
    // Managed server reports no pending questions.
    const opencodeServer = createServer((req, res) => {
      if (req.method === "GET" && requestUrl(req).pathname === "/question") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
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
    const handleEvent = (
      bridge as unknown as {
        handleOpenCodeEvent: (
          event: unknown,
          origin?: { instanceId: string; directory?: string },
        ) => void;
      }
    ).handleOpenCodeEvent.bind(bridge);

    // Question from an external TUI (forwarder plugin), invisible to the
    // managed server's /question endpoint.
    handleEvent(
      {
        type: "question.asked",
        properties: {
          sessionID: "ses_ext",
          id: "que_ext",
          questions: [
            {
              question: "External question?",
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        },
      },
      { instanceId: "ext_tui_1", directory: "/tmp/ext" },
    );
    expect(bridge.getPendingInputRequest("ses_ext")).not.toBeNull();

    // Managed-server question that IS stale and must still be swept.
    handleEvent({
      type: "question.asked",
      properties: {
        sessionID: "ses_managed",
        id: "que_stale",
        questions: [{ question: "Stale?", options: [{ label: "Ok" }] }],
      },
    });
    expect(bridge.getPendingInputRequest("ses_managed")).not.toBeNull();

    await (
      bridge as unknown as {
        syncOpenCodePendingQuestions: () => Promise<void>;
      }
    ).syncOpenCodePendingQuestions();

    // External question survives; managed stale question is cleared.
    expect(bridge.getPendingInputRequest("ses_ext")).not.toBeNull();
    expect(bridge.getPendingInputRequest("ses_managed")).toBeNull();
  });

  it("keeps an isolated idle status as an active completion candidate", () => {
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
    expect(bridge.isSessionActive("ses_status")).toBe(true);
    expect(bridge.getSessionView("ses_status")).toMatchObject({
      activity: "in-turn",
      session: { activity: "in-turn" },
    });
  });

  it("suppresses idle while directory-scoped status is busy, then confirms stable idle", async () => {
    let busy = true;
    const statusRequests: Array<{
      directory: string | null;
      header?: string;
    }> = [];
    const opencodeServer = createServer((req, res) => {
      const url = requestUrl(req);
      if (req.method === "GET" && url.pathname === "/session/status") {
        statusRequests.push({
          directory: url.searchParams.get("directory"),
          header: req.headers["x-opencode-directory"] as string | undefined,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(busy ? { ses_confirm: { type: "busy" } } : {}));
        return;
      }
      if (
        req.method === "GET" &&
        url.pathname === "/session/ses_confirm/message"
      ) {
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
      lifecycle: { quietWindowMs: 0 },
    });
    const internals = bridge as unknown as {
      handleOpenCodeEvent: (
        event: unknown,
        origin?: { directory?: string },
      ) => void;
      reconcileOpenCodeLifecycle: (sessionId: string) => Promise<void>;
    };
    const origin = { directory: "/repo/confirm" };

    internals.handleOpenCodeEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "ses_confirm",
          status: { type: "busy" },
        },
      },
      origin,
    );
    internals.handleOpenCodeEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "ses_confirm",
          status: { type: "idle" },
        },
      },
      origin,
    );
    await internals.reconcileOpenCodeLifecycle("ses_confirm");
    expect(bridge.isSessionActive("ses_confirm")).toBe(true);

    busy = false;
    internals.handleOpenCodeEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "ses_confirm",
          status: { type: "idle" },
        },
      },
      origin,
    );
    await internals.reconcileOpenCodeLifecycle("ses_confirm");

    expect(bridge.isSessionActive("ses_confirm")).toBe(false);
    expect(bridge.listSessions()[0]).toMatchObject({
      id: "ses_confirm",
      activity: "idle",
      lastTurnStatus: "completed",
    });
    expect(statusRequests).toEqual([
      { directory: "/repo/confirm", header: "/repo/confirm" },
      { directory: "/repo/confirm", header: "/repo/confirm" },
    ]);
  });

  it("projects a completed finish=unknown response as completed", async () => {
    const opencodeServer = createServer((req, res) => {
      const url = requestUrl(req);
      if (req.method === "GET" && url.pathname === "/session/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (
        req.method === "GET" &&
        url.pathname === "/session/ses_unknown/message"
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              info: {
                id: "msg_unknown",
                sessionID: "ses_unknown",
                role: "assistant",
                finish: "unknown",
                time: { completed: Date.now() },
              },
              parts: [],
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
      lifecycle: { quietWindowMs: 0 },
    });
    const internals = bridge as unknown as {
      handleOpenCodeEvent: (event: unknown) => void;
      reconcileOpenCodeLifecycle: (sessionId: string) => Promise<void>;
    };

    internals.handleOpenCodeEvent({
      type: "session.status",
      properties: {
        sessionID: "ses_unknown",
        status: { type: "busy" },
      },
    });
    internals.handleOpenCodeEvent({
      type: "session.status",
      properties: {
        sessionID: "ses_unknown",
        status: { type: "idle" },
      },
    });
    await internals.reconcileOpenCodeLifecycle("ses_unknown");

    expect(bridge.isSessionActive("ses_unknown")).toBe(false);
    expect(
      bridge.listSessions().find((item) => item.id === "ses_unknown"),
    ).toMatchObject({
      activity: "idle",
      lastTurnStatus: "completed",
    });
    expect(
      bridge.listSessions().find((item) => item.id === "ses_unknown")
        ?.lastErrorMessage,
    ).toBeUndefined();
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

  it("rejects generic provider titles without overwriting a usable title", () => {
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

    expect(bridge.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ses_title",
          title: null,
        }),
      ]),
    );

    handleEvent({
      type: "session.updated",
      properties: {
        sessionID: "ses_title",
        info: { title: "Benchmark Run #58 失败模式分析" },
      },
    });
    handleEvent({
      type: "message.updated",
      properties: { sessionID: "ses_title", info: {} },
    });

    for (const title of [
      "New session",
      "Yep Anywhere Session",
      "Here's a title for this conversation:",
      "Based on the conversation, here are some title suggestions:",
      "根据这个对话的内容，我为其生成的标题是：",
      "以下是标题：",
      "对话标题",
      "建议的标题",
      "## 对话标题",
      "## 建议的标题",
    ]) {
      handleEvent({
        type: "session.updated",
        properties: {
          sessionID: "ses_title",
          info: { title },
        },
      });
    }

    expect(bridge.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ses_title",
          title: "Benchmark Run #58 失败模式分析",
        }),
      ]),
    );

    handleEvent({
      type: "session.updated",
      properties: {
        sessionID: "ses_title",
        info: { title: "修复 OpenCode 标题生成漂移" },
      },
    });

    expect(bridge.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ses_title",
          title: "修复 OpenCode 标题生成漂移",
        }),
      ]),
    );
  });

  it("reconciles cached sessions with the OpenCode active status endpoint", async () => {
    const opencodeServer = createServer((req, res) => {
      if (
        req.method === "GET" &&
        requestUrl(req).pathname === "/session/status"
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.method === "GET" && requestUrl(req).pathname === "/question") {
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
      lifecycle: { quietWindowMs: 0 },
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

    const internals = bridge as unknown as {
      syncOpenCodeRuntimeState: () => Promise<void>;
    };
    await internals.syncOpenCodeRuntimeState();
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

  it("coalesces repeated bridge reads and skips settled directories", async () => {
    const statusDirectories: string[] = [];
    const opencodeServer = createServer((req, res) => {
      const url = requestUrl(req);
      if (req.method === "GET" && url.pathname === "/global/event") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write("\n");
        return;
      }
      if (req.method === "GET" && url.pathname === "/session/status") {
        const directory = url.searchParams.get("directory") ?? "";
        statusDirectories.push(directory);
        res.writeHead(200, { "content-type": "application/json" });
        // Only the busy directory reports an active session; reporting it for
        // every directory would rewrite the session's attributed cwd.
        res.end(
          JSON.stringify(
            directory === "/repo/busy" ? { ses_busy: { type: "busy" } } : {},
          ),
        );
        return;
      }
      if (
        req.method === "GET" &&
        (url.pathname === "/question" || url.pathname === "/permission")
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const opencodeServerUrl = await listen(opencodeServer);
    const bridgePort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl,
      lifecycle: { reconcileIntervalMs: 10_000 },
    });
    await bridge.start();
    const base = `http://127.0.0.1:${bridgePort}`;
    const internals = bridge as unknown as {
      handleOpenCodeEvent: (
        event: unknown,
        origin?: { directory?: string },
      ) => void;
    };

    try {
      internals.handleOpenCodeEvent(
        {
          type: "session.updated",
          properties: { sessionID: "ses_settled", info: { title: "settled" } },
        },
        { directory: "/repo/settled" },
      );
      internals.handleOpenCodeEvent(
        {
          type: "session.status",
          properties: { sessionID: "ses_busy", status: { type: "busy" } },
        },
        { directory: "/repo/busy" },
      );

      // Let the startup reconciliation triggered by /global/event settle so
      // its requests are not attributed to the measured loop below.
      await fetch(`${base}/session-views`);
      for (let stable = 0; stable < 3; ) {
        const before = statusDirectories.length;
        await new Promise((resolve) => setTimeout(resolve, 20));
        stable = statusDirectories.length === before ? stable + 1 : 0;
      }
      statusDirectories.length = 0;

      const startedAt = Date.now();
      for (let index = 0; index < 20; index += 1) {
        const response = await fetch(`${base}/session-views`);
        expect(response.status).toBe(200);
      }
      const elapsedMs = Date.now() - startedAt;

      // Unthrottled, 20 reads x 3 directories would be 60 status requests.
      // Now at most one reconciliation per 250ms window, and only for the
      // directory that still has an unsettled session.
      const maxWindows = Math.ceil(elapsedMs / 250) + 1;
      expect(statusDirectories.length).toBeLessThanOrEqual(maxWindows);
      expect(statusDirectories).not.toContain("/repo/settled");
    } finally {
      await bridge.shutdown();
    }
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

  it("lowers only top-level Anthropic tool schema composition for Bedrock", async () => {
    let forwardedBody: Record<string, unknown> | undefined;
    const upstream = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/global/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("\n");
        return;
      }
      if (req.method === "POST" && req.url === "/v1/messages") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        forwardedBody = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "message", content: [] }));
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
      },
    });

    await bridge.start();
    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/gateway/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-8-fast",
          tools: [
            {
              name: "feishu-mcp_update-doc",
              input_schema: {
                type: "object",
                properties: {
                  docID: { type: "string" },
                  src_block_ids: {
                    oneOf: [
                      { type: "string" },
                      { type: "array", items: { type: "string" } },
                    ],
                  },
                },
                required: ["docID"],
                anyOf: [
                  {
                    properties: { command: { type: "string" } },
                    required: ["command"],
                  },
                  {
                    properties: { mode: { type: "string" } },
                    required: ["mode"],
                  },
                ],
              },
            },
          ],
        }),
      },
    );

    expect(response.status).toBe(200);
    const tools = forwardedBody?.tools as Array<{
      input_schema: Record<string, unknown>;
    }>;
    expect(tools[0]?.input_schema).not.toHaveProperty("anyOf");
    expect(tools[0]?.input_schema).not.toHaveProperty("oneOf");
    expect(tools[0]?.input_schema).not.toHaveProperty("allOf");
    expect(tools[0]?.input_schema).toMatchObject({
      type: "object",
      required: ["docID"],
      properties: {
        command: { type: "string" },
        mode: { type: "string" },
        src_block_ids: { oneOf: expect.any(Array) },
      },
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

  it("forwards edit boundaries and records the forked actual session id", async () => {
    let forwardedBody: Record<string, unknown> | undefined;
    let forwardedUrl: string | undefined;
    const upstream = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/global/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("\n");
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/ses_parent/resume")) {
        forwardedUrl = req.url;
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
            sessionId: "ses_forked",
            processId: "proc_forked",
            permissionMode: "default",
            modeVersion: 0,
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
    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/sessions/ses_parent/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd: "/tmp/project",
          message: "edited prompt",
          resumeSessionAt: "msg_native_user",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessionId: "ses_forked",
      processId: "proc_forked",
    });
    expect(forwardedUrl).toContain("/sessions/ses_parent/resume");
    expect(forwardedBody).toMatchObject({
      message: "edited prompt",
      provider: "opencode",
      resumeSessionAt: "msg_native_user",
    });
    expect(bridge.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ses_forked",
          projectPath: "/tmp/project",
        }),
      ]),
    );
    await bridge.shutdown();
  });

  it("starts and owns a managed OpenCode server when no external URL is configured", async () => {
    vi.stubEnv("LLM_API_KEY", undefined);
    vi.stubEnv("LLM_API_BASE", undefined);
    vi.stubEnv("LLM_SUB_MODULE", undefined);
    vi.stubEnv("YEP_OPENCODE_LLM_API_KEY", undefined);
    const opencodePath = await writeFakeOpenCodeExecutable();
    const startPort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodePath,
      opencodeStartPort: startPort,
      gatewayConfig: {
        apiKey: "bridge-key",
        apiBase: "https://api.ohmyrouter.com/v1",
        subModule: "claude-code-internal",
      },
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
    await expect(
      fetch(`${url}/test/env`).then((response) => response.json()),
    ).resolves.toEqual({
      llmApiKey: "bridge-key",
      llmApiBase: "https://api.ohmyrouter.com/v1",
      llmSubModule: "claude-code-internal",
      managedApiKey: "bridge-key",
      managedMarker: "1",
      managedServerPort: String(startPort),
    });

    await bridge.shutdown();
    expect(bridge.getStatus()).toMatchObject({
      opencodeServerRunning: false,
      opencodeServerPid: null,
    });
  });

  it("routes a managed user-configured gateway through the listening bridge", async () => {
    vi.stubEnv("LLM_API_KEY", undefined);
    vi.stubEnv("LLM_API_BASE", undefined);
    vi.stubEnv("LLM_SUB_MODULE", undefined);
    const opencodePath = await writeFakeOpenCodeExecutable();
    const bridgePort = await getFreePort();
    let startPort = await getFreePort();
    while (startPort === bridgePort) startPort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      serverUrl: "http://127.0.0.1:3400",
      opencodePath,
      opencodeStartPort: startPort,
      gatewayConfig: {
        apiKey: "bridge-key",
        apiBase: "https://api.ohmyrouter.com/v1",
        subModule: "claude-code-internal",
      },
    });

    await bridge.start();
    const url = await (
      bridge as unknown as {
        ensureOpenCodeServerUrl: () => Promise<string>;
      }
    ).ensureOpenCodeServerUrl();

    await expect(
      fetch(`${url}/test/env`).then((response) => response.json()),
    ).resolves.toMatchObject({
      llmApiKey: "bridge-key",
      llmApiBase: `http://127.0.0.1:${bridgePort}/gateway/v1`,
      llmSubModule: "claude-code-internal",
    });

    await bridge.shutdown();
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

  it("surfaces retry status without dropping the active turn", () => {
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
      type: "session.status",
      properties: { sessionID: "ses_retry", status: { type: "busy" } },
    });
    handleEvent({
      type: "session.status",
      properties: {
        sessionID: "ses_retry",
        status: {
          type: "retry",
          attempt: 3,
          message: "rate limited",
          next: 1_783_673_500_000,
          action: { label: "Open provider", link: "https://example.com" },
        },
      },
    });

    expect(bridge.isSessionActive("ses_retry")).toBe(true);
    const session = bridge
      .listSessions()
      .find((item) => item.id === "ses_retry");
    expect(session?.retryStatus).toMatchObject({
      attempt: 3,
      message: "rate limited",
      next: 1_783_673_500_000,
      actionLabel: "Open provider",
      actionLink: "https://example.com",
    });

    // The session view (what feeds the UI) carries the retry state too.
    const view = bridge
      .listSessionViews()
      .find((item) => item.session.id === "ses_retry");
    expect(view?.session.retryStatus).toMatchObject({ attempt: 3 });

    handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_retry", status: { type: "busy" } },
    });
    expect(
      bridge.listSessions().find((item) => item.id === "ses_retry")
        ?.retryStatus,
    ).toBeUndefined();
  });

  it("marks sessions idle with an error message on session.error", () => {
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
      type: "session.status",
      properties: { sessionID: "ses_err", status: { type: "busy" } },
    });
    expect(bridge.isSessionActive("ses_err")).toBe(true);

    handleEvent({
      type: "session.error",
      properties: {
        sessionID: "ses_err",
        error: { name: "ProviderError", data: { message: "model exploded" } },
      },
    });

    expect(bridge.isSessionActive("ses_err")).toBe(false);
    const session = bridge.listSessions().find((item) => item.id === "ses_err");
    expect(session?.lastErrorMessage).toBe("model exploded");
    expect(session?.lastTurnStatus).toBe("failed");
  });

  it("records interrupted instead of failed for user-initiated aborts", () => {
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
      type: "session.status",
      properties: { sessionID: "ses_abort", status: { type: "busy" } },
    });
    handleEvent({
      type: "session.error",
      properties: {
        sessionID: "ses_abort",
        error: { name: "MessageAbortedError", data: { message: "Stopped" } },
      },
    });

    const session = bridge
      .listSessions()
      .find((item) => item.id === "ses_abort");
    expect(session?.lastTurnStatus).toBe("interrupted");
    // Aborts are not failures; the client renders lastErrorMessage as a
    // failed badge, so it must stay clear.
    expect(session?.lastErrorMessage).toBeUndefined();
  });

  it("stops bridge reconciliation when an owned turn is interrupted over HTTP", async () => {
    const opencodeServer = createServer((req, res) => {
      const url = requestUrl(req);
      if (req.method === "GET" && url.pathname === "/global/event") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write("\n");
        return;
      }
      if (req.method === "GET" && url.pathname === "/session/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ses_interrupt: { type: "busy" } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const opencodeServerUrl = await listen(opencodeServer);
    const bridgePort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl,
      lifecycle: { reconcileIntervalMs: 10_000 },
    });
    await bridge.start();
    const internals = bridge as unknown as {
      handleOpenCodeEvent: (event: unknown) => void;
      lifecycles: Map<
        string,
        {
          state: { phase: string; terminalKind?: string };
          timer: NodeJS.Timeout | null;
        }
      >;
    };

    try {
      internals.handleOpenCodeEvent({
        type: "session.status",
        properties: {
          sessionID: "ses_interrupt",
          status: { type: "busy" },
        },
      });
      expect(internals.lifecycles.get("ses_interrupt")?.timer).not.toBeNull();

      const response = await fetch(
        `http://127.0.0.1:${bridgePort}/sessions/ses_interrupt/terminal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "interrupted" }),
        },
      );
      await expect(response.json()).resolves.toEqual({ terminal: true });

      expect(bridge.isSessionActive("ses_interrupt")).toBe(false);
      expect(
        bridge.listSessions().find((item) => item.id === "ses_interrupt"),
      ).toMatchObject({
        activity: "idle",
        lastTurnStatus: "interrupted",
      });
      expect(internals.lifecycles.get("ses_interrupt")).toMatchObject({
        state: { phase: "terminal", terminalKind: "interrupted" },
        timer: null,
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it("records a completed turn only after idle reconciliation", () => {
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
      lifecycle: { quietWindowMs: 0 },
    });
    const handleEvent = (
      bridge as unknown as {
        handleOpenCodeEvent: (event: unknown) => void;
      }
    ).handleOpenCodeEvent.bind(bridge);

    handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_done", status: { type: "running" } },
    });
    const busy = bridge.listSessions().find((item) => item.id === "ses_done");
    expect(busy?.lastTurnStatus).toBeUndefined();

    handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_done", status: { type: "idle" } },
    });
    expect(bridge.isSessionActive("ses_done")).toBe(true);
    (
      bridge as unknown as {
        dispatchOpenCodeLifecycle: (
          sessionId: string,
          action: {
            type: "status-reconciled";
            now: number;
            status: { type: "idle" };
            quietWindowMs: number;
          },
        ) => void;
      }
    ).dispatchOpenCodeLifecycle("ses_done", {
      type: "status-reconciled",
      now: Date.now(),
      status: { type: "idle" },
      quietWindowMs: 0,
    });
    const idle = bridge.listSessions().find((item) => item.id === "ses_done");
    expect(idle?.lastTurnStatus).toBe("completed");

    // A new turn clears the previous terminal status.
    handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_done", status: { type: "running" } },
    });
    const again = bridge.listSessions().find((item) => item.id === "ses_done");
    expect(again?.lastTurnStatus).toBeUndefined();
  });

  it("keeps an external CLI turn active after tool-calls and completes only from final assistant evidence", async () => {
    const bridgePort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
      lifecycle: { quietWindowMs: 5, reconcileIntervalMs: 5 },
    });
    await bridge.start();
    const handleEvent = (
      bridge as unknown as {
        handleOpenCodeEvent: (
          event: unknown,
          origin: { instanceId: string; directory: string },
        ) => void;
      }
    ).handleOpenCodeEvent.bind(bridge);
    const origin = { instanceId: "inst-cli", directory: "/tmp/cli" };

    try {
      handleEvent(
        {
          type: "session.status",
          properties: { sessionID: "ses_cli", status: { type: "busy" } },
        },
        origin,
      );
      handleEvent(
        {
          type: "message.updated",
          properties: {
            sessionID: "ses_cli",
            info: {
              role: "assistant",
              finish: "tool-calls",
              time: { completed: Date.now() },
            },
          },
        },
        origin,
      );
      handleEvent(
        {
          type: "session.status",
          properties: { sessionID: "ses_cli", status: { type: "idle" } },
        },
        origin,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(bridge.isSessionActive("ses_cli")).toBe(true);
      expect(
        bridge.listSessions().find((item) => item.id === "ses_cli")
          ?.lastTurnStatus,
      ).toBeUndefined();

      handleEvent(
        {
          type: "session.status",
          properties: { sessionID: "ses_cli", status: { type: "busy" } },
        },
        origin,
      );
      handleEvent(
        {
          type: "message.updated",
          properties: {
            sessionID: "ses_cli",
            info: {
              role: "assistant",
              finish: "stop",
              time: { completed: Date.now() },
            },
          },
        },
        origin,
      );
      handleEvent(
        {
          type: "session.status",
          properties: { sessionID: "ses_cli", status: { type: "idle" } },
        },
        origin,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(bridge.isSessionActive("ses_cli")).toBe(false);
      expect(
        bridge.listSessions().find((item) => item.id === "ses_cli")
          ?.lastTurnStatus,
      ).toBe("completed");
    } finally {
      await bridge.shutdown();
    }
  });

  it("keeps the stable-idle fallback for an external CLI without finish metadata", async () => {
    const bridgePort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
      lifecycle: { quietWindowMs: 5, reconcileIntervalMs: 5 },
    });
    await bridge.start();
    const handleEvent = (
      bridge as unknown as {
        handleOpenCodeEvent: (
          event: unknown,
          origin: { instanceId: string; directory: string },
        ) => void;
      }
    ).handleOpenCodeEvent.bind(bridge);
    const origin = { instanceId: "inst-legacy", directory: "/tmp/legacy" };

    try {
      handleEvent(
        {
          type: "session.status",
          properties: { sessionID: "ses_legacy", status: { type: "busy" } },
        },
        origin,
      );
      handleEvent(
        {
          type: "session.status",
          properties: { sessionID: "ses_legacy", status: { type: "idle" } },
        },
        origin,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(bridge.isSessionActive("ses_legacy")).toBe(false);
      expect(
        bridge.listSessions().find((item) => item.id === "ses_legacy")
          ?.lastTurnStatus,
      ).toBe("completed");
    } finally {
      await bridge.shutdown();
    }
  });

  it("does not mark idle-to-idle status polls as completed turns", () => {
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
      properties: { sessionID: "ses_quiet", info: { title: "Quiet" } },
    });
    handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_quiet", status: { type: "idle" } },
    });
    const session = bridge
      .listSessions()
      .find((item) => item.id === "ses_quiet");
    expect(session?.lastTurnStatus).toBeUndefined();
  });

  it("keeps OpenCode task children out of bridge lists but directly addressable", () => {
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
        sessionID: "ses_parent",
        info: { title: "Parent" },
      },
    });
    handleEvent({
      type: "session.created",
      properties: {
        sessionID: "ses_child",
        info: { title: "Child", parentID: "ses_parent" },
      },
    });

    expect(bridge.listSessions().map((session) => session.id)).toEqual([
      "ses_parent",
    ]);
    expect(bridge.listSessionViews().map((view) => view.session.id)).toEqual([
      "ses_parent",
    ]);
    expect(bridge.getStatus().sessionCount).toBe(1);
    expect(bridge.getSessionView("ses_child")?.session).toMatchObject({
      id: "ses_child",
      parentSessionId: "ses_parent",
    });
  });

  it("persists sessions across bridge restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yep-opencode-bridge-state-"));
    tempDirs.push(dir);
    const statePath = join(dir, "sessions.json");

    const first = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
      statePath,
    });
    const handleEvent = (
      first as unknown as {
        handleOpenCodeEvent: (event: unknown) => void;
      }
    ).handleOpenCodeEvent.bind(first);
    const updateSessionState = (
      first as unknown as {
        updateSessionState: (
          sessionId: string,
          state: Record<string, unknown>,
          origin?: { instanceId: string; directory?: string },
        ) => void;
      }
    ).updateSessionState.bind(first);

    handleEvent({
      type: "session.created",
      properties: {
        sessionID: "ses_persist",
        info: { title: "Durable session" },
      },
    });
    // Attribute a real cwd via an external-instance origin; guessed cwds
    // (bridge process cwd) are intentionally not persisted.
    updateSessionState(
      "ses_persist",
      { activity: "idle", active: false },
      { instanceId: "ext_1", directory: dir },
    );
    handleEvent({
      type: "session.created",
      properties: {
        sessionID: "ses_persist_child",
        info: { title: "Durable child", parentID: "ses_persist" },
      },
    });
    updateSessionState(
      "ses_persist_child",
      { activity: "idle", active: false },
      { instanceId: "ext_1", directory: dir },
    );
    handleEvent({
      type: "session.error",
      properties: {
        sessionID: "ses_persist",
        error: { name: "ProviderError", data: { message: "boom" } },
      },
    });
    await first.shutdown();

    const second = new OpenCodeBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: await getFreePort(),
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
      statePath,
    });
    await second.start();
    try {
      const restored = second
        .listSessions()
        .find((item) => item.id === "ses_persist");
      expect(restored).toBeDefined();
      expect(restored?.title).toBe("Durable session");
      expect(restored?.lastErrorMessage).toBe("boom");
      expect(restored?.lastTurnStatus).toBe("failed");
      // Restored sessions come back idle with no live runtime state.
      expect(restored?.active).toBe(false);
      expect(second.isSessionActive("ses_persist")).toBe(false);
      expect(second.listSessions().map((session) => session.id)).toEqual([
        "ses_persist",
      ]);
      expect(
        second.getSessionView("ses_persist_child")?.session.parentSessionId,
      ).toBe("ses_persist");
    } finally {
      await second.shutdown();
    }
  });

  it("removes sessions on session.deleted", () => {
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
      properties: { sessionID: "ses_gone", info: { title: "Doomed" } },
    });
    expect(bridge.listSessions().some((item) => item.id === "ses_gone")).toBe(
      true,
    );

    handleEvent({
      type: "session.deleted",
      properties: { sessionID: "ses_gone" },
    });
    expect(bridge.listSessions().some((item) => item.id === "ses_gone")).toBe(
      false,
    );
  });

  it("does not treat user message persistence as an active turn", () => {
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
      type: "message.updated",
      properties: {
        sessionID: "ses_user_msg",
        info: { id: "msg_1", role: "user" },
      },
    });
    expect(bridge.isSessionActive("ses_user_msg")).toBe(false);

    handleEvent({
      type: "message.updated",
      properties: {
        sessionID: "ses_user_msg",
        info: { id: "msg_2", role: "assistant" },
      },
    });
    expect(bridge.isSessionActive("ses_user_msg")).toBe(true);
  });

  it("does not emit another change signal for identical retry status", () => {
    const bridge = new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
    });
    const internals = bridge as unknown as {
      eventNotifier: { notify: () => void };
      handleOpenCodeEvent: (event: unknown) => void;
    };
    const notify = vi.spyOn(internals.eventNotifier, "notify");
    const event = {
      type: "session.status",
      properties: {
        sessionID: "ses_retry_stable",
        status: {
          type: "retry",
          attempt: 2,
          message: "rate limited",
          next: 1234,
          action: { label: "Details", link: "https://example.test" },
        },
      },
    };

    internals.handleOpenCodeEvent(event);
    expect(notify).toHaveBeenCalledTimes(1);
    notify.mockClear();

    internals.handleOpenCodeEvent(structuredClone(event));
    expect(notify).not.toHaveBeenCalled();

    internals.handleOpenCodeEvent({
      ...event,
      properties: {
        ...event.properties,
        status: { ...event.properties.status, attempt: 3 },
      },
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("supports external instances: events in, decisions out via long-poll", async () => {
    const bridgePort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
    });
    await bridge.start();
    const base = `http://127.0.0.1:${bridgePort}`;
    try {
      // Plugin registers its instance.
      const hello = await fetch(`${base}/external/instances`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: "inst-1",
          directory: "/tmp/project-ext",
        }),
      });
      expect(hello.status).toBe(200);

      // Forwarded permission.asked creates a pending input attributed to the
      // instance's real working directory.
      const asked = await fetch(`${base}/external/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: "inst-1",
          directory: "/tmp/project-ext",
          event: {
            type: "permission.asked",
            properties: {
              sessionID: "ses_ext",
              id: "perm_1",
              permission: "bash",
              patterns: ["rm -rf node_modules"],
              always: ["rm -rf node_modules"],
            },
          },
        }),
      });
      expect(asked.status).toBe(200);

      const session = bridge
        .listSessions()
        .find((item) => item.id === "ses_ext");
      expect(session).toMatchObject({
        projectPath: "/tmp/project-ext",
        activity: "waiting-input",
        pendingInputType: "tool-approval",
      });
      expect(bridge.getPendingInputRequest("ses_ext")).toMatchObject({
        id: "perm_1",
        type: "tool-approval",
        options: ["Approve", "Approve always", "Deny"],
        toolInput: {
          approvalKind: "opencode_permission",
          approvalProtocol: "v1",
          availableDecisions: ["once", "always", "reject"],
          persistentPatterns: ["rm -rf node_modules"],
        },
      });

      // Start a long-poll first, then answer from Yep: the decision must
      // wake the parked poll instead of waiting for the timeout.
      const pollPromise = fetch(
        `${base}/external/instances/inst-1/decisions?waitMs=5000`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const acceptedPromise = bridge.respondToInput(
        "ses_ext",
        "perm_1",
        "approve_always",
      );

      const pollResponse = await pollPromise;
      expect(pollResponse.status).toBe(200);
      const payload = (await pollResponse.json()) as {
        decisions: unknown[];
      };
      expect(payload.decisions).toHaveLength(1);
      expect(payload.decisions[0]).toMatchObject({
        id: "v1:permission:ses_ext:perm_1",
        kind: "permission",
        protocol: "v1",
        requestId: "perm_1",
        sessionId: "ses_ext",
        reply: "always",
      });

      // Polling is non-destructive: no ACK or reply event means the same
      // decision is redelivered and the UI stays waiting-input.
      const retryPoll = await fetch(
        `${base}/external/instances/inst-1/decisions?waitMs=0`,
      );
      const retryPayload = (await retryPoll.json()) as {
        decisions: unknown[];
      };
      expect(retryPayload.decisions).toEqual(payload.decisions);
      expect(bridge.getPendingInputRequest("ses_ext")).toMatchObject({
        id: "perm_1",
      });
      expect(
        bridge.listSessions().find((item) => item.id === "ses_ext")?.activity,
      ).toBe("waiting-input");

      // A retried asked event (for example after its HTTP response was lost)
      // must not replace the decision identity or strand the response waiter.
      await fetch(`${base}/external/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: "inst-1",
          directory: "/tmp/project-ext",
          event: {
            type: "permission.asked",
            properties: {
              sessionID: "ses_ext",
              id: "perm_1",
              permission: "bash",
              patterns: ["rm -rf node_modules"],
            },
          },
        }),
      });

      // Only OpenCode's reply event confirms the decision and releases the
      // original Yep response.
      await fetch(`${base}/external/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: "inst-1",
          directory: "/tmp/project-ext",
          event: {
            type: "permission.replied",
            properties: { sessionID: "ses_ext", requestID: "perm_1" },
          },
        }),
      });
      await expect(acceptedPromise).resolves.toBe(true);
      expect(bridge.getPendingInputRequest("ses_ext")).toBeNull();

      // The terminal event marks the decision confirmed. It remains queued
      // until ACK, but the plugin can now skip applying a TUI-completed reply.
      const confirmedPoll = await fetch(
        `${base}/external/instances/inst-1/decisions?waitMs=0`,
      );
      await expect(confirmedPoll.json()).resolves.toMatchObject({
        decisions: [
          {
            id: "v1:permission:ses_ext:perm_1",
            confirmed: true,
          },
        ],
      });

      // The plugin ACKs explicitly; repeated or late ACKs are harmless.
      for (let index = 0; index < 2; index += 1) {
        const ack = await fetch(
          `${base}/external/instances/inst-1/decisions/${encodeURIComponent(
            "v1:permission:ses_ext:perm_1",
          )}/ack`,
          { method: "POST" },
        );
        expect(ack.status).toBe(200);
      }
      const emptyPoll = await fetch(
        `${base}/external/instances/inst-1/decisions?waitMs=0`,
      );
      await expect(emptyPoll.json()).resolves.toEqual({ decisions: [] });
    } finally {
      await bridge.shutdown();
    }
  });

  it("shuts down while an external instance continuously long-polls", async () => {
    const bridgePort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
    });
    await bridge.start();
    const base = `http://127.0.0.1:${bridgePort}`;
    const registered = await fetch(`${base}/external/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: "inst-shutdown",
        directory: "/tmp/project-shutdown",
      }),
    });
    expect(registered.status).toBe(200);

    let polling = true;
    let pollAttempts = 0;
    const pollLoop = (async () => {
      while (polling) {
        pollAttempts += 1;
        try {
          const response = await fetch(
            `${base}/external/instances/inst-shutdown/decisions?waitMs=5000`,
          );
          if (!response.ok) break;
          await response.json();
        } catch {
          break;
        }
      }
    })();

    const internals = bridge as unknown as {
      externalInstances: Map<string, { waiters: unknown[] }>;
    };
    await vi.waitFor(() => {
      expect(
        internals.externalInstances.get("inst-shutdown")?.waiters,
      ).toHaveLength(1);
    });
    await expect(
      Promise.race([
        bridge.shutdown().then(() => "stopped"),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 1000)),
      ]),
    ).resolves.toBe("stopped");
    polling = false;
    await pollLoop;
    expect(pollAttempts).toBeGreaterThanOrEqual(1);
  });

  it("queues question decisions with ordered answers for external instances", async () => {
    const bridgePort = await getFreePort();
    const bridge = new OpenCodeBridgeService({
      enabled: true,
      host: "127.0.0.1",
      port: bridgePort,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
    });
    await bridge.start();
    const base = `http://127.0.0.1:${bridgePort}`;
    try {
      await fetch(`${base}/external/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: "inst-q",
          directory: "/tmp/project-q",
          event: {
            type: "question.v2.asked",
            properties: {
              sessionID: "ses_q",
              id: "q_1",
              questions: [
                {
                  question: "Pick one",
                  options: [{ label: "A" }, { label: "B" }],
                },
              ],
            },
          },
        }),
      });

      const request = bridge.getPendingInputRequest("ses_q");
      expect(request).toMatchObject({ id: "q_1", type: "question" });

      const acceptedPromise = bridge.respondToInput("ses_q", "q_1", "approve", {
        "question-0": ["A"],
      });

      const poll = await fetch(
        `${base}/external/instances/inst-q/decisions?waitMs=0`,
      );
      const payload = (await poll.json()) as { decisions: unknown[] };
      expect(payload.decisions).toHaveLength(1);
      expect(payload.decisions[0]).toMatchObject({
        id: "v2:question:ses_q:q_1",
        kind: "question",
        protocol: "v2",
        requestId: "q_1",
        sessionId: "ses_q",
        action: "reply",
      });

      await fetch(`${base}/external/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: "inst-q",
          directory: "/tmp/project-q",
          event: {
            type: "question.v2.replied",
            properties: {
              sessionID: "ses_q",
              requestID: "q_1",
              answers: [["A"]],
            },
          },
        }),
      });
      await expect(acceptedPromise).resolves.toBe(true);
    } finally {
      await bridge.shutdown();
    }
  });

  describe("subagent parent/child session handling", () => {
    function makeBridge(opencodeServerUrl?: string): OpenCodeBridgeService {
      return new OpenCodeBridgeService({
        enabled: false,
        host: "127.0.0.1",
        port: 0,
        serverUrl: "http://127.0.0.1:3400",
        opencodeServerUrl: opencodeServerUrl ?? "http://127.0.0.1:3400",
      });
    }

    function feed(bridge: OpenCodeBridgeService, event: unknown): void {
      (
        bridge as unknown as { handleOpenCodeEvent: (event: unknown) => void }
      ).handleOpenCodeEvent(event);
    }

    it("does not treat a message parentID (msg_*) as a session parent", () => {
      const bridge = makeBridge();
      feed(bridge, {
        type: "session.created",
        properties: { info: { id: "ses_root", title: "Root" } },
      });
      feed(bridge, {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_1",
            sessionID: "ses_root",
            role: "assistant",
            parentID: "msg_0",
          },
        },
      });

      const ids = bridge.listSessions().map((session) => session.id);
      expect(ids).toContain("ses_root");
      expect(bridge.getSessionView("ses_root")?.session.parentSessionId).toBe(
        undefined,
      );
    });

    it("establishes a parent/child relationship from session.created parentID", () => {
      const bridge = makeBridge();
      feed(bridge, {
        type: "session.created",
        properties: { info: { id: "ses_root", title: "Root" } },
      });
      feed(bridge, {
        type: "session.created",
        properties: {
          info: { id: "ses_child", parentID: "ses_root", title: "Child" },
        },
      });

      const ids = bridge.listSessions().map((session) => session.id);
      expect(ids).toEqual(["ses_root"]);
      // The child is hidden from the top-level list but directly addressable.
      expect(bridge.getSessionView("ses_child")?.session.parentSessionId).toBe(
        "ses_root",
      );
    });

    it("clears a previously mis-recorded msg_* parent on an authoritative session event", () => {
      const bridge = makeBridge();
      feed(bridge, {
        type: "session.created",
        properties: { info: { id: "ses_root", title: "Root" } },
      });
      // Simulate legacy corruption where a message id leaked into the parent.
      const sessions = (
        bridge as unknown as {
          sessions: Map<string, { parentSessionId?: string }>;
        }
      ).sessions;
      const record = sessions.get("ses_root");
      if (record) record.parentSessionId = "msg_bad";
      expect(bridge.listSessions().map((s) => s.id)).not.toContain("ses_root");

      feed(bridge, {
        type: "session.updated",
        properties: { info: { id: "ses_root", title: "Root" } },
      });
      expect(bridge.listSessions().map((s) => s.id)).toContain("ses_root");
      expect(bridge.getSessionView("ses_root")?.session.parentSessionId).toBe(
        undefined,
      );
    });

    it("drops persisted msg_* parents when restoring sessions", async () => {
      const dir = await mkdtemp(join(tmpdir(), "yep-opencode-restore-"));
      tempDirs.push(dir);
      const statePath = join(dir, "sessions.json");
      await writeFile(
        statePath,
        JSON.stringify({
          version: 1,
          sessions: [
            {
              id: "ses_root",
              parentSessionId: "msg_leak",
              cwd: "/repo",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "ses_child",
              parentSessionId: "ses_root",
              cwd: "/repo",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      );
      const bridge = new OpenCodeBridgeService({
        enabled: false,
        host: "127.0.0.1",
        port: 0,
        serverUrl: "http://127.0.0.1:3400",
        opencodeServerUrl: "http://127.0.0.1:3400",
        statePath,
      });
      await (
        bridge as unknown as {
          restorePersistedSessions: () => Promise<void>;
        }
      ).restorePersistedSessions();

      const ids = bridge.listSessions().map((session) => session.id);
      expect(ids).toContain("ses_root");
      expect(ids).not.toContain("ses_child");
      expect(bridge.getSessionView("ses_root")?.session.parentSessionId).toBe(
        undefined,
      );
    });

    it("projects a child permission onto the root session and replies to the child", async () => {
      const replies: Array<{ url: string; body: unknown }> = [];
      const opencodeServer = createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        req.on("end", () => {
          replies.push({
            url: requestUrl(req).pathname,
            body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null"),
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end("true");
        });
      });
      const opencodeServerUrl = await listen(opencodeServer);
      const bridge = makeBridge(opencodeServerUrl);

      feed(bridge, {
        type: "session.created",
        properties: { info: { id: "ses_root", title: "Root" } },
      });
      feed(bridge, {
        type: "session.created",
        properties: {
          info: { id: "ses_child", parentID: "ses_root", title: "Explore" },
        },
      });
      feed(bridge, {
        type: "permission.asked",
        properties: {
          id: "per_1",
          sessionID: "ses_child",
          permission: "external_directory",
          patterns: ["/tmp/x"],
        },
      });

      // Child stays out of the list; root now needs attention.
      expect(bridge.listSessions().map((s) => s.id)).toEqual(["ses_root"]);
      expect(bridge.getSessionView("ses_root")?.session.activity).toBe(
        "waiting-input",
      );
      expect(bridge.getSessionView("ses_root")?.session.pendingInputType).toBe(
        "tool-approval",
      );

      const projected = bridge.getPendingInputRequest("ses_root");
      expect(projected).toMatchObject({
        id: "per_1",
        sessionId: "ses_root",
        toolInput: {
          originSessionId: "ses_child",
          parentSessionId: "ses_root",
          originSessionTitle: "Explore",
        },
      });

      // Responding through the root resolves the real child request.
      await expect(
        bridge.respondToInput("ses_root", "per_1", "approve"),
      ).resolves.toBe(true);
      expect(replies).toEqual([
        { url: "/permission/per_1/reply", body: { reply: "once" } },
      ]);
      expect(bridge.getPendingInputRequest("ses_root")).toBeNull();
    });

    it("projects a child question onto the root session", () => {
      const bridge = makeBridge();
      feed(bridge, {
        type: "session.created",
        properties: { info: { id: "ses_root", title: "Root" } },
      });
      feed(bridge, {
        type: "session.created",
        properties: { info: { id: "ses_child", parentID: "ses_root" } },
      });
      feed(bridge, {
        type: "question.asked",
        properties: {
          id: "q_1",
          sessionID: "ses_child",
          questions: [{ question: "Proceed?", options: [] }],
        },
      });

      expect(bridge.getSessionView("ses_root")?.session.pendingInputType).toBe(
        "user-question",
      );
      expect(bridge.getPendingInputRequest("ses_root")).toMatchObject({
        id: "q_1",
        sessionId: "ses_root",
        type: "question",
        toolInput: { originSessionId: "ses_child" },
      });
      // The child is still directly retrievable by id.
      expect(bridge.getSessionView("ses_child")).not.toBeNull();
    });

    it("keeps the root waiting-input while another child request is still pending", async () => {
      const opencodeServer = createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("true");
        });
      });
      const opencodeServerUrl = await listen(opencodeServer);
      const bridge = makeBridge(opencodeServerUrl);

      feed(bridge, {
        type: "session.created",
        properties: { info: { id: "ses_root", title: "Root" } },
      });
      feed(bridge, {
        type: "session.created",
        properties: { info: { id: "ses_a", parentID: "ses_root" } },
      });
      feed(bridge, {
        type: "session.created",
        properties: { info: { id: "ses_b", parentID: "ses_root" } },
      });
      feed(bridge, {
        type: "permission.asked",
        properties: { id: "per_a", sessionID: "ses_a", permission: "bash" },
      });
      feed(bridge, {
        type: "permission.asked",
        properties: { id: "per_b", sessionID: "ses_b", permission: "edit" },
      });

      // Queue head is the oldest request.
      expect(bridge.getPendingInputRequest("ses_root")?.id).toBe("per_a");

      await expect(
        bridge.respondToInput("ses_root", "per_a", "approve"),
      ).resolves.toBe(true);

      // The second child is still blocked, so the root stays in needs-attention.
      expect(bridge.getSessionView("ses_root")?.session.activity).toBe(
        "waiting-input",
      );
      expect(bridge.getPendingInputRequest("ses_root")?.id).toBe("per_b");
    });
  });

  describe("runtime sync fan-out", () => {
    const DIRECTORIES = [
      "/repo/one",
      "/repo/two",
      "/repo/three",
      "/repo/four",
      "/repo/five",
      "/repo/six",
    ];

    interface UpstreamCounts {
      status: string[];
      question: string[];
      permission: string[];
    }

    function createUpstream(options: { failFirstStatus?: boolean } = {}) {
      const counts: UpstreamCounts = {
        status: [],
        question: [],
        permission: [],
      };
      let statusCalls = 0;
      const server = createServer((req, res) => {
        const url = requestUrl(req);
        const directory = url.searchParams.get("directory") ?? "";
        if (req.method === "GET" && url.pathname === "/global/event") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          res.write("\n");
          return;
        }
        if (req.method === "GET" && url.pathname === "/session/status") {
          statusCalls += 1;
          if (options.failFirstStatus && statusCalls === 1) {
            res.writeHead(500);
            res.end("boom");
            return;
          }
          counts.status.push(directory);
          const index = DIRECTORIES.indexOf(directory);
          res.writeHead(200, { "content-type": "application/json" });
          // Each managed directory keeps its own session busy, so every
          // directory stays in the fast reconciliation lane - the worst case
          // this guard has to bound.
          res.end(
            JSON.stringify(
              index >= 0 ? { [`ses_${index}`]: { type: "busy" } } : {},
            ),
          );
          return;
        }
        if (req.method === "GET" && url.pathname === "/question") {
          counts.question.push(directory);
          res.writeHead(200, { "content-type": "application/json" });
          res.end("[]");
          return;
        }
        if (req.method === "GET" && url.pathname === "/permission") {
          counts.permission.push(directory);
          res.writeHead(200, { "content-type": "application/json" });
          res.end("[]");
          return;
        }
        res.writeHead(404);
        res.end();
      });
      return { server, counts };
    }

    function resetCounts(counts: UpstreamCounts): void {
      counts.status.length = 0;
      counts.question.length = 0;
      counts.permission.length = 0;
    }

    function totalRequests(counts: UpstreamCounts): number {
      return (
        counts.status.length + counts.question.length + counts.permission.length
      );
    }

    /** Wait until the background reconcilers stop issuing upstream requests. */
    async function settle(counts: UpstreamCounts): Promise<void> {
      for (let stable = 0; stable < 4; ) {
        const before = totalRequests(counts);
        await new Promise((resolve) => setTimeout(resolve, 25));
        stable = totalRequests(counts) === before ? stable + 1 : 0;
      }
      resetCounts(counts);
    }

    function seedBusyDirectories(bridge: OpenCodeBridgeService): void {
      const internals = bridge as unknown as {
        handleOpenCodeEvent: (
          event: unknown,
          origin?: { directory?: string },
        ) => void;
      };
      DIRECTORIES.forEach((directory, index) => {
        internals.handleOpenCodeEvent(
          {
            type: "session.status",
            properties: {
              sessionID: `ses_${index}`,
              status: { type: "busy" },
            },
          },
          { directory },
        );
      });
    }

    it("coalesces concurrent bridge reads into a single directory sync round", async () => {
      const { server, counts } = createUpstream();
      const opencodeServerUrl = await listen(server);
      const bridgePort = await getFreePort();
      const bridge = new OpenCodeBridgeService({
        enabled: true,
        host: "127.0.0.1",
        port: bridgePort,
        serverUrl: "http://127.0.0.1:3400",
        opencodeServerUrl,
        lifecycle: { reconcileIntervalMs: 60_000 },
        runtimeSyncMinIntervalMs: 400,
        idleDirectorySyncIntervalMs: 60_000,
      });
      await bridge.start();
      const base = `http://127.0.0.1:${bridgePort}`;

      try {
        seedBusyDirectories(bridge);
        await settle(counts);

        // Let the freshness window lapse so a fresh round is due.
        await new Promise((resolve) => setTimeout(resolve, 450));

        const reads = [
          `${base}/session-views`,
          `${base}/session-views`,
          `${base}/session-views`,
          `${base}/sessions/ses_0/view`,
          `${base}/sessions/ses_0/view`,
          `${base}/sessions/ses_1/active`,
          `${base}/sessions/ses_1/active`,
          `${base}/sessions/ses_2/pending-input`,
          `${base}/sessions/ses_2/pending-input`,
          `${base}/status`,
          `${base}/status`,
          `${base}/sessions`,
        ];
        const responses = await Promise.all(reads.map((url) => fetch(url)));
        for (const response of responses) expect(response.status).toBe(200);

        // 12 concurrent reads x 7 managed directories x 3 endpoints would be
        // 252 upstream requests. Single-flight collapses them into one round:
        // at most 7 directories x 3 endpoints.
        const managedDirectoryCount = DIRECTORIES.length + 1; // + process.cwd()
        expect(counts.status.length).toBeLessThanOrEqual(managedDirectoryCount);
        expect(counts.question.length).toBeLessThanOrEqual(
          managedDirectoryCount,
        );
        expect(counts.permission.length).toBeLessThanOrEqual(
          managedDirectoryCount,
        );
        expect(totalRequests(counts)).toBeLessThanOrEqual(
          managedDirectoryCount * 3,
        );
        expect(totalRequests(counts)).toBeGreaterThan(0);

        // Inside the freshness window further reads are served from memory.
        resetCounts(counts);
        const cached = await Promise.all(reads.map((url) => fetch(url)));
        for (const response of cached) expect(response.status).toBe(200);
        expect(totalRequests(counts)).toBe(0);

        // Once the window lapses the next round is allowed again.
        await new Promise((resolve) => setTimeout(resolve, 450));
        resetCounts(counts);
        expect((await fetch(`${base}/session-views`)).status).toBe(200);
        expect(totalRequests(counts)).toBeGreaterThan(0);
        expect(totalRequests(counts)).toBeLessThanOrEqual(
          managedDirectoryCount * 3,
        );
      } finally {
        await bridge.shutdown();
      }
    });

    it("limits per-session reads to that session's own directory", async () => {
      const { server, counts } = createUpstream();
      const opencodeServerUrl = await listen(server);
      const bridgePort = await getFreePort();
      const bridge = new OpenCodeBridgeService({
        enabled: true,
        host: "127.0.0.1",
        port: bridgePort,
        serverUrl: "http://127.0.0.1:3400",
        opencodeServerUrl,
        lifecycle: { reconcileIntervalMs: 60_000 },
        runtimeSyncMinIntervalMs: 200,
        idleDirectorySyncIntervalMs: 60_000,
      });
      await bridge.start();
      const base = `http://127.0.0.1:${bridgePort}`;

      try {
        seedBusyDirectories(bridge);
        await settle(counts);
        await new Promise((resolve) => setTimeout(resolve, 250));

        expect((await fetch(`${base}/sessions/ses_3/view`)).status).toBe(200);

        // A single session read must not sweep the other managed directories.
        expect(counts.status).toEqual(["/repo/four"]);
        expect(counts.question).toEqual(["/repo/four"]);
        expect(counts.permission).toEqual(["/repo/four"]);

        // An unknown session cannot be reconciled at all, so it stays free.
        await new Promise((resolve) => setTimeout(resolve, 250));
        resetCounts(counts);
        expect((await fetch(`${base}/sessions/ses_unknown/view`)).status).toBe(
          200,
        );
        expect(totalRequests(counts)).toBe(0);
      } finally {
        await bridge.shutdown();
      }
    });

    it("retries the next window after a failed sync instead of poisoning it", async () => {
      const { server, counts } = createUpstream({ failFirstStatus: true });
      const opencodeServerUrl = await listen(server);
      const bridgePort = await getFreePort();
      const bridge = new OpenCodeBridgeService({
        enabled: true,
        host: "127.0.0.1",
        port: bridgePort,
        serverUrl: "http://127.0.0.1:3400",
        opencodeServerUrl,
        lifecycle: { reconcileIntervalMs: 60_000 },
        runtimeSyncMinIntervalMs: 200,
        idleDirectorySyncIntervalMs: 60_000,
      });
      await bridge.start();
      const base = `http://127.0.0.1:${bridgePort}`;

      try {
        seedBusyDirectories(bridge);
        await settle(counts);
        await new Promise((resolve) => setTimeout(resolve, 250));

        // The failed cycle is recorded but must not wedge the reconciler.
        expect((await fetch(`${base}/session-views`)).status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 250));
        resetCounts(counts);
        expect((await fetch(`${base}/session-views`)).status).toBe(200);
        expect(counts.status.length).toBeGreaterThan(0);
      } finally {
        await bridge.shutdown();
      }
    });
  });
});

describe("OpenCodeBridgeService model gateway proxy", () => {
  interface GatedUpstream {
    url: string;
    releaseTail: () => void;
    tailReleased: () => boolean;
  }

  async function startGatedSseUpstream(): Promise<GatedUpstream> {
    let release: () => void = () => {};
    let released = false;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        released = true;
        resolve();
      };
    });
    const upstream = createServer(async (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write("data: chunk-1\n\n");
      await gate;
      res.write("data: chunk-2\n\n");
      res.end();
    });
    const url = await listen(upstream);
    return { url, releaseTail: release, tailReleased: () => released };
  }

  function startProxy(bridge: OpenCodeBridgeService): Promise<string> {
    const proxy = createServer((req, res) => {
      void (
        bridge as unknown as {
          proxyGatewayRequest: (
            req: typeof req,
            res: typeof res,
            url: URL,
          ) => Promise<void>;
        }
      ).proxyGatewayRequest(req, res, requestUrl(req));
    });
    return listen(proxy);
  }

  function makeBridge(apiBase: string): OpenCodeBridgeService {
    return new OpenCodeBridgeService({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      serverUrl: "http://127.0.0.1:3400",
      opencodeServerUrl: "http://127.0.0.1:1",
      gatewayConfig: { apiKey: "test-key", apiBase },
    });
  }

  it("streams non-GLM responses without waiting for the full body", async () => {
    const upstream = await startGatedSseUpstream();
    const bridge = makeBridge(upstream.url);
    const proxyUrl = await startProxy(bridge);

    const response = await fetch(`${proxyUrl}/gateway/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kimi-k2", stream: true }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.body).not.toBeNull();

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    // The first chunk must arrive while the upstream is still holding the tail,
    // proving the proxy forwards incrementally instead of buffering.
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("chunk-1");
    expect(upstream.tailReleased()).toBe(false);

    upstream.releaseTail();

    let rest = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value);
    }
    expect(rest).toContain("chunk-2");
  });

  it("buffers GLM responses until the upstream completes", async () => {
    const upstream = await startGatedSseUpstream();
    const bridge = makeBridge(upstream.url);
    const proxyUrl = await startProxy(bridge);

    const responsePromise = fetch(`${proxyUrl}/gateway/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", stream: true }),
    });

    // Give the proxy time to reach upstream and start buffering. Because GLM is
    // buffered, the client must not receive headers until we release the tail.
    const settled = await Promise.race([
      responsePromise.then(() => "resolved" as const),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 150),
      ),
    ]);
    expect(settled).toBe("pending");
    expect(upstream.tailReleased()).toBe(false);

    upstream.releaseTail();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("chunk-1");
    expect(text).toContain("chunk-2");
  });
});
