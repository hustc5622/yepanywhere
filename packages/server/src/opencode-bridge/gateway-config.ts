import type {
  ModelInfo,
  OpenCodeRequestProtocol,
  OpenCodeSessionConfig,
} from "@yep-anywhere/shared";
import { getOpenCodeModelDefaultLimits } from "@yep-anywhere/shared";
import {
  type LlmGatewayCredentials,
  clean,
  fetchLlmGatewayModels,
  gatewaySubModuleHeaders,
  isRecord,
  resolveDefaultLlmGatewayChannel,
  withV1Path,
} from "../llm-gateways/index.js";

/**
 * OpenCode's view of one gateway. Structurally identical to the shared
 * credentials type: the OpenCode paths only ever address a single gateway, so
 * they deliberately do not carry the channel identity.
 */
export type OpenCodeGatewayConfig = LlmGatewayCredentials;

export interface ManagedOpenCodeGatewayOverlayOptions {
  openAICompatibleBaseURL?: string;
  sessionConfig: OpenCodeSessionConfig;
}

export interface UserConfiguredOpenCodeEnvOptions {
  /**
   * Local bridge URL that forwards requests to the configured gateway. User
   * configs commonly reference `LLM_API_BASE`; routing that alias through the
   * bridge lets Yep apply transport compatibility fixes without rewriting the
   * user's opencode.json.
   */
  gatewayProxyBaseURL?: string;
}

type Env = NodeJS.ProcessEnv;

const OPENCODE_GATEWAY_API_KEY_ENV = "YEP_OPENCODE_LLM_API_KEY";
const OPENCODE_NATIVE_ATTACHMENT_MODALITIES = {
  input: ["text", "image", "pdf"],
  output: ["text"],
} as const;
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

const DEFAULT_BUFFERED_GATEWAY_MODEL_TOKENS = ["glm"];

/**
 * Decide whether an OpenAI-compatible gateway response must be fully buffered
 * before being handed back to OpenCode.
 *
 * Some upstream models (notably GLM) emit valid but very small SSE chunks whose
 * tool-call deltas trigger an AI SDK decoder race inside OpenCode. Only those
 * responses need buffering; everything else is streamed through untouched so
 * first-byte latency and memory stay proportional to the actual payload instead
 * of the whole completion.
 *
 * Overrides:
 * - `YEP_OPENCODE_GATEWAY_FORCE_BUFFER=true` forces every response to buffer
 *   (safety switch to restore the previous behaviour if a new model regresses).
 * - `YEP_OPENCODE_GATEWAY_BUFFER_MODELS` replaces the default match list with a
 *   comma-separated set of case-insensitive substrings matched against the
 *   request's `model` id.
 */
export function gatewayResponseNeedsBuffering(
  model: string | undefined,
  env: Env = process.env,
): boolean {
  if (clean(env.YEP_OPENCODE_GATEWAY_FORCE_BUFFER) === "true") {
    return true;
  }
  if (!model) return false;
  const tokens = parseBufferedModelTokens(env);
  if (tokens.length === 0) return false;
  const normalized = model.toLowerCase();
  return tokens.some((token) => normalized.includes(token));
}

function parseBufferedModelTokens(env: Env): string[] {
  const override = clean(env.YEP_OPENCODE_GATEWAY_BUFFER_MODELS);
  if (override === undefined) {
    return DEFAULT_BUFFERED_GATEWAY_MODEL_TOKENS;
  }
  return override
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Resolve the single gateway the OpenCode paths address.
 *
 * Thin wrapper over the shared channel resolver: OpenCode consumes only the
 * credentials, so the channel identity is dropped here to keep this module's
 * public shape unchanged.
 */
export function resolveOpenCodeGatewayConfig(
  env: Env,
): OpenCodeGatewayConfig | null {
  const channel = resolveDefaultLlmGatewayChannel(env);
  if (!channel) return null;
  return {
    apiKey: channel.apiKey,
    apiBase: channel.apiBase,
    subModule: channel.subModule,
  };
}

function mergeOpenCodeConfig(
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
  return gatewaySubModuleHeaders(config);
}

/** Fetch the aggregator's model catalog, including each model's API shapes. */
export function fetchOpenCodeGatewayModels(
  config: OpenCodeGatewayConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  return fetchLlmGatewayModels(config, fetchImpl);
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
  // Prefer the user-supplied limits; otherwise fall back to the curated
  // per-model defaults so the ohmyrouter gateway model reports its real
  // context window instead of OpenCode's 200K default.
  const limits =
    sessionConfig.limits ?? getOpenCodeModelDefaultLimits(sessionConfig.model);
  if (limits) managed.limit = limits;
  if (capabilities?.attachment !== undefined) {
    managed.attachment = capabilities.attachment;
  }
  // Current OpenCode filters file parts against `modalities.input`; its legacy
  // `attachment` flag alone only controls catalog/UI metadata. Translate Yep's
  // existing attachment toggle unless the advanced model patch already made
  // an explicit modality choice.
  if (
    capabilities?.attachment === true &&
    !Object.hasOwn(advancedModel, "modalities")
  ) {
    managed.modalities = OPENCODE_NATIVE_ATTACHMENT_MODALITIES;
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
export function buildManagedOpenCodeConfig(
  config: OpenCodeGatewayConfig,
  options: ManagedOpenCodeGatewayOverlayOptions,
): Record<string, unknown> {
  const sessionConfig = options.sessionConfig;
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

/**
 * Build the environment for an OpenCode process that consumes the user's
 * normal global config. LaunchAgents receive dedicated OPENCODE_LLM_* values,
 * while existing user config may still reference the legacy LLM_* names.
 * Preserve explicit generic values and backfill only the missing aliases.
 */
export function buildUserConfiguredOpenCodeEnv(
  baseEnv: Env,
  config?: OpenCodeGatewayConfig | null,
  options: UserConfiguredOpenCodeEnvOptions = {},
): Env {
  const env: Env = { ...baseEnv };
  if (!config) return env;

  if (!clean(env.LLM_API_KEY)) env.LLM_API_KEY = config.apiKey;
  const legacyApiBase = clean(env.LLM_API_BASE);
  const gatewayProxyBaseURL = clean(options.gatewayProxyBaseURL);
  if (!legacyApiBase) {
    env.LLM_API_BASE = gatewayProxyBaseURL ?? config.apiBase;
  } else if (
    gatewayProxyBaseURL &&
    withV1Path(legacyApiBase) === config.apiBase
  ) {
    // Only replace a legacy alias that already points at this gateway. An
    // unrelated explicit LLM_API_BASE remains user-owned and is preserved.
    env.LLM_API_BASE = gatewayProxyBaseURL;
  }
  const dedicatedApiBase = clean(env.OPENCODE_LLM_API_BASE);
  if (
    gatewayProxyBaseURL &&
    dedicatedApiBase &&
    withV1Path(dedicatedApiBase) === config.apiBase
  ) {
    env.OPENCODE_LLM_API_BASE = gatewayProxyBaseURL;
  }
  if (!clean(env.LLM_SUB_MODULE) && config.subModule) {
    env.LLM_SUB_MODULE = config.subModule;
  }
  return env;
}

export function buildManagedOpenCodeEnv(
  baseEnv: Env,
  config: OpenCodeGatewayConfig | null | undefined,
  options: ManagedOpenCodeGatewayOverlayOptions,
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

  const overlay = buildManagedOpenCodeConfig(config, options);
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
