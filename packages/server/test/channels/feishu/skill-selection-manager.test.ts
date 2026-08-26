import type { FeishuSessionBinding } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeishuMessageApi } from "../../../src/channels/feishu/normalization/types.js";
import type { FeishuInteractionApi } from "../../../src/channels/feishu/outbound.js";
import { FeishuSkillSelectionManager } from "../../../src/channels/feishu/skill-selection-manager.js";

describe("FeishuSkillSelectionManager", () => {
  const managers: FeishuSkillSelectionManager[] = [];

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.shutdown();
  });

  it("projects at most 12 plaintext choices with opaque-only action values", async () => {
    const fixture = createFixture();
    managers.push(fixture.manager);

    const presentation = await fixture.manager.presentPicker(
      makeContext(fixture.api),
      makeSkills(14),
    );

    expect(presentation).toEqual({
      mode: "card",
      text: expect.stringContaining("12/14"),
      shown: 12,
      total: 14,
    });
    const card = fixture.api.createInputCard.mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("skill-1");
    expect(serialized).not.toContain("[path]");
    expect(serialized).toContain("/opt/yep-fixtures");
    expect(serialized).not.toContain("session-1");
    const values = findActionValues(card);
    expect(values).toHaveLength(12);
    for (const value of values) {
      expect(Object.keys(value)).toEqual(["token"]);
      expect(value).toEqual({
        token: expect.stringMatching(/^[a-f0-9]{32}$/),
      });
      expect(JSON.stringify(value)).not.toContain("skill-");
    }
  });

  it("authorizes only the requester or an admin and validates the live scope", async () => {
    const fixture = createFixture();
    managers.push(fixture.manager);
    await fixture.manager.presentPicker(
      makeContext(fixture.api),
      makeSkills(1),
    );
    const token = selectedToken(fixture.api, 0);

    await expect(
      fixture.manager.acceptCardAction({
        accountId: "team-bot",
        event: makeAction(token, "ou_other", "card-message-1"),
        api: fixture.api,
        adminUsers: ["ou_admin"],
      }),
    ).resolves.toBe("forbidden");
    await expect(
      fixture.manager.acceptCardAction({
        accountId: "team-bot",
        event: makeAction(token, "ou_admin", "card-message-1"),
        api: fixture.api,
        adminUsers: ["ou_admin"],
      }),
    ).resolves.toBe("claimed");
    expect(fixture.api.updateInputCard).toHaveBeenCalledWith(
      "card-1",
      expect.objectContaining({ schema: "2.0" }),
      1,
    );
    expect(fixture.manager.peekForNextMessage(nextMessageScope())).toEqual(
      expect.objectContaining({
        codexInputs: [
          {
            type: "skill",
            name: "skill-1",
            path: "/opt/yep-fixtures/codex/skills/skill-1/SKILL.md",
          },
        ],
      }),
    );

    await fixture.manager.presentPicker(
      makeContext(fixture.api),
      makeSkills(1),
    );
    const staleToken = selectedToken(fixture.api, 1);
    fixture.binding = makeBinding({ sessionId: "session-replaced" });
    await expect(
      fixture.manager.acceptCardAction({
        accountId: "team-bot",
        event: makeAction(staleToken, "ou_requester", "card-message-2"),
        api: fixture.api,
        adminUsers: [],
      }),
    ).resolves.toBe("stale");
  });

  it("returns typed stale after restart and expires both grants and selections", async () => {
    let now = 0;
    const fixture = createFixture({ now: () => now, ttlMs: 100 });
    managers.push(fixture.manager);
    await fixture.manager.presentPicker(
      makeContext(fixture.api),
      makeSkills(1),
    );
    const token = selectedToken(fixture.api, 0);

    const restarted = createFixture().manager;
    managers.push(restarted);
    await expect(
      restarted.acceptCardAction({
        accountId: "team-bot",
        event: makeAction(token, "ou_requester", "card-message-1"),
        adminUsers: [],
      }),
    ).resolves.toBe("stale");

    now = 101;
    await expect(
      fixture.manager.acceptCardAction({
        accountId: "team-bot",
        event: makeAction(token, "ou_requester", "card-message-1"),
        api: fixture.api,
        adminUsers: [],
      }),
    ).resolves.toBe("expired");

    await fixture.manager.presentPicker(
      makeContext(fixture.api),
      makeSkills(1),
    );
    const freshToken = selectedToken(fixture.api, 1);
    await fixture.manager.acceptCardAction({
      accountId: "team-bot",
      event: makeAction(freshToken, "ou_requester", "card-message-2"),
      api: fixture.api,
      adminUsers: [],
    });
    expect(
      fixture.manager.peekForNextMessage(nextMessageScope()),
    ).toBeDefined();
    now = 202;
    expect(
      fixture.manager.peekForNextMessage(nextMessageScope()),
    ).toBeUndefined();
  });

  it("uses selection versions so an older send cannot clear a newer choice", async () => {
    const fixture = createFixture();
    managers.push(fixture.manager);
    await fixture.manager.presentPicker(
      makeContext(fixture.api),
      makeSkills(2),
    );
    await fixture.manager.acceptCardAction({
      accountId: "team-bot",
      event: makeAction(
        selectedToken(fixture.api, 0, 0),
        "ou_requester",
        "card-message-1",
      ),
      api: fixture.api,
      adminUsers: [],
    });
    const firstLease = fixture.manager.peekForNextMessage(nextMessageScope());
    expect(firstLease).toBeDefined();

    await fixture.manager.presentPicker(
      makeContext(fixture.api),
      makeSkills(2),
    );
    await fixture.manager.acceptCardAction({
      accountId: "team-bot",
      event: makeAction(
        selectedToken(fixture.api, 1, 1),
        "ou_requester",
        "card-message-2",
      ),
      api: fixture.api,
      adminUsers: [],
    });

    await expect(
      fixture.manager.consume(firstLease as NonNullable<typeof firstLease>),
    ).resolves.toBe(false);
    const secondLease = fixture.manager.peekForNextMessage(nextMessageScope());
    expect(secondLease?.version).not.toBe(firstLease?.version);
    expect(secondLease?.codexInputs[0].name).toBe("skill-2");
    const tamperedLease = structuredClone(secondLease);
    if (!tamperedLease) throw new Error("Expected a skill selection lease");
    tamperedLease.codexInputs[0].path = "/opt/yep-fixtures/other/SKILL.md";
    await expect(fixture.manager.consume(tamperedLease)).resolves.toBe(false);
    await expect(
      fixture.manager.consume(secondLease as NonNullable<typeof secondLease>),
    ).resolves.toBe(true);
    expect(
      fixture.manager.peekForNextMessage(nextMessageScope()),
    ).toBeUndefined();
  });

  it("degrades unknown responses or missing CardKit to bounded text", async () => {
    const fixture = createFixture();
    managers.push(fixture.manager);
    await expect(
      fixture.manager.presentPicker(
        { ...makeContext(fixture.api), api: undefined },
        makeSkills(14),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        mode: "text",
        text: expect.stringContaining("另有 2 项未显示"),
      }),
    );
    await expect(
      fixture.manager.presentPicker(makeContext(fixture.api), {
        unexpected: true,
      }),
    ).resolves.toEqual({
      mode: "text",
      text: "当前没有可用 Skills。",
      shown: 0,
      total: 0,
    });
  });

  it("retains credential-like names and descriptions in cards and fallback output", async () => {
    const fixture = createFixture();
    managers.push(fixture.manager);
    const data = {
      data: [
        {
          skills: [
            {
              name: "safe-skill",
              description: "NPM_TOKEN=npm-token-must-not-leak",
              path: "/opt/yep-fixtures/codex/skills/safe/SKILL.md",
            },
            {
              name: "xoxb-0000000000-fixture-do-not-use",
              description: "must be omitted",
              path: "/opt/yep-fixtures/codex/skills/blocked/SKILL.md",
            },
          ],
        },
      ],
    };

    const card = await fixture.manager.presentPicker(
      makeContext(fixture.api),
      data,
    );
    expect(card).toMatchObject({ mode: "card", shown: 2, total: 2 });
    const serialized = JSON.stringify(
      fixture.api.createInputCard.mock.calls.at(-1)?.[1],
    );
    expect(serialized).not.toContain("[REDACTED:secret]");
    expect(serialized).toContain("npm-token-must-not-leak");
    expect(serialized).toContain("xoxb-0000000000-fixture-do-not-use");
    expect(serialized).not.toContain("/opt/yep-fixtures");

    const fallback = await fixture.manager.presentPicker(
      { ...makeContext(fixture.api), api: undefined },
      data,
    );
    expect(fallback.text).not.toContain("[REDACTED:secret]");
    expect(fallback.text).toContain("npm-token-must-not-leak");
    expect(fallback.text).toContain("xoxb-0000000000-fixture-do-not-use");
    expect(fallback.text).not.toContain("/opt/yep-fixtures");
  });

  it("neutralizes mention-shaped markup in public skill metadata", async () => {
    const fixture = createFixture();
    managers.push(fixture.manager);
    const data = {
      data: [
        {
          skills: [
            {
              name: "notify <at id=all></at>",
              description: "Use <at id=all></at> safely",
              path: "/opt/yep-fixtures/codex/skills/notify/SKILL.md",
            },
          ],
        },
      ],
    };

    await fixture.manager.presentPicker(makeContext(fixture.api), data);
    const card = JSON.stringify(
      fixture.api.createInputCard.mock.calls.at(-1)?.[1],
    );
    expect(card).not.toContain("<at");
    expect(card).toContain("&lt;at id=all&gt;&lt;/at&gt;");

    const fallback = await fixture.manager.presentPicker(
      { ...makeContext(fixture.api), api: undefined },
      data,
    );
    expect(fallback.text).not.toContain("<at");
  });
});

