import type {
  ProviderName,
  SlashCommand,
  SlashCommandSource,
} from "@yep-anywhere/shared";

export type AgentCommandPrefix = "/" | "$";

/**
 * Codex `/` commands that actually do something in Yep. Codex parses every
 * other slash command inside its terminal UI; sent through app-server
 * `turn/start` the text would only reach the model as an ordinary prompt
 * (see `references/codex/codex-rs/tui/src/slash_command.rs`). Each entry here
 * is intercepted by Yep and mapped to an app-server control or a Yep feature.
 */
export const CODEX_SLASH_COMMANDS = [
  "compact",
  "model",
  "review",
  "goal",
  "side",
  "btw",
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

/** Menu descriptions for the commands Yep intercepts. */
export interface AgentCommandDescriptions {
  model: string;
  /** Pi compaction, which accepts guidance after the command. */
  compact: string;
  /** Codex compaction, which takes no arguments. */
  codexCompact: string;
  review: string;
  goal: string;
  side: string;
}

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

function mergeCommands(...commandGroups: readonly string[][]): string[] {
  return Array.from(new Set(commandGroups.flat().filter(Boolean)));
}

/**
 * Where the composer lives and what the session can currently do. Commands
 * are offered only when sending them would actually work.
 */
export interface AgentCommandAvailability {
  scope: "new-session" | "session";
  /** This server owns a live provider process for the session. */
  ownsProcess?: boolean;
  /** No process, but sending a message resumes the session. */
  canResume?: boolean;
  /** The provider offers Yep side conversations. */
  hasSideConversation?: boolean;
}

export interface AgentCommandCatalogInput {
  provider: ProviderName | string | undefined | null;
  supportsSlashCommands?: boolean;
  /** Provider-reported commands (init message, live list or cache). */
  providerCommands?: readonly SlashCommand[];
  /** Codex `$` skills. */
  codexSkills?: readonly { name: string; description?: string }[];
  availability: AgentCommandAvailability;
  labels?: AgentCommandLabels;
  descriptions?: Partial<AgentCommandDescriptions>;
}

type YepCommandName = "model" | "compact" | "review" | "goal" | "side" | "btw";

function yepCommandDescription(
  name: YepCommandName,
  descriptions: Partial<AgentCommandDescriptions> | undefined,
  codex: boolean,
): string | undefined {
  if (name === "btw") return descriptions?.side;
  if (name === "compact" && codex) return descriptions?.codexCompact;
  return descriptions?.[name];
}

/**
 * The single source for every composer command menu. New sessions and
 * replies share it so a provider shows the same commands everywhere, minus
 * the ones that need an existing session or a running process.
 */
export function buildAgentCommandCatalog({
  provider,
  supportsSlashCommands,
  providerCommands = [],
  codexSkills = [],
  availability,
  labels = DEFAULT_AGENT_COMMAND_LABELS,
  descriptions,
}: AgentCommandCatalogInput): AgentCommandConfig[] {
  const inSession = availability.scope === "session";
  const ownsProcess = inSession && availability.ownsProcess === true;
  const canSend = !inSession || ownsProcess || availability.canResume === true;
  const hasSide = inSession && availability.hasSideConversation === true;

  const yepCommands: YepCommandName[] = [];
  const addYep = (name: YepCommandName, enabled: boolean) => {
    if (enabled) yepCommands.push(name);
  };
  const sideCommands = (enabled: boolean) => {
    addYep("side", enabled);
    addYep("btw", enabled);
  };

  const yepDetails = (): Record<string, AgentCommandDetail> =>
    Object.fromEntries(
      yepCommands.map((name) => {
        const description = yepCommandDescription(
          name,
          descriptions,
          isCodexCommandProvider(provider),
        );
        return [
          name,
          {
            ...(description ? { description } : {}),
            source: "yep" as const,
          },
        ];
      }),
    );

  const slashGroup = (
    label: string,
    commands: string[],
  ): AgentCommandConfig => {
    const yepNames = new Set<string>(yepCommands);
    return {
      prefix: "/",
      label,
      showButton: commands.length > 0,
      commands,
      // Provider descriptions fill in their own commands; Yep's text wins for
      // the commands Yep intercepts, since that is what will happen.
      details: {
        ...buildSlashCommandDetails(
          providerCommands.filter((command) => !yepNames.has(command.name)),
        ),
        ...yepDetails(),
      },
    };
  };

  if (isCodexCommandProvider(provider)) {
    // Codex compaction can resume an idle session; the other controls need
    // the live app-server thread.
    addYep("compact", inSession && canSend);
    addYep("model", ownsProcess);
    addYep("review", ownsProcess);
    addYep("goal", ownsProcess);
    sideCommands(hasSide);
    const skillDetails = Object.fromEntries(
      codexSkills.flatMap((skill) =>
        skill.description
          ? [[skill.name, { description: skill.description }]]
          : [],
      ),
    );
    const skills = mergeCommands(codexSkills.map((skill) => skill.name));
    return [
      slashGroup(labels.codexCommands, [...yepCommands]),
      {
        prefix: "$",
        label: labels.skills,
        showButton: skills.length > 0,
        commands: skills,
        details: skillDetails,
      },
    ];
  }

  const live = canSend ? providerCommands.map((command) => command.name) : [];

  if (provider === "pi") {
    addYep("compact", ownsProcess);
    addYep("model", ownsProcess);
    sideCommands(hasSide);
    // Yep always intercepts these names for Pi, so a provider entry with the
    // same name must not reappear when the Yep version is unavailable.
    const intercepted = new Set(["compact", "model", "side", "btw"]);
    return [
      slashGroup(
        labels.slashCommands,
        mergeCommands(
          yepCommands,
          live.filter((name) => !intercepted.has(name)),
        ),
      ),
    ];
  }

  // MiniMax Code and Cursor report their built-ins and skills over ACP;
  // everything in that list is resolved by the agent itself.
  if (provider === "mcode" || provider === "cursor") {
    // Only MiniMax Code can switch models mid-session through Yep.
    addYep("model", provider === "mcode" && ownsProcess);
    return [slashGroup(labels.slashCommands, mergeCommands(yepCommands, live))];
  }

  const canUseSlashCommands =
    supportsSlashCommands ?? providerDefaultsToSlashCommands(provider);
  if (!canUseSlashCommands) {
    return [slashGroup(labels.slashCommands, [])];
  }

  addYep("model", ownsProcess);
  sideCommands(hasSide);
  return [
    slashGroup(
      labels.slashCommands,
      canSend ? mergeCommands(yepCommands, STATIC_SLASH_COMMANDS, live) : [],
    ),
  ];
}
