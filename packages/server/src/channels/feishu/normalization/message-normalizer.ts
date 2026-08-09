import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuBotIdentity } from "../transport.js";
import {
  type FeishuForwardEntry,
  type FeishuForwardedContent,
  type FeishuMessageApi,
  type FeishuMessageNormalizerOptions,
  FeishuNormalizationError,
  type FeishuNormalizeInput,
  type FeishuNormalizedInboundMessage,
  type FeishuQuotedContent,
} from "./types.js";

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_CONTENT_CHARS = 100_000;
const DEFAULT_MAX_RESOURCES = 20;

export const FEISHU_MESSAGE_TYPE_REGISTRY = {
  text: { kind: "text", privacy: "standard" },
  post: { kind: "rich-text", privacy: "standard" },
  image: { kind: "media", privacy: "standard" },
  file: { kind: "media", privacy: "standard" },
  audio: { kind: "media", privacy: "standard" },
  video: { kind: "media", privacy: "standard" },
  media: { kind: "media", privacy: "standard" },
  sticker: { kind: "media", privacy: "standard" },
  interactive: { kind: "card", privacy: "standard" },
  merge_forward: { kind: "relation", privacy: "standard" },
  share_chat: { kind: "reference", privacy: "sensitive" },
  share_user: { kind: "reference", privacy: "sensitive" },
  location: { kind: "location", privacy: "sensitive" },
  system: { kind: "system", privacy: "standard" },
  vote: { kind: "structured", privacy: "standard" },
  todo: { kind: "structured", privacy: "sensitive" },
  calendar: { kind: "structured", privacy: "sensitive" },
  general_calendar: { kind: "structured", privacy: "sensitive" },
  share_calendar_event: { kind: "structured", privacy: "sensitive" },
  folder: { kind: "reference", privacy: "sensitive" },
  hongbao: { kind: "financial", privacy: "restricted" },
  video_chat: { kind: "structured", privacy: "sensitive" },
} as const;

export type SupportedFeishuMessageType =
  keyof typeof FEISHU_MESSAGE_TYPE_REGISTRY;

export function isSupportedFeishuMessageType(
  value: string,
): value is SupportedFeishuMessageType {
  return Object.hasOwn(FEISHU_MESSAGE_TYPE_REGISTRY, value);
}

export class FeishuMessageNormalizer {
  private readonly maxItems: number;
  private readonly maxDepth: number;
  private readonly maxContentChars: number;
  private readonly maxResources: number;

  constructor(options: FeishuMessageNormalizerOptions = {}) {
    this.maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
    this.maxResources = options.maxResources ?? DEFAULT_MAX_RESOURCES;
  }

