import type { PermissionMode, ProviderName } from "@yep-anywhere/shared";
import { useI18n } from "../i18n";

export interface ProviderPermissionModeConfig {
  labels: Record<PermissionMode, string>;
  descriptions: Record<PermissionMode, string>;
  title: string;
  description: string | null;
}

/**
 * Keep provider-native permission copy identical on the new-session form and
 * on an existing session's mode selector.
 */
export function useProviderPermissionModeConfig(
  provider: ProviderName | null | undefined,
): ProviderPermissionModeConfig {
  const { t } = useI18n();
  const genericLabels: Record<PermissionMode, string> = {
    auto: t("modeAutoLabel"),
    default: t("modeDefaultLabel"),
    acceptEdits: t("modeAcceptEditsLabel"),
    plan: t("modePlanLabel"),
    bypassPermissions: t("modeBypassPermissionsLabel"),
  };
  const genericDescriptions: Record<PermissionMode, string> = {
    auto: t("modeAutoDescription"),
    default: t("modeDefaultDescription"),
    acceptEdits: t("modeAcceptEditsDescription"),
    plan: t("modePlanDescription"),
    bypassPermissions: t("modeBypassPermissionsDescription"),
  };

  if (provider === "mcode") {
    return {
      labels: {
        ...genericLabels,
        default: t("modeMcodeDefaultLabel"),
        plan: t("modeMcodePlanLabel"),
        auto: t("modeMcodeAutoLabel"),
        bypassPermissions: t("modeMcodeFullAccessLabel"),
      },
      descriptions: {
        ...genericDescriptions,
        default: t("modeMcodeDefaultDescription"),
        plan: t("modeMcodePlanDescription"),
        auto: t("modeMcodeAutoDescription"),
        bypassPermissions: t("modeMcodeFullAccessDescription"),
      },
      title: t("newSessionMcodePermissionTitle"),
      description: t("newSessionMcodePermissionDescription"),
    };
  }

  if (provider === "cursor") {
    return {
      labels: {
        ...genericLabels,
        bypassPermissions: t("modeCursorAllowAllLabel"),
      },
      descriptions: {
        ...genericDescriptions,
        bypassPermissions: t("modeCursorAllowAllDescription"),
      },
      title: t("newSessionModeTitle"),
      description: null,
    };
  }

  if (provider === "codex") {
    return {
      labels: {
        ...genericLabels,
        auto: t("modeCodexCfLabel"),
        plan: t("modeCodexReadOnlyLabel"),
        bypassPermissions: t("modeCodexFullAccessLabel"),
      },
      descriptions: {
        ...genericDescriptions,
        auto: t("modeCodexCfDescription"),
        plan: t("modeCodexReadOnlyDescription"),
        bypassPermissions: t("modeCodexFullAccessDescription"),
      },
      title: t("newSessionCodexPermissionTitle"),
      description: t("newSessionCodexPermissionDescription"),
    };
  }

  // Pi has no native permission policy: Yep gates every Pi tool call itself
  // (see PiProvider's `respectProviderDecision: false` approval callback), and
  // Pi's `plan` mode is only a stricter approval gate — no plan prompt is
  // injected.
  if (provider === "pi") {
    return {
      labels: {
        ...genericLabels,
        default: t("modePiAskLabel"),
        acceptEdits: t("modePiEditLabel"),
        plan: t("modePiPlanLabel"),
        bypassPermissions: t("modePiAllowAllLabel"),
      },
      descriptions: {
        ...genericDescriptions,
        default: t("modePiAskDescription"),
        acceptEdits: t("modePiEditDescription"),
        plan: t("modePiPlanDescription"),
        bypassPermissions: t("modePiAllowAllDescription"),
      },
      title: t("newSessionPiPermissionTitle"),
      description: t("newSessionPiPermissionDescription"),
    };
  }

  if (provider === "gemini-acp") {
    return {
      labels: {
        ...genericLabels,
        default: t("modeGeminiAskLabel"),
        acceptEdits: t("modeGeminiEditLabel"),
        bypassPermissions: t("modeGeminiAllowAllLabel"),
      },
      descriptions: {
        ...genericDescriptions,
        default: t("modeGeminiAskDescription"),
        acceptEdits: t("modeGeminiEditDescription"),
        bypassPermissions: t("modeGeminiAllowAllDescription"),
      },
      title: t("newSessionGeminiPermissionTitle"),
      description: t("newSessionGeminiPermissionDescription"),
    };
  }

  if (provider === "claude" || provider === "claude-ollama") {
    return {
      labels: genericLabels,
      descriptions: genericDescriptions,
      title: t("newSessionClaudePermissionTitle"),
      description: t("newSessionClaudePermissionDescription"),
    };
  }

  return {
    labels: genericLabels,
    descriptions: genericDescriptions,
    title: t("newSessionModeTitle"),
    description: null,
  };
}
