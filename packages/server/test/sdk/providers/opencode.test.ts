import { EventEmitter } from "node:events";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { type ModelInfo, parseOpenCodeSSEEvent } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../../src/logging/logger.js";
import { MessageQueue } from "../../../src/sdk/messageQueue.js";
import { OpenCodeProvider } from "../../../src/sdk/providers/opencode.js";
import type { QueuedUserMessage } from "../../../src/sdk/types.js";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

async function withTestServer<T>(
  handler: (
    req: IncomingMessage,
    res: Parameters<Parameters<typeof createServer>[0]>[1],
  ) => void | Promise<void>,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

interface OpenCodeTestPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  mime?: string;
  filename?: string;
  url?: string;
  callID?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
  };
  cost?: number;
}

interface OpenCodeTestEmissionState {
  toolUseIds: Set<string>;
  toolResultIds: Set<string>;
  toolUseInputs: Map<string, string>;
  markerPartIds: Set<string>;
  streamingPartTypes: Map<string, "text" | "reasoning">;
  permissionAskedIds: Set<string>;
  latestUsage?: Record<string, unknown>;
}

type ConvertPartToSDKMessages = (
  part: OpenCodeTestPart,
  sessionId: string,
  delta: string | undefined,
  currentMessageId: string | null,
  role: "user" | "assistant" | undefined,
  emissionState: OpenCodeTestEmissionState,
  submittedText?: string,
) => Array<Record<string, unknown>>;

function getConvertPartToSDKMessages(
  provider: OpenCodeProvider,
): ConvertPartToSDKMessages {
  return (
    provider as unknown as {
      convertPartToSDKMessages: ConvertPartToSDKMessages;
    }
  ).convertPartToSDKMessages.bind(provider);
}

type ConvertSSEEventToSDKMessages = (
  event: { type: string; properties: Record<string, unknown> },
  baseUrl: string,
  sessionId: string,
  currentMessageId: string | null,
  signal: AbortSignal,
  messageRoles: ReadonlyMap<string, "user" | "assistant">,
  emissionState: OpenCodeTestEmissionState,
  submittedText: string,
) => Promise<Array<Record<string, unknown>>>;

function getConvertSSEEventToSDKMessages(
  provider: OpenCodeProvider,
): ConvertSSEEventToSDKMessages {
  return (
    provider as unknown as {
      convertSSEEventToSDKMessages: ConvertSSEEventToSDKMessages;
    }
  ).convertSSEEventToSDKMessages.bind(provider);
}

function createEmissionState(): OpenCodeTestEmissionState {
  return {
    toolUseIds: new Set<string>(),
    toolResultIds: new Set<string>(),
    toolUseInputs: new Map<string, string>(),
    markerPartIds: new Set<string>(),
    streamingPartTypes: new Map<string, "text" | "reasoning">(),
    permissionAskedIds: new Set<string>(),
  };
}