  async normalize(
    input: FeishuNormalizeInput,
  ): Promise<FeishuNormalizedInboundMessage> {
    const event = parseRawMessageEvent(input.event);
    const nameCache = new Map<string, string>();
    const fetchCache = new Map<string, Promise<Lark.ApiMessageItem[]>>();
    const fetchItems = (messageId: string): Promise<Lark.ApiMessageItem[]> => {
      if (!input.api) return Promise.resolve([]);
      const existing = fetchCache.get(messageId);
      if (existing) return existing;
      const request = input.api.fetchMessageItems(messageId);
      fetchCache.set(messageId, request);
      return request;
    };

    await resolveNames(input.api, collectEventUserIds(event), nameCache);

    try {
      const main =
        event.message.message_type === "merge_forward"
          ? await this.normalizeMergeForward(
              event,
              input.botIdentity,
              input.api,
              fetchItems,
              nameCache,
            )
          : await normalizeSingleEvent(event, input.botIdentity, nameCache);

      const topicResult =
        event.message.thread_id || event.message.root_id
          ? await this.normalizeTopic(
              event,
              input.botIdentity,
              input.api,
              nameCache,
            )
          : undefined;
      const topic = topicResult?.topic;

      const quoted = event.message.parent_id
        ? await this.normalizeQuote(
            event.message.parent_id,
            event,
            input.botIdentity,
            input.api,
            fetchItems,
            nameCache,
          )
        : undefined;
      const primaryContent = topic?.content ?? main.content;
      let content = quoted
        ? `${formatQuote(quoted)}\n\n${primaryContent}`
        : primaryContent;
      let truncated = main.truncated || topic?.hasMore === true;
      if (content.length > this.maxContentChars) {
        content = `${content.slice(0, this.maxContentChars)}\n\n[飞书内容因长度限制被截断]`;
        truncated = true;
      }

      const combinedResources = [
        ...(quoted?.resources ?? []),
        ...(topic?.resources ?? main.resources),
      ];
      const resources = combinedResources.slice(0, this.maxResources);
      const omittedResources = combinedResources.length - resources.length;
      if (resources.length < combinedResources.length) {
        content += `\n\n[另有 ${combinedResources.length - resources.length} 个附件因数量限制未导入]`;
        truncated = true;
      }

      const rawEnvelope = input.event as Record<string, unknown>;
      const eventId =
        stringValue(rawEnvelope.event_id) ??
        `message:${event.message.message_id}`;
      const senderId = event.sender.sender_id.open_id ?? "unknown";
      const senderName = nameCache.get(senderId);
      const unsupported = !isSupportedFeishuMessageType(
        event.message.message_type,
      );
      const omittedItems =
        Math.max(
          0,
          (main.forwarded?.totalItems ?? 0) - (main.forwarded?.readItems ?? 0),
        ) + (topic?.hasMore ? 1 : 0);
      const failedItems = event.message.parent_id && !quoted ? 1 : 0;
      const topicHistoryUnavailable = Boolean(
        (event.message.thread_id || event.message.root_id) && !topic,
      );
      const topicHistoryWarning = topicResult?.unavailableReason;
      const warnings = [
        ...(unsupported
          ? [
              `UNSUPPORTED_MESSAGE_TYPE:${safeMessageType(event.message.message_type)}`,
            ]
          : []),
        ...(failedItems > 0 ? ["QUOTED_MESSAGE_UNAVAILABLE"] : []),
        ...(topicHistoryWarning
          ? [topicHistoryWarning]
          : topicHistoryUnavailable
            ? ["TOPIC_HISTORY_NOT_LOADED"]
            : []),
        ...(topic?.hasMore ? ["TOPIC_HISTORY_TRUNCATED"] : []),
        ...(main.forwarded?.truncated ? ["MERGE_FORWARD_TRUNCATED"] : []),
        ...(omittedResources > 0 ? ["RESOURCE_LIMIT_REACHED"] : []),
        ...(content.length > this.maxContentChars
          ? ["CONTENT_LIMIT_REACHED"]
          : []),
      ];
      const timestamps = [
        parseTimestamp(event.message.create_time),
        quoted?.createTime,
        ...(topic?.entries.map((entry) => entry.createTime) ?? []),
        ...(main.forwarded?.entries.map((entry) => entry.createTime) ?? []),
      ].filter((value): value is number => value !== undefined);
      const contextMode =
        event.message.message_type === "merge_forward"
          ? "merge-forward"
          : event.message.thread_id || event.message.root_id
            ? "topic"
            : event.message.parent_id
              ? "current+quoted"
              : "current";
      const effectiveContextMode =
        contextMode === "topic"
          ? topic
            ? "topic"
            : "current"
          : contextMode === "current+quoted" && !quoted
            ? "current"
            : contextMode;
      const contextWarnings = [
        ...(topicHistoryWarning
          ? [topicHistoryWarning]
          : topicHistoryUnavailable
            ? ["TOPIC_HISTORY_NOT_LOADED"]
            : []),
        ...(topic?.hasMore ? ["TOPIC_HISTORY_TRUNCATED"] : []),
        ...(failedItems > 0 ? ["QUOTED_MESSAGE_UNAVAILABLE"] : []),
      ];
      const context = {
        mode: contextMode,
        effectiveMode: effectiveContextMode,
        messageCount:
          main.forwarded?.readItems ??
          (topic?.entries.length ?? 1) +
            (quoted === undefined ||
            topic?.entries.some((entry) => entry.messageId === quoted.messageId)
              ? 0
              : 1),
        ...(timestamps.length > 0
          ? {
              timeRange: {
                fromMs: Math.min(...timestamps),
                toMs: Math.max(...timestamps),
              },
            }
          : {}),
        truncatedItems: omittedItems,
        failedItems,
        attachmentCount: resources.length,
        operator: { id: senderId, ...(senderName ? { name: senderName } : {}) },
        complete:
          effectiveContextMode === contextMode &&
          !truncated &&
          omittedItems === 0 &&
          omittedResources === 0 &&
          failedItems === 0,
        warnings: contextWarnings,
      } as const;
      return {
        accountId: input.accountId ?? "unknown",
        eventId,
        eventType:
          stringValue(rawEnvelope.event_type) ?? "im.message.receive_v1",
        tenantKey:
          stringValue(rawEnvelope.tenant_key) ?? event.sender.tenant_key,
        messageId: event.message.message_id,
        chatId: event.message.chat_id,
        chatType: event.message.chat_type,
        sender: {
          id: senderId,
          idType: "open_id",
          ...(senderName ? { name: senderName } : {}),
        },
        senderId,
        senderName,
        messageType: event.message.message_type,
        content,
        body: [
          { kind: "text", text: content },
          ...resources.map((resource) => ({
            kind: "resource" as const,
            resource,
          })),
          ...(unsupported
            ? [
                {
                  kind: "unsupported" as const,
                  messageType: event.message.message_type,
                },
              ]
            : []),
        ],
        attachments: [],
        resources,
        mentionsBot: main.mentionedBot,
        rootId: event.message.root_id,
        parentId: event.message.parent_id,
        threadId: event.message.thread_id ?? topicResult?.threadId,
        replyToMessageId: event.message.parent_id,
        createTime: parseTimestamp(event.message.create_time),
        createdAtMs: parseTimestamp(event.message.create_time),
        updatedAtMs: parseTimestamp(event.message.update_time),
        relation: {
          quotedMessageId: event.message.parent_id,
          topicRootId: event.message.root_id,
        },
        context,
        normalization: {
          warnings,
          truncated,
          omittedItems,
          omittedResources,
          rawRef: `feishu-message:${event.message.message_id}`,
        },
        quoted,
        forwarded: main.forwarded,
        truncated,
      };
    } catch (error) {
      if (error instanceof FeishuNormalizationError) throw error;
      throw new FeishuNormalizationError("NORMALIZATION_FAILED");
    }
  }

