import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { useNestedRenderers } from "../contexts/NestedRendererContext";
import { isPlanProgressItem } from "../lib/preprocessMessages";
import {
  type PreprocessMessagesCache,
  preprocessMessagesCached,
} from "../lib/preprocessMessagesCache";
import type { Message } from "../types";
import type { RenderItem } from "../types/renderItems";

function isAssignedTask(item: RenderItem, agentPath?: string): boolean {
  return (
    item.type === "codex_native_item" &&
    item.threadItem.type === "interAgentMessage" &&
    item.threadItem.kind === "task" &&
    (!agentPath || item.threadItem.recipient === agentPath)
  );
}

/** Subagents share the main transcript pipeline, including nested agent cards. */
export function SubagentTranscript({
  messages,
  isStreaming,
  mode = "conversation",
  emptyMessage,
  inheritedContext,
  agentPath,
}: {
  messages: Message[];
  isStreaming: boolean;
  mode?: "conversation" | "result";
  emptyMessage?: string;
  inheritedContext?: ReactNode;
  agentPath?: string;
}) {
  const { RenderItem: RenderItemComponent } = useNestedRenderers();
  const [expandedThinkingItemIds, setExpandedThinkingItemIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const preprocessCacheRef = useRef<PreprocessMessagesCache | null>(null);
  const toggleThinkingExpanded = useCallback((itemId: string) => {
    setExpandedThinkingItemIds((previous) => {
      const next = new Set(previous);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);
  const renderItems = useMemo(() => {
    const result = preprocessMessagesCached(
      messages,
      undefined,
      preprocessCacheRef.current,
    );
    preprocessCacheRef.current = result.cache;
    let previousFinal: string | undefined;
    return result.renderItems
      .filter((item) => !isPlanProgressItem(item))
      .map((item) => {
        if (item.type === "text" && item.phase === "final_answer") {
          previousFinal = item.text.trim();
        } else if (
          agentPath &&
          item.type === "codex_native_item" &&
          item.threadItem.type === "interAgentMessage" &&
          item.threadItem.kind === "result" &&
          item.threadItem.sender === agentPath &&
          typeof item.threadItem.text === "string" &&
          item.threadItem.text.trim() === previousFinal
        ) {
          return {
            ...item,
            threadItem: {
              ...item.threadItem,
              text: undefined,
              resultAlreadyShown: true,
            },
          };
        }
        return item;
      });
  }, [messages, agentPath]);
  let lastTaskIndex = -1;
  for (let index = renderItems.length - 1; index >= 0; index--) {
    const item = renderItems[index];
    if (item && isAssignedTask(item, agentPath)) {
      lastTaskIndex = index;
      break;
    }
  }
  const latestResult = renderItems
    .slice(Math.max(0, lastTaskIndex))
    .filter((item) => item.type === "text" && item.phase === "final_answer")
    .at(-1);
  const items =
    mode === "result" ? (latestResult ? [latestResult] : []) : renderItems;
  // Keep the inherited snapshot mounted across tabs so its disclosure and
  // loaded content survive. The assigned task comes before its background.
  const contextAfterFirstTask =
    !!renderItems[0] && isAssignedTask(renderItems[0], agentPath);
  const firstTask = contextAfterFirstTask ? renderItems[0] : undefined;
  const renderItem = (item: RenderItem) => (
    <RenderItemComponent
      key={item.id}
      item={item}
      isStreaming={isStreaming}
      thinkingExpanded={expandedThinkingItemIds.has(item.id)}
      toggleThinkingExpanded={toggleThinkingExpanded}
    />
  );

  return (
    <div className="task-nested-content">
      {mode === "conversation" && firstTask && renderItem(firstTask)}
      {inheritedContext}
      {items.length === 0 && emptyMessage && (
        <p className="subagent-detail-empty">{emptyMessage}</p>
      )}
      {items
        .filter((item) => mode !== "conversation" || item !== firstTask)
        .map(renderItem)}
    </div>
  );
}
