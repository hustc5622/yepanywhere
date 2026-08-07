/**
 * Yep Anywhere forwarder plugin for OpenCode.
 *
 * Why this exists: the default `opencode` TUI (and `opencode run`) does not
 * listen on any TCP port - its server runs in-process - so the Yep OpenCode
 * bridge (4520) cannot observe those sessions or their permission/question
 * requests. This plugin runs inside every OpenCode instance, forwards the
 * relevant events to the bridge, and long-polls the bridge for user
 * decisions, applying them through OpenCode's in-process SDK client.
 *
 * Install: copy to ~/.config/opencode/plugin/yep-bridge.ts
 * (see scripts/install-opencode-yep-plugin.sh in the yepanywhere repo).
 *
 * Environment:
 * - YEP_OPENCODE_BRIDGE_URL   override bridge base URL (default http://127.0.0.1:4520)
 * - YEP_MANAGED_OPENCODE=1    bootstrap marker set by Yep-managed servers.
 * - YEP_MANAGED_OPENCODE_SERVER_PORT
 *                             scopes that marker to the exact `serve` process;
 *                             both markers are consumed during plugin startup
 *                             so child processes cannot inherit managed status.
 * - YEP_OPENCODE_PLUGIN_DISABLE=1  hard off-switch.
 */

const BRIDGE_URL = (
  process.env.YEP_OPENCODE_BRIDGE_URL ?? "http://127.0.0.1:4520"
).replace(/\/+$/, "");

/**
 * Events worth forwarding. `message.updated` is low-volume but essential: it
 * distinguishes an intermediate `finish: tool-calls` message from the final
 * assistant `finish: stop`. High-frequency part deltas remain excluded.
 */
const FORWARD_EVENTS = new Set([
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "session.error",
  "message.updated",
]);

const DECISION_POLL_WAIT_MS = 25_000;
const DECISION_POLL_TIMEOUT_MS = 30_000;
const DECISION_RETRY_DELAY_MS = 5_000;
const EVENT_RETRY_DELAY_MS = 1_000;

const MANAGED_MARKER_ENV = "YEP_MANAGED_OPENCODE";
const MANAGED_SERVER_PORT_ENV = "YEP_MANAGED_OPENCODE_SERVER_PORT";
const ANTHROPIC_PROVIDER_PACKAGE = "@ai-sdk/anthropic";
const SCHEMA_SANITIZER_MARKER = Symbol("yepAnthropicSchemaSanitizer");

type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

interface OpenCodeProviderConfig {
  npm?: string;
  options?: Record<string, unknown>;
  models?: Record<
    string,
    {
      attachment?: boolean;
      api?: { npm?: string };
      provider?: { npm?: string };
      modalities?: {
        input?: string[];
        output?: string[];
      };
    }
  >;
}

interface OpenCodeConfig {
  provider?: Record<string, OpenCodeProviderConfig>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Bedrock-compatible Anthropic gateways reject custom-tool schemas with a
 * top-level composition keyword. Keep OpenCode's original schema for local
 * argument validation and lower only the serialized transport copy.
 */
function lowerTopLevelToolSchemaComposition(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const compositionKeys = ["anyOf", "oneOf", "allOf"] as const;
  if (!compositionKeys.some((key) => Array.isArray(schema[key]))) {
    return schema;
  }

  const properties = { ...(asRecord(schema.properties) ?? {}) };
  for (const key of compositionKeys) {
    const members = schema[key];
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      const memberProperties = asRecord(asRecord(member)?.properties);
      if (!memberProperties) continue;
      for (const [name, property] of Object.entries(memberProperties)) {
        if (!(name in properties)) properties[name] = property;
      }
    }
  }

  const lowered: Record<string, unknown> = {
    ...schema,
    type: "object",
    properties,
  };
  for (const key of compositionKeys) delete lowered[key];
  return lowered;
}

function sanitizeAnthropicRequestBody(body: string): string | undefined {
  try {
    const parsed = asRecord(JSON.parse(body));
    if (!parsed || !Array.isArray(parsed.tools)) return undefined;

    let changed = false;
    const tools = parsed.tools.map((value) => {
      const tool = asRecord(value);
      const inputSchema = asRecord(tool?.input_schema);
      if (!tool || !inputSchema) return value;

      const lowered = lowerTopLevelToolSchemaComposition(inputSchema);
      if (lowered === inputSchema) return value;
      changed = true;
      return { ...tool, input_schema: lowered };
    });
    return changed ? JSON.stringify({ ...parsed, tools }) : undefined;
  } catch {
    return undefined;
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return undefined;
}

function isAnthropicMessagesRequest(
  input: Parameters<typeof fetch>[0],
): boolean {
  const rawUrl = requestUrl(input);
  if (!rawUrl) return false;
  try {
    return new URL(rawUrl).pathname.endsWith("/messages");
  } catch {
    return false;
  }
}

function bodyText(body: BodyInit | null | undefined): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return undefined;
}

