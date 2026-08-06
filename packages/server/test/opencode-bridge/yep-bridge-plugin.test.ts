import { afterEach, describe, expect, it, vi } from "vitest";
import { YepBridge } from "../../resources/opencode-plugin/yep-bridge.js";

const originalArgv = [...process.argv];

function setOpenCodeArgv(...args: string[]): void {
  process.argv = [process.execPath, "/test/opencode", ...args];
}

describe("Yep OpenCode bridge plugin", () => {
  afterEach(() => {
    process.argv = [...originalArgv];
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps only the matching managed serve process inert", async () => {
    setOpenCodeArgv("serve", "--hostname", "127.0.0.1", "--port", "4521");
    vi.stubEnv("YEP_MANAGED_OPENCODE", "1");
    vi.stubEnv("YEP_MANAGED_OPENCODE_SERVER_PORT", "4521");
    vi.stubEnv("YEP_OPENCODE_PLUGIN_DISABLE", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const hooks = await YepBridge({ client: {}, directory: "/repo" });

    expect(hooks).toHaveProperty("config");
    expect(hooks).not.toHaveProperty("event");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.env.YEP_MANAGED_OPENCODE).toBeUndefined();
    expect(process.env.YEP_MANAGED_OPENCODE_SERVER_PORT).toBeUndefined();
  });

  it("enables forwarding for an inherited marker in a nested run", async () => {
    setOpenCodeArgv("run", "--format", "json", "hello");
    vi.stubEnv("YEP_MANAGED_OPENCODE", "1");
    vi.stubEnv("YEP_MANAGED_OPENCODE_SERVER_PORT", "4521");
    vi.stubEnv("YEP_OPENCODE_PLUGIN_DISABLE", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    const hooks = await YepBridge({ client: {}, directory: "/repo" });

    expect(hooks).toHaveProperty("event");
    expect(process.env.YEP_MANAGED_OPENCODE).toBeUndefined();
    expect(process.env.YEP_MANAGED_OPENCODE_SERVER_PORT).toBeUndefined();
  });

  it("does not silence a serve process whose port does not match the marker", async () => {
    setOpenCodeArgv("serve", "--port", "5999");
    vi.stubEnv("YEP_MANAGED_OPENCODE", "1");
    vi.stubEnv("YEP_MANAGED_OPENCODE_SERVER_PORT", "4521");
    vi.stubEnv("YEP_OPENCODE_PLUGIN_DISABLE", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    const hooks = await YepBridge({ client: {}, directory: "/repo" });

    expect(hooks).toHaveProperty("event");
    expect(process.env.YEP_MANAGED_OPENCODE).toBeUndefined();
    expect(process.env.YEP_MANAGED_OPENCODE_SERVER_PORT).toBeUndefined();
  });

  it("repairs a legacy inherited marker without a scoped port", async () => {
    setOpenCodeArgv("run", "hello");
    vi.stubEnv("YEP_MANAGED_OPENCODE", "1");
    vi.stubEnv("YEP_MANAGED_OPENCODE_SERVER_PORT", undefined);
    vi.stubEnv("YEP_OPENCODE_PLUGIN_DISABLE", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    const hooks = await YepBridge({ client: {}, directory: "/repo" });

    expect(hooks).toHaveProperty("event");
    expect(process.env.YEP_MANAGED_OPENCODE).toBeUndefined();
  });

  it("keeps a legacy managed serve process compatible", async () => {
    setOpenCodeArgv("serve", "--port", "4521");
    vi.stubEnv("YEP_MANAGED_OPENCODE", "1");
    vi.stubEnv("YEP_MANAGED_OPENCODE_SERVER_PORT", undefined);
    vi.stubEnv("YEP_OPENCODE_PLUGIN_DISABLE", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const hooks = await YepBridge({ client: {}, directory: "/repo" });

    expect(hooks).toHaveProperty("config");
    expect(hooks).not.toHaveProperty("event");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.env.YEP_MANAGED_OPENCODE).toBeUndefined();
  });

  it("sanitizes top-level tool composition for every Anthropic SDK channel", async () => {
    setOpenCodeArgv("serve", "--port", "4521");
    vi.stubEnv("YEP_MANAGED_OPENCODE", "1");
    vi.stubEnv("YEP_MANAGED_OPENCODE_SERVER_PORT", "4521");
    vi.stubEnv("YEP_OPENCODE_PLUGIN_DISABLE", "");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const hooks = await YepBridge({ client: {}, directory: "/repo" });
    if (!("config" in hooks) || !hooks.config) {
      throw new Error("Expected the OpenCode config hook to be enabled");
    }
    const config = {
      provider: {
        mafia: {
          npm: "@ai-sdk/anthropic",
          options: { baseURL: "https://api.appintheloop.com/v1" },
        },
        gemini: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://generativelanguage.googleapis.com/v1" },
        },
      },
    };
    await hooks.config(config);

    const mafiaFetch = config.provider.mafia.options.fetch;
    expect(mafiaFetch).toBeTypeOf("function");
    expect(config.provider.gemini.options).not.toHaveProperty("fetch");

    await mafiaFetch("https://api.appintheloop.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "999",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        tools: [
          {
            name: "feishu-mcp_update-doc",
            input_schema: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    command: { type: "string" },
                  },
                },
                {
                  type: "object",
                  properties: {
                    mode: { type: "string" },
                  },
                },
              ],
              properties: {
                selection: {
                  oneOf: [{ type: "string" }, { type: "number" }],
                },
              },
            },
          },
        ],
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(String(init.body));
    const schema = forwarded.tools[0].input_schema;
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        command: { type: "string" },
        mode: { type: "string" },
        selection: {
          oneOf: [{ type: "string" }, { type: "number" }],
        },
      },
    });
    expect(new Headers(init.headers).has("content-length")).toBe(false);
  });

  it("does not block an awaited event hook while the bridge is unavailable", async () => {
    setOpenCodeArgv("run", "hello");
    vi.stubEnv("YEP_MANAGED_OPENCODE", "");
    vi.stubEnv("YEP_MANAGED_OPENCODE_SERVER_PORT", undefined);
    vi.stubEnv("YEP_OPENCODE_PLUGIN_DISABLE", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const hooks = await YepBridge({ client: {}, directory: "/repo" });
    if (!("event" in hooks) || !hooks.event) {
      throw new Error("Expected the OpenCode event hook to be enabled");
    }

    const outcome = await Promise.race([
      hooks
        .event({
          event: {
            type: "session.status",
            properties: {
              sessionID: "ses_offline",
              status: { type: "busy" },
            },
          },
        })
        .then(() => "returned" as const),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);

    expect(outcome).toBe("returned");
  });
});
