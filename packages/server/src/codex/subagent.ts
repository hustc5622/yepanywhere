interface CodexSubagentMetadata {
  isSubagent: boolean;
  parentThreadId?: string;
  agentPath?: string;
  agentNickname?: string;
  agentRole?: string;
  depth?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getString(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function getNumber(
  record: Record<string, unknown> | null,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * Normalize Codex sub-agent metadata from both persistence formats:
 *
 * - rollout JSONL uses snake_case and `source.subagent`
 * - app-server thread payloads use camelCase and `source.subAgent`
 *
 * `forkedFromId` alone is intentionally not treated as a sub-agent marker;
 * user-created forks are still top-level, user-visible sessions.
 */
export function getCodexSubagentMetadata(
  value: unknown,
): CodexSubagentMetadata {
  const record = asRecord(value);
  if (!record) return { isSubagent: false };

  const source = asRecord(record.source);
  const hasSubagentSource =
    !!source &&
    (Object.hasOwn(source, "subagent") || Object.hasOwn(source, "subAgent"));
  const subagentSource = hasSubagentSource
    ? (source?.subagent ?? source?.subAgent)
    : undefined;
  const subagentRecord = asRecord(subagentSource);
  const threadSpawn = asRecord(
    subagentRecord?.thread_spawn ?? subagentRecord?.threadSpawn,
  );

  const threadSource = getString(record, "thread_source", "threadSource");
  let parentThreadId =
    getString(record, "parent_thread_id", "parentThreadId") ??
    getString(threadSpawn, "parent_thread_id", "parentThreadId");

  // Recent Codex rollouts also keep the root session id on child metadata.
  // Use it only after another field has already identified this as a subagent.
  const isSubagent =
    hasSubagentSource || threadSource === "subagent" || !!parentThreadId;
  if (!parentThreadId && isSubagent) {
    const id = getString(record, "id");
    const sessionId = getString(record, "session_id", "sessionId");
    if (sessionId && sessionId !== id) {
      parentThreadId = sessionId;
    }
  }

  return {
    isSubagent,
    parentThreadId,
    agentPath:
      getString(record, "agent_path", "agentPath") ??
      getString(threadSpawn, "agent_path", "agentPath"),
    agentNickname:
      getString(record, "agent_nickname", "agentNickname") ??
      getString(threadSpawn, "agent_nickname", "agentNickname"),
    agentRole:
      getString(record, "agent_role", "agentRole") ??
      getString(threadSpawn, "agent_role", "agentRole"),
    depth: getNumber(threadSpawn, "depth"),
  };
}
