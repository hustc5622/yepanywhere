import {
  ALL_PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  type ProviderName,
} from "@yep-anywhere/shared";

/**
 * Compatibility fallback for servers that predate provider-advertised modes.
 * Keep these lists limited to policies with observably different behavior.
 */
const FALLBACK_PERMISSION_MODES: Partial<
  Record<ProviderName, readonly PermissionMode[]>
> = {
  claude: ALL_PERMISSION_MODES,
  "claude-ollama": ALL_PERMISSION_MODES,
  codex: ["auto", "plan", "bypassPermissions"],
  opencode: ["default", "acceptEdits", "bypassPermissions"],
  "gemini-acp": ["default", "acceptEdits", "bypassPermissions"],
};

export function getProviderPermissionModes(
  provider: ProviderName | null | undefined,
  advertisedModes?: readonly PermissionMode[],
): readonly PermissionMode[] {
  if (advertisedModes) return advertisedModes;
  if (!provider) return ALL_PERMISSION_MODES;
  return FALLBACK_PERMISSION_MODES[provider] ?? ALL_PERMISSION_MODES;
}

export function normalizeProviderPermissionMode(
  provider: ProviderName | null | undefined,
  mode: PermissionMode | undefined,
  advertisedModes?: readonly PermissionMode[],
): PermissionMode {
  const modes = getProviderPermissionModes(provider, advertisedModes);
  const requestedMode = mode ?? DEFAULT_PERMISSION_MODE;
  if (modes.includes(requestedMode)) return requestedMode;
  return modes[0] ?? requestedMode;
}