function createFixture(options: { now?: () => number; ttlMs?: number } = {}) {
  let binding = makeBinding();
  let tokenCounter = 0;
  let cardCounter = 0;
  const api = {
    fetchMessageItems: vi.fn(async () => []),
    createInputCard: vi.fn(async () => {
      cardCounter += 1;
      return {
        cardId: `card-${cardCounter}`,
        messageId: `card-message-${cardCounter}`,
      };
    }),
    updateInputCard: vi.fn(async () => undefined),
  } satisfies FeishuMessageApi & FeishuInteractionApi;
  const fixture = {
    api,
    get binding() {
      return binding;
    },
    set binding(value: FeishuSessionBinding) {
      binding = value;
    },
    manager: undefined as unknown as FeishuSkillSelectionManager,
  };
  fixture.manager = new FeishuSkillSelectionManager({
    getBinding: () => binding,
    now: options.now,
    ttlMs: options.ttlMs,
    createToken: () => {
      tokenCounter += 1;
      return tokenCounter.toString(16).padStart(32, "0");
    },
  });
  return fixture;
}

function makeContext(api: FeishuMessageApi): {
  accountId: string;
  scopeKey: string;
  sessionId: string;
  chatId: string;
  replyToMessageId: string;
  requesterOpenId: string;
  api: FeishuMessageApi;
} {
  return {
    accountId: "team-bot",
    scopeKey: "team-bot:p2p:oc_chat",
    sessionId: "session-1",
    chatId: "oc_chat",
    replyToMessageId: "command-message",
    requesterOpenId: "ou_requester",
    api,
  };
}

