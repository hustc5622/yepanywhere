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
