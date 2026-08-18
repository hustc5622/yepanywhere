import type { ProviderName } from "@yep-anywhere/shared";

const RETIRED_PROVIDER_NAMES = new Set(["opencode"]);
const LIVE_PROVIDER_NAMES = new Set([
  "claude",
  "claude-ollama",
  "codex",
  "codex-oss",
  "gemini",
  "gemini-acp",
  "pi",
  "kimi",
  "zcode",
]);

export function isRetiredProviderName(value: unknown): value is "opencode" {
  return typeof value === "string" && RETIRED_PROVIDER_NAMES.has(value);
}

export function isLiveProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && LIVE_PROVIDER_NAMES.has(value);
}

export function isProviderEnabled(
  provider: string,
  enabledProviders: readonly string[] | undefined,
): boolean {
  if (!isLiveProviderName(provider)) return false;
  return !enabledProviders?.length || enabledProviders.includes(provider);
}
