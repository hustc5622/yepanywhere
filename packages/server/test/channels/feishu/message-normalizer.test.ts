import { readFile } from "node:fs/promises";
import type { ApiMessageItem } from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import { FeishuMessageNormalizer } from "../../../src/channels/feishu/normalization/message-normalizer.js";
import type {
  FeishuMessageApi,
  FeishuNormalizationError,
} from "../../../src/channels/feishu/normalization/types.js";

const botIdentity = { openId: "bot_fixture", name: "Fixture Bot" };

describe("FeishuMessageNormalizer", () => {
  it("normalizes text mentions and strips only the bot mention", async () => {
    const normalizer = new FeishuMessageNormalizer();
    const result = await normalizer.normalize({
      botIdentity,
      event: makeEvent({
        messageType: "text",
        content: JSON.stringify({ text: "@_user 请和 @_bot 一起分析" }),
        mentions: [
          {
            key: "@_user",
            id: { open_id: "sender_b" },
            name: "协作者",
          },
          {
            key: "@_bot",
            id: { open_id: "bot_fixture" },
            name: "Fixture Bot",
          },
        ],
      }),
    });

    expect(result.content).toBe("@协作者 请和 一起分析");
    expect(result.mentionsBot).toBe(true);
    expect(result).toMatchObject({
      accountId: "unknown",
      eventId: "evt_fixture",
      eventType: "im.message.receive_v1",
      sender: { id: "sender_a", idType: "open_id" },
      relation: {},
      context: {
        mode: "current",
        messageCount: 1,
        truncatedItems: 0,
        failedItems: 0,
        attachmentCount: 0,
        complete: true,
      },
      normalization: {
        warnings: [],
        truncated: false,
        omittedItems: 0,
        omittedResources: 0,
      },
    });
    expect(result.body).toEqual([
      { kind: "text", text: "@协作者 请和 一起分析" },
    ]);
  });

  it.each([
    ["share_chat", { chat_id: "oc_shared" }, "<group_card"],
    ["share_user", { user_id: "ou_shared" }, "<contact_card"],
    ["system", { template: "{user} joined", user: "Alice" }, "Alice joined"],
    ["vote", { topic: "Ship?", options: ["Yes", "No"] }, "Ship?"],
    ["todo", { summary: { title: "Fix regression" } }, "Fix regression"],
    [
      "calendar",
      { summary: "Review", start_time: 1_786_063_200_000 },
      "Review",
    ],
    [
      "general_calendar",
      { summary: "Planning", start_time: 1_786_063_200_000 },
      "Planning",
    ],
    [
      "share_calendar_event",
      { summary: "Demo", start_time: 1_786_063_200_000 },
      "Demo",
    ],
    ["folder", { file_key: "fld_fixture", file_name: "Specs" }, "<folder"],
    [
      "video_chat",
      { topic: "Standup", start_time: 1_786_063_200_000 },
      "Standup",
    ],
  ])(
    "normalizes SDK-supported %s messages",
    async (messageType, body, text) => {
      const result = await new FeishuMessageNormalizer().normalize({
        botIdentity,
        event: makeEvent({ messageType, content: JSON.stringify(body) }),
      });

      expect(result.content).toContain(text);
      expect(result.content).not.toContain("未支持的飞书消息类型");
      expect(result.normalization.warnings).toEqual([]);
    },
  );

  it("applies privacy policy to location and hongbao while retaining stickers", async () => {
    const normalizer = new FeishuMessageNormalizer();
    const location = await normalizer.normalize({
      botIdentity,
      event: makeEvent({
        messageType: "location",
        content: JSON.stringify({
          name: "Office",
          latitude: "31.2304",
          longitude: "121.4737",
        }),
      }),
    });
    expect(location.content).toContain("Office");
    expect(location.content).toContain("精确坐标已按隐私策略隐藏");
    expect(location.content).not.toContain("31.2304");

    const hongbao = await normalizer.normalize({
      botIdentity,
      event: makeEvent({
        messageType: "hongbao",
        content: JSON.stringify({ text: "amount=888" }),
      }),
    });
    expect(hongbao.content).toBe("[红包消息]");

    const sticker = await normalizer.normalize({
      botIdentity,
      event: makeEvent({
        messageType: "sticker",
        content: JSON.stringify({ file_key: "sticker_fixture" }),
      }),
    });
    expect(sticker.resources).toEqual([
      {
        type: "sticker",
        fileKey: "sticker_fixture",
        messageId: "om_fixture",
      },
    ]);
  });

  it("extracts post resources, interactive card text and safe links", async () => {
    const normalizer = new FeishuMessageNormalizer();
    const post = await normalizer.normalize({
      botIdentity,
      event: makeEvent({
        messageType: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "任务说明",
            content: [
              [
                { tag: "text", text: "请查看 " },
                { tag: "a", text: "文档", href: "https://example.test/doc" },
                { tag: "img", image_key: "img_fixture" },
              ],
            ],
          },
        }),
      }),
    });
    expect(post.content).toContain("**任务说明**");
    expect(post.content).toContain("[文档](https://example.test/doc)");
    expect(post.resources).toEqual([
      {
        type: "image",
        fileKey: "img_fixture",
        messageId: "om_fixture",
      },
    ]);

    const interactive = await normalizer.normalize({
      botIdentity,
      event: makeEvent({
        messageType: "interactive",
        content: JSON.stringify({
          header: { title: { tag: "plain_text", content: "处理结果" } },
          elements: [
            { tag: "markdown", content: "任务已完成" },
            {
              tag: "button",
              text: { tag: "plain_text", content: "详情" },
              url: "https://example.test/detail",
              behaviors: [
                {
                  type: "callback",
                  value: {
                    token: "CALLBACK_TOKEN_MUST_NOT_LEAK",
                    url: "https://hidden.example.test/private-token",
                  },
                },
              ],
            },
          ],
        }),
      }),
    });
    expect(interactive.content).toContain("处理结果");
    expect(interactive.content).toContain("任务已完成");
    expect(interactive.content).toContain("https://example.test/detail");
    expect(interactive.content).not.toContain("CALLBACK_TOKEN_MUST_NOT_LEAK");
    expect(interactive.content).not.toContain("hidden.example.test");
    expect(interactive.content).not.toBe("[interactive card]");
  });

  it("supplements a reply with quoted message content", async () => {
    const api = makeApi([
      {
        message_id: "om_parent",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "这是被引用的任务背景" }) },
        sender: { id: "sender_b", sender_type: "user" },
        create_time: "1786063000000",
      },
    ]);
    const normalizer = new FeishuMessageNormalizer();
    const result = await normalizer.normalize({
      botIdentity,
      api,
      event: makeEvent({
        parentId: "om_parent",
        content: JSON.stringify({ text: "分析一下" }),
      }),
    });

    expect(result.content).toContain("> 引用消息（协作者）");
    expect(result.content).toContain("这是被引用的任务背景");
    expect(result.content).toMatch(/分析一下$/);
    expect(result.context).toMatchObject({
      mode: "current+quoted",
      messageCount: 2,
      failedItems: 0,
      complete: true,
    });
    expect(result.relation.quotedMessageId).toBe("om_parent");
    expect(api.fetchMessageItems).toHaveBeenCalledTimes(1);
  });

  it("extracts visible CardKit 2.0 quote text without callback payloads", async () => {
    const api = makeApi([
      {
        message_id: "om_card_parent",
        msg_type: "interactive",
        body: {
          content: JSON.stringify({
            schema: "2.0",
            config: {
              summary: { content: "安全摘要" },
              private_token: "CONFIG_TOKEN_MUST_NOT_LEAK",
            },
            header: {
              title: { tag: "plain_text", content: "机器人回答" },
            },
            body: {
              elements: [
                { tag: "markdown", content: "BASE_READY" },
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "可见按钮" },
                  behaviors: [
                    {
                      type: "callback",
                      value: {
                        token: "CALLBACK_TOKEN_MUST_NOT_LEAK",
                        url: "https://hidden.example.test/private-token",
                      },
                    },
                  ],
                },
              ],
            },
          }),
        },
        sender: { id: "sender_b", sender_type: "app" },
        create_time: "1786063000000",
      },
    ]);
    const result = await new FeishuMessageNormalizer().normalize({
      botIdentity,
      api,
      event: makeEvent({
        parentId: "om_card_parent",
        content: JSON.stringify({ text: "核对引用" }),
      }),
    });

    expect(result.content).toContain("> 引用消息（协作者）");
    expect(result.content).toContain("机器人回答");
    expect(result.content).toContain("BASE_READY");
    expect(result.content).toContain("可见按钮");
    expect(result.content).not.toContain("CONFIG_TOKEN_MUST_NOT_LEAK");
    expect(result.content).not.toContain("CALLBACK_TOKEN_MUST_NOT_LEAK");
    expect(result.content).not.toContain("hidden.example.test");
    expect(result.context).toMatchObject({
      mode: "current+quoted",
      effectiveMode: "current+quoted",
      messageCount: 2,
      failedItems: 0,
      complete: true,
    });
  });

  it("keeps quoted CardKit text bounded", async () => {
    const api = makeApi([
      {
        message_id: "om_large_card_parent",
        msg_type: "interactive",
        body: {
          content: JSON.stringify({
            schema: "2.0",
            body: {
              elements: [
                {
                  tag: "markdown",
                  content: `CARD_PREFIX_${"x".repeat(1_000)}`,
                },
              ],
            },
          }),
        },
        sender: { id: "sender_b", sender_type: "app" },
      },
    ]);
    const result = await new FeishuMessageNormalizer({
      maxContentChars: 160,
    }).normalize({
      botIdentity,
      api,
      event: makeEvent({
        parentId: "om_large_card_parent",
        content: JSON.stringify({ text: "当前问题" }),
      }),
    });

    expect(result.truncated).toBe(true);
    expect(result.content).toContain("CARD_PREFIX_");
    expect(result.content).toContain("[飞书内容因长度限制被截断]");
    expect(result.content.length).toBeLessThan(240);
  });

  it("does not claim topic or quoted history is complete when it was not loaded", async () => {
    const api = makeApi([]);
    const topic = await new FeishuMessageNormalizer().normalize({
      botIdentity,
      api,
      event: makeEvent({
        rootId: "om_topic_root",
        threadId: "omt_topic",
      }),
    });
    expect(topic.context).toEqual(
      expect.objectContaining({
        mode: "topic",
        effectiveMode: "current",
        messageCount: 1,
        complete: false,
        warnings: ["TOPIC_HISTORY_NOT_LOADED"],
      }),
    );
    expect(topic.normalization.warnings).toContain("TOPIC_HISTORY_NOT_LOADED");

    const missingQuote = await new FeishuMessageNormalizer().normalize({
      botIdentity,
      api,
      event: makeEvent({ parentId: "om_missing" }),
    });
    expect(missingQuote.context).toEqual(
      expect.objectContaining({
        mode: "current+quoted",
        effectiveMode: "current",
        failedItems: 1,
        complete: false,
        warnings: ["QUOTED_MESSAGE_UNAVAILABLE"],
      }),
    );
  });

  it("loads bounded topic history and reports whether it is complete", async () => {
    const items: ApiMessageItem[] = [
      {
        message_id: "om_topic_root",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "话题背景" }) },
        sender: { id: "sender_b", sender_type: "user" },
        create_time: "1786063000000",
      },
      {
        message_id: "om_fixture",
        upper_message_id: "om_topic_root",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "当前问题" }) },
        sender: { id: "sender_a", sender_type: "user" },
        create_time: "1786063200000",
      },
    ];
    const completeApi = {
      ...makeApi([]),
      fetchThreadMessageItems: vi.fn(async () => ({
        items,
        hasMore: false,
      })),
    };
    const complete = await new FeishuMessageNormalizer().normalize({
      botIdentity,
      api: completeApi,
      event: makeEvent({
        rootId: "om_topic_root",
        threadId: "omt_topic",
        content: JSON.stringify({ text: "当前问题" }),
      }),
    });

    expect(completeApi.fetchThreadMessageItems).toHaveBeenCalledWith(
      "omt_topic",
      100,
    );
    expect(complete.content).toContain("话题背景");
    expect(complete.content).toContain("当前问题");
    expect(complete.context).toMatchObject({
      mode: "topic",
      effectiveMode: "topic",
      messageCount: 2,
      truncatedItems: 0,
      complete: true,
      warnings: [],
    });

    const truncatedApi = {
      ...makeApi([]),
      fetchThreadMessageItems: vi.fn(async () => ({
        items: items.slice(0, 1),
        hasMore: true,
      })),
    };
    const truncated = await new FeishuMessageNormalizer({
      maxItems: 1,
    }).normalize({
      botIdentity,
      api: truncatedApi,
      event: makeEvent({
        rootId: "om_topic_root",
        threadId: "omt_topic",
        content: JSON.stringify({ text: "当前问题" }),
      }),
    });

    expect(truncated.context).toMatchObject({
      mode: "topic",
      effectiveMode: "topic",
      messageCount: 1,
      truncatedItems: 1,
      complete: false,
      warnings: ["TOPIC_HISTORY_TRUNCATED"],
    });
    expect(truncated.content).toContain("当前问题");
    expect(truncated.content).not.toContain("话题背景");
  });

  it("resolves root-only topic scope to a verified thread container", async () => {
    const resolveThreadId = vi.fn(async () => "omt_resolved");
    const fetchThreadMessageItems = vi.fn(async () => ({
      items: [
        {
          message_id: "om_topic_root",
          msg_type: "text",
          body: { content: JSON.stringify({ text: "根消息背景" }) },
          sender: { id: "sender_b", sender_type: "user" },
          create_time: "1786063000000",
        },
      ],
      hasMore: false,
    }));
    const api = {
      ...makeApi([]),
      resolveThreadId,
      fetchThreadMessageItems,
    };

    const result = await new FeishuMessageNormalizer().normalize({
      botIdentity,
      api,
      event: makeEvent({ rootId: "om_topic_root" }),
    });

    expect(resolveThreadId).toHaveBeenCalledWith("om_topic_root");
    expect(fetchThreadMessageItems).toHaveBeenCalledWith("omt_resolved", 100);
    expect(result.threadId).toBe("omt_resolved");
    expect(result.context).toMatchObject({
      mode: "topic",
      effectiveMode: "topic",
      complete: true,
      warnings: [],
    });
    expect(result.content).toContain("根消息背景");
  });

  it("keeps root-only topic context explicitly incomplete without thread_id", async () => {
    const fetchThreadMessageItems = vi.fn(async () => ({
      items: [],
      hasMore: false,
    }));
    const api = {
      ...makeApi([]),
      resolveThreadId: vi.fn(async () => undefined),
      fetchThreadMessageItems,
    };

    const result = await new FeishuMessageNormalizer().normalize({
      botIdentity,
      api,
      event: makeEvent({ rootId: "om_topic_root" }),
    });

    expect(fetchThreadMessageItems).not.toHaveBeenCalled();
    expect(result.context).toMatchObject({
      mode: "topic",
      effectiveMode: "current",
      complete: false,
      warnings: ["TOPIC_THREAD_ID_UNAVAILABLE"],
    });
    expect(result.normalization.warnings).toContain(
      "TOPIC_THREAD_ID_UNAVAILABLE",
    );
  });

  it("expands the sanitized 29-item fixture in one request with golden Markdown", async () => {
    const [event, response, golden] = await Promise.all([
      readFixture("merge-forward-event.json"),
      readFixture<{ items: ApiMessageItem[] }>(
        "merge-forward-get-29-items.json",
      ),
      readFile(
        new URL(
          "../../fixtures/feishu/merge-forward-29-items.golden.md",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    const api = makeApi(response.items);
    const result = await new FeishuMessageNormalizer().normalize({
      event,
      botIdentity,
      api,
    });

    expect(api.fetchMessageItems).toHaveBeenCalledTimes(1);
    expect(result.forwarded).toMatchObject({
      totalItems: 29,
      readItems: 29,
      truncated: false,
    });
    expect(
      result.forwarded?.entries.filter((entry) => entry.messageType === "text"),
    ).toHaveLength(21);
    expect(
      result.forwarded?.entries.filter(
        (entry) => entry.messageType === "interactive",
      ),
    ).toHaveLength(8);
    expect(result.content).not.toContain("[interactive card]");
    expect(result.content).not.toContain("sender_a");
    expect(`${result.content}\n`).toBe(golden);
  });

  it("recurses nested forwards locally and retains child resources", async () => {
    const items: ApiMessageItem[] = [
      {
        message_id: "om_root",
        msg_type: "merge_forward",
        body: { content: "{}" },
      },
      {
        message_id: "om_nested",
        upper_message_id: "om_root",
        msg_type: "merge_forward",
        body: { content: "{}" },
        sender: { id: "sender_a" },
        create_time: "1000",
      },
      {
        message_id: "om_file",
        upper_message_id: "om_nested",
        msg_type: "file",
        body: {
          content: JSON.stringify({
            file_key: "file_fixture",
            file_name: "report.pdf",
          }),
        },
        sender: { id: "sender_b" },
        create_time: "2000",
      },
      {
        message_id: "om_image",
        upper_message_id: "om_root",
        msg_type: "image",
        body: { content: JSON.stringify({ image_key: "image_fixture" }) },
        sender: { id: "sender_a" },
        create_time: "3000",
      },
    ];
    const api = makeApi(items);
    const result = await new FeishuMessageNormalizer().normalize({
      botIdentity,
      api,
      event: makeEvent({ messageId: "om_root", messageType: "merge_forward" }),
    });

    expect(api.fetchMessageItems).toHaveBeenCalledTimes(1);
    expect(result.forwarded?.entries.map((entry) => entry.messageId)).toEqual([
      "om_nested",
      "om_file",
      "om_image",
    ]);
    expect(result.resources).toEqual([
      {
        type: "file",
        fileKey: "file_fixture",
        fileName: "report.pdf",
        messageId: "om_file",
      },
      {
        type: "image",
        fileKey: "image_fixture",
        messageId: "om_image",
      },
    ]);
  });

  it("uses explicit placeholders for unknown types and rejects invalid events", async () => {
    const normalizer = new FeishuMessageNormalizer();
    const unknown = await normalizer.normalize({
      botIdentity,
      event: makeEvent({ messageType: "future_type" }),
    });
    expect(unknown.content).toBe("[未支持的飞书消息类型: future_type]");
    expect(unknown.body.at(-1)).toEqual({
      kind: "unsupported",
      messageType: "future_type",
    });
    expect(unknown.normalization.warnings).toEqual([
      "UNSUPPORTED_MESSAGE_TYPE:future_type",
    ]);

    await expect(
      normalizer.normalize({ botIdentity, event: { message: {} } }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<FeishuNormalizationError>>({
        code: "INVALID_EVENT",
      }),
    );
  });
});

function makeEvent(
  options: {
    messageId?: string;
    messageType?: string;
    content?: string;
    parentId?: string;
    rootId?: string;
    threadId?: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string };
      name?: string;
    }>;
  } = {},
): unknown {
  return {
    event_id: "evt_fixture",
    tenant_key: "tenant_fixture",
    sender: {
      sender_id: { open_id: "sender_a" },
      sender_type: "user",
      tenant_key: "tenant_fixture",
    },
    message: {
      message_id: options.messageId ?? "om_fixture",
      parent_id: options.parentId,
      root_id: options.rootId,
      thread_id: options.threadId,
      create_time: "1786063200000",
      chat_id: "oc_fixture_chat",
      chat_type: "group",
      message_type: options.messageType ?? "text",
      content: options.content ?? JSON.stringify({ text: "hello" }),
      mentions: options.mentions,
    },
  };
}

function makeApi(items: ApiMessageItem[]): FeishuMessageApi & {
  fetchMessageItems: ReturnType<typeof vi.fn>;
} {
  return {
    fetchMessageItems: vi.fn(async () => items),
    resolveUserNames: vi.fn(async (ids: string[]) => {
      const names = new Map([
        ["sender_a", "桃蹊"],
        ["sender_b", "协作者"],
        ["sender_c", "审核者"],
      ]);
      return new Map(
        ids.flatMap((id) => {
          const name = names.get(id);
          return name ? [[id, name] as const] : [];
        }),
      );
    }),
  };
}

async function readFixture<T = unknown>(name: string): Promise<T> {
  return JSON.parse(
    await readFile(
      new URL(`../../fixtures/feishu/${name}`, import.meta.url),
      "utf8",
    ),
  ) as T;
}
