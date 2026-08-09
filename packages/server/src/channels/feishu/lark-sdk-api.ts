import { createHash, randomUUID } from "node:crypto";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuMessageApi } from "./normalization/types.js";
import {
  FEISHU_STREAM_ACTIVITY_ELEMENT_IDS,
  FEISHU_STREAM_ANSWER_ELEMENT_ID,
  FEISHU_STREAM_ARTIFACTS_ELEMENT_ID,
  FEISHU_STREAM_ELEMENT_ID,
  FEISHU_STREAM_PROGRESS_ELEMENT_ID,
  FEISHU_STREAM_PROGRESS_ELEMENT_IDS,
  FEISHU_STREAM_STATUS_ELEMENT_ID,
  FEISHU_STREAM_TOOLS_ELEMENT_ID,
  type FeishuInteractionApi,
  type FeishuNativeArtifactUpload,
  type FeishuOutboundApi,
  type FeishuStreamingReply,
  type FeishuStreamingReplyTarget,
  type FeishuStreamingSectionElementId,
  type FeishuStreamingSectionPlacement,
} from "./outbound.js";
import {
  FEISHU_ARTIFACT_DELIVERY_EFFECT,
  type FeishuDurableOutbox,
  type FeishuOutboxRecord,
  isFeishuArtifactDeliveryRecord,
} from "./outbox.js";

const MAX_NAME_CACHE_ENTRIES = 500;
const NAME_LOOKUP_CONCURRENCY = 5;
const DEFAULT_NAME_CACHE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_NEGATIVE_NAME_CACHE_TTL_MS = 60 * 1_000;
const DEFAULT_CHAT_MODE_CACHE_TTL_MS = 10 * 60 * 1_000;

export interface LarkSdkFeishuMessageApiOptions {
  onApiSuccess?(): void;
  maxRateLimitAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?(): number;
  random?(): number;
  sleep?(delayMs: number): Promise<void>;
  nameCacheTtlMs?: number;
  negativeNameCacheTtlMs?: number;
  chatModeCacheTtlMs?: number;
  outbox?: FeishuDurableOutbox;
  outboxOwner?: string;
  maxOutboxAttempts?: number;
}

type FeishuApiGroup =
  | "message_read"
  | "identity"
  | "media"
  | "card"
  | "message_send";
type FeishuRawMessageType = "file" | "image" | "interactive" | "media" | "text";
type FeishuArtifactMessageType = "file" | "image" | "media";

