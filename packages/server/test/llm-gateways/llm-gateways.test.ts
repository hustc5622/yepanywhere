import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLM_GATEWAY_CHANNEL_ID,
  fetchLlmGatewayModels,
  findLlmGatewayChannel,
  isVisibleGatewayModel,
  resolveDefaultLlmGatewayChannel,
  resolveLlmGatewayChannels,
  resolveLlmGatewayChannelsDetailed,
} from "../../src/llm-gateways/index.js";

describe("resolveDefaultLlmGatewayChannel", () => {
  it("prefers the dedicated OPENCODE_LLM_* variables over the generic aliases", () => {
    expect(
      resolveDefaultLlmGatewayChannel({
        OPENCODE_LLM_API_KEY: "opencode-key",
        OPENCODE_LLM_API_BASE: "https://gateway.example/v1/",
        OPENCODE_LLM_SUB_MODULE: "coding",
        LLM_API_KEY: "global-key",
        LLM_API_BASE: "https://global.example/v1",
        LLM_SUB_MODULE: "global-module",
      }),
    ).toEqual({
      id: DEFAULT_LLM_GATEWAY_CHANNEL_ID,
      label: "gateway.example",
      isDefault: true,
      apiKey: "opencode-key",
      apiKeyEnv: "OPENCODE_LLM_API_KEY",
      apiBase: "https://gateway.example/v1",
      subModule: "coding",
    });
  });

  it("defaults the ohmyrouter routing header and labels the known host", () => {
    expect(
      resolveDefaultLlmGatewayChannel({ LLM_API_KEY: "global-key" }),
    ).toEqual({
      id: DEFAULT_LLM_GATEWAY_CHANNEL_ID,
      label: "OhMyRouter",
      isDefault: true,
      apiKey: "global-key",
      apiKeyEnv: "LLM_API_KEY",
      apiBase: "https://api.ohmyrouter.com/v1",
      subModule: "claude-code-internal",
    });
  });

  it("records which variable supplied the key so callers can scrub it", () => {
    expect(
      resolveDefaultLlmGatewayChannel({ LLM_API_KEY: "k" })?.apiKeyEnv,
    ).toBe("LLM_API_KEY");
    expect(
      resolveDefaultLlmGatewayChannel({
        OPENCODE_LLM_API_KEY: "k",
        LLM_API_KEY: "other",
      })?.apiKeyEnv,
    ).toBe("OPENCODE_LLM_API_KEY");
  });

  it("returns null without an API key", () => {
    expect(
      resolveDefaultLlmGatewayChannel({ LLM_API_BASE: "https://x.example" }),
    ).toBeNull();
  });
});

