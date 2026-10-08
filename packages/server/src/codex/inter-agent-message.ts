import type { Message } from "../supervisor/types.js";

/**
 * Safe public projection of Codex mailbox messages. See protocol.rs
 * InterAgentCommunication::{to_model_input_item,to_response_input_item} and
 * core/src/context/inter_agent_{message,completion_message}.rs.
 * Never retain the raw envelope: it may include encrypted_content.
 */
export interface CodexInterAgentMessage {
  type: "interAgentMessage";
  id: string;
  kind: "task" | "message" | "result";
  sender: string;
  recipient: string;
  text?: string;
  encrypted: boolean;
}

export interface CodexInterAgentMessageSupplement {
  message: Message;
  /** Adjacent history identities, including items outside the requested page. */
  beforeItemId?: string;
  afterItemId?: string;
  /** Enrich an existing native activity using its raw tool call identity. */
  updateOnly?: boolean;
}

/** Keep mailbox entries at their durable position amongst native turn items. */
export function mergeCodexInterAgentMessages(
  messages: Message[],
  supplements: readonly CodexInterAgentMessageSupplement[],
  completeTurns = true,
): Message[] {
  const items = new Map<string, { first: number; last: number }>();
  const turns = new Map<string, { first: number; last: number }>();
  messages.forEach((message, index) => {
    if (typeof message.codexTurnId !== "string") return;
    const turn = turns.get(message.codexTurnId);
    turns.set(message.codexTurnId, {
      first: turn?.first ?? index,
      last: index,
    });
    if (typeof message.codexThreadItemId !== "string") return;
    const key = `${message.codexTurnId}:${message.codexThreadItemId}`;
    items.set(key, { first: items.get(key)?.first ?? index, last: index });
  });
  const known = new Set(
    messages.map((message) => message.codexCorrelationKey).filter(Boolean),
  );
  const insertions = new Map<number, Message[]>();
  const updates = new Map<number, Message>();
  for (const {
    message,
    beforeItemId,
    afterItemId,
    updateOnly,
  } of supplements) {
    if (updateOnly) {
      const index = items.get(
        `${message.codexTurnId}:${message.codexThreadItemId}`,
      )?.first;
      const target = index === undefined ? undefined : messages[index];
      const item = record(message.codexThreadItem);
      const targetItem = record(target?.codexThreadItem);
      if (
        index !== undefined &&
        target &&
        item?.type === "agentWait" &&
        (targetItem?.type === "agentWait" ||
          (targetItem?.type === "collabAgentToolCall" &&
            targetItem.tool === "wait"))
      ) {
        updates.set(index, { ...target, ...message });
        continue;
      }
      if (
        index !== undefined &&
        target &&
        targetItem?.type === "subAgentActivity" &&
        (item?.operation === "followup_task" ||
          item?.operation === "send_message")
      ) {
        updates.set(index, {
          ...target,
          codexThreadItem: { ...targetItem, operation: item.operation },
        });
      }
      continue;
    }
    if (message.codexCorrelationKey && known.has(message.codexCorrelationKey))
      continue;
    const before =
      items.get(`${message.codexTurnId}:${beforeItemId}`)?.first ?? -1;
    const after =
      items.get(`${message.codexTurnId}:${afterItemId}`)?.last ?? -1;
    const bounds =
      typeof message.codexTurnId === "string"
        ? turns.get(message.codexTurnId)
        : undefined;
    const last = bounds?.last ?? -1;
    // Assign a boundary message to the page containing its next native item.
    // Only a turn's trailing messages belong to the preceding item's page.
    // Requiring both neighbors drops messages between two adjacent pages.
    if (!completeTurns && (beforeItemId !== undefined ? before < 0 : after < 0))
      continue;
    const index =
      before >= 0
        ? before
        : after >= 0
          ? after + 1
          : last >= 0
            ? last + 1
            : messages.length;
    const bucket = insertions.get(index) ?? [];
    bucket.push(message);
    insertions.set(index, bucket);
    if (message.codexCorrelationKey) known.add(message.codexCorrelationKey);
  }
  return messages
    .flatMap((message, index) => [
      ...(insertions.get(index) ?? []),
      updates.get(index) ?? message,
    ])
    .concat(insertions.get(messages.length) ?? []);
}

