import type {
  ProviderName,
  SlashCommand,
  SlashCommandSource,
} from "@yep-anywhere/shared";
import {
  CODEX_CLI_SLASH_COMMANDS,
  CODEX_FAST_SLASH_COMMAND,
  type CliSlashCommand,
  PI_CLI_SLASH_COMMANDS,
  YEP_EXTRA_PI_COMMANDS,
  YEP_HANDLED_CODEX_COMMANDS,
  YEP_HANDLED_PI_COMMANDS,
} from "./cliSlashCommands";

export type AgentCommandPrefix = "/" | "$";

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
  /**
   * Provider-reported origin, "yep" for commands Yep runs itself, or
   * "terminal" for CLI built-ins that only work in the provider's terminal.
   */
  source?: SlashCommandSource | "yep" | "terminal";
}

export interface AgentCommandConfig {
  prefix: AgentCommandPrefix;
  label: string;
  showButton: boolean;
  commands: string[];
  /** Optional per-command description/source, keyed by command name. */
  details?: Record<string, AgentCommandDetail>;
  /**
   * Commands left out of the unfiltered list but matched once a prefix is
   * typed, like the Codex TUI's `/quit` and `/btw` aliases.
   */
  typedOnly?: readonly string[];
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
  /** `/fast` before a session starts toggles the Fast service tier. */
  fast: string;
  goal: string;
  /** `/goal` before a session exists: starts the session on the goal. */
  goalNewSession: string;
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
  /**
   * The Codex model offers the Fast service tier, so the CLI lists `/fast`
   * after `/model`. Yep toggles it before a session starts; mid-session the
   * tier only changes in the terminal.
   */
  codexFastMode?: boolean;
  availability: AgentCommandAvailability;
  labels?: AgentCommandLabels;
  descriptions?: Partial<AgentCommandDescriptions>;
}

type YepCommandName = "model" | "compact" | "review" | "goal" | "side" | "btw";

function yepCommandDescription(
  name: YepCommandName,
  descriptions: Partial<AgentCommandDescriptions> | undefined,
  codex: boolean,
  inSession: boolean,
): string | undefined {
  if (name === "btw") return descriptions?.side;
  if (name === "compact" && codex) return descriptions?.codexCompact;
  if (name === "goal" && !inSession) return descriptions?.goalNewSession;
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
  codexFastMode = false,
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
          inSession,
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

  // Codex and Pi show exactly their CLI's `/` picker. Yep runs the commands
  // it can (`yep`); the rest are terminal UI features (`terminal`) that Yep
  // lists for parity and refuses to send as prompt text.
  const cliDetails = (
    commands: readonly CliSlashCommand[],
    handled: ReadonlySet<string>,
  ): Record<string, AgentCommandDetail> =>
    Object.fromEntries(
      commands.map((command) => {
        if (!handled.has(command.name)) {
          return [
            command.name,
            { description: command.description, source: "terminal" as const },
          ];
        }
        const description = yepCommandDescription(
          command.name as YepCommandName,
          descriptions,
          isCodexCommandProvider(provider),
          inSession,
        );
        return [
          command.name,
          { description: description ?? command.description, source: "yep" },
        ];
      }),
    );

  if (isCodexCommandProvider(provider)) {
    const cli = codexFastMode
      ? CODEX_CLI_SLASH_COMMANDS.flatMap((command) =>
          command.name === "model"
            ? [command, CODEX_FAST_SLASH_COMMAND]
            : [command],
        )
      : CODEX_CLI_SLASH_COMMANDS;
    const commands = cli
      .filter((command) => command.picker !== "hidden")
      .map((command) => command.name);
    const typedOnly = cli
      .filter((command) => command.picker === "typed")
      .map((command) => command.name);
    const fastDetail: Record<string, AgentCommandDetail> =
      codexFastMode && !inSession
        ? {
            fast: {
              description:
                descriptions?.fast ?? CODEX_FAST_SLASH_COMMAND.description,
              source: "yep",
            },
          }
        : {};
    const skillDetails = Object.fromEntries(
      codexSkills.flatMap((skill) =>
        skill.description
          ? [[skill.name, { description: skill.description }]]
          : [],
      ),
    );
    const skills = mergeCommands(codexSkills.map((skill) => skill.name));
    return [
      {
        prefix: "/",
        label: labels.codexCommands,
        showButton: commands.length > 0,
        commands,
        typedOnly,
        details: {
          ...cliDetails(cli, YEP_HANDLED_CODEX_COMMANDS),
          ...fastDetail,
        },
      },
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
    // Pi's order: built-ins, then prompt templates, extension commands and
    // skills (Pi skips extension names that collide with a built-in), then
    // Yep's side conversation.
    const builtins = PI_CLI_SLASH_COMMANDS.map((command) => command.name);
    const builtinNames = new Set<string>(builtins);
    const sourceRank = new Map(
      providerCommands.map((command) => [
        command.name,
        command.source === "prompt" ? 0 : command.source === "skill" ? 2 : 1,
      ]),
    );
    const reported = live
      .filter((name) => !builtinNames.has(name))
      .map((name, index) => ({ name, index }))
      .sort(
        (a, b) =>
          (sourceRank.get(a.name) ?? 1) - (sourceRank.get(b.name) ?? 1) ||
          a.index - b.index,
      )
      .map(({ name }) => name);
    const extras = YEP_EXTRA_PI_COMMANDS.filter(
      (name) => !reported.includes(name),
    );
    const commands = mergeCommands(builtins, reported, [...extras]);
    return [
      {
        prefix: "/",
        label: labels.slashCommands,
        showButton: commands.length > 0,
        commands,
        details: {
          ...buildSlashCommandDetails(
            providerCommands.filter(
              (command) => !builtinNames.has(command.name),
            ),
          ),
          ...cliDetails(PI_CLI_SLASH_COMMANDS, YEP_HANDLED_PI_COMMANDS),
          ...Object.fromEntries(
            extras.map((name) => [
              name,
              {
                ...(descriptions?.side
                  ? { description: descriptions.side }
                  : {}),
                source: "yep" as const,
              },
            ]),
          ),
        },
      },
    ];
  }

  // MiniMax Code, Antigravity and Cursor report their built-ins and skills
  // over ACP; everything in that list is resolved by the agent itself.
  if (provider === "mcode" || provider === "cursor" || provider === "agy") {
    // MiniMax Code and Antigravity can switch models mid-session through Yep.
    addYep(
      "model",
      (provider === "mcode" || provider === "agy") && ownsProcess,
    );
    // Antigravity side conversations run in a separate `agy acp`.
    sideCommands(provider === "agy" && hasSide);
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
