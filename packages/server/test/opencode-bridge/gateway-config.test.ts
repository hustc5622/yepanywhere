import { describe, expect, it, vi } from "vitest";
import {
  buildManagedOpenCodeEnv,
  buildUserConfiguredOpenCodeEnv,
  fetchOpenCodeGatewayModels,
  gatewayResponseNeedsBuffering,
  getManagedOpenCodeModelRef,
  resolveOpenCodeGatewayConfig,
  resolveOpenCodeOpenAICompatibleBaseURL,
} from "../../src/opencode-bridge/gateway-config.js";

describe("gatewayResponseNeedsBuffering", () => {
  it("buffers GLM models by default", () => {
    expect(gatewayResponseNeedsBuffering("glm-4.6", {})).toBe(true);
    expect(gatewayResponseNeedsBuffering("zhipu/GLM-4.5", {})).toBe(true);
  });

  it("streams non-GLM models by default", () => {
    expect(gatewayResponseNeedsBuffering("kimi-k2", {})).toBe(false);
    expect(gatewayResponseNeedsBuffering("claude-sonnet-4", {})).toBe(false);
    expect(gatewayResponseNeedsBuffering(undefined, {})).toBe(false);
  });

  it("honors the force-buffer safety switch", () => {
    expect(
      gatewayResponseNeedsBuffering("kimi-k2", {
        YEP_OPENCODE_GATEWAY_FORCE_BUFFER: "true",
      }),
    ).toBe(true);
    expect(
      gatewayResponseNeedsBuffering(undefined, {
        YEP_OPENCODE_GATEWAY_FORCE_BUFFER: "true",
      }),
    ).toBe(true);
  });

  it("supports a custom comma-separated model match list", () => {
    const env = { YEP_OPENCODE_GATEWAY_BUFFER_MODELS: "kimi, foo-bar" };
    expect(gatewayResponseNeedsBuffering("kimi-k2", env)).toBe(true);
    expect(gatewayResponseNeedsBuffering("foo-bar-3", env)).toBe(true);
    // GLM is no longer matched once the list is overridden.
    expect(gatewayResponseNeedsBuffering("glm-4.6", env)).toBe(false);
  });

  it("treats a blank override as unset and disables matching with a sentinel", () => {
    // Whitespace-only override is ignored, so the GLM default still applies.
    expect(
      gatewayResponseNeedsBuffering("glm-4.6", {
        YEP_OPENCODE_GATEWAY_BUFFER_MODELS: "   ",
      }),
    ).toBe(true);
    // A non-matching sentinel effectively streams everything.
    expect(
      gatewayResponseNeedsBuffering("glm-4.6", {
        YEP_OPENCODE_GATEWAY_BUFFER_MODELS: "none",
      }),
    ).toBe(false);
  });
});

