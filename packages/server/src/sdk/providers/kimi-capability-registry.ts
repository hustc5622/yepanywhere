/**
 * Static model capability registry — mirrors Kimi Code CLI's
 * `capability-registry.ts` so we can detect image support for known vision
 * models without running `kimi acp`.
 *
 * Kimi resolves capabilities as `declared ∪ detected` (union semantics):
 * `image_in = declared.has('image_in') || detected.image_in`. Declared
 * capabilities come from `config.toml` `[models."X"].capabilities` or the
 * `KIMI_MODEL_CAPABILITIES` env overlay; detected capabilities come from
 * this static prefix table keyed by `(provider wire type, model id)`.
 *
 * The `models.dev` dynamic catalog and OAuth managed registries also feed
 * capabilities, but they flatten their results back into the declared layer
 * (they write to `config.toml`), so they are not reproduced here. This
 * static table is the fallback that runs at runtime when no explicit
 * declaration exists.
 *
 * Reference: references/kimi-code/packages/kosong/src/providers/capability-registry.ts
 *            references/kimi-code/packages/kosong/src/providers/index.ts
 */

/** Provider wire types that have a static capability catalog. */
export type KimiProviderType =
  | "anthropic"
  | "openai"
  | "openai_responses"
  | "google-genai"
  | "vertexai"
  | "kimi";

/** Minimal capability shape — only the fields we care about for image gating. */
export interface KimiDetectedCapability {
  readonly image_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
}

/** Sentinel for "no catalog entry knows this model". */
const UNKNOWN_CAPABILITY: KimiDetectedCapability = Object.freeze({
  image_in: false,
  thinking: false,
  tool_use: false,
});

interface CapabilityCatalogEntry {
  readonly matches: (normalizedModelName: string) => boolean;
  readonly capability: KimiDetectedCapability;
}

// --- Prefix lists (kept in sync with Kimi's capability-registry.ts) ---

const OPENAI_VISION_TOOL_PREFIXES = [
  "gpt-4o",
  "gpt-4-turbo",
  "gpt-4.1",
  "gpt-4.5",
] as const;

const CLAUDE_VISION_TOOL_PREFIXES = [
  "claude-3-",
  "claude-3.5-",
  "claude-3.7-",
] as const;

const CLAUDE_THINKING_VISION_TOOL_PREFIXES = [
  "claude-opus-4",
  "claude-sonnet-4",
  "claude-haiku-4",
  "claude-fable",
] as const;

const GEMINI_CATALOGUED_PREFIXES = [
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-pro",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
] as const;

// --- Frozen capability objects ---

const OPENAI_REASONING_CAPABILITY: KimiDetectedCapability = Object.freeze({
  image_in: false,
  thinking: true,
  tool_use: true,
});

const OPENAI_VISION_TOOL_CAPABILITY: KimiDetectedCapability = Object.freeze({
  image_in: true,
  thinking: false,
  tool_use: true,
});

const OPENAI_TEXT_TOOL_CAPABILITY: KimiDetectedCapability = Object.freeze({
  image_in: false,
  thinking: false,
  tool_use: true,
});

const ANTHROPIC_VISION_TOOL_CAPABILITY: KimiDetectedCapability = Object.freeze({
  image_in: true,
  thinking: false,
  tool_use: true,
});

const ANTHROPIC_THINKING_VISION_TOOL_CAPABILITY: KimiDetectedCapability =
  Object.freeze({
    image_in: true,
    thinking: true,
    tool_use: true,
  });

const GEMINI_MULTIMODAL_TOOL_CAPABILITY: KimiDetectedCapability = Object.freeze(
  {
    image_in: true,
    thinking: false,
    tool_use: true,
  },
);

const GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY: KimiDetectedCapability =
  Object.freeze({
    image_in: true,
    thinking: true,
    tool_use: true,
  });

// --- Catalogs (ordered — first match wins) ---

const OPENAI_LEGACY_CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
  {
    matches: isOpenAIReasoningModel,
    capability: OPENAI_REASONING_CAPABILITY,
  },
  {
    matches: (name) => hasPrefix(name, OPENAI_VISION_TOOL_PREFIXES),
    capability: OPENAI_VISION_TOOL_CAPABILITY,
  },
  {
    matches: (name) => name.startsWith("gpt-3.5-turbo"),
    capability: OPENAI_TEXT_TOOL_CAPABILITY,
  },
];

