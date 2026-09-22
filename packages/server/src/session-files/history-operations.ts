import type { SessionFileOperationChange } from "@yep-anywhere/shared";
import { isUserPromptMessage } from "../sessions/user-prompt-message.js";
import type { Message } from "../supervisor/types.js";
import { recordCodexFileNotification } from "./codex-operations.js";
import type { SessionFileOperationStore } from "./operation-store.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function blocks(message: Message): Record<string, unknown>[] {
  const content = message.message?.content ?? message.content;
  return Array.isArray(content)
    ? content
        .map(object)
        .filter((value): value is Record<string, unknown> => Boolean(value))
    : [];
}
function resultObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string" && value.length < 8 * 1024 * 1024) {
    try {
      return object(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return object(value);
}

export async function importCodexFileHistory(
  store: SessionFileOperationStore,
  context: { sessionId: string; workspace: string },
  entries: readonly unknown[],
  messages: readonly Message[],
): Promise<void> {
  const turns = new Map<string, string>();
  for (const message of messages) {
    const turn = message.codexTurnId ?? message.turnId;
    if (typeof turn !== "string") continue;
    for (const block of blocks(message))
      if (block.type === "tool_use" && typeof block.id === "string")
        turns.set(block.id, turn.replace(/^turn:/, ""));
  }
  for (const entry of entries) {
    const event = object(entry);
    const envelope = object(event?.payload);
    if (
      typeof envelope?.thread_id === "string" &&
      envelope.thread_id !== context.sessionId
    )
      continue;
    const item =
      envelope?.type === "item_completed" ? object(envelope.item) : undefined;
    // Current rollouts use typed completed items, including code-mode child tools.
    const payload =
      item?.type === "FileChange"
        ? ({
            ...item,
            type: "patch_apply_end",
            call_id: item.id,
            turn_id: envelope?.turn_id,
          } as Record<string, unknown>)
        : envelope;
    if (
      event?.type !== "event_msg" ||
      payload?.type !== "patch_apply_end" ||
      typeof payload.call_id !== "string"
    )
      continue;
    const turnId =
      typeof payload.turn_id === "string"
        ? payload.turn_id
        : turns.get(payload.call_id);
    const changes = object(payload.changes);
    if (!turnId || !changes) continue;
    const status =
      typeof payload.status === "string"
        ? payload.status
        : payload.success === true
          ? "completed"
          : payload.success === false
            ? "failed"
            : undefined;
    if (!status) continue; // Normalized display defaults must not invent historical success.
    const converted = Object.entries(changes).flatMap(([path, value]) => {
      const change = object(value);
      if (change?.type === "add" || change?.type === "delete")
        return typeof change.content === "string"
          ? [{ path, kind: { type: change.type }, diff: change.content }]
          : [];
      if (change?.type === "update" && typeof change.unified_diff === "string")
        return [
          {
            path,
            kind: { type: "update", movePath: change.move_path },
            diff: change.unified_diff,
          },
        ];
      return [];
    });
    await recordCodexFileNotification(
      store,
      {
        ...context,
        timestamp:
          typeof event.timestamp === "string" ? event.timestamp : undefined,
      },
      {
        method: "item/completed",
        params: {
          threadId: context.sessionId,
          turnId,
          item: {
            type: "fileChange",
            id: payload.call_id,
            status,
            changes: converted,
          },
        },
      },
    );
  }
}

/** Conservative compatibility for structured tool results; no shell parsing or disk reconstruction. */
export async function importStructuredFileHistory(
  store: SessionFileOperationStore,
  context: { provider: string; sessionId: string; workspace: string },
  messages: readonly Message[],
): Promise<void> {
  const results = new Map<
    string,
    { block: Record<string, unknown>; message: Message }
  >();
  for (const message of messages)
    for (const block of blocks(message)) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string")
        results.set(block.tool_use_id, { block, message });
    }
  let userId: string | undefined;
  for (const message of messages) {
    if (isUserPromptMessage(message))
      userId =
        message.uuid ??
        (typeof message.id === "string" ? message.id : undefined);
    if (!userId) continue;
    for (const call of blocks(message)) {
      if (
        call.type !== "tool_use" ||
        typeof call.id !== "string" ||
        typeof call.name !== "string"
      )
        continue;
      const name = call.name.toLowerCase().replace(/[^a-z]/g, "");
      if (
        !["edit", "write", "multiedit", "writefile", "editfile"].includes(name)
      )
        continue;
      const result = results.get(call.id);
      if (
        !result ||
        result.block.is_error === true ||
        ["error", "failed", "pending"].includes(String(result.block.status))
      )
        continue;
      const input = object(call.input);
      const output =
        resultObject(result.message.toolUseResult) ??
        resultObject(result.block.content);
      const path = output?.filePath ?? input?.file_path ?? input?.path;
      if (typeof path !== "string" || !path) continue;
      const original = output?.originalFile;
      const content = output?.content;
      const details = resultObject(output?.details);
      const patch =
        typeof details?.patch === "string"
          ? details.patch
          : typeof output?.patch === "string"
            ? output.patch
            : undefined;
      // Results must carry actual content or patch; inputs alone are proposed edits.
      if (original === undefined && !patch) continue;
      const before =
        original === null
          ? null
          : typeof original === "string"
            ? await store
                .putContent(Buffer.from(original))
                .catch(() => undefined)
            : undefined;
      const after =
        typeof content === "string"
          ? await store.putContent(Buffer.from(content)).catch(() => undefined)
          : undefined;
      const change: SessionFileOperationChange = {
        path,
        kind: before === null ? "added" : "modified",
        outcome: "applied",
        before,
        after,
      };
      if (patch && patch.length <= 4 * 1024 * 1024)
        change.patch = { format: "unified", text: patch, complete: true };
      else if (typeof original === "string" && typeof content === "string")
        change.patch = undefined;
      else if (output && Array.isArray(output.structuredPatch)) {
        // Full pre/post strings are preferred. Other patch layouts need a provider adapter.
        change.unavailableReason = "content-not-recorded";
      }
      const time =
        typeof message.timestamp === "string" &&
        Number.isFinite(Date.parse(message.timestamp))
          ? message.timestamp
          : new Date().toISOString();
      await store.append({
        schemaVersion: 1,
        identity: {
          provider: context.provider,
          sourceId: "local",
          sessionId: context.sessionId,
          turnId: userId,
          toolCallId: call.id,
        },
        workspace: context.workspace,
        branchId: context.sessionId,
        messageId: userId,
        timestamp: new Date(time).toISOString(),
        order: Date.parse(time),
        toolName: call.name,
        source: "historical-tool-record",
        resultId: String(result.message.uuid ?? call.id),
        outcome: "applied",
        changes: [change],
      });
    }
  }
}
