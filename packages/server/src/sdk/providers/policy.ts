import type { ProviderName } from "@yep-anywhere/shared";

/** Providers removed from Yep whose names may still appear in persisted state. */
export type RetiredProviderName = "opencode" | "zcode";

const RETIRED_PROVIDER_NAMES = new Set<string>(["opencode", "zcode"]);
const RETIRED_PROVIDER_LABELS: Record<RetiredProviderName, string> = {
  opencode: "OpenCode",
  zcode: "ZCode",
};
const LIVE_PROVIDER_NAMES = new Set([
  "claude",
  "claude-ollama",
  "codex",
  "codex-oss",
  "gemini",
  "gemini-acp",
  "pi",
  "kimi",
  "cursor",
  "mcode",
  "dsh",
]);

export function isRetiredProviderName(
  value: unknown,
): value is RetiredProviderName {
  return typeof value === "string" && RETIRED_PROVIDER_NAMES.has(value);
}

/** User-facing error for requests that target a retired provider. */
export function retiredProviderMessage(provider: RetiredProviderName): string {
  return `${RETIRED_PROVIDER_LABELS[provider]} provider has been retired`;
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
