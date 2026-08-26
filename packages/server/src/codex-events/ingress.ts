import { createHash, randomUUID } from "node:crypto";
import type { CodexRetryStatus } from "@yep-anywhere/shared";
import { classifyCodexNotification } from "./classification.js";
import {
  isKnownCodexServerRequestMethod,
  recordUnknownCodexNotification,
  recordUnknownCodexServerRequest,
} from "./diagnostics.js";
import { createCodexEventDraft } from "./envelope.js";
import {
  type CodexEventJournalMode,
  shouldJournalCodexEvent,
} from "./journal-mode.js";
import {
  type CodexPayloadRedactionOptions,
  type CodexServerRequestSecretContext,
  type RedactedCodexPayload,
  redactCodexPayload,
  redactCodexServerRequestPayload,
  redactCodexServerRequestResolutionPayload,
  restoreCodexServerRequestSecretContext,
} from "./redaction.js";
import { reduceCodexEvent, reduceCodexEvents } from "./reducer.js";
import type { CodexEventStore } from "./store.js";
import {
  type CanonicalCodexSessionState,
  type CodexCallId,
  type CodexEventEnvelope,
  type CodexRuntimeIdentity,
  type SafeCodexPayload,
  type SafeJsonObject,
  type SafeJsonValue,
  createCanonicalCodexSessionState,
} from "./types.js";

export interface CodexNativeNotification {
  method: string;
  params?: unknown;
  /** Top-level app-server envelope timestamp, not part of params. */
  emittedAtMs?: number;
}

export interface CodexEventIngressOptions {
  store: CodexEventStore;
  runtime: CodexRuntimeIdentity;
  sessionId: string;
  projectId?: string;
  /** Trusted provider cwd used only to retain safe workspace-relative paths. */
  workspaceRoot?: string;
  accountId?: string;
  connectionId?: string;
  /**
   * Durable retention policy. Defaults to `full` so existing embedders keep
   * journalling everything; the provider opts into `lifecycle` explicitly.
   */
  journalMode?: CodexEventJournalMode;
  now?: () => number;
}

export interface CodexProjectionParitySnapshot {
  compared: number;
  matched: number;
  mismatched: number;
  lastMismatch?: {
    eventId: string;
    method: string;
    legacyHash: string;
    canonicalHash: string;
  };
}

/**
 * SDK-provider adapter for the canonical event spine. Every public ingest
 * method persists before reducing, and only returns a persisted envelope.
 */
export class CodexEventIngress {
  readonly connectionId: string;
  private readonly store: CodexEventStore;
  private readonly runtime: CodexRuntimeIdentity;
  private readonly sessionId: string;
  private readonly projectId?: string;
  private readonly workspaceRoot?: string;
  private readonly accountId?: string;
  private readonly journalMode: CodexEventJournalMode;
  private readonly now: () => number;
  private state: CanonicalCodexSessionState;
  private eventCounter = 0;
  private persistTail: Promise<void> = Promise.resolve();
  private readonly turnByClientRequestId = new Map<string, string>();
  private readonly turnByServerRequestId = new Map<string, string>();
  private readonly secretsByServerRequestId = new Map<
    string,
    CodexServerRequestSecretContext
  >();
  private parity: CodexProjectionParitySnapshot = {
    compared: 0,
    matched: 0,
    mismatched: 0,
  };

  private constructor(
    options: CodexEventIngressOptions,
    initialState: CanonicalCodexSessionState,
  ) {
    this.store = options.store;
    this.runtime = structuredClone(options.runtime);
    this.sessionId = options.sessionId;
    this.projectId = options.projectId;
    this.workspaceRoot = options.workspaceRoot;
    this.accountId = options.accountId;
    this.journalMode = options.journalMode ?? "full";
    this.connectionId = options.connectionId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.state = initialState;
  }

  static async create(
    options: CodexEventIngressOptions,
  ): Promise<CodexEventIngress> {
    // Replaying the session journal only ever recovers state for a connection
    // that already wrote to it: `restoreCorrelations` matches on
    // `source.connectionId`, and the reduced projection is rebuilt from the
    // same events. A caller that does not supply a connection id gets a fresh
    // random one, which by construction cannot appear in any prior record, so
    // the replay resolves to zero correlations and a projection nobody reads --
    // while forcing a cold hydration of the entire journal at session start.
    if (options.connectionId === undefined) {
      return new CodexEventIngress(
        options,
        createCanonicalCodexSessionState(options.sessionId),
      );
    }
    const events = await options.store.replay({ sessionId: options.sessionId });
    const state = reduceCodexEvents(
      createCanonicalCodexSessionState(options.sessionId),
      events,
    );
    const ingress = new CodexEventIngress(options, state);
    ingress.restoreCorrelations(events);
    return ingress;
  }

