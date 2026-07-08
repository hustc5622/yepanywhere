import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseClaudeWrapperArgs } from "../src/claude-wrapper.js";

describe("parseClaudeWrapperArgs", () => {
  beforeEach(() => {
    vi.stubEnv("YEP_SERVER_URL", undefined);
    vi.stubEnv("YEP_ANYWHERE_SERVER_URL", undefined);
    vi.stubEnv("YEP_DESKTOP_AUTH_TOKEN", undefined);
    vi.stubEnv("DESKTOP_AUTH_TOKEN", undefined);
    vi.stubEnv("YEP_OPENCODE_BRIDGE", undefined);
    vi.stubEnv("YEP_OPENCODE_BRIDGE_URL", undefined);
    vi.stubEnv("YEP_CLAUDE_BRIDGE", undefined);
    vi.stubEnv("YEP_CLAUDE_BRIDGE_URL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses explicit session options and prompt text", () => {
    const parsed = parseClaudeWrapperArgs([
      "--server",
      "http://127.0.0.1:8022/yep/",
      "--cwd",
      "/tmp/project",
      "--model",
      "sonnet",
      "--mode",
      "plan",
      "--resume",
      "session-1",
      "--poll",
      "750",
      "fix",
      "tests",
    ]);

    expect(parsed.options).toMatchObject({
      serverUrl: "http://127.0.0.1:8022/yep",
      cwd: "/tmp/project",
      model: "sonnet",
      mode: "plan",
      resumeSessionId: "session-1",
      pollIntervalMs: 750,
      prompt: "fix tests",
    });
  });

  it("uses env defaults for server and desktop token", () => {
    vi.stubEnv("YEP_SERVER_URL", "http://localhost:9000/yep/");
    vi.stubEnv("YEP_DESKTOP_AUTH_TOKEN", "desktop-token");

    const parsed = parseClaudeWrapperArgs([]);

    expect(parsed.options.serverUrl).toBe("http://localhost:9000/yep");
    expect(parsed.options.desktopToken).toBe("desktop-token");
  });

  it("parses bridge options", () => {
    const parsed = parseClaudeWrapperArgs([
      "--bridge",
      "http://127.0.0.1:4520/",
      "--no-bridge",
    ]);

    expect(parsed.options.bridgeUrl).toBe("http://127.0.0.1:4520");
    expect(parsed.options.useBridge).toBe(false);
    expect(parsed.options.bridgeRequired).toBe(false);
  });

  it("prefers OpenCode bridge env defaults", () => {
    vi.stubEnv("YEP_OPENCODE_BRIDGE_URL", "http://127.0.0.1:4620/");

    const parsed = parseClaudeWrapperArgs([]);

    expect(parsed.options.bridgeUrl).toBe("http://127.0.0.1:4620");
    expect(parsed.options.bridgeRequired).toBe(true);
  });

  it("supports -- separator for prompt text beginning with dashes", () => {
    const parsed = parseClaudeWrapperArgs(["--", "--explain", "flags"]);

    expect(parsed.options.prompt).toBe("--explain flags");
  });

  it("rejects invalid permission modes", () => {
    expect(() => parseClaudeWrapperArgs(["--mode", "invalid"])).toThrow(
      /Invalid --mode value/,
    );
  });
});
