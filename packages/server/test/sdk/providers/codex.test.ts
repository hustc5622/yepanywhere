/**
 * Unit tests for CodexProvider.
 *
 * Tests provider detection, authentication checking, and message normalization
 * without requiring actual Codex CLI installation.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GeneratedArtifactManifest } from "@yep-anywhere/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  InMemoryCodexEventStore,
  replayCodexSession,
} from "../../../src/codex-events/index.js";
import { getCodexMcpAppServerArgs } from "../../../src/codex/mcp-profile.js";
import {
  CodexProvider,
  type CodexProviderConfig,
} from "../../../src/sdk/providers/codex.js";
import type { SDKMessage, ToolApprovalResult } from "../../../src/sdk/types.js";
import { Supervisor } from "../../../src/supervisor/Supervisor.js";
import { UploadManager } from "../../../src/uploads/manager.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}

describe("CodexProvider", () => {
  let provider: CodexProvider;

  beforeAll(() => {
    provider = new CodexProvider();
  });

  describe("isInstalled", () => {
    it("should return boolean indicating CLI availability", async () => {
      const isInstalled = await provider.isInstalled();
      expect(typeof isInstalled).toBe("boolean");
    });

    it("should use custom codexPath if provided and exists", async () => {
      // Custom path is used IF it exists, otherwise falls back to PATH detection
      const customProvider = new CodexProvider({
        codexPath: "/nonexistent/path/to/codex",
      });
      // isInstalled will still check PATH if custom path doesn't exist
      const isInstalled = await customProvider.isInstalled();
      // We just verify it returns a boolean - actual value depends on system
      expect(typeof isInstalled).toBe("boolean");
    });
  });

  describe("getAuthStatus", () => {
    it("should return auth status object with required fields", async () => {
      const status = await provider.getAuthStatus();

      expect(typeof status.installed).toBe("boolean");
      expect(typeof status.authenticated).toBe("boolean");
      expect(typeof status.enabled).toBe("boolean");
    });

    it("should return authenticated=false if auth.json does not exist", async () => {
      // This test relies on the auth file not existing in the test environment
      const authPath = join(homedir(), ".codex", "auth.json");
      if (!existsSync(authPath)) {
        const status = await provider.getAuthStatus();
        // If CLI is not installed, everything should be false
        // If CLI is installed but no auth, installed=true but auth=false
        expect(status.authenticated).toBe(false);
      }
    });
  });

  describe("isAuthenticated", () => {
    it("should return boolean", async () => {
      const isAuth = await provider.isAuthenticated();
      expect(typeof isAuth).toBe("boolean");
    });
  });

  describe("provider properties", () => {
    it("should have correct name", () => {
      expect(provider.name).toBe("codex");
    });

    it("should have correct displayName", () => {
      expect(provider.displayName).toBe("Codex");
    });
  });

  describe("startSession", () => {
    function writeFakeCodexAppServer(tempDir: string): string {
      const fakeCodexPath = join(tempDir, "fake-codex.js");
      writeFileSync(
        fakeCodexPath,
        `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "app-server" && process.env.CODEX_FAKE_APP_SERVER_ERROR) {
  process.stderr.write(process.env.CODEX_FAKE_APP_SERVER_ERROR + "\\n");
  process.exit(1);
}
let buffer = "";
const attemptsByMethod = new Map();

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function sendError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n",
  );
}

function notify(method, params, emittedAtMs) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", method, params, emittedAtMs }) + "\\n",
  );
}

function request(id, method, params) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n",
  );
}

function sendThread(id, threadId, cwd, options = {}) {
  send(id, {
    thread: {
      id: threadId,
      cwd,
      modelProvider: "openai",
      status: { type: "idle" },
      turns: options.turns || [],
      forkedFromId: options.forkedFromId || null,
    },
    model: "gpt-5.5",
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    reasoningEffort: null,
  });
}

function handle(message) {
  const method = typeof message.method === "string" ? message.method : "";
  const attempt = method ? (attemptsByMethod.get(method) || 0) + 1 : 0;
  if (method) {
    attemptsByMethod.set(method, attempt);
  }
  if (process.env.CODEX_FAKE_MESSAGE_CAPTURE) {
    fs.appendFileSync(
      process.env.CODEX_FAKE_MESSAGE_CAPTURE,
      JSON.stringify({
        id: message.id,
        method: message.method,
        params: message.params,
        result: message.result,
        error: message.error,
        attempt,
        monotonicMs: Date.now(),
      }) + "\\n",
    );
  }
  if (!message.method && message.id === "approval-event-spine") {
    notify(
      "turn/completed",
      {
        threadId: "thread-new",
        turn: {
          id: "turn-rewrite",
          status: "completed",
          items: [],
          error: null,
        },
      },
      1003,
    );
    return;
  }
  if (message.method === "initialize") {
    send(message.id, { userAgent: "fake-codex" });
    return;
  }
  if (message.method === "config/read") {
    const names = JSON.parse(process.env.CODEX_FAKE_MCP_SERVERS || "[]");
    send(message.id, {
      config: {
        mcp_servers: Object.fromEntries(names.map((name) => [
          name,
          { command: "fake-mcp", args: [name], enabled: true },
        ])),
      },
      origins: {},
    });
    return;
  }
  if (message.method === "thread/fork") {
    const turns = JSON.parse(process.env.CODEX_FAKE_SOURCE_TURNS || "[]");
    const boundary = turns.findIndex(
      (turn) => turn.id === message.params.lastTurnId,
    );
    sendThread(message.id, "thread-forked", message.params.cwd, {
      turns: boundary < 0 ? [] : turns.slice(0, boundary + 1),
      forkedFromId: message.params.threadId,
    });
    return;
  }
  if (message.method === "turn/start") {
    const eventMode = process.env.CODEX_FAKE_EVENT_MODE === "1";
    const activeTurn = process.env.CODEX_FAKE_ACTIVE_TURN === "1";
    const failedTurn = process.env.CODEX_FAKE_FAILED_TURN === "1";
    send(message.id, {
      turn: {
        id: "turn-rewrite",
        status: failedTurn
          ? "failed"
          : eventMode || activeTurn
            ? "inProgress"
            : "completed",
        items: [],
        error: failedTurn
          ? {
              message:
                "provider failure synthetic-wire-secret at /private/provider/error",
            }
          : null,
      },
    });
    if (eventMode) {
      notify(
        "turn/started",
        {
          threadId: "thread-new",
          turn: { id: "turn-rewrite", status: "inProgress", items: [] },
        },
        1000,
      );
      notify(
        "item/completed",
        {
          threadId: "thread-new",
          turnId: "turn-rewrite",
          item: {
            id: "agent-event-spine",
            type: "agentMessage",
            text: "event spine reply",
            phase: "final_answer",
          },
        },
        1001,
      );
      if (process.env.CODEX_FAKE_GENERATED_FILE) {
        notify(
          "item/completed",
          {
            threadId: "thread-new",
            turnId: "turn-rewrite",
            item: {
              id: "file-generated",
              type: "fileChange",
              status: "completed",
              changes: [
                {
                  path: process.env.CODEX_FAKE_GENERATED_FILE,
                  kind: { type: "add" },
                  diff: "+ password=fixture-only-private",
                },
              ],
            },
          },
          1002,
        );
      }
      notify(
        "future/provider-event",
        {
          threadId: "thread-new",
          turnId: "turn-rewrite",
          authorization: "Bearer must-not-be-persisted",
        },
        1002,
      );
      request(
        "approval-event-spine",
        "item/commandExecution/requestApproval",
        {
          threadId: "thread-new",
          turnId: "turn-rewrite",
          itemId: "command-event-spine",
          command: "pwd",
          cwd: "/tmp",
          reason: "synthetic approval",
          availableDecisions: ["accept", "decline"],
          authorization: "Bearer approval-must-not-be-persisted",
        },
      );
    }

    if (process.env.CODEX_FAKE_SERVER_REQUEST_METHOD) {
      request(
        "synthetic-server-request",
        process.env.CODEX_FAKE_SERVER_REQUEST_METHOD,
        {},
      );
    }
    return;
  }
  if (message.method === "turn/steer") {
    send(message.id, {
      turnId:
        message.params.clientUserMessageId === "client-mismatch"
          ? "different-turn"
          : process.env.CODEX_FAKE_STEER_TURN_ID || message.params.expectedTurnId,
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    send(message.id, {});
    return;
  }
  if ([
    "skills/list",
    "review/start",
    "thread/compact/start",
    "thread/goal/get",
    "thread/goal/set",
    "thread/goal/clear",
    "thread/shellCommand",
  ].includes(message.method)) {
    if (process.env.CODEX_FAKE_CONTROL_CAPTURE) {
      fs.appendFileSync(
        process.env.CODEX_FAKE_CONTROL_CAPTURE,
        JSON.stringify({ method: message.method, params: message.params }) + "\\n",
      );
    }
    if (process.env.CODEX_FAKE_UNSUPPORTED_CONTROLS === "1") {
      sendError(message.id, -32601, "Method not found");
      return;
    }
    if (
      message.method === "thread/goal/set" &&
      message.params.objective === "provider-invalid"
    ) {
      sendError(message.id, -32602, "synthetic invalid parameters");
      return;
    }
    if (message.method === "skills/list") {
      send(message.id, { data: [] });
      return;
    }
    if (message.method === "review/start") {
      send(message.id, {
        turn: {
          id: "review-turn",
          status: "inProgress",
          items: [],
          error: null,
        },
        reviewThreadId: message.params.threadId,
      });
      return;
    }
    if (message.method === "thread/goal/get") {
      send(message.id, {
        goal: process.env.CODEX_FAKE_GOAL_JSON
          ? JSON.parse(process.env.CODEX_FAKE_GOAL_JSON)
          : null,
      });
      return;
    }
    if (message.method === "thread/goal/set") {
      send(message.id, {
        goal: {
          threadId: message.params.threadId,
          objective: message.params.objective || "",
          status: message.params.status || "active",
          tokenBudget: message.params.tokenBudget || null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      });
      return;
    }
    if (message.method === "thread/goal/clear") {
      send(message.id, {
        cleared: process.env.CODEX_FAKE_GOAL_CLEAR_RESULT !== "0",
      });
      return;
    }
    send(message.id, {});
    return;
  }
  if (message.method !== "thread/start" && message.method !== "thread/resume") {
    return;
  }
  if (
    message.method === "thread/resume" &&
    process.env.CODEX_FAKE_NO_ROLLOUT === "1"
  ) {
    const code = Number.parseInt(
      process.env.CODEX_FAKE_NO_ROLLOUT_CODE || "-32600",
      10,
    );
    const threadId =
      process.env.CODEX_FAKE_NO_ROLLOUT_THREAD || message.params.threadId;
    sendError(message.id, code, "no rollout found for thread id " + threadId);
    return;
  }
  const overloadAttempts = Number.parseInt(
    process.env.CODEX_FAKE_OVERLOAD_ATTEMPTS || "0",
    10,
  );
  if (
    message.method === "thread/start" &&
    Number.isSafeInteger(overloadAttempts) &&
    attempt <= overloadAttempts
  ) {
    sendError(message.id, -32001, "Server overloaded; retry later.");
    return;
  }
  const threadStartErrorCode = Number.parseInt(
    process.env.CODEX_FAKE_THREAD_START_ERROR_CODE || "",
    10,
  );
  if (
    message.method === "thread/start" &&
    Number.isSafeInteger(threadStartErrorCode)
  ) {
    sendError(message.id, threadStartErrorCode, "synthetic request failure");
    return;
  }
  fs.writeFileSync(
    process.env.CODEX_FAKE_CAPTURE,
    JSON.stringify({
      argv: process.argv.slice(2),
      method: message.method,
      params: message.params,
    }),
  );
  const resumed = (attemptsByMethod.get("thread/resume") || 0) > 0;
  const threadId =
    message.method === "thread/start" &&
    resumed &&
    process.env.CODEX_FAKE_FIRST_PROMPT_FORK === "1"
      ? "thread-first-fork"
      : message.method === "thread/start" &&
          resumed &&
          process.env.CODEX_FAKE_NO_ROLLOUT === "1"
        ? "thread-replacement"
        : message.method === "thread/start" &&
            process.env.CODEX_FAKE_PROVISIONAL_START === "1"
          ? "thread-provisional"
        : message.params.threadId || "thread-new";
  const turns =
    message.method === "thread/resume"
      ? JSON.parse(process.env.CODEX_FAKE_SOURCE_TURNS || "[]")
      : [];
  sendThread(message.id, threadId, message.params.cwd, { turns });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\\n");
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      handle(JSON.parse(line));
    }
    newlineIndex = buffer.indexOf("\\n");
  }
});
`,
      );
      chmodSync(fakeCodexPath, 0o755);
      return fakeCodexPath;
    }

    it("rejoins a bridge-owned active turn over WebSocket without spawning stdio", async () => {
      const requests: Array<{ method: string; params?: unknown }> = [];
      const websocketPaths: string[] = [];
      const httpServer = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/sessions/thread-bridge/active") {
          res.end(JSON.stringify({ active: true, mcpProfile: "full" }));
          return;
        }
        if (req.url === "/status") {
          const address = httpServer.address() as AddressInfo;
          res.end(
            JSON.stringify({
              listening: true,
              url: `ws://127.0.0.1:${address.port}`,
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      });
      const wsServer = new WebSocketServer({ server: httpServer });
      wsServer.on("connection", (socket, request) => {
        websocketPaths.push(request.url ?? "");
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as {
            id: number;
            method: string;
            params?: unknown;
          };
          requests.push({ method: message.method, params: message.params });
          const send = (result: unknown) =>
            socket.send(JSON.stringify({ id: message.id, result }));
          if (message.method === "initialize") {
            send({ userAgent: "fake-bridge" });
          } else if (message.method === "config/read") {
            send({ config: { mcp_servers: {} }, origins: {} });
          } else if (message.method === "thread/resume") {
            send({
              thread: {
                id: "thread-bridge",
                cwd: "/repo",
                modelProvider: "openai",
                status: { type: "active", activeFlags: [] },
                turns: [
                  {
                    id: "turn-live",
                    status: "inProgress",
                    items: [],
                    error: null,
                  },
                ],
                forkedFromId: null,
              },
              model: "gpt-5.5",
              modelProvider: "openai",
              serviceTier: null,
              cwd: "/repo",
              reasoningEffort: null,
            });
          } else if (message.method === "turn/steer") {
            send({ turnId: "turn-live" });
            socket.send(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "thread-bridge",
                  turn: {
                    id: "turn-live",
                    status: "completed",
                    items: [],
                    error: null,
                  },
                },
              }),
            );
          }
        });
      });
      await new Promise<void>((resolve) =>
        httpServer.listen(0, "127.0.0.1", resolve),
      );
      const address = httpServer.address() as AddressInfo;
      const provider = new CodexProvider({
        codexPath: "/path-that-must-not-be-spawned/codex",
        bridgeExecution: {
          mode: "external",
          controlUrl: `http://127.0.0.1:${address.port}`,
        },
      });
      const session = await provider.startSession({
        cwd: "/repo",
        resumeSessionId: "thread-bridge",
        initialMessage: { text: "continue", uuid: "bridge-message" },
      });
      try {
        for await (const message of session.iterator) {
          if (
            message.type === "result" &&
            message.clientUserMessageId === "bridge-message"
          ) {
            break;
          }
        }
        expect(requests.map((request) => request.method)).toContain(
          "turn/steer",
        );
        expect(requests.map((request) => request.method)).not.toContain(
          "turn/start",
        );
        expect(websocketPaths).toEqual(["/?mcp=full"]);
        expect(
          requests.find((request) => request.method === "turn/steer")?.params,
        ).toMatchObject({
          threadId: "thread-bridge",
          expectedTurnId: "turn-live",
          clientUserMessageId: "bridge-message",
        });
      } finally {
        session.abort();
        for (const client of wsServer.clients) client.terminate();
        await new Promise<void>((resolve) => wsServer.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    });

    it("rejects a bridge WebSocket endpoint on a different host before sending credentials", async () => {
      const httpServer = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/sessions/thread-bridge/active") {
          res.end(JSON.stringify({ active: true }));
          return;
        }
        if (req.url === "/status") {
          res.end(
            JSON.stringify({
              listening: true,
              url: "ws://example.invalid:4510",
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      });
      await new Promise<void>((resolve) =>
        httpServer.listen(0, "127.0.0.1", resolve),
      );
      const address = httpServer.address() as AddressInfo;
      const bridgeProvider = new CodexProvider({
        codexPath: "/path-that-must-not-be-spawned/codex",
        bridgeExecution: {
          mode: "external",
          controlUrl: `http://127.0.0.1:${address.port}`,
          authToken: "must-not-leave-control-host",
        },
      });
      const session = await bridgeProvider.startSession({
        cwd: "/repo",
        resumeSessionId: "thread-bridge",
        initialMessage: { text: "continue" },
      });

      try {
        await expect(session.iterator.next()).resolves.toMatchObject({
          value: {
            type: "error",
            codexError: {
              code: "CODEX_BRIDGE_UNAVAILABLE",
              category: "bridge",
            },
          },
        });
      } finally {
        session.abort();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    });

    function readMessageCapture(capturePath: string): Array<{
      id?: string | number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { code?: number; message?: string };
      attempt?: number;
      monotonicMs?: number;
    }> {
      if (!existsSync(capturePath)) return [];
      return readFileSync(capturePath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              id?: string | number;
              method?: string;
              params?: Record<string, unknown>;
              result?: unknown;
              error?: { code?: number; message?: string };
              attempt?: number;
              monotonicMs?: number;
            },
        );
    }

    it("should return session object with required methods", async () => {
      const session = await provider.startSession({
        cwd: "/tmp",
        initialMessage: { text: "test" },
      });

      expect(session.iterator).toBeDefined();
      expect(typeof session.abort).toBe("function");
      expect(session.queue).toBeDefined();
    });

    it("preserves native input and publishes the accepted turn correlation", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-native-input-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "thread.json");
      const messageCapturePath = join(tempDir, "messages.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;
      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MESSAGE_CAPTURE = messageCapturePath;

      try {
        const nativeProvider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await nativeProvider.startSession({
          cwd: tempDir,
          initialMessage: {
            text: "inspect inputs",
            uuid: "client-native-input",
            tempId: "temp-native-input",
            images: ["data:image/webp;base64,AAAA"],
            attachments: [
              {
                id: "image-upload",
                originalName: "photo.png",
                size: 4,
                mimeType: "image/png",
                path: join(tempDir, "photo.png"),
              },
              {
                id: "document-upload",
                originalName: "report.pdf",
                size: 8,
                mimeType: "application/pdf",
                path: join(tempDir, "report.pdf"),
              },
            ],
            codexInputs: [
              {
                type: "skill",
                name: "review",
                path: join(tempDir, "skills", "review", "SKILL.md"),
              },
              {
                type: "mention",
                name: "guide",
                path: join(tempDir, "docs", "guide.md"),
              },
            ],
          },
        });

        const messages: SDKMessage[] = [];
        for await (const message of session.iterator) {
          messages.push(message);
          if (
            message.type === "result" &&
            message.clientUserMessageId === "client-native-input"
          ) {
            break;
          }
        }

        const turnStart = readMessageCapture(messageCapturePath).find(
          ({ method }) => method === "turn/start",
        );
        expect(turnStart?.params).toMatchObject({
          threadId: "thread-new",
          clientUserMessageId: "client-native-input",
          input: [
            {
              type: "text",
              text: expect.stringContaining(join(tempDir, "report.pdf")),
              text_elements: [],
            },
            { type: "image", url: "data:image/webp;base64,AAAA" },
            { type: "localImage", path: join(tempDir, "photo.png") },
            {
              type: "skill",
              name: "review",
              path: join(tempDir, "skills", "review", "SKILL.md"),
            },
            {
              type: "mention",
              name: "guide",
              path: join(tempDir, "docs", "guide.md"),
            },
          ],
        });
        const acceptedUser = messages.find(
          (message) => message.type === "user",
        );
        expect(acceptedUser).toMatchObject({
          uuid: "client-native-input",
          tempId: "temp-native-input",
          clientUserMessageId: "client-native-input",
          turnId: "turn-rewrite",
          codexTurnId: "turn-rewrite",
          isOptimistic: false,
          message: { content: expect.stringContaining("[managed attachment]") },
        });
        expect(JSON.stringify(acceptedUser)).not.toContain(tempDir);
        expect(
          messages.find(
            (message) =>
              message.type === "result" && message.clientUserMessageId,
          ),
        ).toMatchObject({
          turnId: "turn-rewrite",
          codexTurnId: "turn-rewrite",
          clientUserMessageId: "client-native-input",
        });
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("requires turn/steer to confirm the exact active turn", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-steer-identity-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "thread.json");
      const messageCapturePath = join(tempDir, "messages.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
      const previousActiveTurn = process.env.CODEX_FAKE_ACTIVE_TURN;
      const previousSteerTurnId = process.env.CODEX_FAKE_STEER_TURN_ID;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;
      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MESSAGE_CAPTURE = messageCapturePath;
      process.env.CODEX_FAKE_ACTIVE_TURN = "1";
      process.env.CODEX_FAKE_STEER_TURN_ID = "";

      try {
        const nativeProvider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await nativeProvider.startSession({
          cwd: tempDir,
          initialMessage: { text: "start", uuid: "client-start" },
        });
        await session.iterator.next();
        await session.iterator.next();

        await expect(
          session.steer?.({
            text: "steer",
            uuid: "client-steer",
            codexInputs: [
              {
                type: "skill",
                name: "review",
                path: join(tempDir, "skills", "review", "SKILL.md"),
              },
            ],
          }),
        ).resolves.toEqual({ accepted: true, turnId: "turn-rewrite" });
        expect(
          readMessageCapture(messageCapturePath).find(
            ({ method }) => method === "turn/steer",
          )?.params,
        ).toMatchObject({
          threadId: "thread-new",
          clientUserMessageId: "client-steer",
          expectedTurnId: "turn-rewrite",
          input: [
            { type: "text", text: "steer", text_elements: [] },
            {
              type: "skill",
              name: "review",
              path: join(tempDir, "skills", "review", "SKILL.md"),
            },
          ],
        });

        await expect(
          session.steer?.({ text: "mismatch", uuid: "client-mismatch" }),
        ).resolves.toBe(false);
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
        restoreEnv("CODEX_FAKE_ACTIVE_TURN", previousActiveTurn);
        restoreEnv("CODEX_FAKE_STEER_TURN_ID", previousSteerTurnId);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("interrupts the exact active Codex turn through the stable API", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-interrupt-identity-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "thread.json");
      const messageCapturePath = join(tempDir, "messages.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
      const previousActiveTurn = process.env.CODEX_FAKE_ACTIVE_TURN;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;
      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MESSAGE_CAPTURE = messageCapturePath;
      process.env.CODEX_FAKE_ACTIVE_TURN = "1";

      try {
        const nativeProvider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await nativeProvider.startSession({
          cwd: tempDir,
          initialMessage: { text: "start", uuid: "client-interrupt" },
        });
        await session.iterator.next();
        await session.iterator.next();

        await expect(session.interrupt?.()).resolves.toBeUndefined();
        expect(
          readMessageCapture(messageCapturePath).find(
            ({ method }) => method === "turn/interrupt",
          )?.params,
        ).toEqual({ threadId: "thread-new", turnId: "turn-rewrite" });
        expect(session.codexControls?.capabilities.experimentalApi).toBe(false);
        expect(
          readMessageCapture(messageCapturePath).some(
            ({ method }) =>
              method === "thread/backgroundTerminals/terminate" ||
              method === "thread/backgroundTerminals/clean",
          ),
        ).toBe(false);
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
        restoreEnv("CODEX_FAKE_ACTIVE_TURN", previousActiveTurn);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("redacts a failed turn and preserves its accepted correlation", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-failed-turn-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "thread.json");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousFailedTurn = process.env.CODEX_FAKE_FAILED_TURN;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;
      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_FAILED_TURN = "1";

      try {
        const nativeProvider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await nativeProvider.startSession({
          cwd: tempDir,
          initialMessage: {
            text: "begin",
            uuid: "client-failed-turn",
          },
        });

        await expect(session.iterator.next()).resolves.toMatchObject({
          value: { type: "system", subtype: "init" },
        });
        await expect(session.iterator.next()).resolves.toMatchObject({
          value: {
            type: "user",
            uuid: "client-failed-turn",
            turnId: "turn-rewrite",
          },
        });
        const failed = await session.iterator.next();
        expect(failed.value).toMatchObject({
          type: "error",
          error:
            "Codex encountered an unclassified error before the task completed.",
          turnId: "turn-rewrite",
          codexTurnId: "turn-rewrite",
          clientUserMessageId: "client-failed-turn",
          codexError: expect.objectContaining({
            code: "CODEX_UNKNOWN",
            correlationId: "turn-rewrite",
          }),
        });
        expect(JSON.stringify(failed.value)).not.toContain(
          "synthetic-wire-secret",
        );
        expect(JSON.stringify(failed.value)).not.toContain("/private/provider");
        await expect(session.iterator.next()).resolves.toMatchObject({
          value: {
            type: "result",
            turnId: "turn-rewrite",
            clientUserMessageId: "client-failed-turn",
          },
        });
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_FAILED_TURN", previousFailedTurn);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("exposes only stable native controls and rejects calls until ready", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-controls-ready-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;
      process.env.CODEX_FAKE_CAPTURE = capturePath;

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({ cwd: tempDir });
        const controls = session.codexControls;
        expect(controls?.capabilities).toMatchObject({
          codexVersion: "0.147.0",
          experimentalApi: false,
          methods: {
            "skills/list": true,
            "thread/backgroundTerminals/list": false,
          },
        });
        await expect(
          controls?.invoke({ control: "skills/list" }),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: "not_ready", retryable: true },
        });

        await expect(session.iterator.next()).resolves.toMatchObject({
          value: { type: "system", subtype: "init" },
        });
        await expect(
          controls?.invoke({ control: "thread/backgroundTerminals/list" }),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: "experimental_api_disabled", retryable: false },
        });
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("maps stable native controls to exact 0.147 request contracts", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-controls-contract-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const controlCapturePath = join(tempDir, "controls.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousControlCapture = process.env.CODEX_FAKE_CONTROL_CAPTURE;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;
      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_CONTROL_CAPTURE = controlCapturePath;

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({ cwd: tempDir });
        await session.iterator.next();
        const controls = session.codexControls;
        if (!controls) throw new Error("expected Codex native controls");

        await expect(
          controls.invoke({ control: "skills/list", forceReload: true }),
        ).resolves.toMatchObject({ ok: true, data: { data: [] } });
        await expect(
          controls.invoke({
            control: "review/start",
            target: { type: "uncommittedChanges" },
            delivery: "inline",
          }),
        ).resolves.toMatchObject({
          ok: true,
          data: { reviewThreadId: "thread-new" },
        });
        await expect(
          controls.invoke({ control: "thread/compact/start" }),
        ).resolves.toMatchObject({ ok: true, data: {} });
        await expect(
          controls.invoke({ control: "thread/goal/get" }),
        ).resolves.toMatchObject({ ok: true, data: { goal: null } });
        await expect(
          controls.invoke({
            control: "thread/goal/set",
            objective: "Ship the control boundary",
            status: "active",
            tokenBudget: 40_000,
          }),
        ).resolves.toMatchObject({
          ok: true,
          data: {
            goal: {
              threadId: "thread-new",
              objective: "Ship the control boundary",
              tokenBudget: 40_000,
            },
          },
        });
        await expect(
          controls.invoke({
            control: "thread/goal/set",
            objective: "provider-invalid",
          }),
        ).resolves.toMatchObject({
          ok: false,
          control: "thread/goal/set",
          error: { code: "invalid_request", retryable: false },
        });
        await expect(
          controls.invoke({ control: "thread/goal/clear" }),
        ).resolves.toMatchObject({ ok: true, data: { cleared: true } });
        await expect(
          controls.invoke({
            control: "thread/shellCommand",
            command: "git status --short",
            confirmed: false,
          }),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: "invalid_request" },
        });
        await expect(
          controls.invoke({
            control: "thread/shellCommand",
            command: "git status --short",
            confirmed: true,
          }),
        ).resolves.toMatchObject({ ok: true, data: {} });

        const captured = readFileSync(controlCapturePath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(captured).toEqual(
          expect.arrayContaining([
            {
              method: "skills/list",
              params: { cwds: [tempDir], forceReload: true },
            },
            {
              method: "review/start",
              params: {
                threadId: "thread-new",
                target: { type: "uncommittedChanges" },
                delivery: "inline",
              },
            },
            {
              method: "thread/goal/set",
              params: {
                threadId: "thread-new",
                objective: "Ship the control boundary",
                status: "active",
                tokenBudget: 40_000,
              },
            },
            {
              method: "thread/shellCommand",
              params: {
                threadId: "thread-new",
                command: "git status --short",
              },
            },
          ]),
        );
        expect(
          captured.filter(({ method }) => method === "thread/shellCommand"),
        ).toHaveLength(1);
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_CONTROL_CAPTURE", previousControlCapture);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("adapts provider goal actions and resets state before replace", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-goal-actions-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const controlCapturePath = join(tempDir, "controls.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousControlCapture = process.env.CODEX_FAKE_CONTROL_CAPTURE;
      const previousGoal = process.env.CODEX_FAKE_GOAL_JSON;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;
      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_CONTROL_CAPTURE = controlCapturePath;
      process.env.CODEX_FAKE_GOAL_JSON = JSON.stringify({
        threadId: "thread-new",
        objective: "Existing goal",
        status: "paused",
        tokenBudget: 20_000,
        tokensUsed: 1_000,
        timeUsedSeconds: 30,
        createdAt: 1,
        updatedAt: 2,
      });

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({ cwd: tempDir });
        await session.iterator.next();
        if (!session.getGoal || !session.goalAction) {
          throw new Error("expected Codex goal controls");
        }

        await expect(session.getGoal()).resolves.toMatchObject({
          response: expect.stringContaining("Existing goal"),
          startedTurn: false,
        });
        await expect(
          session.goalAction("replace", "Replacement goal"),
        ).resolves.toMatchObject({
          response: expect.stringContaining("Replacement goal"),
          startedTurn: false,
        });
        await expect(session.goalAction("pause")).resolves.toMatchObject({
          response: expect.stringContaining("Status: Paused"),
          startedTurn: false,
        });

        const goalRequests = readFileSync(controlCapturePath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter(({ method }) => method.startsWith("thread/goal/"));
        expect(goalRequests).toEqual([
          {
            method: "thread/goal/get",
            params: { threadId: "thread-new" },
          },
          {
            method: "thread/goal/clear",
            params: { threadId: "thread-new" },
          },
          {
            method: "thread/goal/set",
            params: {
              threadId: "thread-new",
              objective: "Replacement goal",
              status: "active",
            },
          },
          {
            method: "thread/goal/set",
            params: { threadId: "thread-new", status: "paused" },
          },
        ]);
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_CONTROL_CAPTURE", previousControlCapture);
        restoreEnv("CODEX_FAKE_GOAL_JSON", previousGoal);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("reports when clear finds no Codex goal", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-goal-clear-empty-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousClearResult = process.env.CODEX_FAKE_GOAL_CLEAR_RESULT;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;
      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_GOAL_CLEAR_RESULT = "0";

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({ cwd: tempDir });
        await session.iterator.next();
        if (!session.goalAction)
          throw new Error("expected Codex goal controls");
        await expect(session.goalAction("clear")).resolves.toEqual({
          response: "No goal to clear.",
          startedTurn: false,
        });
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_GOAL_CLEAR_RESULT", previousClearResult);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("maps app-server method absence to a typed unsupported result", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-controls-unsupported-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousUnsupported = process.env.CODEX_FAKE_UNSUPPORTED_CONTROLS;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;
      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_UNSUPPORTED_CONTROLS = "1";

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({ cwd: tempDir });
        await session.iterator.next();
        await expect(
          session.codexControls?.invoke({ control: "skills/list" }),
        ).resolves.toMatchObject({
          ok: false,
          control: "skills/list",
          error: { code: "unsupported_method", retryable: false },
        });
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_UNSUPPORTED_CONTROLS", previousUnsupported);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should emit error if Codex CLI is not found", async () => {
      const noCliProvider = new CodexProvider({
        codexPath: "/nonexistent/codex",
      });

      const session = await noCliProvider.startSession({
        cwd: "/tmp",
        initialMessage: { text: "test" },
      });

      const messages: unknown[] = [];
      for await (const msg of session.iterator) {
        messages.push(msg);
        if (msg.type === "result" || msg.type === "error") break;
      }

      // Should get an error message about CLI not found
      expect(
        messages.some(
          (m: unknown) =>
            (m as { type?: string; error?: string }).type === "error" ||
            (m as { type?: string }).type === "result",
        ),
      ).toBe(true);
    });

    it("classifies startup stderr without exposing it in public errors", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-app-server-error-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const previousError = process.env.CODEX_FAKE_APP_SERVER_ERROR;
      process.env.CODEX_FAKE_APP_SERVER_ERROR =
        "invalid transport in `mcp_servers.node_repl`";

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        const session = await provider.startSession({
          cwd: tempDir,
          initialMessage: { text: "hello" },
        });
        const messages: Array<Record<string, unknown>> = [];
        for await (const message of session.iterator) {
          messages.push(message as unknown as Record<string, unknown>);
          if (message.type === "error") break;
        }

        expect(messages.at(-1)).toMatchObject({
          type: "error",
          error:
            "The Codex process exited unexpectedly before the task completed.",
          codexError: expect.objectContaining({
            code: "CODEX_PROCESS_EXITED",
            category: "process_exit",
          }),
        });
        expect(JSON.stringify(messages.at(-1))).not.toContain(
          "invalid transport in `mcp_servers.node_repl`",
        );
      } finally {
        if (previousError === undefined) {
          Reflect.deleteProperty(process.env, "CODEX_FAKE_APP_SERVER_ERROR");
        } else {
          process.env.CODEX_FAKE_APP_SERVER_ERROR = previousError;
        }
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("retries only transient overloads with bounded exponential backoff", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-app-server-overload-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "thread.json");
      const messageCapturePath = join(tempDir, "messages.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
      const previousOverloadAttempts = process.env.CODEX_FAKE_OVERLOAD_ATTEMPTS;
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MESSAGE_CAPTURE = messageCapturePath;
      process.env.CODEX_FAKE_OVERLOAD_ATTEMPTS = "2";

      try {
        const eventStore = new InMemoryCodexEventStore();
        const provider = new CodexProvider({
          codexPath: fakeCodexPath,
          eventSpine: { store: eventStore },
        });
        session = await provider.startSession({ cwd: tempDir });

        await expect(session.iterator.next()).resolves.toMatchObject({
          value: {
            type: "system",
            subtype: "warning",
            warningKind: "codex_app_server_overloaded",
            willRetry: true,
            codexRetryStatus: {
              state: "queued",
              category: "overloaded",
              retryable: true,
              attempt: 1,
              nextAttempt: 2,
              maxAttempts: 4,
              retryInMs: 50,
            },
          },
        });
        const retrying = await session.iterator.next();
        expect(retrying).toMatchObject({
          value: {
            type: "system",
            subtype: "warning",
            warningKind: "codex_app_server_overloaded",
            codexRetryStatus: {
              state: "retrying",
              attempt: 2,
              nextAttempt: 3,
              maxAttempts: 4,
              retryInMs: 100,
            },
          },
        });
        expect(JSON.stringify(retrying.value)).not.toContain("-32001");
        expect(JSON.stringify(retrying.value)).not.toContain(
          "Server overloaded; retry later.",
        );
        await expect(session.iterator.next()).resolves.toMatchObject({
          value: {
            type: "system",
            subtype: "init",
            session_id: "thread-new",
          },
        });

        const replayed = await replayCodexSession(eventStore, "thread-new");
        expect(replayed.clientRetries).toMatchObject([
          { state: "queued", attempt: 1, method: "thread/start" },
          { state: "retrying", attempt: 2, method: "thread/start" },
        ]);
        expect(JSON.stringify(replayed.clientRetries)).not.toContain("-32001");

        const attempts = readMessageCapture(messageCapturePath).filter(
          ({ method }) => method === "thread/start",
        );
        expect(attempts.map(({ attempt }) => attempt)).toEqual([1, 2, 3]);
        expect(
          (attempts[1]?.monotonicMs ?? 0) -
            (attempts[0]?.monotonicMs ?? Number.POSITIVE_INFINITY),
        ).toBeGreaterThanOrEqual(40);
        expect(
          (attempts[2]?.monotonicMs ?? 0) -
            (attempts[1]?.monotonicMs ?? Number.POSITIVE_INFINITY),
        ).toBeGreaterThanOrEqual(80);
      } finally {
        session?.abort();
        random.mockRestore();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
        restoreEnv("CODEX_FAKE_OVERLOAD_ATTEMPTS", previousOverloadAttempts);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("does not retry non-overload JSON-RPC failures", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-app-server-no-retry-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "thread.json");
      const messageCapturePath = join(tempDir, "messages.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
      const previousErrorCode = process.env.CODEX_FAKE_THREAD_START_ERROR_CODE;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MESSAGE_CAPTURE = messageCapturePath;
      process.env.CODEX_FAKE_THREAD_START_ERROR_CODE = "-32600";

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({ cwd: tempDir });

        await expect(session.iterator.next()).resolves.toMatchObject({
          value: { type: "error" },
        });
        expect(
          readMessageCapture(messageCapturePath)
            .filter(({ method }) => method === "thread/start")
            .map(({ attempt }) => attempt),
        ).toEqual([1]);
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
        restoreEnv("CODEX_FAKE_THREAD_START_ERROR_CODE", previousErrorCode);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("stops overload retries after four total attempts", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-app-server-bounded-retry-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "thread.json");
      const messageCapturePath = join(tempDir, "messages.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
      const previousOverloadAttempts = process.env.CODEX_FAKE_OVERLOAD_ATTEMPTS;
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MESSAGE_CAPTURE = messageCapturePath;
      process.env.CODEX_FAKE_OVERLOAD_ATTEMPTS = "99";

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({ cwd: tempDir });
        const messages: unknown[] = [];
        for (let index = 0; index < 4; index += 1) {
          messages.push((await session.iterator.next()).value);
        }

        expect(messages.slice(0, 3)).toMatchObject([
          { codexRetryStatus: { attempt: 1, retryInMs: 50 } },
          { codexRetryStatus: { attempt: 2, retryInMs: 100 } },
          { codexRetryStatus: { attempt: 3, retryInMs: 200 } },
        ]);
        expect(messages[3]).toMatchObject({ type: "error" });
        expect(JSON.stringify(messages[3])).not.toContain(
          "Server overloaded; retry later.",
        );
        expect(
          readMessageCapture(messageCapturePath)
            .filter(({ method }) => method === "thread/start")
            .map(({ attempt }) => attempt),
        ).toEqual([1, 2, 3, 4]);
      } finally {
        session?.abort();
        random.mockRestore();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
        restoreEnv("CODEX_FAKE_OVERLOAD_ATTEMPTS", previousOverloadAttempts);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("passes modelProvider separately and ignores provider names as model", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-app-server-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMcpServers = process.env.CODEX_FAKE_MCP_SERVERS;
      const configuredMcpServers = ["node_repl", "lark", "web"];
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MCP_SERVERS = JSON.stringify(configuredMcpServers);

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({
          cwd: tempDir,
          resumeSessionId: "thread-existing",
          model: "openai",
        });

        const first = await session.iterator.next();
        expect(first.value).toMatchObject({
          type: "system",
          subtype: "init",
          session_id: "thread-existing",
          model: "gpt-5.5",
        });
        expect(JSON.parse(readFileSync(capturePath, "utf8"))).toMatchObject({
          argv: [
            "app-server",
            "-c",
            'model_provider="openai"',
            ...getCodexMcpAppServerArgs("standard"),
            "--listen",
            "stdio://",
          ],
          method: "thread/resume",
          params: {
            threadId: "thread-existing",
            model: null,
            modelProvider: "openai",
            cwd: tempDir,
            config: {
              mcp_servers: {
                lark: { command: "fake-mcp", enabled: true },
                node_repl: { command: "fake-mcp", enabled: true },
                web: { command: "fake-mcp", enabled: false },
              },
            },
          },
        });
      } finally {
        session?.abort();
        if (previousCapturePath === undefined) {
          process.env.CODEX_FAKE_CAPTURE = undefined;
        } else {
          process.env.CODEX_FAKE_CAPTURE = previousCapturePath;
        }
        if (previousMcpServers === undefined) {
          Reflect.deleteProperty(process.env, "CODEX_FAKE_MCP_SERVERS");
        } else {
          process.env.CODEX_FAKE_MCP_SERVERS = previousMcpServers;
        }
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("uses full Codex MCP profile with all configured MCP enabled", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-app-server-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMcpServers = process.env.CODEX_FAKE_MCP_SERVERS;
      const configuredMcpServers = ["node_repl", "lark", "web"];
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MCP_SERVERS = JSON.stringify(configuredMcpServers);

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({
          cwd: tempDir,
          initialMessage: { text: "hello" },
          codexMcpMode: "full",
        });

        const first = await session.iterator.next();
        expect(first.value).toMatchObject({
          type: "system",
          subtype: "init",
          session_id: "thread-new",
          model: "gpt-5.5",
        });
        expect(JSON.parse(readFileSync(capturePath, "utf8"))).toMatchObject({
          argv: [
            "app-server",
            "-c",
            'model_provider="openai"',
            ...getCodexMcpAppServerArgs("full"),
            "--listen",
            "stdio://",
          ],
          method: "thread/start",
          params: {
            model: null,
            modelProvider: "openai",
            cwd: tempDir,
            config: {
              mcp_servers: {
                lark: { enabled: true },
                node_repl: { enabled: true },
                web: { enabled: true },
              },
            },
          },
        });
      } finally {
        session?.abort();
        if (previousCapturePath === undefined) {
          process.env.CODEX_FAKE_CAPTURE = undefined;
        } else {
          process.env.CODEX_FAKE_CAPTURE = previousCapturePath;
        }
        if (previousMcpServers === undefined) {
          Reflect.deleteProperty(process.env, "CODEX_FAKE_MCP_SERVERS");
        } else {
          process.env.CODEX_FAKE_MCP_SERVERS = previousMcpServers;
        }
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("persists and projects direct-provider events without changing MCP or permission thread config", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-event-ingress-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMcpServers = process.env.CODEX_FAKE_MCP_SERVERS;
      const previousEventMode = process.env.CODEX_FAKE_EVENT_MODE;
      const eventStore = new InMemoryCodexEventStore();
      const onToolApproval = vi.fn(async () => ({
        behavior: "allow" as const,
      }));
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MCP_SERVERS = JSON.stringify([
        "node_repl",
        "lark",
        "web",
      ]);
      process.env.CODEX_FAKE_EVENT_MODE = "1";

      try {
        const provider = new CodexProvider({
          codexPath: fakeCodexPath,
          eventSpine: { defaultMode: "primary", store: eventStore },
        });
        session = await provider.startSession({
          cwd: tempDir,
          initialMessage: { text: "event spine", uuid: "message-event-spine" },
          permissionMode: "plan",
          codexEventAccountId: "account-event-spine",
          codexEventProjectId: "project-event-spine",
          onToolApproval,
        });

        const output: unknown[] = [];
        for await (const item of session.iterator) {
          output.push(item);
          if (item.type === "result") break;
        }

        expect(JSON.parse(readFileSync(capturePath, "utf8"))).toMatchObject({
          method: "thread/start",
          params: {
            approvalPolicy: "on-request",
            sandbox: "read-only",
            config: {
              mcp_servers: {
                lark: { command: "fake-mcp", enabled: true },
                node_repl: { command: "fake-mcp", enabled: true },
                web: { command: "fake-mcp", enabled: false },
              },
            },
          },
        });
        const events = await eventStore.replay({ sessionId: "thread-new" });
        expect(
          events.map(({ method, direction }) => ({ method, direction })),
        ).toEqual([
          { method: "thread/start", direction: "client_request" },
          { method: "thread/start", direction: "client_response" },
          { method: "turn/start", direction: "client_request" },
          { method: "turn/start", direction: "client_response" },
          { method: "turn/started", direction: "server_notification" },
          { method: "item/completed", direction: "server_notification" },
          {
            method: "future/provider-event",
            direction: "server_notification",
          },
          {
            method: "item/commandExecution/requestApproval",
            direction: "server_request",
          },
          {
            method: "item/commandExecution/requestApproval",
            direction: "client_response",
          },
          { method: "turn/completed", direction: "server_notification" },
        ]);
        expect(
          events.every((event) => event.runtime.profile === "stable"),
        ).toBe(true);
        expect(events[2]).toMatchObject({
          method: "turn/start",
          direction: "client_request",
          clientMessageId: "message-event-spine",
          accountId: "account-event-spine",
          projectId: "project-event-spine",
        });
        expect(events[3]).toMatchObject({
          method: "turn/start",
          direction: "client_response",
          clientMessageId: "message-event-spine",
          turnId: "turn-rewrite",
          correlationId: events[2]?.correlationId,
        });
        expect(output).toContainEqual(
          expect.objectContaining({
            type: "assistant",
            codexThreadItemLifecycle: "completed",
            codexThreadId: "thread-new",
            codexTurnId: "turn-rewrite",
            codexEventSequence: 6,
            codexRawReasoningAllowed: false,
            codexThreadItem: expect.objectContaining({
              id: "agent-event-spine",
              type: "agentMessage",
              text: "event spine reply",
            }),
          }),
        );
        expect(output).toContainEqual(
          expect.objectContaining({
            type: "system",
            subtype: "warning",
            warningKind: "unknown_codex_notification",
          }),
        );
        expect(onToolApproval).toHaveBeenCalledWith(
          "Bash",
          expect.objectContaining({
            threadId: "thread-new",
            turnId: "turn-rewrite",
            itemId: "command-event-spine",
          }),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(JSON.stringify(events)).not.toContain("must-not-be-persisted");
        expect(JSON.stringify(output)).not.toContain("future/provider-event");
      } finally {
        session?.abort();
        if (previousCapturePath === undefined) {
          Reflect.deleteProperty(process.env, "CODEX_FAKE_CAPTURE");
        } else {
          process.env.CODEX_FAKE_CAPTURE = previousCapturePath;
        }
        if (previousMcpServers === undefined) {
          Reflect.deleteProperty(process.env, "CODEX_FAKE_MCP_SERVERS");
        } else {
          process.env.CODEX_FAKE_MCP_SERVERS = previousMcpServers;
        }
        if (previousEventMode === undefined) {
          Reflect.deleteProperty(process.env, "CODEX_FAKE_EVENT_MODE");
        } else {
          process.env.CODEX_FAKE_EVENT_MODE = previousEventMode;
        }
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("materializes a live canonical file item into a path-free managed artifact", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-generated-artifact-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const generatedPath = join(tempDir, "generated-report.pdf");
      const uploadsDir = join(tempDir, "managed-uploads");
      const capturePath = join(tempDir, "capture.json");
      const bytes = Buffer.from("%PDF-1.7\nfixture report\n");
      writeFileSync(generatedPath, bytes);
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousEventMode = process.env.CODEX_FAKE_EVENT_MODE;
      const previousGeneratedFile = process.env.CODEX_FAKE_GENERATED_FILE;
      const eventStore = new InMemoryCodexEventStore();
      const uploadManager = new UploadManager({ uploadsDir });
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_EVENT_MODE = "1";
      process.env.CODEX_FAKE_GENERATED_FILE = generatedPath;

      try {
        const provider = new CodexProvider({
          codexPath: fakeCodexPath,
          eventSpine: { defaultMode: "primary", store: eventStore },
          generatedArtifactUploadManager: uploadManager,
        });
        session = await provider.startSession({
          cwd: tempDir,
          initialMessage: {
            text: "create a fixture report",
            uuid: "message-generated-artifact",
          },
          onToolApproval: async () => ({ behavior: "allow" }),
        });

        const output: SDKMessage[] = [];
        for await (const item of session.iterator) {
          output.push(item);
          if (item.type === "result") break;
        }

        const artifactMessage = output.find((item) =>
          Array.isArray(item.codexGeneratedArtifacts),
        );
        expect(artifactMessage, JSON.stringify(output, null, 2)).toBeDefined();
        const artifacts = artifactMessage?.codexGeneratedArtifacts as
          | GeneratedArtifactManifest[]
          | undefined;
        expect(artifacts).toHaveLength(1);
        const artifact = artifacts?.[0];
        if (!artifact) throw new Error("missing generated artifact");
        expect(artifact).toMatchObject({
          managedRef: expect.stringMatching(/^upload:/),
          fileName: "generated-report.pdf",
          mimeType: "application/pdf",
          sizeBytes: bytes.length,
          source: {
            provider: "codex",
            type: "file_change",
            threadId: "thread-new",
            turnId: "turn-rewrite",
            itemId: "file-generated",
          },
        });

        const projectId = Buffer.from(tempDir).toString("base64url");
        const restored = await uploadManager.readGeneratedArtifactBytes(
          { projectId, sessionId: "thread-new" },
          {
            artifactId: artifact.id,
            managedRef: artifact.managedRef,
            fileName: artifact.fileName,
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            expiresAtMs: Date.parse(artifact.retention.expiresAt),
          },
        );
        expect(Buffer.from(restored.bytes)).toEqual(bytes);

        const events = await eventStore.replay({ sessionId: "thread-new" });
        const generatedEvent = events.find(
          (event) => event.itemId === "file-generated",
        );
        expect(generatedEvent).toMatchObject({
          method: "item/completed",
          direction: "server_notification",
        });
        await expect(
          uploadManager.listReplayableGeneratedArtifacts(
            { projectId, sessionId: "thread-new" },
            events,
          ),
        ).resolves.toEqual(artifacts);
        await expect(
          uploadManager.listReplayableGeneratedArtifacts(
            { projectId, sessionId: "thread-new" },
            events.map((event) =>
              event.itemId === "file-generated"
                ? { ...event, eventId: "different-source:1" }
                : event,
            ),
          ),
        ).resolves.toEqual([]);

        const serialized = JSON.stringify(
          output.filter(
            (item) => item.codexThreadItem?.id === "file-generated",
          ),
        );
        expect(serialized).not.toContain(tempDir);
        expect(serialized).not.toContain("fixture-only-private");
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_EVENT_MODE", previousEventMode);
        restoreEnv("CODEX_FAKE_GENERATED_FILE", previousGeneratedFile);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("forks through stable lastTurnId without mutating the source or losing thread MCP config", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-app-server-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const messageCapturePath = join(tempDir, "messages.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
      const previousSourceTurns = process.env.CODEX_FAKE_SOURCE_TURNS;
      const previousMcpServers = process.env.CODEX_FAKE_MCP_SERVERS;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MESSAGE_CAPTURE = messageCapturePath;
      process.env.CODEX_FAKE_SOURCE_TURNS = JSON.stringify([
        { id: "turn-source-1", status: "completed", items: [], error: null },
        { id: "turn-source-2", status: "completed", items: [], error: null },
        { id: "turn-source-3", status: "completed", items: [], error: null },
      ]);
      process.env.CODEX_FAKE_MCP_SERVERS = JSON.stringify(["web"]);

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({
          cwd: tempDir,
          resumeSessionId: "thread-existing",
          initialMessage: { text: "edited prompt", uuid: "message-edit" },
          rollbackNumTurns: 1,
          codexMcpMode: "clear",
        });

        const messages: Array<Record<string, unknown>> = [];
        for await (const item of session.iterator) {
          messages.push(item as unknown as Record<string, unknown>);
          if (item.subtype === "history_fork_complete") break;
        }

        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "system",
            subtype: "init",
            session_id: "thread-forked",
            forkParentSessionId: "thread-existing",
          }),
        );
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "system",
            subtype: "history_fork_complete",
            uuid: "codex-history-fork-turn-rewrite",
            session_id: "thread-forked",
            forkParentSessionId: "thread-existing",
            turnId: "turn-rewrite",
            messageUuid: "message-edit",
          }),
        );

        const requests = readMessageCapture(messageCapturePath);
        expect(
          requests.filter(({ method }) => method === "thread/resume"),
        ).toHaveLength(1);
        expect(
          requests.filter(({ method }) => method === "thread/fork"),
        ).toEqual([
          expect.objectContaining({
            params: expect.objectContaining({
              threadId: "thread-existing",
              lastTurnId: "turn-source-2",
              config: expect.objectContaining({
                mcp_servers: expect.objectContaining({
                  web: expect.objectContaining({ enabled: false }),
                }),
              }),
            }),
          }),
        ]);
        expect(
          requests.find(({ method }) => method === "thread/fork")?.params,
        ).not.toHaveProperty("beforeTurnId");
        expect(
          requests.find(({ method }) => method === "turn/start")?.params,
        ).toMatchObject({ threadId: "thread-forked" });
        expect(
          requests.some(({ method }) => method === "thread/rollback"),
        ).toBe(false);
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
        restoreEnv("CODEX_FAKE_SOURCE_TURNS", previousSourceTurns);
        restoreEnv("CODEX_FAKE_MCP_SERVERS", previousMcpServers);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("starts an empty child for a first-prompt edit and records manual lineage", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-first-fork-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const messageCapturePath = join(tempDir, "messages.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
      const previousSourceTurns = process.env.CODEX_FAKE_SOURCE_TURNS;
      const previousFirstPrompt = process.env.CODEX_FAKE_FIRST_PROMPT_FORK;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MESSAGE_CAPTURE = messageCapturePath;
      process.env.CODEX_FAKE_SOURCE_TURNS = JSON.stringify([
        { id: "turn-source-1", status: "completed", items: [], error: null },
        { id: "turn-source-2", status: "completed", items: [], error: null },
        { id: "turn-source-3", status: "completed", items: [], error: null },
      ]);
      process.env.CODEX_FAKE_FIRST_PROMPT_FORK = "1";

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({
          cwd: tempDir,
          resumeSessionId: "thread-existing",
          initialMessage: {
            text: "edited first prompt",
            uuid: "message-first",
          },
          rollbackNumTurns: 3,
        });

        await expect(session.iterator.next()).resolves.toMatchObject({
          value: {
            type: "system",
            subtype: "init",
            session_id: "thread-first-fork",
            forkParentSessionId: "thread-existing",
          },
        });
        await session.iterator.next();
        await session.iterator.next();

        const requests = readMessageCapture(messageCapturePath);
        expect(
          requests.filter(({ method }) => method === "thread/start"),
        ).toHaveLength(1);
        expect(requests.some(({ method }) => method === "thread/fork")).toBe(
          false,
        );
        expect(
          requests.some(({ method }) => method === "thread/rollback"),
        ).toBe(false);
        expect(
          requests.find(({ method }) => method === "turn/start")?.params,
        ).toMatchObject({ threadId: "thread-first-fork" });
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
        restoreEnv("CODEX_FAKE_SOURCE_TURNS", previousSourceTurns);
        restoreEnv("CODEX_FAKE_FIRST_PROMPT_FORK", previousFirstPrompt);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it.each([
      {
        name: "excluded suffix exceeds source history",
        turns: [
          { id: "turn-source-1", status: "completed", items: [], error: null },
        ],
        rollbackNumTurns: 2,
      },
      {
        name: "retained boundary is still in progress",
        turns: [
          { id: "turn-source-1", status: "completed", items: [], error: null },
          { id: "turn-source-2", status: "inProgress", items: [], error: null },
          { id: "turn-source-3", status: "completed", items: [], error: null },
        ],
        rollbackNumTurns: 1,
      },
    ])("fails closed when $name", async ({ turns, rollbackNumTurns }) => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-invalid-fork-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const messageCapturePath = join(tempDir, "messages.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
      const previousSourceTurns = process.env.CODEX_FAKE_SOURCE_TURNS;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MESSAGE_CAPTURE = messageCapturePath;
      process.env.CODEX_FAKE_SOURCE_TURNS = JSON.stringify(turns);

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({
          cwd: tempDir,
          resumeSessionId: "thread-existing",
          initialMessage: { text: "invalid edit" },
          rollbackNumTurns,
        });

        await expect(session.iterator.next()).resolves.toMatchObject({
          value: { type: "error" },
        });
        const requests = readMessageCapture(messageCapturePath);
        expect(
          requests.some(({ method }) =>
            [
              "thread/fork",
              "thread/start",
              "thread/rollback",
              "turn/start",
            ].includes(method ?? ""),
          ),
        ).toBe(false);
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
        restoreEnv("CODEX_FAKE_SOURCE_TURNS", previousSourceTurns);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it.each([
      {
        name: "replaces an exact missing rollout with create-only provenance",
        allowReplacement: true,
        errorCode: -32600,
        errorThread: "thread-provisional",
        expectsReplacement: true,
      },
      {
        name: "rejects an exact missing rollout without create-only provenance",
        allowReplacement: false,
        errorCode: -32600,
        errorThread: "thread-provisional",
        expectsReplacement: false,
      },
      {
        name: "rejects a lookalike missing-rollout error code",
        allowReplacement: true,
        errorCode: -32000,
        errorThread: "thread-provisional",
        expectsReplacement: false,
      },
      {
        name: "rejects a missing-rollout error for another thread",
        allowReplacement: true,
        errorCode: -32600,
        errorThread: "another-thread",
        expectsReplacement: false,
      },
    ])(
      "$name",
      async ({
        allowReplacement,
        errorCode,
        errorThread,
        expectsReplacement,
      }) => {
        const tempDir = mkdtempSync(
          join(require("node:os").tmpdir(), "codex-no-rollout-"),
        );
        const fakeCodexPath = writeFakeCodexAppServer(tempDir);
        const capturePath = join(tempDir, "capture.json");
        const messageCapturePath = join(tempDir, "messages.jsonl");
        const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
        const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
        const previousNoRollout = process.env.CODEX_FAKE_NO_ROLLOUT;
        const previousNoRolloutCode = process.env.CODEX_FAKE_NO_ROLLOUT_CODE;
        const previousNoRolloutThread =
          process.env.CODEX_FAKE_NO_ROLLOUT_THREAD;
        let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
          null;

        process.env.CODEX_FAKE_CAPTURE = capturePath;
        process.env.CODEX_FAKE_MESSAGE_CAPTURE = messageCapturePath;
        process.env.CODEX_FAKE_NO_ROLLOUT = "1";
        process.env.CODEX_FAKE_NO_ROLLOUT_CODE = String(errorCode);
        process.env.CODEX_FAKE_NO_ROLLOUT_THREAD = errorThread;

        try {
          const provider = new CodexProvider({ codexPath: fakeCodexPath });
          session = await provider.startSession({
            cwd: tempDir,
            resumeSessionId: "thread-provisional",
            allowMissingRolloutReplacement: allowReplacement,
            initialMessage: { text: "first prompt", uuid: "first-1" },
          });

          if (expectsReplacement) {
            await expect(session.iterator.next()).resolves.toMatchObject({
              value: {
                type: "system",
                subtype: "init",
                session_id: "thread-replacement",
              },
            });
            await expect(session.iterator.next()).resolves.toMatchObject({
              value: {
                type: "user",
                uuid: "first-1",
                session_id: "thread-replacement",
              },
            });
            await expect(session.iterator.next()).resolves.toMatchObject({
              value: { type: "result", session_id: "thread-replacement" },
            });
          } else {
            await expect(session.iterator.next()).resolves.toMatchObject({
              value: { type: "error" },
            });
          }

          const requests = readMessageCapture(messageCapturePath);
          expect(
            requests.filter(({ method }) => method === "thread/resume"),
          ).toHaveLength(1);
          expect(
            requests.filter(({ method }) => method === "thread/start"),
          ).toHaveLength(expectsReplacement ? 1 : 0);
          expect(
            requests.filter(({ method }) => method === "turn/start"),
          ).toHaveLength(expectsReplacement ? 1 : 0);
        } finally {
          session?.abort();
          restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
          restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
          restoreEnv("CODEX_FAKE_NO_ROLLOUT", previousNoRollout);
          restoreEnv("CODEX_FAKE_NO_ROLLOUT_CODE", previousNoRolloutCode);
          restoreEnv("CODEX_FAKE_NO_ROLLOUT_THREAD", previousNoRolloutThread);
          rmSync(tempDir, { recursive: true, force: true });
        }
      },
    );

    it("restarts a create-only Codex process without replaying its first turn twice", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-provisional-restart-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const messageCapturePath = join(tempDir, "messages.jsonl");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
      const previousNoRollout = process.env.CODEX_FAKE_NO_ROLLOUT;
      const previousProvisional = process.env.CODEX_FAKE_PROVISIONAL_START;
      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MESSAGE_CAPTURE = messageCapturePath;
      process.env.CODEX_FAKE_NO_ROLLOUT = "1";
      process.env.CODEX_FAKE_PROVISIONAL_START = "1";

      const provider = new CodexProvider({ codexPath: fakeCodexPath });
      const onSessionIdChanged = vi.fn(async () => undefined);
      const supervisor = new Supervisor({
        provider,
        idleTimeoutMs: 60_000,
        onSessionIdChanged,
      });

      try {
        const created = await supervisor.createSession(tempDir);
        expect("id" in created).toBe(true);
        if (!("id" in created)) throw new Error("expected a process");
        expect(created.sessionId).toBe("thread-provisional");
        expect(created.isUnmaterializedSession).toBe(true);

        const queued = await supervisor.queueMessageToSession(
          created.sessionId,
          tempDir,
          { text: "first after create", tempId: "first-after-create" },
          undefined,
          { reasoningEffort: "xhigh" },
        );
        expect(queued).toMatchObject({ success: true, restarted: true });
        if (!queued.success) throw new Error(queued.error);

        await vi.waitFor(() => {
          expect(queued.process.sessionId).toBe("thread-replacement");
          expect(queued.process.state.type).toBe("idle");
          expect(queued.process.queueDepth).toBe(0);
        });
        expect(queued.process.isUnmaterializedSession).toBe(false);
        expect(supervisor.getProcessForSession("thread-provisional")?.id).toBe(
          queued.process.id,
        );
        expect(supervisor.getProcessForSession("thread-replacement")?.id).toBe(
          queued.process.id,
        );
        expect(
          queued.process
            .getMessageHistory()
            .filter((message) => message.type === "user"),
        ).toHaveLength(1);
        expect(
          queued.process
            .getMessageHistory()
            .filter((message) => message.type === "result"),
        ).toHaveLength(1);
        expect(onSessionIdChanged).toHaveBeenCalledWith(
          "thread-provisional",
          "thread-replacement",
          created.projectId,
        );

        const requests = readMessageCapture(messageCapturePath);
        expect(
          requests.filter(({ method }) => method === "thread/start"),
        ).toHaveLength(2);
        expect(
          requests.filter(({ method }) => method === "thread/resume"),
        ).toHaveLength(1);
        expect(
          requests.filter(({ method }) => method === "turn/start"),
        ).toEqual([
          expect.objectContaining({
            params: expect.objectContaining({
              threadId: "thread-replacement",
              effort: "xhigh",
              clientUserMessageId: expect.any(String),
            }),
          }),
        ]);
      } finally {
        await supervisor.shutdown();
        restoreEnv("CODEX_FAKE_CAPTURE", previousCapturePath);
        restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
        restoreEnv("CODEX_FAKE_NO_ROLLOUT", previousNoRollout);
        restoreEnv("CODEX_FAKE_PROVISIONAL_START", previousProvisional);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("uses clear Codex MCP profile with default MCP servers disabled", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-app-server-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      const previousMcpServers = process.env.CODEX_FAKE_MCP_SERVERS;
      const configuredMcpServers = ["node_repl", "lark", "web"];
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_MCP_SERVERS = JSON.stringify(configuredMcpServers);

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({
          cwd: tempDir,
          initialMessage: { text: "hello" },
          codexMcpMode: "clear",
        });

        const first = await session.iterator.next();
        expect(first.value).toMatchObject({
          type: "system",
          subtype: "init",
          session_id: "thread-new",
          model: "gpt-5.5",
        });
        expect(JSON.parse(readFileSync(capturePath, "utf8"))).toMatchObject({
          argv: [
            "app-server",
            "-c",
            'model_provider="openai"',
            ...getCodexMcpAppServerArgs("clear"),
            "--listen",
            "stdio://",
          ],
          method: "thread/start",
          params: {
            model: null,
            modelProvider: "openai",
            cwd: tempDir,
            config: {
              mcp_servers: {
                lark: { enabled: false },
                node_repl: { enabled: false },
                web: { enabled: false },
              },
            },
          },
        });
      } finally {
        session?.abort();
        if (previousCapturePath === undefined) {
          process.env.CODEX_FAKE_CAPTURE = undefined;
        } else {
          process.env.CODEX_FAKE_CAPTURE = previousCapturePath;
        }
        if (previousMcpServers === undefined) {
          Reflect.deleteProperty(process.env, "CODEX_FAKE_MCP_SERVERS");
        } else {
          process.env.CODEX_FAKE_MCP_SERVERS = previousMcpServers;
        }
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("preserves typed JSON-RPC error codes for rejected server requests", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-server-request-error-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "messages.jsonl");
      const previousMessageCapture = process.env.CODEX_FAKE_MESSAGE_CAPTURE;
      const previousServerRequest =
        process.env.CODEX_FAKE_SERVER_REQUEST_METHOD;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;
      process.env.CODEX_FAKE_MESSAGE_CAPTURE = capturePath;
      process.env.CODEX_FAKE_SERVER_REQUEST_METHOD = "future/unknown";

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({
          cwd: tempDir,
          initialMessage: { text: "exercise server request errors" },
        });
        await session.iterator.next();
        await session.iterator.next();
        await vi.waitFor(() => {
          expect(
            readMessageCapture(capturePath).find(
              ({ id }) => id === "synthetic-server-request",
            ),
          ).toMatchObject({
            error: {
              code: -32601,
              message: "Unsupported Codex server request: future/unknown",
            },
          });
        });
      } finally {
        session?.abort();
        restoreEnv("CODEX_FAKE_MESSAGE_CAPTURE", previousMessageCapture);
        restoreEnv("CODEX_FAKE_SERVER_REQUEST_METHOD", previousServerRequest);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

describe("CodexProvider Auth File Parsing", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeAll(() => {
    // Create a temp directory to use as HOME
    tempDir = mkdtempSync(join(require("node:os").tmpdir(), "codex-test-"));
    originalHome = process.env.HOME;
  });

  afterAll(() => {
    // Restore HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    // Cleanup
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should parse valid auth.json file", async () => {
    // Create mock auth file
    const codexDir = join(tempDir, ".codex");
    require("node:fs").mkdirSync(codexDir, { recursive: true });

    const authData = {
      api_key: "test-key-123",
      expires_at: new Date(Date.now() + 86400000).toISOString(), // 1 day from now
      user: {
        email: "test@example.com",
        name: "Test User",
      },
    };

    writeFileSync(join(codexDir, "auth.json"), JSON.stringify(authData));

    // Create provider that looks in our temp directory
    // Note: This doesn't actually work because homedir() is cached,
    // but it demonstrates the intended behavior
  });

  it("should handle expired tokens", async () => {
    // Create mock auth file with expired token
    const codexDir = join(tempDir, ".codex");
    require("node:fs").mkdirSync(codexDir, { recursive: true });

    const authData = {
      api_key: "test-key-123",
      expires_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
    };

    writeFileSync(join(codexDir, "auth.json"), JSON.stringify(authData));

    // The actual test would need to mock homedir() to use tempDir
  });

  it("should handle invalid JSON in auth file", async () => {
    const codexDir = join(tempDir, ".codex");
    require("node:fs").mkdirSync(codexDir, { recursive: true });

    writeFileSync(join(codexDir, "auth.json"), "not valid json");

    // Provider should handle this gracefully
  });
});

describe("CodexProvider Event Normalization", () => {
  // Test helper to create a provider and access internal methods
  function createTestProvider(): CodexProvider {
    return new CodexProvider();
  }

  it("should have correct provider interface", () => {
    const provider = createTestProvider();

    expect(provider.name).toBe("codex");
    expect(provider.displayName).toBe("Codex");
    expect(typeof provider.isInstalled).toBe("function");
    expect(typeof provider.isAuthenticated).toBe("function");
    expect(typeof provider.getAuthStatus).toBe("function");
    expect(typeof provider.startSession).toBe("function");
  });

  it("uses one stable correlation key for agent-message lifecycle updates", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "msg-native-1",
        type: "agentMessage",
        text: "Checking the repository.",
        phase: "commentary",
      },
    };

    const started = provider.convertNotificationToSDKMessages(
      { method: "item/started", params },
      "thread-1",
      new Map(),
    );
    const completed = provider.convertNotificationToSDKMessages(
      { method: "item/completed", params },
      "thread-1",
      new Map(),
    );

    expect(started[0]?.codexCorrelationKey).toBe(
      "codex:turn-1:agent-message:msg-native-1",
    );
    expect(completed[0]?.codexCorrelationKey).toBe(
      started[0]?.codexCorrelationKey,
    );
  });

  it("normalizes command execution tool_use and tool_result to Read shape", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-read",
        type: "command_execution",
        command: "cat src/example.ts",
        aggregated_output: "line 1\nline 2",
        exit_code: 0,
        status: "completed",
      },
      "thread-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-read",
          name: "Read",
          input: { file_path: "src/example.ts" },
        },
      ],
    });
    expect(messages[1]?.message).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-read",
          content: "line 1\nline 2",
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "src/example.ts",
      },
    });
  });

  it("correlates turn completion with its native status", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-interrupted",
            status: "interrupted",
            items: [],
            error: null,
          },
        },
      },
      "thread-1",
      new Map(),
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: "system",
        subtype: "turn_complete",
        turnId: "turn-interrupted",
        turnStatus: "interrupted",
      }),
    ]);
  });

  it("projects token usage while the Codex turn is still running", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-running",
          tokenUsage: {
            total: {
              totalTokens: 168_796,
              inputTokens: 167_772,
              cachedInputTokens: 150_000,
              cacheWriteInputTokens: 0,
              outputTokens: 1_024,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 168_796,
              inputTokens: 167_772,
              cachedInputTokens: 150_000,
              cacheWriteInputTokens: 0,
              outputTokens: 1_024,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 258_400,
          },
        },
      },
      "thread-1",
      new Map(),
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: "system",
        subtype: "turn_usage",
        session_id: "thread-1",
        turnId: "turn-running",
        codexTurnId: "turn-running",
        usage: {
          input_tokens: 167_772,
          output_tokens: 1_024,
          cached_input_tokens: 150_000,
          model_context_window: 258_400,
        },
      }),
    ]);
  });

  it("uses the compacted total for live usage when fresh input is zero", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-compacted",
          tokenUsage: {
            total: {
              totalTokens: 90_000,
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 90_000,
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 258_400,
          },
        },
      },
      "thread-1",
      new Map(),
    );

    expect(messages[0]?.usage).toMatchObject({
      input_tokens: 90_000,
      model_context_window: 258_400,
    });
  });

  it("correlates item lifecycle messages and publishes terminal tool status", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-declined",
          item: {
            id: "call-declined",
            type: "commandExecution",
            command: "printf denied",
            aggregatedOutput: "",
            exitCode: null,
            status: "declined",
          },
        },
      },
      "thread-1",
      new Map(),
    );

    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).toMatchObject({
        turnId: "turn-declined",
        codexTurnId: "turn-declined",
      });
    }
    expect(messages[0]?.message).toMatchObject({
      content: [
        expect.objectContaining({
          type: "tool_use",
          id: "call-declined",
          status: "declined",
        }),
      ],
    });
  });

  it("marks failed MCP lifecycle results as errors", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-mcp-failed",
          item: {
            id: "mcp-failed",
            type: "mcpToolCall",
            server: "synthetic",
            tool: "fixture_call",
            arguments: { fixture: true },
            result: null,
            error: null,
            status: "failed",
          },
        },
      },
      "thread-1",
      new Map(),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      content: [
        expect.objectContaining({
          type: "tool_use",
          id: "mcp-failed",
          status: "failed",
        }),
      ],
    });
    expect(messages[1]?.message).toMatchObject({
      content: [
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "mcp-failed",
          is_error: true,
        }),
      ],
    });
  });

  it("normalizes shell-launcher wrapped command execution to Read shape", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-read-wrapped",
        type: "command_execution",
        command: "/bin/bash -lc \"sed -n '10,12p' src/example.ts\"",
        aggregated_output: "line 10\nline 11\nline 12",
        exit_code: 0,
        status: "completed",
      },
      "session-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-read-wrapped",
          name: "Read",
          input: { file_path: "src/example.ts", offset: 10, limit: 3 },
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "src/example.ts",
        startLine: 10,
      },
    });
  });

  it("normalizes heredoc command execution as Write with structured file result", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const content = "line 1\nline 2\n";
    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-write",
        type: "command_execution",
        command: `cat > src/generated.ts <<'EOF'\n${content}EOF`,
        aggregated_output: "",
        exit_code: 0,
        status: "completed",
      },
      "session-1",
      "turn-2",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-write",
          name: "Write",
          input: {
            file_path: "src/generated.ts",
            content,
          },
        },
      ],
    });

    const resultBlock = ((
      messages[1]?.message as { content?: unknown[] } | undefined
    )?.content ?? [])[0] as Record<string, unknown>;
    expect(resultBlock.type).toBe("tool_result");
    expect(resultBlock.tool_use_id).toBe("call-write");
    expect(resultBlock.is_error).toBeUndefined();
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "src/generated.ts",
        content,
        numLines: 2,
        startLine: 1,
        totalLines: 2,
      },
    });
  });

  it("normalizes no-match ripgrep exit code as non-error Grep result", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-grep",
        type: "command_execution",
        command: "rg -n missing_pattern src",
        aggregated_output: "",
        exit_code: 1,
        status: "completed",
      },
      "session-1",
      "turn-2",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-grep",
          name: "Grep",
          input: { pattern: "missing_pattern", path: "src" },
        },
      ],
    });

    const resultBlock = ((
      messages[1]?.message as { content?: unknown[] } | undefined
    )?.content ?? [])[0] as Record<string, unknown>;
    expect(resultBlock.type).toBe("tool_result");
    expect(resultBlock.tool_use_id).toBe("call-grep");
    expect(resultBlock.is_error).toBeUndefined();
    expect(messages[1]?.toolUseResult).toMatchObject({
      mode: "files_with_matches",
      numFiles: 0,
    });
  });

  it("normalizes imageGeneration without publishing provider savedPath", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "img-1",
            type: "imageGeneration",
            status: "completed",
            savedPath: "/tmp/generated.png",
            revisedPrompt: "A quiet product screenshot",
            result: "Image saved",
          },
        },
      },
      "session-1",
      new Map(),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "img-1",
          name: "ViewImage",
          input: {
            revised_prompt: "A quiet product screenshot",
            result: "Image saved",
            status: "completed",
            title: "Generated image",
          },
        },
      ],
    });
    expect(messages[1]?.message).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "img-1",
          content: "Image generation result: Image saved",
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "image",
      revisedPrompt: "A quiet product screenshot",
    });
    expect(JSON.stringify(messages)).not.toContain("/tmp/generated.png");
  });

  it("keeps canonical generated/file items path-free for public SDK messages", () => {
    const provider = createTestProvider() as unknown as {
      attachCanonicalCodexItem: (
        messages: Array<Record<string, unknown>>,
        event: Record<string, unknown>,
        sessionId: string,
      ) => Array<Record<string, unknown>>;
    };

    const generated = provider.attachCanonicalCodexItem(
      [],
      {
        method: "item/completed",
        payload: {
          safety: "safe",
          data: {
            item: {
              id: "img-local",
              type: "imageGeneration",
              status: "completed",
              result: "file:///private/test/generated.png",
              savedPath: "/private/test/generated.png",
            },
          },
        },
        eventId: "event-image",
        sequence: 1,
        receivedAtMs: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      "session-1",
    );
    const changed = provider.attachCanonicalCodexItem(
      [],
      {
        method: "item/completed",
        payload: {
          safety: "safe",
          data: {
            item: {
              id: "file-local",
              type: "fileChange",
              status: "completed",
              changes: [
                {
                  path: "/private/test/result.txt",
                  kind: { type: "add" },
                  diff: "+ token=must-not-be-published",
                },
              ],
            },
          },
        },
        eventId: "event-file",
        sequence: 2,
        receivedAtMs: 2,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      "session-1",
    );

    const serialized = JSON.stringify([generated, changed]);
    expect(serialized).not.toContain("/private/test");
    expect(serialized).not.toContain("must-not-be-published");
    expect(changed[0]?.codexThreadItem).toMatchObject({
      changes: [
        {
          path: "[path hidden]",
          diff: "[REDACTED:secret-diff]",
        },
      ],
    });
  });

  it("normalizes legacy image_generation_call rows without publishing saved_path", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "img-2",
            type: "image_generation_call",
            status: "generating",
            saved_path:
              "/Users/test/.codex/generated_images/session-1/ig_456.png",
            revised_prompt: "A saved generated image",
            result: "iVBORw0KGgoAAAANSUhEUgAA",
          },
        },
      },
      "session-1",
      new Map(),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "img-2",
          name: "ViewImage",
          input: {
            revised_prompt: "A saved generated image",
            status: "generating",
            title: "Generated image",
          },
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "image",
      revisedPrompt: "A saved generated image",
    });
    expect(JSON.stringify(messages)).not.toContain(
      "/Users/test/.codex/generated_images",
    );
  });

  it("summarizes inline generated images without publishing their data URI", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };
    const inlineImage = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(192, 0x61),
    ]).toString("base64");

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "img-inline",
            type: "imageGeneration",
            status: "completed",
            result: inlineImage,
          },
        },
      },
      "session-1",
      new Map(),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      content: [
        {
          input: {
            result: "[image data]",
            status: "completed",
          },
        },
      ],
    });
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain(inlineImage);
    expect(serialized).not.toContain("data:image/");
  });

  it("does not emit rate limit errors when hasCredits is false but usage is below 100%", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: {
              usedPercent: 21,
              resetsAt: 1772721801,
            },
            credits: {
              hasCredits: false,
              unlimited: false,
              balance: null,
            },
          },
        },
      },
      "session-1",
      new Map(),
    );

    expect(messages).toEqual([]);
  });

  it("does not emit synthetic errors for exhausted usage snapshots", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: {
              used_percent: 100,
              resets_at: 1772721801,
            },
            credits: {
              has_credits: false,
              unlimited: false,
              balance: null,
            },
          },
        },
      },
      "session-1",
      new Map(),
    );

    expect(messages).toEqual([]);
  });

  it("emits errors from codex error notifications", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: false,
          error: {
            message:
              "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
            codexErrorInfo: "usageLimitExceeded",
          },
        },
      },
      "session-1",
      new Map(),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "error",
      session_id: "session-1",
      error: "The Codex usage quota or context budget has been reached.",
      codexError: expect.objectContaining({
        code: "CODEX_QUOTA_EXCEEDED",
        category: "quota",
      }),
      willRetry: false,
    });
    expect(JSON.stringify(messages[0])).not.toContain("chatgpt.com");
  });

  it("keeps retrying Codex errors non-terminal", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: true,
          error: {
            message: "service unavailable at /private/secret",
            codexErrorInfo: "serverOverloaded",
          },
        },
      },
      "session-1",
      new Map(),
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: "system",
        subtype: "warning",
        warning:
          "Codex is busy and cannot process the request right now. Codex is retrying automatically; keep this turn running.",
        willRetry: true,
        codexError: expect.objectContaining({ category: "overloaded" }),
      }),
    ]);
    expect(JSON.stringify(messages)).not.toContain("/private/secret");
  });

  it("preserves the retry cause when Codex reports an unknown terminal error", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        customToolContexts?: Map<string, unknown>,
        commandOutputBuffers?: Map<string, string>,
        emitProjectionDiagnostics?: boolean,
        emitUnknownCompatibilityMessage?: boolean,
        retryableErrorsByTurnId?: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };
    const retryableErrorsByTurnId = new Map<string, unknown>();

    provider.convertNotificationToSDKMessages(
      {
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: true,
          error: {
            message: "server overloaded",
            codexErrorInfo: "serverOverloaded",
          },
        },
      },
      "session-1",
      new Map(),
      new Map(),
      new Map(),
      true,
      false,
      retryableErrorsByTurnId,
    );
    const terminal = provider.convertNotificationToSDKMessages(
      {
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: false,
          error: { message: "unknown Codex error" },
        },
      },
      "session-1",
      new Map(),
      new Map(),
      new Map(),
      true,
      false,
      retryableErrorsByTurnId,
    );

    expect(terminal).toEqual([
      expect.objectContaining({
        type: "error",
        error: "Codex is busy and cannot process the request right now.",
        willRetry: false,
        codexRetryExhausted: true,
        codexError: expect.objectContaining({
          code: "CODEX_OVERLOADED",
          category: "overloaded",
        }),
      }),
    ]);
    expect(retryableErrorsByTurnId.has("turn-1")).toBe(false);
  });

  it("streams raw code-mode exec calls and their results", () => {
    const testProvider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        customToolContexts: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };
    const contexts = new Map<string, unknown>();

    const calls = testProvider.convertNotificationToSDKMessages(
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "custom_tool_call",
            call_id: "call-exec",
            name: "exec",
            input: "const result = await tools.example({ value: 1 });",
          },
        },
      },
      "session-1",
      new Map(),
      contexts,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      turnId: "turn-1",
      codexTurnId: "turn-1",
    });
    expect(calls[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-exec",
          name: "CodexExec",
          input: {
            script: "const result = await tools.example({ value: 1 });",
          },
        },
      ],
    });

    const results = testProvider.convertNotificationToSDKMessages(
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "custom_tool_call_output",
            call_id: "call-exec",
            output: '{"ok":true}',
          },
        },
      },
      "session-1",
      new Map(),
      contexts,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      turnId: "turn-1",
      codexTurnId: "turn-1",
    });
    expect(results[0]?.message).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-exec",
          content: '{"ok":true}',
        },
      ],
    });
  });

  it("streams turn plan updates as completed UpdatePlan snapshots", () => {
    const testProvider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = testProvider.convertNotificationToSDKMessages(
      {
        method: "turn/plan/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: "Running checks",
          plan: [
            { step: "Inspect", status: "completed" },
            { step: "Test", status: "inProgress" },
          ],
        },
      },
      "thread-1",
      new Map(),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "assistant",
      session_id: "thread-1",
      uuid: "codex-plan-turn-1",
      turnId: "turn-1",
      codexTurnId: "turn-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "codex-plan-turn-1",
            name: "UpdatePlan",
            input: {
              explanation: "Running checks",
              plan: [
                { step: "Inspect", status: "completed" },
                { step: "Test", status: "in_progress" },
              ],
            },
            status: "completed",
          },
        ],
      },
    });
  });

  it("ignores turn plan updates for another thread", () => {
    const testProvider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    expect(
      testProvider.convertNotificationToSDKMessages(
        {
          method: "turn/plan/updated",
          params: {
            threadId: "thread-other",
            turnId: "turn-1",
            explanation: null,
            plan: [{ step: "Inspect", status: "pending" }],
          },
        },
        "thread-current",
        new Map(),
      ),
    ).toEqual([]);
  });

  it("adds a completed UpdatePlan block to code-mode exec snapshots", () => {
    const testProvider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        customToolContexts: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = testProvider.convertNotificationToSDKMessages(
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "custom_tool_call",
            call_id: "call-plan",
            name: "exec",
            input:
              'await tools.update_plan({plan: [{step: "Inspect", status: "pending"}]});',
          },
        },
      },
      "session-1",
      new Map(),
      new Map(),
    );

    expect(messages[0]?.message).toMatchObject({
      content: [
        {
          type: "tool_use",
          id: "call-plan",
          name: "CodexExec",
        },
        {
          type: "tool_use",
          id: "call-plan-update-plan",
          name: "UpdatePlan",
          input: {
            plan: [{ step: "Inspect", status: "pending" }],
          },
          status: "completed",
        },
      ],
    });
  });

  it("streams command output deltas into the pending tool_use block", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        customToolContexts?: Map<string, unknown>,
        commandOutputBuffers?: Map<string, string>,
      ) => Array<Record<string, unknown>>;
    };
    const buffers = new Map<string, string>();

    const first = provider.convertNotificationToSDKMessages(
      {
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-cmd",
          delta: "line one\n",
        },
      },
      "session-1",
      new Map(),
      new Map(),
      buffers,
    );
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: "assistant",
      uuid: "item-cmd-turn-1",
      turnId: "turn-1",
      codexTurnId: "turn-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "item-cmd",
            partialOutput: "line one\n",
          },
        ],
      },
    });

    const second = provider.convertNotificationToSDKMessages(
      {
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-cmd",
          delta: "line two\n",
        },
      },
      "session-1",
      new Map(),
      new Map(),
      buffers,
    );
    const block = ((second[0]?.message as { content?: unknown[] })?.content ??
      [])[0] as Record<string, unknown>;
    expect(block.partialOutput).toBe("line one\nline two\n");

    provider.convertNotificationToSDKMessages(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "item-cmd",
            type: "commandExecution",
            command: "printf 'done'",
            aggregatedOutput: "done",
            exitCode: 0,
            status: "completed",
          },
        },
      },
      "session-1",
      new Map(),
      new Map(),
      buffers,
    );
    expect(buffers.size).toBe(0);

    buffers.set("turn-1\0orphaned-item", "partial output");
    provider.convertNotificationToSDKMessages(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      },
      "session-1",
      new Map(),
      new Map(),
      buffers,
    );
    expect(buffers.size).toBe(0);
  });

  it("converts warning notifications into visible system messages", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    const warning = provider.convertNotificationToSDKMessages(
      {
        method: "warning",
        params: { threadId: "thread-1", message: "Sandbox degraded" },
      },
      "session-1",
      new Map(),
    );
    expect(warning).toHaveLength(1);
    expect(warning[0]).toMatchObject({
      type: "system",
      subtype: "warning",
      content: "Sandbox degraded",
      warningKind: "warning",
    });

    const deprecation = provider.convertNotificationToSDKMessages(
      {
        method: "deprecationNotice",
        params: { summary: "Old flag", details: "Use --new-flag instead" },
      },
      "session-1",
      new Map(),
    );
    expect(deprecation[0]).toMatchObject({
      type: "system",
      subtype: "warning",
      content: "Old flag\nUse --new-flag instead",
    });

    const rollbackDeprecation = provider.convertNotificationToSDKMessages(
      {
        method: "deprecationNotice",
        params: {
          summary: "thread/rollback is deprecated and will be removed soon",
          details: null,
        },
      },
      "session-1",
      new Map(),
    );
    expect(rollbackDeprecation[0]).toMatchObject({
      type: "system",
      subtype: "warning",
      content: "thread/rollback is deprecated and will be removed soon",
    });

    const empty = provider.convertNotificationToSDKMessages(
      { method: "configWarning", params: {} },
      "session-1",
      new Map(),
    );
    expect(empty).toEqual([]);
  });

  it("keeps unknown notifications invisible in the legacy projection", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
      ) => Array<Record<string, unknown>>;
    };

    expect(
      provider.convertNotificationToSDKMessages(
        {
          method: "future/provider-event",
          params: { authorization: "must-not-be-projected" },
        },
        "session-1",
        new Map(),
      ),
    ).toEqual([]);
  });
});

describe("CodexProvider server requests", () => {
  type ServerRequest = {
    id: string | number;
    method: string;
    params?: unknown;
  };
  type HandleServerRequest = (
    request: ServerRequest,
    options: {
      cwd: string;
      onToolApproval?: (
        toolName: string,
        input: unknown,
        options: {
          signal: AbortSignal;
          requestId?: string;
          requestMethod?: string;
          respectProviderDecision?: boolean;
        },
      ) => Promise<ToolApprovalResult>;
    },
    signal: AbortSignal,
  ) => Promise<unknown>;

  const getHandler = (provider: CodexProvider) =>
    (
      provider as unknown as {
        handleServerRequestApproval: HandleServerRequest;
      }
    ).handleServerRequestApproval.bind(provider);

  it("keeps requestUserInput pending until answers are submitted", async () => {
    const provider = new CodexProvider();
    let resolveApproval:
      | ((result: {
          behavior: "allow";
          updatedInput: unknown;
        }) => void)
      | undefined;
    const onToolApproval = vi.fn(
      async (_toolName: string, input: unknown) =>
        await new Promise<{
          behavior: "allow";
          updatedInput: unknown;
        }>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    let settled = false;
    const responsePromise = getHandler(provider)(
      {
        id: 17,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          isBlocking: true,
          autoResolutionMs: null,
          questions: [
            {
              id: "choice",
              header: "Mode",
              question: "Choose a mode",
              isOther: false,
              isSecret: false,
              options: [{ label: "Safe", description: "Use safe mode" }],
            },
            {
              id: "note",
              header: "Note",
              question: "Add a note",
              isOther: true,
              isSecret: false,
              options: null,
            },
          ],
        },
      },
      { cwd: "/workspace", onToolApproval },
      new AbortController().signal,
    ).then((response) => {
      settled = true;
      return response;
    });

    await vi.waitFor(() => expect(onToolApproval).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(onToolApproval).toHaveBeenCalledWith(
      "AskUserQuestion",
      expect.objectContaining({
        isBlocking: true,
        questions: expect.arrayContaining([
          expect.objectContaining({ id: "choice", question: "Choose a mode" }),
        ]),
      }),
      expect.objectContaining({
        requestId: "codex:number:17",
        requestMethod: "item/tool/requestUserInput",
        respectProviderDecision: true,
      }),
    );

    const input = onToolApproval.mock.calls[0]?.[1] as Record<string, unknown>;
    resolveApproval?.({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: { choice: "Safe", note: "ship it" },
      },
    });

    await expect(responsePromise).resolves.toEqual({
      answers: {
        choice: { answers: ["Safe"] },
        note: { answers: ["user_note: ship it"] },
      },
    });
  });

  it("fails closed instead of returning empty answers when user input is denied", async () => {
    await expect(
      getHandler(new CodexProvider())(
        {
          id: "question-denied",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "item-question",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "secret",
                header: "Secret",
                question: "Enter the secret",
                isOther: true,
                isSecret: true,
                options: null,
              },
            ],
          },
        },
        {
          cwd: "/workspace",
          onToolApproval: vi.fn(async () => ({
            behavior: "deny" as const,
            providerDecision: "deny" as const,
          })),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Codex tool user input request was declined");
  });

  it.each([
    ["approve_for_session", "acceptForSession"],
    [
      "approve_always",
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["git", "status"],
        },
      },
    ],
    ["approve_strict_auto_review", "accept"],
  ] as const)(
    "keeps exact command decision %s through native response mapping",
    async (providerDecision, expectedDecision) => {
      const amendment = {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["git", "status"],
        },
      };
      const onToolApproval = vi.fn(async () => ({
        behavior: "allow" as const,
        providerDecision,
      }));
      await expect(
        getHandler(new CodexProvider())(
          {
            id: `command-${providerDecision}`,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "item-command",
              startedAtMs: Date.now(),
              environmentId: null,
              command: "git status",
              cwd: "/workspace",
              availableDecisions: [
                "accept",
                "acceptForSession",
                amendment,
                "decline",
                "cancel",
              ],
            },
          },
          { cwd: "/workspace", onToolApproval },
          new AbortController().signal,
        ),
      ).resolves.toEqual({ decision: expectedDecision });
      expect(onToolApproval).toHaveBeenCalledWith(
        "Bash",
        expect.objectContaining({
          requestMethod: "item/commandExecution/requestApproval",
          availableDecisions: expect.arrayContaining([
            "accept",
            "acceptForSession",
          ]),
        }),
        expect.objectContaining({
          requestId: `codex:string:command-${providerDecision}`,
          requestMethod: "item/commandExecution/requestApproval",
          respectProviderDecision: true,
        }),
      );
    },
  );

  it("does not turn approve_always into a persistent network deny", async () => {
    await expect(
      getHandler(new CodexProvider())(
        {
          id: "command-network-deny",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "item-command",
            startedAtMs: Date.now(),
            environmentId: null,
            command: "curl example.com",
            cwd: "/workspace",
            availableDecisions: [
              "accept",
              {
                applyNetworkPolicyAmendment: {
                  network_policy_amendment: {
                    host: "example.com",
                    action: "deny",
                  },
                },
              },
              "cancel",
            ],
          },
        },
        {
          cwd: "/workspace",
          onToolApproval: vi.fn(async () => ({
            behavior: "allow" as const,
            providerDecision: "approve_always" as const,
          })),
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ decision: "accept" });
  });

  it("distinguishes explicit decline from transport cancellation", async () => {
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-command",
      startedAtMs: Date.now(),
      environmentId: null,
      command: "pnpm test",
      cwd: "/workspace",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    };
    const handler = getHandler(new CodexProvider());

    await expect(
      handler(
        {
          id: "explicit-deny",
          method: "item/commandExecution/requestApproval",
          params,
        },
        {
          cwd: "/workspace",
          onToolApproval: vi.fn(async () => ({
            behavior: "deny" as const,
            interrupt: true,
            providerDecision: "deny" as const,
          })),
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ decision: "decline" });

    await expect(
      handler(
        {
          id: "transport-abort",
          method: "item/commandExecution/requestApproval",
          params,
        },
        {
          cwd: "/workspace",
          onToolApproval: vi.fn(async () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
          }),
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ decision: "cancel" });
  });

  it.each([
    [
      "approve_for_session",
      { permissions: { network: { enabled: true } }, scope: "session" },
    ],
    [
      "approve_always",
      { permissions: { network: { enabled: true } }, scope: "session" },
    ],
    [
      "approve_strict_auto_review",
      {
        permissions: { network: { enabled: true } },
        scope: "turn",
        strictAutoReview: true,
      },
    ],
  ] as const)(
    "maps exact permissions decision %s without collapsing it",
    async (providerDecision, expected) => {
      const onToolApproval = vi.fn(async () => ({
        behavior: "allow" as const,
        providerDecision,
      }));
      await expect(
        getHandler(new CodexProvider())(
          {
            id: `permissions-${providerDecision}`,
            method: "item/permissions/requestApproval",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "item-permissions",
              environmentId: null,
              startedAtMs: Date.now(),
              cwd: "/workspace",
              reason: "Network access is required",
              permissions: {
                network: { enabled: true },
                fileSystem: null,
              },
            },
          },
          { cwd: "/workspace", onToolApproval },
          new AbortController().signal,
        ),
      ).resolves.toEqual(expected);
      expect(onToolApproval).toHaveBeenCalledWith(
        "Permissions",
        expect.objectContaining({
          approvalKind: "permissions",
          approvalPrompt: "Network access is required",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-permissions",
        }),
        expect.objectContaining({
          requestId: `codex:string:permissions-${providerDecision}`,
          requestMethod: "item/permissions/requestApproval",
          respectProviderDecision: true,
        }),
      );
    },
  );

  it.each([
    ["approve_for_session", { persist: "session" }],
    ["approve_always", { persist: "always" }],
    ["approve_strict_auto_review", null],
  ] as const)(
    "preserves exact MCP persistence decision %s",
    async (providerDecision, expectedMeta) => {
      await expect(
        getHandler(new CodexProvider())(
          {
            id: `mcp-${providerDecision}`,
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              serverName: "example",
              mode: "form",
              _meta: {
                codex_approval_kind: "mcp_tool_call",
                tool_name: "create_issue",
                persist: ["session", "always"],
              },
              message: "Allow MCP tool?",
              requestedSchema: { type: "object", properties: {} },
            },
          },
          {
            cwd: "/workspace",
            onToolApproval: vi.fn(async () => ({
              behavior: "allow" as const,
              providerDecision,
            })),
          },
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        action: "accept",
        content: null,
        _meta: expectedMeta,
      });
    },
  );

  it("explicitly owns or fails closed for every pinned ServerRequest method", async () => {
    const threadParams = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: Date.now(),
    };
    const cases: Array<{
      method: string;
      params: Record<string, unknown>;
      expected?: unknown;
      error?: string;
    }> = [
      {
        method: "item/commandExecution/requestApproval",
        params: { ...threadParams, command: "pwd", cwd: "/workspace" },
        expected: { decision: "decline" },
      },
      {
        method: "item/fileChange/requestApproval",
        params: { ...threadParams, reason: null, grantRoot: null },
        expected: { decision: "decline" },
      },
      {
        method: "item/tool/requestUserInput",
        params: {
          ...threadParams,
          isBlocking: true,
          autoResolutionMs: null,
          questions: [],
        },
        error: "No interactive input handler is available",
      },
      {
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "example",
          mode: "form",
          _meta: null,
          message: "Continue?",
          requestedSchema: { type: "object", properties: {} },
        },
        expected: { action: "decline", content: null, _meta: null },
      },
      {
        method: "item/permissions/requestApproval",
        params: {
          ...threadParams,
          environmentId: null,
          cwd: "/workspace",
          reason: null,
          permissions: { network: null, fileSystem: null },
        },
        expected: { permissions: {}, scope: "turn" },
      },
      {
        method: "item/tool/call",
        params: {},
        error: "Unsupported Codex server request: item/tool/call",
      },
      {
        method: "account/chatgptAuthTokens/refresh",
        params: {},
        error:
          "Unsupported Codex server request: account/chatgptAuthTokens/refresh",
      },
      {
        method: "attestation/generate",
        params: {},
        error: "Unsupported Codex server request: attestation/generate",
      },
      {
        method: "currentTime/read",
        params: {},
        error: "Unsupported Codex server request: currentTime/read",
      },
      {
        method: "applyPatchApproval",
        params: { fileChanges: { "/workspace/a.ts": { type: "update" } } },
        expected: { decision: "denied" },
      },
      {
        method: "execCommandApproval",
        params: { command: ["pwd"], cwd: "/workspace" },
        expected: { decision: "denied" },
      },
    ];

    expect(cases).toHaveLength(11);
    for (const testCase of cases) {
      const response = getHandler(new CodexProvider())(
        {
          id: `owner-${testCase.method}`,
          method: testCase.method,
          params: testCase.params,
        },
        { cwd: "/workspace" },
        new AbortController().signal,
      );
      if (testCase.error) {
        await expect(response).rejects.toThrow(testCase.error);
      } else {
        await expect(response).resolves.toEqual(testCase.expected);
      }
    }
  });

  it("does not silently acknowledge an unknown server request", async () => {
    await expect(
      getHandler(new CodexProvider())(
        { id: 99, method: "future/unknown", params: {} },
        { cwd: "/workspace" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unsupported Codex server request: future/unknown");
  });
});

describe("CodexProvider Configuration", () => {
  it("exposes only distinct modes and maps aliases to cf-style policy", () => {
    const codexProvider = new CodexProvider();
    const provider = codexProvider as unknown as {
      mapPermissionModeToThreadPolicy: (permissionMode?: string) => {
        approvalPolicy: string;
        sandbox: string;
      };
    };

    expect(codexProvider.permissionModes).toEqual([
      "auto",
      "plan",
      "bypassPermissions",
    ]);
    expect(provider.mapPermissionModeToThreadPolicy()).toEqual({
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    for (const alias of ["auto", "default", "acceptEdits"]) {
      expect(provider.mapPermissionModeToThreadPolicy(alias)).toEqual({
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
      });
    }
    expect(provider.mapPermissionModeToThreadPolicy("plan")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    expect(
      provider.mapPermissionModeToThreadPolicy("bypassPermissions"),
    ).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("should accept custom timeout", () => {
    const config: CodexProviderConfig = {
      timeout: 60000,
    };
    const provider = new CodexProvider(config);

    expect(provider.name).toBe("codex");
    // Can't directly verify timeout since it's private,
    // but we can verify the provider was created
  });

  it("should accept custom codex path", () => {
    const config: CodexProviderConfig = {
      codexPath: "/custom/path/to/codex",
    };
    const provider = new CodexProvider(config);

    expect(provider.name).toBe("codex");
  });

  it("should use defaults when no config provided", () => {
    const provider = new CodexProvider();

    expect(provider.name).toBe("codex");
    expect(provider.displayName).toBe("Codex");
  });

  describe("normalizeModelList", () => {
    type AppServerModel = {
      id: string;
      model?: string;
      displayName?: string;
      hidden?: boolean;
      isDefault?: boolean;
      upgrade?: string | null;
    };
    const normalize = (models: AppServerModel[]) =>
      (
        new CodexProvider() as unknown as {
          normalizeModelList: (
            m: AppServerModel[],
            source: { id: string },
          ) => Array<{ id: string }>;
        }
      ).normalizeModelList(models, { id: "openai" });

    it("ranks the account default model first", () => {
      const result = normalize([
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
        },
        { id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4" },
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          displayName: "GPT-5.5",
          isDefault: true,
        },
      ]);
      expect(result[0]?.id).toBe("gpt-5.5");
    });

    it("filters out hidden models", () => {
      const result = normalize([
        { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5" },
        {
          id: "gpt-5.3-codex",
          model: "gpt-5.3-codex",
          displayName: "GPT-5.3-Codex",
          hidden: true,
        },
      ]);
      expect(result.map((m) => m.id)).toEqual(["gpt-5.5"]);
    });
  });
});