  getState(): CanonicalCodexSessionState {
    return structuredClone(this.state);
  }

  getTurnForRequest(
    requestId: CodexCallId,
    direction: "client" | "server" = "client",
  ): string | undefined {
    return (
      direction === "client"
        ? this.turnByClientRequestId
        : this.turnByServerRequestId
    ).get(callIdKey(requestId));
  }

  getParityDiagnostics(): CodexProjectionParitySnapshot {
    return structuredClone(this.parity);
  }

  async ingestNotification(
    notification: CodexNativeNotification,
  ): Promise<CodexEventEnvelope> {
    const payload = safePayload(notification.method, notification.params, {
      workspaceRoot: this.workspaceRoot,
    });
    const payloadObject = asObject(payload.data);
    const requestId = readCallId(payloadObject, "requestId");
    const correlatedTurnId =
      readNestedId(payloadObject, "turn") ??
      readString(payloadObject, "turnId") ??
      (requestId === undefined
        ? undefined
        : notification.method === "serverRequest/resolved"
          ? this.turnByServerRequestId.get(callIdKey(requestId))
          : (this.turnByClientRequestId.get(callIdKey(requestId)) ??
            this.turnByServerRequestId.get(callIdKey(requestId))));
    return await this.persist({
      method: notification.method,
      direction: "server_notification",
      payload,
      ...(requestId === undefined ? {} : { requestId }),
      ...(correlatedTurnId === undefined ? {} : { turnId: correlatedTurnId }),
      ...(notification.emittedAtMs === undefined
        ? {}
        : { appServerEmittedAtMs: notification.emittedAtMs }),
      dedupeKey: lifecycleDedupeKey(notification.method, payloadObject),
    });
  }

  async ingestClientExchange(input: {
    requestId: CodexCallId;
    method: string;
    params?: unknown;
    result: unknown;
    clientMessageId?: string;
  }): Promise<{ request: CodexEventEnvelope; response: CodexEventEnvelope }> {
    const request = await this.ingestClientRequest(input);
    const response = await this.ingestClientResponse(input);
    return { request, response };
  }

  async ingestClientRequest(input: {
    requestId: CodexCallId;
    method: string;
    params?: unknown;
    clientMessageId?: string;
  }): Promise<CodexEventEnvelope> {
    const requestPayload = safePayload(input.method, input.params, {
      workspaceRoot: this.workspaceRoot,
    });
    const requestObject = asObject(requestPayload.data);
    const turnId = readString(requestObject, "turnId");
    const correlationId = `client-request:${callIdKey(input.requestId)}`;
    return await this.persist({
      method: input.method,
      direction: "client_request",
      payload: requestPayload,
      requestId: input.requestId,
      correlationId,
      ...(turnId === undefined ? {} : { turnId }),
      ...(input.clientMessageId === undefined
        ? {}
        : { clientMessageId: input.clientMessageId }),
    });
  }

  async ingestClientResponse(input: {
    requestId: CodexCallId;
    method: string;
    result?: unknown;
    error?: unknown;
    clientMessageId?: string;
  }): Promise<CodexEventEnvelope> {
    const responsePayload = safePayload(
      input.method,
      input.error === undefined
        ? (input.result ?? null)
        : { error: input.error },
      { workspaceRoot: this.workspaceRoot },
    );
    const responseObject = asObject(responsePayload.data);
    const turnId =
      readNestedId(responseObject, "turn") ??
      readString(responseObject, "turnId");
    if (turnId) {
      this.turnByClientRequestId.set(callIdKey(input.requestId), turnId);
    }
    const correlationId = `client-request:${callIdKey(input.requestId)}`;
    return await this.persist({
      method: input.method,
      direction: "client_response",
      phase: "resolved",
      payload: responsePayload,
      requestId: input.requestId,
      correlationId,
      ...(turnId === undefined ? {} : { turnId }),
      ...(input.clientMessageId === undefined
        ? {}
        : { clientMessageId: input.clientMessageId }),
    });
  }

  /**
   * Persist the client's bounded overload decision before either UI projects it.
   * The payload deliberately excludes the app-server's raw error text/data.
   */
  async ingestClientRetry(input: {
    requestId: CodexCallId;
    method: string;
    retryStatus: CodexRetryStatus;
    clientMessageId?: string;
    threadId?: string;
  }): Promise<CodexEventEnvelope> {
    return await this.persist({
      method: input.method,
      direction: "client_response",
      phase: "observed",
      payload: safePayload(
        input.method,
        {
          retryStatus: input.retryStatus,
        },
        { workspaceRoot: this.workspaceRoot },
      ),
      requestId: input.requestId,
      correlationId: `client-retry:${callIdKey(input.requestId)}:${input.retryStatus.attempt}`,
      ...(input.clientMessageId === undefined
        ? {}
        : { clientMessageId: input.clientMessageId }),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    });
  }

