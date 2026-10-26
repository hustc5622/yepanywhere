import { describe, expect, it } from "vitest";
import {
  CODEX_SLASH_COMMANDS,
  PI_SLASH_COMMANDS,
  STATIC_SLASH_COMMANDS,
  buildSlashCommandDetails,
  getAgentCommandConfig,
  getAgentCommandConfigs,
  getStaticAgentCommandConfigs,
  normalizeSlashCommands,
} from "../agentCommands";

describe("agent command config", () => {
  it("uses slash commands for Codex providers", () => {
    const config = getAgentCommandConfig("codex", false, ["ignored"]);

    expect(config.prefix).toBe("/");
    expect(config.label).toBe("Codex commands");
    expect(config.showButton).toBe(true);
    expect(config.commands).toBe(CODEX_SLASH_COMMANDS);
  });

  it("keeps Codex slash commands and skills in separate namespaces", () => {
    const configs = getAgentCommandConfigs(
      "codex",
      false,
      [],
      ["imagegen", "openai-docs"],
    );

    expect(configs).toEqual([
      {
        prefix: "/",
        label: "Codex commands",
        showButton: true,
        commands: CODEX_SLASH_COMMANDS,
      },
      {
        prefix: "$",
        label: "Skills",
        showButton: true,
        commands: ["imagegen", "openai-docs"],
      },
    ]);
  });

  it("defaults Claude providers to slash command support", () => {
    const config = getAgentCommandConfig("claude", undefined, [
      "deep-research",
    ]);

    expect(config.prefix).toBe("/");
    expect(config.label).toBe("Slash commands");
    expect(config.showButton).toBe(true);
    expect(config.commands).toEqual([
      ...STATIC_SLASH_COMMANDS,
      "deep-research",
    ]);
  });

  it("offers Pi's handled built-ins plus its live commands", () => {
    const config = getAgentCommandConfig("pi", true, [
      "skill:review",
      "compact",
    ]);

    expect(config.showButton).toBe(true);
    expect(config.commands).toEqual([...PI_SLASH_COMMANDS, "skill:review"]);
    expect(config.commands).not.toContain("help");
  });

  it("hides commands for providers without command support", () => {
    const config = getAgentCommandConfig("gemini", false, ["ignored"]);

    expect(config.prefix).toBe("/");
    expect(config.showButton).toBe(false);
    expect(config.commands).toEqual([]);
  });

  it("builds a static slash toolbar config", () => {
    const configs = getStaticAgentCommandConfigs(["deep-research"]);

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      prefix: "/",
      label: "Slash commands",
      showButton: true,
    });
    expect(configs[0]?.commands).toEqual([
      ...STATIC_SLASH_COMMANDS,
      "deep-research",
    ]);
  });

  it("normalizes legacy names and full provider command entries", () => {
    expect(
      normalizeSlashCommands([
        "review",
        { name: "/fix-tests", description: " Fix tests ", source: "prompt" },
        { name: "skill:x", source: "unknown" },
        { name: "review", description: "duplicate" },
        { description: "nameless" },
        42,
      ]),
    ).toEqual([
      { name: "review", description: "" },
      { name: "fix-tests", description: "Fix tests", source: "prompt" },
      { name: "skill:x", description: "" },
    ]);
    expect(normalizeSlashCommands(undefined)).toEqual([]);
  });

  it("keeps only commands that have something to show", () => {
    expect(
      buildSlashCommandDetails([
        { name: "review", description: "Review", source: "extension" },
        { name: "bare", description: "" },
        { name: "skill:x", description: "", source: "skill" },
      ]),
    ).toEqual({
      review: { description: "Review", source: "extension" },
      "skill:x": { source: "skill" },
    });
  });
});
