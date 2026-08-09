import {
  type FeishuAccountConfig,
  FeishuAccountConfigSchema,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { resolveFeishuScope } from "../../../src/channels/feishu/scope.js";

type ScopeMessage = Parameters<typeof resolveFeishuScope>[0]["message"];

describe("resolveFeishuScope", () => {
  it("uses one stable scope per private chat", () => {
    expect(
      resolveFeishuScope({
        account: makeAccount(),
        message: makeMessage({ chatType: "p2p" }),
      }),
    ).toEqual({
      key: "team-bot:p2p:oc_fixture",
      kind: "p2p",
      accountId: "team-bot",
      chatId: "oc_fixture",
    });
  });

  it("uses thread_id for thread-aware group accounts", () => {
    expect(
      resolveFeishuScope({
        account: makeAccount(),
        message: makeMessage({ threadId: "omt_thread" }),
      }),
    ).toMatchObject({
      key: "team-bot:thread:oc_fixture:omt_thread",
      kind: "thread",
      threadId: "omt_thread",
    });
  });

  it("uses root_id only after chat metadata confirms topic mode", () => {
    const message = makeMessage({ rootId: "om_root" });
    expect(resolveFeishuScope({ account: makeAccount(), message }).kind).toBe(
      "group",
    );
    expect(
      resolveFeishuScope({
        account: makeAccount(),
        message,
        chatMode: "topic",
      }),
    ).toMatchObject({
      key: "team-bot:thread:oc_fixture:om_root",
      kind: "thread",
    });
  });

  it("keeps merge_forward message IDs out of scope keys", () => {
    const scope = resolveFeishuScope({
      account: makeAccount({ groupSessionMode: "chat" }),
      message: makeMessage({
        messageId: "om_forward_material",
        messageType: "merge_forward",
        threadId: "omt_ignored",
      }),
    });

    expect(scope.key).toBe("team-bot:group:oc_fixture");
    expect(scope.key).not.toContain("om_forward_material");
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
    allowedUsers: ["sender_a"],
    ...overrides,
  });
}

function makeMessage(overrides: Partial<ScopeMessage> = {}): ScopeMessage {
  return {
    chatId: "oc_fixture",
    chatType: "group",
    ...overrides,
  };
}
