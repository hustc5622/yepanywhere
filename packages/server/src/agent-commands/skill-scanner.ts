import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentSkill } from "@yep-anywhere/shared";
import { PI_AGENT_DIR } from "../sessions/pi-files.js";

/**
 * Fallback skill discovery for providers that have not reported a list for
 * this directory yet. Each provider's roots mirror its own loader, in its
 * precedence order (first root wins on a name collision):
 *
 * - Codex: `references/codex/codex-rs/ext/skills/src/host_roots.rs`
 * - Pi: `references/pi/packages/coding-agent/src/core/package-manager.ts`
 * - MiniMax Code: `references/minimax/app/mavis/local-runtime-v2/src/service/skill/registry/roots.ts`
 * - Cursor: `skill-path-utils.ts` in the installed `cursor-agent` bundle
 *
 * The provider's live list stays authoritative: it also applies enablement
 * config and plugin/package skills, which this scan does not.
 */
export type SkillScanProvider = "codex" | "pi" | "mcode" | "cursor";

interface SkillRoot {
  path: string;
  /** Directory names inside a root are scanned at most this deep. */
  maxDepth?: number;
}

export interface SkillScanEnv {
  home?: string;
  codexHome?: string;
  piAgentDir?: string;
  minimaxHome?: string;
}

const MAX_SKILLS = 500;
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_DEPTH = 3;

/**
 * `cwd` and its ancestors up to the enclosing git root (inclusive), nearest
 * first; only `cwd` when it is not inside a git repository.
 */
async function projectDirs(cwd: string, home: string): Promise<string[]> {
  const dirs: string[] = [];
  let current = resolve(cwd);
  for (let i = 0; i < 32; i++) {
    dirs.push(current);
    if (await exists(join(current, ".git"))) return dirs;
    const parent = dirname(current);
    if (parent === current || current === home) break;
    current = parent;
  }
  return dirs.slice(0, 1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function skillRootsFor(
  provider: SkillScanProvider,
  cwd: string,
  env: SkillScanEnv = {},
): Promise<SkillRoot[]> {
  const home = env.home ?? homedir();
  const codexHome =
    env.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex");
  const nearestFirst = await projectDirs(cwd, home);
  const user = (...parts: string[]) => ({ path: join(home, ...parts) });

  switch (provider) {
    case "codex":
      return [
        { path: join(resolve(cwd), ".codex", "skills") },
        ...nearestFirst.map((dir) => ({
          path: join(dir, ".agents", "skills"),
        })),
        { path: join(codexHome, "skills") },
        user(".agents", "skills"),
        { path: join(codexHome, "skills", ".system") },
      ];
    case "pi": {
      const agentDir =
        env.piAgentDir ??
        (env.home ? join(home, ".pi", "agent") : PI_AGENT_DIR);
      return [
        { path: join(agentDir, "skills") },
        { path: join(resolve(cwd), ".pi", "skills") },
        ...nearestFirst.map((dir) => ({
          path: join(dir, ".agents", "skills"),
        })),
        user(".agents", "skills"),
      ];
    }
    case "mcode": {
      const dataDir = env.minimaxHome ?? join(home, ".minimax");
      return [
        ...nearestFirst.flatMap((dir) => [
          { path: join(dir, ".minimax", "skills") },
          { path: join(dir, ".claude", "skills") },
          { path: join(dir, ".agents", "skills") },
        ]),
        user(".claude", "skills"),
        user(".codex", "skills"),
        user(".agents", "skills"),
        { path: join(dataDir, "agents", "mavis", "skills") },
        { path: join(dataDir, "skills") },
        { path: join(dataDir, ".builtin-skills") },
      ];
    }
    case "cursor":
      return [
        ...nearestFirst.flatMap((dir) =>
          [".cursor", ".claude", ".codex", ".agents"].map((base) => ({
            path: join(dir, base, "skills"),
          })),
        ),
        user(".cursor", "skills"),
        user(".cursor", "skills-cursor"),
        user(".claude", "skills"),
        user(".codex", "skills"),
        user(".agents", "skills"),
      ];
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** `name` and `description` from YAML frontmatter, incl. `>`/`|` blocks. */
export function parseSkillFrontmatter(text: string): {
  name?: string;
  description?: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (!match?.[1]) return {};
  const lines = match[1].split(/\r?\n/u);
  const result: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const field = /^(name|description):\s*(.*)$/u.exec(line);
    if (!field) continue;
    const key = field[1] as "name" | "description";
    let value = field[2] ?? "";
    if (/^[>|][-+]?\s*$/u.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/u.test(lines[i + 1] ?? "")) {
        i++;
        block.push((lines[i] ?? "").trim());
      }
      value = block.filter(Boolean).join(" ");
    }
    const parsed = unquote(value);
    if (parsed) result[key] = parsed;
  }
  return result;
}

async function readSkill(dir: string): Promise<AgentSkill | null> {
  const path = join(dir, "SKILL.md");
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    if (info.size > MAX_SKILL_FILE_BYTES * 16) return null;
    const text = (await readFile(path, "utf8")).slice(0, MAX_SKILL_FILE_BYTES);
    const meta = parseSkillFrontmatter(text);
    const name = (meta.name ?? dir.split(/[\\/]/u).pop() ?? "").trim();
    if (!name) return null;
    return { name, description: meta.description ?? "", path };
  } catch {
    return null;
  }
}

async function scanRoot(
  root: SkillRoot,
  out: AgentSkill[],
  depth = 0,
  dir = root.path,
): Promise<void> {
  if (out.length >= MAX_SKILLS) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_SKILLS) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const child = join(dir, entry.name);
    const skill = await readSkill(child);
    if (skill) {
      out.push(skill);
    } else if (depth + 1 < (root.maxDepth ?? DEFAULT_MAX_DEPTH)) {
      await scanRoot(root, out, depth + 1, child);
    }
  }
}

/** Skills visible to `provider` in `cwd`, de-duplicated by name. */
export async function scanSkills(
  provider: SkillScanProvider,
  cwd: string,
  env?: SkillScanEnv,
): Promise<AgentSkill[]> {
  const roots = await skillRootsFor(provider, cwd, env);
  const seenRoots = new Set<string>();
  const byName = new Map<string, AgentSkill>();
  for (const root of roots) {
    const key = resolve(root.path);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    const found: AgentSkill[] = [];
    await scanRoot(root, found);
    for (const skill of found) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
    if (byName.size >= MAX_SKILLS) break;
  }
  return [...byName.values()];
}
