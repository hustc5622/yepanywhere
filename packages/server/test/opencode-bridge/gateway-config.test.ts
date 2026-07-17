import { describe, expect, it, vi } from "vitest";
import {
  buildManagedOpenCodeEnv,
  buildUserConfiguredOpenCodeEnv,
  fetchOpenCodeGatewayModels,
  getManagedOpenCodeModelRef,
  resolveOpenCodeGatewayConfig,
  resolveOpenCodeOpenAICompatibleBaseURL,
} from "../../src/opencode-bridge/gateway-config.js";

describe("OpenCode gateway configuration", () => {
  it("uses dedicated OpenCode credentials ahead of title and legacy settings", () => {
    expect(
      resolveOpenCodeGatewayConfig({
        OPENCODE_LLM_API_KEY: "opencode-key",
        OPENCODE_LLM_API_BASE: "https://gateway.example/v1/",
        OPENCODE_LLM_SUB_MODULE: "coding",
        SESSION_TITLE_LLM_API_KEY: "title-key",
        LLM_API_KEY: "legacy-key",
      }),
    ).toEqual({
      apiKey: "opencode-key",
      apiBase: "https://gateway.example/v1",
      subModule: "coding",
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
});
