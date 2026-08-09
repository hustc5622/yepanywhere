import { describe, expect, it, vi } from "vitest";
import { LarkSdkFeishuMessageApi } from "../../../src/channels/feishu/lark-sdk-api.js";

describe("LarkSdkFeishuMessageApi inbound adapter", () => {
  it("requests user-visible card content once and reuses sender names from the response", async () => {
    const messageGet = vi.fn(async () => ({
      data: {
        items: [
          {
            message_id: "om_child",
            upper_message_id: "om_root",
            msg_type: "interactive",
            body: { content: "{}" },
            create_time: "1000",
            sender: {
              id: "sender_a",
              id_type: "open_id",
              sender_type: "user",
              sender_name: "脱敏用户",
            },
            mentions: [
              {
                key: "@_user",
                id: "sender_b",
                id_type: "open_id",
                name: "协作者",
              },
            ],
          },
        ],
      },
    }));
    const contactGet = vi.fn();
    const onApiSuccess = vi.fn();
    const api = new LarkSdkFeishuMessageApi(
      {
        im: { v1: { message: { get: messageGet } } },
        contact: { v3: { user: { get: contactGet } } },
      } as never,
      { onApiSuccess },
    );

    const items = await api.fetchMessageItems("om_root");
    const names = await api.resolveUserNames(["sender_a"]);

    expect(messageGet).toHaveBeenCalledWith({
      path: { message_id: "om_root" },
      params: {
        user_id_type: "open_id",
        card_msg_content_type: "user_card_content",
        with_sender_name: true,
      },
    });
    expect(items[0]?.mentions?.[0]).toMatchObject({
      key: "@_user",
      id: { open_id: "sender_b" },
    });
    expect(names.get("sender_a")).toBe("脱敏用户");
    expect(contactGet).not.toHaveBeenCalled();
    expect(onApiSuccess).toHaveBeenCalledTimes(1);
  });

  it("resolves a thread container only from the message thread_id field", async () => {
    const messageGet = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          items: [{ message_id: "om_root", thread_id: "omt_verified" }],
        },
      })
      .mockResolvedValueOnce({
        data: { items: [{ message_id: "om_plain", root_id: "om_root" }] },
      });
    const api = new LarkSdkFeishuMessageApi({
      im: { v1: { message: { get: messageGet } } },
    } as never);

    await expect(api.resolveThreadId("om_root")).resolves.toBe("omt_verified");
    await expect(api.resolveThreadId("om_plain")).resolves.toBeUndefined();
    expect(messageGet).toHaveBeenNthCalledWith(1, {
      path: { message_id: "om_root" },
      params: { user_id_type: "open_id" },
    });
  });

  it("paginates thread history in ascending order and keeps the result bounded", async () => {
    const messageList = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              message_id: "om_root",
              msg_type: "text",
              body: { content: '{"text":"root"}' },
              create_time: "1000",
              sender: {
                id: "sender_root",
                sender_type: "user",
                sender_name: "Root Sender",
              },
            },
            {
              message_id: "om_reply_1",
              parent_id: "om_root",
              msg_type: "text",
              body: { content: '{"text":"reply one"}' },
              create_time: "2000",
            },
          ],
          has_more: true,
          page_token: "page-2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              message_id: "om_reply_2",
              parent_id: "om_root",
              msg_type: "text",
              body: { content: '{"text":"reply two"}' },
              create_time: "3000",
            },
          ],
          has_more: true,
          page_token: "page-3",
        },
      });
    const contactGet = vi.fn();
    const api = new LarkSdkFeishuMessageApi({
      im: { v1: { message: { list: messageList } } },
      contact: { v3: { user: { get: contactGet } } },
    } as never);

    const result = await api.fetchThreadMessageItems("omt_thread", 3);

    expect(messageList).toHaveBeenNthCalledWith(1, {
      params: {
        container_id_type: "thread",
        container_id: "omt_thread",
        sort_type: "ByCreateTimeAsc",
        page_size: 3,
        card_msg_content_type: "user_card_content",
        with_sender_name: true,
      },
    });
    expect(messageList).toHaveBeenNthCalledWith(2, {
      params: expect.objectContaining({
        container_id_type: "thread",
        container_id: "omt_thread",
        page_size: 1,
        page_token: "page-2",
      }),
    });
    expect(result).toMatchObject({
      hasMore: true,
      items: [
        { message_id: "om_root" },
        { message_id: "om_reply_1", upper_message_id: "om_root" },
        { message_id: "om_reply_2", upper_message_id: "om_root" },
      ],
    });
    await expect(api.resolveUserNames(["sender_root"])).resolves.toEqual(
      new Map([["sender_root", "Root Sender"]]),
    );
    expect(contactGet).not.toHaveBeenCalled();
  });

  it("falls back to key-based media APIs for forwarded child resources", async () => {
    const stream = chunks(Buffer.from("image"));
    const messageResourceGet = vi.fn(async () => {
      throw new Error("forwarded child unsupported");
    });
    const imageGet = vi.fn(async () => ({ getReadableStream: () => stream }));
    const api = new LarkSdkFeishuMessageApi({
      im: {
        v1: {
          messageResource: { get: messageResourceGet },
          image: { get: imageGet },
        },
      },
    } as never);

    const result = await api.downloadMessageResource(
      "om_child",
      "img_fixture",
      "image",
    );

    expect(result).toBe(stream);
    expect(imageGet).toHaveBeenCalledWith({
      path: { image_key: "img_fixture" },
    });
  });

  it("retries HTTP 429 responses with an account-local bounded backoff", async () => {
    const messageGet = vi
      .fn()
      .mockRejectedValueOnce({
        response: { status: 429, headers: { "retry-after": "0" } },
      })
      .mockResolvedValueOnce({ data: { items: [] } });
    const sleep = vi.fn(async () => undefined);
    const onApiSuccess = vi.fn();
    const api = new LarkSdkFeishuMessageApi(
      { im: { v1: { message: { get: messageGet } } } } as never,
      {
        retryBaseMs: 10,
        random: () => 0,
        sleep,
        now: () => 1_000,
        onApiSuccess,
      },
    );

    await expect(api.fetchMessageItems("om_retry")).resolves.toEqual([]);
    expect(messageGet).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
    expect(onApiSuccess).toHaveBeenCalledTimes(1);
  });

  it("expires account-scoped display-name cache entries", async () => {
    let now = 1_000;
    const contactGet = vi
      .fn()
      .mockResolvedValueOnce({ data: { user: { name: "First" } } })
      .mockResolvedValueOnce({ data: { user: { name: "Updated" } } });
    const api = new LarkSdkFeishuMessageApi(
      { contact: { v3: { user: { get: contactGet } } } } as never,
      { nameCacheTtlMs: 10, now: () => now },
    );

    await expect(api.resolveUserNames(["ou_user"])).resolves.toEqual(
      new Map([["ou_user", "First"]]),
    );
    now += 11;
    await expect(api.resolveUserNames(["ou_user"])).resolves.toEqual(
      new Map([["ou_user", "Updated"]]),
    );
    expect(contactGet).toHaveBeenCalledTimes(2);
  });

  it("rebuilds a receive event for durable-inbox recovery", async () => {
    const messageGet = vi.fn(async () => ({
      data: {
        items: [
          {
            message_id: "om_recover",
            root_id: "om_root",
            thread_id: "omt_thread",
            chat_id: "oc_topic",
            msg_type: "text",
            body: { content: '{"text":"recover me"}' },
            sender: {
              id: "ou_user",
              id_type: "open_id",
              sender_type: "user",
              tenant_key: "tenant-a",
            },
            mentions: [
              {
                key: "@_user_1",
                id: "ou_bot",
                id_type: "open_id",
                name: "Bot",
              },
            ],
          },
        ],
      },
    }));
    const chatGet = vi.fn(async () => ({ data: { chat_mode: "topic" } }));
    const api = new LarkSdkFeishuMessageApi({
      im: {
        v1: {
          message: { get: messageGet },
          chat: { get: chatGet },
        },
      },
    } as never);

    await expect(api.fetchMessageEvent("om_recover")).resolves.toMatchObject({
      tenant_key: "tenant-a",
      sender: { sender_id: { open_id: "ou_user" } },
      message: {
        message_id: "om_recover",
        root_id: "om_root",
        thread_id: "omt_thread",
        chat_id: "oc_topic",
        chat_type: "group",
        message_type: "text",
        content: '{"text":"recover me"}',
        mentions: [{ id: { open_id: "ou_bot" } }],
      },
    });
    await expect(api.getChatMode("oc_topic")).resolves.toBe("topic");
    expect(messageGet).toHaveBeenCalledWith({
      path: { message_id: "om_recover" },
      params: {
        user_id_type: "open_id",
        card_msg_content_type: "user_card_content",
        with_sender_name: true,
      },
    });
    expect(chatGet).toHaveBeenCalledTimes(1);
  });
});

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}