  private async normalizeMergeForward(
    event: Lark.RawMessageEvent,
    botIdentity: FeishuBotIdentity,
    api: FeishuMessageApi | undefined,
    fetchItems: (messageId: string) => Promise<Lark.ApiMessageItem[]>,
    nameCache: Map<string, string>,
  ): Promise<NormalizedContent> {
    if (!api) {
      return {
        content: "[无法展开飞书合并转发消息：消息读取能力未配置]",
        resources: [],
        mentionedBot: mentionsBot(event, botIdentity.openId),
        truncated: true,
      };
    }

    const allItems = await fetchItems(event.message.message_id);
    const contentItems = allItems.filter(
      (item) =>
        item.message_id &&
        !(
          item.message_id === event.message.message_id && !item.upper_message_id
        ),
    );
    const selected = contentItems.slice(0, this.maxItems);
    const truncatedByCount = selected.length < contentItems.length;
    await resolveNames(
      api,
      selected.flatMap((item) => (item.sender?.id ? [item.sender.id] : [])),
      nameCache,
    );

    const children = buildChildrenMap(selected, event.message.message_id);
    const aliases = buildSenderAliases(selected, nameCache);
    const entries: FeishuForwardEntry[] = [];
    const resources: Lark.ResourceDescriptor[] = [];
    const visited = new Set<string>();
    const walk = async (parentId: string, depth: number): Promise<void> => {
      for (const item of children.get(parentId) ?? []) {
        const messageId = item.message_id;
        if (!messageId || visited.has(messageId)) continue;
        visited.add(messageId);
        const senderId = item.sender?.id;
        const senderName =
          (senderId ? nameCache.get(senderId) : undefined) ??
          (senderId ? aliases.get(senderId) : undefined) ??
          "未知参与者";
        const messageType = item.msg_type ?? "unknown";
        let normalized: NormalizedContent;
        if (messageType === "merge_forward") {
          normalized = {
            content:
              depth >= this.maxDepth ? "[嵌套转发层级超过限制]" : "[嵌套转发]",
            resources: [],
            mentionedBot: false,
            truncated: depth >= this.maxDepth,
          };
        } else {
          normalized = await normalizeApiItem(
            item,
            event,
            botIdentity,
            nameCache,
          );
        }
        entries.push({
          messageId,
          parentMessageId: parentId,
          depth,
          messageType,
          senderId,
          senderName,
          createTime: parseTimestamp(item.create_time),
          content: ensureVisibleContent(
            normalized.content,
            messageId,
            messageType,
          ),
          resources: normalized.resources,
        });
        resources.push(...normalized.resources);
        if (depth < this.maxDepth) {
          await walk(messageId, depth + 1);
        }
      }
    };
    await walk(event.message.message_id, 0);

    // API responses occasionally contain orphaned children. Preserve them
    // after the rooted tree instead of silently dropping useful context.
    for (const item of selected) {
      if (!item.message_id || visited.has(item.message_id)) continue;
      children.set(event.message.message_id, [item]);
      await walk(event.message.message_id, 0);
    }

    const forwarded: FeishuForwardedContent = {
      totalItems: contentItems.length,
      readItems: entries.length,
      truncated: truncatedByCount || entries.length < selected.length,
      entries,
    };
    return {
      content: formatForwardedMarkdown(event.message.message_id, forwarded),
      resources,
      mentionedBot: mentionsBot(event, botIdentity.openId),
      truncated: forwarded.truncated,
      forwarded,
    };
  }

