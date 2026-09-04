/**
 * Yep's temporary, process-local Pi integration.
 *
 * Loaded explicitly with `pi --extension`; it neither installs files under
 * ~/.pi nor mutates the user's models.json. The server supplies a generated
 * provider catalog through YEP_PI_PROVIDER_CONFIG for this child only, and the
 * per-provider gateway credentials through YEP_PI_LLM_API_KEYS.
 */

const APPROVAL_TITLE_PREFIX = "__YEP_PI_TOOL_APPROVAL__:";
const MAX_APPROVAL_PAYLOAD_CHARS = 200_000;
const PROVIDER_STATE_KEY = Symbol.for("yep.pi.provider-config.v1");

// Pi's RPC event stream carries no tool progress, but the agent loop does emit
// `tool_execution_update` to extensions. Relay a bounded tail of it through the
// fire-and-forget `ui.notify` channel so Yep can render a live exec preview.
const PARTIAL_OUTPUT_PREFIX = "__YEP_PI_TOOL_PARTIAL__:";
const MAX_PARTIAL_OUTPUT_CHARS = 8_000;
// The bash tool already throttles its own updates to 100ms; this is a second
// gate so a chattier tool cannot flood the RPC stdout stream.
const PARTIAL_OUTPUT_THROTTLE_MS = 200;
const MAX_TRACKED_TOOL_CALLS = 32;

function parseProviderConfig() {
  const retained = globalThis[PROVIDER_STATE_KEY];
  if (retained && Array.isArray(retained.providers)) return retained;

  const raw = process.env.YEP_PI_PROVIDER_CONFIG;
  // One key per generated provider: Yep can register several gateways, and
  // each gateway has its own credential. The legacy single-key variable is
  // still honoured as a fallback for a provider with no entry in the map.
  const rawKeys = process.env.YEP_PI_LLM_API_KEYS;
  const fallbackApiKey = process.env.YEP_PI_LLM_API_KEY;

  // Pi's bash tool inherits process.env. Remove server-owned configuration as
  // soon as the extension has captured it so tool subprocesses cannot read it.
  Reflect.deleteProperty(process.env, "YEP_PI_PROVIDER_CONFIG");
  Reflect.deleteProperty(process.env, "YEP_PI_LLM_API_KEYS");
  Reflect.deleteProperty(process.env, "YEP_PI_LLM_API_KEY");

  let apiKeys = {};
  if (rawKeys) {
    try {
      const parsedKeys = JSON.parse(rawKeys);
      if (parsedKeys && typeof parsedKeys === "object") apiKeys = parsedKeys;
    } catch {
      // Fall through with no map; providers without a key are dropped below.
    }
  }

  if (!raw || (!fallbackApiKey && Object.keys(apiKeys).length === 0)) {
    const empty = { providers: [] };
    globalThis[PROVIDER_STATE_KEY] = empty;
    return empty;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.providers)) {
      const empty = { providers: [] };
      globalThis[PROVIDER_STATE_KEY] = empty;
      return empty;
    }
    const providers = parsed.providers
      .filter(
        (provider) =>
          provider &&
          typeof provider.id === "string" &&
          provider.id.length > 0 &&
          provider.config &&
          typeof provider.config === "object",
      )
      .map((provider) => {
        const apiKey =
          typeof apiKeys[provider.id] === "string" && apiKeys[provider.id]
            ? apiKeys[provider.id]
            : fallbackApiKey;
        return apiKey
          ? { id: provider.id, config: { ...provider.config, apiKey } }
          : null;
      })
      // Fail closed: a provider with no credential would surface as a model
      // that always errors at request time.
      .filter((provider) => provider !== null);
    // Pi recreates its AgentSession and reloads extensions after a native
    // fork/resume. Retain the captured config in this child process so the
    // generated provider is registered again without putting the gateway key
    // back into process.env (which the bash tool inherits).
    const config = {
      providers,
      ...(typeof parsed.globalInstructions === "string" &&
      parsed.globalInstructions.trim()
        ? { globalInstructions: parsed.globalInstructions.trim() }
        : {}),
    };
    globalThis[PROVIDER_STATE_KEY] = config;
    return config;
  } catch {
    const empty = { providers: [] };
    globalThis[PROVIDER_STATE_KEY] = empty;
    return empty;
  }
}

