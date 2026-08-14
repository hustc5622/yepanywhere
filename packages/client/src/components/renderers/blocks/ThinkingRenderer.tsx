import { useState } from "react";
import type { ContentBlock, ContentRenderer, RenderContext } from "../types";

interface ThinkingBlock extends ContentBlock {
  type: "thinking";
  thinking: string;
  signature?: string; // Never rendered
}

/**
 * Thinking renderer used by legacy nested content blocks.
 */
function ThinkingRendererComponent({
  block,
  context,
}: {
  block: ThinkingBlock;
  context: RenderContext;
}) {
  const thinking = block.thinking || "";
  const [isExpanded, setIsExpanded] = useState(false);

  if (isExpanded) {
    // Expanded: whole block is clickable to collapse
    return (
      <button
        type="button"
        className="thinking-block thinking-block-expanded"
        onClick={() => setIsExpanded(false)}
        aria-expanded={true}
      >
        <div className="thinking-toggle-expanded">
          <span className="thinking-label">Thinking</span>
          <span className="thinking-icon">▲</span>
        </div>
        <div className="thinking-content">{thinking}</div>
      </button>
    );
  }

  // Collapsed: small inline button with pulsing when streaming
  const collapsedClass = context.isStreaming
    ? "thinking-block thinking-streaming-collapsed"
    : "thinking-block";

  return (
    <div className={collapsedClass}>
      <button
        type="button"
        className="thinking-toggle-collapsed"
        onClick={() => setIsExpanded(true)}
        aria-expanded={false}
      >
        <span className="thinking-label">
          {context.isStreaming ? "Thinking..." : "Thinking"}
        </span>
        <span className="thinking-icon">▼</span>
      </button>
    </div>
  );
}

export const thinkingRenderer: ContentRenderer<ThinkingBlock> = {
  type: "thinking",
  render(block, context) {
    return (
      <ThinkingRendererComponent
        block={block as ThinkingBlock}
        context={context}
      />
    );
  },
  getSummary(block) {
    const thinking = (block as ThinkingBlock).thinking || "";
    const firstLine = thinking.split("\n")[0] || "";
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  },
};