  private async normalizeQuote(
    messageId: string,
    sourceEvent: Lark.RawMessageEvent,
    botIdentity: FeishuBotIdentity,
    api: FeishuMessageApi | undefined,
    fetchItems: (messageId: string) => Promise<Lark.ApiMessageItem[]>,
    nameCache: Map<string, string>,
  ): Promise<FeishuQuotedContent | undefined> {
    if (!api) return undefined;
    const items = await fetchItems(messageId).catch(() => []);
    const item =
      items.find((candidate) => candidate.message_id === messageId) ?? items[0];
    if (!item?.message_id) return undefined;
    const senderId = item.sender?.id;
    await resolveNames(api, senderId ? [senderId] : [], nameCache);
    const normalized = await normalizeApiItem(
      item,
      sourceEvent,
      botIdentity,
      nameCache,
    );
    return {
      messageId: item.message_id,
      senderId,
      senderName:
        (senderId ? nameCache.get(senderId) : undefined) ?? "引用消息发送者",
      messageType: item.msg_type ?? "unknown",
      createTime: parseTimestamp(item.create_time),
      content: ensureVisibleContent(
        normalized.content,
        item.message_id,
        item.msg_type ?? "unknown",
      ),
      resources: normalized.resources,
    };
  }

  private async normalizeTopic(
    event: Lark.RawMessageEvent,
    botIdentity: FeishuBotIdentity,
    api: FeishuMessageApi | undefined,
    nameCache: Map<string, string>,
  ): Promise<NormalizedTopicResult> {
    let threadId = event.message.thread_id;
    if (!threadId && event.message.root_id) {
      threadId = await api
        ?.resolveThreadId?.(event.message.root_id)
        .catch(() => undefined);
      if (!threadId) {
        return { unavailableReason: "TOPIC_THREAD_ID_UNAVAILABLE" };
      }
    }
    if (!threadId || !api?.fetchThreadMessageItems) {
      return {
        ...(threadId ? { threadId } : {}),
        unavailableReason: "TOPIC_HISTORY_NOT_LOADED",
      };
    }
    const response = await api
      .fetchThreadMessageItems(threadId, this.maxItems)
      .catch(() => undefined);
    if (!response) {
      return { threadId, unavailableReason: "TOPIC_HISTORY_NOT_LOADED" };
    }
    const currentAt = parseTimestamp(event.message.create_time);
    const sorted = [...response.items]
      .filter((item) => {
        const timestamp = parseTimestamp(item.create_time);
        return currentAt === undefined || timestamp === undefined
          ? true
          : timestamp <= currentAt;
      })
      .sort(
        (left, right) =>
          (parseTimestamp(left.create_time) ?? 0) -
          (parseTimestamp(right.create_time) ?? 0),
      )
      .slice(0, this.maxItems);
    await resolveNames(
      api,
      sorted.flatMap((item) => (item.sender?.id ? [item.sender.id] : [])),
      nameCache,
    );

    let entries: FeishuForwardEntry[] = [];
    for (const item of sorted) {
      if (!item.message_id) continue;
      const normalized = await normalizeApiItem(
        item,
        event,
        botIdentity,
        nameCache,
      );
      const senderId = item.sender?.id;
      entries.push({
        messageId: item.message_id,
        parentMessageId: item.upper_message_id ?? event.message.root_id ?? "",
        depth: item.upper_message_id ? 1 : 0,
        messageType: item.msg_type ?? "unknown",
        senderId,
        senderName:
          (senderId ? nameCache.get(senderId) : undefined) ??
          `参与者 ${entries.length + 1}`,
        createTime: parseTimestamp(item.create_time),
        content: ensureVisibleContent(
          normalized.content,
          item.message_id,
          item.msg_type ?? "unknown",
        ),
        resources: normalized.resources,
      });
    }

    if (
      !entries.some((entry) => entry.messageId === event.message.message_id)
    ) {
      const current = await normalizeSingleEvent(event, botIdentity, nameCache);
      const senderId = event.sender.sender_id.open_id;
      entries.push({
        messageId: event.message.message_id,
        parentMessageId: event.message.parent_id ?? event.message.root_id ?? "",
        depth: event.message.parent_id ? 1 : 0,
        messageType: event.message.message_type,
        senderId,
        senderName:
          (senderId ? nameCache.get(senderId) : undefined) ?? "当前消息发送者",
        createTime: currentAt,
        content: current.content,
        resources: current.resources,
      });
    }
    entries.sort(
      (left, right) => (left.createTime ?? 0) - (right.createTime ?? 0),
    );
    const exceededLimit = entries.length > this.maxItems;
    if (exceededLimit) {
      const current = entries.find(
        (entry) => entry.messageId === event.message.message_id,
      );
      const historical = entries.filter(
        (entry) => entry.messageId !== event.message.message_id,
      );
      entries = current
        ? [...historical.slice(0, Math.max(0, this.maxItems - 1)), current]
        : entries.slice(0, this.maxItems);
      entries.sort(
        (left, right) => (left.createTime ?? 0) - (right.createTime ?? 0),
      );
    }
    const hasMore =
      response.hasMore ||
      response.items.length > this.maxItems ||
      exceededLimit;
    return {
      threadId,
      topic: {
        content: formatTopicMarkdown(threadId, entries, hasMore),
        resources: entries.flatMap((entry) => entry.resources),
        entries,
        hasMore,
      },
    };
  }
}

