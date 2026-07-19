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
 * - YEP_MANAGED_OPENCODE=1    set by Yep-managed servers; the plugin stays
 *                             inert there because those events already reach
 *                             the bridge via /global/event SSE.
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
  if (
    process.env.YEP_MANAGED_OPENCODE === "1" ||
    process.env.YEP_OPENCODE_PLUGIN_DISABLE === "1"
  ) {
    return {};
  }

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
