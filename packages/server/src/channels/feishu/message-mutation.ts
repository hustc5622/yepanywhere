import { createHash } from "node:crypto";

export const FEISHU_MESSAGE_MUTATION_CAPABILITIES = {
  edit: {
    support: "opportunistic_read_observation",
    eventType: null,
    observationTrigger: "message_receive_or_recovery_payload",
    scheduledPolling: false,
    reason:
      "Feishu exposes update_time/is_updated through message reads but does not document a message-edited event; no scheduled poller is wired",
  },
  recall: {
    support: "event",
    eventType: "im.message.recalled_v1",
    reason: "Official recall event",
  },
  reactionAdded: {
    support: "event",
    eventType: "im.message.reaction.created_v1",
    reason: "Official reaction-created event",
  },
  reactionRemoved: {
    support: "event",
    eventType: "im.message.reaction.deleted_v1",
    reason: "Official reaction-deleted event",
  },
} as const;

export type FeishuMessageMutationKind =
  | "edited"
  | "recalled"
  | "reaction_added"
  | "reaction_removed";

export interface FeishuMessageMutation {
  version: 1;
  eventId: string;
  eventType: string;
  messageId: string;
  kind: FeishuMessageMutationKind;
  occurredAtMs: number;
  source: "event" | "message_read_observation";
  actor?: {
    id?: string;
    type?: string;
  };
  reaction?: {
    key: string;
    emojiType: string;
  };
  recallType?: string;
}

const RECALL_EVENT = "im.message.recalled_v1";
const REACTION_CREATED_EVENT = "im.message.reaction.created_v1";
const REACTION_DELETED_EVENT = "im.message.reaction.deleted_v1";

export function normalizeFeishuMessageMutation(
  eventType: string,
  input: unknown,
): FeishuMessageMutation | undefined {
  if (
    eventType !== RECALL_EVENT &&
    eventType !== REACTION_CREATED_EVENT &&
    eventType !== REACTION_DELETED_EVENT
  ) {
    return undefined;
  }

  const envelope = asRecord(input);
  if (!envelope) return undefined;
  const header = asRecord(envelope.header);
  const body = asRecord(envelope.event) ?? envelope;
  const messageId = safeId(body.message_id);
  if (!messageId) return undefined;

  const occurredAtMs =
    timestampValue(
      eventType === RECALL_EVENT ? body.recall_time : body.action_time,
    ) ?? timestampValue(header?.create_time);
  if (occurredAtMs === undefined) return undefined;

  const actorId = firstSafeId(
    asRecord(body.user_id)?.open_id,
    asRecord(body.user_id)?.user_id,
    asRecord(body.user_id)?.union_id,
    body.operator_id,
  );
  const actorType = safeToken(body.operator_type);
  const eventId =
    safeId(header?.event_id) ??
    safeId(envelope.event_id) ??
    syntheticEventId(eventType, messageId, occurredAtMs, actorId);

  if (eventType === RECALL_EVENT) {
    return {
      version: 1,
      eventId,
      eventType,
      messageId,
      kind: "recalled",
      occurredAtMs,
      source: "event",
      ...(actorId || actorType
        ? {
            actor: {
              ...(actorId ? { id: actorId } : {}),
              ...(actorType ? { type: actorType } : {}),
            },
          }
        : {}),
      ...(safeToken(body.recall_type)
        ? { recallType: safeToken(body.recall_type) }
        : {}),
    };
  }

  const reactionType = asRecord(body.reaction_type);
  const emojiType = safeToken(reactionType?.emoji_type);
  if (!emojiType) return undefined;
  const reactionKey = createHash("sha256")
    .update(`${messageId}\0${actorId ?? "unknown"}\0${emojiType}`)
    .digest("hex");
  return {
    version: 1,
    eventId,
    eventType,
    messageId,
    kind:
      eventType === REACTION_CREATED_EVENT
        ? "reaction_added"
        : "reaction_removed",
    occurredAtMs,
    source: "event",
    ...(actorId || actorType
      ? {
          actor: {
            ...(actorId ? { id: actorId } : {}),
            ...(actorType ? { type: actorType } : {}),
          },
        }
      : {}),
    reaction: { key: reactionKey, emojiType },
  };
}

/**
 * Feishu does not document a message-edited event. A read/receive payload can
 * still prove an edit when update_time is newer than create_time (or the API
 * explicitly returns is_updated). Persist only revision metadata; never copy
 * message content into the mutation journal.
 */
export function observeFeishuMessageRevision(
  input: unknown,
): FeishuMessageMutation | undefined {
  const envelope = asRecord(input);
  if (!envelope) return undefined;
  const body = asRecord(envelope.event) ?? envelope;
  const message = asRecord(body.message);
  if (!message) return undefined;
  const messageId = safeId(message.message_id);
  const createdAtMs = timestampValue(message.create_time);
  const updatedAtMs = timestampValue(message.update_time);
  const explicitlyUpdated = message.is_updated === true;
  if (
    !messageId ||
    updatedAtMs === undefined ||
    (!explicitlyUpdated &&
      (createdAtMs === undefined || updatedAtMs <= createdAtMs))
  ) {
    return undefined;
  }
  const sender = asRecord(body.sender);
  const senderId = asRecord(sender?.sender_id);
  const actorId = firstSafeId(
    senderId?.open_id,
    senderId?.user_id,
    senderId?.union_id,
  );
  return {
    version: 1,
    eventId: syntheticEventId(
      "im.message.edit_observed_v1",
      messageId,
      updatedAtMs,
      actorId,
    ),
    eventType: "im.message.edit_observed_v1",
    messageId,
    kind: "edited",
    occurredAtMs: updatedAtMs,
    source: "message_read_observation",
    ...(actorId ? { actor: { id: actorId, type: "user" } } : {}),
  };
}

function syntheticEventId(
  eventType: string,
  messageId: string,
  occurredAtMs: number,
  actorId: string | undefined,
): string {
  return `synthetic:${createHash("sha256")
    .update(`${eventType}\0${messageId}\0${occurredAtMs}\0${actorId ?? ""}`)
    .digest("hex")}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstSafeId(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = safeId(value);
    if (parsed) return parsed;
  }
  return undefined;
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\r\n\0]/u.test(value)
    ? value
    : undefined;
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(value)
    ? value
    : undefined;
}

function timestampValue(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{1,17}$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
