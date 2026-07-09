import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
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

function createEmissionState(): OpenCodeTestEmissionState {
  return {
    toolUseIds: new Set<string>(),
    toolResultIds: new Set<string>(),
  };
}

describe("OpenCodeProvider", () => {
  const originalEnv = {
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_API_BASE: process.env.LLM_API_BASE,
    LLM_SUB_MODULE: process.env.LLM_SUB_MODULE,
    SESSION_TITLE_LLM_API_KEY: process.env.SESSION_TITLE_LLM_API_KEY,
    SESSION_TITLE_LLM_API_BASE: process.env.SESSION_TITLE_LLM_API_BASE,
    SESSION_TITLE_SUB_MODULE: process.env.SESSION_TITLE_SUB_MODULE,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };

  afterEach(() => {
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
      model: {
        providerID: "anthropic",
        id: "claude-fable-5",
      },
    });

    expect(
      methods.buildOpenCodeMessagePayload("hello", "anthropic/claude-fable-5"),
    ).toEqual({
      parts: [{ type: "text", text: "hello" }],
      model: {
        providerID: "anthropic",
        modelID: "claude-fable-5",
      },
    });
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
            opencodeModelLimits?: { context: number; output: number };
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
          model: "anthropic/claude-sonnet-4",
          opencodeModelLimits: { context: 1_000_000, output: 32_000 },
        }),
    );

    expect(result).toEqual({ ok: true, model: "anthropic/claude-sonnet-4" });
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
          model: "anthropic/claude-sonnet-4",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4": {
                  limit: { context: 1_000_000, output: 32_000 },
                },
              },
            },
          },
        },
      },
    ]);
  });

  it("rejects OpenCode model limits without an explicit provider/model", async () => {
    const provider = new OpenCodeProvider();
    const configureServer = (
      provider as unknown as {
        configureServer: (
          baseUrl: string,
          options: {
            permissionMode?: string;
            model?: string;
            opencodeModelLimits?: { context: number; output: number };
          },
        ) => Promise<
          { ok: true; model: string | null } | { ok: false; error: string }
        >;
      }
    ).configureServer.bind(provider);

    const result = await configureServer("http://127.0.0.1:9", {
      permissionMode: "default",
      model: "auto",
      opencodeModelLimits: { context: 1_000_000, output: 32_000 },
    });

    expect(result).toEqual({
      ok: false,
      error:
        "OpenCode model limits require an explicit model in provider/model format",
    });
  });

  it("forks an OpenCode session when resuming at a message boundary", async () => {
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

    const result = await withTestServer(
      async (req, res) => {
        requests.push({
          url: req.url,
          method: req.method,
          body: await readJsonBody(req),
        });
        res.setHeader("Content-Type", "application/json");
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

    expect(result).toEqual({ id: "ses_fork" });
    const url = new URL(requests[0]?.url ?? "", "http://127.0.0.1");
    expect(url.pathname).toBe("/session/ses_parent/fork");
    expect(url.searchParams.get("directory")).toBe("/repo");
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: { messageID: "msg_boundary" },
    });
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

  it("emits full OpenCode usage from step-finish parts", () => {
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

    expect(messages.at(-1)).toEqual(
      expect.objectContaining({
        type: "result",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          reasoning_tokens: 3,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 2,
          cost_usd: 0.0123,
        },
      }),
    );
  });

  it("passes fallback LLM env vars to OpenCode child processes", () => {
    Reflect.deleteProperty(process.env, "LLM_API_KEY");
    Reflect.deleteProperty(process.env, "LLM_API_BASE");
    Reflect.deleteProperty(process.env, "LLM_SUB_MODULE");
    process.env.SESSION_TITLE_LLM_API_KEY = "test-key";
    process.env.SESSION_TITLE_LLM_API_BASE = "https://example.test/v1";
    process.env.SESSION_TITLE_SUB_MODULE = "test-module";

    const provider = new OpenCodeProvider();
    const getOpenCodeEnv = (
      provider as unknown as {
        getOpenCodeEnv: () => NodeJS.ProcessEnv;
      }
    ).getOpenCodeEnv.bind(provider);

    expect(getOpenCodeEnv()).toMatchObject({
      LLM_API_KEY: "test-key",
      LLM_API_BASE: "https://example.test/v1",
      LLM_SUB_MODULE: "test-module",
    });
  });

  it("extracts OpenCode 200-response message errors", () => {
    const provider = new OpenCodeProvider();
    const extractMessageResponseError = (
      provider as unknown as {
        extractMessageResponseError: (response: unknown) => string | null;
      }
    ).extractMessageResponseError.bind(provider);

    expect(
      extractMessageResponseError({
        info: {
          error: {
            name: "APIError",
            data: { message: "Unauthorized: missing token" },
          },
        },
      }),
    ).toBe("Unauthorized: missing token");

    expect(extractMessageResponseError({ info: {} })).toBeNull();
  });
});
