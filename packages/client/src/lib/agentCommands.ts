import type { ProviderName } from "@yep-anywhere/shared";

export type AgentCommandPrefix = "/" | "$";

export const CODEX_SLASH_COMMANDS = [
  "permissions",
  "ide",
  "keymap",
  "vim",
  "sandbox-add-read-dir",
  "agent",
  "apps",
  "plugins",
  "hooks",
  "clear",
  "archive",
  "delete",
  "compact",
  "copy",
  "diff",
  "exit",
  "experimental",
  "approve",
  "memories",
  "skills",
  "import",
  "feedback",
  "init",
  "logout",
  "mcp",
  "mention",
  "model",
  "fast",
  "plan",
  "goal",
  "personality",
  "ps",
  "stop",
  "fork",
  "side",
  "btw",
  "raw",
  "resume",
  "new",
  "quit",
  "review",
  "status",
  "usage",
  "debug-config",
  "statusline",
  "title",
  "theme",
];

export const STATIC_SLASH_COMMANDS = [
  "help",
  "status",
  "model",
  "permissions",
  "clear",
  "compact",
  "resume",
  "init",
  "memory",
  "mcp",
  "agents",
  "add-dir",
  "config",
  "cost",
  "doctor",
  "ide",
  "login",
  "logout",
  "review",
  "vim",
];

export interface AgentCommandConfig {
  prefix: AgentCommandPrefix;
  label: string;
  showButton: boolean;
  commands: string[];
}

export interface AgentCommandLabels {
  codexCommands: string;
  skills: string;
  slashCommands: string;
}

const DEFAULT_AGENT_COMMAND_LABELS: AgentCommandLabels = {
  codexCommands: "Codex commands",
  skills: "Skills",
  slashCommands: "Slash commands",
};

export function isCodexCommandProvider(
  provider: ProviderName | string | undefined | null,
): provider is "codex" | "codex-oss" {
  return provider === "codex" || provider === "codex-oss";
}

export function providerDefaultsToSlashCommands(
  provider: ProviderName | string | undefined | null,
): boolean {
  return provider === "claude" || provider === "claude-ollama";
}

function mergeCommands(...commandGroups: string[][]): string[] {
  return Array.from(new Set(commandGroups.flat().filter(Boolean)));
}

export function getAgentCommandConfigs(
  provider: ProviderName | string | undefined | null,
  supportsSlashCommands?: boolean,
  slashCommands: string[] = [],
  codexSkills: string[] = [],
  labels: AgentCommandLabels = DEFAULT_AGENT_COMMAND_LABELS,
): AgentCommandConfig[] {
  if (isCodexCommandProvider(provider)) {
    return [
      {
        prefix: "/",
        label: labels.codexCommands,
        showButton: true,
        commands: CODEX_SLASH_COMMANDS,
      },
      {
        prefix: "$",
        label: labels.skills,
        showButton: true,
        commands: mergeCommands(codexSkills),
      },
    ];
  }

  const canUseSlashCommands =
    supportsSlashCommands ?? providerDefaultsToSlashCommands(provider);

  return [
    {
      prefix: "/",
      label: labels.slashCommands,
      showButton: canUseSlashCommands,
      commands: canUseSlashCommands
        ? mergeCommands(STATIC_SLASH_COMMANDS, slashCommands)
        : [],
    },
  ];
}

export function getStaticAgentCommandConfigs(
  slashCommands: string[] = [],
): AgentCommandConfig[] {
  return getAgentCommandConfigs("claude", true, slashCommands);
}

export function getAgentCommandConfig(
  provider: ProviderName | string | undefined | null,
  supportsSlashCommands?: boolean,
  slashCommands: string[] = [],
): AgentCommandConfig {
  return getAgentCommandConfigs(
    provider,
    supportsSlashCommands,
    slashCommands,
  )[0] as AgentCommandConfig;
}
