import type {
  AssistantOutputToolGroupItem,
  RenderItem,
  ToolCallItem,
} from "../types/renderItems";
import { isPlanProgressItem } from "./preprocessMessages";

function isReadableAssistantOutput(item: RenderItem): boolean {
  return item.type === "text" && item.text.trim().length > 0;
}

function isQuestionTool(item: ToolCallItem): boolean {
  const normalized = item.toolName.toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "question" || normalized === "askuserquestion";
}

function buildGroup(tools: ToolCallItem[]): AssistantOutputToolGroupItem {
  const first = tools[0];
  const last = tools.at(-1);
  return {
    type: "assistant_output_tool_group",
    id: `assistant-output-tools:${first?.id ?? "missing"}:${last?.id ?? "missing"}`,
    tools,
    sourceMessages: tools.flatMap((tool) => tool.sourceMessages),
    ...(tools.every((tool) => tool.isSubagent) ? { isSubagent: true } : {}),
  };
}

/**
 * Collapse a completed visual tool run once a later user-readable assistant
 * message closes it. The unfinished tail after the latest output remains as
 * ordinary tool_call rows so live progress and partial output stay visible.
 *
 * User prompts reset look-ahead, and interactive question tools stay explicit
 * because they represent a user interaction boundary in MessageList.
 */
export function groupToolsBeforeAssistantOutput(
  items: readonly RenderItem[],
): RenderItem[] {
  const hasReadableOutputAhead = new Array<boolean>(items.length).fill(false);
  let readableOutputAhead = false;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (item.type === "user_prompt" || item.type === "session_setup") {
      readableOutputAhead = false;
      continue;
    }
    hasReadableOutputAhead[index] = readableOutputAhead;
    if (isReadableAssistantOutput(item)) readableOutputAhead = true;
  }

  const projected: RenderItem[] = [];
  for (let index = 0; index < items.length; ) {
    const item = items[index];
    if (
      !item ||
      item.type !== "tool_call" ||
      isQuestionTool(item) ||
      isPlanProgressItem(item) ||
      !hasReadableOutputAhead[index]
    ) {
      if (item) projected.push(item);
      index += 1;
      continue;
    }

    const tools: ToolCallItem[] = [];
    while (index < items.length) {
      const candidate = items[index];
      if (
        !candidate ||
        candidate.type !== "tool_call" ||
        isQuestionTool(candidate) ||
        isPlanProgressItem(candidate) ||
        !hasReadableOutputAhead[index]
      ) {
        break;
      }
      tools.push(candidate);
      index += 1;
    }
    projected.push(buildGroup(tools));
  }

  return projected;
}
