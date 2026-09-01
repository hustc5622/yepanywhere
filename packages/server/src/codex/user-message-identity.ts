import type {
  CodexResponseItemEntry,
  CodexSessionEntry,
} from "@yep-anywhere/shared";

const CODEX_USER_MESSAGE_CORRELATION_PREFIX = "codex:user-message:";

export interface CodexUserMessageIdentity {
  clientUserMessageId: string;
  codexCorrelationKey: string;
}

/**
 * Build the one public identity shared by a Yep admission echo, Codex's
 * `userMessage.clientId`, and the persisted legacy `user_message.client_id`.
 *
 * Message `uuid`s deliberately remain source-native: rollout offsets and
 * app-server item ids are also pagination/edit cursors. Cross-source merging
 * therefore uses this correlation key instead of rewriting those ids.
 */
export function codexUserMessageIdentity(
  clientId: unknown,
): CodexUserMessageIdentity | undefined {
  if (typeof clientId !== "string") return undefined;
  const normalized = clientId.trim();
  if (!normalized) return undefined;
  return {
    clientUserMessageId: normalized,
    codexCorrelationKey: `${CODEX_USER_MESSAGE_CORRELATION_PREFIX}${normalized}`,
  };
}

/**
 * Read the client-generated identity from either Codex rollout generation:
 *
 * - legacy `event_msg.user_message.client_id`;
 * - current `event_msg.item_completed.item` user messages.
 *
 * App-server ThreadItems use camelCase while persisted EventMsgs use
 * PascalCase/snake_case, so accept both spellings at this protocol boundary.
 */
export function codexEventUserMessageClientId(
  payload: unknown,
): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (record.type === "user_message") {
    return normalizedClientId(record.client_id ?? record.clientId);
  }
  if (record.type !== "item_completed") return undefined;

  const item =
    record.item && typeof record.item === "object"
      ? (record.item as Record<string, unknown>)
      : null;
  if (!item || !isUserMessageType(item.type)) return undefined;
  return normalizedClientId(item.client_id ?? item.clientId);
}

/**
 * Pair each durable user ResponseItem with the following Codex user event that
 * owns its client-generated identity. Startup setup inputs may precede the
 * actual prompt, so the last consecutive user ResponseItem wins.
 */
export function collectCodexResponseUserClientIds(
  entries: readonly CodexSessionEntry[],
): WeakMap<CodexResponseItemEntry, string> {
  const clientIds = new WeakMap<CodexResponseItemEntry, string>();
  let pendingUserResponse: CodexResponseItemEntry | null = null;

  for (const entry of entries) {
    if (entry.type === "response_item") {
      if (entry.payload.type === "message" && entry.payload.role === "user") {
        pendingUserResponse = entry;
      } else {
        pendingUserResponse = null;
      }
      continue;
    }

    if (entry.type !== "event_msg") continue;
    const clientId = codexEventUserMessageClientId(entry.payload);
    if (!clientId) continue;
    if (pendingUserResponse) clientIds.set(pendingUserResponse, clientId);
    pendingUserResponse = null;
  }

  return clientIds;
}

function isUserMessageType(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.replace(/[^a-z]/gi, "").toLowerCase() === "usermessage"
  );
}

function normalizedClientId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}
