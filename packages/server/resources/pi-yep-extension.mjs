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

export { APPROVAL_TITLE_PREFIX };