describe("resolveLlmGatewayChannels", () => {
  it("keeps the default channel first and appends compact extra channels", () => {
    const channels = resolveLlmGatewayChannels({
      LLM_API_KEY: "old-key",
      LLM_API_BASE: "https://api.ohmyrouter.com/v1",
      NEW_LLM_API_KEY: "new-key",
      YEP_LLM_GATEWAYS:
        "aitl=https://api.appintheloop.com/v1|NEW_LLM_API_KEY|codex-internal|AppInTheLoop",
    });

    expect(channels).toEqual([
      {
        id: "default",
        label: "OhMyRouter",
        isDefault: true,
        apiKey: "old-key",
        apiKeyEnv: "LLM_API_KEY",
        apiBase: "https://api.ohmyrouter.com/v1",
        subModule: "claude-code-internal",
      },
      {
        id: "aitl",
        label: "AppInTheLoop",
        isDefault: false,
        apiKey: "new-key",
        apiKeyEnv: "NEW_LLM_API_KEY",
        apiBase: "https://api.appintheloop.com/v1",
        subModule: "codex-internal",
      },
    ]);
    expect(findLlmGatewayChannel(channels, "aitl")?.apiKey).toBe("new-key");
    expect(findLlmGatewayChannel(channels, "missing")).toBeUndefined();
  });

  it("falls back to the host name when the compact form omits the label", () => {
    const [, extra] = resolveLlmGatewayChannels({
      LLM_API_KEY: "old-key",
      NEW_LLM_API_KEY: "new-key",
      YEP_LLM_GATEWAYS:
        "aitl=https://api.appintheloop.com/v1|NEW_LLM_API_KEY|codex-internal",
    });

    expect(extra?.label).toBe("api.appintheloop.com");
  });

  it("accepts a JSON array, normalizes the base URL, and honours an explicit label", () => {
    expect(
      resolveLlmGatewayChannels({
        SECOND_KEY: "second-key",
        YEP_LLM_GATEWAYS: JSON.stringify([
          {
            id: "AITL",
            label: "App In The Loop",
            apiBase: "https://api.appintheloop.com/",
            apiKeyEnv: "SECOND_KEY",
          },
        ]),
      }),
    ).toEqual([
      {
        id: "aitl",
        label: "App In The Loop",
        isDefault: false,
        apiKey: "second-key",
        apiKeyEnv: "SECOND_KEY",
        apiBase: "https://api.appintheloop.com/v1",
      },
    ]);
  });

  it("lets an explicit empty subModule disable the per-host default", () => {
    const [channel] = resolveLlmGatewayChannels({
      OMR_KEY: "omr-key",
      YEP_LLM_GATEWAYS: JSON.stringify([
        {
          id: "omr",
          apiBase: "https://api.ohmyrouter.com/v1",
          apiKeyEnv: "OMR_KEY",
          subModule: "",
        },
      ]),
    });

    expect(channel?.subModule).toBeUndefined();
  });

  it("skips invalid entries instead of dropping the working default channel", () => {
    const { channels, problems } = resolveLlmGatewayChannelsDetailed({
      LLM_API_KEY: "old-key",
      PRESENT_KEY: "present",
      YEP_LLM_GATEWAYS: [
        "default=https://api.example/v1|PRESENT_KEY",
        "Bad Id=https://api.example/v1|PRESENT_KEY",
        "nokey=https://api.example/v1|MISSING_KEY",
        "badkey=https://api.example/v1|NOT-A-VARIABLE",
        "nobase=|PRESENT_KEY",
        "novalue",
        "ok=https://api.example/v1|PRESENT_KEY",
        "ok=https://api.other/v1|PRESENT_KEY",
      ].join(","),
    });

    expect(channels.map((channel) => channel.id)).toEqual(["default", "ok"]);
    // Parse-level problems are reported before per-entry resolution problems.
    expect(problems).toEqual([
      { entry: "novalue", reason: 'expected "id=apiBase|API_KEY_ENV"' },
      {
        entry: "default=https://api.example/v1|PRESENT_KEY",
        reason: '"default" is reserved for the LLM_API_* channel',
      },
      {
        entry: "Bad Id=https://api.example/v1|PRESENT_KEY",
        reason: "channel id must match [a-z0-9][a-z0-9_-]*",
      },
      {
        entry: "nokey=https://api.example/v1|MISSING_KEY",
        reason: "environment variable MISSING_KEY is empty",
      },
      {
        entry: "badkey=https://api.example/v1|NOT-A-VARIABLE",
        reason: "apiKeyEnv must be a valid environment variable name",
      },
      { entry: "nobase=|PRESENT_KEY", reason: "apiBase is required" },
      {
        entry: "ok=https://api.other/v1|PRESENT_KEY",
        reason: 'duplicate channel id "ok"',
      },
    ]);
  });

  it("reports invalid JSON without throwing", () => {
    const { channels, problems } = resolveLlmGatewayChannelsDetailed({
      LLM_API_KEY: "old-key",
      YEP_LLM_GATEWAYS: "[{",
    });

    expect(channels.map((channel) => channel.id)).toEqual(["default"]);
    expect(problems).toEqual([
      { entry: "YEP_LLM_GATEWAYS", reason: "value is not valid JSON" },
    ]);
  });
});

