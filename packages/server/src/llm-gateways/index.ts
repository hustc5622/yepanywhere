/**
 * Provider-neutral LLM gateway channels.
 *
 * Yep talks to OpenAI-/Anthropic-compatible aggregator gateways from several
 * independent places: the OpenCode bridge and its managed provider overlay,
 * the Pi provider's generated provider catalog, session-title generation, and
 * the gateway benchmark. Each of those grew its own copy of "resolve a base
 * URL, an API key and an optional `X-Sub-Module` header", which is why adding
 * a second gateway previously meant touching every consumer.
 *
 * This module owns those primitives once. It is deliberately dependency-free
 * (no logger, no config singleton) so it stays trivially testable and usable
 * from the bridge sidecars, which do not boot the full server config.
 */

import type { ModelInfo, OpenCodeRequestProtocol } from "@yep-anywhere/shared";

export type Env = NodeJS.ProcessEnv;

/** Everything needed to call one gateway. */
export interface LlmGatewayCredentials {
  apiKey: string;
  /** Always normalized to end in `/v1`. */
  apiBase: string;
  /** Optional `X-Sub-Module` routing header required by some gateways. */
  subModule?: string;
}

/**
 * One addressable gateway. `id` is used to namespace derived identifiers
 * (model refs, generated provider ids), so it is restricted to a conservative
 * character set and is stable across restarts.
 */
export interface LlmGatewayChannel extends LlmGatewayCredentials {
  id: string;
  label: string;
  /** True for the channel derived from the legacy single-gateway variables. */
  isDefault: boolean;
  /**
   * Name of the environment variable the key came from, when it came from one.
   * Callers that spawn provider processes use this to scrub the credential
   * from the child environment (Pi's bash tool would otherwise inherit it).
   */
  apiKeyEnv?: string;
}

/** Id of the channel derived from the legacy `LLM_*`/`OPENCODE_LLM_*` vars. */
export const DEFAULT_LLM_GATEWAY_CHANNEL_ID = "default";

/** Historic default aggregator; kept as the fallback base URL. */
export const DEFAULT_LLM_GATEWAY_API_BASE = "https://api.ohmyrouter.com";

const OHMYROUTER_HOST = "api.ohmyrouter.com";
const OHMYROUTER_SUB_MODULE = "claude-code-internal";

/** Extra channels, as JSON array or compact `id=base|keyEnv|subModule` list. */
export const LLM_GATEWAYS_ENV = "YEP_LLM_GATEWAYS";

/** Comma-separated model-id prefixes a gateway picker should offer. */
export const LLM_GATEWAY_MODELS_ENV = "YEP_LLM_GATEWAY_MODELS";

/**
 * Model ids a coding-agent picker offers, matched case-insensitively by prefix
 * against the bare (un-namespaced) gateway model id.
 *
 * Aggregator gateways list their whole historic catalog — two gateways produced
 * 63 entries here, most of them superseded snapshots, families nobody drives an
 * agent with, and endpoints that are not chat at all. An allowlist is used
 * instead of a deny list because the catalogs keep growing: a new dated Claude
 * snapshot or Gemini preview must not silently reappear in the picker.
 *
 * One entry per family, newest release only. Nothing here is unroutable: a
 * session already pinned to another model still resolves and still runs; this
 * list only controls what a picker offers.
 *
 * Set `YEP_LLM_GATEWAY_MODELS` to replace the list, or to an empty value to
 * offer every model the gateway reports.
 */
const DEFAULT_GATEWAY_MODEL_PREFIXES = [
  // Anthropic: Opus and Fable only.
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-fable-5",
  // OpenAI: 5.6 and newer.
  "gpt-5.6",
  "gpt-5.7",
  "gpt-6",
  // Zhipu, Moonshot, MiniMax, DeepSeek: newest generation only.
  "glm-5.2",
  "kimi-k3",
  "minimax-m3",
  "deepseek-v4",
];

