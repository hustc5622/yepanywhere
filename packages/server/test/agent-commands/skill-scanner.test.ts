import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseSkillFrontmatter,
  scanSkills,
} from "../../src/agent-commands/skill-scanner.js";

async function skill(dir: string, name: string, description: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
}

describe("skill scanner", () => {
  let root: string;
  let home: string;
  let repo: string;
  let cwd: string;

  beforeEach(async () => {
    root = join(tmpdir(), `skill-scan-${randomUUID()}`);
    home = join(root, "home");
    repo = join(root, "repo");
    cwd = join(repo, "packages", "app");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await skill(join(home, ".agents", "skills", "shared"), "shared", "Global");
    await skill(
      join(home, ".codex", "skills", "codex-only"),
      "codex-only",
      "C",
    );
    await skill(
      join(home, ".codex", "skills", ".system", "imagegen"),
      "imagegen",
      "System",
    );
    await skill(join(repo, ".agents", "skills", "shared"), "shared", "Repo");
    await skill(
      join(home, ".minimax", ".builtin-skills", "pack", "nested"),
      "nested",
      "Nested",
    );
    await skill(
      join(home, ".cursor", "skills-cursor", "canvas"),
      "canvas",
      "X",
    );
    await skill(join(home, ".pi", "agent", "skills", "pi-own"), "pi-own", "P");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const env = () => ({ home, codexHome: join(home, ".codex") });

  it("follows Codex roots: repo .agents up to the git root wins", async () => {
    const skills = await scanSkills("codex", cwd, env());
    expect(skills.map((s) => s.name)).toEqual([
      "shared",
      "codex-only",
      "imagegen",
    ]);
    expect(skills[0]?.description).toBe("Repo");
    expect(skills[0]?.path).toBe(
      join(repo, ".agents", "skills", "shared", "SKILL.md"),
    );
  });

  it("uses each provider's own directories", async () => {
    expect((await scanSkills("pi", cwd, env())).map((s) => s.name)).toEqual([
      "pi-own",
      "shared",
    ]);
    const mcode = (await scanSkills("mcode", cwd, env())).map((s) => s.name);
    expect(mcode).toContain("codex-only");
    expect(mcode).toContain("nested");
    const cursor = (await scanSkills("cursor", cwd, env())).map((s) => s.name);
    expect(cursor).toContain("canvas");
    expect(cursor).not.toContain("pi-own");
  });

  it("parses quoted and folded frontmatter", () => {
    expect(
      parseSkillFrontmatter(
        '---\nname: "deep"\ndescription: >\n  Line one\n  line two\nother: x\n---\n',
      ),
    ).toEqual({ name: "deep", description: "Line one line two" });
    expect(parseSkillFrontmatter("no frontmatter")).toEqual({});
  });
});