describe("OpenCodeProvider", () => {
  const originalEnv = {
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_API_BASE: process.env.LLM_API_BASE,
    LLM_SUB_MODULE: process.env.LLM_SUB_MODULE,
    OPENCODE_LLM_API_KEY: process.env.OPENCODE_LLM_API_KEY,
    OPENCODE_LLM_API_BASE: process.env.OPENCODE_LLM_API_BASE,
    OPENCODE_LLM_SUB_MODULE: process.env.OPENCODE_LLM_SUB_MODULE,
    SESSION_TITLE_LLM_API_KEY: process.env.SESSION_TITLE_LLM_API_KEY,
    SESSION_TITLE_LLM_API_BASE: process.env.SESSION_TITLE_LLM_API_BASE,
    SESSION_TITLE_SUB_MODULE: process.env.SESSION_TITLE_SUB_MODULE,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
    YEP_OPENCODE_BRIDGE_CONTROL_URL:
      process.env.YEP_OPENCODE_BRIDGE_CONTROL_URL,
    OPENCODE_BRIDGE_CONTROL_URL: process.env.OPENCODE_BRIDGE_CONTROL_URL,
    YEP_OPENCODE_BRIDGE_URL: process.env.YEP_OPENCODE_BRIDGE_URL,
    OPENCODE_BRIDGE_URL: process.env.OPENCODE_BRIDGE_URL,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it("maps Yep permission modes to OpenCode permissions", () => {
    const provider = new OpenCodeProvider();
    const mapPermissionModeToOpenCode = (
      provider as unknown as {
        mapPermissionModeToOpenCode: (
          mode?: string,
        ) => Record<string, "allow" | "ask" | "deny">;
      }
    ).mapPermissionModeToOpenCode.bind(provider);

    expect(provider.permissionModes).toEqual([
      "default",
      "acceptEdits",
      "bypassPermissions",
    ]);
    const defaultPermissions = mapPermissionModeToOpenCode("default");
    expect(defaultPermissions).toMatchObject({
      read: "allow",
      glob: "allow",
      grep: "allow",
      edit: "ask",
      write: "ask",
      bash: "ask",
      "*": "ask",
    });
    expect(mapPermissionModeToOpenCode("auto")).toEqual(defaultPermissions);
    expect(mapPermissionModeToOpenCode("plan")).toEqual(defaultPermissions);

    expect(mapPermissionModeToOpenCode("acceptEdits")).toMatchObject({
      edit: "allow",
      write: "allow",
      bash: "ask",
      "*": "ask",
    });

    expect(mapPermissionModeToOpenCode("bypassPermissions")).toEqual({
      "*": "allow",
    });
  });

  it("orders OpenCode session permissions with the wildcard fallback first", () => {
    const provider = new OpenCodeProvider();
    const buildOpenCodeSessionPermission = (
      provider as unknown as {
        buildOpenCodeSessionPermission: (mode?: string) => Array<{
          permission: string;
          pattern: "*";
          action: "allow" | "ask" | "deny";
        }>;
      }
    ).buildOpenCodeSessionPermission.bind(provider);
    const rules = buildOpenCodeSessionPermission("acceptEdits");
    const evaluate = (permission: string) =>
      rules.findLast(
        (rule) => rule.permission === "*" || rule.permission === permission,
      )?.action;

    expect(rules[0]).toEqual({
      permission: "*",
      pattern: "*",
      action: "ask",
    });
    expect(evaluate("read")).toBe("allow");
    expect(evaluate("edit")).toBe("allow");
    expect(evaluate("bash")).toBe("ask");
    expect(evaluate("unknown-tool")).toBe("ask");
  });

  it("normalizes OpenCode model options", () => {
    const provider = new OpenCodeProvider();
    const normalizeOpenCodeModelOption = (
      provider as unknown as {
        normalizeOpenCodeModelOption: (model?: string) => string | null;
      }
    ).normalizeOpenCodeModelOption.bind(provider);

    expect(normalizeOpenCodeModelOption(undefined)).toBeNull();
    expect(normalizeOpenCodeModelOption("default")).toBeNull();
    expect(normalizeOpenCodeModelOption("auto")).toBeNull();
    expect(normalizeOpenCodeModelOption(" anthropic/claude-sonnet-4 ")).toBe(
      "anthropic/claude-sonnet-4",
    );
  });

  it("preserves an explicit OpenCode provider/model selection", async () => {
    const provider = new OpenCodeProvider();
    const methods = provider as unknown as {
      resolveOpenCodeModelOption: (model?: string) => Promise<string | null>;
    };
    await expect(
      methods.resolveOpenCodeModelOption("anthropic/deepseek-v4-pro"),
    ).resolves.toBe("anthropic/deepseek-v4-pro");
    await expect(
      methods.resolveOpenCodeModelOption("anthropic/claude-sonnet-4"),
    ).resolves.toBe("anthropic/claude-sonnet-4");
  });

  it("uses the global OpenCode catalog and offers config inheritance first", async () => {
    const provider = new OpenCodeProvider();
    const methods = provider as unknown as {
      findOpenCodePath: () => Promise<string | null>;
      loadOpenCodeCliModels: (path: string) => Promise<ModelInfo[]>;
      getGatewayModelWindows: () => Promise<Map<string, number>>;
    };
    vi.spyOn(methods, "findOpenCodePath").mockResolvedValue("/bin/opencode");
    vi.spyOn(methods, "loadOpenCodeCliModels").mockResolvedValue([
      { id: "anthropic/glm-5.2", name: "anthropic / glm-5.2" },
    ]);
    vi.spyOn(methods, "getGatewayModelWindows").mockResolvedValue(new Map());

    await expect(provider.getAvailableModels()).resolves.toEqual([
      { id: "default", name: "Default (OpenCode config)" },
      { id: "anthropic/glm-5.2", name: "anthropic / glm-5.2" },
    ]);
  });

  it("lists only models connected to the bridge-managed OpenCode runtime", async () => {
    let runtimeUrl = "";

    await withTestServer(
      (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && url.pathname === "/status") {
          res.end(JSON.stringify({ opencodeServerUrl: runtimeUrl }));
          return;
        }
        if (req.method === "GET" && url.pathname === "/config/providers") {
          res.end(
            JSON.stringify({
              providers: [
                {
                  id: "ohmyrouter",
                  models: {
                    "deepseek-v4-pro": {
                      api: { npm: "@ai-sdk/anthropic" },
                      limit: { context: 200_000, output: 32_000 },
                      variants: { high: { effort: "high" } },
                    },
                  },
                },
                {
                  id: "opencode",
                  models: {
                    "big-pickle": {
                      api: { npm: "@ai-sdk/openai-compatible" },
                      limit: { context: 128_000, output: 16_000 },
                    },
                  },
                },
              ],
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      },
      async (bridgeControlUrl) => {
        runtimeUrl = bridgeControlUrl;
        const provider = new OpenCodeProvider({ bridgeControlUrl });
        const methods = provider as unknown as {
          loadOpenCodeCliModels: (path: string) => Promise<ModelInfo[]>;
        };
        const cliSpy = vi.spyOn(methods, "loadOpenCodeCliModels");

        await expect(provider.getAvailableModels()).resolves.toEqual([
          { id: "default", name: "Default (OpenCode config)" },
          {
            id: "ohmyrouter/deepseek-v4-pro",
            name: "ohmyrouter / deepseek-v4-pro",
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            supportedReasoningEffortsByProtocol: {
              anthropic: [{ reasoningEffort: "high" }],
            },
          },
          {
            id: "opencode/big-pickle",
            name: "opencode / big-pickle",
            contextWindow: 128_000,
            maxOutputTokens: 16_000,
          },
        ]);
        expect(cliSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("does not fall back to a different CLI catalog when the runtime has no connected providers", async () => {
    let runtimeUrl = "";

    await withTestServer(
      (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && url.pathname === "/status") {
          res.end(JSON.stringify({ opencodeServerUrl: runtimeUrl }));
          return;
        }
        if (req.method === "GET" && url.pathname === "/config/providers") {
          res.end(JSON.stringify({ providers: [], default: {} }));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      },
      async (bridgeControlUrl) => {
        runtimeUrl = bridgeControlUrl;
        const provider = new OpenCodeProvider({ bridgeControlUrl });
        const methods = provider as unknown as {
          loadOpenCodeCliModels: (path: string) => Promise<ModelInfo[]>;
        };
        const cliSpy = vi.spyOn(methods, "loadOpenCodeCliModels");

        await expect(provider.getAvailableModels()).resolves.toEqual([
          { id: "default", name: "Default (OpenCode config)" },
        ]);
        expect(cliSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("remaps a stale provider-qualified model to its sole connected route", async () => {
    await withTestServer(
      (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && url.pathname === "/config/providers") {
          res.end(
            JSON.stringify({
              providers: [
                {
                  id: "ohmyrouter",
                  models: {
                    "deepseek-v4-pro": {},
                    "glm-5.2": {},
                  },
                },
                {
                  id: "anthropic",
                  models: { "claude-sonnet-5": {} },
                },
              ],
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      },
      async (baseUrl) => {
        const provider = new OpenCodeProvider();
        const resolveOpenCodeRuntimeModel = (
          provider as unknown as {
            resolveOpenCodeRuntimeModel: (
              baseUrl: string,
              cwd: string,
              model: string | null,
            ) => Promise<string | null>;
          }
        ).resolveOpenCodeRuntimeModel.bind(provider);

        await expect(
          resolveOpenCodeRuntimeModel(
            baseUrl,
            "/repo",
            "deepseek/deepseek-v4-pro",
          ),
        ).resolves.toBe("ohmyrouter/deepseek-v4-pro");
        await expect(
          resolveOpenCodeRuntimeModel(
            baseUrl,
            "/repo",
            "ohmyrouter/deepseek-v4-pro",
          ),
        ).resolves.toBe("ohmyrouter/deepseek-v4-pro");
        await expect(
          resolveOpenCodeRuntimeModel(
            baseUrl,
            "/repo",
            "anthropic/missing-model",
          ),
        ).resolves.toBe("anthropic/missing-model");
      },
    );
  });

  it("parses protocol-specific reasoning variants from verbose model output", () => {
    const provider = new OpenCodeProvider();
    const parseOpenCodeVerboseModels = (
      provider as unknown as {
        parseOpenCodeVerboseModels: (output: string) => ModelInfo[];
      }
    ).parseOpenCodeVerboseModels.bind(provider);

    const models = parseOpenCodeVerboseModels(`opencode models --verbose
yep-openai-compatible/glm-5.2
{
  "id": "glm-5.2",
  "api": {
    "url": "https://example.test/{tenant}/v1",
    "npm": "@ai-sdk/openai-compatible"
  },
  "variants": {
    "high": { "reasoningEffort": "high" },
    "future-turbo-v9": { "metadata": { "literal": "}" } }
  }
}
yep-anthropic/glm-5.2
{
  "id": "glm-5.2",
  "api": { "npm": "@ai-sdk/anthropic" },
  "variants": {
    "high": { "effort": "high" },
    "max": { "effort": "max" }
  }
}`);

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "yep-openai-compatible/glm-5.2",
      supportedReasoningEfforts: [
        { reasoningEffort: "high" },
        { reasoningEffort: "future-turbo-v9" },
      ],
      supportedReasoningEffortsByProtocol: {
        "openai-compatible": [
          { reasoningEffort: "high" },
          { reasoningEffort: "future-turbo-v9" },
        ],
      },
    });
    expect(models[1]).toMatchObject({
      id: "yep-anthropic/glm-5.2",
      supportedReasoningEffortsByProtocol: {
        anthropic: [{ reasoningEffort: "high" }, { reasoningEffort: "max" }],
      },
    });
  });

  it("hides invalid legacy variants for adaptive Anthropic models", () => {
    const provider = new OpenCodeProvider();
    const parseOpenCodeVerboseModels = (
      provider as unknown as {
        parseOpenCodeVerboseModels: (output: string) => ModelInfo[];
      }
    ).parseOpenCodeVerboseModels.bind(provider);

    const models = parseOpenCodeVerboseModels(`opencode models --verbose
mafia/claude-opus-5
{
  "api": { "id": "claude-opus-5", "npm": "@ai-sdk/anthropic" },
  "variants": {
    "high": { "thinking": { "type": "enabled", "budgetTokens": 16000 } }
  }
}
mafia/claude-opus-5-fixed
{
  "api": { "id": "claude-opus-5", "npm": "@ai-sdk/anthropic" },
  "variants": {
    "high": { "thinking": { "type": "adaptive" }, "effort": "high" }
  }
}
mafia/claude-opus-4-20250514
{
  "api": { "id": "claude-opus-4-20250514", "npm": "@ai-sdk/anthropic" },
  "variants": {
    "high": { "thinking": { "type": "enabled", "budgetTokens": 16000 } }
  }
}`);

    expect(models[0]).not.toHaveProperty("supportedReasoningEfforts");
    expect(models[1]).toMatchObject({
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      supportedReasoningEffortsByProtocol: {
        anthropic: [{ reasoningEffort: "high" }],
      },
    });
    expect(models[2]).toMatchObject({
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      supportedReasoningEffortsByProtocol: {
        anthropic: [{ reasoningEffort: "high" }],
      },
    });
  });

  it("does not synthesize variants for ordinary CLI model entries", () => {
    const provider = new OpenCodeProvider();
    const parseOpenCodeVerboseModels = (
      provider as unknown as {
        parseOpenCodeVerboseModels: (output: string) => ModelInfo[];
      }
    ).parseOpenCodeVerboseModels.bind(provider);

    const [model] = parseOpenCodeVerboseModels(`
custom-openai/glm-5.2
{
  "api": { "npm": "@ai-sdk/openai-compatible" },
  "capabilities": { "reasoning": false },
  "variants": {}
}`);

    expect(model).toMatchObject({
      id: "custom-openai/glm-5.2",
    });
    expect(model).not.toHaveProperty("supportedRequestProtocols");
    expect(model).not.toHaveProperty("supportedReasoningEfforts");
    expect(model).not.toHaveProperty("supportedReasoningEffortsByProtocol");
  });

  it("parses real context/output limits from verbose model output", () => {
    const provider = new OpenCodeProvider();
    const parseOpenCodeVerboseModels = (
      provider as unknown as {
        parseOpenCodeVerboseModels: (output: string) => ModelInfo[];
      }
    ).parseOpenCodeVerboseModels.bind(provider);

    const [model] = parseOpenCodeVerboseModels(`ohmyrouter/claude-opus-4-8
{
  "id": "claude-opus-4-8",
  "api": { "npm": "@ai-sdk/anthropic" },
  "limit": { "context": 1000000, "input": 900000, "output": 128000 }
}`);

    expect(model).toMatchObject({
      id: "ohmyrouter/claude-opus-4-8",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    });
  });

  it("ignores non-positive limit values in verbose model output", () => {
    const provider = new OpenCodeProvider();
    const parseOpenCodeVerboseModels = (
      provider as unknown as {
        parseOpenCodeVerboseModels: (output: string) => ModelInfo[];
      }
    ).parseOpenCodeVerboseModels.bind(provider);

    const [model] = parseOpenCodeVerboseModels(`custom/foo
{ "limit": { "context": 0, "output": 0 } }`);

    expect(model).toMatchObject({ id: "custom/foo" });
    expect(model).not.toHaveProperty("contextWindow");
    expect(model).not.toHaveProperty("maxOutputTokens");
  });

  it("backfills missing context windows from the gateway catalog", async () => {
    const provider = new OpenCodeProvider();
    const methods = provider as unknown as {
      findOpenCodePath: () => Promise<string | null>;
      loadOpenCodeCliModels: (path: string) => Promise<ModelInfo[]>;
      getGatewayModelWindows: () => Promise<Map<string, number>>;
    };
    vi.spyOn(methods, "findOpenCodePath").mockResolvedValue("/bin/opencode");
    vi.spyOn(methods, "loadOpenCodeCliModels").mockResolvedValue([
      { id: "ohmyrouter/glm-5.2", name: "glm" },
      {
        id: "ohmyrouter/claude-opus-4-8",
        name: "opus",
        contextWindow: 1_000_000,
      },
    ]);
    // Gateway reports a window for the model that lacks one, and a different
    // value for the model the CLI already resolved (which must win).
    vi.spyOn(methods, "getGatewayModelWindows").mockResolvedValue(
      new Map([
        ["glm-5.2", 200_000],
        ["claude-opus-4-8", 999],
      ]),
    );

    await expect(provider.getAvailableModels()).resolves.toEqual([
      { id: "default", name: "Default (OpenCode config)" },
      { id: "ohmyrouter/glm-5.2", name: "glm", contextWindow: 200_000 },
      {
        id: "ohmyrouter/claude-opus-4-8",
        name: "opus",
        contextWindow: 1_000_000,
      },
    ]);
  });

  it("keeps plain model-list output compatible with older OpenCode versions", () => {
    const provider = new OpenCodeProvider();
    const parseOpenCodeVerboseModels = (
      provider as unknown as {
        parseOpenCodeVerboseModels: (output: string) => ModelInfo[];
      }
    ).parseOpenCodeVerboseModels.bind(provider);

    expect(
      parseOpenCodeVerboseModels("opencode/big-pickle\nohmyrouter/glm-5.2\n"),
    ).toEqual([
      { id: "opencode/big-pickle", name: "opencode / big-pickle" },
      { id: "ohmyrouter/glm-5.2", name: "ohmyrouter / glm-5.2" },
    ]);
  });

  it("allocates an OpenCode port that is not already listening", async () => {
    const provider = new OpenCodeProvider();
    const getAvailablePort = (
      provider as unknown as {
        getAvailablePort: () => Promise<number>;
      }
    ).getAvailablePort.bind(provider);

    const [allocatedPort, occupiedPort] = await withTestServer(
      (_req, res) => res.end(),
      async (baseUrl) => [
        await getAvailablePort(),
        Number(new URL(baseUrl).port),
      ],
    );

    expect(allocatedPort).not.toBe(occupiedPort);
  });

  it("selects the 4520 bridge-managed server used by of", async () => {
    let sharedServerUrl = "";
    let statusRequests = 0;

    await withTestServer(
      (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/status") {
          statusRequests += 1;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ opencodeServerUrl: sharedServerUrl }));
          return;
        }
        res.statusCode = 404;
        res.end();
      },
      async (bridgeControlUrl) => {
        sharedServerUrl = `${bridgeControlUrl}/shared-opencode`;
        const provider = new OpenCodeProvider({ bridgeControlUrl });
        const resolveBridgeManagedServer = (
          provider as unknown as {
            resolveBridgeManagedServer: () => Promise<string | null>;
          }
        ).resolveBridgeManagedServer.bind(provider);

        await expect(resolveBridgeManagedServer()).resolves.toBe(
          sharedServerUrl,
        );
      },
    );

    expect(statusRequests).toBe(1);
  });

  it("starts a Yep session on the shared server without spawning a dedicated CLI", async () => {
    let serverUrl = "";
    let abortRequests = 0;
    const terminalNotifications: unknown[] = [];
    const methods: string[] = [];
    let createBody: Record<string, unknown> | null = null;

    await withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        methods.push(`${req.method} ${url.pathname}`);
        res.setHeader("content-type", "application/json");

        if (req.method === "GET" && url.pathname === "/status") {
          res.end(JSON.stringify({ opencodeServerUrl: serverUrl }));
          return;
        }
        if (req.method === "GET" && url.pathname === "/session") {
          res.end("[]");
          return;
        }
        if (req.method === "GET" && url.pathname === "/config/providers") {
          res.end(
            JSON.stringify({
              providers: [
                {
                  id: "ohmyrouter",
                  models: { "deepseek-v4-pro": {} },
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && url.pathname === "/session") {
          createBody = (await readJsonBody(req)) as Record<string, unknown>;
          res.end(JSON.stringify({ id: "ses_shared" }));
          return;
        }
        if (req.method === "PATCH" && url.pathname === "/session/ses_shared") {
          await readJsonBody(req);
          res.end(JSON.stringify({ id: "ses_shared" }));
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_shared/abort"
        ) {
          abortRequests += 1;
          res.end("true");
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/sessions/ses_shared/terminal"
        ) {
          terminalNotifications.push(await readJsonBody(req));
          res.end(JSON.stringify({ terminal: true }));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      },
      async (bridgeControlUrl) => {
        serverUrl = bridgeControlUrl;
        const provider = new OpenCodeProvider({
          bridgeControlUrl,
          opencodePath: "/definitely/not/a/real/opencode",
        });
        const session = await provider.startSession({
          cwd: "/repo",
          model: "deepseek/deepseek-v4-pro",
        });

        await expect(session.iterator.next()).resolves.toMatchObject({
          done: false,
          value: {
            type: "system",
            subtype: "init",
            session_id: "ses_shared",
            model: "ohmyrouter/deepseek-v4-pro",
          },
        });
        expect(session.pid).toBeUndefined();
        expect(session.isProcessAlive?.()).toBe(true);

        session.abort();
        await session.iterator.return?.(undefined as never);
        await vi.waitFor(() => {
          expect(abortRequests).toBe(1);
          expect(terminalNotifications).toEqual([{ kind: "interrupted" }]);
        });
        expect(session.isProcessAlive?.()).toBe(false);
      },
    );

    expect(methods).toEqual(
      expect.arrayContaining([
        "GET /status",
        "GET /session",
        "POST /session",
        "PATCH /session/ses_shared",
      ]),
    );
    expect(methods).not.toContain("PATCH /config");
    expect(createBody).toMatchObject({
      model: {
        providerID: "ohmyrouter",
        id: "deepseek-v4-pro",
      },
      permission: expect.arrayContaining([
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "*", action: "ask" },
      ]),
    });
  });

  it("routes a direct TUI session through its external plugin instead of 4521", async () => {
    const methods: string[] = [];
    const commands: Array<Record<string, unknown>> = [];
    const commandHeaders: Array<string | string[] | undefined> = [];
    await withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        methods.push(`${req.method} ${url.pathname}`);
        res.setHeader("content-type", "application/json");
        if (
          req.method === "GET" &&
          url.pathname === "/sessions/ses_direct/execution"
        ) {
          res.end(
            JSON.stringify({ owner: "external-plugin", available: true }),
          );
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/sessions/ses_direct/external-command"
        ) {
          commandHeaders.push(req.headers["x-yep-anywhere"]);
          commands.push((await readJsonBody(req)) as Record<string, unknown>);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (
          req.method === "GET" &&
          url.pathname === "/sessions/ses_direct/view"
        ) {
          res.end(
            JSON.stringify({
              sessionView: {
                active: false,
                session: { lastTurnStatus: "completed" },
              },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "unexpected route" }));
      },
      async (bridgeControlUrl) => {
        const provider = new OpenCodeProvider({
          bridgeControlUrl,
          opencodePath: "/path-that-must-not-be-spawned/opencode",
        });
        const session = await provider.startSession({
          cwd: "/repo/direct",
          resumeSessionId: "ses_direct",
          model: "openai/gpt-test",
          reasoningEffort: "high",
          permissionMode: "acceptEdits",
          initialMessage: { text: "continue", uuid: "direct-message" },
        });
        try {
          await expect(session.iterator.next()).resolves.toMatchObject({
            done: false,
            value: { type: "system", session_id: "ses_direct" },
          });
          expect(session.isProcessAlive?.()).toBe(true);
          await expect(session.iterator.next()).resolves.toMatchObject({
            done: false,
            value: { type: "user", uuid: "direct-message" },
          });
          await expect(session.iterator.next()).resolves.toMatchObject({
            done: false,
            value: {
              type: "result",
              clientUserMessageId: "direct-message",
            },
          });
          expect(session.pid).toBeUndefined();
          expect(session.isProcessAlive?.()).toBe(true);
          expect(commands[0]).toMatchObject({
            kind: "prompt",
            sessionId: "ses_direct",
            payload: {
              parts: [{ type: "text", text: "continue" }],
              model: { providerID: "openai", modelID: "gpt-test" },
              variant: "high",
            },
            permission: expect.arrayContaining([
              { permission: "edit", pattern: "*", action: "allow" },
              { permission: "bash", pattern: "*", action: "ask" },
            ]),
          });
          expect(commandHeaders).toEqual(["true"]);
          expect(methods).not.toContain("GET /status");
          expect(methods).not.toContain("POST /session");
        } finally {
          session.abort();
          await session.iterator.return?.(undefined as never);
        }
      },
    );
  });

  it("does not accept a stale OpenCode listener after its child exits", async () => {
    const provider = new OpenCodeProvider();
    const waitForServer = (
      provider as unknown as {
        waitForServer: (
          baseUrl: string,
          timeoutMs: number,
          cwd?: string,
          process?: {
            exitCode: number | null;
            signalCode: NodeJS.Signals | null;
            once: EventEmitter["once"];
            off: EventEmitter["off"];
          },
        ) => Promise<boolean>;
      }
    ).waitForServer.bind(provider);
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.exitCode = null;
    child.signalCode = null;

    const ready = await withTestServer(
      (_req, res) => res.end("[]"),
      async (baseUrl) => {
        setTimeout(() => {
          child.exitCode = 1;
          child.emit("exit", 1, null);
        }, 20);
        return await waitForServer(baseUrl, 1_000, undefined, child);
      },
    );

    expect(ready).toBe(false);
  });

  it("builds OpenCode session and message payloads with the selected model", () => {
    const provider = new OpenCodeProvider();
    const methods = provider as unknown as {
      buildOpenCodeSessionCreatePayload: (
        cwd: string,
        model?: string | null,
        permission?: Array<{
          permission: string;
          pattern: "*";
          action: "allow" | "ask" | "deny";
        }>,
      ) => unknown;
      buildOpenCodeMessagePayload: (
        text: string,
        model?: string | null,
        variant?: string,
        fileParts?: Array<{
          type: "file";
          mime: string;
          filename?: string;
          url: string;
        }>,
      ) => unknown;
    };

    expect(
      methods.buildOpenCodeSessionCreatePayload(
        "/repo",
        "anthropic/claude-fable-5",
        [{ permission: "bash", pattern: "*", action: "ask" }],
      ),
    ).toEqual({
      title: "Yep Anywhere Session",
      location: { directory: "/repo" },
      metadata: {
        createdBy: "yep",
        source: "yep-anywhere",
      },
      model: {
        providerID: "anthropic",
        id: "claude-fable-5",
      },
      permission: [{ permission: "bash", pattern: "*", action: "ask" }],
    });

    expect(
      methods.buildOpenCodeMessagePayload(
        "hello",
        "anthropic/claude-fable-5",
        "max",
      ),
    ).toEqual({
      parts: [{ type: "text", text: "hello" }],
      model: {
        providerID: "anthropic",
        modelID: "claude-fable-5",
      },
      variant: "max",
    });
    expect(
      methods.buildOpenCodeMessagePayload(
        "hello",
        "anthropic/claude-fable-5",
        "default",
      ),
    ).toEqual({
      parts: [{ type: "text", text: "hello" }],
      model: {
        providerID: "anthropic",
        modelID: "claude-fable-5",
      },
    });
    expect(
      methods.buildOpenCodeMessagePayload(
        "hello",
        "yep-openai-compatible/kimi-k2.6",
        "max",
      ),
    ).toEqual({
      parts: [{ type: "text", text: "hello" }],
      model: {
        providerID: "yep-openai-compatible",
        modelID: "kimi-k2.6",
      },
      variant: "max",
    });
    expect(
      methods.buildOpenCodeMessagePayload(
        "hello",
        "yep-anthropic/future-model",
        "xhigh",
      ),
    ).toEqual({
      parts: [{ type: "text", text: "hello" }],
      model: {
        providerID: "yep-anthropic",
        modelID: "future-model",
      },
      variant: "xhigh",
    });
  });

  it("fails closed when the runtime model does not advertise a variant", async () => {
    const provider = new OpenCodeProvider();
    const resolveOpenCodeVariant = (
      provider as unknown as {
        resolveOpenCodeVariant: (
          baseUrl: string,
          cwd: string,
          model: string,
          variant: string,
        ) => Promise<string | undefined>;
      }
    ).resolveOpenCodeVariant.bind(provider);

    await withTestServer(
      (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            providers: [
              {
                id: "yep-anthropic",
                models: {
                  "claude-opus-4-7": {
                    variants: { high: {}, max: {} },
                  },
                  "kimi-k2.6": { variants: {} },
                },
              },
            ],
          }),
        );
      },
      async (baseUrl) => {
        await expect(
          resolveOpenCodeVariant(
            baseUrl,
            "/repo",
            "yep-anthropic/claude-opus-4-7",
            "max",
          ),
        ).resolves.toBe("max");
        await expect(
          resolveOpenCodeVariant(
            baseUrl,
            "/repo",
            "yep-anthropic/claude-opus-4-7",
            "xhigh",
          ),
        ).resolves.toBeUndefined();
        await expect(
          resolveOpenCodeVariant(
            baseUrl,
            "/repo",
            "yep-anthropic/kimi-k2.6",
            "max",
          ),
        ).resolves.toBeUndefined();
      },
    );
  });

  it("rejects legacy enabled-thinking variants for adaptive Anthropic models", async () => {
    const provider = new OpenCodeProvider();
    const resolveOpenCodeVariant = (
      provider as unknown as {
        resolveOpenCodeVariant: (
          baseUrl: string,
          cwd: string,
          model: string,
          variant: string,
        ) => Promise<string | undefined>;
      }
    ).resolveOpenCodeVariant.bind(provider);

    await withTestServer(
      (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            providers: [
              {
                id: "mafia",
                models: {
                  "claude-opus-5": {
                    api: {
                      id: "claude-opus-5",
                      npm: "@ai-sdk/anthropic",
                    },
                    variants: {
                      high: {
                        thinking: {
                          type: "enabled",
                          budgetTokens: 16_000,
                        },
                      },
                    },
                  },
                  "claude-opus-5-fixed": {
                    api: {
                      id: "claude-opus-5",
                      npm: "@ai-sdk/anthropic",
                    },
                    variants: {
                      high: {
                        thinking: { type: "adaptive" },
                        effort: "high",
                      },
                    },
                  },
                  "claude-opus-4-20250514": {
                    api: {
                      id: "claude-opus-4-20250514",
                      npm: "@ai-sdk/anthropic",
                    },
                    variants: {
                      high: {
                        thinking: {
                          type: "enabled",
                          budgetTokens: 16_000,
                        },
                      },
                    },
                  },
                },
              },
            ],
          }),
        );
      },
      async (baseUrl) => {
        await expect(
          resolveOpenCodeVariant(
            baseUrl,
            "/repo",
            "mafia/claude-opus-5",
            "high",
          ),
        ).resolves.toBeUndefined();
        await expect(
          resolveOpenCodeVariant(
            baseUrl,
            "/repo",
            "mafia/claude-opus-5-fixed",
            "high",
          ),
        ).resolves.toBe("high");
        await expect(
          resolveOpenCodeVariant(
            baseUrl,
            "/repo",
            "mafia/claude-opus-4-20250514",
            "high",
          ),
        ).resolves.toBe("high");
      },
    );
  });

  it("keeps non-media uploads path-only and builds supported native file parts", async () => {
    const imageAttachment = {
      id: "file-1",
      originalName: "screen shot.png",
      name: "file-1_screen shot.png",
      size: 1_024,
      mimeType: "image/png",
      path: "/uploads/screen shot.png",
    };
    const jsonAttachment = {
      id: "file-2",
      originalName: "request.json",
      name: "file-2_request.json",
      size: 2_048,
      mimeType: "application/json",
      path: "/uploads/request.json",
    };
    const pdfAttachment = {
      id: "file-3",
      originalName: "spec.pdf",
      name: "file-3_spec.pdf",
      size: 4_096,
      mimeType: "Application/PDF; charset=binary",
      path: "/uploads/spec.pdf",
    };
    const queue = new MessageQueue({ preserveAttachments: true });
    queue.push({
      text: "describe these images",
      attachments: [imageAttachment, jsonAttachment, pdfAttachment],
      images: ["data:image/jpeg;base64,AQID"],
    });

    const queued = (await queue.generator().next()).value;
    expect(queued?.attachments).toEqual([
      imageAttachment,
      jsonAttachment,
      pdfAttachment,
    ]);
    if (!queued) throw new Error("Expected the queued OpenCode message");
    const queuedText = Array.isArray(queued.message.content)
      ? queued.message.content.find((part) => part.type === "text")?.text
      : queued.message.content;
    expect(queuedText).toContain(
      "- request.json (2.0 KB, application/json): /uploads/request.json",
    );

    const provider = new OpenCodeProvider();
    const methods = provider as unknown as {
      buildOpenCodeFileParts: (message: QueuedUserMessage) => Array<{
        type: "file";
        mime: string;
        filename?: string;
        url: string;
      }>;
      buildOpenCodeMessagePayload: (
        text: string,
        model?: string | null,
        variant?: string,
        fileParts?: Array<{
          type: "file";
          mime: string;
          filename?: string;
          url: string;
        }>,
      ) => unknown;
    };
    const fileParts = methods.buildOpenCodeFileParts(queued);

    expect(fileParts).toEqual([
      {
        type: "file",
        mime: "image/png",
        filename: "screen shot.png",
        url: pathToFileURL(imageAttachment.path).href,
      },
      {
        type: "file",
        mime: "application/pdf",
        filename: "spec.pdf",
        url: pathToFileURL(pdfAttachment.path).href,
      },
      {
        type: "file",
        mime: "image/jpeg",
        url: "data:image/jpeg;base64,AQID",
      },
    ]);
    expect(
      methods.buildOpenCodeMessagePayload(
        "describe these images",
        "anthropic/claude-sonnet-5",
        undefined,
        fileParts,
      ),
    ).toEqual({
      parts: [...fileParts, { type: "text", text: "describe these images" }],
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
      },
    });
  });

  it("marks newly created OpenCode sessions with Yep metadata", async () => {
    const provider = new OpenCodeProvider();
    const markOpenCodeSessionCreatedByYep = (
      provider as unknown as {
        markOpenCodeSessionCreatedByYep: (
          baseUrl: string,
          sessionId: string,
          cwd: string,
          existingMetadata?: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).markOpenCodeSessionCreatedByYep.bind(provider);
    const requests: Array<{ url?: string; method?: string; body: unknown }> =
      [];

    await withTestServer(
      async (req, res) => {
        requests.push({
          url: req.url,
          method: req.method,
          body: await readJsonBody(req),
        });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "ses_1" }));
      },
      (baseUrl) =>
        markOpenCodeSessionCreatedByYep(baseUrl, "ses_1", "/repo", {
          custom: "preserved",
        }),
    );

    expect(requests).toEqual([
      {
        url: "/session/ses_1?directory=%2Frepo",
        method: "PATCH",
        body: {
          metadata: {
            custom: "preserved",
            createdBy: "yep",
            source: "yep-anywhere",
          },
        },
      },
    ]);
  });

  it("routes OpenCode session creation to the requested project directory", async () => {
    const provider = new OpenCodeProvider();
    const prepareOpenCodeSession = (
      provider as unknown as {
        prepareOpenCodeSession: (
          baseUrl: string,
          options: { resumeSessionId?: string; resumeSessionAt?: string },
          cwd: string,
          model: string | null,
          permission: never[],
        ) => Promise<{ id: string }>;
      }
    ).prepareOpenCodeSession.bind(provider);

    const requests: Array<{
      url?: string;
      directoryHeader?: string | string[];
      body: unknown;
    }> = [];
    const cwd = "/repo with spaces";

    const result = await withTestServer(
      async (req, res) => {
        requests.push({
          url: req.url,
          directoryHeader: req.headers["x-opencode-directory"],
          body: await readJsonBody(req),
        });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "ses_created" }));
      },
      (baseUrl) =>
        prepareOpenCodeSession(
          baseUrl,
          {},
          cwd,
          "anthropic/claude-fable-5",
          [],
        ),
    );

    const url = new URL(requests[0]?.url ?? "", "http://127.0.0.1");
    expect(result).toEqual({ id: "ses_created" });
    expect(url.pathname).toBe("/session");
    expect(url.searchParams.get("directory")).toBe(cwd);
    expect(requests[0]?.directoryHeader).toBe(cwd);
    expect(requests[0]?.body).toEqual({
      title: "Yep Anywhere Session",
      location: { directory: cwd },
      metadata: {
        createdBy: "yep",
        source: "yep-anywhere",
      },
      model: {
        providerID: "anthropic",
        id: "claude-fable-5",
      },
    });
  });

  it("does not persist permission mode or selected model into OpenCode config", async () => {
    const provider = new OpenCodeProvider();
    const configureServer = (
      provider as unknown as {
        configureServer: (
          baseUrl: string,
          options: {
            permissionMode?: string;
            model?: string;
          },
        ) => Promise<{ ok: true; model: string | null } | { ok: false }>;
      }
    ).configureServer.bind(provider);

    const requests: Array<{ url?: string; method?: string; body: unknown }> =
      [];

    const result = await withTestServer(
      async (req, res) => {
        requests.push({
          url: req.url,
          method: req.method,
          body: await readJsonBody(req),
        });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(requests.at(-1)?.body));
      },
      (baseUrl) =>
        configureServer(baseUrl, {
          permissionMode: "acceptEdits",
          model: "yep-anthropic/claude-sonnet-4",
        }),
    );

    expect(result).toEqual({
      ok: true,
      model: "yep-anthropic/claude-sonnet-4",
    });
    expect(requests).toEqual([]);
  });

  it("keeps legacy provider config out of the project config", async () => {
    const provider = new OpenCodeProvider();
    const methods = provider as unknown as {
      configureServer: (
        baseUrl: string,
        options: {
          permissionMode?: string;
          model?: string;
          opencodeConfig?: {
            model: string;
            requestProtocol: "anthropic";
            limits: { context: number; output: number };
          };
        },
      ) => Promise<{ ok: true; model: string | null } | { ok: false }>;
    };
    const requests: Array<{ url?: string; method?: string; body: unknown }> =
      [];

    const result = await withTestServer(
      async (req, res) => {
        requests.push({
          url: req.url,
          method: req.method,
          body: await readJsonBody(req),
        });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({}));
      },
      (baseUrl) =>
        methods.configureServer(baseUrl, {
          model: "yep-anthropic/deepseek-v4-pro",
          opencodeConfig: {
            model: "deepseek-v4-pro",
            requestProtocol: "anthropic",
            limits: { context: 1_000_000, output: 32_000 },
          },
        }),
    );

    expect(result).toEqual({
      ok: true,
      model: "yep-anthropic/deepseek-v4-pro",
    });
    expect(requests).toEqual([]);
  });

  it("forks at the edited native user message and persists merged lineage", async () => {
    const provider = new OpenCodeProvider();
    const prepareOpenCodeSession = (
      provider as unknown as {
        prepareOpenCodeSession: (
          baseUrl: string,
          options: { resumeSessionId?: string; resumeSessionAt?: string },
          cwd: string,
          model: string | null,
          permission: never[],
        ) => Promise<{ id: string }>;
      }
    ).prepareOpenCodeSession.bind(provider);

    const requests: Array<{ url?: string; method?: string; body: unknown }> =
      [];

    const infoSpy = vi.spyOn(getLogger(), "info");
    const result = await withTestServer(
      async (req, res) => {
        requests.push({
          url: req.url,
          method: req.method,
          body: await readJsonBody(req),
        });
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST") {
          res.end(
            JSON.stringify({
              id: "ses_fork",
              metadata: {
                custom: "preserved",
                createdBy: "external",
                yepFork: {
                  schemaVersion: 1,
                  kind: "edit-fork",
                  parentSessionId: "ses_grandparent",
                  forkMessageId: "msg_old",
                },
              },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ id: "ses_fork" }));
      },
      (baseUrl) =>
        prepareOpenCodeSession(
          baseUrl,
          {
            resumeSessionId: "ses_parent",
            resumeSessionAt: "msg_boundary",
          },
          "/repo",
          null,
          [],
        ),
    );

    expect(result).toMatchObject({
      id: "ses_fork",
      metadata: {
        custom: "preserved",
        createdBy: "yep",
        source: "yep-anywhere",
        yepFork: {
          schemaVersion: 1,
          kind: "edit-fork",
          parentSessionId: "ses_parent",
          forkMessageId: "msg_boundary",
          createdAt: expect.any(String),
        },
      },
    });
    const url = new URL(requests[0]?.url ?? "", "http://127.0.0.1");
    expect(url.pathname).toBe("/session/ses_parent/fork");
    expect(url.searchParams.get("directory")).toBe("/repo");
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: { messageID: "msg_boundary" },
    });
    expect(requests[1]).toMatchObject({
      url: "/session/ses_fork?directory=%2Frepo",
      method: "PATCH",
      body: {
        metadata: {
          custom: "preserved",
          createdBy: "yep",
          source: "yep-anywhere",
          yepFork: {
            schemaVersion: 1,
            kind: "edit-fork",
            parentSessionId: "ses_parent",
            forkMessageId: "msg_boundary",
            createdAt: expect.any(String),
          },
        },
      },
    });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "opencode_session_fork_requested",
        parentSessionId: "ses_parent",
        forkMessageId: "msg_boundary",
      }),
      expect.any(String),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "opencode_session_fork_completed",
        forkSessionId: "ses_fork",
      }),
      expect.any(String),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "opencode_session_fork_metadata_patched",
        forkSessionId: "ses_fork",
        schemaVersion: 1,
      }),
      expect.any(String),
    );
    for (const [fields] of infoSpy.mock.calls) {
      if (!fields || typeof fields !== "object") continue;
      expect(fields).not.toHaveProperty("message");
      expect(fields).not.toHaveProperty("prompt");
    }
  });

  it("forks the first persisted user message instead of creating a new session", async () => {
    const provider = new OpenCodeProvider();
    const prepareOpenCodeSession = (
      provider as unknown as {
        prepareOpenCodeSession: (
          baseUrl: string,
          options: { resumeSessionId?: string; resumeSessionAt?: string },
          cwd: string,
          model: string | null,
          permission: never[],
        ) => Promise<{ id: string }>;
      }
    ).prepareOpenCodeSession.bind(provider);
    const requests: Array<{ method?: string; url?: string; body: unknown }> =
      [];

    await withTestServer(
      async (req, res) => {
        requests.push({
          method: req.method,
          url: req.url,
          body: await readJsonBody(req),
        });
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ id: "ses_first_fork", metadata: { custom: true } }),
        );
      },
      (baseUrl) =>
        prepareOpenCodeSession(
          baseUrl,
          { resumeSessionId: "ses_parent", resumeSessionAt: "msg_first" },
          "/repo",
          null,
          [],
        ),
    );

    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/session/ses_parent/fork?directory=%2Frepo",
      body: { messageID: "msg_first" },
    });
    expect(requests.some((request) => request.url === "/session")).toBe(false);
  });

  it("fails the edit before prompt submission when lineage PATCH fails", async () => {
    const provider = new OpenCodeProvider();
    const prepareOpenCodeSession = (
      provider as unknown as {
        prepareOpenCodeSession: (
          baseUrl: string,
          options: { resumeSessionId?: string; resumeSessionAt?: string },
          cwd: string,
          model: string | null,
          permission: never[],
        ) => Promise<{ id: string }>;
      }
    ).prepareOpenCodeSession.bind(provider);
    const requests: Array<{ method?: string; url?: string }> = [];

    await withTestServer(
      async (req, res) => {
        requests.push({ method: req.method, url: req.url });
        if (req.method === "POST") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({ id: "ses_orphan", metadata: { custom: true } }),
          );
          return;
        }
        res.statusCode = 500;
        res.end("metadata unavailable");
      },
      async (baseUrl) => {
        await expect(
          prepareOpenCodeSession(
            baseUrl,
            {
              resumeSessionId: "ses_parent",
              resumeSessionAt: "msg_user",
            },
            "/repo",
            null,
            [],
          ),
        ).rejects.toThrow(
          /ses_orphan.*lineage metadata could not be persisted.*500/i,
        );
      },
    );

    expect(requests).toEqual([
      {
        method: "POST",
        url: "/session/ses_parent/fork?directory=%2Frepo",
      },
      { method: "PATCH", url: "/session/ses_orphan?directory=%2Frepo" },
    ]);
  });

  it("bridges OpenCode permission requests through Yep tool approval", async () => {
    const provider = new OpenCodeProvider();
    const handlePermissionAsked = (
      provider as unknown as {
        handlePermissionAsked: (
          baseUrl: string,
          event: unknown,
          signal: AbortSignal,
          onToolApproval: (
            toolName: string,
            input: unknown,
            options: { signal: AbortSignal; requestId?: string },
          ) => Promise<{ behavior: "allow" | "deny" }>,
        ) => Promise<void>;
      }
    ).handlePermissionAsked.bind(provider);

    const replies: unknown[] = [];
    const approvals: Array<{
      toolName: string;
      input: unknown;
      requestId?: string;
    }> = [];

    await withTestServer(
      async (req, res) => {
        if (req.method === "POST" && req.url === "/permission/per_1/reply") {
          replies.push(await readJsonBody(req));
          res.setHeader("Content-Type", "application/json");
          res.end("true");
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      },
      async (baseUrl) => {
        await handlePermissionAsked(
          baseUrl,
          {
            type: "permission.asked",
            properties: {
              id: "per_1",
              sessionID: "ses_1",
              permission: "bash",
              patterns: ["git status"],
              metadata: { cwd: "/repo" },
              always: ["git *"],
              tool: { messageID: "msg_1", callID: "call_1" },
            },
          },
          new AbortController().signal,
          async (toolName, input, options) => {
            approvals.push({ toolName, input, requestId: options.requestId });
            return { behavior: "allow" };
          },
        );
      },
    );

    expect(approvals).toEqual([
      {
        toolName: "Bash",
        input: {
          permission: "bash",
          patterns: ["git status"],
          metadata: { cwd: "/repo" },
          always: ["git *"],
          messageID: "msg_1",
          callID: "call_1",
        },
        requestId: "per_1",
      },
    ]);
    expect(replies).toEqual([{ reply: "once" }]);
  });

  it("ignores duplicate permission.asked events for the same permission id", async () => {
    // OpenCode can re-emit permission.asked for the same id (SSE reconnect
    // replay / repeated event). Without dedup each event queues a fresh
    // pending approval through the Process canUseTool callback, so the popup
    // re-appears after the user already approved and a second click hits a
    // 400. convertSSEEventToSDKMessages must dispatch the approval only once
    // per permission id.
    const provider = new OpenCodeProvider();
    const convertSSEEventToSDKMessages = (
      provider as unknown as {
        convertSSEEventToSDKMessages: (
          event: { type: string; properties: Record<string, unknown> },
          baseUrl: string,
          sessionId: string,
          currentMessageId: string | null,
          signal: AbortSignal,
          messageRoles: ReadonlyMap<string, "user" | "assistant">,
          emissionState: OpenCodeTestEmissionState,
          submittedText: string,
          onToolApproval: (
            toolName: string,
            input: unknown,
            options: { signal: AbortSignal },
          ) => Promise<{ behavior: "allow" | "deny" }>,
          cwd?: string,
        ) => Promise<Array<Record<string, unknown>>>;
      }
    ).convertSSEEventToSDKMessages.bind(provider);

    const emissionState = createEmissionState();
    const approvals: Array<{ toolName: string }> = [];
    const replies: unknown[] = [];
    const event = {
      type: "permission.asked",
      properties: {
        id: "per_dup",
        sessionID: "ses_dup",
        permission: "bash",
        patterns: ["git status"],
        always: ["git *"],
        tool: { messageID: "msg_1", callID: "call_1" },
      },
    };

    await withTestServer(
      async (req, res) => {
        if (req.method === "POST" && req.url === "/permission/per_dup/reply") {
          replies.push(await readJsonBody(req));
          res.setHeader("Content-Type", "application/json");
          res.end("true");
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      },
      async (baseUrl) => {
        const onToolApproval = async (toolName: string) => {
          approvals.push({ toolName });
          return { behavior: "allow" as const };
        };
        const signal = new AbortController().signal;
        const roles = new Map<string, "user" | "assistant">();

        const first = await convertSSEEventToSDKMessages(
          event,
          baseUrl,
          "ses_dup",
          null,
          signal,
          roles,
          emissionState,
          "",
          onToolApproval,
        );
        expect(first).toEqual([]);

        // Replayed duplicate must be ignored: no second approval, no reply.
        const second = await convertSSEEventToSDKMessages(
          event,
          baseUrl,
          "ses_dup",
          null,
          signal,
          roles,
          emissionState,
          "",
          onToolApproval,
        );
        expect(second).toEqual([]);
      },
    );

    expect(approvals).toEqual([{ toolName: "Bash" }]);
    expect(replies).toEqual([{ reply: "once" }]);
  });

  type SendMessageAndStream = (
    baseUrl: string,
    opencodeSessionId: string,
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onToolApproval: (
      toolName: string,
      input: unknown,
      options: { signal: AbortSignal; requestId?: string },
    ) => Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown }>,
    model?: string,
    variant?: string,
    cwd?: string,
  ) => AsyncIterableIterator<Record<string, unknown>>;

  function getSendMessageAndStream(
    provider: OpenCodeProvider,
  ): SendMessageAndStream {
    return (
      provider as unknown as { sendMessageAndStream: SendMessageAndStream }
    ).sendMessageAndStream.bind(provider);
  }

  const fastLifecycle = {
    quietWindowMs: 30,
    reconcileIntervalMs: 20,
    statusFailureGraceMs: 500,
  } as const;

  it("routes a descendant subagent permission to the parent turn and replies to the child", async () => {
    const provider = new OpenCodeProvider({ lifecycle: fastLifecycle });
    const sendMessageAndStream = getSendMessageAndStream(provider);

    let eventStream: ServerResponse | undefined;
    let resolveEventStream: () => void = () => undefined;
    const eventStreamReady = new Promise<void>((resolve) => {
      resolveEventStream = resolve;
    });
    const replies: Array<{ path: string; body: unknown }> = [];
    const approvals: Array<{
      toolName: string;
      input: unknown;
      requestId?: string;
    }> = [];

    const messages = await withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/event") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          res.flushHeaders();
          eventStream = res;
          resolveEventStream();
          return;
        }
        if (req.method === "GET" && url.pathname === "/session/status") {
          res.setHeader("Content-Type", "application/json");
          res.end("{}");
          return;
        }
        if (
          req.method === "GET" &&
          url.pathname === "/session/ses_parent/message"
        ) {
          res.setHeader("Content-Type", "application/json");
          res.end("[]");
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_parent/prompt_async"
        ) {
          await readJsonBody(req);
          res.statusCode = 204;
          res.end();
          await eventStreamReady;
          // The subagent's child session is announced via session.created.
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "session.created",
              properties: {
                info: {
                  id: "ses_child",
                  parentID: "ses_parent",
                  title: "Explore repo",
                  agent: "explore",
                },
              },
            })}\n\n`,
          );
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "permission.asked",
              properties: {
                id: "per_child",
                sessionID: "ses_child",
                permission: "external_directory",
                patterns: ["/tmp/outside"],
                always: ["/tmp/*"],
                tool: { messageID: "msg_c", callID: "call_c" },
              },
            })}\n\n`,
          );
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/permission/per_child/reply"
        ) {
          replies.push({ path: url.pathname, body: await readJsonBody(req) });
          res.setHeader("Content-Type", "application/json");
          res.end("true");
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "session.idle",
              properties: { sessionID: "ses_parent" },
            })}\n\n`,
          );
          eventStream?.end();
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      },
      async (baseUrl) => {
        const output: Array<Record<string, unknown>> = [];
        for await (const message of sendMessageAndStream(
          baseUrl,
          "ses_parent",
          "yep_parent",
          "hello",
          new AbortController().signal,
          async (toolName, input, options) => {
            approvals.push({ toolName, input, requestId: options.requestId });
            return { behavior: "allow" };
          },
          undefined,
          undefined,
          "/repo",
        )) {
          output.push(message);
        }
        return output;
      },
    );

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.requestId).toBe("per_child");
    expect(approvals[0]?.toolName).toBe("external_directory");
    expect(approvals[0]?.input).toMatchObject({
      permission: "external_directory",
      originSessionId: "ses_child",
      parentSessionId: "ses_parent",
      originSessionTitle: "Explore repo",
      originAgent: "explore",
    });
    // The reply targets the child's own OpenCode request id.
    expect(replies).toEqual([
      { path: "/permission/per_child/reply", body: { reply: "once" } },
    ]);
    expect(messages.at(-1)).toMatchObject({
      type: "result",
      session_id: "yep_parent",
    });
  });

  it("routes a descendant subagent question to the parent turn", async () => {
    const provider = new OpenCodeProvider({ lifecycle: fastLifecycle });
    const sendMessageAndStream = getSendMessageAndStream(provider);

    let eventStream: ServerResponse | undefined;
    let resolveEventStream: () => void = () => undefined;
    const eventStreamReady = new Promise<void>((resolve) => {
      resolveEventStream = resolve;
    });
    const approvals: Array<{ toolName: string; input: unknown }> = [];
    const replies: string[] = [];

    await withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/event") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.flushHeaders();
          eventStream = res;
          resolveEventStream();
          return;
        }
        if (req.method === "GET" && url.pathname === "/session/status") {
          res.setHeader("Content-Type", "application/json");
          res.end("{}");
          return;
        }
        if (
          req.method === "GET" &&
          url.pathname === "/session/ses_parent/message"
        ) {
          res.setHeader("Content-Type", "application/json");
          res.end("[]");
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_parent/prompt_async"
        ) {
          await readJsonBody(req);
          res.statusCode = 204;
          res.end();
          await eventStreamReady;
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "session.updated",
              properties: {
                info: {
                  id: "ses_child",
                  parentID: "ses_parent",
                  agent: "explore",
                },
              },
            })}\n\n`,
          );
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "question.asked",
              properties: {
                id: "que_child",
                sessionID: "ses_child",
                questions: [
                  {
                    question: "Proceed?",
                    header: "Confirm",
                    custom: false,
                    options: [{ label: "Yes", description: "go" }],
                  },
                ],
                tool: { messageID: "msg_q", callID: "call_q" },
              },
            })}\n\n`,
          );
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/question/que_child/reply"
        ) {
          replies.push(url.pathname);
          await readJsonBody(req);
          res.setHeader("Content-Type", "application/json");
          res.end("true");
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "session.idle",
              properties: { sessionID: "ses_parent" },
            })}\n\n`,
          );
          eventStream?.end();
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      },
      async (baseUrl) => {
        for await (const _message of sendMessageAndStream(
          baseUrl,
          "ses_parent",
          "yep_parent",
          "hello",
          new AbortController().signal,
          async (toolName, input) => {
            approvals.push({ toolName, input });
            return {
              behavior: "allow",
              updatedInput: {
                ...(input as Record<string, unknown>),
                answers: { "question-0": "Yes" },
              },
            };
          },
          undefined,
          undefined,
          "/repo",
        )) {
          // drain
        }
      },
    );

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.toolName).toBe("AskUserQuestion");
    expect(approvals[0]?.input).toMatchObject({
      originSessionId: "ses_child",
      parentSessionId: "ses_parent",
      originAgent: "explore",
    });
    expect(replies).toEqual(["/question/que_child/reply"]);
  });

  it("ignores permission requests from unrelated sibling sessions in the same directory", async () => {
    const provider = new OpenCodeProvider({ lifecycle: fastLifecycle });
    const sendMessageAndStream = getSendMessageAndStream(provider);

    let eventStream: ServerResponse | undefined;
    let resolveEventStream: () => void = () => undefined;
    const eventStreamReady = new Promise<void>((resolve) => {
      resolveEventStream = resolve;
    });
    const approvals: string[] = [];
    const sessionRecordFetches: string[] = [];

    await withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/event") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.flushHeaders();
          eventStream = res;
          resolveEventStream();
          return;
        }
        if (req.method === "GET" && url.pathname === "/session/status") {
          res.setHeader("Content-Type", "application/json");
          res.end("{}");
          return;
        }
        if (
          req.method === "GET" &&
          url.pathname === "/session/ses_parent/message"
        ) {
          res.setHeader("Content-Type", "application/json");
          res.end("[]");
          return;
        }
        if (req.method === "GET" && url.pathname === "/session/ses_stranger") {
          // A sibling session with no relation to the active parent.
          sessionRecordFetches.push(url.pathname);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ id: "ses_stranger" }));
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_parent/prompt_async"
        ) {
          await readJsonBody(req);
          res.statusCode = 204;
          res.end();
          await eventStreamReady;
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "permission.asked",
              properties: {
                id: "per_stranger",
                sessionID: "ses_stranger",
                permission: "bash",
              },
            })}\n\n`,
          );
          // The parent's own turn then completes normally.
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "session.idle",
              properties: { sessionID: "ses_parent" },
            })}\n\n`,
          );
          eventStream?.end();
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      },
      async (baseUrl) => {
        for await (const _message of sendMessageAndStream(
          baseUrl,
          "ses_parent",
          "yep_parent",
          "hello",
          new AbortController().signal,
          async (toolName) => {
            approvals.push(toolName);
            return { behavior: "allow" };
          },
          undefined,
          undefined,
          "/repo",
        )) {
          // drain
        }
      },
    );

    expect(approvals).toEqual([]);
    // The stranger was checked once for ancestry and then remembered as
    // unrelated (no relation to ses_parent), never routed to approval.
    expect(sessionRecordFetches).toEqual(["/session/ses_stranger"]);
  });

  it("recovers descendant ancestry over HTTP for a nested subagent", async () => {
    const provider = new OpenCodeProvider({ lifecycle: fastLifecycle });
    const sendMessageAndStream = getSendMessageAndStream(provider);

    let eventStream: ServerResponse | undefined;
    let resolveEventStream: () => void = () => undefined;
    const eventStreamReady = new Promise<void>((resolve) => {
      resolveEventStream = resolve;
    });
    const approvals: Array<{ input: unknown; requestId?: string }> = [];
    const replies: string[] = [];

    await withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/event") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.flushHeaders();
          eventStream = res;
          resolveEventStream();
          return;
        }
        if (req.method === "GET" && url.pathname === "/session/status") {
          res.setHeader("Content-Type", "application/json");
          res.end("{}");
          return;
        }
        if (
          req.method === "GET" &&
          url.pathname === "/session/ses_parent/message"
        ) {
          res.setHeader("Content-Type", "application/json");
          res.end("[]");
          return;
        }
        // Ancestry recovery: grandchild -> child -> parent, resolved via HTTP
        // because the intermediate session.created events were missed.
        if (req.method === "GET" && url.pathname === "/session/ses_grand") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              id: "ses_grand",
              parentID: "ses_mid",
              title: "Nested worker",
              agent: "explore",
            }),
          );
          return;
        }
        if (req.method === "GET" && url.pathname === "/session/ses_mid") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ id: "ses_mid", parentID: "ses_parent" }));
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_parent/prompt_async"
        ) {
          await readJsonBody(req);
          res.statusCode = 204;
          res.end();
          await eventStreamReady;
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "permission.asked",
              properties: {
                id: "per_grand",
                sessionID: "ses_grand",
                permission: "bash",
              },
            })}\n\n`,
          );
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/permission/per_grand/reply"
        ) {
          replies.push(url.pathname);
          await readJsonBody(req);
          res.setHeader("Content-Type", "application/json");
          res.end("true");
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "session.idle",
              properties: { sessionID: "ses_parent" },
            })}\n\n`,
          );
          eventStream?.end();
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      },
      async (baseUrl) => {
        for await (const _message of sendMessageAndStream(
          baseUrl,
          "ses_parent",
          "yep_parent",
          "hello",
          new AbortController().signal,
          async (_toolName, input, options) => {
            approvals.push({ input, requestId: options.requestId });
            return { behavior: "allow" };
          },
          undefined,
          undefined,
          "/repo",
        )) {
          // drain
        }
      },
    );

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.requestId).toBe("per_grand");
    expect(approvals[0]?.input).toMatchObject({
      originSessionId: "ses_grand",
      parentSessionId: "ses_parent",
      originSessionTitle: "Nested worker",
    });
    expect(replies).toEqual(["/permission/per_grand/reply"]);
  });

  it("processes two concurrent descendant permissions in order without overwriting", async () => {
    const provider = new OpenCodeProvider({ lifecycle: fastLifecycle });
    const sendMessageAndStream = getSendMessageAndStream(provider);

    let eventStream: ServerResponse | undefined;
    let resolveEventStream: () => void = () => undefined;
    const eventStreamReady = new Promise<void>((resolve) => {
      resolveEventStream = resolve;
    });
    const approvals: string[] = [];
    const replies: string[] = [];

    await withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/event") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.flushHeaders();
          eventStream = res;
          resolveEventStream();
          return;
        }
        if (req.method === "GET" && url.pathname === "/session/status") {
          res.setHeader("Content-Type", "application/json");
          res.end("{}");
          return;
        }
        if (
          req.method === "GET" &&
          url.pathname === "/session/ses_parent/message"
        ) {
          res.setHeader("Content-Type", "application/json");
          res.end("[]");
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_parent/prompt_async"
        ) {
          await readJsonBody(req);
          res.statusCode = 204;
          res.end();
          await eventStreamReady;
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "session.created",
              properties: {
                info: { id: "ses_child_a", parentID: "ses_parent" },
              },
            })}\n\n`,
          );
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "session.created",
              properties: {
                info: { id: "ses_child_b", parentID: "ses_parent" },
              },
            })}\n\n`,
          );
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "permission.asked",
              properties: {
                id: "per_a",
                sessionID: "ses_child_a",
                permission: "bash",
              },
            })}\n\n`,
          );
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "permission.asked",
              properties: {
                id: "per_b",
                sessionID: "ses_child_b",
                permission: "edit",
              },
            })}\n\n`,
          );
          return;
        }
        if (
          req.method === "POST" &&
          (url.pathname === "/permission/per_a/reply" ||
            url.pathname === "/permission/per_b/reply")
        ) {
          replies.push(url.pathname);
          await readJsonBody(req);
          res.setHeader("Content-Type", "application/json");
          res.end("true");
          if (url.pathname === "/permission/per_b/reply") {
            eventStream?.write(
              `data: ${JSON.stringify({
                type: "session.idle",
                properties: { sessionID: "ses_parent" },
              })}\n\n`,
            );
            eventStream?.end();
          }
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      },
      async (baseUrl) => {
        for await (const _message of sendMessageAndStream(
          baseUrl,
          "ses_parent",
          "yep_parent",
          "hello",
          new AbortController().signal,
          async (toolName) => {
            approvals.push(toolName);
            return { behavior: "allow" };
          },
          undefined,
          undefined,
          "/repo",
        )) {
          // drain
        }
      },
    );

    // Both children were handled, in arrival order, each replying to its own
    // request id — neither overwrote the other.
    expect(approvals).toEqual(["Bash", "Edit"]);
    expect(replies).toEqual([
      "/permission/per_a/reply",
      "/permission/per_b/reply",
    ]);
  });

  it("uses prompt_async and bridges OpenCode questions through Yep", async () => {
    const provider = new OpenCodeProvider();
    const sendMessageAndStream = (
      provider as unknown as {
        sendMessageAndStream: (
          baseUrl: string,
          opencodeSessionId: string,
          sessionId: string,
          text: string,
          signal: AbortSignal,
          onToolApproval: (
            toolName: string,
            input: unknown,
            options: { signal: AbortSignal },
          ) => Promise<{
            behavior: "allow" | "deny";
            updatedInput?: unknown;
          }>,
          model?: string,
          variant?: string,
          cwd?: string,
          fileParts?: Array<{
            type: "file";
            mime: string;
            filename?: string;
            url: string;
          }>,
        ) => AsyncIterableIterator<Record<string, unknown>>;
      }
    ).sendMessageAndStream.bind(provider);

    let eventStream: ServerResponse | undefined;
    let resolveEventStream: () => void = () => undefined;
    const eventStreamReady = new Promise<void>((resolve) => {
      resolveEventStream = resolve;
    });
    const requests: Array<{
      path: string;
      directory: string | null;
      body: unknown;
      directoryHeader?: string;
    }> = [];
    const approvals: Array<{ toolName: string; input: unknown }> = [];

    const messages = await withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/event") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.flushHeaders();
          eventStream = res;
          resolveEventStream();
          return;
        }

        if (req.method === "GET" && url.pathname === "/session/status") {
          res.setHeader("Content-Type", "application/json");
          res.end("{}");
          return;
        }

        if (
          req.method === "GET" &&
          url.pathname === "/session/ses_open/message"
        ) {
          res.setHeader("Content-Type", "application/json");
          res.end("[]");
          return;
        }

        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_open/prompt_async"
        ) {
          requests.push({
            path: url.pathname,
            directory: url.searchParams.get("directory"),
            body: await readJsonBody(req),
            directoryHeader: req.headers["x-opencode-directory"] as
              | string
              | undefined,
          });
          res.statusCode = 204;
          res.end();
          await eventStreamReady;
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "question.asked",
              properties: {
                id: "que_1",
                sessionID: "ses_open",
                questions: [
                  {
                    question: "Choose one",
                    header: "First",
                    custom: false,
                    options: [{ label: "A", description: "Option A" }],
                  },
                  {
                    question: "Choose many",
                    header: "Second",
                    multiple: true,
                    options: [
                      { label: "B", description: "Option B" },
                      { label: "C", description: "Option C" },
                    ],
                  },
                ],
                tool: { messageID: "msg_1", callID: "call_1" },
              },
            })}\n\n`,
          );
          return;
        }

        if (req.method === "POST" && url.pathname === "/question/que_1/reply") {
          requests.push({
            path: url.pathname,
            directory: url.searchParams.get("directory"),
            body: await readJsonBody(req),
            directoryHeader: req.headers["x-opencode-directory"] as
              | string
              | undefined,
          });
          res.setHeader("Content-Type", "application/json");
          res.end("true");
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "session.idle",
              properties: { sessionID: "ses_open" },
            })}\n\n`,
          );
          eventStream?.end();
          return;
        }

        res.statusCode = 404;
        res.end("not found");
      },
      async (baseUrl) => {
        const output: Array<Record<string, unknown>> = [];
        for await (const message of sendMessageAndStream(
          baseUrl,
          "ses_open",
          "yep_session",
          "hello",
          new AbortController().signal,
          async (toolName, input) => {
            approvals.push({ toolName, input });
            return {
              behavior: "allow",
              updatedInput: {
                ...(input as Record<string, unknown>),
                answers: {
                  "question-0": "A",
                  "Choose many": ["B", "C"],
                },
              },
            };
          },
          "yep-anthropic/glm-5.2",
          "max",
          "/repo",
          [
            {
              type: "file",
              mime: "image/png",
              filename: "screenshot.png",
              url: "file:///repo/screenshot.png",
            },
          ],
        )) {
          output.push(message);
        }
        return output;
      },
    );

    expect(approvals).toEqual([
      {
        toolName: "AskUserQuestion",
        input: {
          questions: [
            {
              id: "question-0",
              question: "Choose one",
              header: "First",
              options: [{ label: "A", description: "Option A" }],
              multiSelect: false,
              custom: false,
            },
            {
              id: "question-1",
              question: "Choose many",
              header: "Second",
              options: [
                { label: "B", description: "Option B" },
                { label: "C", description: "Option C" },
              ],
              multiSelect: true,
            },
          ],
          messageID: "msg_1",
          callID: "call_1",
        },
      },
    ]);
    expect(requests).toEqual([
      {
        path: "/session/ses_open/prompt_async",
        directory: "/repo",
        directoryHeader: "/repo",
        body: {
          parts: [
            {
              type: "file",
              mime: "image/png",
              filename: "screenshot.png",
              url: "file:///repo/screenshot.png",
            },
            { type: "text", text: "hello" },
          ],
          model: { providerID: "yep-anthropic", modelID: "glm-5.2" },
          variant: "max",
        },
      },
      {
        path: "/question/que_1/reply",
        directory: "/repo",
        directoryHeader: "/repo",
        body: { answers: [["A"], ["B", "C"]] },
      },
    ]);
    expect(messages.at(-1)).toMatchObject({
      type: "result",
      session_id: "yep_session",
    });
  });

  it("survives idle jitter and an SSE reconnect before emitting one result", async () => {
    const provider = new OpenCodeProvider({
      lifecycle: {
        quietWindowMs: 30,
        reconcileIntervalMs: 20,
        statusFailureGraceMs: 500,
      },
    });
    const sendMessageAndStream = (
      provider as unknown as {
        sendMessageAndStream: (
          baseUrl: string,
          opencodeSessionId: string,
          sessionId: string,
          text: string,
          signal: AbortSignal,
        ) => AsyncIterableIterator<Record<string, unknown>>;
      }
    ).sendMessageAndStream.bind(provider);

    let eventConnections = 0;
    let firstStream: ServerResponse | undefined;
    let status: "busy" | "idle" = "busy";
    let terminalAssistant = false;

    const messages = await withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/event") {
          eventConnections += 1;
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          res.flushHeaders();
          if (eventConnections === 1) {
            firstStream = res;
          } else {
            setTimeout(() => {
              terminalAssistant = true;
              status = "idle";
              res.write(
                `data: ${JSON.stringify({
                  type: "message.updated",
                  properties: {
                    info: {
                      id: "msg_terminal",
                      sessionID: "ses_jitter",
                      role: "assistant",
                      finish: "stop",
                      time: { completed: Date.now() },
                    },
                  },
                })}\n\n`,
              );
              res.write(
                `data: ${JSON.stringify({
                  type: "session.status",
                  properties: {
                    sessionID: "ses_jitter",
                    status: { type: "idle" },
                  },
                })}\n\n`,
              );
            }, 5);
          }
          return;
        }

        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_jitter/prompt_async"
        ) {
          req.resume();
          res.statusCode = 204;
          res.end();
          firstStream?.write(
            `data: ${JSON.stringify({
              type: "session.status",
              properties: {
                sessionID: "ses_jitter",
                status: { type: "busy" },
              },
            })}\n\n`,
          );
          status = "idle";
          firstStream?.write(
            `data: ${JSON.stringify({
              type: "session.status",
              properties: {
                sessionID: "ses_jitter",
                status: { type: "idle" },
              },
            })}\n\n`,
          );
          setTimeout(() => {
            status = "busy";
            firstStream?.write(
              `data: ${JSON.stringify({
                type: "session.status",
                properties: {
                  sessionID: "ses_jitter",
                  status: { type: "busy" },
                },
              })}\n\n`,
            );
            firstStream?.end();
          }, 5);
          return;
        }

        if (req.method === "GET" && url.pathname === "/session/status") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify(
              status === "busy" ? { ses_jitter: { type: "busy" } } : {},
            ),
          );
          return;
        }

        if (
          req.method === "GET" &&
          url.pathname === "/session/ses_jitter/message"
        ) {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify(
              terminalAssistant
                ? [
                    {
                      info: {
                        id: "msg_terminal",
                        sessionID: "ses_jitter",
                        role: "assistant",
                        finish: "stop",
                        time: { completed: Date.now() },
                      },
                      parts: [],
                    },
                  ]
                : [],
            ),
          );
          return;
        }

        res.statusCode = 404;
        res.end("not found");
      },
      async (baseUrl) => {
        const output: Array<Record<string, unknown>> = [];
        for await (const message of sendMessageAndStream(
          baseUrl,
          "ses_jitter",
          "yep_jitter",
          "hello",
          new AbortController().signal,
        )) {
          output.push(message);
        }
        return output;
      },
    );

    expect(eventConnections).toBeGreaterThanOrEqual(2);
    expect(messages.filter((message) => message.type === "result")).toEqual([
      expect.objectContaining({
        type: "result",
        session_id: "yep_jitter",
      }),
    ]);
    expect(messages.some((message) => message.type === "error")).toBe(false);
  });

  it("rejects denied OpenCode questions", async () => {
    const provider = new OpenCodeProvider();
    const handleQuestionAsked = (
      provider as unknown as {
        handleQuestionAsked: (
          baseUrl: string,
          event: unknown,
          signal: AbortSignal,
          onToolApproval: () => Promise<{ behavior: "deny" }>,
        ) => Promise<void>;
      }
    ).handleQuestionAsked.bind(provider);
    const requests: Array<{ url?: string; body: unknown }> = [];

    await withTestServer(
      async (req, res) => {
        requests.push({ url: req.url, body: await readJsonBody(req) });
        res.setHeader("Content-Type", "application/json");
        res.end("true");
      },
      (baseUrl) =>
        handleQuestionAsked(
          baseUrl,
          {
            type: "question.asked",
            properties: {
              id: "que_deny",
              sessionID: "ses_1",
              questions: [
                {
                  question: "Continue?",
                  header: "Continue",
                  options: [{ label: "No", description: "Stop" }],
                },
              ],
            },
          },
          new AbortController().signal,
          async () => ({ behavior: "deny" }),
        ),
    );

    expect(requests).toEqual([
      { url: "/question/que_deny/reject", body: null },
    ]);
  });

  it("rejects allowed OpenCode questions when any ordered answer is empty", async () => {
    const provider = new OpenCodeProvider();
    const handleQuestionAsked = (
      provider as unknown as {
        handleQuestionAsked: (
          baseUrl: string,
          event: unknown,
          signal: AbortSignal,
          onToolApproval: () => Promise<{
            behavior: "allow";
            updatedInput: unknown;
          }>,
        ) => Promise<void>;
      }
    ).handleQuestionAsked.bind(provider);
    const requests: Array<{ url?: string; body: unknown }> = [];

    await withTestServer(
      async (req, res) => {
        requests.push({ url: req.url, body: await readJsonBody(req) });
        res.setHeader("Content-Type", "application/json");
        res.end("true");
      },
      (baseUrl) =>
        handleQuestionAsked(
          baseUrl,
          {
            type: "question.asked",
            properties: {
              id: "que_incomplete",
              sessionID: "ses_1",
              questions: [
                {
                  question: "Continue?",
                  header: "Continue",
                  options: [{ label: "Yes", description: "Proceed" }],
                },
              ],
            },
          },
          new AbortController().signal,
          async () => ({
            behavior: "allow",
            updatedInput: { answers: { "question-0": [] } },
          }),
        ),
    );

    expect(requests).toEqual([
      { url: "/question/que_incomplete/reject", body: null },
    ]);
  });

  it("times out an unresponsive SSE handshake before sending the prompt", async () => {
    const provider = new OpenCodeProvider({ timeout: 20 });
    const sendMessageAndStream = (
      provider as unknown as {
        sendMessageAndStream: (
          baseUrl: string,
          opencodeSessionId: string,
          sessionId: string,
          text: string,
          signal: AbortSignal,
        ) => AsyncIterableIterator<Record<string, unknown>>;
      }
    ).sendMessageAndStream.bind(provider);
    let eventRequests = 0;
    let promptRequests = 0;
    let abortRequests = 0;

    const messages = await withTestServer(
      (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/event") {
          eventRequests += 1;
          req.once("aborted", () => res.destroy());
          return;
        }
        if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) {
          promptRequests += 1;
          res.statusCode = 204;
          res.end();
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_timeout/abort"
        ) {
          abortRequests += 1;
          res.setHeader("Content-Type", "application/json");
          res.end("true");
          return;
        }
        res.statusCode = 404;
        res.end();
      },
      async (baseUrl) => {
        const output: Array<Record<string, unknown>> = [];
        for await (const message of sendMessageAndStream(
          baseUrl,
          "ses_timeout",
          "yep_timeout",
          "hello",
          new AbortController().signal,
        )) {
          output.push(message);
        }
        return output;
      },
    );

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "error",
        session_id: "yep_timeout",
        error: "Timed out connecting to OpenCode SSE",
      }),
    );
    expect(eventRequests).toBe(1);
    expect(promptRequests).toBe(0);
    expect(abortRequests).toBe(1);
  });

  it("surfaces prompt_async session errors from SSE", async () => {
    const provider = new OpenCodeProvider();
    const sendMessageAndStream = (
      provider as unknown as {
        sendMessageAndStream: (
          baseUrl: string,
          opencodeSessionId: string,
          sessionId: string,
          text: string,
          signal: AbortSignal,
        ) => AsyncIterableIterator<Record<string, unknown>>;
      }
    ).sendMessageAndStream.bind(provider);
    let eventStream: ServerResponse | undefined;
    let abortRequests = 0;

    const messages = await withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/event") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.flushHeaders();
          eventStream = res;
          return;
        }
        if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) {
          await readJsonBody(req);
          res.statusCode = 204;
          res.end();
          // OpenCode keeps its SSE connection alive after session.error. The
          // provider must still finish the turn instead of waiting forever for
          // the response body to close.
          eventStream?.write(
            `data: ${JSON.stringify({
              type: "session.error",
              properties: {
                sessionID: "ses_error",
                error: {
                  name: "APIError",
                  data: { message: "Upstream unavailable" },
                },
              },
            })}\n\n`,
          );
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_error/abort"
        ) {
          abortRequests += 1;
          res.setHeader("Content-Type", "application/json");
          res.end("true");
          return;
        }
        res.statusCode = 404;
        res.end();
      },
      async (baseUrl) => {
        const output: Array<Record<string, unknown>> = [];
        for await (const message of sendMessageAndStream(
          baseUrl,
          "ses_error",
          "yep_error",
          "hello",
          new AbortController().signal,
        )) {
          output.push(message);
        }
        return output;
      },
    );

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "error",
        session_id: "yep_error",
        error: "Upstream unavailable",
      }),
    );
    expect(messages.at(-1)).toMatchObject({
      type: "result",
      session_id: "yep_error",
      subtype: "error_during_execution",
      is_error: true,
      error: "Upstream unavailable",
    });
    expect(abortRequests).toBe(1);
  });

  it("completes a finish=unknown response instead of polling forever", async () => {
    const provider = new OpenCodeProvider({
      lifecycle: {
        quietWindowMs: 10,
        reconcileIntervalMs: 5,
        statusFailureGraceMs: 500,
      },
    });
    const sendMessageAndStream = getSendMessageAndStream(provider);
    let abortRequests = 0;
    const terminalNotifications: unknown[] = [];

    const messages = await withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/event") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.flushHeaders();
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_unknown/prompt_async"
        ) {
          await readJsonBody(req);
          res.statusCode = 204;
          res.end();
          return;
        }
        if (req.method === "GET" && url.pathname === "/session/status") {
          res.setHeader("Content-Type", "application/json");
          res.end("{}");
          return;
        }
        if (
          req.method === "GET" &&
          url.pathname === "/session/ses_unknown/message"
        ) {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify([
              {
                info: {
                  id: "msg_unknown",
                  sessionID: "ses_unknown",
                  role: "assistant",
                  finish: "unknown",
                  time: { completed: Date.now() },
                },
                parts: [],
              },
            ]),
          );
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/session/ses_unknown/abort"
        ) {
          abortRequests += 1;
          res.setHeader("Content-Type", "application/json");
          res.end("true");
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname === "/sessions/ses_unknown/terminal"
        ) {
          terminalNotifications.push(await readJsonBody(req));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ terminal: true }));
          return;
        }
        res.statusCode = 404;
        res.end();
      },
      async (baseUrl) => {
        provider.configureBridgeControlUrl(baseUrl);
        const output: Array<Record<string, unknown>> = [];
        for await (const message of sendMessageAndStream(
          baseUrl,
          "ses_unknown",
          "yep_unknown",
          "hello",
          new AbortController().signal,
          async () => ({ behavior: "allow" }),
        )) {
          output.push(message);
        }
        return output;
      },
    );

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "result",
        session_id: "yep_unknown",
      }),
    );
    expect(messages.some((message) => message.type === "error")).toBe(false);
    expect(abortRequests).toBe(0);
    expect(terminalNotifications).toEqual([]);
  });

  it("exposes OpenCode child-process liveness to stale detection", async () => {
    const provider = new OpenCodeProvider();
    const fakeChild = {
      exitCode: null as number | null,
      signalCode: null,
    };
    const methods = provider as unknown as {
      runSession: (
        ...args: unknown[]
      ) => AsyncIterableIterator<Record<string, unknown>>;
    };
    methods.runSession = async function* (...args: unknown[]) {
      const processRef = args[5] as { value?: unknown };
      processRef.value = fakeChild;
      yield { type: "system", subtype: "init" };
    };

    const session = await provider.startSession({ cwd: "/repo" });
    expect(session.isProcessAlive?.()).toBe(false);
    await session.iterator.next();
    expect(session.isProcessAlive?.()).toBe(true);
    fakeChild.exitCode = 0;
    expect(session.isProcessAlive?.()).toBe(false);
    session.abort();
  });

  it("does not render OpenCode user text parts as assistant messages", () => {
    const provider = new OpenCodeProvider();
    const convertPartToSDKMessages = getConvertPartToSDKMessages(provider);
    const emissionState = createEmissionState();

    expect(
      convertPartToSDKMessages(
        {
          id: "part_user",
          sessionID: "ses_1",
          messageID: "msg_user",
          type: "text",
          text: "你能搜索网页吗",
        },
        "yep_session",
        undefined,
        null,
        "user",
        emissionState,
      ),
    ).toEqual([]);

    expect(
      convertPartToSDKMessages(
        {
          id: "part_synthetic_read",
          sessionID: "ses_1",
          messageID: "msg_unknown",
          type: "text",
          text: 'Called the Read tool with the following input: {"filePath":"/uploads/screenshot.png"}',
          synthetic: true,
        },
        "yep_session",
        undefined,
        null,
        undefined,
        emissionState,
      ),
    ).toEqual([]);

    expect(
      convertPartToSDKMessages(
        {
          id: "part_unknown_echo",
          sessionID: "ses_1",
          messageID: "msg_unknown",
          type: "text",
          text: "你能搜索网页吗",
        },
        "yep_session",
        undefined,
        null,
        undefined,
        emissionState,
        "你能搜索网页吗",
      ),
    ).toEqual([]);
  });

  it("streams OpenCode assistant text as SDK stream events", () => {
    const provider = new OpenCodeProvider();
    const convertPartToSDKMessages = getConvertPartToSDKMessages(provider);
    const emissionState = createEmissionState();

    expect(
      convertPartToSDKMessages(
        {
          id: "part_assistant",
          sessionID: "ses_1",
          messageID: "msg_assistant",
          type: "text",
          text: "可以，我能搜索网页。",
        },
        "yep_session",
        undefined,
        null,
        "assistant",
        emissionState,
      ),
    ).toEqual([
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({
          type: "message_start",
          message: expect.objectContaining({ id: "msg_assistant" }),
        }),
      }),
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      }),
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "可以，我能搜索网页。" },
        }),
      }),
    ]);

    expect(
      convertPartToSDKMessages(
        {
          id: "finish",
          sessionID: "ses_1",
          messageID: "msg_assistant",
          type: "step-finish",
        },
        "yep_session",
        undefined,
        null,
        "assistant",
        emissionState,
      ),
    ).toEqual([
      expect.objectContaining({
        type: "stream_event",
        event: { type: "message_stop" },
      }),
      expect.objectContaining({
        type: "assistant",
        uuid: "msg_assistant",
        message: { role: "assistant", content: "可以，我能搜索网页。" },
      }),
    ]);
  });

  it.each([
    {
      partType: "text" as const,
      expectedDelta: { type: "text_delta", text: "Hello" },
    },
    {
      partType: "reasoning" as const,
      expectedDelta: { type: "thinking_delta", thinking: "Hello" },
    },
  ])(
    "consumes standalone message.part.delta for $partType parts",
    async ({ partType, expectedDelta }) => {
      const provider = new OpenCodeProvider();
      const convertEvent = getConvertSSEEventToSDKMessages(provider);
      const emissionState = createEmissionState();
      const messageRoles = new Map([["msg_assistant", "assistant" as const]]);
      const common = [
        "http://127.0.0.1:1",
        "yep_session",
        null,
        new AbortController().signal,
        messageRoles,
        emissionState,
        "",
      ] as const;

      await expect(
        convertEvent(
          {
            type: "message.part.updated",
            properties: {
              part: {
                id: "part_streaming",
                sessionID: "ses_1",
                messageID: "msg_assistant",
                type: partType,
                text: "",
              },
            },
          },
          ...common,
        ),
      ).resolves.toEqual([]);

      const deltaMessages = await convertEvent(
        {
          type: "message.part.delta",
          properties: {
            sessionID: "ses_1",
            messageID: "msg_assistant",
            partID: "part_streaming",
            field: "text",
            delta: "Hello",
          },
        },
        ...common,
      );
      expect(deltaMessages).toEqual([
        expect.objectContaining({
          type: "stream_event",
          event: expect.objectContaining({ type: "message_start" }),
        }),
        expect.objectContaining({
          type: "stream_event",
          event: expect.objectContaining({ type: "content_block_start" }),
        }),
        expect.objectContaining({
          type: "stream_event",
          event: expect.objectContaining({
            type: "content_block_delta",
            delta: expectedDelta,
          }),
        }),
      ]);

      await convertEvent(
        {
          type: "message.part.delta",
          properties: {
            sessionID: "ses_1",
            messageID: "msg_assistant",
            partID: "part_streaming",
            field: "text",
            delta: " world",
          },
        },
        ...common,
      );
      await expect(
        convertEvent(
          {
            type: "message.part.updated",
            properties: {
              part: {
                id: "part_streaming",
                sessionID: "ses_1",
                messageID: "msg_assistant",
                type: partType,
                text: "Hello world",
              },
            },
          },
          ...common,
        ),
      ).resolves.toEqual([]);
    },
  );

  it("derives deltas from cumulative OpenCode assistant text parts", () => {
    const provider = new OpenCodeProvider();
    const convertPartToSDKMessages = getConvertPartToSDKMessages(provider);
    const emissionState = createEmissionState();
    const part: OpenCodeTestPart = {
      id: "part_assistant",
      sessionID: "ses_1",
      messageID: "msg_assistant",
      type: "text",
      text: "Hello",
    };

    expect(
      convertPartToSDKMessages(
        part,
        "yep_session",
        undefined,
        null,
        "assistant",
        emissionState,
      ).at(-1),
    ).toEqual(
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        }),
      }),
    );

    expect(
      convertPartToSDKMessages(
        { ...part, text: "Hello world" },
        "yep_session",
        undefined,
        null,
        "assistant",
        emissionState,
      ),
    ).toEqual([
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({
          type: "content_block_delta",
          delta: { type: "text_delta", text: " world" },
        }),
      }),
    ]);
  });

  it("renders OpenCode 1.17 tool parts as tool use and result messages", () => {
    const provider = new OpenCodeProvider();
    const convertPartToSDKMessages = getConvertPartToSDKMessages(provider);
    const emissionState = createEmissionState();

    const messages = convertPartToSDKMessages(
      {
        id: "prt_tool",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "tool",
        callID: "call_1",
        tool: "webfetch",
        state: {
          status: "completed",
          input: { url: "https://example.com" },
          output: "Example Domain",
        },
      },
      "yep_session",
      undefined,
      null,
      "assistant",
      emissionState,
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: "assistant",
        message: expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({
              type: "tool_use",
              id: "call_1",
              name: "webfetch",
              input: { url: "https://example.com" },
              opencodeStatus: "completed",
            }),
          ],
        }),
      }),
      expect.objectContaining({
        type: "user",
        message: expect.objectContaining({
          role: "user",
          content: [
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call_1",
              content: "Example Domain",
              is_error: false,
              opencodeStatus: "completed",
            }),
          ],
        }),
      }),
    ]);
  });

  it("flushes accumulated assistant text before emitting a tool_use", () => {
    const provider = new OpenCodeProvider();
    const convertPartToSDKMessages = getConvertPartToSDKMessages(provider);
    const emissionState = createEmissionState();

    // Model streams reasoning/text ahead of a tool call within the same turn.
    convertPartToSDKMessages(
      {
        id: "part_text",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "text",
        text: "Deciding to improve the design",
      },
      "yep_session",
      undefined,
      null,
      "assistant",
      emissionState,
    );

    const messages = convertPartToSDKMessages(
      {
        id: "prt_tool",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: { status: "running", input: { command: "ls -la" } },
      },
      "yep_session",
      undefined,
      null,
      "assistant",
      emissionState,
    );

    // The streamed text must land as a permanent assistant message (preceded by
    // message_stop) BEFORE the tool_use, otherwise the client clears the
    // `_isStreaming` placeholder on the tool_use and the text vanishes until the
    // eventual step-finish re-emits it.
    expect(messages).toEqual([
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({ type: "message_stop" }),
      }),
      expect.objectContaining({
        type: "assistant",
        uuid: "msg_assistant",
        message: expect.objectContaining({
          role: "assistant",
          content: "Deciding to improve the design",
        }),
      }),
      expect.objectContaining({
        type: "assistant",
        message: expect.objectContaining({
          content: [
            expect.objectContaining({
              type: "tool_use",
              id: "call_1",
              name: "Bash",
            }),
          ],
        }),
      }),
    ]);
  });

  it("starts post-tool assistant text under the new OpenCode step message ID", () => {
    const provider = new OpenCodeProvider();
    const convertPartToSDKMessages = getConvertPartToSDKMessages(provider);
    const emissionState = createEmissionState();

    convertPartToSDKMessages(
      {
        id: "part_step_1",
        sessionID: "ses_1",
        messageID: "msg_step_1",
        type: "text",
        text: "I will inspect the file.",
      },
      "yep_session",
      undefined,
      null,
      "assistant",
      emissionState,
    );
    convertPartToSDKMessages(
      {
        id: "tool_step_1",
        sessionID: "ses_1",
        messageID: "msg_step_1",
        type: "tool",
        callID: "call_1",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/repo/app.ts" },
          output: "const value = 1;",
        },
      },
      "yep_session",
      undefined,
      "msg_step_1",
      "assistant",
      emissionState,
    );

    // message.updated can still point at the preceding assistant step when the
    // first part for the post-tool step arrives. The native part.messageID must
    // win so the client appends a new row below the tool.
    const postToolMessages = convertPartToSDKMessages(
      {
        id: "part_step_2",
        sessionID: "ses_1",
        messageID: "msg_step_2",
        type: "text",
        text: "The file is valid.",
      },
      "yep_session",
      undefined,
      "msg_step_1",
      "assistant",
      emissionState,
    );

    expect(postToolMessages).toEqual([
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({
          type: "message_start",
          message: expect.objectContaining({ id: "msg_step_2" }),
        }),
      }),
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({ type: "content_block_start" }),
      }),
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "The file is valid." },
        }),
      }),
    ]);

    expect(
      convertPartToSDKMessages(
        {
          id: "finish_step_2",
          sessionID: "ses_1",
          messageID: "msg_step_2",
          type: "step-finish",
        },
        "yep_session",
        undefined,
        "msg_step_1",
        "assistant",
        emissionState,
      ).at(-1),
    ).toMatchObject({
      type: "assistant",
      uuid: "msg_step_2",
      message: { role: "assistant", content: "The file is valid." },
    });
  });

  it("re-emits tool_use when running-stage input materializes", () => {
    const provider = new OpenCodeProvider();
    const convertPartToSDKMessages = getConvertPartToSDKMessages(provider);
    const emissionState = createEmissionState();

    const pending = convertPartToSDKMessages(
      {
        id: "prt_tool2",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "tool",
        callID: "call_2",
        tool: "bash",
        state: { status: "pending", input: {} },
      },
      "yep_session",
      undefined,
      null,
      "assistant",
      emissionState,
    );
    expect(pending).toHaveLength(1);

    const running = convertPartToSDKMessages(
      {
        id: "prt_tool2",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "tool",
        callID: "call_2",
        tool: "bash",
        state: { status: "running", input: { command: "ls -la" } },
      },
      "yep_session",
      undefined,
      null,
      "assistant",
      emissionState,
    );
    expect(running).toEqual([
      expect.objectContaining({
        type: "assistant",
        message: expect.objectContaining({
          content: [
            expect.objectContaining({
              type: "tool_use",
              id: "call_2",
              input: { command: "ls -la" },
              opencodeStatus: "running",
            }),
          ],
        }),
      }),
    ]);

    // Unchanged input does not re-emit.
    const runningAgain = convertPartToSDKMessages(
      {
        id: "prt_tool2",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "tool",
        callID: "call_2",
        tool: "bash",
        state: { status: "running", input: { command: "ls -la" } },
      },
      "yep_session",
      undefined,
      null,
      "assistant",
      emissionState,
    );
    expect(runningAgain).toEqual([]);
  });

  it("emits a visible marker for OpenCode subtask parts", () => {
    const provider = new OpenCodeProvider();
    const convertPartToSDKMessages = getConvertPartToSDKMessages(provider);
    const emissionState = createEmissionState();

    const part = {
      id: "prt_subtask",
      sessionID: "ses_1",
      messageID: "msg_assistant",
      type: "subtask",
      prompt: "Investigate flaky test",
      description: "Investigate the flaky auth test",
      agent: "explore",
    } as unknown as Parameters<typeof convertPartToSDKMessages>[0];

    const messages = convertPartToSDKMessages(
      part,
      "yep_session",
      undefined,
      null,
      "assistant",
      emissionState,
    );
    expect(messages).toEqual([
      expect.objectContaining({
        type: "assistant",
        message: expect.objectContaining({
          content: [
            expect.objectContaining({
              type: "text",
              text: "**Subagent (explore)**: Investigate the flaky auth test",
            }),
          ],
        }),
      }),
    ]);

    // Duplicate part updates do not re-emit the marker.
    expect(
      convertPartToSDKMessages(
        part,
        "yep_session",
        undefined,
        null,
        "assistant",
        emissionState,
      ),
    ).toEqual([]);
  });

  it("does not copy an unnamed data URI attachment into streamed transcript text", () => {
    const provider = new OpenCodeProvider();
    const convertPartToSDKMessages = getConvertPartToSDKMessages(provider);
    const emissionState = createEmissionState();
    const part = {
      id: "prt_inline_file",
      sessionID: "ses_1",
      messageID: "msg_user",
      type: "file",
      mime: "image/png",
      url: `data:image/png;base64,${"A".repeat(8_192)}`,
    } as unknown as Parameters<typeof convertPartToSDKMessages>[0];

    const messages = convertPartToSDKMessages(
      part,
      "yep_session",
      undefined,
      null,
      "user",
      emissionState,
    );
    expect(messages).toMatchObject([
      {
        type: "user",
        message: {
          content: [{ type: "text", text: "📎 attachment (image/png)" }],
        },
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("data:image/png;base64");
  });

  it("retains native file metadata while parsing OpenCode SSE events", () => {
    const event = parseOpenCodeSSEEvent(
      JSON.stringify({
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_file",
            sessionID: "ses_1",
            messageID: "msg_user",
            type: "file",
            mime: "image/png",
            filename: "screenshot.png",
            url: "data:image/png;base64,AQID",
          },
        },
      }),
    );

    expect(event).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          type: "file",
          mime: "image/png",
          filename: "screenshot.png",
          url: "data:image/png;base64,AQID",
        },
      },
    });
  });

  it("does not emit a duplicate file marker for Yep-uploaded user files", () => {
    const provider = new OpenCodeProvider();
    const convertPartToSDKMessages = getConvertPartToSDKMessages(provider);
    const submittedText =
      "review this\n\nUser uploaded files:\n- screenshot.png (1 KB, image/png): /uploads/screenshot.png";

    expect(
      convertPartToSDKMessages(
        {
          id: "prt_yep_upload",
          sessionID: "ses_1",
          messageID: "msg_user",
          type: "file",
          filename: "screenshot.png",
        },
        "yep_session",
        undefined,
        null,
        "user",
        createEmissionState(),
        submittedText,
      ),
    ).toEqual([]);

    expect(
      convertPartToSDKMessages(
        {
          id: "prt_inline_image",
          sessionID: "ses_1",
          messageID: "msg_user",
          type: "file",
          mime: "image/jpeg",
          url: "data:image/jpeg;base64,AQID",
        },
        "yep_session",
        undefined,
        null,
        "user",
        createEmissionState(),
        submittedText,
      ),
    ).toMatchObject([
      {
        type: "user",
        message: {
          content: [{ type: "text", text: "📎 attachment (image/jpeg)" }],
        },
      },
    ]);
  });

  it("records step-finish usage without emitting a premature result", () => {
    const provider = new OpenCodeProvider();
    const convertPartToSDKMessages = getConvertPartToSDKMessages(provider);
    const emissionState = createEmissionState();

    const messages = convertPartToSDKMessages(
      {
        id: "finish",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "step-finish",
        cost: 0.0123,
        tokens: {
          input: 10,
          output: 5,
          reasoning: 3,
          cache: { read: 7, write: 2 },
        },
      },
      "yep_session",
      undefined,
      null,
      "assistant",
      emissionState,
    );

    expect(messages).toEqual([]);
    expect(emissionState.latestUsage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 3,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 2,
      cost_usd: 0.0123,
    });
  });

  it("preserves user-config credentials before a managed model is selected", () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_API_BASE = "https://example.test/v1";
    Reflect.deleteProperty(process.env, "LLM_SUB_MODULE");
    Reflect.deleteProperty(process.env, "OPENCODE_LLM_API_KEY");
    Reflect.deleteProperty(process.env, "OPENCODE_LLM_API_BASE");
    Reflect.deleteProperty(process.env, "OPENCODE_LLM_SUB_MODULE");
    Reflect.deleteProperty(process.env, "OPENCODE_CONFIG_CONTENT");
    process.env.SESSION_TITLE_LLM_API_KEY = "stale-title-key";
    process.env.SESSION_TITLE_LLM_API_BASE = "https://title.example/v1";
    process.env.SESSION_TITLE_SUB_MODULE = "test-module";
    Reflect.deleteProperty(process.env, "YEP_OPENCODE_BRIDGE_CONTROL_URL");
    Reflect.deleteProperty(process.env, "OPENCODE_BRIDGE_CONTROL_URL");
    Reflect.deleteProperty(process.env, "YEP_OPENCODE_BRIDGE_URL");
    Reflect.deleteProperty(process.env, "OPENCODE_BRIDGE_URL");

    const provider = new OpenCodeProvider();
    const getOpenCodeEnv = (
      provider as unknown as {
        getOpenCodeEnv: (
          config: undefined,
          managedServerPort: number,
        ) => NodeJS.ProcessEnv;
      }
    ).getOpenCodeEnv.bind(provider);

    const env = getOpenCodeEnv(undefined, 4567);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(env.LLM_API_KEY).toBe("test-key");
    expect(env.LLM_API_BASE).toBe("https://example.test/v1");
    expect(env).not.toHaveProperty("YEP_OPENCODE_LLM_API_KEY");
    expect(env.YEP_MANAGED_OPENCODE).toBe("1");
    expect(env.YEP_MANAGED_OPENCODE_SERVER_PORT).toBe("4567");
    expect(config.provider).toBeUndefined();
    expect(env).not.toHaveProperty("LLM_SUB_MODULE");
  });

  it("uses an explicit OpenCode submodule in provider headers", () => {
    Reflect.deleteProperty(process.env, "LLM_SUB_MODULE");
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_API_BASE = "https://example.test/v1";
    process.env.SESSION_TITLE_LLM_API_KEY = "stale-title-key";
    process.env.SESSION_TITLE_LLM_API_BASE = "https://title.example/v1";
    process.env.SESSION_TITLE_SUB_MODULE = "title-module";
    process.env.OPENCODE_LLM_SUB_MODULE = "opencode-module";
    Reflect.deleteProperty(process.env, "OPENCODE_CONFIG_CONTENT");

    const provider = new OpenCodeProvider();
    const getOpenCodeEnv = (
      provider as unknown as {
        getOpenCodeEnv: (
          config: {
            model: string;
            requestProtocol: "anthropic";
          },
          managedServerPort: number,
        ) => NodeJS.ProcessEnv;
      }
    ).getOpenCodeEnv.bind(provider);

    const env = getOpenCodeEnv(
      {
        model: "deepseek-v4-pro",
        requestProtocol: "anthropic",
      },
      4567,
    );
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(config.provider?.["yep-anthropic"]?.options).toMatchObject({
      headers: { "X-Sub-Module": "opencode-module" },
    });
    expect(env).not.toHaveProperty("LLM_SUB_MODULE");
  });

  it("uses an explicit OpenCode submodule ahead of the global fallback", () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_API_BASE = "https://example.test/v1";
    process.env.SESSION_TITLE_LLM_API_KEY = "stale-title-key";
    process.env.SESSION_TITLE_LLM_API_BASE = "https://title.example/v1";
    process.env.LLM_SUB_MODULE = "generic-module";
    process.env.OPENCODE_LLM_SUB_MODULE = "opencode-module";
    Reflect.deleteProperty(process.env, "OPENCODE_CONFIG_CONTENT");

    const provider = new OpenCodeProvider();
    const getOpenCodeEnv = (
      provider as unknown as {
        getOpenCodeEnv: (
          config: {
            model: string;
            requestProtocol: "openai-compatible";
          },
          managedServerPort: number,
        ) => NodeJS.ProcessEnv;
      }
    ).getOpenCodeEnv.bind(provider);

    const env = getOpenCodeEnv(
      {
        model: "glm-5.2",
        requestProtocol: "openai-compatible",
      },
      4567,
    );
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(config.provider?.["yep-openai-compatible"]?.options).toMatchObject({
      headers: { "X-Sub-Module": "opencode-module" },
    });
    expect(env).not.toHaveProperty("LLM_SUB_MODULE");
  });

  it("registers the selected model for its OpenCode protocol provider", () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_API_BASE = "https://example.test/v1";
    process.env.SESSION_TITLE_LLM_API_KEY = "stale-title-key";
    process.env.SESSION_TITLE_LLM_API_BASE = "https://title.example/v1";
    Reflect.deleteProperty(process.env, "OPENCODE_CONFIG_CONTENT");

    const provider = new OpenCodeProvider();
    const getOpenCodeEnv = (
      provider as unknown as {
        getOpenCodeEnv: (
          config: {
            model: string;
            requestProtocol: "anthropic";
            limits: { context: number; output: number };
          },
          managedServerPort: number,
        ) => NodeJS.ProcessEnv;
      }
    ).getOpenCodeEnv.bind(provider);

    const env = getOpenCodeEnv(
      {
        model: "deepseek-v4-pro",
        requestProtocol: "anthropic",
        limits: { context: 1_000_000, output: 32_000 },
      },
      4567,
    );
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<
        string,
        {
          models?: Record<
            string,
            { limit?: { context: number; output: number } }
          >;
        }
      >;
    };

    expect(
      config.provider?.["yep-anthropic"]?.models?.["deepseek-v4-pro"],
    ).toMatchObject({
      limit: { context: 1_000_000, output: 32_000 },
    });
  });

  it("formats OpenCode session errors", () => {
    const provider = new OpenCodeProvider();
    const formatOpenCodeError = (
      provider as unknown as {
        formatOpenCodeError: (error: unknown) => string | null;
      }
    ).formatOpenCodeError.bind(provider);

    expect(
      formatOpenCodeError({
        name: "APIError",
        data: { message: "Unauthorized: missing token" },
      }),
    ).toBe("Unauthorized: missing token");

    expect(formatOpenCodeError(undefined)).toBeNull();
  });
});

