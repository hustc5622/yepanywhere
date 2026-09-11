import { iterateCodexRolloutLines } from "./codex-rollout-file.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function singleImage(output: unknown): string | null {
  if (!Array.isArray(output)) return null;
  const images = output
    .map(record)
    .filter((part) => part?.type === "input_image");
  return images.length === 1 && typeof images[0]?.image_url === "string"
    ? images[0].image_url
    : null;
}

/**
 * Recover the image sent to the model from its durable tool response.
 *
 * Codex ImageView ThreadItems contain only a path. Direct view_image calls
 * have an exact call_id; code-mode nested calls instead emit ImageView events
 * inside an exec, whose response contains the images forwarded with image().
 * Only accept an unambiguous one-view / one-image execution. Several views,
 * overlapping executions, or missing image() output must never be guessed
 * from a filename or image order. Compaction copies are not tool responses.
 */
export async function readCodexImageSnapshot(
  filePath: string,
  itemId: string,
): Promise<string | null> {
  const activeCalls = new Map<
    string,
    { direct: boolean; views: Set<string>; ambiguous: boolean }
  >();
  for await (const { line } of iterateCodexRolloutLines(filePath, {
    maxLineBytes: 32 * 1024 * 1024,
    maxBytes: 512 * 1024 * 1024,
  })) {
    let entry: RecordValue | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      // A running rollout may end with an incomplete line.
      continue;
    }
    const payload = record(entry?.payload);
    if (!payload) continue;
    if (entry?.type === "event_msg") {
      if (payload.type === "task_started" || payload.type === "turn_aborted") {
        activeCalls.clear();
      }
      const item = record(payload.item);
      if (
        payload.type === "item_completed" &&
        (item?.type === "ImageView" || item?.type === "imageView") &&
        typeof item.id === "string"
      ) {
        for (const call of activeCalls.values()) {
          call.views.add(item.id);
          if (activeCalls.size !== 1) call.ambiguous = true;
        }
      }
      continue;
    }
    if (entry?.type !== "response_item") continue;
    const callId = payload.call_id;
    if (typeof callId !== "string") continue;
    if (
      payload.type === "function_call" ||
      payload.type === "custom_tool_call"
    ) {
      const name = typeof payload.name === "string" ? payload.name : "";
      const tool = name.split(".").pop();
      if (tool === "view_image" || tool === "exec" || tool === "wait") {
        activeCalls.set(callId, {
          direct: tool === "view_image",
          views: new Set(),
          ambiguous: false,
        });
      }
      continue;
    }
    if (
      payload.type !== "function_call_output" &&
      payload.type !== "custom_tool_call_output"
    )
      continue;
    const call = activeCalls.get(callId);
    activeCalls.delete(callId);
    if (!call) continue;
    if (call.direct && callId === itemId) return singleImage(payload.output);
    if (call.views.has(itemId)) {
      return !call.ambiguous && call.views.size === 1
        ? singleImage(payload.output)
        : null;
    }
  }
  return null;
}
