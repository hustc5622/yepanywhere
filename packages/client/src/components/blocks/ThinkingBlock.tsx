import { memo } from "react";
import { useOptionalI18n } from "../../i18n";

interface Props {
  thinking: string;
  status: "streaming" | "complete";
  isExpanded: boolean;
  onToggle: () => void;
}

export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  status,
  isExpanded,
  onToggle,
}: Props) {
  const i18n = useOptionalI18n();
  const isStreaming = status === "streaming";
  const className = [
    "thinking-block",
    "collapsible",
    "timeline-item",
    isStreaming && !isExpanded ? "thinking-streaming-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <details
      className={className}
      open={isExpanded}
      onToggle={(e) => {
        if (e.currentTarget.open !== isExpanded) {
          onToggle();
        }
      }}
    >
      <summary className="collapsible__summary">
        <span>
          {isStreaming
            ? (i18n?.t("nativeRenderThinkingStreaming") ?? "Thinking...")
            : (i18n?.t("nativeRenderThinking") ?? "Thinking")}
        </span>
        <span className="collapsible__icon">▸</span>
      </summary>
      <div className="collapsible__content">
        <span className="text-content">{thinking}</span>
      </div>
    </details>
  );
});
