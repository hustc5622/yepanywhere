import type { ProviderName } from "@yep-anywhere/shared";

/**
 * Resolve the model token sent by the client into the provider-facing value.
 *
 * Claude's model catalog presents `default` as Sonnet 5, so make that choice
 * explicit instead of inheriting a potentially different model from the
 * remote VM's user settings. Other providers retain their native default.
 */
export function resolveSessionModel(
  model: string | undefined,
  provider: ProviderName | undefined,
): string | undefined {
  if (model !== "default") return model;
  return provider === "claude" ? "sonnet" : undefined;
}
