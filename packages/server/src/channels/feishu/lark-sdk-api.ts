import type * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuMessageApi } from "./normalization/types.js";

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
}

type FeishuApiGroup = "message_read" | "identity" | "media";

export class LarkSdkFeishuMessageApi implements FeishuMessageApi {
  private readonly client: Lark.Client;
  private readonly options: LarkSdkFeishuMessageApiOptions;
  private readonly rateLimitedUntil = new Map<FeishuApiGroup, number>();
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