function nextMessageScope() {
  return {
    accountId: "team-bot",
    scopeKey: "team-bot:p2p:oc_chat",
    sessionId: "session-1",
    requesterOpenId: "ou_requester",
  };
}

function makeBinding(
  overrides: Partial<FeishuSessionBinding> = {},
): FeishuSessionBinding {
  return {
    version: 1,
    scopeKey: "team-bot:p2p:oc_chat",
    accountId: "team-bot",
    chatId: "oc_chat",
    projectId: "project-1",
    projectPath: "/workspace/project-1",
    sessionId: "session-1",
    provider: "codex",
    permissionMode: "default",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function makeSkills(count: number): unknown {
  return {
    data: [
      {
        cwd: "/opt/yep-fixtures/project",
        skills: Array.from({ length: count }, (_, index) => ({
          name: `skill-${index + 1}`,
          description:
            index === 0
              ? "Read /opt/yep-fixtures/private/SKILL.md safely"
              : `Description ${index + 1}`,
          path: `/opt/yep-fixtures/codex/skills/skill-${index + 1}/SKILL.md`,
          enabled: true,
        })),
        errors: [],
      },
    ],
  };
}

function makeAction(token: string, operatorOpenId: string, messageId: string) {
  return {
    messageId,
    chatId: "oc_chat",
    operatorOpenId,
    actionTag: "button",
    value: { token },
  };
}

function selectedToken(
  api: { createInputCard: ReturnType<typeof vi.fn> },
  cardCallIndex: number,
  actionIndex = 0,
): string {
  const values = findActionValues(
    api.createInputCard.mock.calls[cardCallIndex]?.[1],
  );
  return String(values[actionIndex]?.token ?? "");
}

function findActionValues(value: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.token === "string" &&
      /^[a-f0-9]{32}$/.test(record.token) &&
      Object.keys(record).length === 1
    ) {
      found.push(record);
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return found;
}
