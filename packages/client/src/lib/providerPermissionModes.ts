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
  // ZCode's native `auto` denies every tool call, so it is not offered.
  // The remaining four map 1:1 onto build/edit/plan/yolo.
  zcode: ["default", "acceptEdits", "plan", "bypassPermissions"],
  // Kimi's ACP modes are default/manual, plan, auto, and yolo. The shared
  // bypassPermissions value is presented as YOLO by Kimi-specific UI.
  kimi: ["default", "plan", "auto", "bypassPermissions"],
};

const PROVIDER_DEFAULT_PERMISSION_MODES: Partial<
  Record<ProviderName, PermissionMode>
> = {
  // Never make Kimi's fully autonomous `auto` mode the implicit default.
  kimi: "default",
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
  const requestedMode =
    mode ??
    (provider ? PROVIDER_DEFAULT_PERMISSION_MODES[provider] : undefined) ??
    DEFAULT_PERMISSION_MODE;
  if (modes.includes(requestedMode)) return requestedMode;
  return modes[0] ?? requestedMode;
}