interface NormalizedContent {
  content: string;
  resources: Lark.ResourceDescriptor[];
  mentionedBot: boolean;
  truncated: boolean;
  forwarded?: FeishuForwardedContent;
}

interface NormalizedTopicContent {
  content: string;
  resources: Lark.ResourceDescriptor[];
  entries: FeishuForwardEntry[];
  hasMore: boolean;
}

interface NormalizedTopicResult {
  threadId?: string;
  topic?: NormalizedTopicContent;
  unavailableReason?:
    | "TOPIC_THREAD_ID_UNAVAILABLE"
    | "TOPIC_HISTORY_NOT_LOADED";
}

async function normalizeSingleEvent(
  event: Lark.RawMessageEvent,
  botIdentity: FeishuBotIdentity,
  nameCache: Map<string, string>,
): Promise<NormalizedContent> {
  if (!isSupportedFeishuMessageType(event.message.message_type)) {
    return {
      content: unsupportedMessage(event.message.message_type),
      resources: [],
      mentionedBot: mentionsBot(event, botIdentity.openId),
      truncated: false,
    };
  }
  const normalized = await Lark.normalize(event, {
    botIdentity: toSdkBotIdentity(botIdentity),
    stripBotMentions: true,
    includeRaw: false,
    resolveSenderName: (openId) => nameCache.get(openId),
  });
  return {
    content: applyContentPolicy(
      event.message.message_type,
      enrichInteractiveContent(
        normalized.content,
        event.message.message_type,
        event.message.content,
      ),
    ),
    resources: normalized.resources.map((resource) => ({
      ...resource,
      messageId: event.message.message_id,
    })),
    mentionedBot: normalized.mentionedBot,
    truncated: false,
  };
}

