/**
 * Capability metadata for gateway models Yep registers with Pi dynamically.
 *
 * Pi's built-in catalog is generated with per-model quirks (see
 * `references/pi/packages/ai/scripts/generate-models.ts`), but a model Yep
 * registers at runtime starts with none of them. That is not cosmetic: current
 * Claude releases reject the legacy budget-based thinking payload outright with
 *
 *   400 "thinking.type.enabled" is not supported for this model. Use
 *       "thinking.type.adaptive" and "output_config.effort" ...
 *
 * because `anthropic-messages` only emits the adaptive shape when the model
 * carries `compat.forceAdaptiveThinking`. The rules below mirror upstream's
 * `isAnthropicAdaptiveThinkingModel`, `isAnthropicTemperatureUnsupportedModel`
 * and its adaptive-effort level maps, keyed on the same substrings so both
 * `claude-opus-4-8` and `claude-opus-4.8` style ids match.
 */

/** Thinking levels Pi understands, mapped to a provider effort or disabled. */
export type PiThinkingLevelMap = Record<string, string | null>;

export interface PiAnthropicModelTraits {
  compat?: {
    forceAdaptiveThinking?: true;
    supportsTemperature?: false;
  };
  thinkingLevelMap?: PiThinkingLevelMap;
}

function hasVersion(id: string, family: string, version: string): boolean {
  return (
    id.includes(`${family}-${version.replace(".", "-")}`) ||
    id.includes(`${family}-${version}`)
  );
}

/** Claude releases that require the adaptive thinking payload. */
function isAdaptiveThinkingModel(id: string): boolean {
  return (
    hasVersion(id, "opus", "4.6") ||
    hasVersion(id, "opus", "4.7") ||
    hasVersion(id, "opus", "4.8") ||
    id.includes("opus-5") ||
    id.includes("opus.5") ||
    hasVersion(id, "sonnet", "4.6") ||
    id.includes("sonnet-5") ||
    id.includes("sonnet.5") ||
    id.includes("fable-5")
  );
}

function isTemperatureUnsupportedModel(id: string): boolean {
  return (
    hasVersion(id, "opus", "4.7") ||
    hasVersion(id, "opus", "4.8") ||
    id.includes("opus-5") ||
    id.includes("opus.5")
  );
}

/**
 * Resolve the traits for one bare gateway model id.
 *
 * Effort availability follows Anthropic's adaptive-thinking documentation as
 * encoded upstream: `max` on every adaptive model, `xhigh` only on Opus
 * 4.7/4.8/5, Sonnet 5 and Fable 5. Fable 5 additionally cannot disable
 * thinking, which upstream expresses as `off: null` \u2014 without it Pi would send
 * `thinking: { type: "disabled" }` for a model that rejects it.
 */
export function piAnthropicModelTraits(
  bareModelId: string,
): PiAnthropicModelTraits {
  const id = bareModelId.toLowerCase();
  if (!isAdaptiveThinkingModel(id)) return {};

  const supportsXhigh =
    hasVersion(id, "opus", "4.7") ||
    hasVersion(id, "opus", "4.8") ||
    id.includes("opus-5") ||
    id.includes("opus.5") ||
    id.includes("sonnet-5") ||
    id.includes("sonnet.5") ||
    id.includes("fable-5");

  const thinkingLevelMap: PiThinkingLevelMap = {
    max: "max",
    ...(supportsXhigh ? { xhigh: "xhigh" } : {}),
    ...(id.includes("fable-5") ? { off: null } : {}),
  };

  return {
    compat: {
      forceAdaptiveThinking: true,
      ...(isTemperatureUnsupportedModel(id)
        ? { supportsTemperature: false as const }
        : {}),
    },
    thinkingLevelMap,
  };
}