describe("isVisibleGatewayModel", () => {
  it("offers one entry per family, newest release only", () => {
    for (const id of [
      "claude-opus-4-8",
      "claude-opus-4-8-fast",
      "claude-opus-5",
      "claude-fable-5",
      "gpt-5.6",
      "gpt-5.6-sol",
      "glm-5.2",
      "kimi-k3",
      "MiniMax-M3",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]) {
      expect(isVisibleGatewayModel(id, {}), id).toBe(true);
    }
  });

  it("drops superseded releases, unrequested families, and non-chat endpoints", () => {
    for (const id of [
      "claude-opus-4-5-20251101",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "gpt-5.5",
      "gpt-image-2",
      "glm-5.1",
      "kimi-k2.7-code",
      "MiniMax-M2.7",
      "M2-her",
      "gemini-3.5-flash",
      "gemini-embedding-001",
      "doubao-seed-2-1-pro-260628",
      "mimo-v2.5-pro",
      "qwen3.7-max",
    ]) {
      expect(isVisibleGatewayModel(id, {}), id).toBe(false);
    }
  });

  it("lets the environment replace or clear the list", () => {
    expect(
      isVisibleGatewayModel("gemini-3.5-flash", {
        YEP_LLM_GATEWAY_MODELS: "",
      }),
    ).toBe(true);
    expect(
      isVisibleGatewayModel("glm-5.1", {
        YEP_LLM_GATEWAY_MODELS: "glm-5.1, kimi",
      }),
    ).toBe(true);
    expect(
      isVisibleGatewayModel("claude-opus-5", {
        YEP_LLM_GATEWAY_MODELS: "glm-5.1",
      }),
    ).toBe(false);
  });
});

describe("fetchLlmGatewayModels", () => {
  it("sends the channel's auth and routing headers", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await fetchLlmGatewayModels(
      {
        apiKey: "key",
        apiBase: "https://api.appintheloop.com/v1",
        subModule: "codex-internal",
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.appintheloop.com/v1/models",
      expect.objectContaining({
        headers: {
          accept: "application/json",
          authorization: "Bearer key",
          "X-Sub-Module": "codex-internal",
        },
      }),
    );
  });

  it("omits the routing header when the channel has no sub-module", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await fetchLlmGatewayModels(
      { apiKey: "key", apiBase: "https://api.example/v1" },
      fetchImpl,
    );

    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer key",
    });
  });

  it("normalizes a real appintheloop-shaped catalog", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-opus-5",
                owned_by: "claude",
                supported_endpoint_types: ["anthropic", "openai", "gemini"],
              },
              {
                id: "kimi-k3",
                owned_by: "moonshot",
                supported_endpoint_types: ["openai", "openai-response"],
              },
              { id: "  ", supported_endpoint_types: [] },
              { id: "__proto__", supported_endpoint_types: ["openai"] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      fetchLlmGatewayModels(
        { apiKey: "key", apiBase: "https://api.appintheloop.com/v1" },
        fetchImpl,
      ),
    ).resolves.toEqual([
      {
        id: "claude-opus-5",
        name: "claude-opus-5",
        description: "claude",
        ownedBy: "claude",
        contextWindow: undefined,
        supportedRequestProtocols: ["anthropic", "openai-compatible"],
      },
      {
        id: "kimi-k3",
        name: "kimi-k3",
        description: "moonshot",
        ownedBy: "moonshot",
        contextWindow: undefined,
        supportedRequestProtocols: ["openai-compatible"],
      },
    ]);
  });

  it("rejects a failed request and an invalid catalog", async () => {
    const failing = vi.fn(async () => new Response("nope", { status: 502 }));
    await expect(
      fetchLlmGatewayModels(
        { apiKey: "key", apiBase: "https://api.example/v1" },
        failing,
      ),
    ).rejects.toThrow("502");

    const invalid = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      fetchLlmGatewayModels(
        { apiKey: "key", apiBase: "https://api.example/v1" },
        invalid,
      ),
    ).rejects.toThrow("invalid catalog");
  });
});