interface Envelope {
  id?: string;
  turnId?: string;
  sender: string;
  recipient: string;
  text: string;
  encrypted: boolean;
  triggerTurn?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function identity(value: Record<string, unknown>) {
  const turnId = record(
    value.internal_chat_message_metadata_passthrough,
  )?.turn_id;
  return {
    ...(typeof value.id === "string" && value.id ? { id: value.id } : {}),
    ...(typeof turnId === "string" && turnId ? { turnId } : {}),
  };
}

function readEnvelope(value: unknown): Envelope | undefined {
  const payload = record(value);
  if (!payload) return undefined;
  if (
    payload.type === "agent_message" &&
    typeof payload.author === "string" &&
    typeof payload.recipient === "string" &&
    Array.isArray(payload.content)
  ) {
    return {
      ...identity(payload),
      sender: payload.author,
      recipient: payload.recipient,
      text: payload.content
        .flatMap((part) => {
          const block = record(part);
          return block?.type === "input_text" && typeof block.text === "string"
            ? [block.text]
            : [];
        })
        .join("\n"),
      encrypted: payload.content.some(
        (part) => record(part)?.type === "encrypted_content",
      ),
    };
  }

  // Codex also serializes InterAgentCommunication as one assistant text
  // block. Require its structural fields; arbitrary assistant JSON is prose.
  if (
    payload.type !== "message" ||
    payload.role !== "assistant" ||
    !Array.isArray(payload.content) ||
    payload.content.length !== 1
  )
    return undefined;
  const block = record(payload.content[0]);
  if (
    (block?.type !== "output_text" && block?.type !== "input_text") ||
    typeof block.text !== "string"
  )
    return undefined;
  let communication: Record<string, unknown> | undefined;
  try {
    communication = record(JSON.parse(block.text));
  } catch {
    return undefined;
  }
  if (
    !communication ||
    typeof communication.author !== "string" ||
    typeof communication.recipient !== "string" ||
    typeof communication.content !== "string" ||
    typeof communication.trigger_turn !== "boolean"
  )
    return undefined;
  return {
    ...identity(payload),
    ...identity(communication),
    sender: communication.author,
    recipient: communication.recipient,
    text: communication.content,
    encrypted: typeof communication.encrypted_content === "string",
    triggerTurn: communication.trigger_turn,
  };
}

export function readCodexInterAgentMessageIdentity(
  payload: unknown,
): { id?: string; turnId?: string } | undefined {
  const envelope = readEnvelope(payload);
  if (!envelope) return undefined;
  return {
    ...(envelope.id ? { id: envelope.id } : {}),
    ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
  };
}

export function normalizeCodexInterAgentMessage(
  payload: unknown,
  fallbackId: string,
): CodexInterAgentMessage | null {
  const envelope = readEnvelope(payload);
  if (!envelope) return null;
  const header =
    /^Message Type: (NEW_TASK|MESSAGE|FINAL_ANSWER)\r?\nTask name: ([^\r\n]+)\r?\nSender: ([^\r\n]+)\r?\nPayload:\r?\n/.exec(
      envelope.text,
    );
  // Only strip the known protocol header when it agrees with the envelope.
  // Unknown or malformed plaintext remains readable instead of disappearing.
  const matches =
    header?.[2] === envelope.recipient && header?.[3] === envelope.sender;
  const text = matches ? envelope.text.slice(header[0].length) : envelope.text;
  return {
    type: "interAgentMessage",
    id: envelope.id ?? fallbackId,
    kind: matches
      ? header[1] === "NEW_TASK"
        ? "task"
        : header[1] === "FINAL_ANSWER"
          ? "result"
          : "message"
      : envelope.triggerTurn
        ? "task"
        : "message",
    sender: envelope.sender,
    recipient: envelope.recipient,
    ...(text.trim() ? { text } : {}),
    encrypted: envelope.encrypted,
  };
}
