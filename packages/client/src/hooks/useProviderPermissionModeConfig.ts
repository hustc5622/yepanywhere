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

  if (provider === "kimi") {
    return {
      labels: {
        ...genericLabels,
        default: t("modeKimiDefaultLabel"),
        plan: t("modeKimiPlanLabel"),
        auto: t("modeKimiAutoLabel"),
        bypassPermissions: t("modeKimiYoloLabel"),
      },
      descriptions: {
        ...genericDescriptions,
        default: t("modeKimiDefaultDescription"),
        plan: t("modeKimiPlanDescription"),
        auto: t("modeKimiAutoDescription"),
        bypassPermissions: t("modeKimiYoloDescription"),
      },
      title: t("newSessionKimiPermissionTitle"),
      description: t("newSessionKimiPermissionDescription"),
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

  if (provider === "opencode") {
    return {
      labels: {
        ...genericLabels,
        default: t("modeOpenCodeAskLabel"),
        acceptEdits: t("modeOpenCodeEditLabel"),
        bypassPermissions: t("modeOpenCodeAllowAllLabel"),
      },
      descriptions: {
        ...genericDescriptions,
        default: t("modeOpenCodeAskDescription"),
        acceptEdits: t("modeOpenCodeEditDescription"),
        bypassPermissions: t("modeOpenCodeAllowAllDescription"),
      },
      title: t("newSessionOpenCodePermissionTitle"),
      description: t("newSessionOpenCodePermissionDescription"),
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
