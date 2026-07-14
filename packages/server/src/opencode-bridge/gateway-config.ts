import type {
  ModelInfo,
  OpenCodeRequestProtocol,
  OpenCodeSessionConfig,
} from "@yep-anywhere/shared";

export interface OpenCodeGatewayConfig {
  apiKey: string;
  apiBase: string;
  subModule?: string;
}

export interface OpenCodeGatewayOverlayOptions {
  openAICompatibleBaseURL?: string;
  sessionConfig?: OpenCodeSessionConfig;
}

type Env = NodeJS.ProcessEnv;

const DEFAULT_API_BASE = "https://api.ohmyrouter.com";
const OHMYROUTER_SUB_MODULE = "claude-code-internal";
const OPENCODE_GATEWAY_API_KEY_ENV = "YEP_OPENCODE_LLM_API_KEY";
const MANAGED_PROVIDER_IDS: Record<OpenCodeRequestProtocol, string> = {
  "openai-compatible": "yep-openai-compatible",
  anthropic: "yep-anthropic",
};
const OPENCODE_BRIDGE_CONTROL_URL_ENVS = [
  "YEP_OPENCODE_BRIDGE_CONTROL_URL",
  "OPENCODE_BRIDGE_CONTROL_URL",
  "YEP_OPENCODE_BRIDGE_URL",
  "OPENCODE_BRIDGE_URL",
] as const;

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

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function withV1Path(apiBase: string): string {
  const normalized = apiBase.replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

/**
 * OpenAI-compatible traffic can optionally pass through the bridge. The
 * bridge injects gateway headers and coalesces tiny SSE chunks from gateways
 * whose tool-call deltas otherwise expose an AI SDK decoder race.
 */
export function resolveOpenCodeOpenAICompatibleBaseURL(
  env: Env,
): string | undefined {
  const bridgeControlUrl = OPENCODE_BRIDGE_CONTROL_URL_ENVS.map((key) =>
    clean(env[key]),
  ).find(Boolean);
  if (!bridgeControlUrl) return undefined;
  return `${bridgeControlUrl.replace(/\/+$/, "")}/gateway/v1`;
}

function defaultSubModule(apiBase: string): string | undefined {
  try {
    return new URL(apiBase).hostname === "api.ohmyrouter.com"
      ? OHMYROUTER_SUB_MODULE
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveOpenCodeGatewayConfig(
  env: Env,
): OpenCodeGatewayConfig | null {
  const apiKey =
    clean(env.OPENCODE_LLM_API_KEY) ??
    clean(env.SESSION_TITLE_LLM_API_KEY) ??
    clean(env.LLM_API_KEY);
  if (!apiKey) return null;

  const apiBase = withV1Path(
    clean(env.OPENCODE_LLM_API_BASE) ??
      clean(env.SESSION_TITLE_LLM_API_BASE) ??
      clean(env.LLM_API_BASE) ??
      DEFAULT_API_BASE,
  );
  const subModule =
    clean(env.OPENCODE_LLM_SUB_MODULE) ?? defaultSubModule(apiBase);

  return { apiKey, apiBase, subModule };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeOpenCodeConfig(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      continue;
    }
    const current = merged[key];
    merged[key] =
      isRecord(current) && isRecord(value)
        ? mergeOpenCodeConfig(current, value)
        : value;
  }
  return merged;
}

function gatewayHeaders(config: OpenCodeGatewayConfig): Record<string, string> {
  return config.subModule ? { "X-Sub-Module": config.subModule } : {};
}

function normalizeGatewayProtocols(value: unknown): OpenCodeRequestProtocol[] {
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

/** Fetch the aggregator's model catalog, including each model's API shapes. */
export async function fetchOpenCodeGatewayModels(
  config: OpenCodeGatewayConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  const response = await fetchImpl(`${config.apiBase}/models`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.apiKey}`,
      ...gatewayHeaders(config),
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

export function getManagedOpenCodeModelRef(
  sessionConfig: OpenCodeSessionConfig,
): string {
  return `${MANAGED_PROVIDER_IDS[sessionConfig.requestProtocol]}/${sessionConfig.model}`;
}

function buildManagedModelConfig(
  sessionConfig: OpenCodeSessionConfig,
  headers: Record<string, string>,
): Record<string, unknown> {
  const advancedModel = sessionConfig.advanced?.model ?? {};
  const capabilities = sessionConfig.capabilities;
  const managed: Record<string, unknown> = {
    name: sessionConfig.name ?? sessionConfig.model,
    headers,
  };
  if (sessionConfig.limits) managed.limit = sessionConfig.limits;
  if (capabilities?.attachment !== undefined) {
    managed.attachment = capabilities.attachment;
  }
  if (capabilities?.reasoning !== undefined) {
    managed.reasoning = capabilities.reasoning;
  }
  if (capabilities?.temperature !== undefined) {
    managed.temperature = capabilities.temperature;
  }
  if (capabilities?.toolCall !== undefined) {
    managed.tool_call = capabilities.toolCall;
  }
  return mergeOpenCodeConfig(advancedModel, managed);
}

/** Build the exact provider/model catalog entry consumed by one session. */
export function buildOpenCodeGatewayOverlay(
  config: OpenCodeGatewayConfig,
  options: OpenCodeGatewayOverlayOptions = {},
): Record<string, unknown> {
  const sessionConfig = options.sessionConfig;
  if (!sessionConfig) return {};

  const headers = gatewayHeaders(config);
  const providerID = MANAGED_PROVIDER_IDS[sessionConfig.requestProtocol];
  const baseURL =
    sessionConfig.requestProtocol === "openai-compatible"
      ? (options.openAICompatibleBaseURL ?? config.apiBase)
      : config.apiBase;
  const npm =
    sessionConfig.requestProtocol === "openai-compatible"
      ? "@ai-sdk/openai-compatible"
      : "@ai-sdk/anthropic";
  const advancedProvider = sessionConfig.advanced?.provider ?? {};
  const provider = mergeOpenCodeConfig(advancedProvider, {
    npm,
    name:
      sessionConfig.requestProtocol === "openai-compatible"
        ? "Yep gateway (OpenAI-compatible)"
        : "Yep gateway (Anthropic)",
    options: {
      apiKey: `{env:${OPENCODE_GATEWAY_API_KEY_ENV}}`,
      baseURL,
      headers,
    },
    models: {
      [sessionConfig.model]: buildManagedModelConfig(sessionConfig, headers),
    },
  });

  return {
    model: getManagedOpenCodeModelRef(sessionConfig),
    provider: { [providerID]: provider },
  };
}

export function buildManagedOpenCodeEnv(
  baseEnv: Env,
  config?: OpenCodeGatewayConfig | null,
  options: OpenCodeGatewayOverlayOptions = {},
): Env {
  const env: Env = { ...baseEnv };
  if (!config) return env;

  // The generated provider is configured exclusively through
  // OPENCODE_CONFIG_CONTENT. Generic LLM variables must not silently rewrite
  // its protocol-specific endpoint or headers.
  const managedEnv: Env = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        key !== "LLM_API_KEY" &&
        key !== "LLM_API_BASE" &&
        key !== "LLM_SUB_MODULE",
    ),
  );
  managedEnv[OPENCODE_GATEWAY_API_KEY_ENV] = config.apiKey;

  const overlay = buildOpenCodeGatewayOverlay(config, options);
  if (Object.keys(overlay).length === 0) return managedEnv;

  if (!managedEnv.OPENCODE_CONFIG_CONTENT) {
    managedEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(overlay);
    return managedEnv;
  }

  try {
    const parsed = JSON.parse(managedEnv.OPENCODE_CONFIG_CONTENT) as unknown;
    if (!isRecord(parsed)) return managedEnv;
    managedEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(
      mergeOpenCodeConfig(parsed, overlay),
    );
  } catch {
    // Preserve an explicitly supplied invalid value so OpenCode reports its
    // own config error instead of Yep silently discarding user configuration.
  }
  return managedEnv;
}