const OPENAI_RESPONSES_CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
  {
    matches: isOpenAIReasoningModel,
    capability: OPENAI_REASONING_CAPABILITY,
  },
  {
    matches: (name) => hasPrefix(name, OPENAI_VISION_TOOL_PREFIXES),
    capability: OPENAI_VISION_TOOL_CAPABILITY,
  },
];

const ANTHROPIC_CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
  {
    matches: (name) => hasPrefix(name, CLAUDE_VISION_TOOL_PREFIXES),
    capability: ANTHROPIC_VISION_TOOL_CAPABILITY,
  },
  {
    matches: (name) => hasPrefix(name, CLAUDE_THINKING_VISION_TOOL_PREFIXES),
    capability: ANTHROPIC_THINKING_VISION_TOOL_CAPABILITY,
  },
];

// --- Helpers ---

function normalizeModelName(modelName: string): string {
  return modelName.toLowerCase();
}

function hasPrefix(modelName: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => modelName.startsWith(prefix));
}

function isOpenAIReasoningModel(modelName: string): boolean {
  return /^o\d/.test(modelName);
}

function capabilityFromCatalog(
  modelName: string,
  catalog: readonly CapabilityCatalogEntry[],
): KimiDetectedCapability {
  const normalized = normalizeModelName(modelName);
  for (const entry of catalog) {
    if (entry.matches(normalized)) {
      return entry.capability;
    }
  }
  return UNKNOWN_CAPABILITY;
}

// --- Per-provider entry points (same dispatch as Kimi's getModelCapability) ---

function getOpenAILegacyModelCapability(
  modelName: string,
): KimiDetectedCapability {
  return capabilityFromCatalog(modelName, OPENAI_LEGACY_CAPABILITY_CATALOG);
}

function getOpenAIResponsesModelCapability(
  modelName: string,
): KimiDetectedCapability {
  return capabilityFromCatalog(modelName, OPENAI_RESPONSES_CAPABILITY_CATALOG);
}

function getAnthropicModelCapability(
  modelName: string,
): KimiDetectedCapability {
  return capabilityFromCatalog(modelName, ANTHROPIC_CAPABILITY_CATALOG);
}

function getGoogleGenAIModelCapability(
  modelName: string,
): KimiDetectedCapability {
  const normalized = normalizeModelName(modelName);
  if (!normalized.startsWith("gemini-")) return UNKNOWN_CAPABILITY;
  if (!hasPrefix(normalized, GEMINI_CATALOGUED_PREFIXES))
    return UNKNOWN_CAPABILITY;

  if (normalized.startsWith("gemini-2.5-") || normalized.includes("thinking")) {
    return GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY;
  }
  return GEMINI_MULTIMODAL_TOOL_CAPABILITY;
}

/**
 * Look up the detected capability for a `(provider wire type, model id)` pair.
 *
 * Mirrors Kimi's `getModelCapability` dispatch: a pure static table lookup
 * that does not instantiate a provider. Unknown / uncatalogued models (and
 * the Kimi wire, whose capabilities come from the host's catalog/config
 * rather than the model name) return `UNKNOWN_CAPABILITY`.
 *
 * Reference: references/kimi-code/packages/kosong/src/providers/index.ts:54
 */
export function getKimiModelCapability(
  wire: KimiProviderType,
  modelName: string,
): KimiDetectedCapability {
  switch (wire) {
    case "anthropic":
      return getAnthropicModelCapability(modelName);
    case "openai":
      return getOpenAILegacyModelCapability(modelName);
    case "openai_responses":
      return getOpenAIResponsesModelCapability(modelName);
    case "google-genai":
    case "vertexai":
      return getGoogleGenAIModelCapability(modelName);
    case "kimi":
      return UNKNOWN_CAPABILITY;
    default: {
      const exhaustive: never = wire;
      void exhaustive;
      return UNKNOWN_CAPABILITY;
    }
  }
}

/**
 * Whether a detected capability is the UNKNOWN sentinel (no catalog entry
 * knew the model). Used to distinguish "catalog says image_in: false"
 * (authoritative negative) from "catalog has no info" (unknown).
 */
export function isUnknownDetectedCapability(
  capability: KimiDetectedCapability,
): boolean {
  return !capability.image_in && !capability.thinking && !capability.tool_use;
}