const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** Normalize any gateway base URL to the `/v1` root the catalog lives under. */
export function withV1Path(apiBase: string): string {
  const normalized = apiBase.replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

/**
 * Default `X-Sub-Module` for a gateway that requires one. Only ohmyrouter is
 * known to need it; every other host defaults to sending no routing header.
 */
export function defaultSubModuleForApiBase(
  apiBase: string,
): string | undefined {
  try {
    return new URL(apiBase).hostname === OHMYROUTER_HOST
      ? OHMYROUTER_SUB_MODULE
      : undefined;
  } catch {
    return undefined;
  }
}

/** Human label for a gateway that did not supply one. */
export function defaultLabelForApiBase(apiBase: string): string {
  try {
    const { hostname } = new URL(apiBase);
    return hostname === OHMYROUTER_HOST ? "OhMyRouter" : hostname;
  } catch {
    return apiBase;
  }
}

/** Request headers for a gateway call, including the optional routing header. */
export function gatewaySubModuleHeaders(
  credentials: Pick<LlmGatewayCredentials, "subModule">,
): Record<string, string> {
  return credentials.subModule ? { "X-Sub-Module": credentials.subModule } : {};
}

export function gatewayAuthHeaders(
  credentials: LlmGatewayCredentials,
): Record<string, string> {
  return {
    authorization: `Bearer ${credentials.apiKey}`,
    ...gatewaySubModuleHeaders(credentials),
  };
}

/**
 * Resolve the channel described by the legacy single-gateway variables.
 *
 * `OPENCODE_LLM_*` wins over the generic `LLM_*` aliases (LaunchAgents set the
 * dedicated names, while user shells and existing opencode.json files still
 * reference the generic ones). Returns null when no API key is configured,
 * which every caller treats as "gateway features unavailable".
 */
export function resolveDefaultLlmGatewayChannel(
  env: Env,
): LlmGatewayChannel | null {
  const apiKeyEnv = clean(env.OPENCODE_LLM_API_KEY)
    ? "OPENCODE_LLM_API_KEY"
    : clean(env.LLM_API_KEY)
      ? "LLM_API_KEY"
      : undefined;
  const apiKey = apiKeyEnv ? clean(env[apiKeyEnv]) : undefined;
  if (!apiKey || !apiKeyEnv) return null;

  const apiBase = withV1Path(
    clean(env.OPENCODE_LLM_API_BASE) ??
      clean(env.LLM_API_BASE) ??
      DEFAULT_LLM_GATEWAY_API_BASE,
  );
  const subModule =
    clean(env.OPENCODE_LLM_SUB_MODULE) ??
    clean(env.LLM_SUB_MODULE) ??
    defaultSubModuleForApiBase(apiBase);

  return {
    id: DEFAULT_LLM_GATEWAY_CHANNEL_ID,
    label: defaultLabelForApiBase(apiBase),
    isDefault: true,
    apiKey,
    apiKeyEnv,
    apiBase,
    ...(subModule ? { subModule } : {}),
  };
}

/** A rejected `YEP_LLM_GATEWAYS` entry, for the caller to log. */
export interface LlmGatewayChannelProblem {
  entry: string;
  reason: string;
}

export interface ResolvedLlmGatewayChannels {
  channels: LlmGatewayChannel[];
  problems: LlmGatewayChannelProblem[];
}

interface RawChannelSpec {
  id?: unknown;
  label?: unknown;
  apiBase?: unknown;
  apiKey?: unknown;
  apiKeyEnv?: unknown;
  subModule?: unknown;
}

/**
 * Resolve every configured gateway channel.
 *
 * The default channel (when configured) always comes first, so callers that
 * only support one gateway keep their previous behaviour by taking `[0]`.
 * Additional channels come from `YEP_LLM_GATEWAYS`, accepting either
 *
 *   JSON:    [{"id":"aitl","apiBase":"https://api.example.com/v1",
 *              "apiKeyEnv":"NEW_LLM_API_KEY","subModule":"codex-internal"}]
 *   compact: aitl=https://api.example.com/v1|NEW_LLM_API_KEY|codex-internal|Label
 *
 * In the compact form the sub-module and label fields are optional, and an
 * empty sub-module field disables the per-host default routing header.
 *
 * Keys are referenced by environment variable name so the secret itself is
 * never duplicated into a second variable that ends up in logs or in a child
 * process environment. A literal `apiKey` is still accepted for callers that
 * have no separate variable to point at.
 *
 * Invalid entries are skipped rather than failing startup: a typo in one extra
 * gateway must not take the working default gateway down with it.
 */
export function resolveLlmGatewayChannelsDetailed(
  env: Env,
): ResolvedLlmGatewayChannels {
  const channels: LlmGatewayChannel[] = [];
  const problems: LlmGatewayChannelProblem[] = [];

  const defaultChannel = resolveDefaultLlmGatewayChannel(env);
  if (defaultChannel) channels.push(defaultChannel);

  const raw = clean(env[LLM_GATEWAYS_ENV]);
  if (!raw) return { channels, problems };

  const specs = parseChannelSpecs(raw, problems);
  const seen = new Set(channels.map((channel) => channel.id));
  for (const { entry, spec } of specs) {
    const resolved = resolveChannelSpec(spec, env, entry, problems);
    if (!resolved) continue;
    if (seen.has(resolved.id)) {
      problems.push({
        entry,
        reason: `duplicate channel id "${resolved.id}"`,
      });
      continue;
    }
    seen.add(resolved.id);
    channels.push(resolved);
  }
  return { channels, problems };
}

/** Convenience wrapper for callers that do not report configuration problems. */
export function resolveLlmGatewayChannels(env: Env): LlmGatewayChannel[] {
  return resolveLlmGatewayChannelsDetailed(env).channels;
}

/** Look up one channel by id. */
export function findLlmGatewayChannel(
  channels: readonly LlmGatewayChannel[],
  id: string | undefined,
): LlmGatewayChannel | undefined {
  if (!id) return undefined;
  return channels.find((channel) => channel.id === id);
}

function parseChannelSpecs(
  raw: string,
  problems: LlmGatewayChannelProblem[],
): Array<{ entry: string; spec: RawChannelSpec }> {
  if (raw.startsWith("[") || raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      problems.push({
        entry: LLM_GATEWAYS_ENV,
        reason: "value is not valid JSON",
      });
      return [];
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.flatMap((item, index) =>
      isRecord(item)
        ? [{ entry: `${LLM_GATEWAYS_ENV}[${index}]`, spec: item }]
        : [],
    );
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        problems.push({ entry, reason: 'expected "id=apiBase|API_KEY_ENV"' });
        return [];
      }
      const [apiBase, apiKeyEnv, subModule, label] = entry
        .slice(separator + 1)
        .split("|")
        .map((part) => part.trim());
      return [
        {
          entry,
          spec: {
            id: entry.slice(0, separator),
            apiBase,
            apiKeyEnv,
            subModule,
            label,
          } satisfies RawChannelSpec,
        },
      ];
    });
}

