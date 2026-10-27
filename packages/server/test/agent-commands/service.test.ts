import { describe, expect, it, vi } from "vitest";
import { parseCodexSkillsResponse } from "../../src/agent-commands/codex-skills.js";
import { AgentCommandService } from "../../src/agent-commands/service.js";

const scanned = [
  { name: "git-commit-push", description: "Commit", path: "/s" },
];

function service(overrides = {}) {
  return new AgentCommandService({
    codexSkills: { list: vi.fn(async () => null) },
    scan: vi.fn(async () => scanned),
    readPiCache: vi.fn(async () => null),
    readAcpCache: vi.fn(async () => null),
    ...overrides,
  });
}

describe("agent command service", () => {
  it("prefers a live Codex process, then a probe, then a scan", async () => {
    const live = await service().list("codex", "/repo", {
      liveCodexSkills: async () => ({
        data: [
          {
            cwd: "/repo",
            skills: [
              { name: "live", description: "L", path: "/l", enabled: true },
              { name: "off", description: "", path: "/o", enabled: false },
            ],
          },
        ],
      }),
    });
    expect(live).toMatchObject({
      origin: "live",
      skills: [{ name: "live", description: "L", path: "/l" }],
    });

    const probe = vi.fn(async () => [
      { name: "p", description: "", path: "/p" },
    ]);
    expect(
      await service({ codexSkills: { list: probe } }).list("codex", "/repo"),
    ).toMatchObject({ origin: "live", skills: [{ name: "p" }] });

    expect(await service().list("codex", "/repo")).toMatchObject({
      origin: "scan",
      skills: scanned,
    });
  });

  it("turns scanned skills into each provider's command syntax", async () => {
    const pi = await service().list("pi", "/repo");
    expect(pi.commands).toEqual([
      { name: "skill:git-commit-push", description: "Commit", source: "skill" },
    ]);
    const mcode = await service().list("mcode", "/repo");
    expect(mcode.commands[0]?.name).toBe("git-commit-push");
  });

  it("uses the live list, then the cache, before scanning", async () => {
    const live = await service().list("mcode", "/repo", {
      liveCommands: async () => [{ name: "compact", description: "" }],
    });
    expect(live).toMatchObject({
      origin: "live",
      commands: [{ name: "compact" }],
    });

    const cached = await service({
      readPiCache: async () => [{ name: "tmpl", description: "" }],
    }).list("pi", "/repo");
    expect(cached).toMatchObject({
      origin: "cache",
      commands: [{ name: "tmpl" }],
    });
  });

  it("marks Cursor commands that are skills", async () => {
    const result = await service({
      readAcpCache: async () => [
        { name: "git-commit-push", description: "" },
        { name: "plan-review", description: "" },
      ],
    }).list("cursor", "/repo");
    expect(result.commands).toEqual([
      { name: "git-commit-push", description: "", source: "skill" },
      { name: "plan-review", description: "" },
    ]);
  });

  it("lists nothing for providers without a skills source", async () => {
    expect(await service().list("claude", "/repo")).toEqual({
      provider: "claude",
      origin: "none",
      commands: [],
      skills: [],
    });
  });

  it("prefers the short description from SKILL.json interface", () => {
    expect(
      parseCodexSkillsResponse({
        data: [
          {
            skills: [
              {
                name: "a",
                description: "long",
                interface: { shortDescription: "short" },
                path: "/a",
              },
            ],
          },
        ],
      }),
    ).toEqual([{ name: "a", description: "short", path: "/a" }]);
  });
});
