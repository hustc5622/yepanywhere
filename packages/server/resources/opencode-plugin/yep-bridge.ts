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

/** Events worth forwarding; message.part.* streaming is deliberately excluded. */
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
]);

const DECISION_POLL_WAIT_MS = 25_000;
const DECISION_POLL_TIMEOUT_MS = 30_000;
const DECISION_RETRY_DELAY_MS = 5_000;

interface YepDecision {
  kind: "permission" | "question";
  requestId: string;
  sessionId: string;
  reply?: "once" | "always" | "reject";
  action?: "reply" | "reject";
  answers?: string[][];
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
    postSessionIdPermissionsPermissionId?: (options: {
      path: { id: string; permissionID: string };
      body: { response: "once" | "always" | "reject" };
    }) => Promise<unknown>;
    _client?: {
      post: (options: {
        url: string;
        path?: Record<string, string>;
        body?: unknown;
        headers?: Record<string, string>;
      }) => Promise<unknown>;
    };
  };

  async function applyDecision(decision: YepDecision): Promise<void> {
    try {
      if (decision.kind === "permission") {
        await client.postSessionIdPermissionsPermissionId?.({
          path: { id: decision.sessionId, permissionID: decision.requestId },
          body: { response: decision.reply ?? "once" },
        });
        return;
      }
      // Questions have no dedicated v1 SDK method; use the underlying
      // hey-api client (its fetch is the same in-process transport).
      const raw = client._client;
      if (!raw) return;
      if (decision.action === "reject") {
        await raw.post({
          url: "/question/{requestID}/reject",
          path: { requestID: decision.requestId },
        });
      } else {
        await raw.post({
          url: "/question/{requestID}/reply",
          path: { requestID: decision.requestId },
          body: { answers: decision.answers ?? [] },
          headers: { "content-type": "application/json" },
        });
      }
    } catch {
      // The user can still answer in the TUI; the bridge pending state is
      // reconciled by the permission.replied/question.* event either way.
    }
  }

  // Decision long-poll loop. Doubles as the liveness heartbeat: the bridge
  // marks this instance's sessions idle when polling stops.
  void (async () => {
    while (!disposed) {
      try {
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
          for (const decision of data.decisions ?? []) {
            await applyDecision(decision);
          }
          continue;
        }
      } catch {
        // Bridge unreachable - back off and retry.
      }
      await new Promise((resolve) =>
        setTimeout(resolve, DECISION_RETRY_DELAY_MS),
      );
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
      void postJson("/external/events", { instanceId, directory, event });
    },
    dispose: async () => {
      disposed = true;
    },
  };
};
