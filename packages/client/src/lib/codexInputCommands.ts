import type { CodexStructuredUserInput } from "../api/client";

export interface CodexSkillCommand {
  name: string;
  path: string;
  description?: string;
}

export type CodexSlashCommandResult =
  | { kind: "none" }
  | { kind: "compact" }
  | { kind: "invalid-compact-args" }
  /** `review/start`: bare → uncommitted changes, text → custom instructions. */
  | { kind: "review"; instructions?: string }
  /** Opens the goal dialog; trailing text prefills the objective. */
  | { kind: "goal"; objective?: string };

/**
 * Codex slash commands Yep intercepts. Codex itself parses slash commands
 * only in its terminal UI, so anything else is sent as ordinary text.
 */
export function parseCodexSlashCommand(text: string): CodexSlashCommandResult {
  const trimmed = text.trim();
  if (trimmed === "/compact") return { kind: "compact" };
  if (/^\/compact\s+/u.test(trimmed)) {
    return { kind: "invalid-compact-args" };
  }
  const review = /^\/review(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (review) {
    const instructions = review[1]?.trim();
    return instructions ? { kind: "review", instructions } : { kind: "review" };
  }
  const goal = /^\/goal(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (goal) {
    const objective = goal[1]?.trim();
    return objective ? { kind: "goal", objective } : { kind: "goal" };
  }
  return { kind: "none" };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseCodexSkillsList(value: unknown): CodexSkillCommand[] {
  const response = asRecord(value);
  const entries = response?.data;
  if (!Array.isArray(entries)) return [];

  const skills: CodexSkillCommand[] = [];
  const seen = new Set<string>();
  for (const entryValue of entries) {
    const entry = asRecord(entryValue);
    if (!entry || !Array.isArray(entry.skills)) continue;
    for (const skillValue of entry.skills) {
      const skill = asRecord(skillValue);
      const name = typeof skill?.name === "string" ? skill.name.trim() : "";
      const path = typeof skill?.path === "string" ? skill.path.trim() : "";
      if (!name || !path || skill?.enabled === false) continue;
      const identity = `${name}\u0000${path}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      skills.push({
        name,
        path,
        ...(typeof skill?.description === "string" && skill.description.trim()
          ? { description: skill.description.trim() }
          : {}),
      });
    }
  }
  return skills;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveCodexSkillInputs(
  text: string,
  skills: readonly CodexSkillCommand[],
): CodexStructuredUserInput[] {
  const inputs: CodexStructuredUserInput[] = [];
  const seenNames = new Set<string>();
  for (const skill of skills) {
    if (seenNames.has(skill.name)) continue;
    const mention = new RegExp(
      `(^|[\\s([{])\\$${escapeRegExp(skill.name)}(?=$|[\\s)\\]},.!?;:])`,
      "u",
    );
    if (!mention.test(text)) continue;
    seenNames.add(skill.name);
    inputs.push({ type: "skill", name: skill.name, path: skill.path });
  }
  return inputs;
}