function partialResultText(partialResult) {
  if (typeof partialResult === "string") return partialResult;
  if (!partialResult || typeof partialResult !== "object") return "";
  const content = partialResult.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Forward a running tool's partial output to Yep.
 *
 * Updates are cumulative snapshots (not deltas), so a dropped or reordered
 * notify only costs a frame: the server keeps the longest snapshot and the
 * real `toolResult` still arrives through the normal RPC stream.
 */
function registerPartialOutputRelay(pi) {
  /** @type {Map<string, { timer: NodeJS.Timeout | undefined, pending: string | undefined, lastSentAt: number, lastSent: string }>} */
  const states = new Map();

  const send = (ctx, toolCallId, text) => {
    const state = states.get(toolCallId);
    if (state) {
      state.pending = undefined;
      state.lastSentAt = Date.now();
      state.lastSent = text;
    }
    try {
      ctx.ui.notify(
        `${PARTIAL_OUTPUT_PREFIX}${JSON.stringify({ toolCallId, text })}`,
      );
    } catch {
      // A notify failure must never break tool execution.
    }
  };

  const clear = (toolCallId) => {
    const state = states.get(toolCallId);
    if (state?.timer) clearTimeout(state.timer);
    states.delete(toolCallId);
  };

  pi.on("tool_execution_start", (event) => {
    clear(event.toolCallId);
  });

  pi.on("tool_execution_update", (event, ctx) => {
    const toolCallId = event.toolCallId;
    if (typeof toolCallId !== "string" || !toolCallId) return;
    const full = partialResultText(event.partialResult);
    if (!full) return;
    const text =
      full.length > MAX_PARTIAL_OUTPUT_CHARS
        ? full.slice(-MAX_PARTIAL_OUTPUT_CHARS)
        : full;

    let state = states.get(toolCallId);
    if (!state) {
      state = {
        timer: undefined,
        pending: undefined,
        lastSentAt: 0,
        lastSent: "",
      };
      states.set(toolCallId, state);
      // `tool_execution_end` normally removes the entry; evict the oldest ones
      // anyway so an aborted turn cannot retain snapshots for the lifetime of
      // the Pi process.
      while (states.size > MAX_TRACKED_TOOL_CALLS) {
        const oldest = states.keys().next();
        if (oldest.done) break;
        clear(oldest.value);
      }
    }
    if (text === state.lastSent) return;

    const wait = PARTIAL_OUTPUT_THROTTLE_MS - (Date.now() - state.lastSentAt);
    if (wait <= 0) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      send(ctx, toolCallId, text);
      return;
    }

    // Coalesce into a trailing emit so a burst of updates still ends on the
    // newest snapshot instead of a stale one.
    state.pending = text;
    state.timer ??= setTimeout(() => {
      const current = states.get(toolCallId);
      if (!current) return;
      current.timer = undefined;
      const pending = current.pending;
      if (pending === undefined) return;
      send(ctx, toolCallId, pending);
    }, wait);
    state.timer.unref?.();
  });

  pi.on("tool_execution_end", (event) => {
    clear(event.toolCallId);
  });
}

function serializeApproval(event) {
  let payload;
  try {
    payload = JSON.stringify({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
    });
  } catch {
    payload = JSON.stringify({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: {},
    });
  }
  return payload.length <= MAX_APPROVAL_PAYLOAD_CHARS
    ? payload
    : JSON.stringify({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: {},
        truncated: true,
      });
}

export default function yepPiExtension(pi) {
  const config = parseProviderConfig();
  for (const provider of config.providers) {
    pi.registerProvider(provider.id, provider.config);
  }

  if (config.globalInstructions) {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${config.globalInstructions}`,
    }));
  }

  registerPartialOutputRelay(pi);

  pi.on("tool_call", async (event, ctx) => {
    const approved = await ctx.ui.confirm(
      `${APPROVAL_TITLE_PREFIX}${event.toolName}`,
      serializeApproval(event),
    );
    if (!approved) {
      return {
        block: true,
        reason: "The tool call was denied by the user in Yep.",
      };
    }
    return undefined;
  });
}

export { APPROVAL_TITLE_PREFIX, PARTIAL_OUTPUT_PREFIX };