function resolveChannelSpec(
  spec: RawChannelSpec,
  env: Env,
  entry: string,
  problems: LlmGatewayChannelProblem[],
): LlmGatewayChannel | null {
  const id = clean(stringOrUndefined(spec.id))?.toLowerCase();
  if (!id || !CHANNEL_ID_PATTERN.test(id)) {
    problems.push({
      entry,
      reason: "channel id must match [a-z0-9][a-z0-9_-]*",
    });
    return null;
  }
  if (id === DEFAULT_LLM_GATEWAY_CHANNEL_ID) {
    problems.push({
      entry,
      reason: `"${DEFAULT_LLM_GATEWAY_CHANNEL_ID}" is reserved for the LLM_API_* channel`,
    });
    return null;
  }

  const rawApiBase = clean(stringOrUndefined(spec.apiBase));
  if (!rawApiBase) {
    problems.push({ entry, reason: "apiBase is required" });
    return null;
  }
  const apiBase = withV1Path(rawApiBase);

  const apiKeyEnv = clean(stringOrUndefined(spec.apiKeyEnv));
  if (apiKeyEnv && !ENV_NAME_PATTERN.test(apiKeyEnv)) {
    problems.push({
      entry,
      reason: "apiKeyEnv must be a valid environment variable name",
    });
    return null;
  }
  const apiKey = apiKeyEnv
    ? clean(env[apiKeyEnv])
    : clean(stringOrUndefined(spec.apiKey));
  if (!apiKey) {
    problems.push({
      entry,
      reason: apiKeyEnv
        ? `environment variable ${apiKeyEnv} is empty`
        : "apiKey or apiKeyEnv is required",
    });
    return null;
  }

  // An explicit empty string disables the routing header even for a host whose
  // default would add one; `undefined` falls back to the per-host default.
  const explicitSubModule = stringOrUndefined(spec.subModule);
  const subModule =
    explicitSubModule === undefined
      ? defaultSubModuleForApiBase(apiBase)
      : clean(explicitSubModule);

  return {
    id,
    label:
      clean(stringOrUndefined(spec.label)) ?? defaultLabelForApiBase(apiBase),
    isDefault: false,
    apiKey,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    apiBase,
    ...(subModule ? { subModule } : {}),
  };
}

