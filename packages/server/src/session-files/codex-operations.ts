import { join } from "node:path";
import type { SessionFileOperationChange } from "@yep-anywhere/shared";
import { getDataDir } from "../config.js";
import { getLogger } from "../logging/logger.js";
import type { ThreadItem } from "../sdk/providers/codex-protocol/index.js";
import { SessionFileOperationStore } from "./operation-store.js";

let defaultStore: SessionFileOperationStore | undefined;
export function getSessionFileOperationStore(): SessionFileOperationStore {
  const directory = join(getDataDir(), "session-file-operations");
  if (defaultStore?.directory !== directory)
    defaultStore = new SessionFileOperationStore(directory);
  return defaultStore;
}

export interface FileOperationContext {
  sessionId: string;
  workspace: string;
  sourceId?: string;
  timestamp?: string;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Consume settled native file facts before the transport's journal retention policy. */
export async function recordCodexFileNotification(
  store: SessionFileOperationStore,
  context: FileOperationContext,
  notification: { method: string; params?: unknown },
): Promise<void> {
  const params = object(notification.params);
  if (!params || params.threadId !== context.sessionId) return;
  if (notification.method === "turn/completed") {
    const turn = object(params.turn);
    if (typeof turn?.id !== "string" || !Array.isArray(turn.items)) return;
    for (const item of turn.items)
      await recordCodexFileNotification(store, context, {
        method: "item/completed",
        params: { threadId: context.sessionId, turnId: turn.id, item },
      });
    return;
  }
  if (
    notification.method !== "item/completed" &&
    notification.method !== "item/started"
  )
    return;
  const input = object(params.item);
  if (
    input?.type !== "fileChange" ||
    typeof input.id !== "string" ||
    typeof params.turnId !== "string" ||
    !Array.isArray(input.changes)
  )
    return;
  // Validate the consumed subset instead of asserting an unvalidated native payload.
  if (
    !["completed", "inProgress", "failed", "declined"].includes(
      String(input.status),
    )
  )
    return;
  const item = input as unknown as Extract<ThreadItem, { type: "fileChange" }>;
  const applied =
    notification.method === "item/completed" && item.status === "completed";
  const changes: SessionFileOperationChange[] = [];
  for (const raw of item.changes) {
    if (
      typeof raw.path !== "string" ||
      !raw.path ||
      typeof raw.diff !== "string"
    )
      continue;
    const kind = object(raw.kind);
    if (!kind || !["add", "delete", "update"].includes(String(kind.type)))
      continue;
    const movePath =
      typeof kind.movePath === "string" ? kind.movePath : undefined;
    const change: SessionFileOperationChange = {
      path: movePath ?? raw.path,
      ...(movePath ? { previousPath: raw.path } : {}),
      kind:
        kind.type === "add"
          ? "added"
          : kind.type === "delete"
            ? "deleted"
            : movePath
              ? "renamed"
              : "modified",
      outcome: applied ? "applied" : "unknown",
      ...(kind.type === "add"
        ? { before: null }
        : kind.type === "delete"
          ? { after: null }
          : {}),
    };
    if (applied && (kind.type === "add" || kind.type === "delete")) {
      // Native add/delete `diff` is whole-file content, NOT a unified patch.
      try {
        const content = await store.putContent(Buffer.from(raw.diff));
        if (kind.type === "add") change.after = content;
        else change.before = content;
      } catch {
        change.unavailableReason = "capture-failed";
      }
    } else if (applied && raw.diff.length <= 4 * 1024 * 1024) {
      const suffix = movePath ? `\n\nMoved to: ${movePath}` : "";
      const patch =
        suffix && raw.diff.endsWith(suffix)
          ? raw.diff.slice(0, -suffix.length)
          : raw.diff;
      change.patch = { format: "unified", text: patch, complete: true };
    } else if (applied) change.unavailableReason = "limit";
    changes.push(change);
  }
  if (!changes.length) return;
  const parsedTime = context.timestamp
    ? Date.parse(context.timestamp)
    : Number.NaN;
  const now = Number.isFinite(parsedTime) ? parsedTime : Date.now();
  await store.append({
    schemaVersion: 1,
    identity: {
      provider: "codex",
      sourceId: context.sourceId ?? "local",
      sessionId: context.sessionId,
      turnId: params.turnId,
      toolCallId: item.id,
    },
    workspace: context.workspace,
    branchId: context.sessionId,
    messageId: item.id,
    timestamp: new Date(now).toISOString(),
    order: now,
    toolName: "apply_patch",
    source: "native-file-event",
    outcome: applied
      ? "applied"
      : item.status === "declined"
        ? "declined"
        : item.status === "failed"
          ? "unknown"
          : "pending",
    ...(applied ? { resultId: `item/completed:${item.id}` } : {}),
    changes,
  });
}

/** File indexing is observational: its storage failures cannot change tool execution semantics. */
export async function observeCodexFileNotification(
  context: FileOperationContext,
  notification: { method: string; params?: unknown },
  store = getSessionFileOperationStore(),
): Promise<void> {
  try {
    await recordCodexFileNotification(store, context, notification);
  } catch (error) {
    getLogger().warn(
      { error, sessionId: context.sessionId },
      "Session file operation capture failed",
    );
  }
}
