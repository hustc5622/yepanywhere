import { CODEX_PROVIDER_RUNTIME_IDENTITY } from "../codex-events/runtime.js";
import { getCodexMcpAppServerArgs } from "../codex/mcp-profile.js";
import { findCodexCliPath } from "../sdk/cli-detection.js";
import type { InitializeResponse } from "../sdk/providers/codex-protocol/generated/InitializeResponse.js";
import type { ThreadItemsListParams } from "../sdk/providers/codex-protocol/generated/v2/ThreadItemsListParams.js";
import type { ThreadItemsListResponse } from "../sdk/providers/codex-protocol/generated/v2/ThreadItemsListResponse.js";
import type { ThreadListParams } from "../sdk/providers/codex-protocol/generated/v2/ThreadListParams.js";
import type { ThreadListResponse } from "../sdk/providers/codex-protocol/generated/v2/ThreadListResponse.js";
import type { ThreadReadParams } from "../sdk/providers/codex-protocol/generated/v2/ThreadReadParams.js";
import type { ThreadReadResponse } from "../sdk/providers/codex-protocol/generated/v2/ThreadReadResponse.js";
import type { ThreadTurnsListParams } from "../sdk/providers/codex-protocol/generated/v2/ThreadTurnsListParams.js";
import type { ThreadTurnsListResponse } from "../sdk/providers/codex-protocol/generated/v2/ThreadTurnsListResponse.js";
import {
  CodexAppServerClient,
  CodexJsonRpcError,
} from "../sdk/providers/codex.js";
import {
  type CodexHistoryCapability,
  CodexHistoryClientError,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;

export interface CodexHistoryClientOptions {
  command?: string;
  cwd?: string;
  requestTimeoutMs?: number;
  now?: () => number;
  clientFactory?: (input: {
    command: string;
    cwd: string;
    args: string[];
  }) => CodexHistoryAppServerTransport;
}

export type CodexHistoryAppServerTransport = Pick<
  CodexAppServerClient,
  "connect" | "isAlive" | "request" | "notify" | "close"
>;

function protocolVersion(userAgent: string): string {
  return userAgent.match(/\/(\d+\.\d+\.\d+)/)?.[1] ?? "unknown";
}

/** Long-lived, read-only app-server protocol client. */
export class CodexHistoryClient {
  private client: CodexHistoryAppServerTransport | null = null;
  private startup: Promise<CodexHistoryAppServerTransport> | null = null;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private failureCount = 0;
  private nextStartAt = 0;
  private capability: CodexHistoryCapability | null = null;
  private readonly capabilityByRuntime = new Map<
    string,
    CodexHistoryCapability
  >();
  private readonly requestTimeoutMs: number;
  private readonly cwd: string;
  private readonly now: () => number;
  private lastFailureDiagnostic: {
    method: string;
    code?: number;
    category: string;
  } | null = null;

  constructor(private readonly options: CodexHistoryClientOptions = {}) {
    this.requestTimeoutMs = Math.max(
      1,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.cwd = options.cwd ?? process.cwd();
    this.now = options.now ?? Date.now;
  }

  getCapability(): CodexHistoryCapability | null {
    return this.capability ? { ...this.capability } : null;
  }

  getLastFailureDiagnostic(): {
    method: string;
    code?: number;
    category: string;
  } | null {
    return this.lastFailureDiagnostic
      ? { ...this.lastFailureDiagnostic }
      : null;
  }

  async listThreads(params: ThreadListParams): Promise<ThreadListResponse> {
    const result = await this.request<ThreadListResponse>(
      "thread/list",
      params,
    );
    if (params.useStateDbOnly) this.updateCapability("list");
    return result;
  }

  async readThread(params: ThreadReadParams): Promise<ThreadReadResponse> {
    return this.request("thread/read", params);
  }

  async listTurns(
    params: ThreadTurnsListParams,
  ): Promise<ThreadTurnsListResponse> {
    const result = await this.request<ThreadTurnsListResponse>(
      "thread/turns/list",
      params,
    );
    this.updateCapability("turns");
    return result;
  }

  async listItems(
    params: ThreadItemsListParams,
  ): Promise<ThreadItemsListResponse> {
    const result = await this.request<ThreadItemsListResponse>(
      "thread/items/list",
      params,
    );
    this.updateCapability("items");
    return result;
  }

  shutdown(): void {
    this.client?.close();
    this.client = null;
    this.startup = null;
    this.inFlight.clear();
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    const key = `${method}\0${JSON.stringify(params)}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const operation = this.requestInternal<T>(method, params).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  private async requestInternal<T>(
    method: string,
    params: unknown,
  ): Promise<T> {
    const client = await this.ensureClient();
    let timer: NodeJS.Timeout | undefined;
    try {
      const response = await Promise.race([
        client.request<T>(method, params),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new CodexHistoryClientError("timeout"));
          }, this.requestTimeoutMs);
          timer.unref?.();
        }),
      ]);
      this.lastFailureDiagnostic = null;
      return response;
    } catch (error) {
      if (
        error instanceof CodexHistoryClientError &&
        error.reason === "timeout"
      ) {
        this.recordTransportFailure(client);
        throw error;
      }
      if (error instanceof CodexJsonRpcError) {
        this.lastFailureDiagnostic = {
          method,
          code: error.code,
          category: safeProtocolFailureCategory(error.message),
        };
        if (error.code === -32601) {
          throw new CodexHistoryClientError("unsupported");
        }
        if (error.message.toLowerCase().includes("invalid cursor")) {
          throw new CodexHistoryClientError("invalid_cursor");
        }
        if (
          error.message.toLowerCase().includes("not materialized") ||
          error.message.toLowerCase().includes("no rollout found")
        ) {
          throw new CodexHistoryClientError("unmaterialized");
        }
        throw new CodexHistoryClientError("protocol");
      }
      this.recordTransportFailure(client);
      throw new CodexHistoryClientError("unavailable");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensureClient(): Promise<CodexHistoryAppServerTransport> {
    if (this.client?.isAlive()) return this.client;
    if (this.now() < this.nextStartAt) {
      throw new CodexHistoryClientError("backoff");
    }
    if (this.startup) return this.startup;

    const startup = this.startClient();
    this.startup = startup;
    try {
      return await startup;
    } finally {
      if (this.startup === startup) this.startup = null;
    }
  }

  private async startClient(): Promise<CodexHistoryAppServerTransport> {
    const command = this.options.command ?? (await findCodexCliPath());
    if (!command) {
      this.recordStartupFailure();
      throw new CodexHistoryClientError("unavailable");
    }

    const args = getCodexMcpAppServerArgs("clear");
    const client = this.options.clientFactory
      ? this.options.clientFactory({ command, cwd: this.cwd, args })
      : new CodexAppServerClient(command, this.cwd, process.env, args);
    try {
      await client.connect();
      const initialized = await this.withStartupTimeout(
        client.request<InitializeResponse>("initialize", {
          clientInfo: {
            name: "yep-anywhere-history-read",
            title: "Yep Anywhere History Read",
            version: "dev",
          },
          capabilities: { experimentalApi: true },
        }),
      );
      client.notify("initialized");
      const version = protocolVersion(initialized.userAgent);
      const runtimeKey = `${version}\0${CODEX_PROVIDER_RUNTIME_IDENTITY.schemaHash}`;
      this.capability = this.capabilityByRuntime.get(runtimeKey) ?? {
        protocolVersion: version,
        schemaHash: CODEX_PROVIDER_RUNTIME_IDENTITY.schemaHash,
        supportsThreadListStateDbOnly: false,
        supportsThreadTurnsList: false,
        supportsThreadItemsList: false,
      };
      this.capabilityByRuntime.set(runtimeKey, this.capability);
      this.failureCount = 0;
      this.nextStartAt = 0;
      this.client = client;
      return client;
    } catch (error) {
      client.close();
      this.recordStartupFailure();
      if (error instanceof CodexHistoryClientError) throw error;
      throw new CodexHistoryClientError("unavailable");
    }
  }

  private async withStartupTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new CodexHistoryClientError("timeout")),
            this.requestTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private updateCapability(kind: "list" | "turns" | "items"): void {
    if (!this.capability) return;
    if (kind === "list") this.capability.supportsThreadListStateDbOnly = true;
    if (kind === "turns") this.capability.supportsThreadTurnsList = true;
    if (kind === "items") this.capability.supportsThreadItemsList = true;
  }

  private recordTransportFailure(client: CodexHistoryAppServerTransport): void {
    if (this.client === client) this.client = null;
    client.close();
    this.recordStartupFailure();
  }

  private recordStartupFailure(): void {
    this.failureCount += 1;
    const delay = Math.min(
      MAX_BACKOFF_MS,
      INITIAL_BACKOFF_MS * 2 ** (this.failureCount - 1),
    );
    this.nextStartAt = this.now() + delay;
  }
}

function safeProtocolFailureCategory(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("deserialize stored thread item")) {
    return "stored_item_incompatible";
  }
  if (normalized.includes("thread not loaded")) return "thread_not_loaded";
  if (normalized.includes("invalid thread id")) return "invalid_thread_id";
  if (normalized.includes("failed to read thread")) return "thread_read_failed";
  if (normalized.includes("thread store")) return "thread_store_error";
  if (normalized.includes("archived")) return "thread_archived";
  if (normalized.includes("not materialized")) return "not_materialized";
  if (normalized.includes("invalid cursor")) return "invalid_cursor";
  if (normalized.includes("not supported")) return "unsupported";
  if (normalized.includes("invalid")) return "invalid_request";
  return "protocol_error";
}

let defaultClient: CodexHistoryClient | null = null;

export function getCodexHistoryClient(): CodexHistoryClient {
  defaultClient ??= new CodexHistoryClient();
  return defaultClient;
}

export function resetCodexHistoryClientForTests(): void {
  defaultClient?.shutdown();
  defaultClient = null;
}

export function shutdownCodexHistoryClient(): void {
  defaultClient?.shutdown();
}
