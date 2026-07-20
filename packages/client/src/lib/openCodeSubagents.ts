export type OpenCodeSubagentStatus =
  | "pending"
  | "complete"
  | "error"
  | "aborted";

export type OpenCodeTaskState = "running" | "completed" | "error";

interface OpenCodeTaskMetadata {
  sessionId?: unknown;
  background?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getOpenCodeTaskMetadata(
  input: unknown,
): OpenCodeTaskMetadata | undefined {
  if (!isRecord(input) || !isRecord(input.opencodeMetadata)) return undefined;
  return input.opencodeMetadata;
}

export function getOpenCodeSubagentSessionId(
  input: unknown,
): string | undefined {
  const sessionId = getOpenCodeTaskMetadata(input)?.sessionId;
  return typeof sessionId === "string" && sessionId.startsWith("ses_")
    ? sessionId
    : undefined;
}

export function isOpenCodeBackgroundTask(input: unknown): boolean {
  return getOpenCodeTaskMetadata(input)?.background === true;
}

function getTagAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"),
  );
  return match?.[1];
}

/** Extract provider-emitted task lifecycle markers from OpenCode output. */
export function extractOpenCodeTaskStateUpdates(
  text: string,
): Array<{ sessionId: string; state: OpenCodeTaskState }> {
  const updates: Array<{ sessionId: string; state: OpenCodeTaskState }> = [];
  const taskTag = /<task\b([^>]*)>/gi;

  for (const match of text.matchAll(taskTag)) {
    const attributes = match[1] ?? "";
    const sessionId = getTagAttribute(attributes, "id");
    const state = getTagAttribute(attributes, "state")?.toLowerCase();
    if (
      !sessionId?.startsWith("ses_") ||
      (state !== "running" && state !== "completed" && state !== "error")
    ) {
      continue;
    }
    updates.push({ sessionId, state });
  }

  return updates;
}

export function stringifyOpenCodeTaskResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function statusFromTaskState(state: OpenCodeTaskState): OpenCodeSubagentStatus {
  switch (state) {
    case "running":
      return "pending";
    case "error":
      return "error";
    case "completed":
      return "complete";
  }
}

/**
 * Resolve OpenCode's child-task lifecycle rather than treating successful
 * completion of the launcher tool as completion of a background subagent.
 */
export function resolveOpenCodeTaskStatus(
  input: unknown,
  result: unknown,
  status: OpenCodeSubagentStatus,
  latestState?: OpenCodeTaskState,
): OpenCodeSubagentStatus {
  // A launcher error/interruption is authoritative even if an older lifecycle
  // marker for a resumed child session exists elsewhere in the transcript.
  if (status === "error" || status === "aborted") return status;

  const sessionId = getOpenCodeSubagentSessionId(input);
  const resultState = sessionId
    ? extractOpenCodeTaskStateUpdates(stringifyOpenCodeTaskResult(result))
        .filter((update) => update.sessionId === sessionId)
        .at(-1)?.state
    : undefined;
  const taskState = latestState ?? resultState;
  if (taskState) return statusFromTaskState(taskState);

  // Background launchers return successfully as soon as the child starts.
  // Without a terminal notification, "pending" is the least misleading state.
  if (isOpenCodeBackgroundTask(input) && status === "complete") {
    return "pending";
  }

  return status;
}