function sanitizedHeaders(
  headers: HeadersInit | undefined,
): Headers | undefined {
  if (!headers) return undefined;
  const next = new Headers(headers);
  next.delete("content-length");
  return next;
}

function wrapAnthropicFetch(fetchImpl: FetchLike): FetchLike {
  if (
    (fetchImpl as FetchLike & { [SCHEMA_SANITIZER_MARKER]?: boolean })[
      SCHEMA_SANITIZER_MARKER
    ]
  ) {
    return fetchImpl;
  }

  const wrapped: FetchLike = async (input, init) => {
    if (!isAnthropicMessagesRequest(input)) return fetchImpl(input, init);

    const inlineBody = bodyText(init?.body);
    if (inlineBody !== undefined) {
      const body = sanitizeAnthropicRequestBody(inlineBody);
      if (body !== undefined) {
        return fetchImpl(input, {
          ...init,
          body,
          headers: sanitizedHeaders(init?.headers),
        });
      }
      return fetchImpl(input, init);
    }

    if (typeof Request !== "undefined" && input instanceof Request) {
      const requestBody = await input.clone().text();
      const body = sanitizeAnthropicRequestBody(requestBody);
      if (body !== undefined) {
        const headers = new Headers(input.headers);
        headers.delete("content-length");
        return fetchImpl(new Request(input, { body, headers }), init);
      }
    }
    return fetchImpl(input, init);
  };
  Object.defineProperty(wrapped, SCHEMA_SANITIZER_MARKER, { value: true });
  return wrapped;
}

function usesAnthropicSdk(
  providerId: string,
  provider: OpenCodeProviderConfig,
): boolean {
  return (
    providerId === "anthropic" ||
    provider.npm === ANTHROPIC_PROVIDER_PACKAGE ||
    Object.values(provider.models ?? {}).some(
      (model) =>
        model.api?.npm === ANTHROPIC_PROVIDER_PACKAGE ||
        model.provider?.npm === ANTHROPIC_PROVIDER_PACKAGE,
    )
  );
}

/**
 * OpenCode gates native file parts on `modalities.input`, not on the legacy
 * `attachment` flag. Preserve explicit modality declarations, but translate
 * the old Anthropic attachment shorthand in memory so images reach the SDK
 * instead of becoming OpenCode's "model does not support image input" text.
 */
function applyAnthropicAttachmentCompatibility(
  provider: OpenCodeProviderConfig,
): void {
  for (const model of Object.values(provider.models ?? {})) {
    if (model.attachment !== true || model.modalities?.input !== undefined) {
      continue;
    }
    model.modalities = {
      ...model.modalities,
      input: ["text", "image", "pdf"],
      output: model.modalities?.output ?? ["text"],
    };
  }
}

async function applyAnthropicCompatibility(
  config: OpenCodeConfig,
): Promise<void> {
  for (const [providerId, provider] of Object.entries(config.provider ?? {})) {
    if (!usesAnthropicSdk(providerId, provider)) continue;
    applyAnthropicAttachmentCompatibility(provider);
    const options = provider.options ?? {};
    const configuredFetch = options.fetch;
    const fetchImpl =
      typeof configuredFetch === "function"
        ? (configuredFetch as FetchLike)
        : (globalThis.fetch.bind(globalThis) as FetchLike);
    provider.options = {
      ...options,
      fetch: wrapAnthropicFetch(fetchImpl),
    };
  }
}

