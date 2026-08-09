import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LarkSdkFeishuMessageApi } from "../../../src/channels/feishu/lark-sdk-api.js";
import { FeishuDurableOutbox } from "../../../src/channels/feishu/outbox.js";

const TARGET = {
  chatId: "oc_chat",
  replyToMessageId: "om_source",
  replyInThread: true,
} as const;

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function deliveryIdentity(artifactId: string) {
  return {
    accountId: "account-a",
    sessionId: "session-a",
    threadId: "codex-thread-a",
    turnId: "codex-turn-a",
    itemId: `item-${artifactId}`,
    artifactId,
  };
}

describe("LarkSdkFeishuMessageApi", () => {
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

  it("uploads a validated generated PNG and replies in the source thread", async () => {
    const imageCreate = vi.fn(async () => ({ image_key: "img_generated" }));
    const messageReply = vi.fn(async () => ({
      data: { message_id: "om_generated" },
    }));
    const api = new LarkSdkFeishuMessageApi({
      im: {
        v1: {
          image: { create: imageCreate },
          message: { reply: messageReply, create: vi.fn() },
        },
      },
    } as never);
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);

    await expect(
      api.sendImageReply(TARGET, {
        fileName: "codex-generated-fixture.png",
        mimeType: "image/png",
        bytes,
        sizeBytes: bytes.length,
        sha256: digest(bytes),
        source: "codex_image_generation",
        retention: "feishu_managed",
      }),
    ).resolves.toEqual({
      imageKey: "img_generated",
      messageId: "om_generated",
    });

    expect(imageCreate).toHaveBeenCalledWith({
      data: { image_type: "message", image: bytes },
    });
    expect(messageReply).toHaveBeenCalledWith({
      path: { message_id: TARGET.replyToMessageId },
      data: expect.objectContaining({
        msg_type: "image",
        reply_in_thread: true,
        content: JSON.stringify({ image_key: "img_generated" }),
      }),
    });
  });

  it("uploads generated PDF and MP4 artifacts with their native Feishu message types", async () => {
    const fileCreate = vi
      .fn()
      .mockResolvedValueOnce({ file_key: "file_pdf" })
      .mockResolvedValueOnce({ file_key: "file_video" });
    const messageReply = vi
      .fn()
      .mockResolvedValueOnce({ data: { message_id: "om_pdf" } })
      .mockResolvedValueOnce({ data: { message_id: "om_video" } });
    const api = new LarkSdkFeishuMessageApi({
      im: {
        v1: {
          file: { create: fileCreate },
          message: { reply: messageReply, create: vi.fn() },
        },
      },
    } as never);
    const pdf = Buffer.from("%PDF-1.7\n");
    const mp4 = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);

    await expect(
      api.sendFileReply(TARGET, {
        fileName: "report.pdf",
        mimeType: "application/pdf",
        bytes: pdf,
        sizeBytes: pdf.length,
        sha256: digest(pdf),
        source: "codex_generated_file",
        retention: "feishu_managed",
      }),
    ).resolves.toEqual({ fileKey: "file_pdf", messageId: "om_pdf" });
    await expect(
      api.sendVideoReply(TARGET, {
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        bytes: mp4,
        sizeBytes: mp4.length,
        sha256: digest(mp4),
        source: "codex_generated_file",
        retention: "feishu_managed",
      }),
    ).resolves.toEqual({ fileKey: "file_video", messageId: "om_video" });

    expect(fileCreate).toHaveBeenNthCalledWith(1, {
      data: {
        file_type: "pdf",
        file_name: "report.pdf",
        file: pdf,
      },
    });
    expect(fileCreate).toHaveBeenNthCalledWith(2, {
      data: {
        file_type: "mp4",
        file_name: "clip.mp4",
        file: mp4,
      },
    });
    expect(
      messageReply.mock.calls.map((call) => call[0].data.msg_type),
    ).toEqual(["file", "media"]);
  });

  it("does not send a message or expose upload errors after a native file upload fails", async () => {
    const fileCreate = vi.fn(async () => {
      throw new Error("synthetic-sensitive-upload-detail");
    });
    const messageReply = vi.fn();
    const api = new LarkSdkFeishuMessageApi({
      im: {
        v1: {
          file: { create: fileCreate },
          message: { reply: messageReply, create: vi.fn() },
        },
      },
    } as never);
    const pdf = Buffer.from("%PDF-1.7\n");

    await expect(
      api.sendFileReply(TARGET, {
        fileName: "report.pdf",
        mimeType: "application/pdf",
        bytes: pdf,
        sizeBytes: pdf.length,
        sha256: digest(pdf),
        source: "codex_generated_file",
        retention: "feishu_managed",
      }),
    ).rejects.toThrow();
    expect(messageReply).not.toHaveBeenCalled();
  });

  it("deduplicates repeated artifact delivery with one stable upload and message identity", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-artifact-once-"));
    try {
      const outbox = new FeishuDurableOutbox({ dataDir });
      await outbox.initialize(new Date(1_000));
      const fileCreate = vi.fn(async () => ({ file_key: "file_stable" }));
      const messageReply = vi.fn(async () => ({
        data: { message_id: "om_stable" },
      }));
      const api = new LarkSdkFeishuMessageApi(
        {
          im: {
            v1: {
              file: { create: fileCreate },
              message: { reply: messageReply, create: vi.fn() },
            },
          },
        } as never,
        { outbox, outboxOwner: "account-a", now: () => 1_000 },
      );
      const bytes = Buffer.from("%PDF-1.7\n");
      const upload = {
        fileName: "report.pdf",
        mimeType: "application/pdf",
        bytes,
        sizeBytes: bytes.length,
        sha256: digest(bytes),
        source: "codex_generated_file" as const,
        retention: "feishu_managed" as const,
        deliveryIdentity: deliveryIdentity(`ga_${"a".repeat(32)}`),
      };

      await expect(api.sendFileReply(TARGET, upload)).resolves.toEqual({
        fileKey: "file_stable",
        messageId: "om_stable",
      });
      await expect(api.sendFileReply(TARGET, upload)).resolves.toEqual({
        fileKey: "file_stable",
        messageId: "om_stable",
      });

      expect(fileCreate).toHaveBeenCalledTimes(1);
      expect(messageReply).toHaveBeenCalledTimes(1);
      const persisted = await import("node:fs/promises").then(({ readFile }) =>
        readFile(outbox.filePath, "utf8"),
      );
      expect(persisted).not.toContain("%PDF");
      expect(persisted).not.toContain("report.pdf");
      expect(persisted).not.toContain("codex-thread-a");
      expect(persisted).toContain("file_stable");
      const record = JSON.parse(persisted).records[0];
      expect(record).toMatchObject({
        kind: "message_send",
        payload: { effect: "generated_artifact_send_v1" },
      });
      expect(record.idempotencyKey).toMatch(/^artifact:v1:[a-f0-9]{64}$/);
      expect(record.idempotencyKey.length).toBeLessThanOrEqual(80);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reuses an uploaded key and message uuid when a send fails once", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-artifact-retry-"));
    try {
      const outbox = new FeishuDurableOutbox({ dataDir });
      await outbox.initialize(new Date(1_000));
      let now = 1_000;
      const fileCreate = vi.fn(async () => ({ file_key: "file_retry" }));
      const messageReply = vi
        .fn()
        .mockRejectedValueOnce({ response: { status: 503 } })
        .mockResolvedValueOnce({ data: { message_id: "om_retry" } });
      const api = new LarkSdkFeishuMessageApi(
        {
          im: {
            v1: {
              file: { create: fileCreate },
              message: { reply: messageReply, create: vi.fn() },
            },
          },
        } as never,
        {
          outbox,
          outboxOwner: "account-a",
          maxRateLimitAttempts: 1,
          now: () => now,
        },
      );
      const bytes = Buffer.from("%PDF-1.7\n");
      const upload = {
        fileName: "report.pdf",
        mimeType: "application/pdf",
        bytes,
        sizeBytes: bytes.length,
        sha256: digest(bytes),
        source: "codex_generated_file" as const,
        retention: "feishu_managed" as const,
        deliveryIdentity: deliveryIdentity(`ga_${"b".repeat(32)}`),
      };

      await expect(api.sendFileReply(TARGET, upload)).rejects.toBeDefined();
      now += 500;
      await expect(api.sendFileReply(TARGET, upload)).resolves.toEqual({
        fileKey: "file_retry",
        messageId: "om_retry",
      });

      expect(fileCreate).toHaveBeenCalledTimes(1);
      expect(messageReply).toHaveBeenCalledTimes(2);
      const uuids = messageReply.mock.calls.map((call) => call[0].data.uuid);
      expect(uuids[0]).toBe(uuids[1]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("recovers an uploaded artifact after process restart without uploading again", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "yep-feishu-artifact-restart-"),
    );
    try {
      let now = 1_000;
      const firstOutbox = new FeishuDurableOutbox({ dataDir });
      await firstOutbox.initialize(new Date(now));
      const firstUpload = vi.fn(async () => ({ file_key: "file_restart" }));
      const firstSend = vi.fn(async () => {
        throw { response: { status: 503 } };
      });
      const firstApi = new LarkSdkFeishuMessageApi(
        {
          im: {
            v1: {
              file: { create: firstUpload },
              message: { reply: firstSend, create: vi.fn() },
            },
          },
        } as never,
        {
          outbox: firstOutbox,
          outboxOwner: "account-a",
          maxRateLimitAttempts: 1,
          now: () => now,
        },
      );
      const bytes = Buffer.from("%PDF-1.7\n");
      const upload = {
        fileName: "report.pdf",
        mimeType: "application/pdf",
        bytes,
        sizeBytes: bytes.length,
        sha256: digest(bytes),
        source: "codex_generated_file" as const,
        retention: "feishu_managed" as const,
        deliveryIdentity: deliveryIdentity(`ga_${"c".repeat(32)}`),
      };
      await expect(
        firstApi.sendFileReply(TARGET, upload),
      ).rejects.toBeDefined();
      const firstUuid = firstSend.mock.calls[0]?.[0].data.uuid;

      now += 500;
      const restoredOutbox = new FeishuDurableOutbox({ dataDir });
      await restoredOutbox.initialize(new Date(now));
      const restoredUpload = vi.fn();
      const restoredSend = vi.fn(async () => ({
        data: { message_id: "om_restart" },
      }));
      const restoredApi = new LarkSdkFeishuMessageApi(
        {
          im: {
            v1: {
              file: { create: restoredUpload },
              message: { reply: restoredSend, create: vi.fn() },
            },
          },
        } as never,
        {
          outbox: restoredOutbox,
          outboxOwner: "account-a",
          maxRateLimitAttempts: 1,
          now: () => now,
        },
      );

      await restoredApi.recoverOutbox();
      expect(firstUpload).toHaveBeenCalledTimes(1);
      expect(restoredUpload).not.toHaveBeenCalled();
      expect(restoredSend).toHaveBeenCalledTimes(1);
      expect(restoredSend.mock.calls[0]?.[0].data.uuid).toBe(firstUuid);
      await expect(restoredApi.sendFileReply(TARGET, upload)).resolves.toEqual({
        fileKey: "file_restart",
        messageId: "om_restart",
      });
      expect(restoredSend).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not collide delivery records for distinct artifact identities", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "yep-feishu-artifact-distinct-"),
    );
    try {
      const outbox = new FeishuDurableOutbox({ dataDir });
      await outbox.initialize(new Date(1_000));
      const fileCreate = vi
        .fn()
        .mockResolvedValueOnce({ file_key: "file_one" })
        .mockResolvedValueOnce({ file_key: "file_two" });
      const messageReply = vi
        .fn()
        .mockResolvedValueOnce({ data: { message_id: "om_one" } })
        .mockResolvedValueOnce({ data: { message_id: "om_two" } });
      const api = new LarkSdkFeishuMessageApi(
        {
          im: {
            v1: {
              file: { create: fileCreate },
              message: { reply: messageReply, create: vi.fn() },
            },
          },
        } as never,
        { outbox, outboxOwner: "account-a", now: () => 1_000 },
      );
      const firstBytes = Buffer.from("%PDF-1.7\nfirst");
      // Identical bytes still represent two distinct canonical artifacts.
      const secondBytes = Buffer.from(firstBytes);
      const base = {
        fileName: "report.pdf",
        mimeType: "application/pdf",
        source: "codex_generated_file" as const,
        retention: "feishu_managed" as const,
      };
      await api.sendFileReply(TARGET, {
        ...base,
        bytes: firstBytes,
        sizeBytes: firstBytes.length,
        sha256: digest(firstBytes),
        deliveryIdentity: deliveryIdentity(`ga_${"d".repeat(32)}`),
      });
      await api.sendFileReply(TARGET, {
        ...base,
        bytes: secondBytes,
        sizeBytes: secondBytes.length,
        sha256: digest(secondBytes),
        deliveryIdentity: deliveryIdentity(`ga_${"e".repeat(32)}`),
      });

      expect(fileCreate).toHaveBeenCalledTimes(2);
      expect(messageReply).toHaveBeenCalledTimes(2);
      expect(
        new Set(
          messageReply.mock.calls.map((call) => call[0].data.uuid as string),
        ).size,
      ).toBe(2);
      const persisted = JSON.parse(
        await import("node:fs/promises").then(({ readFile }) =>
          readFile(outbox.filePath, "utf8"),
        ),
      );
      expect(persisted.records).toHaveLength(2);
      expect(
        new Set(persisted.records.map((record: { id: string }) => record.id))
          .size,
      ).toBe(2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a native artifact whose bytes no longer match its digest", async () => {
    const imageCreate = vi.fn();
    const api = new LarkSdkFeishuMessageApi({
      im: {
        v1: {
          image: { create: imageCreate },
          message: { reply: vi.fn(), create: vi.fn() },
        },
      },
    } as never);
    const original = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const replaced = Buffer.from(original);
    replaced[8] = 0x01;

    await expect(
      api.sendImageReply(TARGET, {
        fileName: "generated.png",
        mimeType: "image/png",
        bytes: replaced,
        sizeBytes: replaced.length,
        sha256: digest(original),
        source: "codex_image_generation",
        retention: "feishu_managed",
      }),
    ).rejects.toThrow("FEISHU_GENERATED_IMAGE_INVALID");
    expect(imageCreate).not.toHaveBeenCalled();
  });

  it("rejects a digest-valid artifact whose MIME does not match its bytes", async () => {
    const fileCreate = vi.fn();
    const api = new LarkSdkFeishuMessageApi({
      im: {
        v1: {
          file: { create: fileCreate },
          message: { reply: vi.fn(), create: vi.fn() },
        },
      },
    } as never);
    const pdf = Buffer.from("%PDF-1.7\n");

    await expect(
      api.sendFileReply(TARGET, {
        fileName: "report.txt",
        mimeType: "text/plain",
        bytes: pdf,
        sizeBytes: pdf.length,
        sha256: digest(pdf),
        source: "codex_generated_file",
        retention: "feishu_managed",
      }),
    ).rejects.toThrow("FEISHU_GENERATED_FILE_INVALID");
    expect(fileCreate).not.toHaveBeenCalled();
  });

  it("never falls back from a failed topic reply into the main chat", async () => {
    const messageReply = vi.fn(async () => {
      throw new Error("topic reply unavailable");
    });
    const messageCreate = vi.fn(async () => ({
      data: { message_id: "om_wrong_audience" },
    }));
    const api = new LarkSdkFeishuMessageApi({
      im: {
        v1: {
          message: { reply: messageReply, create: messageCreate },
        },
      },
    } as never);

    await expect(api.sendTextReply(TARGET, "result")).rejects.toThrow(
      "topic reply unavailable",
    );
    expect(messageReply).toHaveBeenCalledTimes(1);
    expect(messageCreate).not.toHaveBeenCalled();

    await expect(
      api.sendTextReply({ ...TARGET, replyInThread: false }, "result"),
    ).resolves.toEqual({ messageId: "om_wrong_audience" });
    expect(messageCreate).toHaveBeenCalledTimes(1);
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

  it("persists a failed 5xx card mutation and recovers it idempotently", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-api-outbox-"));
    try {
      const outbox = new FeishuDurableOutbox({ dataDir });
      await outbox.initialize(new Date(1_000));
      let now = 1_000;
      const contentUpdate = vi
        .fn()
        .mockRejectedValueOnce({ response: { status: 503 } })
        .mockResolvedValueOnce({});
      const api = new LarkSdkFeishuMessageApi(
        {
          cardkit: { v1: { cardElement: { content: contentUpdate } } },
        } as never,
        {
          outbox,
          outboxOwner: "account-a",
          maxRateLimitAttempts: 1,
          now: () => now,
        },
      );

      await expect(
        api.updateStreamingReply("card-recover", "answer", 3),
      ).rejects.toBeDefined();
      const [pending] = outbox.listRecoverable(
        "account-a",
        new Date(now + 500),
      );
      expect(pending).toMatchObject({
        kind: "card_content_update",
        status: "pending",
        attempts: 1,
        lastErrorCode: "HTTP_503",
      });

      now += 500;
      await api.recoverOutbox();
      expect(contentUpdate).toHaveBeenCalledTimes(2);
      expect(outbox.get(pending?.id ?? "")?.status).toBe("delivered");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("retains the stable section identity across durable card retries", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-section-outbox-"));
    try {
      const outbox = new FeishuDurableOutbox({ dataDir });
      await outbox.initialize(new Date(2_000));
      let now = 2_000;
      const contentUpdate = vi
        .fn()
        .mockRejectedValueOnce({ response: { status: 503 } })
        .mockResolvedValueOnce({});
      const api = new LarkSdkFeishuMessageApi(
        {
          cardkit: { v1: { cardElement: { content: contentUpdate } } },
        } as never,
        {
          outbox,
          outboxOwner: "account-a",
          maxRateLimitAttempts: 1,
          now: () => now,
        },
      );

      await expect(
        api.updateStreamingReplySection(
          "card-recover",
          "yep_stream_act_03",
          "第三项工具",
          7,
        ),
      ).rejects.toBeDefined();
      const [pending] = outbox.listRecoverable(
        "account-a",
        new Date(now + 500),
      );
      expect(pending?.payload).toMatchObject({
        cardId: "card-recover",
        elementId: "yep_stream_act_03",
        sequence: 7,
      });

      now += 500;
      await api.recoverOutbox();
      expect(contentUpdate).toHaveBeenLastCalledWith({
        path: {
          card_id: "card-recover",
          element_id: "yep_stream_act_03",
        },
        data: {
          content: "第三项工具",
          sequence: 7,
          uuid: "yep_content_card-recover_7",
        },
      });
      expect(outbox.get(pending?.id ?? "")?.status).toBe("delivered");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("recovers an on-demand card element create with its placement intact", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-create-outbox-"));
    try {
      const outbox = new FeishuDurableOutbox({ dataDir });
      await outbox.initialize(new Date(3_000));
      let now = 3_000;
      const elementCreate = vi
        .fn()
        .mockRejectedValueOnce({ response: { status: 503 } })
        .mockResolvedValueOnce({});
      const api = new LarkSdkFeishuMessageApi(
        {
          cardkit: { v1: { cardElement: { create: elementCreate } } },
        } as never,
        {
          outbox,
          outboxOwner: "account-a",
          maxRateLimitAttempts: 1,
          now: () => now,
        },
      );

      await expect(
        api.createStreamingReplySection(
          "card-recover",
          "yep_stream_act_01",
          "MCP · 进行中",
          { type: "insert_after", targetElementId: "yep_stream_tools" },
          8,
        ),
      ).rejects.toBeDefined();
      const [pending] = outbox.listRecoverable(
        "account-a",
        new Date(now + 500),
      );
      expect(pending).toMatchObject({
        kind: "card_content_update",
        payload: {
          action: "create",
          cardId: "card-recover",
          elementId: "yep_stream_act_01",
          content: "MCP · 进行中",
          placement: {
            type: "insert_after",
            targetElementId: "yep_stream_tools",
          },
          sequence: 8,
        },
      });

      now += 500;
      await api.recoverOutbox();
      expect(elementCreate).toHaveBeenLastCalledWith({
        path: { card_id: "card-recover" },
        data: {
          type: "insert_after",
          target_element_id: "yep_stream_tools",
          elements: JSON.stringify([
            {
              tag: "markdown",
              element_id: "yep_stream_act_01",
              content: "MCP · 进行中",
            },
          ]),
          sequence: 8,
          uuid: "yep_create_card-recover_8",
        },
      });
      expect(outbox.get(pending?.id ?? "")?.status).toBe("delivered");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
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

  it("creates, streams and finalizes a CardKit reply in the source thread", async () => {
    const cardCreate = vi.fn(async () => ({ data: { card_id: "card-1" } }));
    const messageReply = vi.fn(async () => ({
      data: { message_id: "om_reply" },
    }));
    const contentUpdate = vi.fn(async () => ({}));
    const elementCreate = vi.fn(async () => ({}));
    const elementDelete = vi.fn(async () => ({}));
    const settingsUpdate = vi.fn(async () => ({}));
    const api = new LarkSdkFeishuMessageApi({
      cardkit: {
        v1: {
          card: { create: cardCreate, settings: settingsUpdate },
          cardElement: {
            content: contentUpdate,
            create: elementCreate,
            delete: elementDelete,
          },
        },
      },
      im: {
        v1: {
          message: {
            reply: messageReply,
            create: vi.fn(),
          },
        },
      },
    } as never);
    const target = {
      chatId: "oc_chat",
      replyToMessageId: "om_source",
      replyInThread: true,
    };

    await expect(api.createStreamingReply(target, "正在处理")).resolves.toEqual(
      { cardId: "card-1", messageId: "om_reply" },
    );
    await api.createStreamingReplySection(
      "card-1",
      "yep_stream_answer",
      "回复",
      { type: "insert_after", targetElementId: "yep_stream_status" },
      1,
    );
    await api.updateStreamingReply("card-1", "完整回答", 2);
    await api.updateStreamingReplySection(
      "card-1",
      "yep_stream_answer",
      "工具状态",
      3,
    );
    await api.deleteStreamingReplySection("card-1", "yep_stream_answer", 4);
    await api.finishStreamingReply("card-1", 5, "回答摘要");

    const cardSpec = JSON.parse(cardCreate.mock.calls[0]?.[0].data.data);
    expect(cardSpec).toMatchObject({
      schema: "2.0",
      config: { streaming_mode: true },
    });
    const elementIds = cardSpec.body.elements.map(
      (element: { element_id: string }) => element.element_id,
    );
    expect(elementIds).toEqual(["yep_stream_status"]);
    expect(new Set(elementIds).size).toBe(elementIds.length);
    expect(
      elementIds.every((elementId: string) => elementId.length <= 20),
    ).toBe(true);
    expect(messageReply).toHaveBeenCalledWith({
      path: { message_id: "om_source" },
      data: {
        content: JSON.stringify({
          type: "card",
          data: { card_id: "card-1" },
        }),
        msg_type: "interactive",
        reply_in_thread: true,
        uuid: expect.stringMatching(/^yep_message_/),
      },
    });
    expect(cardSpec.body.elements).not.toContainEqual(
      expect.objectContaining({ content: "\u200B" }),
    );
    expect(elementCreate).toHaveBeenCalledWith({
      path: { card_id: "card-1" },
      data: {
        type: "insert_after",
        target_element_id: "yep_stream_status",
        elements: JSON.stringify([
          {
            tag: "markdown",
            element_id: "yep_stream_answer",
            content: "回复",
          },
        ]),
        sequence: 1,
        uuid: "yep_create_card-1_1",
      },
    });
    expect(contentUpdate).toHaveBeenNthCalledWith(1, {
      path: { card_id: "card-1", element_id: "yep_stream_answer" },
      data: {
        content: "完整回答",
        sequence: 2,
        uuid: "yep_content_card-1_2",
      },
    });
    expect(contentUpdate).toHaveBeenNthCalledWith(2, {
      path: { card_id: "card-1", element_id: "yep_stream_answer" },
      data: {
        content: "工具状态",
        sequence: 3,
        uuid: "yep_content_card-1_3",
      },
    });
    expect(elementDelete).toHaveBeenCalledWith({
      path: { card_id: "card-1", element_id: "yep_stream_answer" },
      data: { sequence: 4, uuid: "yep_delete_card-1_4" },
    });
    expect(settingsUpdate).toHaveBeenCalledWith({
      path: { card_id: "card-1" },
      data: {
        settings: JSON.stringify({
          config: {
            streaming_mode: false,
            summary: { content: "回答摘要" },
          },
        }),
        sequence: 5,
        uuid: "yep_settings_card-1_5",
      },
    });
  });

  it("creates and resolves an interactive input card", async () => {
    const cardCreate = vi.fn(async () => ({ data: { card_id: "card-input" } }));
    const cardUpdate = vi.fn(async () => ({}));
    const messageReply = vi.fn(async () => ({
      data: { message_id: "om_input" },
    }));
    const api = new LarkSdkFeishuMessageApi({
      cardkit: { v1: { card: { create: cardCreate, update: cardUpdate } } },
      im: {
        v1: {
          message: { reply: messageReply, create: vi.fn() },
        },
      },
    } as never);
    const target = {
      chatId: "oc_chat",
      replyToMessageId: "om_source",
      replyInThread: false,
    };
    const pendingCard = { schema: "2.0", body: { elements: [] } };
    const resolvedCard = { schema: "2.0", body: { elements: [{}] } };

    await expect(api.createInputCard(target, pendingCard)).resolves.toEqual({
      cardId: "card-input",
      messageId: "om_input",
    });
    await api.updateInputCard("card-input", resolvedCard, 1);

    expect(cardCreate).toHaveBeenCalledWith({
      data: { type: "card_json", data: JSON.stringify(pendingCard) },
    });
    expect(cardUpdate).toHaveBeenCalledWith({
      path: { card_id: "card-input" },
      data: {
        card: { type: "card_json", data: JSON.stringify(resolvedCard) },
        sequence: 1,
        uuid: "yep_input_card-input_1",
      },
    });
  });
});

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}
