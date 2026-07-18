import { EventEmitter } from "node:events";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelInfo } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../../src/logging/logger.js";
import { OpenCodeProvider } from "../../../src/sdk/providers/opencode.js";

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

    expect(mapPermissionModeToOpenCode("default")).toMatchObject({
      read: "allow",
      glob: "allow",
      grep: "allow",
      edit: "ask",
      write: "ask",
      bash: "ask",
      "*": "ask",
    });

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

  it("merges gateway reasoning variants by model id and protocol order", () => {
    const provider = new OpenCodeProvider();
    const methods = provider as unknown as {
      parseOpenCodeVerboseModels: (output: string) => ModelInfo[];
      mergeGatewayModelReasoningMetadata: (
        gatewayModels: ModelInfo[],
        cliModels: ModelInfo[],
      ) => ModelInfo[];
    };
    const cliModels = methods.parseOpenCodeVerboseModels(`
yep-openai-compatible/model-next
{
  "api": { "npm": "@ai-sdk/openai-compatible" },
  "variants": {
    "medium": {},
    "future-ultra": {}
  }
}
yep-anthropic/model-next
{
  "api": { "npm": "@ai-sdk/anthropic" },
  "variants": {
    "medium": {},
    "max": {}
  }
}`);

    const [model] = methods.mergeGatewayModelReasoningMetadata(
      [
        {
          id: "model-next",
          name: "Model Next",
          supportedRequestProtocols: ["openai-compatible", "anthropic"],
        },
      ],
      cliModels,
    );

    expect(model?.supportedReasoningEffortsByProtocol).toEqual({
      "openai-compatible": [
        { reasoningEffort: "medium" },
        { reasoningEffort: "future-ultra" },
      ],
      anthropic: [{ reasoningEffort: "medium" }, { reasoningEffort: "max" }],
    });
    expect(model?.supportedReasoningEfforts).toEqual([
      { reasoningEffort: "medium" },
      { reasoningEffort: "future-ultra" },
      { reasoningEffort: "max" },
    ]);
  });

  it("uses OpenCode-advertised Claude variants without model-name fallbacks", () => {
    const provider = new OpenCodeProvider();
    const methods = provider as unknown as {
      parseOpenCodeVerboseModels: (output: string) => ModelInfo[];
      mergeGatewayModelReasoningMetadata: (
        gatewayModels: ModelInfo[],
        cliModels: ModelInfo[],
      ) => ModelInfo[];
    };
    const cliModels = methods.parseOpenCodeVerboseModels(`
anthropic/claude-opus-4-7
{
  "api": { "npm": "@ai-sdk/anthropic" },
  "capabilities": { "reasoning": true },
  "variants": {
    "low": {},
    "medium": {},
    "high": {},
    "xhigh": {},
    "max": {}
  }
}
ohmyrouter/deepseek-v4-pro
{
  "api": { "npm": "@ai-sdk/openai-compatible" },
  "capabilities": { "reasoning": false },
  "variants": {}
}`);

    const [claude, deepseek, kimi] = methods.mergeGatewayModelReasoningMetadata(
      [
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          supportedRequestProtocols: ["openai-compatible", "anthropic"],
        },
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          supportedRequestProtocols: ["openai-compatible", "anthropic"],
        },
        {
          id: "kimi-k2.6",
          name: "Kimi K2.6",
          supportedRequestProtocols: ["openai-compatible", "anthropic"],
        },
      ],
      cliModels,
    );

    expect(claude?.supportedReasoningEfforts).toEqual([
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
      { reasoningEffort: "max" },
    ]);
    expect(claude?.supportedReasoningEffortsByProtocol).toEqual({
      anthropic: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
        { reasoningEffort: "xhigh" },
        { reasoningEffort: "max" },
      ],
    });
    expect(deepseek).not.toHaveProperty("supportedReasoningEfforts");
    expect(deepseek).not.toHaveProperty("supportedReasoningEffortsByProtocol");
    expect(kimi).toEqual({
      id: "kimi-k2.6",
      name: "Kimi K2.6",
      supportedRequestProtocols: ["openai-compatible", "anthropic"],
    });
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
    const methods: string[] = [];

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
        if (req.method === "PATCH" && url.pathname === "/config") {
          await readJsonBody(req);
          res.end("{}");
          return;
        }
        if (req.method === "POST" && url.pathname === "/session") {
          await readJsonBody(req);
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
        res.statusCode = 404;
        res.end("{}");
      },
      async (bridgeControlUrl) => {
        serverUrl = bridgeControlUrl;
        const provider = new OpenCodeProvider({
          bridgeControlUrl,
          opencodePath: "/definitely/not/a/real/opencode",
        });
        const session = await provider.startSession({ cwd: "/repo" });

        await expect(session.iterator.next()).resolves.toMatchObject({
          done: false,
          value: {
            type: "system",
            subtype: "init",
            session_id: "ses_shared",
          },
        });
        expect(session.pid).toBeUndefined();
        expect(session.isProcessAlive?.()).toBe(true);

        session.abort();
        await session.iterator.return?.(undefined as never);
        await vi.waitFor(() => expect(abortRequests).toBe(1));
        expect(session.isProcessAlive?.()).toBe(false);
      },
    );

    expect(methods).toEqual(
      expect.arrayContaining([
        "GET /status",
        "GET /session",
        "PATCH /config",
        "POST /session",
        "PATCH /session/ses_shared",
      ]),
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
      ) => unknown;
      buildOpenCodeMessagePayload: (
        text: string,
        model?: string | null,
        variant?: string,
      ) => unknown;
    };

    expect(
      methods.buildOpenCodeSessionCreatePayload(
        "/repo",
        "anthropic/claude-fable-5",
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
        prepareOpenCodeSession(baseUrl, {}, cwd, "anthropic/claude-fable-5"),
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

  it("patches OpenCode config with permission mode and selected model", async () => {
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
    expect(requests).toEqual([
      {
        url: "/config",
        method: "PATCH",
        body: {
          permission: expect.objectContaining({
            edit: "allow",
            write: "allow",
            bash: "ask",
            "*": "ask",
          }),
          model: "yep-anthropic/claude-sonnet-4",
        },
      },
    ]);
  });

  it("keeps provider creation out of the post-start config patch", async () => {
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
    expect(requests).toEqual([
      {
        url: "/config",
        method: "PATCH",
        body: expect.objectContaining({
          model: "yep-anthropic/deepseek-v4-pro",
        }),
      },
    ]);
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
            options: { signal: AbortSignal },
          ) => Promise<{ behavior: "allow" | "deny" }>,
        ) => Promise<void>;
      }
    ).handlePermissionAsked.bind(provider);

    const replies: unknown[] = [];
    const approvals: Array<{ toolName: string; input: unknown }> = [];

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
          async (toolName, input) => {
            approvals.push({ toolName, input });
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
      },
    ]);
    expect(replies).toEqual([{ reply: "once" }]);
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
          parts: [{ type: "text", text: "hello" }],
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
          eventStream?.end(
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
    expect(abortRequests).toBe(1);
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
    Reflect.deleteProperty(process.env, "LLM_API_KEY");
    Reflect.deleteProperty(process.env, "LLM_API_BASE");
    Reflect.deleteProperty(process.env, "LLM_SUB_MODULE");
    Reflect.deleteProperty(process.env, "OPENCODE_LLM_API_KEY");
    Reflect.deleteProperty(process.env, "OPENCODE_LLM_API_BASE");
    Reflect.deleteProperty(process.env, "OPENCODE_LLM_SUB_MODULE");
    Reflect.deleteProperty(process.env, "OPENCODE_CONFIG_CONTENT");
    process.env.SESSION_TITLE_LLM_API_KEY = "test-key";
    process.env.SESSION_TITLE_LLM_API_BASE = "https://example.test/v1";
    process.env.SESSION_TITLE_SUB_MODULE = "test-module";
    Reflect.deleteProperty(process.env, "YEP_OPENCODE_BRIDGE_CONTROL_URL");
    Reflect.deleteProperty(process.env, "OPENCODE_BRIDGE_CONTROL_URL");
    Reflect.deleteProperty(process.env, "YEP_OPENCODE_BRIDGE_URL");
    Reflect.deleteProperty(process.env, "OPENCODE_BRIDGE_URL");

    const provider = new OpenCodeProvider();
    const getOpenCodeEnv = (
      provider as unknown as {
        getOpenCodeEnv: () => NodeJS.ProcessEnv;
      }
    ).getOpenCodeEnv.bind(provider);

    const env = getOpenCodeEnv();
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(env.LLM_API_KEY).toBe("test-key");
    expect(env.LLM_API_BASE).toBe("https://example.test/v1");
    expect(env).not.toHaveProperty("YEP_OPENCODE_LLM_API_KEY");
    expect(config.provider).toBeUndefined();
    expect(env).not.toHaveProperty("LLM_SUB_MODULE");
  });

  it("uses an explicit OpenCode submodule in provider headers", () => {
    Reflect.deleteProperty(process.env, "LLM_SUB_MODULE");
    process.env.SESSION_TITLE_LLM_API_KEY = "test-key";
    process.env.SESSION_TITLE_LLM_API_BASE = "https://example.test/v1";
    process.env.SESSION_TITLE_SUB_MODULE = "title-module";
    process.env.OPENCODE_LLM_SUB_MODULE = "opencode-module";
    Reflect.deleteProperty(process.env, "OPENCODE_CONFIG_CONTENT");

    const provider = new OpenCodeProvider();
    const getOpenCodeEnv = (
      provider as unknown as {
        getOpenCodeEnv: (config: {
          model: string;
          requestProtocol: "anthropic";
        }) => NodeJS.ProcessEnv;
      }
    ).getOpenCodeEnv.bind(provider);

    const env = getOpenCodeEnv({
      model: "deepseek-v4-pro",
      requestProtocol: "anthropic",
    });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(config.provider?.["yep-anthropic"]?.options).toMatchObject({
      headers: { "X-Sub-Module": "opencode-module" },
    });
    expect(env).not.toHaveProperty("LLM_SUB_MODULE");
  });

  it("does not allow a generic submodule to override OpenCode headers", () => {
    process.env.SESSION_TITLE_LLM_API_KEY = "test-key";
    process.env.SESSION_TITLE_LLM_API_BASE = "https://example.test/v1";
    process.env.LLM_SUB_MODULE = "generic-module";
    process.env.OPENCODE_LLM_SUB_MODULE = "opencode-module";
    Reflect.deleteProperty(process.env, "OPENCODE_CONFIG_CONTENT");

    const provider = new OpenCodeProvider();
    const getOpenCodeEnv = (
      provider as unknown as {
        getOpenCodeEnv: (config: {
          model: string;
          requestProtocol: "openai-compatible";
        }) => NodeJS.ProcessEnv;
      }
    ).getOpenCodeEnv.bind(provider);

    const env = getOpenCodeEnv({
      model: "glm-5.2",
      requestProtocol: "openai-compatible",
    });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(config.provider?.["yep-openai-compatible"]?.options).toMatchObject({
      headers: { "X-Sub-Module": "opencode-module" },
    });
    expect(env).not.toHaveProperty("LLM_SUB_MODULE");
  });

  it("registers the selected model for its OpenCode protocol provider", () => {
    process.env.SESSION_TITLE_LLM_API_KEY = "test-key";
    process.env.SESSION_TITLE_LLM_API_BASE = "https://example.test/v1";
    Reflect.deleteProperty(process.env, "OPENCODE_CONFIG_CONTENT");

    const provider = new OpenCodeProvider();
    const getOpenCodeEnv = (
      provider as unknown as {
        getOpenCodeEnv: (config: {
          model: string;
          requestProtocol: "anthropic";
          limits: { context: number; output: number };
        }) => NodeJS.ProcessEnv;
      }
    ).getOpenCodeEnv.bind(provider);

    const env = getOpenCodeEnv({
      model: "deepseek-v4-pro",
      requestProtocol: "anthropic",
      limits: { context: 1_000_000, output: 32_000 },
    });
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
