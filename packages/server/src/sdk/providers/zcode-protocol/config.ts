/**
 * Server-only ZCode config/credentials whitelist adapter.
 *
 * Reads `~/.zcode/v2/config.json` and `~/.zcode/v2/credentials.json`,
 * extracts only the fields Yep needs, discards everything else, and builds
 * a composite-ID model catalog for client-facing model selection.
 *
 * Real ZCode 0.16.1 config structure (verified from actual config.json):
 *   - Root key is singular `provider` (NOT `providers`), an object map.
 *   - Each provider entry has: `name`, `kind`, `options`, `enabled`,
 *     `source`, `models` (object map, NOT array), `systemDisabledReason`.
 *   - `models` is an object map keyed by model ID; each value has fields
 *     like `name`, `reasoning`, `limit`, `modalities`, `zcode`.
 *   - Base URL, API key and other runtime parameters live inside `options`.
 *
 * Security rules enforced here:
 *   - Raw config/credentials never leave this module (never logged, never
 *     persisted, never returned to the client).
 *   - The catalog only carries `hasSecret`/`available` booleans and stable
 *     error codes — never the key value itself.
 *   - Unknown provider kinds are marked unavailable (fail-closed), not
 *     silently mapped to the closest known kind.
 *   - Error objects return stable codes, not raw config snippets.
 *   - `interaction/requestProviderRuntimeHeaders` content is handled
 *     separately in P1 and is never part of the catalog or registry.
 */

import type {
  ZCodeErrorCode,
  ZCodeProviderRegistryEntry,
} from "@yep-anywhere/shared";
import { z } from "zod";
import type {
  ZCodeApiKeySource,
  ZCodeConfigParseResult,
  ZCodeModelCatalogEntry,
  ZCodeParsedModel,
  ZCodeParsedProvider,
  ZCodeProviderKind,
} from "./types.js";

// =============================================================================
// Whitelist Zod schemas (lenient: unknown fields are counted, not retained)
// =============================================================================

/** Known provider kinds — anything else is marked unavailable. */
const KNOWN_PROVIDER_KINDS = new Set<ZCodeProviderKind>([
  "anthropic",
  "openai",
  "openai-compatible",
]);

/**
 * Provider options schema — only extracts fields Yep needs.
 * The `apiKey`, `baseURL`, `apiKeyRequired`, and `headers` are the
 * runtime parameters used by the registry adapter. Secret values remain in
 * server-only parsed provider records only long enough to build the in-memory
 * app-server registry; they never enter the client-facing catalog.
 */
