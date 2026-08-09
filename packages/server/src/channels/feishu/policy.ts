import type { FeishuAccountConfig } from "@yep-anywhere/shared";

export type FeishuChatType = "p2p" | "group";
export type FeishuPolicyRole = "user" | "admin";

export interface FeishuMessageIdentity {
  senderOpenId: string;
  chatId: string;
  chatType: FeishuChatType;
  tenantKey?: string;
  mentionsBot: boolean;
  senderIsBot?: boolean;
  botOpenId?: string;
}

export type FeishuPolicyDecision =
  | { allowed: true; role: FeishuPolicyRole }
  | {
      allowed: false;
      reason:
        | "account_disabled"
        | "account_locked"
        | "tenant_mismatch"
        | "bot_message"
        | "user_not_allowed"
        | "chat_not_allowed"
        | "mention_required";
    };

export function authorizeFeishuMessage(
  account: FeishuAccountConfig,
  identity: FeishuMessageIdentity,
): FeishuPolicyDecision {
  if (!account.enabled) {
    return { allowed: false, reason: "account_disabled" };
  }
  if (account.allowedUsers.length === 0 && account.adminUsers.length === 0) {
    return { allowed: false, reason: "account_locked" };
  }
  if (
    account.tenantKey &&
    (!identity.tenantKey || identity.tenantKey !== account.tenantKey)
  ) {
    return { allowed: false, reason: "tenant_mismatch" };
  }
  if (
    identity.senderIsBot ||
    (identity.botOpenId && identity.senderOpenId === identity.botOpenId)
  ) {
    return { allowed: false, reason: "bot_message" };
  }

  const role = account.adminUsers.includes(identity.senderOpenId)
    ? "admin"
    : account.allowedUsers.includes(identity.senderOpenId)
      ? "user"
      : undefined;
  if (!role) {
    return { allowed: false, reason: "user_not_allowed" };
  }

  if (identity.chatType === "group") {
    if (!account.allowedChats.includes(identity.chatId)) {
      return { allowed: false, reason: "chat_not_allowed" };
    }
    if (account.requireMentionInGroup && !identity.mentionsBot) {
      return { allowed: false, reason: "mention_required" };
    }
  }

  return { allowed: true, role };
}

export function authorizeFeishuAdmin(
  account: FeishuAccountConfig,
  senderOpenId: string,
): boolean {
  return account.enabled && account.adminUsers.includes(senderOpenId);
}

export function authorizeFeishuApproval(
  account: FeishuAccountConfig,
  senderOpenId: string,
  operationUserIds: readonly string[],
): boolean {
  return (
    account.enabled &&
    (account.adminUsers.includes(senderOpenId) ||
      operationUserIds.includes(senderOpenId))
  );
}
