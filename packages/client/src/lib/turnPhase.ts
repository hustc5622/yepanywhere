import type { RenderItem } from "../types/renderItems";

export type TurnPhase = "llm" | "tools";

/** Infer the foreground phase from the current turn's latest activity. */
export function getTurnPhase(items: RenderItem[]): TurnPhase | undefined {
  let toolsRunning = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.isSubagent) continue;
    // Fresh model output closes the preceding tool batch. Old missing results
    // must not leave the phase stuck on tools after the model has continued.
    if (item.type === "text" || item.type === "thinking") break;
    if (item.type === "tool_call") {
      if (item.status === "pending" && !item.toolResult) {
        if (/^(AskUserQuestion|question)$/i.test(item.toolName))
          return undefined;
        toolsRunning = true;
      }
    } else if (item.type === "display_tool_group") {
      const group = item.group;
      if (group.type === "action_required") {
        if (group.status === "running") return undefined;
      } else {
        toolsRunning ||=
          (group.runningCount ?? (group.status === "running" ? 1 : 0)) > 0;
      }
    } else if (
      item.type === "codex_native_item" &&
      item.threadItem.type === "collabAgentToolCall"
    ) {
      // A background agent can remain active after its spawn call completes.
      // Only the foreground collaboration call counts as waiting on a tool.
      toolsRunning ||=
        item.lifecycle === "started" && item.threadItem.status === "inProgress";
    }
  }
  return toolsRunning ? "tools" : "llm";
}