async function normalizeApiItem(
  item: Lark.ApiMessageItem,
  sourceEvent: Lark.RawMessageEvent,
  botIdentity: FeishuBotIdentity,
  nameCache: Map<string, string>,
): Promise<NormalizedContent> {
  const messageType = item.msg_type ?? "unknown";
  if (!isSupportedFeishuMessageType(messageType)) {
    return {
      content: unsupportedMessage(messageType),
      resources: [],
      mentionedBot: false,
      truncated: false,
    };
  }
  const event: Lark.RawMessageEvent = {
    sender: {
      sender_id: { open_id: item.sender?.id },
      sender_type: item.sender?.sender_type,
    },
    message: {
      message_id: item.message_id ?? "unknown",
      create_time:
        item.create_time === undefined ? undefined : String(item.create_time),
      chat_id: sourceEvent.message.chat_id,
      chat_type: sourceEvent.message.chat_type,
      message_type: messageType,
      content: item.body?.content ?? "{}",
      mentions: item.mentions,
    },
  };
  return normalizeSingleEvent(event, botIdentity, nameCache);
}

function parseRawMessageEvent(value: unknown): Lark.RawMessageEvent {
  if (!value || typeof value !== "object") {
    throw new FeishuNormalizationError("INVALID_EVENT");
  }
  const raw = value as Record<string, unknown>;
  const sender = objectValue(raw.sender);
  const senderId = objectValue(sender?.sender_id);
  const message = objectValue(raw.message);
  const chatType = stringValue(message?.chat_type);
  const parsed: Lark.RawMessageEvent = {
    sender: {
      sender_id: {
        open_id: stringValue(senderId?.open_id),
        user_id: stringValue(senderId?.user_id),
        union_id: stringValue(senderId?.union_id),
      },
      sender_type: stringValue(sender?.sender_type),
      tenant_key: stringValue(sender?.tenant_key),
    },
    message: {
      message_id: stringValue(message?.message_id) ?? "",
      root_id: stringValue(message?.root_id),
      parent_id: stringValue(message?.parent_id),
      create_time: stringValue(message?.create_time),
      update_time: stringValue(message?.update_time),
      chat_id: stringValue(message?.chat_id) ?? "",
      thread_id: stringValue(message?.thread_id),
      chat_type: chatType === "p2p" ? "p2p" : "group",
      message_type: stringValue(message?.message_type) ?? "",
      content: stringValue(message?.content) ?? "{}",
      mentions: Array.isArray(message?.mentions)
        ? (message.mentions as Lark.RawMessageEvent["message"]["mentions"])
        : undefined,
    },
  };
  if (
    !parsed.message.message_id ||
    !parsed.message.chat_id ||
    !parsed.message.message_type ||
    (chatType !== "p2p" && chatType !== "group")
  ) {
    throw new FeishuNormalizationError("INVALID_EVENT");
  }
  return parsed;
}

