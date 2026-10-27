import { useMemo } from "react";
import { useI18n } from "../i18n";
import {
  type AgentCommandCatalogInput,
  type AgentCommandConfig,
  buildAgentCommandCatalog,
} from "../lib/agentCommands";

type CatalogOptions = Omit<AgentCommandCatalogInput, "labels" | "descriptions">;

/** Localized command menus shared by every composer. */
export function useAgentCommandCatalog({
  provider,
  supportsSlashCommands,
  providerCommands,
  codexSkills,
  availability,
}: CatalogOptions): AgentCommandConfig[] {
  const { t } = useI18n();
  const { scope, ownsProcess, canResume, hasSideConversation } = availability;
  return useMemo(
    () =>
      buildAgentCommandCatalog({
        provider,
        supportsSlashCommands,
        providerCommands,
        codexSkills,
        availability: { scope, ownsProcess, canResume, hasSideConversation },
        labels: {
          codexCommands: t("codexCommandsLabel"),
          skills: t("codexSkillsLabel"),
          slashCommands: t("slashCommandsLabel"),
        },
        descriptions: {
          model: t("slashCommandModelDescription"),
          compact: t("slashCommandCompactDescription"),
          codexCompact: t("slashCommandCodexCompactDescription"),
          review: t("slashCommandReviewDescription"),
          goal: t("slashCommandGoalDescription"),
          side: t("slashCommandSideDescription"),
        },
      }),
    [
      provider,
      supportsSlashCommands,
      providerCommands,
      codexSkills,
      scope,
      ownsProcess,
      canResume,
      hasSideConversation,
      t,
    ],
  );
}
