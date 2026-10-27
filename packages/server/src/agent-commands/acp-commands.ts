import type { SlashCommand } from "@yep-anywhere/shared";
import { writeAgentCommandCache } from "./command-cache.js";

export type AcpCommandProvider = "mcode" | "cursor";

/**
 * Commands an ACP agent advertises that do nothing useful through Yep:
 * - MiniMax Code `/new` only says "start a new thread in your ACP client".
 * - Cursor `/copy-request-id` writes to the clipboard of the agent host.
 */
const UNUSABLE: Record<AcpCommandProvider, ReadonlySet<string>> = {
  mcode: new Set(["new"]),
  cursor: new Set(["copy-request-id"]),
};

const MCODE_SKILL_PREFIX = /^\[Skill\]\s*/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ACP `available_commands_update.availableCommands` → Yep commands. */
export function normalizeAcpCommands(
  provider: AcpCommandProvider,
  available: unknown,
): SlashCommand[] {
  if (!Array.isArray(available)) return [];
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];
  for (const item of available) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const name = item.name.trim().replace(/^\//u, "");
    if (!name || seen.has(name) || UNUSABLE[provider].has(name)) continue;
    seen.add(name);
    let description =
      typeof item.description === "string" ? item.description.trim() : "";
    let source: SlashCommand["source"];
    // MiniMax Code lists skills as `/name` with a "[Skill]" description tag.
    if (provider === "mcode" && MCODE_SKILL_PREFIX.test(description)) {
      description = description.replace(MCODE_SKILL_PREFIX, "");
      source = "skill";
    }
    const hint =
      isRecord(item.input) && typeof item.input.hint === "string"
        ? item.input.hint.trim()
        : "";
    commands.push({
      name,
      description,
      ...(hint ? { argumentHint: hint } : {}),
      ...(source ? { source } : {}),
    });
  }
  return commands;
}

/**
 * Keeps the latest `available_commands_update` of one ACP session and
 * remembers it per working directory for sessions that start later.
 */
export class AcpCommandTracker {
  private commands: SlashCommand[] | null = null;
  private waiters: Array<(commands: SlashCommand[] | null) => void> = [];

  constructor(
    private readonly provider: AcpCommandProvider,
    private readonly cwd: string,
    private readonly cachePath?: string,
  ) {}

  /** Returns true when the notification was a command list update. */
  accept(notification: unknown): boolean {
    const update = isRecord(notification) ? notification.update : undefined;
    if (
      !isRecord(update) ||
      update.sessionUpdate !== "available_commands_update"
    ) {
      return false;
    }
    const commands = normalizeAcpCommands(
      this.provider,
      update.availableCommands,
    );
    this.commands = commands;
    for (const resolve of this.waiters.splice(0)) resolve(commands);
    void writeAgentCommandCache(
      this.provider,
      this.cwd,
      commands,
      this.cachePath,
    );
    return true;
  }

  /** Latest list; waits briefly for the first update after session start. */
  current(timeoutMs = 1_500): Promise<SlashCommand[] | null> {
    if (this.commands) return Promise.resolve(this.commands);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      const done = (commands: SlashCommand[] | null) => {
        clearTimeout(timer);
        resolve(commands);
      };
      this.waiters.push(done);
    });
  }
}
