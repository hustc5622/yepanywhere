import { describe, expect, it } from "vitest";
import {
  parseCodexSkillsList,
  parseCodexSlashCommand,
  resolveCodexSkillInputs,
} from "../codexInputCommands";

describe("Codex input commands", () => {
  it("recognizes only the bare compact command", () => {
    expect(parseCodexSlashCommand("/compact")).toEqual({ kind: "compact" });
    expect(parseCodexSlashCommand("  /compact  ")).toEqual({
      kind: "compact",
    });
    expect(parseCodexSlashCommand("/compact keep the plan")).toEqual({
      kind: "invalid-compact-args",
    });
    expect(parseCodexSlashCommand("/compactness")).toEqual({ kind: "none" });
  });

  it("parses review and goal commands with optional text", () => {
    expect(parseCodexSlashCommand("/review")).toEqual({ kind: "review" });
    expect(parseCodexSlashCommand(" /review focus on auth\n ")).toEqual({
      kind: "review",
      instructions: "focus on auth",
    });
    expect(parseCodexSlashCommand("/reviewer")).toEqual({ kind: "none" });
    expect(parseCodexSlashCommand("/goal")).toEqual({ kind: "goal" });
    expect(parseCodexSlashCommand("/goal ship v2")).toEqual({
      kind: "goal",
      objective: "ship v2",
    });
    expect(parseCodexSlashCommand("please /goal x")).toEqual({ kind: "none" });
  });

  it("normalizes enabled skills from app-server skills/list", () => {
    expect(
      parseCodexSkillsList({
        data: [
          {
            cwd: "/repo",
            skills: [
              {
                name: "openai-docs",
                path: "/skills/openai-docs/SKILL.md",
                description: "Use OpenAI docs",
                enabled: true,
              },
              {
                name: "disabled",
                path: "/skills/disabled/SKILL.md",
                enabled: false,
              },
            ],
            errors: [],
          },
        ],
      }),
    ).toEqual([
      {
        name: "openai-docs",
        path: "/skills/openai-docs/SKILL.md",
        description: "Use OpenAI docs",
      },
    ]);
  });

  it("turns known dollar mentions into structured skill inputs", () => {
    const skills = [
      { name: "openai-docs", path: "/skills/openai-docs/SKILL.md" },
      { name: "plugin:deploy", path: "/skills/deploy/SKILL.md" },
    ];

    expect(
      resolveCodexSkillInputs(
        "Use $openai-docs, then $plugin:deploy. $missing stays plain.",
        skills,
      ),
    ).toEqual([
      {
        type: "skill",
        name: "openai-docs",
        path: "/skills/openai-docs/SKILL.md",
      },
      {
        type: "skill",
        name: "plugin:deploy",
        path: "/skills/deploy/SKILL.md",
      },
    ]);
  });
});
