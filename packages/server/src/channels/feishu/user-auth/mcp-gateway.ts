import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Client, Domain, withUserAccessToken } from "@larksuiteoapi/node-sdk";
import {
  ALL_TOOLS,
  MCP_DOC_TOOL_NAMES,
  resolveTokenMode,
} from "../../../../resources/feishu/catalog.mjs";
import { executeTool } from "../../../../resources/feishu/handlers.mjs";
import { getRequiredScopes } from "../../../../resources/feishu/scopes.mjs";
import { atomicWriteJson } from "../../../utils/atomic-json-file.js";
import {
  directLarkHttpInstance,
  shouldBypassProxy,
} from "../lark-sdk-transport.js";
import { feishuFetch } from "./http.js";
import { FeishuOAuthError } from "./oauth-client.js";
import type { FeishuUserAuthService } from "./service.js";

interface ConnectorBinding {
  accountId: string;
  userOpenId: string;
  workspace: string;
  token: string;
  serverUrl: string;
}
export interface FeishuMcpConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  tool_timeout_sec: number;
}
export function disabledFeishuMcpConfig(): FeishuMcpConfig {
  return {
    command: process.execPath,
    args: [
      resolve(
        import.meta.dirname,
        "../../../../resources/feishu/connector.mjs",
      ),
    ],
    env: {},
    enabled: false,
    tool_timeout_sec: 240,
  };
}
export interface FeishuToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
const genericTool = {
  name: "lark_api",
  description:
    "Call a Feishu business OpenAPI. Authorization is managed by Yep. Never use this for OAuth endpoints.",
  inputSchema: {
    type: "object",
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      path: { type: "string" },
      body: { type: "object", additionalProperties: true },
      params: { type: "object", additionalProperties: true },
    },
    required: ["method", "path"],
  },
};
export const FEISHU_MCP_TOOLS = [...ALL_TOOLS, genericTool];
const sha = (input: string) => createHash("sha256").update(input).digest("hex");

export class FeishuMcpGateway {
  private readonly bindingsDir: string;
  constructor(
    private readonly options: {
      dataDir: string;
      serverUrl: string;
      auth: FeishuUserAuthService;
      secret(accountId: string): string | undefined;
      createClient?: (accountId: string, secret: string) => Client;
      onAuthRequired?(
        accountId: string,
        user: string,
        url: string,
      ): Promise<boolean>;
    },
  ) {
    this.bindingsDir = join(
      options.dataDir,
      "channels",
      "feishu",
      "mcp-clients",
    );
  }

