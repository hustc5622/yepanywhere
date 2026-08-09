import {
  type FeishuAccountConfig,
  FeishuAccountConfigSchema,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  type FeishuMessageIdentity,
  authorizeFeishuAdmin,
  authorizeFeishuApproval,
  authorizeFeishuMessage,
} from "../../../src/channels/feishu/policy.js";

describe("Feishu channel policy", () => {
  it("locks an account that has no user or admin allowlist", () => {
    const account = makeAccount({ allowedUsers: [], adminUsers: [] });
    expect(authorizeFeishuMessage(account, makeIdentity())).toEqual({
      allowed: false,
      reason: "account_locked",
    });
  });

  it("requires allowed user, allowed group and a bot mention in groups", () => {
    const account = makeAccount();

    expect(
      authorizeFeishuMessage(account, makeIdentity({ mentionsBot: false })),
    ).toEqual({ allowed: false, reason: "mention_required" });
    expect(
      authorizeFeishuMessage(account, makeIdentity({ chatId: "oc_unknown" })),
    ).toEqual({ allowed: false, reason: "chat_not_allowed" });
    expect(
      authorizeFeishuMessage(
        account,
        makeIdentity({ senderOpenId: "ou_unknown" }),
      ),
    ).toEqual({ allowed: false, reason: "user_not_allowed" });
    expect(authorizeFeishuMessage(account, makeIdentity())).toEqual({
      allowed: true,
      role: "user",
    });
    expect(
      authorizeFeishuMessage(makeAccount({ allowedChats: [] }), makeIdentity()),
    ).toEqual({ allowed: false, reason: "chat_not_allowed" });
  });

  it("rejects bot loops and tenant mismatches", () => {
    const account = makeAccount({ tenantKey: "tenant-a" });

    expect(
      authorizeFeishuMessage(
        account,
        makeIdentity({ senderOpenId: "ou_bot", botOpenId: "ou_bot" }),
      ),
    ).toEqual({ allowed: false, reason: "bot_message" });
    expect(
      authorizeFeishuMessage(account, makeIdentity({ tenantKey: "tenant-b" })),
    ).toEqual({ allowed: false, reason: "tenant_mismatch" });
  });

  it("separates admin commands and operation-bound approvals", () => {
    const account = makeAccount();

    expect(authorizeFeishuAdmin(account, "ou_admin")).toBe(true);
    expect(authorizeFeishuAdmin(account, "ou_user")).toBe(false);
    expect(authorizeFeishuApproval(account, "ou_user", ["ou_user"])).toBe(true);
    expect(authorizeFeishuApproval(account, "ou_other", ["ou_user"])).toBe(
      false,
    );
  });
});

function makeAccount(
  overrides: Partial<FeishuAccountConfig> = {},
): FeishuAccountConfig {
  return FeishuAccountConfigSchema.parse({
    id: "team-bot",
    name: "Team Bot",
    enabled: true,
    appId: "cli_0123456789abcdef",
    secretRef: "store:team-bot",
    allowedUsers: ["ou_user"],
    adminUsers: ["ou_admin"],
    allowedChats: ["oc_allowed"],
    ...overrides,
  });
}

function makeIdentity(
  overrides: Partial<FeishuMessageIdentity> = {},
): FeishuMessageIdentity {
  return {
    senderOpenId: "ou_user",
    chatId: "oc_allowed",
    chatType: "group",
    mentionsBot: true,
    tenantKey: "tenant-a",
    ...overrides,
  };
}
