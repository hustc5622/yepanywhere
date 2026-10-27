import type { AgentSkill } from "@yep-anywhere/shared";
import { CodexAppServerClient } from "../codex-bridge/CodexAppServerClient.js";
import { getLogger } from "../logging/logger.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Enabled skills from an app-server `skills/list` response. */
export function parseCodexSkillsResponse(value: unknown): AgentSkill[] {
  const entries = asRecord(value)?.data;
  if (!Array.isArray(entries)) return [];
  const skills: AgentSkill[] = [];
  const seen = new Set<string>();
  for (const entryValue of entries) {
    const entry = asRecord(entryValue);
    if (!entry || !Array.isArray(entry.skills)) continue;
    for (const skillValue of entry.skills) {
      const skill = asRecord(skillValue);
      const name = typeof skill?.name === "string" ? skill.name.trim() : "";
      const path = typeof skill?.path === "string" ? skill.path.trim() : "";
      if (!name || !path || skill?.enabled === false || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const iface = asRecord(skill?.interface);
      const description =
        (typeof iface?.shortDescription === "string" &&
          iface.shortDescription.trim()) ||
        (typeof skill?.description === "string" && skill.description.trim()) ||
        "";
      skills.push({ name, description, path });
    }
  }
  return skills;
}

interface CodexSkillsClient {
  start(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): void;
}

export interface CodexSkillsListerOptions {
  ttlMs?: number;
  createClient?: () => CodexSkillsClient;
}

/**
 * Lists Codex skills for a directory without a session: `skills/list` needs
 * no thread, so a short-lived `codex app-server` answers it with Codex's own
 * roots, plugin skills and enablement config. Results are cached per `cwd`.
 */
export class CodexSkillsLister {
  private readonly cache = new Map<
    string,
    { at: number; skills: Promise<AgentSkill[] | null> }
  >();
  private readonly ttlMs: number;
  private readonly createClient: () => CodexSkillsClient;

  constructor(options: CodexSkillsListerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.createClient =
      options.createClient ??
      (() => new CodexAppServerClient({ requestTimeoutMs: 15_000 }));
  }

  list(cwd: string): Promise<AgentSkill[] | null> {
    const cached = this.cache.get(cwd);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.skills;
    const skills = this.fetch(cwd);
    this.cache.set(cwd, { at: Date.now(), skills });
    // A failure should not stick for the whole TTL.
    void skills.then((result) => {
      if (result === null && this.cache.get(cwd)?.skills === skills) {
        this.cache.delete(cwd);
      }
    });
    if (this.cache.size > 64) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return skills;
  }

  private async fetch(cwd: string): Promise<AgentSkill[] | null> {
    const client = this.createClient();
    try {
      await client.start();
      const response = await client.request("skills/list", { cwds: [cwd] });
      return parseCodexSkillsResponse(response);
    } catch (error) {
      getLogger().debug({ error, cwd }, "Codex skills/list probe failed");
      return null;
    } finally {
      client.close();
    }
  }
}
