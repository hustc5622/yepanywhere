import type { Message } from "../types";
import type {
  CodexNativeItem,
  CodexSubagentActivity,
  CodexSubagentCommunicationPreview,
  RenderItem,
  ToolCallItem,
} from "../types/renderItems";
import { getMessageId } from "./mergeMessages";

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function uniqueSources(messages: Message[]): Message[] {
  const seen = new Set<string | Message>();
  return messages.filter((message) => {
    const key = getMessageId(message) || message;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function eventKeys(event: CodexSubagentActivity["events"][number]): string[] {
  if (event.communicationKey) return [event.communicationKey];
  return [event.id, event.nativeId].filter((id): id is string => !!id);
}

function communicationKey(item: CodexNativeItem): string {
  const native = item.threadItem;
  return JSON.stringify([
    item.threadId ??
      item.sourceMessages.find((source) => source.codexThreadId)
        ?.codexThreadId ??
      null,
    item.turnId ??
      item.sourceMessages.find((source) => source.codexTurnId)?.codexTurnId ??
      null,
    string(native.id) ?? item.id,
    native.kind,
    native.sender,
    native.recipient,
  ]);
}

function communicationPreview(
  item: CodexNativeItem,
): CodexSubagentCommunicationPreview {
  const native = item.threadItem;
  return {
    ...(string(native.text) ? { text: string(native.text) } : {}),
    encrypted: native.encrypted === true,
    ...(native.truncated === true ? { truncated: true } : {}),
  };
}

function preferPreview(
  previous: CodexSubagentCommunicationPreview | undefined,
  incoming: CodexSubagentCommunicationPreview,
): CodexSubagentCommunicationPreview {
  if (!previous) return incoming;
  if (
    !incoming.encrypted &&
    incoming.text &&
    (previous.encrypted ||
      !previous.text ||
      (previous.truncated && !incoming.truncated) ||
      (Boolean(previous.truncated) === Boolean(incoming.truncated) &&
        incoming.text.length > previous.text.length))
  ) {
    return incoming;
  }
  return previous;
}

function operation(tool: ToolCallItem | undefined): string | undefined {
  return tool ? codexCollaborationOperation(tool.toolName) : undefined;
}

function codexCollaborationOperation(name: string): string | undefined {
  if (!/[./]/.test(name)) return name;
  const match = /^(?:collaboration|multi_agent_v1)[./]([^./]+)$/.exec(name);
  return match?.[1];
}

function rawCallId(id: string): string {
  if (!id.startsWith("dt2.")) return id;
  try {
    const decoded: unknown = JSON.parse(
      atob(id.slice(4).replace(/-/g, "+").replace(/_/g, "/")),
    );
    return Array.isArray(decoded) && typeof decoded[1] === "string"
      ? decoded[1]
      : id;
  } catch {
    return id;
  }
}

/** Coordination logs belong in child details, except actionable failures. */
export function isHiddenCodexMainControlTool(
  name: string,
  status: string,
  id: string,
  representedCallIds: readonly string[] = [],
): boolean {
  if (["error", "failed", "aborted", "interrupted"].includes(status))
    return false;
  const tool = codexCollaborationOperation(name);
  if (
    [
      "send_message",
      "list_agents",
      "interrupt_agent",
      "close_agent",
      "resume_agent",
    ].includes(tool ?? "")
  )
    return true;
  const represented = representedCallIds.includes(rawCallId(id));
  if (["spawn_agent", "followup_task", "wait_agent"].includes(tool ?? ""))
    return represented;
  // Bare/functions.wait is also a command-execution poll. Only an explicit
  // collaboration namespace or a matching native agent wait disambiguates it.
  return tool === "wait" && represented;
}

/** Presentation-only projection. Keep the cached accumulation available to details. */
export function projectCodexMainTimeline(items: RenderItem[]): RenderItem[] {
  const accumulated = collapseCodexSubagentActivities(items);
  const entries = new Map<string, CodexNativeItem>();
  const represented = new Set<string>();
  for (const item of accumulated) {
    if (item.type !== "codex_native_item") continue;
    if (item.threadItem.type === "agentWait") {
      const id = string(item.threadItem.id);
      if (id) represented.add(id);
    }
    if (
      item.threadItem.type === "collabAgentToolCall" &&
      item.threadItem.tool === "spawnAgent"
    ) {
      const id = string(item.threadItem.id);
      if (id) {
        represented.add(id);
        entries.set(id, item);
      }
    }
    if (item.threadItem.type === "subAgentActivity") {
      for (const event of item.subagentActivity?.events ?? []) {
        if (event.kind !== "started") continue;
        const id = event.nativeId ?? event.id;
        represented.add(id);
        entries.set(id, item);
      }
    }
  }
  const representedIds = [...represented];
  const placedEntries = new Set<CodexNativeItem>();
  const projected: RenderItem[] = [];
  const entry = (item: CodexNativeItem): CodexNativeItem => ({
    ...item,
    ...(item.subagentActivity
      ? {
          subagentActivity: {
            events: item.subagentActivity.events,
            entryKind: item.subagentActivity.entryKind,
            orphanTerminal: item.subagentActivity.orphanTerminal,
          },
        }
      : {}),
  });

  for (const item of accumulated) {
    if (item.type === "tool_call") {
      const replacement = entries.get(item.id);
      if (
        replacement &&
        ["spawn_agent", "followup_task"].includes(operation(item) ?? "")
      ) {
        if (!placedEntries.has(replacement)) {
          projected.push({
            ...entry(replacement),
            sourceMessages: uniqueSources([
              ...item.sourceMessages,
              ...replacement.sourceMessages,
            ]),
          });
          placedEntries.add(replacement);
        }
        continue;
      }
      if (
        isHiddenCodexMainControlTool(
          item.toolName,
          item.status,
          item.id,
          representedIds,
        )
      )
        continue;
    }
    if (item.type === "codex_native_item") {
      if (item.threadItem.type === "interAgentMessage") continue;
      if (
        item.threadItem.type === "collabAgentToolCall" &&
        item.threadItem.tool === "spawnAgent"
      ) {
        if (!placedEntries.has(item)) {
          projected.push(item);
          placedEntries.add(item);
        }
        continue;
      }
      if (item.threadItem.type === "subAgentActivity") {
        if (item.threadItem.kind === "interacted" || placedEntries.has(item))
          continue;
        projected.push(entry(item));
        placedEntries.add(item);
        continue;
      }
      if (
        item.threadItem.type === "collabAgentToolCall" &&
        item.threadItem.tool !== "spawnAgent" &&
        item.threadItem.tool !== "wait" &&
        item.threadItem.status !== "failed"
      )
        continue;
    }
    if (item.type === "display_tool_group") {
      const group = item.group;
      if (group.type === "tool_group") {
        const steps = group.steps?.filter(
          (step) =>
            !isHiddenCodexMainControlTool(
              step.name,
              step.status,
              step.id,
              representedIds,
            ),
        );
        const allStepsKnown = group.steps?.length === group.count;
        const onlyHiddenNames =
          group.toolNames.length > 0 &&
          group.toolNames.length < 5 &&
          group.toolNames.every((name) =>
            isHiddenCodexMainControlTool(name, "complete", "", representedIds),
          );
        if (
          (allStepsKnown && steps?.length === 0) ||
          (group.failedCount === 0 && onlyHiddenNames)
        )
          continue;
        projected.push({
          ...item,
          mainTimeline: true,
          representedAgentCallIds: representedIds,
          group: {
            ...group,
            ...(steps ? { steps } : {}),
            ...(allStepsKnown && steps
              ? {
                  count: steps.length,
                  toolNames: [...new Set(steps.map((step) => step.name))],
                }
              : {}),
          },
        });
        continue;
      }
    }
    projected.push(item);
  }
  return projected;
}

function isTerminal(item: CodexNativeItem): boolean {
  return ["completed", "interrupted"].includes(String(item.threadItem.kind));
}

/**
 * One card per child execution, not one card per lifecycle notification.
 * Parent turn boundaries do not finish a child. Only a new start/follow-up or
 * its own terminal event separates executions. Event identities survive this
 * pass so persisted pages and an already-processed live tail can be combined.
 */
export function collapseCodexSubagentActivities(
  items: RenderItem[],
): RenderItem[] {
  const result: RenderItem[] = [];
  const latestByAgent = new Map<string, number>();
  const seenEvents = new Map<string, number>();
  const seenCommunications = new Map<string, number>();
  const seenWaits = new Map<string, number>();
  const tools = new Map(
    items
      .filter((item): item is ToolCallItem => item.type === "tool_call")
      .map((item) => [item.id, item]),
  );

  const remember = (item: CodexNativeItem, index: number) => {
    for (const event of item.subagentActivity?.events ?? []) {
      if (event.communicationKey) {
        seenCommunications.set(event.communicationKey, index);
      } else {
        for (const key of eventKeys(event)) seenEvents.set(key, index);
      }
    }
    const threadId = string(item.threadItem.agentThreadId);
    const path = string(item.threadItem.agentPath);
    for (const identity of [threadId, path]) {
      if (identity && index >= (latestByAgent.get(identity) ?? -1)) {
        latestByAgent.set(identity, index);
      }
    }
  };

  const merge = (index: number, incoming: CodexNativeItem) => {
    const previous = result[index] as CodexNativeItem;
    const eventIds = new Set(
      previous.subagentActivity?.events.flatMap(eventKeys),
    );
    const events = [
      ...(previous.subagentActivity?.events ?? []),
      ...(incoming.subagentActivity?.events ?? []).filter(
        (event) => !eventKeys(event).some((key) => eventIds.has(key)),
      ),
    ];
    // A late replay of the start must never regress a finished round.
    const latest = isTerminal(previous) ? previous : incoming;
    const merged: CodexNativeItem = {
      ...previous,
      threadItem: {
        ...previous.threadItem,
        kind: latest.threadItem.kind,
      },
      lifecycle: latest.lifecycle,
      sourceMessages: uniqueSources([
        ...previous.sourceMessages,
        ...incoming.sourceMessages,
      ]),
      subagentActivity: {
        ...previous.subagentActivity,
        ...incoming.subagentActivity,
        events,
        entryKind:
          previous.subagentActivity?.entryKind ??
          incoming.subagentActivity?.entryKind,
        orphanTerminal: !events.some((event) => event.kind === "started"),
      },
    };
    result[index] = merged;
    remember(merged, index);
  };

  for (const item of items) {
    if (item.type !== "codex_native_item") {
      result.push(item);
      continue;
    }

    const native = item.threadItem;
    if (native.type === "agentWait") {
      const key = communicationKey(item);
      const previousIndex = seenWaits.get(key);
      if (previousIndex === undefined) {
        seenWaits.set(key, result.length);
        result.push(item);
      } else {
        const previous = result[previousIndex] as CodexNativeItem;
        const latest =
          previous.threadItem.status !== "running" &&
          native.status === "running"
            ? previous
            : item;
        result[previousIndex] = {
          ...previous,
          threadItem: { ...previous.threadItem, ...latest.threadItem },
          lifecycle: latest.lifecycle,
          sourceMessages: uniqueSources([
            ...previous.sourceMessages,
            ...item.sourceMessages,
          ]),
        };
      }
      continue;
    }
    if (native.type === "interAgentMessage") {
      const key = communicationKey(item);
      const replayIndex = seenCommunications.get(key);
      if (replayIndex !== undefined) {
        const previous = result[replayIndex] as CodexNativeItem;
        const preview = preferPreview(
          communicationPreview(previous),
          communicationPreview(item),
        );
        result[replayIndex] = {
          ...previous,
          threadItem: {
            ...previous.threadItem,
            ...preview,
            truncated: preview.truncated === true,
          },
          sourceMessages: uniqueSources([
            ...previous.sourceMessages,
            ...item.sourceMessages,
          ]),
        };
        continue;
      }
      // Communications stay independent in the accumulation pipeline so the
      // child detail can show every assignment, message and returned result.
      seenCommunications.set(key, result.length);
      result.push(item);
      continue;
    }

    if (native.type !== "subAgentActivity") {
      result.push(item);
      continue;
    }

    const threadId = string(native.agentThreadId);
    const path = string(native.agentPath);
    const agent = threadId ?? path;
    if (!agent) {
      result.push(item);
      continue;
    }

    const nativeId = string(native.id);
    const tool = nativeId ? tools.get(nativeId) : undefined;
    const followup =
      native.kind === "interacted" &&
      (string(native.operation) ?? operation(tool)) === "followup_task";
    const kind = followup ? "started" : string(native.kind);
    if (!["started", "completed", "interrupted"].includes(kind ?? "")) {
      result.push(item);
      continue;
    }

    const incoming: CodexNativeItem = {
      ...item,
      threadItem: {
        ...native,
        kind,
        ...(followup ? { operation: "followup_task" } : {}),
      },
      subagentActivity: item.subagentActivity ?? {
        events: [{ id: item.id, nativeId, kind: kind ?? "" }],
        ...(kind === "started"
          ? { entryKind: followup ? ("followup" as const) : ("spawn" as const) }
          : {}),
        orphanTerminal: kind !== "started",
      },
    };
    const replayIndex = incoming.subagentActivity?.events
      .flatMap(eventKeys)
      .map((key) => seenEvents.get(key))
      .find((index) => index !== undefined);
    if (replayIndex !== undefined) {
      merge(replayIndex, incoming);
      continue;
    }

    const previousIndex = latestByAgent.get(agent);
    const previous =
      previousIndex === undefined ? undefined : result[previousIndex];
    if (
      previousIndex !== undefined &&
      previous?.type === "codex_native_item" &&
      !isTerminal(previous) &&
      (followup ||
        !incoming.subagentActivity?.events.some(
          (event) => event.kind === "started",
        ))
    ) {
      merge(previousIndex, incoming);
      continue;
    }

    const index = result.length;
    result.push(incoming);
    remember(incoming, index);
  }

  return result;
}
