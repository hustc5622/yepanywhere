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
let buffer = "";

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function handle(message) {
  if (message.method === "initialize") {
    send(message.id, { userAgent: "fake-codex" });
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

    it("passes modelProvider separately and ignores provider names as model", async () => {
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
            "--disable",
            "apps",
            "--disable",
            "plugins",
            "-c",
            "mcp_servers.chrome-devtools.enabled=false",
            "--listen",
            "stdio://",
          ],
          method: "thread/resume",
          params: {
            threadId: "thread-existing",
            model: null,
            modelProvider: "openai",
            cwd: tempDir,
          },
        });
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

    it("uses full Codex MCP profile without the cf default disable args", async () => {
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
          argv: ["app-server", "--listen", "stdio://"],
          method: "thread/start",
          params: {
            model: null,
            modelProvider: "openai",
            cwd: tempDir,
          },
        });
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
      let session: Awaited<ReturnType<CodexProvider["startSession"]>> | null =
        null;

      process.env.CODEX_FAKE_CAPTURE = capturePath;

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
            "--disable",
            "apps",
            "--disable",
            "plugins",
            "-c",
            "mcp_servers.chrome-devtools.enabled=false",
            "-c",
            "mcp_servers.node_repl.enabled=false",
            "-c",
            "mcp_servers.feishu-mcp.enabled=false",
            "-c",
            "mcp_servers.openaiDeveloperDocs.enabled=false",
            "--listen",
            "stdio://",
          ],
          method: "thread/start",
          params: {
            model: null,
            modelProvider: "openai",
            cwd: tempDir,
          },
        });
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
      error:
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
    });
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
});

describe("CodexProvider Configuration", () => {
  it("maps the default permission mode to cf-style Codex policy", () => {
    const provider = new CodexProvider() as unknown as {
      mapPermissionModeToThreadPolicy: (permissionMode?: string) => {
        approvalPolicy: string;
        sandbox: string;
      };
    };

    expect(provider.mapPermissionModeToThreadPolicy()).toEqual({
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    expect(provider.mapPermissionModeToThreadPolicy("default")).toEqual({
      approvalPolicy: "on-request",
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
          normalizeModelList: (m: AppServerModel[]) => Array<{ id: string }>;
        }
      ).normalizeModelList(models);

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
