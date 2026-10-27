import type {
  AgentCommandListing,
  AgentSkill,
  SlashCommand,
} from "@yep-anywhere/shared";
import { readPiCommandCache } from "../sdk/providers/pi-command-cache.js";
import { CodexSkillsLister, parseCodexSkillsResponse } from "./codex-skills.js";
import { readAgentCommandCache } from "./command-cache.js";
import { type SkillScanProvider, scanSkills } from "./skill-scanner.js";

/**
 * How each provider invokes a skill typed in the composer:
 * - Codex: `$name`, sent as a structured `skill` input (needs `path`).
 * - Pi: `/skill:name`, expanded by Pi.
 * - MiniMax Code, Cursor: `/name`, resolved by the agent.
 */
export const SKILL_COMMAND_PREFIX: Partial<Record<string, string>> = {
  pi: "skill:",
  mcode: "",
  cursor: "",
};

export interface AgentCommandSources {
  /** `/` list from the session's running process, when there is one. */
  liveCommands?: () => Promise<SlashCommand[] | null>;
  /** Raw `skills/list` result from the session's Codex process. */
  liveCodexSkills?: () => Promise<unknown>;
}

export interface AgentCommandServiceOptions {
  codexSkills?: Pick<CodexSkillsLister, "list">;
  scan?: (provider: SkillScanProvider, cwd: string) => Promise<AgentSkill[]>;
  readPiCache?: (cwd: string) => Promise<SlashCommand[] | null>;
  readAcpCache?: (
    provider: string,
    cwd: string,
  ) => Promise<SlashCommand[] | null>;
  scanTtlMs?: number;
}

function none(provider: string): AgentCommandListing {
  return { provider, origin: "none", commands: [], skills: [] };
}

/**
 * The single place that decides which commands and skills a composer can
 * offer for a provider in a project: the running process first, then the
 * provider's last report for the directory, then a scan of its skill roots.
 */
export class AgentCommandService {
  private readonly codexSkills: Pick<CodexSkillsLister, "list">;
  private readonly scanImpl: NonNullable<AgentCommandServiceOptions["scan"]>;
  private readonly readPiCache: NonNullable<
    AgentCommandServiceOptions["readPiCache"]
  >;
  private readonly readAcpCache: NonNullable<
    AgentCommandServiceOptions["readAcpCache"]
  >;
  private readonly scanTtlMs: number;
  private readonly scans = new Map<
    string,
    { at: number; skills: Promise<AgentSkill[]> }
  >();

  constructor(options: AgentCommandServiceOptions = {}) {
    this.codexSkills = options.codexSkills ?? new CodexSkillsLister();
    this.scanImpl = options.scan ?? scanSkills;
    this.readPiCache =
      options.readPiCache ?? ((cwd) => readPiCommandCache(cwd));
    this.readAcpCache =
      options.readAcpCache ??
      ((provider, cwd) => readAgentCommandCache(provider, cwd));
    this.scanTtlMs = options.scanTtlMs ?? 30_000;
  }

  async list(
    provider: string,
    cwd: string,
    sources: AgentCommandSources = {},
  ): Promise<AgentCommandListing> {
    switch (provider) {
      case "codex":
        return this.listCodex(cwd, sources);
      case "pi":
        return this.listSlashProvider(provider, cwd, sources, () =>
          this.readPiCache(cwd),
        );
      case "mcode":
      case "cursor":
        return this.listSlashProvider(provider, cwd, sources, () =>
          this.readAcpCache(provider, cwd),
        );
      default:
        return none(provider);
    }
  }

  private scan(provider: SkillScanProvider, cwd: string) {
    const key = `${provider}\u0000${cwd}`;
    const cached = this.scans.get(key);
    if (cached && Date.now() - cached.at < this.scanTtlMs) return cached.skills;
    const skills = this.scanImpl(provider, cwd).catch(() => []);
    this.scans.set(key, { at: Date.now(), skills });
    if (this.scans.size > 128) {
      const oldest = this.scans.keys().next().value;
      if (oldest !== undefined) this.scans.delete(oldest);
    }
    return skills;
  }

  private async listCodex(
    cwd: string,
    sources: AgentCommandSources,
  ): Promise<AgentCommandListing> {
    if (sources.liveCodexSkills) {
      const live = await sources.liveCodexSkills().catch(() => undefined);
      if (live !== undefined) {
        return {
          provider: "codex",
          origin: "live",
          commands: [],
          skills: parseCodexSkillsResponse(live),
        };
      }
    }
    const probed = await this.codexSkills.list(cwd).catch(() => null);
    if (probed) {
      return {
        provider: "codex",
        origin: "live",
        commands: [],
        skills: probed,
      };
    }
    const scanned = await this.scan("codex", cwd);
    return {
      provider: "codex",
      origin: scanned.length > 0 ? "scan" : "none",
      commands: [],
      skills: scanned,
    };
  }

  private async listSlashProvider(
    provider: "pi" | "mcode" | "cursor",
    cwd: string,
    sources: AgentCommandSources,
    readCache: () => Promise<SlashCommand[] | null>,
  ): Promise<AgentCommandListing> {
    const live = sources.liveCommands
      ? await sources.liveCommands().catch(() => null)
      : null;
    const cached = live ? null : await readCache().catch(() => null);
    const reported = live ?? cached;
    if (reported) {
      return {
        provider,
        origin: live ? "live" : "cache",
        commands:
          provider === "cursor"
            ? await this.markCursorSkills(reported, cwd)
            : reported,
        skills: [],
      };
    }
    const prefix = SKILL_COMMAND_PREFIX[provider] ?? "";
    const scanned = await this.scan(provider, cwd);
    return {
      provider,
      origin: scanned.length > 0 ? "scan" : "none",
      commands: scanned.map((skill) => ({
        name: `${prefix}${skill.name}`,
        description: skill.description,
        source: "skill" as const,
      })),
      skills: [],
    };
  }

  /** Cursor's ACP list does not say which entries are skills. */
  private async markCursorSkills(
    commands: SlashCommand[],
    cwd: string,
  ): Promise<SlashCommand[]> {
    const skills = new Set((await this.scan("cursor", cwd)).map((s) => s.name));
    return commands.map((command) =>
      !command.source && skills.has(command.name)
        ? { ...command, source: "skill" as const }
        : command,
    );
  }
}
