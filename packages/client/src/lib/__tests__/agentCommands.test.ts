import { describe, expect, it } from "vitest";
import { filterCommands } from "../../hooks/useCommandCompletion";
import {
  type AgentCommandAvailability,
  STATIC_SLASH_COMMANDS,
  buildAgentCommandCatalog,
  buildSlashCommandDetails,
  normalizeSlashCommands,
} from "../agentCommands";
import {
  CODEX_CLI_SLASH_COMMANDS,
  PI_CLI_SLASH_COMMANDS,
  terminalOnlyCommand,
} from "../cliSlashCommands";

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
  it("offers exactly the Codex CLI picker in every composer state", () => {
    // `/apps` runs when typed but never appears in the Codex picker.
    const cliNames = CODEX_CLI_SLASH_COMMANDS.filter(
      (command) => command.picker !== "hidden",
    ).map((command) => command.name);
    for (const availability of [
      OWNED,
      IDLE,
      NEW_SESSION,
      { scope: "session" as const },
    ]) {
      const [slash, skills] = buildAgentCommandCatalog({
        provider: "codex",
        supportsSlashCommands: false,
        providerCommands: [{ name: "ignored", description: "" }],
        codexSkills: [
          { name: "imagegen", description: "Make images" },
          { name: "openai-docs" },
        ],
        availability,
        descriptions: { codexCompact: "Compact now", side: "Side chat" },
      });
      expect(slash?.prefix).toBe("/");
      expect(slash?.label).toBe("Codex commands");
      expect(slash?.showButton).toBe(true);
      expect(slash?.commands).toEqual(cliNames);
      expect(skills).toEqual({
        prefix: "$",
        label: "Skills",
        showButton: true,
        commands: ["imagegen", "openai-docs"],
        details: { imagegen: { description: "Make images" } },
      });
    }
  });

  it("marks what Yep runs versus terminal-only Codex commands", () => {
    const [slash] = buildAgentCommandCatalog({
      provider: "codex",
      availability: OWNED,
      descriptions: { codexCompact: "Compact now", side: "Side chat" },
    });
    expect(slash?.commands.slice(0, 3)).toEqual([
      "model",
      "presets",
      "daybreak",
    ]);
    // Like the TUI, aliases appear only once a prefix is typed.
    expect(slash?.typedOnly).toEqual(["btw", "quit"]);
    const unfiltered = filterCommands(
      slash?.commands ?? [],
      "",
      slash?.typedOnly,
    );
    expect(unfiltered).not.toContain("btw");
    expect(unfiltered).not.toContain("quit");
    expect(
      filterCommands(slash?.commands ?? [], "bt", slash?.typedOnly),
    ).toEqual(["btw"]);
    expect(terminalOnlyCommand("codex", "/apps")).toBe("apps");
    expect(slash?.details?.compact).toEqual({
      description: "Compact now",
      source: "yep",
    });
    expect(slash?.details?.btw).toEqual({
      description: "Side chat",
      source: "yep",
    });
    expect(slash?.details?.vim).toEqual({
      description: "toggle Vim mode for the composer",
      source: "terminal",
    });
    expect(slash?.commands).not.toContain("debug-m-drop");
    expect(slash?.commands).not.toContain("setup-default-sandbox");
  });

  it("lists /fast after /model when the Codex model offers the Fast tier", () => {
    const [newSession] = buildAgentCommandCatalog({
      provider: "codex",
      codexFastMode: true,
      availability: NEW_SESSION,
      descriptions: { fast: "Toggle Fast" },
    });
    expect(newSession?.commands.slice(0, 3)).toEqual([
      "model",
      "fast",
      "presets",
    ]);
    expect(newSession?.details?.fast).toEqual({
      description: "Toggle Fast",
      source: "yep",
    });

    const [inSession] = buildAgentCommandCatalog({
      provider: "codex",
      codexFastMode: true,
      availability: OWNED,
    });
    expect(inSession?.details?.fast?.source).toBe("terminal");

    const [noFast] = buildAgentCommandCatalog({
      provider: "codex",
      availability: OWNED,
    });
    expect(noFast?.commands).not.toContain("fast");
    expect(terminalOnlyCommand("codex", "/fast")).toBe("fast");
  });

  it("uses the session-start /goal description before a Codex session exists", () => {
    const [slash] = buildAgentCommandCatalog({
      provider: "codex",
      availability: NEW_SESSION,
      descriptions: { goal: "In session", goalNewSession: "Start on a goal" },
    });
    expect(slash?.details?.goal).toEqual({
      description: "Start on a goal",
      source: "yep",
    });
  });

  it("refuses terminal-only CLI commands, resolving aliases", () => {
    expect(terminalOnlyCommand("codex", "/vim")).toBe("vim");
    expect(terminalOnlyCommand("codex", "  /cwd now")).toBe("pwd");
    expect(terminalOnlyCommand("codex", "/clean")).toBe("stop");
    expect(terminalOnlyCommand("codex", "/goal ship")).toBeNull();
    expect(terminalOnlyCommand("codex", "/compact")).toBeNull();
    expect(terminalOnlyCommand("codex", "/unknown")).toBeNull();
    expect(terminalOnlyCommand("codex", "see /vim")).toBeNull();
    expect(terminalOnlyCommand("codex", "/usr/bin/env")).toBeNull();
    expect(terminalOnlyCommand("pi", "/tree")).toBe("tree");
    expect(terminalOnlyCommand("pi", "/compact keep notes")).toBeNull();
    // A Pi extension of the same name runs over RPC.
    expect(terminalOnlyCommand("pi", "/export", ["export"])).toBeNull();
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

  it("lists Pi's CLI built-ins, then its reported commands, then Yep side chat", () => {
    const providerCommands = [
      { name: "skill:review", description: "", source: "skill" as const },
      { name: "goal", description: "Goals", source: "extension" as const },
      { name: "gcp", description: "Commit", source: "prompt" as const },
      { name: "compact", description: "extension shadowing a built-in" },
    ];
    const builtins = PI_CLI_SLASH_COMMANDS.map((command) => command.name);
    const [owned] = buildAgentCommandCatalog({
      provider: "pi",
      providerCommands,
      availability: { scope: "session", ownsProcess: true },
      descriptions: { compact: "Yep compact", side: "Side chat" },
    });
    // Pi's picker order: prompt templates, extensions, then skills.
    expect(owned?.commands).toEqual([
      ...builtins,
      "gcp",
      "goal",
      "skill:review",
      "side",
      "btw",
    ]);
    expect(owned?.commands).not.toContain("help");
    expect(owned?.details?.["skill:review"]).toEqual({ source: "skill" });
    expect(owned?.details?.goal).toEqual({
      description: "Goals",
      source: "extension",
    });
    expect(owned?.details?.compact).toEqual({
      description: "Yep compact",
      source: "yep",
    });
    expect(owned?.details?.tree).toEqual({
      description: "Navigate session tree (switch branches)",
      source: "terminal",
    });
    expect(owned?.details?.side).toEqual({
      description: "Side chat",
      source: "yep",
    });
    for (const query of ["co", "com", "compact"]) {
      expect(filterCommands(owned?.commands ?? [], query)).toContain("compact");
    }

    // Reported commands need a process or a resumable session; the CLI
    // list itself is always shown.
    const [external] = buildAgentCommandCatalog({
      provider: "pi",
      providerCommands,
      availability: { scope: "session" },
    });
    expect(external?.commands).toEqual([...builtins, "side", "btw"]);
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

  it("adds Yep side chat to Antigravity's ACP commands", () => {
    const providerCommands = [{ name: "goal", description: "Goal" }];
    const [owned] = buildAgentCommandCatalog({
      provider: "agy",
      supportsSlashCommands: true,
      providerCommands,
      availability: OWNED,
      descriptions: { side: "Side chat" },
    });
    expect(owned?.commands).toEqual(["model", "side", "btw", "goal"]);
    expect(owned?.details?.btw?.source).toBe("yep");

    const [idle] = buildAgentCommandCatalog({
      provider: "agy",
      providerCommands,
      availability: IDLE,
    });
    expect(idle?.commands).toEqual(["side", "btw", "goal"]);

    for (const availability of [
      NEW_SESSION,
      { ...OWNED, hasSideConversation: false },
    ]) {
      const [config] = buildAgentCommandCatalog({
        provider: "agy",
        providerCommands,
        availability,
      });
      expect(config?.commands).not.toContain("side");
      expect(config?.commands).not.toContain("btw");
    }
    // MiniMax Code has no side conversation.
    const [mcode] = buildAgentCommandCatalog({
      provider: "mcode",
      providerCommands,
      availability: OWNED,
    });
    expect(mcode?.commands).not.toContain("side");
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