function readCliOption(args: string[], name: string): string | undefined {
  const directIndex = args.indexOf(name);
  if (directIndex >= 0) return args[directIndex + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parsePort(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
    ? port
    : null;
}

/**
 * Consume the managed-server bootstrap marker and decide whether it belongs to
 * this exact OpenCode process.
 *
 * Environment variables normally leak into every tool, daemon, and nested
 * `opencode run` launched by a managed server. Treating the boolean marker as a
 * permanent identity therefore makes those unrelated descendants invisible to
 * Yep. New launchers add the exact managed server port, which must match this
 * process' `serve --port` invocation. Legacy launchers remain compatible, but
 * only an actual `serve` command is considered managed.
 *
 * Delete the bootstrap variables for both matched and inherited markers. The
 * current plugin has already made its decision, and descendants must establish
 * their own identity instead of inheriting this one.
 */
function consumeManagedServerMarker(): boolean {
  if (process.env[MANAGED_MARKER_ENV] !== "1") return false;

  const expectedPortValue = process.env[MANAGED_SERVER_PORT_ENV];
  const args = process.argv.slice(2);
  const isServe = args[0] === "serve";
  const expectedPort = parsePort(expectedPortValue);
  const actualPort = parsePort(readCliOption(args, "--port"));

  Reflect.deleteProperty(process.env, MANAGED_MARKER_ENV);
  Reflect.deleteProperty(process.env, MANAGED_SERVER_PORT_ENV);

  if (!isServe) return false;
  // No port means the process came from a pre-scoping Yep launcher. Preserve
  // compatibility while still refusing to silence inherited `run`/TUI modes.
  if (expectedPortValue === undefined) return true;
  return expectedPort !== null && actualPort === expectedPort;
}

interface YepDecision {
  id: string;
  confirmed?: boolean;
  kind: "permission" | "question";
  protocol: "v1" | "v2";
  requestId: string;
  sessionId: string;
  reply?: "once" | "always" | "reject";
  action?: "reply" | "reject";
  answers?: string[][];
}

interface ForwardedEvent {
  type?: string;
  properties?: unknown;
}

async function postJson(path: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(`${BRIDGE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const YepBridge = async (input: {
  client: unknown;
  directory: string;
}) => {
  const isManagedServer = consumeManagedServerMarker();
  if (process.env.YEP_OPENCODE_PLUGIN_DISABLE === "1") {
    return {};
  }

  const compatibilityHooks = {
    config: applyAnthropicCompatibility,
  };
  if (isManagedServer) return compatibilityHooks;

  const instanceId = `oc-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const directory = input.directory;
  let disposed = false;

  // The SDK client's fetch goes in-process, so replies work even when the
  // OpenCode instance has no TCP listener.
  const client = input.client as {
    _client?: {
      post: (options: {
        url: string;
        path?: Record<string, string>;
        body?: unknown;
        headers?: Record<string, string>;
        throwOnError?: boolean;
      }) => Promise<unknown>;
    };
  };

  const queuedEvents: Array<{
    event: ForwardedEvent;
    resolve: () => void;
  }> = [];
  let pumpingEvents = false;

  const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function pumpEvents(): Promise<void> {
    if (pumpingEvents) return;
    pumpingEvents = true;
    try {
      while (!disposed && queuedEvents.length > 0) {
        const next = queuedEvents[0];
        if (
          await postJson("/external/events", {
            instanceId,
            directory,
            event: next.event,
          })
        ) {
          queuedEvents.shift();
          next.resolve();
          continue;
        }
        await delay(EVENT_RETRY_DELAY_MS);
      }
    } finally {
      pumpingEvents = false;
      if (!disposed && queuedEvents.length > 0) void pumpEvents();
    }
  }

  function enqueueEvent(event: ForwardedEvent): Promise<void> {
    if (disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      queuedEvents.push({ event, resolve });
      void pumpEvents();
    });
  }

  function confirmationEvent(decision: YepDecision): ForwardedEvent {
    if (decision.kind === "permission") {
      return {
        type:
          decision.protocol === "v2"
            ? "permission.v2.replied"
            : "permission.replied",
        properties: {
          sessionID: decision.sessionId,
          requestID: decision.requestId,
          reply: decision.reply ?? "once",
        },
      };
    }
    return {
      type:
        decision.action === "reject"
          ? decision.protocol === "v2"
            ? "question.v2.rejected"
            : "question.rejected"
          : decision.protocol === "v2"
            ? "question.v2.replied"
            : "question.replied",
      properties: {
        sessionID: decision.sessionId,
        requestID: decision.requestId,
        ...(decision.action === "reject"
          ? {}
          : { answers: decision.answers ?? [] }),
      },
    };
  }

  async function applyDecision(decision: YepDecision): Promise<void> {
    const raw = client._client;
    if (!raw) throw new Error("OpenCode SDK transport is unavailable");

    if (decision.kind === "permission") {
      if (decision.protocol === "v2") {
        await raw.post({
          url: "/api/session/{sessionID}/permission/{requestID}/reply",
          path: {
            sessionID: decision.sessionId,
            requestID: decision.requestId,
          },
          body: { reply: decision.reply ?? "once" },
          headers: { "content-type": "application/json" },
          throwOnError: true,
        });
      } else {
        await raw.post({
          url: "/permission/{requestID}/reply",
          path: { requestID: decision.requestId },
          body: { reply: decision.reply ?? "once" },
          headers: { "content-type": "application/json" },
          throwOnError: true,
        });
      }
      return;
    }

    const questionPath =
      decision.protocol === "v2"
        ? "/api/session/{sessionID}/question/{requestID}"
        : "/question/{requestID}";
    const path = {
      ...(decision.protocol === "v2" ? { sessionID: decision.sessionId } : {}),
      requestID: decision.requestId,
    };
    if (decision.action === "reject") {
      await raw.post({
        url: `${questionPath}/reject`,
        path,
        throwOnError: true,
      });
    } else {
      await raw.post({
        url: `${questionPath}/reply`,
        path,
        body: { answers: decision.answers ?? [] },
        headers: { "content-type": "application/json" },
        throwOnError: true,
      });
    }
  }

  async function acknowledgeDecision(decisionId: string): Promise<boolean> {
    return postJson(
      `/external/instances/${encodeURIComponent(
        instanceId,
      )}/decisions/${encodeURIComponent(decisionId)}/ack`,
      {},
    );
  }

  const appliedDecisionIds = new Set<string>();
  const pendingDecisionAcks = new Set<string>();

  async function flushDecisionAcks(): Promise<boolean> {
    for (const decisionId of pendingDecisionAcks) {
      if (!(await acknowledgeDecision(decisionId))) return false;
      pendingDecisionAcks.delete(decisionId);
      appliedDecisionIds.delete(decisionId);
    }
    return true;
  }

  // Decision long-poll loop. Doubles as the liveness heartbeat: the bridge
  // marks this instance's sessions idle when polling stops.
  void (async () => {
    while (!disposed) {
      try {
        // Retry ACKs independently of redelivery. If an ACK reached the bridge
        // but its response was lost, the idempotent retry still clears local
        // state even though the decision no longer appears in the next poll.
        if (!(await flushDecisionAcks())) {
          await delay(DECISION_RETRY_DELAY_MS);
          continue;
        }
        const response = await fetch(
          `${BRIDGE_URL}/external/instances/${encodeURIComponent(
            instanceId,
          )}/decisions?waitMs=${DECISION_POLL_WAIT_MS}`,
          { signal: AbortSignal.timeout(DECISION_POLL_TIMEOUT_MS) },
        );
        if (response.ok) {
          const data = (await response.json()) as {
            decisions?: YepDecision[];
          };
          let retry = false;
          for (const decision of data.decisions ?? []) {
            try {
              if (decision.confirmed) {
                appliedDecisionIds.add(decision.id);
              }
              if (!appliedDecisionIds.has(decision.id)) {
                await applyDecision(decision);
                // OpenCode invokes plugin event hooks fire-and-forget. Enqueue
                // an explicit confirmation behind any native reply event so
                // the bridge always observes completion before ACK.
                await enqueueEvent(confirmationEvent(decision));
                appliedDecisionIds.add(decision.id);
              }
              pendingDecisionAcks.add(decision.id);
              if (!(await flushDecisionAcks())) {
                retry = true;
                break;
              }
            } catch {
              retry = true;
              break;
            }
          }
          if (!retry) continue;
        }
      } catch {
        // Bridge unreachable - back off and retry.
      }
      await delay(DECISION_RETRY_DELAY_MS);
    }
  })();

  void postJson("/external/instances", { instanceId, directory });

  return {
    ...compatibilityHooks,
    event: async ({
      event,
    }: {
      event: { type?: string; properties?: unknown };
    }) => {
      if (disposed || !event || typeof event.type !== "string") return;
      if (!FORWARD_EVENTS.has(event.type)) return;
      // Enqueueing is synchronous and the pump preserves event order. Do not
      // make OpenCode depend on bridge availability: some builds await plugin
      // hooks, while the bridge may legitimately be stopped or restarting.
      void enqueueEvent(event);
    },
    dispose: async () => {
      // OpenCode can dispose a short-lived `opencode run` instance
      // immediately after publishing its terminal message/status events.
      // Those hooks are fire-and-forget in some versions, so closing the pump
      // here used to drop the queue tail and leave Yep stuck in-turn. Give the
      // ordered pump a bounded chance to deliver every already-enqueued event.
      const deadline = Date.now() + 5_000;
      while (
        (pumpingEvents || queuedEvents.length > 0) &&
        Date.now() < deadline
      ) {
        await delay(25);
      }
      disposed = true;
      // Release confirmation waiters if the bridge stayed unavailable through
      // the drain window. The events are intentionally dropped at disposal.
      for (const pending of queuedEvents.splice(0)) pending.resolve();
    },
  };
};