  async connectorConfig(
    accountId: string,
    user: string,
    workspace: string,
  ): Promise<FeishuMcpConfig> {
    const account = this.options.auth.account(accountId, user);
    const actual = await realpath(workspace);
    const roots = await Promise.all(
      account.allowedWorkspaceRoots.map((root) => realpath(root)),
    );
    if (!roots.some((root) => within(root, actual)))
      throw new Error("MCP workspace is outside the account workspace roots.");
    const id = sha(JSON.stringify([accountId, user, actual]));
    const path = join(this.bindingsDir, `${id}.json`);
    // The grant lock also serializes connector creation across server processes.
    await this.options.auth.store.locked(id, async () => {
      let binding: ConnectorBinding | undefined;
      try {
        binding = JSON.parse(await readFile(path, "utf8")) as ConnectorBinding;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      binding = {
        accountId,
        userOpenId: user,
        workspace: actual,
        token: binding?.token ?? randomBytes(32).toString("base64url"),
        serverUrl: this.options.serverUrl,
      };
      await atomicWriteJson(
        join(this.bindingsDir, `${sha(binding.token)}.credential.json`),
        binding,
      );
      await atomicWriteJson(path, binding);
    });
    return {
      command: process.execPath,
      args: [
        resolve(
          import.meta.dirname,
          "../../../../resources/feishu/connector.mjs",
        ),
        path,
      ],
      env: {},
      enabled: true,
      tool_timeout_sec: 240,
    };
  }
  async authenticate(token: string): Promise<ConnectorBinding> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error("Invalid MCP credential");
    const binding = JSON.parse(
      await readFile(
        join(this.bindingsDir, `${sha(token)}.credential.json`),
        "utf8",
      ),
    ) as ConnectorBinding;
    if (binding.token !== token) throw new Error("Invalid MCP credential");
    const account = this.options.auth.account(
      binding.accountId,
      binding.userOpenId,
    );
    const actual = await realpath(binding.workspace);
    const roots = await Promise.all(
      account.allowedWorkspaceRoots.map((root) => realpath(root)),
    );
    if (!roots.some((root) => within(root, actual)))
      throw new Error("MCP workspace access was revoked");
    return binding;
  }
  async call(
    token: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<FeishuToolResult> {
    const binding = await this.authenticate(token);
    const account = this.options.auth.account(
      binding.accountId,
      binding.userOpenId,
    );
    const cancelVersion = await this.options.auth.cancellationVersion(
      binding.accountId,
      binding.userOpenId,
    );
    const checkCancellation = async () => {
      if (
        signal?.aborted ||
        (await this.options.auth.cancellationVersion(
          binding.accountId,
          binding.userOpenId,
        )) !== cancelVersion
      )
        throw new Error("Tool request cancelled.");
    };
    const tool = FEISHU_MCP_TOOLS.find((item) => item.name === name);
    if (!tool) return failure("unknown_tool", "Unknown Feishu tool.");
    const validationError = validateArgument(
      args,
      tool.inputSchema,
      "arguments",
    );
    if (validationError) return failure("invalid_arguments", validationError);
    const schema = tool.inputSchema as {
      required?: string[];
      properties?: Record<string, { enum?: unknown[] }>;
    };
    for (const key of schema.required ?? [])
      if (args[key] === undefined)
        return failure("invalid_arguments", `Missing ${key}`);
    for (const [key, rule] of Object.entries(schema.properties ?? {}))
      if (
        args[key] !== undefined &&
        rule.enum &&
        !rule.enum.includes(args[key])
      )
        return failure("invalid_arguments", `Invalid ${key}`);
    if (
      name === "lark_api" &&
      (typeof args.path !== "string" ||
        !/^\/open-apis\/(?:docx|docs|drive|sheets|bitable|wiki|search|calendar|task|im|contact|mail|approval|speech_to_text)\//.test(
          args.path,
        ) ||
        /(?:\.\.|%2e|%2f|\\|#)/i.test(args.path))
    )
      return failure(
        "invalid_path",
        "Use a Feishu business API path under /open-apis/.",
      );
    if (
      (name === "lark_approval" ||
        (name === "lark_api" && String(args.path).includes("/approval/"))) &&
      !account.adminUsers.includes(binding.userOpenId)
    )
      return failure(
        "forbidden",
        "This tool requires an account administrator.",
      );
    let businessRequestStarted = false;
    try {
      const scopes = getRequiredScopes(
        name,
        typeof args.action === "string" ? args.action : undefined,
      );
      const mode =
        name === "lark_api" || MCP_DOC_TOOL_NAMES.has(name)
          ? "user"
          : resolveTokenMode(name, String(args.action ?? ""));
      let accessToken: string | undefined;
      if (mode !== "tenant") {
        try {
          accessToken = await this.options.auth.accessToken(
            binding.accountId,
            binding.userOpenId,
            scopes,
          );
        } catch (error) {
          if (
            !(error instanceof FeishuOAuthError) ||
            error.kind !== "reauth_required"
          )
            throw error;
          const view = await this.options.auth.begin(
            binding.accountId,
            binding.userOpenId,
            scopes,
            true,
          );
          const notified = view.authorizationUrl
            ? await this.options.onAuthRequired?.(
                binding.accountId,
                binding.userOpenId,
                view.authorizationUrl,
              )
            : false;
          // Only wait before issuing the business request. No write is replayed.
          const deadline = Date.now() + (notified ? 180_000 : 0);
          while (Date.now() < deadline && !signal?.aborted) {
            await new Promise<void>((done) => {
              const timer = setTimeout(done, 1500);
              timer.unref();
            });
            const status = await this.options.auth.status(
              binding.accountId,
              binding.userOpenId,
            );
            if (
              status.status === "ready" &&
              scopes.every((scope) => status.scopes.includes(scope))
            ) {
              accessToken = await this.options.auth.accessToken(
                binding.accountId,
                binding.userOpenId,
                scopes,
              );
              break;
            }
            if (!status.authorizationUrl) break;
          }
          if (!accessToken)
            return failure(
              "user_auth_required",
              "Connect your Feishu account, then continue the original task. No business request was sent.",
              {
                authorization_url: view.authorizationUrl,
                required_scopes: scopes,
              },
            );
        }
      }
      if (signal?.aborted)
        return failure(
          "cancelled",
          "The tool request was cancelled before execution.",
        );
      const secret = this.options.secret(account.id);
      if (!secret) throw new Error("Feishu App Secret is missing.");
      const sdk =
        this.options.createClient?.(account.id, secret) ??
        new Client({
          appId: account.appId,
          appSecret: secret,
          domain: account.domain === "lark" ? Domain.Lark : Domain.Feishu,
          loggerLevel: 0,
          ...(shouldBypassProxy(account)
            ? { httpInstance: directLarkHttpInstance() }
            : {}),
        });
      const opts = accessToken ? withUserAccessToken(accessToken) : undefined;
      if (MCP_DOC_TOOL_NAMES.has(name)) {
        if (account.domain !== "feishu")
          return failure(
            "unsupported_domain",
            "The document relay is available for Feishu. Use the native document APIs for Lark.",
          );
        const remoteName = name.replace(/^lark_/, "").replaceAll("_", "-");
        await checkCancellation();
        businessRequestStarted = true;
        const response = await feishuFetch(
          "https://mcp.feishu.cn/mcp",
          {
            method: "POST",
            redirect: "error",
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
              : AbortSignal.timeout(120_000),
            headers: {
              "Content-Type": "application/json",
              "X-Lark-MCP-UAT": accessToken ?? "",
              "X-Lark-MCP-Allowed-Tools": remoteName,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: randomBytes(8).toString("hex"),
              method: "tools/call",
              params: { name: remoteName, arguments: args },
            }),
          },
          account,
        );
        const result = (await response.json()) as {
          result?: FeishuToolResult;
          error?: unknown;
        };
        if (!response.ok || result.error)
          return failure("feishu_api_error", JSON.stringify(result), {
            business_request_started: true,
            retry_safe: false,
          });
        return (
          result.result ??
          failure("invalid_response", "Invalid Feishu document response.")
        );
      }
      const checkedSdk = checkedClient(sdk, signal, async () => {
        await checkCancellation();
        businessRequestStarted = true;
      });
      const result =
        name === "lark_api"
          ? await checkedSdk.request(
              {
                method: String(args.method).toUpperCase(),
                url: String(args.path),
                data: args.body,
                params: args.params,
              },
              opts,
            )
          : await executeTool(
              checkedSdk,
              name,
              { ...args, user_open_id: binding.userOpenId },
              opts,
              {
                workspace: binding.workspace,
                roots: [
                  await realpath(binding.workspace),
                  await realpath(tmpdir()),
                  ...(process.platform === "win32"
                    ? []
                    : [await realpath("/tmp")]),
                ],
              },
            );
      return {
        content: [{ type: "text", text: JSON.stringify(result ?? null) }],
      };
    } catch (error) {
      const cancelled =
        signal?.aborted ||
        (error instanceof Error && error.message === "Tool request cancelled.");
      return failure(
        cancelled
          ? "cancelled"
          : error instanceof FeishuOAuthError
            ? error.code
            : "feishu_api_error",
        error instanceof Error ? error.message : String(error),
        {
          business_request_started: businessRequestStarted,
          retry_safe: !businessRequestStarted && !cancelled,
        },
      );
    }
  }
}
function within(root: string, target: string) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function failure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): FeishuToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error_type: code, message, ...details }),
      },
    ],
  };
}
/** SDK methods may return nonzero codes without throwing; never project these as success. */
function checkedClient<T extends object>(
  object: T,
  signal?: AbortSignal,
  onRequest?: () => void | Promise<void>,
): T {
  return new Proxy(object, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value === "function")
        return async (...args: unknown[]) => {
          if (signal?.aborted) throw new Error("Tool request cancelled.");
          await onRequest?.();
          const result = await Reflect.apply(value, target, args);
          if (result && typeof result.code === "number" && result.code !== 0)
            throw new Error(
              `Feishu API ${result.code}: ${result.msg ?? result.message ?? "Request failed"}`,
            );
          if (result && typeof result.getReadableStream === "function") {
            const stream = result.getReadableStream.bind(result);
            result.getReadableStream = async function* () {
              let size = 0;
              for await (const chunk of stream()) {
                size += Buffer.byteLength(chunk);
                if (signal?.aborted || size > 100 * 1024 * 1024)
                  throw new Error(
                    "Download cancelled or exceeds the 100 MiB limit.",
                  );
                yield chunk;
              }
            };
          }
          return result;
        };
      return value && typeof value === "object"
        ? checkedClient(value, signal, onRequest)
        : value;
    },
  });
}

function validateArgument(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  const type = schema.type;
  if (
    (type === "string" && typeof value !== "string") ||
    (type === "boolean" && typeof value !== "boolean") ||
    (type === "number" &&
      (typeof value !== "number" || !Number.isFinite(value))) ||
    (type === "object" &&
      (value === null || typeof value !== "object" || Array.isArray(value))) ||
    (type === "array" && !Array.isArray(value))
  )
    return `${path} must be ${String(type)}.`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    return `${path} has an invalid value.`;
  if (
    Array.isArray(value) &&
    schema.items &&
    typeof schema.items === "object"
  ) {
    if (value.length > 1000) return `${path} contains too many items.`;
    for (let index = 0; index < value.length; index++) {
      const error = validateArgument(
        value[index],
        schema.items as Record<string, unknown>,
        `${path}[${index}]`,
      );
      if (error) return error;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(schema.required))
      for (const key of schema.required)
        if (typeof key === "string" && record[key] === undefined)
          return `${path}.${key} is required.`;
    const properties = schema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    for (const [key, child] of Object.entries(properties ?? {})) {
      const error = validateArgument(record[key], child, `${path}.${key}`);
      if (error) return error;
    }
  }
  return undefined;
}
