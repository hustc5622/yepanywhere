import type { ContentBlock, Message } from "../types";

/**
 * Represents a pending Task (Task tool_use without matching tool_result).
 */
export interface PendingTask {
  /** The tool_use block ID */
  toolUseId: string;
  /** Task description from input */
  description: string;
  /** Subagent type from input */
  subagentType: string;
}

/**
 * A Task/Agent tool call together with the number of persisted results seen
 * for it. Kimi mappings only become authoritative after a tool_result lands,
 * while other providers still need the pending-only view used historically.
 */
export interface AgentTask extends PendingTask {
  resultCount: number;
}

/** Find every Task/Agent tool call and count its matching tool results. */
export function findAgentTasks(messages: Message[]): AgentTask[] {
  const taskToolUses = new Map<
    string,
    { description: string; subagentType: string }
  >();
  const resultCounts = new Map<string, number>();

  for (const msg of messages) {
    // Get content from nested message object (SDK structure) first, fall back to top-level
    // Phase 4c: prefer message.content over top-level content
    const content =
      (msg.message as { content?: string | ContentBlock[] } | undefined)
        ?.content ?? msg.content;

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      // Find Task tool_use blocks
      if (
        block.type === "tool_use" &&
        (block.name === "Task" ||
          block.name === "Agent" ||
          block.name === "AgentSwarm") &&
        typeof block.id === "string"
      ) {
        const input = block.input as
          | {
              description?: string;
              subagent_type?: string;
            }
          | undefined;
        taskToolUses.set(block.id, {
          description: input?.description ?? "Unknown task",
          subagentType: input?.subagent_type ?? "unknown",
        });
      }

      // Find tool_result blocks
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        resultCounts.set(
          block.tool_use_id,
          (resultCounts.get(block.tool_use_id) ?? 0) + 1,
        );
      }
    }
  }

  return [...taskToolUses.entries()].map(
    ([toolUseId, { description, subagentType }]) => ({
      toolUseId,
      description,
      subagentType,
      resultCount: resultCounts.get(toolUseId) ?? 0,
    }),
  );
}

/** Find Task/Agent tool calls that do not yet have a matching tool result. */
export function findPendingTasks(messages: Message[]): PendingTask[] {
  return findAgentTasks(messages)
    .filter((task) => task.resultCount === 0)
    .map(({ toolUseId, description, subagentType }) => ({
      toolUseId,
      description,
      subagentType,
    }));
}