interface GatewayModelRecord {
  id?: unknown;
  name?: unknown;
  owned_by?: unknown;
  context_window?: unknown;
  supported_endpoint_types?: unknown;
}

interface GatewayModelsResponse {
  success?: unknown;
  data?: unknown;
}

/**
 * Map a gateway's `supported_endpoint_types` onto the request protocols Yep
 * can drive. Unknown or missing values fall back to "both", which is what the
 * historic single-gateway behaviour assumed.
 */
export function normalizeGatewayProtocols(
  value: unknown,
): OpenCodeRequestProtocol[] {
  if (!Array.isArray(value)) {
    return ["openai-compatible", "anthropic"];
  }

  const protocols = new Set<OpenCodeRequestProtocol>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.toLowerCase();
    if (
      normalized.includes("anthropic") ||
      normalized === "messages" ||
      normalized.includes("/messages")
    ) {
      protocols.add("anthropic");
    }
    if (
      normalized.includes("openai") ||
      normalized.includes("chat/completions") ||
      (normalized.includes("chat") && normalized.includes("completion")) ||
      normalized.includes("openai-compatible")
    ) {
      protocols.add("openai-compatible");
    }
  }
  return protocols.size > 0
    ? Array.from(protocols)
    : ["openai-compatible", "anthropic"];
}

/** Fetch one gateway's model catalog, including each model's API shapes. */
export async function fetchLlmGatewayModels(
  credentials: LlmGatewayCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  const response = await fetchImpl(`${credentials.apiBase}/models`, {
    headers: {
      accept: "application/json",
      ...gatewayAuthHeaders(credentials),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`OpenCode model gateway returned ${response.status}`);
  }

  const payload = (await response.json()) as GatewayModelsResponse;
  if (payload.success === false || !Array.isArray(payload.data)) {
    throw new Error("OpenCode model gateway returned an invalid catalog");
  }

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const raw of payload.data) {
    if (!isRecord(raw)) continue;
    const item = raw as GatewayModelRecord;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (
      !id ||
      id === "__proto__" ||
      id === "prototype" ||
      id === "constructor" ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);

    const ownedBy =
      typeof item.owned_by === "string" && item.owned_by.trim()
        ? item.owned_by.trim()
        : undefined;
    const contextWindow =
      typeof item.context_window === "number" &&
      Number.isFinite(item.context_window) &&
      item.context_window > 0
        ? Math.trunc(item.context_window)
        : undefined;
    const supportedRequestProtocols = normalizeGatewayProtocols(
      item.supported_endpoint_types,
    );

    models.push({
      id,
      name:
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim()
          : id,
      description: ownedBy,
      ownedBy,
      contextWindow,
      supportedRequestProtocols,
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the active picker model prefixes. */
export function resolveGatewayModelPrefixes(env: Env): string[] {
  const override = env[LLM_GATEWAY_MODELS_ENV];
  if (override === undefined) return DEFAULT_GATEWAY_MODEL_PREFIXES;
  return override
    .split(",")
    .map((prefix) => prefix.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether a picker should offer this model. Matched against the bare model id,
 * so a channel-qualified id must have its prefix stripped first. An empty
 * prefix list offers everything.
 */
export function isVisibleGatewayModel(
  bareModelId: string,
  env: Env = process.env,
): boolean {
  const prefixes = resolveGatewayModelPrefixes(env);
  if (prefixes.length === 0) return true;
  const normalized = bareModelId.trim().toLowerCase();
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