/**
 * A live permission-mode switch must reach the OpenCode session itself.
 * Yep-side state alone left the native session on its original `ask` rules, so
 * the UI showed bypassPermissions while OpenCode kept raising
 * external_directory/bash approvals.
 *
 * OpenCode merges (appends) a PATCHed ruleset onto the session's existing one
 * (`Permission.merge` in the session update handler) and resolves an action
 * with `findLast` (`Permission.evaluate`), so these tests replay the real
 * upstream semantics against the recorded PATCH bodies.
 */
describe("OpenCodeProvider live permission mode", () => {
  interface RecordedPatch {
    url: string;
    directoryHeader: string | null;
    permission: Array<{ permission: string; pattern: string; action: string }>;
  }

  function wildcardMatch(value: string, pattern: string): boolean {
    if (pattern === "*") return true;
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(value);
  }

  /** Mirror of upstream Permission.evaluate: last matching rule wins. */
  function evaluate(
    permission: string,
    ruleset: RecordedPatch["permission"],
  ): string {
    return (
      ruleset.findLast(
        (rule) =>
          wildcardMatch(permission, rule.permission) &&
          wildcardMatch("*", rule.pattern),
      )?.action ?? "ask"
    );
  }

  async function withPermissionServer<T>(
    run: (input: {
      session: Awaited<ReturnType<OpenCodeProvider["startSession"]>>;
      patches: RecordedPatch[];
      paths: string[];
      failNext: (status: number) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const patches: RecordedPatch[] = [];
    const paths: string[] = [];
    let failStatus: number | null = null;

    return withTestServer(
      async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        paths.push(`${req.method} ${url.pathname}`);
        res.setHeader("content-type", "application/json");
        if (req.method === "PATCH" && url.pathname === "/session/ses_live") {
          const body = (await readJsonBody(req)) as {
            permission?: RecordedPatch["permission"];
          } | null;
          if (failStatus !== null) {
            res.statusCode = failStatus;
            res.end(JSON.stringify({ error: "nope" }));
            return;
          }
          patches.push({
            url: req.url ?? "",
            directoryHeader:
              (req.headers["x-opencode-directory"] as string | undefined) ??
              null,
            permission: body?.permission ?? [],
          });
          res.end(JSON.stringify({ id: "ses_live" }));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      },
      async (baseUrl) => {
        const provider = new OpenCodeProvider();
        // Drive runtimeRef exactly like a running turn would, without
        // spawning an OpenCode CLI.
        (
          provider as unknown as {
            runSession: (
              ...args: unknown[]
            ) => AsyncIterableIterator<Record<string, unknown>>;
          }
        ).runSession = async function* (...args: unknown[]) {
          const runtimeRef = args[6] as {
            baseUrl?: string;
            cwd?: string;
            sessionId?: string;
            alive?: boolean;
            sharedServer?: boolean;
          };
          runtimeRef.baseUrl = baseUrl;
          runtimeRef.cwd = "/repo/app";
          runtimeRef.sessionId = "ses_live";
          runtimeRef.alive = true;
          runtimeRef.sharedServer = true;
          yield { type: "system", subtype: "init" };
        };

        const session = await provider.startSession({ cwd: "/repo/app" });
        await session.iterator.next();
        try {
          return await run({
            session,
            patches,
            paths,
            failNext: (status) => {
              failStatus = status;
            },
          });
        } finally {
          session.abort();
        }
      },
    );
  }

  it("exposes setPermissionMode on the AgentSession", async () => {
    await withPermissionServer(async ({ session }) => {
      expect(typeof session.setPermissionMode).toBe("function");
    });
  });

  it("PATCHes the native session with the directory query and header", async () => {
    await withPermissionServer(async ({ session, patches, paths }) => {
      await session.setPermissionMode?.("bypassPermissions");

      expect(patches).toHaveLength(1);
      const patch = patches[0];
      expect(new URL(patch?.url ?? "", "http://127.0.0.1").pathname).toBe(
        "/session/ses_live",
      );
      expect(
        new URL(patch?.url ?? "", "http://127.0.0.1").searchParams.get(
          "directory",
        ),
      ).toBe("/repo/app");
      expect(patch?.directoryHeader).toBe("/repo/app");
      expect(patch?.permission).toEqual([
        { permission: "*", pattern: "*", action: "allow" },
      ]);
      // Session-scoped only: a project-level /config write would leak a
      // Yep-only override into the user's repo.
      expect(paths.some((path) => path.includes("/config"))).toBe(false);
    });
  });

  it("keeps the wildcard fallback first so tool rules retain precedence", async () => {
    await withPermissionServer(async ({ session, patches }) => {
      await session.setPermissionMode?.("acceptEdits");

      expect(patches[0]?.permission[0]).toEqual({
        permission: "*",
        pattern: "*",
        action: "ask",
      });
      const bashIndex = patches[0]?.permission.findIndex(
        (rule) => rule.permission === "bash",
      );
      expect(bashIndex).toBeGreaterThan(0);
    });
  });

  it("lets each appended block win under upstream findLast evaluation", async () => {
    await withPermissionServer(async ({ session, patches }) => {
      await session.setPermissionMode?.("default");
      await session.setPermissionMode?.("bypassPermissions");

      // Upstream appends, so the effective ruleset is every patch flattened.
      const afterBypass = patches.flatMap((patch) => patch.permission);
      expect(evaluate("bash", afterBypass)).toBe("allow");
      expect(evaluate("edit", afterBypass)).toBe("allow");
      expect(evaluate("external_directory", afterBypass)).toBe("allow");

      await session.setPermissionMode?.("acceptEdits");
      const afterAcceptEdits = patches.flatMap((patch) => patch.permission);
      expect(evaluate("edit", afterAcceptEdits)).toBe("allow");
      expect(evaluate("write", afterAcceptEdits)).toBe("allow");
      expect(evaluate("read", afterAcceptEdits)).toBe("allow");
      expect(evaluate("bash", afterAcceptEdits)).toBe("ask");
      expect(evaluate("external_directory", afterAcceptEdits)).toBe("ask");

      await session.setPermissionMode?.("default");
      const afterDefault = patches.flatMap((patch) => patch.permission);
      expect(evaluate("edit", afterDefault)).toBe("ask");
      expect(evaluate("bash", afterDefault)).toBe("ask");
      expect(evaluate("read", afterDefault)).toBe("allow");
    });
  });

  it("rejects with the upstream status when the PATCH fails", async () => {
    await withPermissionServer(async ({ session, failNext }) => {
      failNext(503);
      await expect(
        session.setPermissionMode?.("bypassPermissions"),
      ).rejects.toThrow(/503/);
    });
  });

  it("rejects instead of silently succeeding before the session is ready", async () => {
    const provider = new OpenCodeProvider();
    (
      provider as unknown as {
        runSession: (
          ...args: unknown[]
        ) => AsyncIterableIterator<Record<string, unknown>>;
      }
    ).runSession = async function* () {
      yield { type: "system", subtype: "init" };
    };
    const session = await provider.startSession({ cwd: "/repo/app" });
    await expect(
      session.setPermissionMode?.("bypassPermissions"),
    ).rejects.toThrow(/not ready/);
    session.abort();
  });
});
