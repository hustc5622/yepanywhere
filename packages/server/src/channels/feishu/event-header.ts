import type { FeishuBotIdentity } from "./transport.js";

export interface FeishuInboundEventHeader {
  eventId?: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  messageType: string;
  senderOpenId: string;
  senderType?: string;
  tenantKey?: string;
  rootId?: string;
  threadId?: string;
  mentionsBot: boolean;
}

export class FeishuInboundEventError extends Error {
  readonly code = "INVALID_EVENT";

  constructor() {
    super("INVALID_EVENT");
    this.name = "FeishuInboundEventError";
  }
}

/** Parse only routing/policy fields. The event body is deliberately omitted. */
export function parseFeishuInboundEventHeader(
  value: unknown,
  botIdentity: FeishuBotIdentity,
): FeishuInboundEventHeader {
  const raw = objectValue(value);
  const sender = objectValue(raw?.sender);
  const senderId = objectValue(sender?.sender_id);
  const message = objectValue(raw?.message);
  const chatType = stringValue(message?.chat_type);
  const messageId = stringValue(message?.message_id);
  const chatId = stringValue(message?.chat_id);
  const messageType = stringValue(message?.message_type);
  const senderOpenId = stringValue(senderId?.open_id);
  if (
    !messageId ||
    !chatId ||
    !messageType ||
    !senderOpenId ||
    (chatType !== "p2p" && chatType !== "group")
  ) {
    throw new FeishuInboundEventError();
  }

  const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
  return {
    eventId: stringValue(raw?.event_id),
    messageId,
    chatId,
    chatType,
    messageType,
    senderOpenId,
    senderType: stringValue(sender?.sender_type),
    tenantKey: stringValue(raw?.tenant_key) ?? stringValue(sender?.tenant_key),
    rootId: stringValue(message?.root_id),
    threadId: stringValue(message?.thread_id),
    mentionsBot: mentions.some((mention) => {
      const mentionId = objectValue(objectValue(mention)?.id);
      return stringValue(mentionId?.open_id) === botIdentity.openId;
    }),
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
