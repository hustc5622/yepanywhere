import { describe, expect, it } from "vitest";
import {
  type AgentCommandAvailability,
  CODEX_SLASH_COMMANDS,
  STATIC_SLASH_COMMANDS,
  buildAgentCommandCatalog,
  buildSlashCommandDetails,
  normalizeSlashCommands,
} from "../agentCommands";

const OWNED: AgentCommandAvailability = {
  scope: "session",
  ownsProcess: true,
  hasSideConversation: true,
};
const IDLE: AgentCommandAvailability = {
  scope: "session",
  canResume: true,
  hasSideConversation: true,
};
const NEW_SESSION: AgentCommandAvailability = { scope: "new-session" };

describe("agent command catalog", () => {
  it("offers only the Codex commands Yep actually handles", () => {
    const [slash, skills] = buildAgentCommandCatalog({
      provider: "codex",
      supportsSlashCommands: false,
      providerCommands: [{ name: "ignored", description: "" }],
      codexSkills: [
        { name: "imagegen", description: "Make images" },
        { name: "openai-docs" },
      ],
      availability: OWNED,
      descriptions: { codexCompact: "Compact now", side: "Side chat" },
    });

    expect(slash?.prefix).toBe("/");
    expect(slash?.label).toBe("Codex commands");
    expect(slash?.commands).toEqual(CODEX_SLASH_COMMANDS);
    expect(slash?.commands).not.toContain("vim");
    expect(slash?.details?.compact).toEqual({
      description: "Compact now",
      source: "yep",
    });
    expect(slash?.details?.btw).toEqual({
      description: "Side chat",
      source: "yep",
    });
    expect(skills).toEqual({
      prefix: "$",
      label: "Skills",
      showButton: true,
      commands: ["imagegen", "openai-docs"],
      details: { imagegen: { description: "Make images" } },
    });
  });

  it("keeps only resumable Codex commands for an idle session", () => {
    const [slash, skills] = buildAgentCommandCatalog({
      provider: "codex",
      availability: { ...IDLE, hasSideConversation: false },
    });
    expect(slash?.commands).toEqual(["compact"]);
    expect(skills?.showButton).toBe(false);
  });

  it("offers no session-bound Codex commands in a new session", () => {
    const [slash] = buildAgentCommandCatalog({
      provider: "codex",
      availability: NEW_SESSION,
    });
    expect(slash?.commands).toEqual([]);
    expect(slash?.showButton).toBe(false);
  });

  it("keeps Claude provider commands usable while idle", () => {
    const [idle] = buildAgentCommandCatalog({
      provider: "claude",
      providerCommands: [{ name: "deep-research", description: "Research" }],
      availability: { ...IDLE, hasSideConversation: false },
    });
    expect(idle?.showButton).toBe(true);
    expect(idle?.commands).toEqual([...STATIC_SLASH_COMMANDS, "deep-research"]);
    expect(idle?.details?.["deep-research"]).toEqual({
      description: "Research",
    });

    const [owned] = buildAgentCommandCatalog({
      provider: "claude",
      providerCommands: [{ name: "model", description: "CLI picker" }],
      availability: { ...OWNED, hasSideConversation: false },
      descriptions: { model: "Yep model switch" },
    });
    expect(owned?.commands[0]).toBe("model");
    expect(owned?.details?.model).toEqual({
      description: "Yep model switch",
      source: "yep",
    });
  });

  it("hides Claude commands for externally owned sessions", () => {
    const [config] = buildAgentCommandCatalog({
      provider: "claude",
      availability: { scope: "session" },
    });
    expect(config?.commands).toEqual([]);
  });

  it("offers Pi's handled built-ins only with a live process", () => {
    const providerCommands = [
      { name: "skill:review", description: "", source: "skill" as const },
      { name: "compact", description: "" },
    ];
    const [owned] = buildAgentCommandCatalog({
      provider: "pi",
      providerCommands,
      availability: { scope: "session", ownsProcess: true },
    });
    expect(owned?.commands).toEqual(["compact", "model", "skill:review"]);
    expect(owned?.commands).not.toContain("help");
    expect(owned?.details?.["skill:review"]).toEqual({ source: "skill" });

    const [idle] = buildAgentCommandCatalog({
      provider: "pi",
      providerCommands,
      availability: { scope: "session", canResume: true },
    });
    expect(idle?.commands).toEqual(["skill:review"]);
  });

  it("offers ACP-reported commands and skills for MiniMax Code and Cursor", () => {
    const providerCommands = [
      { name: "compact", description: "Compact" },
      { name: "pdf", description: "Read PDFs", source: "skill" as const },
    ];
    const [mcode] = buildAgentCommandCatalog({
      provider: "mcode",
      supportsSlashCommands: true,
      providerCommands,
      availability: { scope: "session", ownsProcess: true },
      descriptions: { model: "Yep model switch" },
    });
    expect(mcode?.commands).toEqual(["model", "compact", "pdf"]);
    expect(mcode?.details?.pdf).toEqual({
      description: "Read PDFs",
      source: "skill",
    });

    const [cursor] = buildAgentCommandCatalog({
      provider: "cursor",
      providerCommands,
      availability: NEW_SESSION,
    });
    expect(cursor?.commands).toEqual(["compact", "pdf"]);
    expect(cursor?.commands).not.toContain("help");

    const [external] = buildAgentCommandCatalog({
      provider: "cursor",
      providerCommands,
      availability: { scope: "session" },
    });
    expect(external?.commands).toEqual([]);
  });

  it("hides commands for providers without command support", () => {
    const [config] = buildAgentCommandCatalog({
      provider: "gemini",
      supportsSlashCommands: false,
      providerCommands: [{ name: "ignored", description: "" }],
      availability: OWNED,
    });
    expect(config?.showButton).toBe(false);
    expect(config?.commands).toEqual([]);
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
