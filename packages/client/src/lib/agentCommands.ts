import type {
  ProviderName,
  SlashCommand,
  SlashCommandSource,
} from "@yep-anywhere/shared";

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

/**
 * Pi built-ins Yep handles itself. Pi's other TUI commands do nothing over
 * RPC, so they are not offered; extension commands, prompt templates and
 * skills come from the live `get_commands` list.
 */
export const PI_SLASH_COMMANDS = ["compact"];

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

/** Extra text a command menu shows next to a command name. */
export interface AgentCommandDetail {
  description?: string;
  /** Provider-reported origin, or "yep" for commands Yep handles itself. */
  source?: SlashCommandSource | "yep";
}

export interface AgentCommandConfig {
  prefix: AgentCommandPrefix;
  label: string;
  showButton: boolean;
  commands: string[];
  /** Optional per-command description/source, keyed by command name. */
  details?: Record<string, AgentCommandDetail>;
}

/**
 * Accept both the legacy init shape (`string[]`) and full provider entries
 * (`{ name, description, source }`), dropping anything unusable.
 */
export function normalizeSlashCommands(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];
  for (const item of value) {
    const record =
      typeof item === "string"
        ? { name: item }
        : item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : null;
    const name =
      typeof record?.name === "string"
        ? record.name.trim().replace(/^\//u, "")
        : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const source =
      record?.source === "extension" ||
      record?.source === "prompt" ||
      record?.source === "skill"
        ? record.source
        : undefined;
    commands.push({
      name,
      description:
        typeof record?.description === "string"
          ? record.description.trim()
          : "",
      ...(source ? { source } : {}),
    });
  }
  return commands;
}

/** Description/source lookup for the command menus. */
export function buildSlashCommandDetails(
  commands: readonly SlashCommand[],
): Record<string, AgentCommandDetail> {
  const details: Record<string, AgentCommandDetail> = {};
  for (const command of commands) {
    if (!command.description && !command.source) continue;
    details[command.name] = {
      ...(command.description ? { description: command.description } : {}),
      ...(command.source ? { source: command.source } : {}),
    };
  }
  return details;
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

  if (provider === "pi") {
    return [
      {
        prefix: "/",
        label: labels.slashCommands,
        showButton: true,
        commands: mergeCommands(PI_SLASH_COMMANDS, slashCommands),
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