  async ingestServerRequest(input: {
    requestId: CodexCallId;
    method: string;
    params?: unknown;
  }): Promise<CodexEventEnvelope> {
    const redacted = redactCodexServerRequestPayload(
      input.method,
      input.params,
      { workspaceRoot: this.workspaceRoot },
    );
    const payload = safePayloadFromRedaction(redacted);
    const payloadObject = asObject(payload.data);
    const turnId =
      readString(payloadObject, "turnId") ??
      readNestedId(payloadObject, "turn");
    if (turnId) {
      this.turnByServerRequestId.set(callIdKey(input.requestId), turnId);
    }
    this.secretsByServerRequestId.set(
      callIdKey(input.requestId),
      redacted.secretContext,
    );
    return await this.persist({
      method: input.method,
      direction: "server_request",
      payload,
      requestId: input.requestId,
      correlationId: `server-request:${callIdKey(input.requestId)}`,
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  async ingestServerRequestResolution(input: {
    requestId: CodexCallId;
    method: string;
    result?: unknown;
    error?: unknown;
  }): Promise<CodexEventEnvelope> {
    const requestKey = callIdKey(input.requestId);
    const turnId = this.turnByServerRequestId.get(requestKey);
    const redacted = redactCodexServerRequestResolutionPayload(
      input.method,
      input.error === undefined
        ? { result: input.result ?? null }
        : { error: input.error },
      this.secretsByServerRequestId.get(requestKey),
      { workspaceRoot: this.workspaceRoot },
    );
    const event = await this.persist({
      method: input.method,
      direction: "client_response",
      phase: "resolved",
      payload: safePayloadFromRedaction(redacted),
      requestId: input.requestId,
      correlationId: `server-request:${requestKey}`,
      ...(turnId === undefined ? {} : { turnId }),
    });
    this.secretsByServerRequestId.delete(requestKey);
    return event;
  }

  recordProjectionParity(
    event: CodexEventEnvelope,
    legacyProjection: readonly unknown[],
    canonicalProjection: readonly unknown[],
  ): CodexProjectionParitySnapshot {
    const legacyHash = projectionHash(legacyProjection);
    const canonicalHash = projectionHash(canonicalProjection);
    const matched = legacyHash === canonicalHash;
    this.parity = {
      ...this.parity,
      compared: this.parity.compared + 1,
      matched: this.parity.matched + (matched ? 1 : 0),
      mismatched: this.parity.mismatched + (matched ? 0 : 1),
      ...(matched
        ? {}
        : {
            lastMismatch: {
              eventId: event.eventId,
              method: classifyCodexNotification(event.method).known
                ? event.method
                : "unknown",
              legacyHash,
              canonicalHash,
            },
          }),
    };
    return this.getParityDiagnostics();
  }

  notificationFromEvent(event: CodexEventEnvelope): CodexNativeNotification {
    return {
      method: event.method,
      params: structuredClone(event.payload.data),
      ...(event.appServerEmittedAtMs === undefined
        ? {}
        : { emittedAtMs: event.appServerEmittedAtMs }),
    };
  }

  private async persist(
    input: Omit<
      Parameters<typeof createCodexEventDraft>[0],
      | "eventId"
      | "runtime"
      | "sessionId"
      | "projectId"
      | "accountId"
      | "connectionId"
      | "receivedAtMs"
    >,
  ): Promise<CodexEventEnvelope> {
    return await this.withPersistLock(async () => {
      const eventId = `${this.connectionId}:${++this.eventCounter}`;
      const draft = createCodexEventDraft({
        ...input,
        eventId,
        runtime: this.runtime,
        sessionId: this.sessionId,
        ...(this.projectId === undefined ? {} : { projectId: this.projectId }),
        ...(this.accountId === undefined ? {} : { accountId: this.accountId }),
        connectionId: this.connectionId,
        receivedAtMs: this.now(),
      });

      if (!shouldJournalCodexEvent(this.journalMode, draft)) {
        // Not journalled: no disk write, no store index, no reduction. The
        // envelope is still returned because the live projection is built from
        // its payload, so dropping the record changes what we retain, never
        // what the client sees for this event.
        //
        // `sequence: 0` marks it as unsequenced. Sequences are assigned by the
        // store and are only meaningful for records that made it in; handing a
        // synthetic one to the reducer would manufacture out-of-order anomalies
        // against the real journal.
        return {
          ...draft,
          persistedAtMs: draft.receivedAtMs,
          sequence: 0,
        };
      }

      const result = await this.store.append(draft);
      if (result.inserted) {
        this.state = reduceCodexEvent(this.state, result.event);
        if (
          result.event.direction === "server_notification" &&
          !classifyCodexNotification(result.event.method).known
        ) {
          recordUnknownCodexNotification(
            result.event.method,
            result.event.runtime,
          );
        } else if (
          result.event.direction === "server_request" &&
          !isKnownCodexServerRequestMethod(result.event.method)
        ) {
          recordUnknownCodexServerRequest(
            result.event.method,
            result.event.runtime,
          );
        }
      }
      return result.event;
    });
  }

  private restoreCorrelations(events: readonly CodexEventEnvelope[]): void {
    const ownEventPrefix = `${this.connectionId}:`;
    for (const event of events) {
      if (event.source.connectionId === this.connectionId) {
        const suffix = event.eventId.startsWith(ownEventPrefix)
          ? Number(event.eventId.slice(ownEventPrefix.length))
          : Number.NaN;
        if (Number.isSafeInteger(suffix) && suffix > this.eventCounter) {
          this.eventCounter = suffix;
        }
      }
      if (event.requestId === undefined) continue;
      const requestKey = callIdKey(event.requestId);
      if (event.direction === "server_request") {
        if (event.turnId !== undefined) {
          this.turnByServerRequestId.set(requestKey, event.turnId);
        }
        this.secretsByServerRequestId.set(
          requestKey,
          restoreCodexServerRequestSecretContext(
            event.method,
            event.payload.data,
            event.payload.truncated === true,
          ),
        );
      } else if (
        event.direction === "client_response" &&
        event.phase === "resolved" &&
        event.correlationId === `server-request:${requestKey}`
      ) {
        this.secretsByServerRequestId.delete(requestKey);
      }
      if (event.turnId === undefined) continue;
      if (
        event.direction === "client_request" ||
        event.direction === "client_response"
      ) {
        this.turnByClientRequestId.set(requestKey, event.turnId);
      }
    }
  }

  private async withPersistLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.persistTail;
    let release: () => void = () => undefined;
    this.persistTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function safePayload(
  method: string,
  value: unknown,
  options: CodexPayloadRedactionOptions = {},
): SafeCodexPayload {
  return safePayloadFromRedaction(redactCodexPayload(method, value, options));
}

function safePayloadFromRedaction(
  redacted: RedactedCodexPayload,
): SafeCodexPayload {
  return {
    safety: "safe",
    data: redacted.data,
    ...(redacted.redactionCount > 0
      ? { redactionCount: redacted.redactionCount }
      : {}),
    ...(redacted.truncated ? { truncated: true } : {}),
  };
}

function lifecycleDedupeKey(
  method: string,
  payload: SafeJsonObject | undefined,
): string | undefined {
  const threadId =
    readString(payload, "threadId") ?? readNestedId(payload, "thread");
  const turnId = readString(payload, "turnId") ?? readNestedId(payload, "turn");
  const itemId = readString(payload, "itemId") ?? readNestedId(payload, "item");
  switch (method) {
    case "turn/started":
    case "turn/completed":
      return threadId && turnId ? `${method}:${threadId}:${turnId}` : undefined;
    case "item/started":
    case "item/completed":
      return threadId && turnId && itemId
        ? `${method}:${threadId}:${turnId}:${itemId}`
        : undefined;
    default:
      return undefined;
  }
}

function projectionHash(projection: readonly unknown[]): string {
  const sanitized = sanitizeProjectionValue(projection);
  return createHash("sha256")
    .update(JSON.stringify(sanitized))
    .digest("hex")
    .slice(0, 20);
}

function sanitizeProjectionValue(value: unknown, key?: string): SafeJsonValue {
  if (key === "timestamp") return "[IGNORED:timestamp]";
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeProjectionValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, entryValue]) => [
          entryKey,
          sanitizeProjectionValue(entryValue, entryKey),
        ]),
    );
  }
  return String(value);
}

function asObject(value: SafeJsonValue): SafeJsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function readString(
  value: SafeJsonObject | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function readNestedId(
  value: SafeJsonObject | undefined,
  key: string,
): string | undefined {
  const nested = value?.[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? readString(nested, "id")
    : undefined;
}

function readCallId(
  value: SafeJsonObject | undefined,
  key: string,
): CodexCallId | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" || typeof candidate === "number"
    ? candidate
    : undefined;
}

function callIdKey(value: CodexCallId): string {
  return `${typeof value}:${String(value)}`;
}
