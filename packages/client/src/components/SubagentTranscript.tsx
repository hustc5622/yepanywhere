import { useCallback, useMemo, useRef, useState } from "react";
import { useNestedRenderers } from "../contexts/NestedRendererContext";
import { isPlanProgressItem } from "../lib/preprocessMessages";
import {
  type PreprocessMessagesCache,
  preprocessMessagesCached,
} from "../lib/preprocessMessagesCache";
import type { Message } from "../types";

/** Subagents share the main transcript pipeline, including nested agent cards. */
export function SubagentTranscript({
  messages,
  isStreaming,
  mode = "conversation",
  emptyMessage,
}: {
  messages: Message[];
  isStreaming: boolean;
  mode?: "conversation" | "result";
  emptyMessage?: string;
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
    return result.renderItems.filter((item) => !isPlanProgressItem(item));
  }, [messages]);
  const latestResult = renderItems
    .filter((item) => item.type === "text" && item.phase === "final_answer")
    .at(-1);
  const items =
    mode === "result" ? (latestResult ? [latestResult] : []) : renderItems;

  return (
    <div className="task-nested-content">
      {items.length === 0 && emptyMessage && (
        <p className="subagent-detail-empty">{emptyMessage}</p>
      )}
      {items.map((item) => (
        <RenderItemComponent
          key={item.id}
          item={item}
          isStreaming={isStreaming}
          thinkingExpanded={expandedThinkingItemIds.has(item.id)}
          toggleThinkingExpanded={toggleThinkingExpanded}
        />
      ))}
    </div>
  );
}