function buildChildrenMap(
  items: Lark.ApiMessageItem[],
  rootId: string,
): Map<string, Lark.ApiMessageItem[]> {
  const ids = new Set(
    items.flatMap((item) => (item.message_id ? [item.message_id] : [])),
  );
  const map = new Map<string, Lark.ApiMessageItem[]>();
  for (const item of items) {
    if (!item.message_id) continue;
    const candidateParent = item.upper_message_id;
    const parentId =
      candidateParent &&
      (candidateParent === rootId || ids.has(candidateParent))
        ? candidateParent
        : rootId;
    const siblings = map.get(parentId) ?? [];
    siblings.push(item);
    map.set(parentId, siblings);
  }
  for (const siblings of map.values()) {
    siblings.sort(
      (left, right) =>
        (parseTimestamp(left.create_time) ?? 0) -
        (parseTimestamp(right.create_time) ?? 0),
    );
  }
  return map;
}

function buildSenderAliases(
  items: Lark.ApiMessageItem[],
  names: Map<string, string>,
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const item of items) {
    const senderId = item.sender?.id;
    if (!senderId || names.has(senderId) || aliases.has(senderId)) continue;
    aliases.set(senderId, `参与者 ${aliases.size + 1}`);
  }
  return aliases;
}

async function resolveNames(
  api: FeishuMessageApi | undefined,
  openIds: string[],
  cache: Map<string, string>,
): Promise<void> {
  if (!api?.resolveUserNames) return;
  const missing = [...new Set(openIds.filter((id) => id && !cache.has(id)))];
  if (missing.length === 0) return;
  try {
    const resolved = await api.resolveUserNames(missing);
    for (const [openId, name] of resolved) {
      if (missing.includes(openId) && name.trim())
        cache.set(openId, name.trim());
    }
  } catch {
    // Name resolution is optional. Stable aliases are used as fallback.
  }
}

function collectEventUserIds(event: Lark.RawMessageEvent): string[] {
  const ids =
    event.message.mentions?.flatMap((mention) =>
      mention.id.open_id ? [mention.id.open_id] : [],
    ) ?? [];
  if (event.sender.sender_id.open_id) ids.push(event.sender.sender_id.open_id);
  return ids;
}

function formatForwardedMarkdown(
  rootMessageId: string,
  forwarded: FeishuForwardedContent,
): string {
  const timestamps = forwarded.entries.flatMap((entry) =>
    entry.createTime === undefined ? [] : [entry.createTime],
  );
  const lines = [
    "# 飞书转发话题",
    "",
    `- 原始消息 ID：${rootMessageId}`,
    `- 消息数：${forwarded.totalItems}`,
    `- 已读取：${forwarded.readItems}`,
  ];
  if (timestamps.length > 0) {
    lines.push(
      `- 时间范围：${formatTimestamp(Math.min(...timestamps))} 至 ${formatTimestamp(Math.max(...timestamps))}`,
    );
  }
  if (forwarded.truncated) {
    lines.push("- 注意：部分内容因数量、层级或解析限制被截断");
  }

  const [topic, ...replies] = forwarded.entries;
  lines.push("", "## 话题正文", "");
  lines.push(topic ? formatForwardEntry(topic) : "[未提取到话题正文]");
  lines.push("", "## 回复", "");
  if (replies.length === 0) {
    lines.push("[无可见回复]");
  } else {
    lines.push(replies.map(formatForwardEntry).join("\n\n"));
  }
  return lines.join("\n");
}

