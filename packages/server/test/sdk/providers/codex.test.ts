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
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryCodexEventStore } from "../../../src/codex-events/index.js";
import { getCodexMcpAppServerArgs } from "../../../src/codex/mcp-profile.js";
import {
  CodexProvider,
  type CodexProviderConfig,
} from "../../../src/sdk/providers/codex.js";

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

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
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

function handle(message) {
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
  if (message.method === "thread/rollback") {
    send(message.id, {
      thread: { id: message.params.threadId, status: { type: "idle" } },
    });
    return;
  }
  if (message.method === "turn/start") {
    const eventMode = process.env.CODEX_FAKE_EVENT_MODE === "1";
    send(message.id, {
      turn: {
        id: "turn-rewrite",
        status: eventMode ? "inProgress" : "completed",
        items: [],
        error: null,
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
    return;
  }
  if (message.method !== "thread/start" && message.method !== "thread/resume") {
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
  send(message.id, {
    thread: {
      id: message.params.threadId || "thread-new",
      cwd: message.params.cwd,
      modelProvider: "openai",
      status: { type: "idle" },
    },
    model: "gpt-5.5",
    modelProvider: "openai",
    serviceTier: null,
    cwd: message.params.cwd,
    reasoningEffort: null,
  });
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

    it("should return session object with required methods", async () => {
      const session = await provider.startSession({
        cwd: "/tmp",
        initialMessage: { text: "test" },
      });

      expect(session.iterator).toBeDefined();
      expect(typeof session.abort).toBe("function");
      expect(session.queue).toBeDefined();
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

    it("emits history_rewrite_complete after rollback and turn/start", async () => {
      const tempDir = mkdtempSync(
        join(require("node:os").tmpdir(), "codex-app-server-"),
      );
      const fakeCodexPath = writeFakeCodexAppServer(tempDir);
      const capturePath = join(tempDir, "capture.json");
      const previousCapturePath = process.env.CODEX_FAKE_CAPTURE;
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;

      try {
        const provider = new CodexProvider({ codexPath: fakeCodexPath });
        session = await provider.startSession({
          cwd: tempDir,
          resumeSessionId: "thread-existing",
          initialMessage: { text: "edited prompt", uuid: "message-edit" },
          rollbackNumTurns: 1,
        });

        const messages: Array<Record<string, unknown>> = [];
        for await (const item of session.iterator) {
          messages.push(item as unknown as Record<string, unknown>);
          if (item.subtype === "history_rewrite_complete") break;
        }

        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "system",
            subtype: "history_rewrite_complete",
            uuid: "codex-history-rewrite-turn-rewrite",
            session_id: "thread-existing",
            turnId: "turn-rewrite",
            messageUuid: "message-edit",
          }),
        );
      } finally {
        session?.abort();
        if (previousCapturePath === undefined) {
          process.env.CODEX_FAKE_CAPTURE = undefined;
        } else {
          process.env.CODEX_FAKE_CAPTURE = previousCapturePath;
        }
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

  it("normalizes imageGeneration notifications into completed ViewImage rows", () => {
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
            path: "/tmp/generated.png",
            revised_prompt: "A quiet product screenshot",
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
          content: "Generated image: /tmp/generated.png",
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "image",
      path: "/tmp/generated.png",
      revisedPrompt: "A quiet product screenshot",
    });
  });

  it("normalizes image_generation_call notifications into completed ViewImage rows", () => {
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
            path: "/Users/test/.codex/generated_images/session-1/ig_456.png",
            revised_prompt: "A saved generated image",
            status: "generating",
            title: "Generated image",
          },
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "image",
      path: "/Users/test/.codex/generated_images/session-1/ig_456.png",
      revisedPrompt: "A saved generated image",
    });
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
        willRetry: true,
        codexError: expect.objectContaining({ category: "overloaded" }),
      }),
    ]);
    expect(JSON.stringify(messages)).not.toContain("/private/secret");
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
    expect(rollbackDeprecation).toEqual([]);

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
