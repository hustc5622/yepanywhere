import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { asRecord } from "../bridge-common/util.js";
import {
  CODEX_EVENT_RUNTIME_IDENTITY,
  CODEX_PROVIDER_RUNTIME_IDENTITY,
  CodexEventIngress,
  type CodexEventStore,
  type CodexRuntimeIdentity,
  InMemoryCodexEventStore,
  JsonlCodexEventStore,
} from "../codex-events/index.js";
import { idKey } from "./interactions.js";
import type { JsonRpcId, JsonRpcMessage } from "./types.js";

export interface CodexBridgeEventSpineOptions {
  store: CodexEventStore;
  connectionId: string;
  connectionSessionId: string;
  onPersistenceError?: (stage: string, error: unknown) => void;
}

export interface CodexBridgeClientRequestScope {
  method: string;
  params?: unknown;
  sessionId: string;
}

export interface CodexBridgeServerRequestScope {
  method: string;
  sessionId: string;
}

/**
 * Transport-facing storage error: retain the cause while enforcing store-before-forward.
 */
export class CodexBridgeEventPersistenceError extends Error {
  readonly stage: string;

  constructor(stage: string, cause: unknown) {
    super(
      `Codex event spine persistence failed at ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "CodexBridgeEventPersistenceError";
    this.stage = stage;
  }
}

/**
 * Connection-local adapter between transparent bridge frames and the shared
 * Codex event spine. It deliberately keeps transport bookkeeping out of the
 * reducer: JSON-RPC ids are scoped to one connection, while durable event
 * sessions are scoped to the real app-server thread whenever it is known.
 */
export class CodexBridgeEventSpine {
  private readonly store: CodexEventStore;
  private readonly connectionId: string;
  private readonly connectionSessionId: string;
  private readonly onPersistenceError?: (stage: string, error: unknown) => void;
  private readonly ingresses = new Map<string, Promise<CodexEventIngress>>();
  private readonly clientRequests = new Map<
    string,
    CodexBridgeClientRequestScope
  >();
  private readonly serverRequests = new Map<
    string,
    CodexBridgeServerRequestScope
  >();
  /**
   * A thread/start request has no provider session id. Its persisted response
   * is the durable evidence for this alias; the original request is never
   * rewritten or copied into the newly discovered thread session.
   */
  private readonly sessionAliases = new Map<string, string>();
  private runtime: CodexRuntimeIdentity = CODEX_EVENT_RUNTIME_IDENTITY;

  constructor(options: CodexBridgeEventSpineOptions) {
    this.store = options.store;
    this.connectionId = options.connectionId;
    this.connectionSessionId = options.connectionSessionId;
    this.onPersistenceError = options.onPersistenceError;
  }

  getIngressCount(): number {
    return this.ingresses.size;
  }

  async observeClientRequest(
    message: JsonRpcMessage,
  ): Promise<CodexBridgeClientRequestScope | null> {
    if (!message.method || message.id === undefined) return null;

    if (message.method === "initialize") {
      this.runtime = runtimeFromInitializeParams(message.params);
    }
    const scope: CodexBridgeClientRequestScope = {
      method: message.method,
      params: message.params,
      sessionId: this.resolveSessionId(message.params),
    };
    await this.persist("client-request", async () => {
      const ingress = await this.getIngress(scope.sessionId);
      await ingress.ingestClientRequest({
        requestId: message.id as JsonRpcId,
        method: scope.method,
        params: scope.params,
      });
    });
    this.clientRequests.set(idKey(message.id), scope);
    return scope;
  }

  async observeClientResponse(
    message: JsonRpcMessage,
    suppliedScope?: CodexBridgeClientRequestScope,
  ): Promise<void> {
    if (message.id === undefined) return;
    const requestKey = idKey(message.id);
    const scope = suppliedScope ?? this.clientRequests.get(requestKey);
    if (!scope) return;

    await this.persist("client-response", async () => {
      const ingress = await this.getIngress(scope.sessionId);
      await ingress.ingestClientResponse({
        requestId: message.id as JsonRpcId,
        method: scope.method,
        ...(message.error === undefined
          ? { result: message.result ?? null }
          : { error: message.error }),
      });
    });
    this.clientRequests.delete(requestKey);

    const threadId = readThreadId(message.result);
    if (threadId && scope.sessionId === this.connectionSessionId) {
      this.sessionAliases.set(this.connectionSessionId, threadId);
    }
  }

  async observeServerRequest(message: JsonRpcMessage): Promise<string | null> {
    if (!message.method || message.id === undefined) return null;
    const sessionId = this.resolveSessionId(message.params);
    await this.persist("server-request", async () => {
      const ingress = await this.getIngress(sessionId);
      await ingress.ingestServerRequest({
        requestId: message.id as JsonRpcId,
        method: message.method as string,
        params: message.params,
      });
    });
    this.serverRequests.set(idKey(message.id), {
      method: message.method,
      sessionId,
    });
    return sessionId;
  }

  async observeServerRequestResolution(
    message: JsonRpcMessage,
    suppliedScope?: CodexBridgeServerRequestScope,
  ): Promise<void> {
    if (message.id === undefined) return;
    const requestKey = idKey(message.id);
    const scope = suppliedScope ?? this.serverRequests.get(requestKey);
    if (!scope) return;

    await this.persist("server-request-resolution", async () => {
      const ingress = await this.getIngress(scope.sessionId);
      await ingress.ingestServerRequestResolution({
        requestId: message.id as JsonRpcId,
        method: scope.method,
        ...(message.error === undefined
          ? { result: message.result ?? null }
          : { error: message.error }),
      });
    });
    this.serverRequests.delete(requestKey);
  }

  async observeServerNotification(message: JsonRpcMessage): Promise<void> {
    if (!message.method || message.id !== undefined) return;
    const nestedThreadId = readThreadId(message.params);
    const sessionId = nestedThreadId ?? this.resolveSessionId(message.params);
    await this.persist("server-notification", async () => {
      const ingress = await this.getIngress(sessionId);
      await ingress.ingestNotification({
        method: message.method as string,
        params: message.params,
        ...(typeof message.emittedAtMs === "number" &&
        Number.isFinite(message.emittedAtMs)
          ? { emittedAtMs: message.emittedAtMs }
          : {}),
      });
    });
  }

  private resolveSessionId(value: unknown): string {
    const threadId = readThreadId(value);
    if (threadId) return threadId;
    const explicitSessionId = readString(asRecord(value)?.sessionId);
    if (explicitSessionId) {
      return this.sessionAliases.get(explicitSessionId) ?? explicitSessionId;
    }
    // Account/model/config traffic is connection-scoped even after a thread
    // exists, so never guess that an id-less message belongs to the alias.
    return this.connectionSessionId;
  }

  private getIngress(sessionId: string): Promise<CodexEventIngress> {
    let ingress = this.ingresses.get(sessionId);
    if (!ingress) {
      ingress = CodexEventIngress.create({
        store: this.store,
        runtime: this.runtime,
        sessionId,
        connectionId: this.connectionId,
      });
      this.ingresses.set(sessionId, ingress);
    }
    return ingress;
  }

  private async persist(
    stage: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.onPersistenceError?.(stage, error);
      // Canonical persistence is the commit point. A frame that did not reach
      // it must never enter bridge projections or cross the proxy boundary.
      throw new CodexBridgeEventPersistenceError(stage, error);
    }
  }
}

export function createCodexBridgeEventStore(options: {
  store?: CodexEventStore;
  eventStorePath?: string;
  statePath?: string;
}): CodexEventStore {
  if (options.store) return options.store;
  const filePath =
    options.eventStorePath ??
    (options.statePath
      ? deriveCodexBridgeEventStorePath(options.statePath)
      : undefined);
  return filePath
    ? new JsonlCodexEventStore({ filePath })
    : new InMemoryCodexEventStore();
}

export function deriveCodexBridgeEventStorePath(statePath: string): string {
  return join(dirname(statePath), "codex-events.jsonl");
}

export function createCodexBridgeEventIdentity(input: {
  serviceInstanceId?: string;
  connectionId: number;
  profile: string;
}): { connectionId: string; connectionSessionId: string } {
  const serviceInstanceId = input.serviceInstanceId ?? randomUUID();
  return {
    connectionId: `codex-bridge:${serviceInstanceId}:${input.connectionId}:${input.profile}`,
    connectionSessionId: `bridge-connection:${serviceInstanceId}:${input.connectionId}`,
  };
}

function runtimeFromInitializeParams(params: unknown): CodexRuntimeIdentity {
  const capabilities = asRecord(asRecord(params)?.capabilities);
  const experimentalApi = capabilities?.experimentalApi === true;
  return experimentalApi
    ? {
        ...CODEX_PROVIDER_RUNTIME_IDENTITY,
      }
    : CODEX_EVENT_RUNTIME_IDENTITY;
}

function readThreadId(value: unknown): string | undefined {
  const record = asRecord(value);
  return (
    readString(record?.threadId) ??
    readString(record?.conversationId) ??
    readString(asRecord(record?.thread)?.id)
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
