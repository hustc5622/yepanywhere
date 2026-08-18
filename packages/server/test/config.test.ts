import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_CLEAR_MCP_APP_SERVER_ARGS,
  CODEX_FULL_MCP_APP_SERVER_ARGS,
  CODEX_STANDARD_MCP_APP_SERVER_ARGS,
  type CodexMcpConfigEntry,
  getCodexMcpAppServerArgs,
  getCodexMcpConfigEntries,
  getCodexMcpThreadConfig,
  resolveCodexMcpThreadProfile,
} from "../src/codex/mcp-profile.js";

describe("loadConfig codex paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses CODEX_HOME/sessions when CODEX_SESSIONS_DIR is unset", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/custom-codex-home");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe("/tmp/custom-codex-home/sessions");
  });

  it("prefers CODEX_SESSIONS_DIR over CODEX_HOME", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/custom-codex-home");
    vi.stubEnv("CODEX_SESSIONS_DIR", "/tmp/explicit-codex-sessions");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe("/tmp/explicit-codex-sessions");
  });

  it("falls back to ~/.codex/sessions when neither env var is set", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe(
      path.join(os.homedir(), ".codex", "sessions"),
    );
  });

  it("always allows the managed uploads directory for local-image", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home");
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("KIMI_SESSIONS_DIR", "/tmp/kimi-home/sessions");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual([
      "/tmp/yep-data/uploads",
      "/tmp/codex-home/generated_images",
      "/tmp/kimi-home/sessions",
    ]);
  });

  it("merges managed uploads with configured local-image paths", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home");
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("KIMI_SESSIONS_DIR", "/tmp/kimi-home/sessions");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "/tmp, /var/tmp, /tmp");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual([
      "/tmp/yep-data/uploads",
      "/tmp/codex-home/generated_images",
      "/tmp/kimi-home/sessions",
      "/tmp",
      "/var/tmp",
    ]);
  });

  it("does not allow an empty Kimi sessions path to become an image prefix", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home");
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("KIMI_CODE_HOME", "/tmp/kimi-home");
    vi.stubEnv("KIMI_SESSIONS_DIR", "");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.kimiSessionsDir).toBe("/tmp/kimi-home/sessions");
    expect(config.allowedImagePaths).toEqual([
      "/tmp/yep-data/uploads",
      "/tmp/codex-home/generated_images",
      "/tmp/kimi-home/sessions",
    ]);
    expect(config.allowedImagePaths).not.toContain("");
  });

  it("allows Codex home and configured roots for local text files", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home");
    vi.stubEnv("ALLOWED_LOCAL_FILE_PATHS", "/tmp/reports, /tmp/reports");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedLocalFilePaths).toEqual([
      "/tmp/codex-home",
      "/tmp/reports",
    ]);
  });

  it("uses the standard, clear, and full Codex bridge profiles by default", async () => {
    vi.stubEnv("YEP_CODEX_BRIDGE_LIGHT_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_CLEAR_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_FULL_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_UPSTREAM_ARGS", undefined);
    vi.stubEnv("CODEX_BRIDGE_UPSTREAM_ARGS", undefined);

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexBridgeLightUpstreamArgs).toEqual(
      CODEX_STANDARD_MCP_APP_SERVER_ARGS,
    );
    expect(config.codexBridgeClearUpstreamArgs).toEqual(
      CODEX_CLEAR_MCP_APP_SERVER_ARGS,
    );
    expect(config.codexBridgeFullUpstreamArgs).toEqual(
      CODEX_FULL_MCP_APP_SERVER_ARGS,
    );
  });

  it("applies MCP enablement only to discovered servers", () => {
    const configuredServerIds = [
      "node_repl",
      "lark",
      "feishu-mcp",
      "chrome-devtools",
      "custom.server",
    ];
    const entries: CodexMcpConfigEntry[] = configuredServerIds.map((name) => ({
      name,
      transport: {
        type: "stdio",
        command: "fake-mcp",
      },
    }));

    const standard = getCodexMcpThreadConfig("standard", entries).mcp_servers;
    const clear = getCodexMcpThreadConfig("clear", entries).mcp_servers;
    const full = getCodexMcpThreadConfig("full", entries).mcp_servers;

    expect(
      Object.fromEntries(
        Object.entries(standard).map(([name, config]) => [
          name,
          config.enabled,
        ]),
      ),
    ).toEqual({
      node_repl: true,
      lark: true,
      "feishu-mcp": true,
      "chrome-devtools": false,
      "custom.server": false,
    });
    expect(
      Object.values(clear).every((config) => config.enabled === false),
    ).toBe(true);
    expect(Object.values(full).every((config) => config.enabled === true)).toBe(
      true,
    );
    expect(standard["chrome-devtools"]).toMatchObject({
      command: "fake-mcp",
      enabled: false,
    });
    expect(standard["chrome-devtools"]).not.toHaveProperty("args");
    expect(standard.web).toBeUndefined();
  });

  it("extracts only MCP transports from effective Codex config", () => {
    expect(
      getCodexMcpConfigEntries({
        mcp_servers: {
          local: {
            command: "npx",
            args: ["-y", "local-mcp"],
            env: { SECRET: "do-not-copy" },
          },
          remote: {
            url: "https://mcp.example.test",
            http_headers: { Authorization: "do-not-copy" },
          },
        },
      }),
    ).toEqual([
      { name: "local", transport: { type: "stdio", command: "npx" } },
      {
        name: "remote",
        transport: {
          type: "streamable_http",
          url: "https://mcp.example.test",
        },
      },
    ]);
  });

  it("merges client MCP fields while keeping the selected profile authoritative", () => {
    const resolved = resolveCodexMcpThreadProfile(
      "standard",
      {
        mcp_servers: {
          node_repl: { command: "/base/node-repl", args: ["--base"] },
          "project.custom": { url: "https://base.example.test" },
        },
      },
      {
        mcp_servers: {
          node_repl: { args: ["--client"], enabled: false },
          client_only: {
            command: "/client/mcp",
            env: { CLIENT_VALUE: "kept" },
            enabled: true,
          },
        },
      },
    );

    expect(resolved.configuredServerIds).toEqual([
      "client_only",
      "node_repl",
      "project.custom",
    ]);
    expect(resolved.clientExpectedDisabledServerIds).toEqual([
      "client_only",
      "project.custom",
    ]);
    expect(resolved.threadConfig.mcp_servers).toEqual({
      client_only: {
        command: "/client/mcp",
        env: { CLIENT_VALUE: "kept" },
        enabled: false,
      },
      node_repl: {
        command: "/base/node-repl",
        args: ["--client"],
        enabled: true,
      },
      "project.custom": {
        url: "https://base.example.test",
        enabled: false,
      },
    });
  });

  it("removes stale MCP enablement from custom bridge args", () => {
    expect(
      getCodexMcpAppServerArgs("clear", [
        "--disable",
        "apps",
        "-c",
        "mcp_servers.missing.enabled=false",
        "--config",
        "mcp_servers.also-missing.enabled=true",
        "-c",
        'model_provider="openai"',
      ]),
    ).toEqual(["--disable", "apps", "-c", 'model_provider="openai"']);
  });

  it("parses profile-specific Codex bridge upstream args from env", async () => {
    vi.stubEnv("YEP_CODEX_BRIDGE_LIGHT_UPSTREAM_ARGS", "");
    vi.stubEnv(
      "YEP_CODEX_BRIDGE_CLEAR_UPSTREAM_ARGS",
      '["--disable","apps","-c","mcp_servers.foo.enabled=false"]',
    );
    vi.stubEnv(
      "YEP_CODEX_BRIDGE_FULL_UPSTREAM_ARGS",
      '["--enable","apps","-c","x.y=true"]',
    );
    vi.stubEnv("YEP_CODEX_BRIDGE_UPSTREAM_ARGS", "--legacy ignored");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexBridgeLightUpstreamArgs).toEqual([]);
    expect(config.codexBridgeClearUpstreamArgs).toEqual([
      "--disable",
      "apps",
      "-c",
      "mcp_servers.foo.enabled=false",
    ]);
    expect(config.codexBridgeFullUpstreamArgs).toEqual([
      "--enable",
      "apps",
      "-c",
      "x.y=true",
    ]);
  });

  it("keeps legacy Codex bridge upstream args as a light-profile override only", async () => {
    vi.stubEnv("YEP_CODEX_BRIDGE_LIGHT_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_CLEAR_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_FULL_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_UPSTREAM_ARGS", "--disable apps");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexBridgeLightUpstreamArgs).toEqual(["--disable", "apps"]);
    expect(config.codexBridgeClearUpstreamArgs).toEqual(
      CODEX_CLEAR_MCP_APP_SERVER_ARGS,
    );
    expect(config.codexBridgeFullUpstreamArgs).toEqual(
      CODEX_FULL_MCP_APP_SERVER_ARGS,
    );
  });

  it("keeps the agent runtime embedded by default", async () => {
    vi.stubEnv("PORT", "8022");
    vi.stubEnv("YEP_RUNTIME_MODE", undefined);
    vi.stubEnv("YEP_RUNTIME_PORT", undefined);
    vi.stubEnv("YEP_RUNTIME_CONTROL_URL", undefined);
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", "/tmp/yep-runtime-config");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.runtimeMode).toBe("embedded");
    expect(config.runtimePort).toBe(8025);
    expect(config.runtimeControlUrl).toBe("http://127.0.0.1:8025");
    expect(config.runtimeTokenFile).toBe(
      "/tmp/yep-runtime-config/runtime/token",
    );
  });

  it("parses external agent runtime overrides", async () => {
    vi.stubEnv("YEP_RUNTIME_MODE", "external");
    vi.stubEnv("YEP_RUNTIME_PORT", "9025");
    vi.stubEnv("YEP_RUNTIME_CONTROL_URL", "http://localhost:9026");
    vi.stubEnv("YEP_RUNTIME_TOKEN_FILE", "/tmp/runtime-token");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.runtimeMode).toBe("external");
    expect(config.runtimePort).toBe(9025);
    expect(config.runtimeControlUrl).toBe("http://localhost:9026");
    expect(config.runtimeTokenFile).toBe("/tmp/runtime-token");
  });

  it("defaults session title submodule for ohmyrouter", async () => {
    vi.stubEnv("SESSION_TITLE_LLM_API_KEY", "test-key");
    vi.stubEnv("SESSION_TITLE_LLM_API_BASE", "https://api.ohmyrouter.com");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.sessionTitleGeneration.enabled).toBe(true);
    expect(config.sessionTitleGeneration.subModule).toBe(
      "claude-code-internal",
    );
    expect(config.sessionTitleGeneration.model).toBe("deepseek-v4-pro");
    expect(config.sessionTitleGeneration).toMatchObject({
      retryMaxAttempts: 3,
      retryBaseDelayMs: 5000,
      retryMaxDelayMs: 60000,
      startupBackfillWindowMs: 7 * 24 * 60 * 60 * 1000,
      startupBackfillLimit: 25,
      startupBackfillConcurrency: 2,
      startupBackfillMaxProjects: 20,
    });
  });

  it("allows session title submodule override", async () => {
    vi.stubEnv("SESSION_TITLE_LLM_API_KEY", "test-key");
    vi.stubEnv("SESSION_TITLE_LLM_API_BASE", "https://api.example.com");
    vi.stubEnv("SESSION_TITLE_SUB_MODULE", "custom-submodule");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.sessionTitleGeneration.subModule).toBe("custom-submodule");
  });
});
