import type { FeishuAccountConfig } from "@yep-anywhere/shared";

export type FeishuScopeKind = "p2p" | "group" | "thread";

export interface FeishuScope {
  key: string;
  kind: FeishuScopeKind;
  accountId: string;
  chatId: string;
  threadId?: string;
}

export interface FeishuScopeResolutionInput {
  account: Pick<FeishuAccountConfig, "id" | "groupSessionMode">;
  message: {
    chatId: string;
    chatType: "p2p" | "group" | "unknown";
    messageId?: string;
    messageType?: string;
    threadId?: string;
    rootId?: string;
  };
  /** Resolved from chat metadata. `topic` means root_id is a safe fallback. */
  chatMode?: "p2p" | "group" | "topic";
}

export function resolveFeishuScope(
  input: FeishuScopeResolutionInput,
): FeishuScope {
  const { account, message } = input;
  if (message.chatType === "p2p") {
    return {
      key: `${account.id}:p2p:${message.chatId}`,
      kind: "p2p",
      accountId: account.id,
      chatId: message.chatId,
    };
  }

  const effectiveThreadId =
    message.threadId ??
    (input.chatMode === "topic" ? message.rootId : undefined);
  if (
    account.groupSessionMode === "thread-when-available" &&
    effectiveThreadId
  ) {
    return {
      key: `${account.id}:thread:${message.chatId}:${effectiveThreadId}`,
      kind: "thread",
      accountId: account.id,
      chatId: message.chatId,
      threadId: effectiveThreadId,
    };
  }

  return {
    key: `${account.id}:group:${message.chatId}`,
    kind: "group",
    accountId: account.id,
    chatId: message.chatId,
  };
}