describe("OpenCode gateway configuration", () => {
  it("uses dedicated OpenCode credentials ahead of global and title settings", () => {
    expect(
      resolveOpenCodeGatewayConfig({
        OPENCODE_LLM_API_KEY: "opencode-key",
        OPENCODE_LLM_API_BASE: "https://gateway.example/v1/",
        OPENCODE_LLM_SUB_MODULE: "coding",
        SESSION_TITLE_LLM_API_KEY: "title-key",
        SESSION_TITLE_LLM_API_BASE: "https://title.example/v1",
        LLM_API_KEY: "global-key",
        LLM_API_BASE: "https://global.example/v1",
        LLM_SUB_MODULE: "global-module",
      }),
    ).toEqual({
      apiKey: "opencode-key",
      apiBase: "https://gateway.example/v1",
      subModule: "coding",
    });
  });

  it("shares global LLM settings without borrowing session-title credentials", () => {
    expect(
      resolveOpenCodeGatewayConfig({
        SESSION_TITLE_LLM_API_KEY: "stale-title-key",
        SESSION_TITLE_LLM_API_BASE: "https://title.example/v1",
        LLM_API_KEY: "global-key",
        LLM_API_BASE: "https://global.example/v1/",
        LLM_SUB_MODULE: "global-module",
      }),
    ).toEqual({
      apiKey: "global-key",
      apiBase: "https://global.example/v1",
      subModule: "global-module",
    });
  });

  it("loads models and their supported request protocols from the gateway", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: "glm-5.2",
                owned_by: "zhipu",
                supported_endpoint_types: ["openai", "anthropic"],
              },
              {
                id: "claude-sonnet",
                name: "Claude Sonnet",
                supported_endpoint_types: ["anthropic"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      fetchOpenCodeGatewayModels(
        {
          apiKey: "opencode-key",
          apiBase: "https://gateway.example/v1",
          subModule: "coding",
        },
        fetchImpl,
      ),
    ).resolves.toEqual([
      {
        id: "claude-sonnet",
        name: "Claude Sonnet",
        supportedRequestProtocols: ["anthropic"],
      },
      {
        id: "glm-5.2",
        name: "glm-5.2",
        description: "zhipu",
        ownedBy: "zhipu",
        supportedRequestProtocols: ["openai-compatible", "anthropic"],
      },
    ]);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gateway.example/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer opencode-key",
          "X-Sub-Module": "coding",
        }),
      }),
    );
  });

  it("falls back to curated per-model limits when the session omits them", () => {
    const env = buildManagedOpenCodeEnv(
      {},
      {
        apiKey: "opencode-key",
        apiBase: "https://api.ohmyrouter.com/v1",
        subModule: "claude-code-internal",
      },
      {
        sessionConfig: {
          model: "claude-opus-4-8",
          requestProtocol: "anthropic",
          capabilities: {
            reasoning: false,
            toolCall: true,
            temperature: true,
          },
        },
      },
    );
    const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<
        string,
        { models?: Record<string, Record<string, unknown>> }
      >;
    };
    // ohmyrouter's /v1/models catalog exposes no context window, so without the
    // curated fallback this model would resolve to OpenCode's 200K default.
    expect(
      content.provider?.["yep-anthropic"]?.models?.["claude-opus-4-8"]?.limit,
    ).toEqual({ context: 1_000_000, output: 128_000 });
  });

  it("declares OpenCode input modalities when managed attachments are enabled", () => {
    const env = buildManagedOpenCodeEnv(
      {},
      {
        apiKey: "opencode-key",
        apiBase: "https://gateway.example/v1",
      },
      {
        sessionConfig: {
          model: "claude-opus-5",
          requestProtocol: "anthropic",
          capabilities: { attachment: true },
        },
      },
    );
    const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<
        string,
        { models?: Record<string, Record<string, unknown>> }
      >;
    };

    expect(
      content.provider?.["yep-anthropic"]?.models?.["claude-opus-5"],
    ).toMatchObject({
      attachment: true,
      modalities: {
        input: ["text", "image", "pdf"],
        output: ["text"],
      },
    });
  });

  it("preserves explicit advanced OpenCode modalities", () => {
    const env = buildManagedOpenCodeEnv(
      {},
      {
        apiKey: "opencode-key",
        apiBase: "https://gateway.example/v1",
      },
      {
        sessionConfig: {
          model: "claude-opus-5",
          requestProtocol: "anthropic",
          capabilities: { attachment: true },
          advanced: {
            model: {
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        },
      },
    );
    const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<
        string,
        { models?: Record<string, Record<string, unknown>> }
      >;
    };

    expect(
      content.provider?.["yep-anthropic"]?.models?.["claude-opus-5"]
        ?.modalities,
    ).toEqual({ input: ["text", "image"], output: ["text"] });
  });

  it("builds an isolated OpenAI-compatible provider for the selected model", () => {
    const env = buildManagedOpenCodeEnv(
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          agent: { build: { mode: "primary" } },
        }),
      },
      {
        apiKey: "opencode-key",
        apiBase: "https://api.ohmyrouter.com/v1",
        subModule: "claude-code-internal",
      },
      {
        openAICompatibleBaseURL: "http://127.0.0.1:4520/gateway/v1",
        sessionConfig: {
          model: "glm-5.2",
          requestProtocol: "openai-compatible",
          limits: { context: 200_000, output: 32_768 },
          capabilities: {
            reasoning: false,
            toolCall: true,
            temperature: true,
          },
          advanced: {
            provider: { options: { headers: { "X-Trace": "yep" } } },
            model: { options: { thinking: { type: "disabled" } } },
          },
        },
      },
    );
    const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      model?: string;
      agent?: Record<string, unknown>;
      provider?: Record<string, Record<string, unknown>>;
    };
    const provider = content.provider?.["yep-openai-compatible"] as {
      npm?: string;
      options?: Record<string, unknown>;
      models?: Record<string, Record<string, unknown>>;
    };

    expect(env.YEP_OPENCODE_LLM_API_KEY).toBe("opencode-key");
    expect(content.model).toBe("yep-openai-compatible/glm-5.2");
    expect(content.agent?.build).toEqual({ mode: "primary" });
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options).toMatchObject({
      apiKey: "{env:YEP_OPENCODE_LLM_API_KEY}",
      baseURL: "http://127.0.0.1:4520/gateway/v1",
      headers: {
        "X-Sub-Module": "claude-code-internal",
        "X-Trace": "yep",
      },
    });
    expect(provider.models?.["glm-5.2"]).toMatchObject({
      limit: { context: 200_000, output: 32_768 },
      reasoning: false,
      tool_call: true,
      options: { thinking: { type: "disabled" } },
    });
  });

  it("uses the Anthropic AI SDK and direct gateway URL for Anthropic Messages", () => {
    const sessionConfig = {
      model: "deepseek-v4-pro",
      requestProtocol: "anthropic" as const,
      capabilities: { reasoning: true, toolCall: true },
    };
    const env = buildManagedOpenCodeEnv(
      {},
      {
        apiKey: "opencode-key",
        apiBase: "https://gateway.example/v1",
      },
      {
        openAICompatibleBaseURL: "http://127.0.0.1:4520/gateway/v1",
        sessionConfig,
      },
    );
    const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<
        string,
        { npm?: string; options?: Record<string, unknown> }
      >;
    };

    expect(getManagedOpenCodeModelRef(sessionConfig)).toBe(
      "yep-anthropic/deepseek-v4-pro",
    );
    expect(content.provider?.["yep-anthropic"]?.npm).toBe("@ai-sdk/anthropic");
    expect(content.provider?.["yep-anthropic"]?.options?.baseURL).toBe(
      "https://gateway.example/v1",
    );
  });

  it("derives the optional local OpenAI-compatible bridge URL", () => {
    expect(
      resolveOpenCodeOpenAICompatibleBaseURL({
        YEP_OPENCODE_BRIDGE_CONTROL_URL: "http://127.0.0.1:4520/",
      }),
    ).toBe("http://127.0.0.1:4520/gateway/v1");
  });

  it("does not pass generic LLM credentials into managed OpenCode children", () => {
    const env = buildManagedOpenCodeEnv(
      {
        LLM_API_KEY: "generic-key",
        LLM_API_BASE: "https://generic.example/v1",
        LLM_SUB_MODULE: "generic-module",
      },
      {
        apiKey: "opencode-key",
        apiBase: "https://api.ohmyrouter.com/v1",
      },
      {
        sessionConfig: {
          model: "glm-5.2",
          requestProtocol: "anthropic",
        },
      },
    );

    expect(env).not.toHaveProperty("LLM_API_KEY");
    expect(env).not.toHaveProperty("LLM_API_BASE");
    expect(env).not.toHaveProperty("LLM_SUB_MODULE");
    expect(env.YEP_OPENCODE_LLM_API_KEY).toBe("opencode-key");
  });

  it("keeps legacy LLM aliases available to user-configured OpenCode servers", () => {
    const env = buildUserConfiguredOpenCodeEnv(
      {
        OPENCODE_LLM_API_KEY: "dedicated-key",
      },
      {
        apiKey: "dedicated-key",
        apiBase: "https://api.ohmyrouter.com/v1",
        subModule: "claude-code-internal",
      },
    );

    expect(env.LLM_API_KEY).toBe("dedicated-key");
    expect(env.LLM_API_BASE).toBe("https://api.ohmyrouter.com/v1");
    expect(env.LLM_SUB_MODULE).toBe("claude-code-internal");
    expect(env).not.toHaveProperty("YEP_OPENCODE_LLM_API_KEY");
  });

  it("does not overwrite explicit generic LLM values in user config", () => {
    const env = buildUserConfiguredOpenCodeEnv(
      {
        LLM_API_KEY: "user-key",
        LLM_API_BASE: "https://user.example/v1",
        LLM_SUB_MODULE: "user-module",
      },
      {
        apiKey: "dedicated-key",
        apiBase: "https://api.ohmyrouter.com/v1",
        subModule: "claude-code-internal",
      },
    );

    expect(env.LLM_API_KEY).toBe("user-key");
    expect(env.LLM_API_BASE).toBe("https://user.example/v1");
    expect(env.LLM_SUB_MODULE).toBe("user-module");
  });

  it("routes matching user-configured gateway aliases through the local bridge", () => {
    const env = buildUserConfiguredOpenCodeEnv(
      {
        OPENCODE_LLM_API_BASE: "https://api.ohmyrouter.com/v1/",
        LLM_API_BASE: "https://api.ohmyrouter.com/v1",
      },
      {
        apiKey: "dedicated-key",
        apiBase: "https://api.ohmyrouter.com/v1",
      },
      { gatewayProxyBaseURL: "http://127.0.0.1:4520/gateway/v1" },
    );

    expect(env.OPENCODE_LLM_API_BASE).toBe("http://127.0.0.1:4520/gateway/v1");
    expect(env.LLM_API_BASE).toBe("http://127.0.0.1:4520/gateway/v1");
  });

  it("does not proxy an unrelated explicit user gateway alias", () => {
    const env = buildUserConfiguredOpenCodeEnv(
      { LLM_API_BASE: "https://user.example/v1" },
      {
        apiKey: "dedicated-key",
        apiBase: "https://api.ohmyrouter.com/v1",
      },
      { gatewayProxyBaseURL: "http://127.0.0.1:4520/gateway/v1" },
    );

    expect(env.LLM_API_BASE).toBe("https://user.example/v1");
  });
});