function formatTopicMarkdown(
  threadId: string,
  entries: FeishuForwardEntry[],
  truncated: boolean,
): string {
  const lines = [
    "# 飞书话题上下文",
    "",
    `- 话题 ID：${threadId}`,
    `- 已读取：${entries.length}`,
    `- 完整：${truncated ? "否" : "是"}`,
    "",
    "## 消息",
    "",
  ];
  if (entries.length === 0) {
    lines.push("[没有可见话题消息]");
  } else {
    lines.push(entries.map(formatForwardEntry).join("\n\n"));
  }
  return lines.join("\n");
}

function formatForwardEntry(entry: FeishuForwardEntry): string {
  const time =
    entry.createTime === undefined ? "时间未知" : formatTime(entry.createTime);
  const indent = "  ".repeat(Math.min(entry.depth, 6));
  return `${indent}**${entry.senderName}｜${time}**\n\n${indent}${entry.content.replace(/\n/g, `\n${indent}`)}`;
}

function formatQuote(quoted: FeishuQuotedContent): string {
  return `> 引用消息（${quoted.senderName}）\n> ${quoted.content.replace(/\n/g, "\n> ")}`;
}

function ensureVisibleContent(
  content: string,
  messageId: string,
  messageType: string,
): string {
  if (
    content.trim() &&
    content !== "[interactive card]" &&
    content !== "[unsupported message]"
  ) {
    return content;
  }
  return `[未提取到内容；消息 ID: ${messageId}；类型: ${messageType}]`;
}

function enrichInteractiveContent(
  content: string,
  messageType: string,
  rawContent: string,
): string {
  if (messageType !== "interactive") return content;
  const links = extractVisibleHttpLinks(rawContent).filter(
    (link) => !content.includes(link),
  );
  return links.length > 0
    ? `${content}\n${links.map((link) => `- ${link}`).join("\n")}`
    : content;
}

/**
 * Extract links only from visible card-layout nodes.
 *
 * Card callback `behaviors[].value`, variables, and other opaque payloads are
 * deliberately outside this traversal. They may contain routing tokens or
 * private tool state and must never become model-visible quote text.
 */
function extractVisibleHttpLinks(rawContent: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return [];
  }
  const links = new Set<string>();
  const visibleChildKeys = new Set([
    "header",
    "body",
    "elements",
    "columns",
    "items",
    "fields",
    "actions",
    "rows",
    "cells",
    "text",
    "title",
    "subtitle",
    "content",
  ]);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "url" || key === "href" || key.endsWith("_url")) &&
        typeof child === "string" &&
        /^https?:\/\//i.test(child)
      ) {
        links.add(child);
      } else if (visibleChildKeys.has(key)) {
        visit(child);
      }
    }
  };
  visit(parsed);
  return [...links];
}

function unsupportedMessage(messageType: string): string {
  const safeType = safeMessageType(messageType);
  return `[未支持的飞书消息类型: ${safeType || "unknown"}]`;
}

function safeMessageType(messageType: string): string {
  return messageType.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function applyContentPolicy(messageType: string, content: string): string {
  if (messageType === "hongbao") return "[红包消息]";
  if (messageType !== "location") return content;
  const redacted = content.replace(/\scoords="[^"]*"/g, "");
  return `${redacted}\n[精确坐标已按隐私策略隐藏]`;
}

function mentionsBot(event: Lark.RawMessageEvent, botOpenId: string): boolean {
  return (
    event.message.mentions?.some(
      (mention) => mention.id.open_id === botOpenId,
    ) ?? false
  );
}

function toSdkBotIdentity(identity: FeishuBotIdentity): Lark.BotIdentity {
  return { openId: identity.openId, name: identity.name ?? "bot" };
}

function parseTimestamp(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const timestamp =
    typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp + 8 * 60 * 60 * 1000);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${formatUtcTime(date)} +08:00`;
}

function formatTime(timestamp: number): string {
  return formatUtcTime(new Date(timestamp + 8 * 60 * 60 * 1000));
}

function formatUtcTime(date: Date): string {
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
