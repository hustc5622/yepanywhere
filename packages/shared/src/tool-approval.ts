export type ToolApprovalPersistenceKind =
  | "session"
  | "command-policy"
  | "network-policy";

export interface ToolApprovalPersistence {
  kind: ToolApprovalPersistenceKind;
  response: "approve_for_session" | "approve_always";
}

/**
 * Resolve the narrowest persistent approval offered by a provider request.
 *
 * Codex deliberately distinguishes its session cache from persisted command
 * and network policy amendments. Consumers must not collapse those decisions:
 * doing so can both mislabel the UI and send a response that falls back to a
 * one-shot approval when no `acceptForSession` decision was offered.
 */
export function getToolApprovalPersistence(
  toolInput: unknown,
): ToolApprovalPersistence | undefined {
  const input = asRecord(toolInput);
  if (!input) return undefined;

  const rawDecisions = input.availableDecisions;
  const hasAvailableDecisions = Array.isArray(rawDecisions);
  const decisions: unknown[] = hasAvailableDecisions ? rawDecisions : [];

  // Prefer the narrower session grant when a provider offers both a session
  // grant and a policy amendment through a reduced UI with one persistent
  // action.
  if (decisions.includes("acceptForSession")) {
    return { kind: "session", response: "approve_for_session" };
  }

  for (const decision of decisions) {
    const nativeDecision = asRecord(decision);
    if (asRecord(nativeDecision?.acceptWithExecpolicyAmendment)) {
      return { kind: "command-policy", response: "approve_always" };
    }

    const networkDecision = asRecord(
      nativeDecision?.applyNetworkPolicyAmendment,
    );
    const amendment = asRecord(networkDecision?.network_policy_amendment);
    // A deny amendment is a separate "deny and remember" action. Never expose
    // it through an affirmative persistent-approval button.
    if (amendment?.action === "allow") {
      return { kind: "network-policy", response: "approve_always" };
    }
  }

  // An explicit list is authoritative even if legacy proposal fields are also
  // present. Do not synthesize an action the provider omitted from that list.
  if (hasAvailableDecisions) return undefined;

  // Stable protocol variants may omit availableDecisions while retaining the
  // proposed amendment fields. Preserve the same semantics in that fallback.
  if (input.proposedExecpolicyAmendment != null) {
    return { kind: "command-policy", response: "approve_always" };
  }

  if (
    Array.isArray(input.proposedNetworkPolicyAmendments) &&
    input.proposedNetworkPolicyAmendments.some(
      (amendment) => asRecord(amendment)?.action === "allow",
    )
  ) {
    return { kind: "network-policy", response: "approve_always" };
  }

  // File-change approvals have a native session-scoped decision even in older
  // payloads that do not include an explicit availableDecisions list.
  if (input.approvalKind === "file_change") {
    return { kind: "session", response: "approve_for_session" };
  }

  return undefined;
}

/** Whether the active owner can honor Yep's deny-then-guide composite action. */
export function supportsToolApprovalFeedback(
  toolInput: unknown,
  source?: "process" | "codex-bridge" | "persisted",
): boolean {
  // Bridge server-request responses contain only the native decline decision;
  // they currently have no owned message queue for the follow-up guidance.
  if (source === "codex-bridge" || source === "persisted") return false;
  const input = asRecord(toolInput);
  if (input?.approvalKind === "permissions") return false;
  if (input?.approvalKind !== "mcp_tool_call") return true;

  const persistScopes = Array.isArray(input.persistScopes)
    ? input.persistScopes.filter((scope) => typeof scope === "string")
    : [];
  return persistScopes.length === 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