export class LarkSdkFeishuMessageApi
  implements FeishuMessageApi, FeishuOutboundApi, FeishuInteractionApi
{
  private readonly client: Lark.Client;
  private readonly options: LarkSdkFeishuMessageApiOptions;
  private readonly rateLimitedUntil = new Map<FeishuApiGroup, number>();
  private outboxRecoveryTimer?: ReturnType<typeof setTimeout>;
  private readonly nameCache = new Map<
    string,
    { value?: string; expiresAt: number }
  >();
  private readonly chatModeCache = new Map<
    string,
    { value: "p2p" | "group" | "topic"; expiresAt: number }
  >();

  constructor(
    client: Lark.Client,
    options: LarkSdkFeishuMessageApiOptions = {},
  ) {
    this.client = client;
    this.options = options;
  }

  async fetchMessageItems(messageId: string): Promise<Lark.ApiMessageItem[]> {
    const response = await this.call("message_read", () =>
      this.client.im.v1.message.get({
        path: { message_id: messageId },
        params: {
          user_id_type: "open_id",
          card_msg_content_type: "user_card_content",
          with_sender_name: true,
        },
      }),
    );
    return (response.data?.items ?? []).map((item) => {
      if (item.sender?.id && item.sender.sender_name) {
        this.cacheName(item.sender.id, item.sender.sender_name);
      }
      return {
        message_id: item.message_id,
        upper_message_id: item.upper_message_id,
        msg_type: item.msg_type,
        body: item.body,
        sender: item.sender
          ? {
              id: item.sender.id,
              id_type: item.sender.id_type,
              sender_type: item.sender.sender_type,
            }
          : undefined,
        create_time: item.create_time,
        mentions: item.mentions?.map((mention) => ({
          key: mention.key,
          id: {
            ...(mention.id_type === "open_id"
              ? { open_id: mention.id }
              : mention.id_type === "user_id"
                ? { user_id: mention.id }
                : { union_id: mention.id }),
          },
          name: mention.name,
          tenant_key: mention.tenant_key,
        })),
      };
    });
  }

  async resolveThreadId(messageId: string): Promise<string | undefined> {
    const response = await this.call("message_read", () =>
      this.client.im.v1.message.get({
        path: { message_id: messageId },
        params: { user_id_type: "open_id" },
      }),
    );
    const item =
      response.data?.items?.find(
        (candidate) => candidate.message_id === messageId,
      ) ?? response.data?.items?.[0];
    const threadId = item?.thread_id?.trim();
    return threadId || undefined;
  }

  async fetchThreadMessageItems(
    threadId: string,
    maxItems: number,
  ): Promise<{ items: Lark.ApiMessageItem[]; hasMore: boolean }> {
    const boundedMax = Math.max(1, Math.min(500, Math.trunc(maxItems)));
    const items: Lark.ApiMessageItem[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let hasMore = false;
    do {
      const response = await this.call("message_read", () =>
        this.client.im.v1.message.list({
          params: {
            container_id_type: "thread",
            container_id: threadId,
            sort_type: "ByCreateTimeAsc",
            page_size: Math.min(50, boundedMax - items.length),
            card_msg_content_type: "user_card_content",
            with_sender_name: true,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        }),
      );
      for (const item of response.data?.items ?? []) {
        if (items.length >= boundedMax) break;
        if (item.sender?.id && item.sender.sender_name) {
          this.cacheName(item.sender.id, item.sender.sender_name);
        }
        items.push({
          message_id: item.message_id,
          upper_message_id: item.parent_id ?? item.upper_message_id,
          msg_type: item.msg_type,
          body: item.body,
          sender: item.sender
            ? {
                id: item.sender.id,
                id_type: item.sender.id_type,
                sender_type: item.sender.sender_type,
              }
            : undefined,
          create_time: item.create_time,
          mentions: item.mentions?.map((mention) => ({
            key: mention.key,
            id: {
              ...(mention.id_type === "open_id"
                ? { open_id: mention.id }
                : mention.id_type === "user_id"
                  ? { user_id: mention.id }
                  : { union_id: mention.id }),
            },
            name: mention.name,
            tenant_key: mention.tenant_key,
          })),
        });
      }
      hasMore = response.data?.has_more === true;
      const nextPageToken = response.data?.page_token;
      if (
        !hasMore ||
        items.length >= boundedMax ||
        !nextPageToken ||
        seenPageTokens.has(nextPageToken)
      ) {
        break;
      }
      seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    } while (items.length < boundedMax);
    return { items, hasMore };
  }

  async fetchMessageEvent(messageId: string): Promise<unknown> {
    const response = await this.call("message_read", () =>
      this.client.im.v1.message.get({
        path: { message_id: messageId },
        params: {
          user_id_type: "open_id",
          card_msg_content_type: "user_card_content",
          with_sender_name: true,
        },
      }),
    );
    const item =
      response.data?.items?.find(
        (candidate) => candidate.message_id === messageId,
      ) ?? response.data?.items?.[0];
    if (
      !item?.message_id ||
      !item.chat_id ||
      !item.msg_type ||
      !item.sender?.id
    ) {
      throw new Error("FEISHU_MESSAGE_RECOVERY_FAILED");
    }
    const chatMode = await this.getChatMode(item.chat_id);
    return {
      tenant_key: item.sender.tenant_key,
      sender: {
        sender_id: { open_id: item.sender.id },
        sender_type: item.sender.sender_type,
        tenant_key: item.sender.tenant_key,
      },
      message: {
        message_id: item.message_id,
        root_id: item.root_id,
        parent_id: item.parent_id,
        thread_id: item.thread_id,
        create_time: item.create_time,
        update_time: item.update_time,
        chat_id: item.chat_id,
        chat_type: chatMode === "p2p" ? "p2p" : "group",
        message_type: item.msg_type,
        content: item.body?.content ?? "{}",
        mentions: item.mentions?.map((mention) => ({
          key: mention.key,
          id: {
            ...(mention.id_type === "open_id"
              ? { open_id: mention.id }
              : mention.id_type === "user_id"
                ? { user_id: mention.id }
                : { union_id: mention.id }),
          },
          name: mention.name,
          tenant_key: mention.tenant_key,
        })),
      },
    };
  }

  async getChatMode(chatId: string): Promise<"p2p" | "group" | "topic"> {
    const cached = this.chatModeCache.get(chatId);
    if (cached && cached.expiresAt > this.now()) {
      this.chatModeCache.delete(chatId);
      this.chatModeCache.set(chatId, cached);
      return cached.value;
    }
    this.chatModeCache.delete(chatId);
    const response = await this.call("identity", () =>
      this.client.im.v1.chat.get({
        path: { chat_id: chatId },
        params: { user_id_type: "open_id" },
      }),
    );
    const rawMode = response.data?.chat_mode ?? response.data?.chat_type;
    const mode =
      rawMode === "p2p" ? "p2p" : rawMode === "topic" ? "topic" : "group";
    this.chatModeCache.set(chatId, {
      value: mode,
      expiresAt:
        this.now() +
        Math.max(
          0,
          this.options.chatModeCacheTtlMs ?? DEFAULT_CHAT_MODE_CACHE_TTL_MS,
        ),
    });
    while (this.chatModeCache.size > MAX_NAME_CACHE_ENTRIES) {
      const oldest = this.chatModeCache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.chatModeCache.delete(oldest);
    }
    return mode;
  }

  async resolveUserNames(
    openIds: string[],
  ): Promise<ReadonlyMap<string, string>> {
    const uniqueIds = [...new Set(openIds)].slice(0, 100);
    const missing = uniqueIds.filter(
      (openId) => !this.readCachedName(openId).found,
    );
    for (
      let index = 0;
      index < missing.length;
      index += NAME_LOOKUP_CONCURRENCY
    ) {
      const batch = missing.slice(index, index + NAME_LOOKUP_CONCURRENCY);
      await Promise.all(
        batch.map(async (openId) => {
          try {
            const response = await this.call("identity", () =>
              this.client.contact.v3.user.get({
                path: { user_id: openId },
                params: { user_id_type: "open_id" },
              }),
            );
            this.cacheName(openId, response.data?.user?.name);
          } catch {
            this.cacheName(openId, undefined);
          }
        }),
      );
    }

    return new Map(
      uniqueIds.flatMap((openId) => {
        const name = this.readCachedName(openId).value;
        return name ? [[openId, name] as const] : [];
      }),
    );
  }

  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
  ): Promise<AsyncIterable<Uint8Array>> {
    try {
      const response = await this.call("media", () =>
        this.client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: fileKey },
          params: { type },
        }),
      );
      return response.getReadableStream();
    } catch {
      // message.resource does not support forwarded sub-messages. The
      // key-based endpoints are the documented compatibility path.
      const response =
        type === "image"
          ? await this.call("media", () =>
              this.client.im.v1.image.get({ path: { image_key: fileKey } }),
            )
          : await this.call("media", () =>
              this.client.im.v1.file.get({ path: { file_key: fileKey } }),
            );
      return response.getReadableStream();
    }
  }

  async createStreamingReply(
    target: FeishuStreamingReplyTarget,
    initialText: string,
  ): Promise<FeishuStreamingReply> {
    const card = await this.call("card", () =>
      this.client.cardkit.v1.card.create({
        data: {
          type: "card_json",
          data: JSON.stringify(buildStreamingCard(initialText)),
        },
      }),
    );
    const cardId = card.data?.card_id;
    if (!cardId) throw new Error("FEISHU_CARD_CREATE_FAILED");
    const messageId = await this.sendRawMessage(target, "interactive", {
      type: "card",
      data: { card_id: cardId },
    });
    return { cardId, messageId };
  }

  async updateStreamingReply(
    cardId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    await this.deliverMutation(
      `card-content:${cardId}:${sequence}`,
      "card_content_update",
      { cardId, content, sequence },
      () => this.updateStreamingReplyDirect(cardId, content, sequence),
    );
  }

  async updateStreamingReplySection(
    cardId: string,
    elementId: FeishuStreamingSectionElementId,
    content: string,
    sequence: number,
  ): Promise<void> {
    await this.deliverMutation(
      `card-content:${cardId}:${elementId}:${sequence}`,
      "card_content_update",
      { cardId, elementId, content, sequence },
      () =>
        this.updateStreamingReplyDirect(cardId, content, sequence, elementId),
    );
  }

  async createStreamingReplySection(
    cardId: string,
    elementId: FeishuStreamingSectionElementId,
    content: string,
    placement: FeishuStreamingSectionPlacement,
    sequence: number,
  ): Promise<void> {
    await this.deliverMutation(
      `card-element-create:${cardId}:${elementId}:${sequence}`,
      "card_content_update",
      {
        action: "create",
        cardId,
        elementId,
        content,
        placement,
        sequence,
      },
      () =>
        this.createStreamingReplySectionDirect(
          cardId,
          elementId,
          content,
          placement,
          sequence,
        ),
    );
  }

  async deleteStreamingReplySection(
    cardId: string,
    elementId: FeishuStreamingSectionElementId,
    sequence: number,
  ): Promise<void> {
    await this.deliverMutation(
      `card-element-delete:${cardId}:${elementId}:${sequence}`,
      "card_content_update",
      { action: "delete", cardId, elementId, sequence },
      () => this.deleteStreamingReplySectionDirect(cardId, elementId, sequence),
    );
  }

  async finishStreamingReply(
    cardId: string,
    sequence: number,
    summary: string,
  ): Promise<void> {
    await this.deliverMutation(
      `card-finish:${cardId}:${sequence}`,
      "card_finish",
      { cardId, sequence, summary },
      () => this.finishStreamingReplyDirect(cardId, sequence, summary),
    );
  }

  async sendTextReply(
    target: FeishuStreamingReplyTarget,
    text: string,
  ): Promise<{ messageId: string }> {
    return {
      messageId: await this.sendRawMessage(target, "text", { text }),
    };
  }

  async sendImageReply(
    target: FeishuStreamingReplyTarget,
    image: FeishuNativeArtifactUpload,
  ): Promise<{ messageId: string; imageKey: string }> {
    if (
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        image.mimeType,
      ) ||
      image.bytes.length === 0 ||
      image.bytes.length !== image.sizeBytes ||
      !hasExpectedArtifactDigest(image) ||
      !hasExpectedArtifactMime(image) ||
      image.bytes.length > 10 * 1024 * 1024
    ) {
      throw new Error("FEISHU_GENERATED_IMAGE_INVALID");
    }
    const result = await this.sendArtifactReply(
      target,
      image,
      "image",
      async () => {
        const uploaded = await this.call("media", () =>
          this.client.im.v1.image.create({
            data: {
              image_type: "message",
              image: Buffer.from(image.bytes),
            },
          }),
        );
        const imageKey = uploaded?.image_key;
        if (!imageKey) throw new Error("FEISHU_IMAGE_KEY_MISSING");
        return imageKey;
      },
    );
    return { imageKey: result.remoteKey, messageId: result.messageId };
  }

  async sendFileReply(
    target: FeishuStreamingReplyTarget,
    file: FeishuNativeArtifactUpload,
  ): Promise<{ messageId: string; fileKey: string }> {
    this.assertGeneratedFile(file, 30 * 1024 * 1024);
    const result = await this.sendArtifactReply(
      target,
      file,
      "file",
      async () => {
        const uploaded = await this.call("media", () =>
          this.client.im.v1.file.create({
            data: {
              file_type: feishuFileType(file.mimeType),
              file_name: file.fileName,
              file: Buffer.from(file.bytes),
            },
          }),
        );
        const fileKey = uploaded?.file_key;
        if (!fileKey) throw new Error("FEISHU_FILE_KEY_MISSING");
        return fileKey;
      },
    );
    return { fileKey: result.remoteKey, messageId: result.messageId };
  }

  async sendVideoReply(
    target: FeishuStreamingReplyTarget,
    video: FeishuNativeArtifactUpload,
  ): Promise<{ messageId: string; fileKey: string }> {
    this.assertGeneratedFile(video, 30 * 1024 * 1024);
    if (video.mimeType !== "video/mp4") {
      throw new Error("FEISHU_GENERATED_VIDEO_INVALID");
    }
    const result = await this.sendArtifactReply(
      target,
      video,
      "media",
      async () => {
        const uploaded = await this.call("media", () =>
          this.client.im.v1.file.create({
            data: {
              file_type: "mp4",
              file_name: video.fileName,
              file: Buffer.from(video.bytes),
            },
          }),
        );
        const fileKey = uploaded?.file_key;
        if (!fileKey) throw new Error("FEISHU_FILE_KEY_MISSING");
        return fileKey;
      },
    );
    return { fileKey: result.remoteKey, messageId: result.messageId };
  }

  private async sendArtifactReply(
    target: FeishuStreamingReplyTarget,
    artifact: FeishuNativeArtifactUpload,
    messageType: FeishuArtifactMessageType,
    upload: () => Promise<string>,
  ): Promise<{ messageId: string; remoteKey: string }> {
    const idempotencyKey = artifactDeliveryIdempotencyKey(
      this.options.outboxOwner,
      target,
      artifact,
      messageType,
    );
    const outbox = this.options.outbox;
    const owner = this.options.outboxOwner;
    if (!outbox || !owner || !outbox.isOperational()) {
      const remoteKey = await upload();
      return {
        remoteKey,
        messageId: await this.sendArtifactMessageDirect(
          target,
          messageType,
          remoteKey,
          idempotencyKey,
        ),
      };
    }

    const queued = await outbox.enqueue({
      owner,
      idempotencyKey,
      kind: "message_send",
      payload: {
        effect: FEISHU_ARTIFACT_DELIVERY_EFFECT,
        target,
        messageType,
      },
      now: new Date(this.now()),
    });
    const delivered = artifactDeliveryResult(queued);
    if (queued.status === "delivered" && delivered) return delivered;

    const claimed = await outbox.claim(queued.id, new Date(this.now()));
    if (!claimed) throw new Error("FEISHU_OUTBOX_OPERATION_BUSY");
    try {
      let remoteKey = artifactRemoteKey(claimed);
      if (!remoteKey) {
        // Lark's image/file create APIs expose no idempotency parameter. The
        // returned key is persisted before message send so every later retry
        // and restart reuses it. A crash after Lark accepts the upload but
        // before this write remains the upstream-unavoidable duplicate window.
        remoteKey = await upload();
        await outbox.markArtifactUploaded(
          claimed.id,
          remoteKey,
          new Date(this.now()),
        );
      }
      const messageId = await this.sendArtifactMessageDirect(
        target,
        messageType,
        remoteKey,
        claimed.id,
      );
      await outbox.completeArtifact(
        claimed.id,
        messageId,
        new Date(this.now()),
      );
      return { messageId, remoteKey };
    } catch (error) {
      await this.settleOutboxFailure(claimed, error);
      throw error;
    }
  }

  private sendArtifactMessageDirect(
    target: FeishuStreamingReplyTarget,
    messageType: FeishuArtifactMessageType,
    remoteKey: string,
    idempotencyKey: string,
  ): Promise<string> {
    return this.sendRawMessageDirect(
      target,
      messageType,
      messageType === "image"
        ? { image_key: remoteKey }
        : { file_key: remoteKey },
      idempotencyKey,
    );
  }

  private assertGeneratedFile(
    file: FeishuNativeArtifactUpload,
    maxBytes: number,
  ): void {
    if (
      file.bytes.length === 0 ||
      file.bytes.length !== file.sizeBytes ||
      !hasExpectedArtifactDigest(file) ||
      !hasExpectedArtifactMime(file) ||
      file.bytes.length > maxBytes ||
      !file.fileName ||
      file.fileName.length > 120 ||
      hasUnsafeFileNameCharacter(file.fileName)
    ) {
      throw new Error("FEISHU_GENERATED_FILE_INVALID");
    }
  }

  async createInputCard(
    target: FeishuStreamingReplyTarget,
    card: object,
  ): Promise<FeishuStreamingReply> {
    const response = await this.call("card", () =>
      this.client.cardkit.v1.card.create({
        data: { type: "card_json", data: JSON.stringify(card) },
      }),
    );
    const cardId = response.data?.card_id;
    if (!cardId) throw new Error("FEISHU_INPUT_CARD_CREATE_FAILED");
    const messageId = await this.sendRawMessage(target, "interactive", {
      type: "card",
      data: { card_id: cardId },
    });
    return { cardId, messageId };
  }

  async updateInputCard(
    cardId: string,
    card: object,
    sequence: number,
  ): Promise<void> {
    await this.deliverMutation(
      `input-card:${cardId}:${sequence}`,
      "input_card_update",
      { cardId, card, sequence },
      () => this.updateInputCardDirect(cardId, card, sequence),
    );
  }

  async recoverOutbox(): Promise<void> {
    const outbox = this.options.outbox;
    const owner = this.options.outboxOwner;
    if (!outbox || !owner || !outbox.isOperational()) return;
    for (const record of outbox.listRecoverable(owner, new Date(this.now()))) {
      // Upload bytes/paths are deliberately not durable. A record interrupted
      // before it received a remote key waits for the same live artifact to be
      // observed again; uploaded records are fully restart-recoverable.
      if (
        isFeishuArtifactDeliveryRecord(record) &&
        !artifactRemoteKey(record)
      ) {
        continue;
      }
      const claimed = await outbox.claim(record.id, new Date(this.now()));
      if (!claimed) continue;
      try {
        const messageId = await this.executeOutboxRecord(claimed);
        if (isFeishuArtifactDeliveryRecord(claimed)) {
          await outbox.completeArtifact(
            claimed.id,
            requiredString(messageId),
            new Date(this.now()),
          );
        } else {
          await outbox.complete(claimed.id, new Date(this.now()));
        }
      } catch (error) {
        await this.settleOutboxFailure(claimed, error);
      }
    }
  }

  private async sendRawMessage(
    target: FeishuStreamingReplyTarget,
    messageType: FeishuRawMessageType,
    content: object,
  ): Promise<string> {
    const idempotencyKey = `message:${randomUUID()}`;
    return this.deliverMutation(
      idempotencyKey,
      "message_send",
      { target, messageType, content },
      (outboxId) =>
        this.sendRawMessageDirect(
          target,
          messageType,
          content,
          outboxId ?? idempotencyKey,
        ),
    );
  }

  private async sendRawMessageDirect(
    target: FeishuStreamingReplyTarget,
    messageType: FeishuRawMessageType,
    content: object,
    idempotencyKey: string,
  ): Promise<string> {
    const uuid = `yep_${idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(
      0,
      50,
    );
    try {
      const response = await this.call("message_send", () =>
        this.client.im.v1.message.reply({
          path: { message_id: target.replyToMessageId },
          data: {
            content: JSON.stringify(content),
            msg_type: messageType,
            reply_in_thread: target.replyInThread,
            uuid,
          },
        }),
      );
      const messageId = response.data?.message_id;
      if (!messageId) throw new Error("FEISHU_REPLY_MESSAGE_ID_MISSING");
      return messageId;
    } catch (error) {
      // A task accepted inside a topic must never escape into the main chat.
      // Let the durable outbox retry the same thread reply instead of silently
      // changing its audience and context.
      if (target.replyInThread) throw error;
      const response = await this.call("message_send", () =>
        this.client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: target.chatId,
            msg_type: messageType,
            content: JSON.stringify(content),
            uuid,
          },
        }),
      );
      const messageId = response.data?.message_id;
      if (!messageId) throw new Error("FEISHU_CREATE_MESSAGE_ID_MISSING");
      return messageId;
    }
  }

  private updateStreamingReplyDirect(
    cardId: string,
    content: string,
    sequence: number,
    elementId: FeishuStreamingSectionElementId = FEISHU_STREAM_ELEMENT_ID,
  ): Promise<unknown> {
    return this.call("card", () =>
      this.client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: {
          content,
          sequence,
          uuid: `yep_content_${cardId}_${sequence}`,
        },
      }),
    );
  }

  private createStreamingReplySectionDirect(
    cardId: string,
    elementId: FeishuStreamingSectionElementId,
    content: string,
    placement: FeishuStreamingSectionPlacement,
    sequence: number,
  ): Promise<unknown> {
    return this.call("card", () =>
      this.client.cardkit.v1.cardElement.create({
        path: { card_id: cardId },
        data: {
          type: placement.type,
          target_element_id: placement.targetElementId,
          elements: JSON.stringify([
            { tag: "markdown", element_id: elementId, content },
          ]),
          sequence,
          uuid: `yep_create_${cardId}_${sequence}`,
        },
      }),
    );
  }

  private deleteStreamingReplySectionDirect(
    cardId: string,
    elementId: FeishuStreamingSectionElementId,
    sequence: number,
  ): Promise<unknown> {
    return this.call("card", () =>
      this.client.cardkit.v1.cardElement.delete({
        path: { card_id: cardId, element_id: elementId },
        data: {
          sequence,
          uuid: `yep_delete_${cardId}_${sequence}`,
        },
      }),
    );
  }

  private finishStreamingReplyDirect(
    cardId: string,
    sequence: number,
    summary: string,
  ): Promise<unknown> {
    return this.call("card", () =>
      this.client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
              summary: { content: summary },
            },
          }),
          sequence,
          uuid: `yep_settings_${cardId}_${sequence}`,
        },
      }),
    );
  }

  private updateInputCardDirect(
    cardId: string,
    card: object,
    sequence: number,
  ): Promise<unknown> {
    return this.call("card", () =>
      this.client.cardkit.v1.card.update({
        path: { card_id: cardId },
        data: {
          card: { type: "card_json", data: JSON.stringify(card) },
          sequence,
          uuid: `yep_input_${cardId}_${sequence}`,
        },
      }),
    );
  }

  private async deliverMutation<T>(
    idempotencyKey: string,
    kind: FeishuOutboxRecord["kind"],
    payload: Record<string, unknown>,
    operation: (outboxId?: string) => Promise<T>,
  ): Promise<T> {
    const outbox = this.options.outbox;
    const owner = this.options.outboxOwner;
    if (!outbox || !owner || !outbox.isOperational()) return operation();
    const queued = await outbox.enqueue({
      owner,
      idempotencyKey,
      kind,
      payload,
      now: new Date(this.now()),
    });
    const claimed = await outbox.claim(queued.id, new Date(this.now()));
    if (!claimed) {
      // A delivered retry is safe because every supported Feishu mutation has
      // its own upstream UUID/sequence idempotency key.
      if (queued.status === "delivered") return operation(queued.id);
      throw new Error("FEISHU_OUTBOX_OPERATION_BUSY");
    }
    try {
      const result = await operation(claimed.id);
      await outbox.complete(claimed.id, new Date(this.now()));
      return result;
    } catch (error) {
      await this.settleOutboxFailure(claimed, error);
      throw error;
    }
  }

  private async settleOutboxFailure(
    record: FeishuOutboxRecord,
    error: unknown,
  ): Promise<void> {
    const outbox = this.options.outbox;
    if (!outbox) return;
    const retryable =
      readTransientRetryAfterMs(error, this.now()) !== undefined;
    const maxAttempts = Math.max(1, this.options.maxOutboxAttempts ?? 5);
    if (retryable && record.attempts < maxAttempts) {
      const delayMs = Math.min(30_000, 500 * 2 ** (record.attempts - 1));
      await outbox.retry(record.id, {
        errorCode: outboundErrorCode(error),
        delayMs,
        now: new Date(this.now()),
      });
      this.scheduleOutboxRecovery(delayMs);
      return;
    }
    await outbox.deadLetter(
      record.id,
      outboundErrorCode(error),
      new Date(this.now()),
    );
  }

  private scheduleOutboxRecovery(delayMs: number): void {
    if (this.outboxRecoveryTimer) return;
    this.outboxRecoveryTimer = setTimeout(() => {
      this.outboxRecoveryTimer = undefined;
      void this.recoverOutbox();
    }, delayMs);
    this.outboxRecoveryTimer.unref?.();
  }

  private async executeOutboxRecord(
    record: FeishuOutboxRecord,
  ): Promise<string | undefined> {
    const payload = record.payload;
    switch (record.kind) {
      case "card_content_update":
        if (payload.action === "create") {
          await this.createStreamingReplySectionDirect(
            requiredString(payload.cardId),
            requiredStreamingSectionElementId(payload.elementId),
            requiredString(payload.content),
            requiredStreamingSectionPlacement(payload.placement),
            requiredNumber(payload.sequence),
          );
        } else if (payload.action === "delete") {
          await this.deleteStreamingReplySectionDirect(
            requiredString(payload.cardId),
            requiredStreamingSectionElementId(payload.elementId),
            requiredNumber(payload.sequence),
          );
        } else {
          await this.updateStreamingReplyDirect(
            requiredString(payload.cardId),
            requiredString(payload.content),
            requiredNumber(payload.sequence),
            streamingSectionElementId(payload.elementId),
          );
        }
        return;
      case "card_finish":
        await this.finishStreamingReplyDirect(
          requiredString(payload.cardId),
          requiredNumber(payload.sequence),
          requiredString(payload.summary),
        );
        return;
      case "input_card_update":
        await this.updateInputCardDirect(
          requiredString(payload.cardId),
          requiredObject(payload.card),
          requiredNumber(payload.sequence),
        );
        return;
      case "message_send":
        if (isFeishuArtifactDeliveryRecord(record)) {
          return this.sendArtifactMessageDirect(
            requiredTarget(payload.target),
            requiredArtifactMessageType(payload.messageType),
            requiredString(payload.remoteKey),
            record.id,
          );
        }
        return this.sendRawMessageDirect(
          requiredTarget(payload.target),
          requiredMessageType(payload.messageType),
          requiredObject(payload.content),
          record.id,
        );
    }
  }

  private cacheName(openId: string, name: string | undefined): void {
    const value = name?.trim() || undefined;
    this.nameCache.delete(openId);
    this.nameCache.set(openId, {
      value,
      expiresAt:
        this.now() +
        Math.max(
          0,
          value
            ? (this.options.nameCacheTtlMs ?? DEFAULT_NAME_CACHE_TTL_MS)
            : (this.options.negativeNameCacheTtlMs ??
                DEFAULT_NEGATIVE_NAME_CACHE_TTL_MS),
        ),
    });
    while (this.nameCache.size > MAX_NAME_CACHE_ENTRIES) {
      const oldest = this.nameCache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.nameCache.delete(oldest);
    }
  }

  private readCachedName(openId: string): {
    found: boolean;
    value?: string;
  } {
    const cached = this.nameCache.get(openId);
    if (!cached || cached.expiresAt <= this.now()) {
      this.nameCache.delete(openId);
      return { found: false };
    }
    this.nameCache.delete(openId);
    this.nameCache.set(openId, cached);
    return { found: true, value: cached.value };
  }

  private async call<T>(
    group: FeishuApiGroup,
    operation: () => Promise<T>,
  ): Promise<T> {
    const maxAttempts = Math.max(1, this.options.maxRateLimitAttempts ?? 3);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await this.waitForGroup(group);
      try {
        const result = await operation();
        this.options.onApiSuccess?.();
        return result;
      } catch (error) {
        const retryAfterMs = readTransientRetryAfterMs(error, this.now());
        if (retryAfterMs === undefined || attempt + 1 >= maxAttempts) {
          throw error;
        }
        const baseMs = Math.max(0, this.options.retryBaseMs ?? 250);
        const maxMs = Math.max(baseMs, this.options.retryMaxMs ?? 5_000);
        const exponentialMs = Math.min(maxMs, baseMs * 2 ** attempt);
        const jitterMs = Math.round(exponentialMs * 0.25 * this.random());
        const delayMs = Math.max(retryAfterMs, exponentialMs + jitterMs);
        this.rateLimitedUntil.set(
          group,
          Math.max(this.rateLimitedUntil.get(group) ?? 0, this.now() + delayMs),
        );
      }
    }
    throw new Error("FEISHU_API_RETRY_EXHAUSTED");
  }

  private async waitForGroup(group: FeishuApiGroup): Promise<void> {
    const delayMs = Math.max(
      0,
      (this.rateLimitedUntil.get(group) ?? 0) - this.now(),
    );
    if (delayMs > 0) await this.sleep(delayMs);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private random(): number {
    return this.options.random?.() ?? Math.random();
  }

  private sleep(delayMs: number): Promise<void> {
    if (this.options.sleep) return this.options.sleep(delayMs);
    return new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
}

function hasExpectedArtifactDigest(file: FeishuNativeArtifactUpload): boolean {
  return (
    /^sha256:[a-f0-9]{64}$/.test(file.sha256) &&
    `sha256:${createHash("sha256").update(file.bytes).digest("hex")}` ===
      file.sha256
  );
}

function artifactDeliveryIdempotencyKey(
  owner: string | undefined,
  target: FeishuStreamingReplyTarget,
  artifact: FeishuNativeArtifactUpload,
  messageType: FeishuArtifactMessageType,
): string {
  const identity = artifact.deliveryIdentity;
  const hash = createHash("sha256");
  const append = (value: string): void => {
    hash.update(String(Buffer.byteLength(value)));
    hash.update(":");
    hash.update(value);
  };
  append("feishu-artifact-delivery-v1");
  append(owner ?? identity?.accountId ?? "unscoped-account");
  append(identity?.accountId ?? "");
  append(identity?.sessionId ?? target.replyToMessageId);
  append(identity?.threadId ?? target.chatId);
  append(identity?.turnId ?? target.replyToMessageId);
  append(identity?.itemId ?? artifact.fileName);
  append(identity?.artifactId ?? artifact.sha256);
  append(artifact.sha256);
  append(messageType);
  append(target.chatId);
  append(target.replyToMessageId);
  append(target.replyInThread ? "thread" : "chat");
  return `artifact:v1:${hash.digest("hex")}`;
}

function artifactRemoteKey(record: FeishuOutboxRecord): string | undefined {
  const value = record.payload.remoteKey;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function artifactDeliveryResult(
  record: FeishuOutboxRecord,
): { messageId: string; remoteKey: string } | undefined {
  const remoteKey = artifactRemoteKey(record);
  const messageId = record.payload.messageId;
  return remoteKey && typeof messageId === "string" && messageId.length > 0
    ? { messageId, remoteKey }
    : undefined;
}

function hasExpectedArtifactMime(file: FeishuNativeArtifactUpload): boolean {
  const extension = file.fileName.split(".").pop()?.toLowerCase() ?? "";
  const allowedExtensions: Record<string, readonly string[]> = {
    "image/png": ["png"],
    "image/jpeg": ["jpg", "jpeg"],
    "image/gif": ["gif"],
    "image/webp": ["webp"],
    "application/pdf": ["pdf"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
      "docx",
    ],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
      "xlsx",
    ],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      ["pptx"],
    "text/plain": ["txt", "md", "markdown"],
    "text/csv": ["csv"],
    "application/json": ["json"],
    "video/mp4": ["mp4"],
  };
  if (!allowedExtensions[file.mimeType]?.includes(extension)) return false;
  const bytes = Buffer.from(file.bytes);
  switch (file.mimeType) {
    case "image/png":
      return bytes
        .subarray(0, 8)
        .equals(Buffer.from("89504e470d0a1a0a", "hex"));
    case "image/jpeg":
      return bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(
        bytes.subarray(0, 6).toString("ascii"),
      );
    case "image/webp":
      return (
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
    case "application/pdf":
      return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    case "video/mp4":
      return (
        bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp"
      );
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return bytes.subarray(0, 4).equals(Buffer.from("504b0304", "hex"));
    case "application/json":
      try {
        JSON.parse(bytes.toString("utf8"));
        return true;
      } catch {
        return false;
      }
    case "text/plain":
    case "text/csv":
      return (
        !bytes.includes(0) &&
        bytes.subarray(0, 5).toString("ascii") !== "%PDF-" &&
        !bytes.subarray(0, 4).equals(Buffer.from("504b0304", "hex")) &&
        !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      );
    default:
      return false;
  }
}

function readRateLimitRetryAfterMs(
  error: unknown,
  now: number,
): number | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const status = numberValue(record?.status) ?? numberValue(response?.status);
  const code = numberValue(record?.code) ?? numberValue(response?.code);
  if (status !== 429 && code !== 429 && code !== 99991400) return undefined;

  const headers = response?.headers ?? record?.headers;
  const raw = readHeader(headers, "retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function readTransientRetryAfterMs(
  error: unknown,
  now: number,
): number | undefined {
  const rateLimit = readRateLimitRetryAfterMs(error, now);
  if (rateLimit !== undefined) return rateLimit;
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const status = numberValue(record?.status) ?? numberValue(response?.status);
  return status !== undefined && status >= 500 && status <= 599 ? 0 : undefined;
}

function outboundErrorCode(error: unknown): string {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const status = numberValue(record?.status) ?? numberValue(response?.status);
  const code = numberValue(record?.code) ?? numberValue(response?.code);
  if (status !== undefined) return `HTTP_${status}`;
  if (code !== undefined) return `FEISHU_${code}`;
  return "FEISHU_OUTBOUND_FAILED";
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("FEISHU_OUTBOX_PAYLOAD_INVALID");
  }
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("FEISHU_OUTBOX_PAYLOAD_INVALID");
  }
  return value;
}

function requiredObject(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  if (!result) throw new Error("FEISHU_OUTBOX_PAYLOAD_INVALID");
  return result;
}

function requiredTarget(value: unknown): FeishuStreamingReplyTarget {
  const target = requiredObject(value);
  if (
    typeof target.chatId !== "string" ||
    typeof target.replyToMessageId !== "string" ||
    typeof target.replyInThread !== "boolean"
  ) {
    throw new Error("FEISHU_OUTBOX_PAYLOAD_INVALID");
  }
  return {
    chatId: target.chatId,
    replyToMessageId: target.replyToMessageId,
    replyInThread: target.replyInThread,
  };
}

function requiredMessageType(value: unknown): FeishuRawMessageType {
  if (
    value !== "file" &&
    value !== "image" &&
    value !== "interactive" &&
    value !== "media" &&
    value !== "text"
  ) {
    throw new Error("FEISHU_OUTBOX_PAYLOAD_INVALID");
  }
  return value;
}

function requiredArtifactMessageType(
  value: unknown,
): FeishuArtifactMessageType {
  const messageType = requiredMessageType(value);
  if (
    messageType !== "image" &&
    messageType !== "file" &&
    messageType !== "media"
  ) {
    throw new Error("FEISHU_OUTBOX_PAYLOAD_INVALID");
  }
  return messageType;
}

function feishuFileType(
  mimeType: string,
): "doc" | "pdf" | "ppt" | "stream" | "xls" {
  switch (mimeType) {
    case "application/pdf":
      return "pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "doc";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return "xls";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return "ppt";
    default:
      return "stream";
  }
}

function hasUnsafeFileNameCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      character === "/" ||
      character === "\\"
    ) {
      return true;
    }
  }
  return false;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const value = get.call(headers, name) as unknown;
    return typeof value === "string" ? value : undefined;
  }
  const record = headers as Record<string, unknown>;
  const matchingKey = Object.keys(record).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  const value = matchingKey ? record[matchingKey] : undefined;
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildStreamingCard(initialText: string): object {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: { content: "Codex 正在处理" },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: FEISHU_STREAM_STATUS_ELEMENT_ID,
          content: initialText || "正在处理…",
        },
      ],
    },
  };
}

function requiredStreamingSectionPlacement(
  value: unknown,
): FeishuStreamingSectionPlacement {
  const record = asRecord(value);
  if (record?.type !== "insert_after") {
    throw new Error("Invalid Feishu streaming section placement");
  }
  return {
    type: "insert_after",
    targetElementId: requiredStreamingSectionElementId(record.targetElementId),
  };
}

function requiredStreamingSectionElementId(
  value: unknown,
): FeishuStreamingSectionElementId {
  const elementId = streamingSectionElementId(value);
  if (elementId === FEISHU_STREAM_ELEMENT_ID && value !== elementId) {
    throw new Error("Invalid Feishu streaming section element id");
  }
  return elementId;
}

function streamingSectionElementId(
  value: unknown,
): FeishuStreamingSectionElementId {
  if (
    value === FEISHU_STREAM_STATUS_ELEMENT_ID ||
    value === FEISHU_STREAM_PROGRESS_ELEMENT_ID ||
    value === FEISHU_STREAM_TOOLS_ELEMENT_ID ||
    value === FEISHU_STREAM_ARTIFACTS_ELEMENT_ID ||
    value === FEISHU_STREAM_ANSWER_ELEMENT_ID ||
    FEISHU_STREAM_PROGRESS_ELEMENT_IDS.some(
      (elementId) => elementId === value,
    ) ||
    FEISHU_STREAM_ACTIVITY_ELEMENT_IDS.some((elementId) => elementId === value)
  ) {
    return value as FeishuStreamingSectionElementId;
  }
  return FEISHU_STREAM_ELEMENT_ID;
}