const ProviderOptionsSchema = z
  .object({
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    apiKeyRequired: z.boolean().optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/**
 * Model `reasoning` capability, when it is an object.
 *
 * Real ZCode 0.16.1 example (GLM-5-Turbo):
 *   `{enabled: true, variants: ["enabled", "off"], defaultVariant: "enabled"}`
 *
 * The CLI derives its thought-level list from this capability
 * (`listThoughtLevels()` returns `[]` when reasoning is disabled or absent), so
 * a model with `reasoning: null` has no thought level at all.
 */
const ConfigModelReasoningObjectSchema = z
  .object({
    enabled: z.boolean().optional(),
    variants: z.array(z.string()).optional(),
    defaultVariant: z.string().optional(),
  })
  .passthrough();

/**
 * Model entry schema for the `models` object map.
 * Each model value has fields like `name`, `reasoning`, `limit`, etc.
 * We only need the model key (ID) and optionally `name` for the label.
 */
const ConfigModelSchema = z
  .object({
    name: z.string().optional(),
    // Real ZCode 0.16.1: reasoning can be a boolean, an object like
    // {enabled, variants, defaultVariant}, or null. Keep it unknown so a
    // malformed capability degrades to "no thought levels" instead of
    // dropping the whole model from the catalog.
    reasoning: z.unknown().optional(),
    limit: z.unknown().optional(),
    modalities: z.unknown().optional(),
    zcode: z.unknown().optional(),
  })
  .passthrough();

/**
 * Extract the thought levels a model advertises.
 *
 * Mirrors the real CLI's `WG(modelRef, catalog)`: return the declared levels
 * only when the reasoning capability is enabled, otherwise return an empty
 * list. A bare `reasoning: true` enables reasoning without naming levels, so
 * there is nothing selectable. Any unrecognized shape also yields no levels.
 */
function extractThoughtLevels(reasoning: unknown): {
  levels: string[];
  defaultLevel?: string;
} {
  const parsed = ConfigModelReasoningObjectSchema.safeParse(reasoning);
  if (!parsed.success) return { levels: [] };
  const capability = parsed.data;
  if (capability.enabled === false) return { levels: [] };

  const seen = new Set<string>();
  const levels: string[] = [];
  for (const raw of capability.variants ?? []) {
    const level = raw.trim();
    if (!level || seen.has(level)) continue;
    seen.add(level);
    levels.push(level);
  }
  if (levels.length === 0) return { levels: [] };

  const defaultLevel = capability.defaultVariant?.trim();
  return {
    levels,
    ...(defaultLevel && seen.has(defaultLevel) ? { defaultLevel } : {}),
  };
}

/**
 * Real ZCode 0.16.1 config provider entry.
 * Keyed by provider ID (e.g. `builtin:zai`, `builtin:bigmodel`).
 */
const ConfigProviderSchema = z
  .object({
    name: z.string().optional(),
    kind: z.string(),
    options: ProviderOptionsSchema.optional(),
    enabled: z.boolean().optional(),
    source: z.string().optional(),
    models: z.record(z.string(), ConfigModelSchema).optional(),
    systemDisabledReason: z.string().optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/**
 * Real ZCode config root: singular `provider` (object map, NOT array).
 * Falls back to `providers` for backward compatibility with older fixtures.
 */
const ConfigRootSchema = z
  .object({
    // Real CLI uses singular `provider` as an object map
    provider: z.record(z.string(), ConfigProviderSchema).optional(),
    // Legacy/synthetic fixtures may use `providers` — tolerate but prefer `provider`
    providers: z.record(z.string(), ConfigProviderSchema).optional(),
  })
  .passthrough();

const CredentialsProviderSchema = z
  .object({
    apiKey: z.string().optional(),
  })
  .passthrough();

/**
 * Real ZCode credentials root: flat key-value map (NOT `providers` map).
 * Keys are credential identifiers like `oauth:zai:access_token`,
 * `oauth:active_provider`, `bot:*:credential`, etc.
 * We only extract `apiKey`-like entries if present under provider keys.
 * Also tolerate the legacy `providers` map shape.
 */
const CredentialsRootSchema = z
  .object({
    providers: z.record(z.string(), CredentialsProviderSchema).optional(),
  })
  .passthrough();

// =============================================================================
// Parsing
// =============================================================================

/**
 * Parse `config.json` + `credentials.json` into a structured catalog.
 *
 * Handles the real ZCode 0.16.1 config structure:
 *   - Root `provider` (singular, object map)
 *   - Each provider has `models` as an object map (NOT array)
 *   - Secrets live in `options.apiKey` or credentials
 *   - `enabled: false` or `systemDisabledReason` → provider unavailable
 *   - `source: "custom"` for user-configured providers
 *
 * @param configJson - Raw parsed `config.json` content (unknown).
 * @param credentialsJson - Raw parsed `credentials.json` content (unknown).
 * @returns Parsed providers, models, and composite-ID catalog with stable
 *   error codes.  Never contains raw secret values.
 */
export function parseZCodeConfig(
  configJson: unknown,
  credentialsJson: unknown,
): ZCodeConfigParseResult {
  const configResult = ConfigRootSchema.safeParse(configJson);
  if (!configResult.success) {
    return emptyResult("zcode_config_unavailable");
  }

  const credentialsResult = CredentialsRootSchema.safeParse(credentialsJson);
  // Credentials may be absent or empty — that's not a hard failure, it just
  // means providers relying on inline keys will be unavailable.
  const credentials = credentialsResult.success
    ? credentialsResult.data
    : { providers: {} };

  // Prefer real `provider` (singular), fall back to legacy `providers`.
  const configProviders =
    configResult.data.provider ?? configResult.data.providers ?? {};
  const credProviders = credentials.providers ?? {};

  const parsedProviders: ZCodeParsedProvider[] = [];
  const parsedModels: ZCodeParsedModel[] = [];
  const catalog: ZCodeModelCatalogEntry[] = [];

  for (const [providerKey, providerCfg] of Object.entries(configProviders)) {
    const providerId = providerKey;
    const kind = providerCfg.kind;
    const label = providerCfg.name;
    const options = providerCfg.options ?? {};
    const credentialApiKey = credProviders[providerKey]?.apiKey;
    const apiKeyValue =
      typeof options.apiKey === "string" && options.apiKey.length > 0
        ? options.apiKey
        : typeof credentialApiKey === "string" && credentialApiKey.length > 0
          ? credentialApiKey
          : undefined;
    const headers = normalizeRuntimeHeaders(options.headers);
    const enabled = providerCfg.enabled;
    const systemDisabledReason = providerCfg.systemDisabledReason;

    // Determine API key source and availability.
    const { source, hasSecret, unknownFieldCount } = analyzeSecret(
      providerKey,
      options,
      credProviders[providerKey],
    );

    const knownKind = KNOWN_PROVIDER_KINDS.has(kind as ZCodeProviderKind)
      ? (kind as ZCodeProviderKind)
      : null;

    // Unknown kind → provider is unavailable, models are not catalogued.
    if (!knownKind) {
      parsedProviders.push({
        id: providerId,
        label,
        kind: "openai-compatible", // placeholder; `available` is false
        apiKeySource: source,
        hasSecret: false,
        unknownFieldCount,
      });
      continue;
    }

    // Provider is disabled by the system → unavailable
    const isSystemDisabled =
      systemDisabledReason !== undefined && systemDisabledReason !== null;
    const isEnabled = enabled !== false && !isSystemDisabled;
    const isAvailable = hasSecret && isEnabled;

    parsedProviders.push({
      id: providerId,
      label,
      kind: knownKind,
      apiKeySource: source,
      hasSecret,
      unknownFieldCount,
      ...(systemDisabledReason ? { systemDisabledReason } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(apiKeyValue ? { apiKeyValue } : {}),
      ...(typeof options.baseURL === "string"
        ? { baseURL: options.baseURL }
        : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });

    // Catalog models with composite IDs.
    // Real ZCode uses `models` as an object map keyed by model ID.
    const modelsMap = providerCfg.models ?? {};
    for (const [modelId, modelCfg] of Object.entries(modelsMap)) {
      const compositeId = buildCompositeId(providerId, modelId);
      const modelLabel = modelCfg?.name;
      const { levels, defaultLevel } = extractThoughtLevels(
        modelCfg?.reasoning,
      );

      parsedModels.push({
        id: modelId,
        label: modelLabel,
        providerId,
      });

      const available = isAvailable;
      const unavailableReason: ZCodeErrorCode | undefined = available
        ? undefined
        : isSystemDisabled
          ? "zcode_model_unavailable"
          : !hasSecret
            ? "zcode_model_unavailable"
            : "zcode_model_unavailable";

      catalog.push({
        compositeId,
        providerId,
        modelId,
        providerLabel: label,
        modelLabel,
        available,
        unavailableReason,
        thoughtLevels: levels,
        ...(defaultLevel ? { defaultThoughtLevel: defaultLevel } : {}),
      });
    }
  }

  // If no providers were found at all, flag config as unavailable.
  if (parsedProviders.length === 0) {
    return emptyResult("zcode_config_unavailable");
  }

  return {
    providers: parsedProviders,
    models: parsedModels,
    catalog,
    errorCode: null,
  };
}

// =============================================================================
// Registry builder (for workspace/updateProviderRegistry)
// =============================================================================

/**
 * Build the protocol registry entries for `workspace/updateProviderRegistry`.
 *
 * Real ZCode 0.16.1 registry entry (verified by probing the app-server's
 * strict zod validation on 2026-08-13):
 *   - `providerId` (NOT `id`); no `name` key — the schema is `.strict()` and
 *     rejects it with "Unrecognized key".
 *   - `models` is REQUIRED and must contain >= 1 entry; each entry is exactly
 *     `{modelId}` — again no `name` key.
 *   - `kind`, `source`, `baseURL`, `headers` optional.
 *   - `apiKey`: discriminated union — `{source: "inline", value: <key>}`.
 *
 * Only available providers (hasSecret && enabled && >= 1 model) are included.
 *
 * Security: the apiKey value is included as `{source: "inline", value: ...}`
 * because the real CLI converts inline values to session secrets internally
 * (the readState echo shows `apiKeyRef: {source: "session-secret", ...}`).
 * The value is never logged, never returned to the client API, and only sent
 * to the app-server child process over stdio.
 */
export function buildZCodeProviderRegistry(
  parsed: ZCodeConfigParseResult,
): ZCodeProviderRegistryEntry[] {
  const entries: ZCodeProviderRegistryEntry[] = [];

  for (const provider of parsed.providers) {
    if (!provider.hasSecret) continue;
    // Skip system-disabled providers
    if (provider.systemDisabledReason || provider.enabled === false) continue;

    const models = parsed.models.filter((m) => m.providerId === provider.id);
    // The real schema requires `models` to be a non-empty array — a provider
    // without catalogued models would fail validation for the whole registry.
    if (models.length === 0) continue;

    entries.push({
      providerId: provider.id,
      kind: provider.kind,
      source: "custom",
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      ...(provider.apiKeyValue
        ? { apiKey: { source: "inline" as const, value: provider.apiKeyValue } }
        : {}),
      ...(provider.headers ? { headers: provider.headers } : {}),
      models: models.map((m) => ({ modelId: m.id })),
    });
  }

  return entries;
}

// =============================================================================
// Composite ID helpers
// =============================================================================

/**
 * Build a composite model ID: `providerId/modelId`.
 *
 * This is the only model identifier exposed to the client.  The server holds
 * a reverse map to resolve the original provider/model pair.
 */
export function buildCompositeId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/**
 * Resolve a composite ID back to its provider/model pair.
 * Returns `undefined` when the composite ID is not in the catalog.
 */
export function resolveZCodeCompositeModelId(
  catalog: readonly ZCodeModelCatalogEntry[],
  compositeId: string,
): ZCodeModelCatalogEntry | undefined {
  return catalog.find((entry) => entry.compositeId === compositeId);
}

/**
 * Build a `Map<string, ZCodeModelCatalogEntry>` for O(1) composite-ID lookup.
 */
export function buildZCodeCatalogMap(
  catalog: readonly ZCodeModelCatalogEntry[],
): Map<string, ZCodeModelCatalogEntry> {
  const map = new Map<string, ZCodeModelCatalogEntry>();
  for (const entry of catalog) {
    map.set(entry.compositeId, entry);
  }
  return map;
}

// =============================================================================
// Thought level (reasoning effort) resolution
// =============================================================================

/**
 * Resolve the `thoughtLevel` to send for a model.
 *
 * Mirrors the real CLI's own guard (`Iqn`/`wca`): a requested level is applied
 * only when the model advertises it, otherwise the request is dropped. Yep
 * drops it here instead of sending an unsupported value so the CLI does not
 * have to log a `thought_level_skipped` fallback for every turn.
 *
 * Returns `undefined` when the model has no thought levels, when nothing is
 * requested and the model declares no default, or when the requested level is
 * not advertised by this model.
 */
export function resolveZCodeThoughtLevel(
  entry: ZCodeModelCatalogEntry | undefined,
  preferred?: string | null,
): string | undefined {
  if (!entry || entry.thoughtLevels.length === 0) return undefined;
  const requested = preferred?.trim();
  if (requested) {
    return entry.thoughtLevels.includes(requested) ? requested : undefined;
  }
  return entry.defaultThoughtLevel;
}

// =============================================================================
// Secret analysis (never logs key values)
// =============================================================================

interface SecretAnalysis {
  source: ZCodeApiKeySource | null;
  hasSecret: boolean;
  unknownFieldCount: number;
}

/**
 * Determine the API key source and whether a usable secret exists.
 *
 * Real ZCode 0.16.1 stores secrets inside `options`:
 *   - `options.apiKey`: inline API key string
 *   - `options.apiKeyRequired`: boolean indicating if key is required
 *   - `options.headers`: runtime headers (e.g. Authorization)
 *   - Credentials file may also have provider-specific keys
 *
 * Priority: inline → credentials → runtime-headers.
 *
 * The actual key value is retained only in the server-side parsed provider so
 * the in-memory registry can authenticate; it is never logged or projected to
 * the client-facing catalog.
 */
function analyzeSecret(
  providerKey: string,
  options: z.infer<typeof ProviderOptionsSchema>,
  credProvider: z.infer<typeof CredentialsProviderSchema> | undefined,
): SecretAnalysis {
  void providerKey; // provider key not used for lookup in real credentials

  // Try inline first: options.apiKey
  const configKey = options.apiKey;
  if (typeof configKey === "string" && configKey.length > 0) {
    return { source: "inline", hasSecret: true, unknownFieldCount: 0 };
  }

  // Try credentials file for this provider
  const credKey = credProvider?.apiKey;
  if (typeof credKey === "string" && credKey.length > 0) {
    return { source: "inline", hasSecret: true, unknownFieldCount: 0 };
  }

  // Try runtime headers: options.headers present and non-empty
  if (Object.keys(normalizeRuntimeHeaders(options.headers)).length > 0) {
    return {
      source: "runtime-headers",
      hasSecret: true,
      unknownFieldCount: 0,
    };
  }

  // No secret source found.
  return { source: null, hasSecret: false, unknownFieldCount: 0 };
}

/** Keep only header values accepted by the app-server's strict registry. */
function normalizeRuntimeHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") normalized[name] = value;
  }
  return normalized;
}

// =============================================================================
// Helpers
// =============================================================================

function emptyResult(errorCode: ZCodeErrorCode): ZCodeConfigParseResult {
  return {
    providers: [],
    models: [],
    catalog: [],
    errorCode,
  };
}
