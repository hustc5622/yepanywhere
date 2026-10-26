import { useI18n } from "../i18n";
import type { AgentCommandDetail } from "../lib/agentCommands";

interface CommandMenuItemContentProps {
  prefix: string;
  command: string;
  detail?: AgentCommandDetail;
}

/**
 * Name, origin tag and one-line description of a command menu entry, so the
 * list reads like the provider's own `/` picker (e.g. Pi's terminal list).
 */
export function CommandMenuItemContent({
  prefix,
  command,
  detail,
}: CommandMenuItemContentProps) {
  const { t } = useI18n();
  const sourceLabel =
    detail?.source === "extension"
      ? t("slashCommandSourceExtension")
      : detail?.source === "prompt"
        ? t("slashCommandSourcePrompt")
        : detail?.source === "skill"
          ? t("slashCommandSourceSkill")
          : detail?.source === "yep"
            ? t("slashCommandSourceYep")
            : null;
  return (
    <>
      <span className="command-menu-item-header">
        <span className="command-completion-name">
          {prefix}
          {command}
        </span>
        {sourceLabel && (
          <span className="command-menu-item-source">{sourceLabel}</span>
        )}
      </span>
      {detail?.description && (
        <span className="command-menu-item-description">
          {detail.description}
        </span>
      )}
    </>
  );
}
