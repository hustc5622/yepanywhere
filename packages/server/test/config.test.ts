import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual([
      "/tmp/yep-data/uploads",
      "/tmp/codex-home/generated_images",
    ]);
  });

  it("merges managed uploads with configured local-image paths", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home");
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "/tmp, /var/tmp, /tmp");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual([
      "/tmp/yep-data/uploads",
      "/tmp/codex-home/generated_images",
      "/tmp",
      "/var/tmp",
    ]);
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

  it("uses light and clear Codex bridge upstream args by default and keeps full profile unrestricted", async () => {
    vi.stubEnv("YEP_CODEX_BRIDGE_LIGHT_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_CLEAR_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_FULL_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_UPSTREAM_ARGS", undefined);
    vi.stubEnv("CODEX_BRIDGE_UPSTREAM_ARGS", undefined);

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexBridgeLightUpstreamArgs).toEqual([
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "-c",
      "mcp_servers.chrome-devtools.enabled=false",
    ]);
    expect(config.codexBridgeClearUpstreamArgs).toEqual([
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
    ]);
    expect(config.codexBridgeFullUpstreamArgs).toEqual([]);
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
    expect(config.codexBridgeClearUpstreamArgs).toEqual([
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
    ]);
    expect(config.codexBridgeFullUpstreamArgs).toEqual([]);
  });

  it("uses safe OpenCode bridge defaults", async () => {
    vi.stubEnv("PORT", undefined);
    vi.stubEnv("YEP_OPENCODE_BRIDGE_HOST", undefined);
    vi.stubEnv("YEP_OPENCODE_BRIDGE_PORT", undefined);
    vi.stubEnv("YEP_OPENCODE_BRIDGE_CONTROL_URL", undefined);
    vi.stubEnv("YEP_OPENCODE_BRIDGE_UPSTREAM_URL", undefined);
    vi.stubEnv("OPENCODE_BRIDGE_UPSTREAM_URL", undefined);
    vi.stubEnv("YEP_OPENCODE_SERVER_URL", undefined);
    vi.stubEnv("YEP_OPENCODE_SERVER_START_PORT", undefined);
    vi.stubEnv("YEP_OPENCODE_PORT", undefined);
    vi.stubEnv("YEP_SERVER_URL", undefined);
    vi.stubEnv("YEP_ANYWHERE_SERVER_URL", undefined);

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.opencodeBridgeHost).toBe("127.0.0.1");
    expect(config.opencodeBridgePort).toBe(4520);
    expect(config.opencodeBridgeControlUrl).toBe("http://127.0.0.1:4520");
    expect(config.opencodeBridgeServerUrl).toBe("http://127.0.0.1:3400");
    expect(config.opencodeServerUrl).toBeUndefined();
    expect(config.opencodeServerStartPort).toBe(4521);
  });

  it("parses OpenCode bridge env overrides", async () => {
    vi.stubEnv("YEP_OPENCODE_BRIDGE_HOST", "localhost");
    vi.stubEnv("YEP_OPENCODE_BRIDGE_PORT", "4620");
    vi.stubEnv("YEP_OPENCODE_BRIDGE_CONTROL_URL", "http://localhost:4621");
    vi.stubEnv("YEP_SERVER_URL", "http://127.0.0.1:8022/yep");
    vi.stubEnv("YEP_OPENCODE_BRIDGE_UPSTREAM_URL", "http://127.0.0.1:4621");
    vi.stubEnv("YEP_OPENCODE_SERVER_START_PORT", "4622");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.opencodeBridgeHost).toBe("localhost");
    expect(config.opencodeBridgePort).toBe(4620);
    expect(config.opencodeBridgeControlUrl).toBe("http://localhost:4621");
    expect(config.opencodeBridgeServerUrl).toBe("http://127.0.0.1:8022/yep");
    expect(config.opencodeServerUrl).toBe("http://127.0.0.1:4621");
    expect(config.opencodeServerStartPort).toBe(4622);
  });

  it("does not treat the OpenCode shell server URL as a bridge upstream override", async () => {
    vi.stubEnv("YEP_OPENCODE_SERVER_URL", "http://127.0.0.1:4521");
    vi.stubEnv("YEP_OPENCODE_PORT", "4521");
    vi.stubEnv("YEP_OPENCODE_BRIDGE_UPSTREAM_URL", undefined);
    vi.stubEnv("OPENCODE_BRIDGE_UPSTREAM_URL", undefined);

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.opencodeServerUrl).toBeUndefined();
    expect(config.opencodeServerStartPort).toBe(4521);
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
