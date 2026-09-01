import { useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import type { AssistantOutputToolGroupItem } from "../../types/renderItems";
import { ToolCallRow } from "./ToolCallRow";

export function AssistantOutputToolGroupRow({
  item,
  sessionProvider,
}: {
  item: AssistantOutputToolGroupItem;
  sessionProvider?: string;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const status = item.tools.some((tool) => tool.status === "pending")
    ? "running"
    : item.tools.some(
          (tool) => tool.status === "error" || tool.status === "aborted",
        )
      ? "failed"
      : "completed";
  const failedCount = item.tools.filter(
    (tool) => tool.status === "error" || tool.status === "aborted",
  ).length;
  const toolNames = useMemo(
    () => [...new Set(item.tools.map((tool) => tool.toolName))].slice(0, 5),
    [item.tools],
  );
  const summary = [
    t("sessionToolGroupCount", { count: item.tools.length }),
    ...(failedCount > 0
      ? [t("sessionToolGroupFailedCount", { count: failedCount })]
      : []),
  ].join(" · ");

  return (
    <div
      className={`display-tool-group assistant-output-tool-group timeline-item status-${status} ${expanded ? "expanded" : "collapsed"}`}
      data-testid="assistant-output-tool-group"
    >
      <button
        type="button"
        className="display-tool-group-header"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        {status === "running" && (
          <span className="display-tool-group-spinner" aria-hidden="true" />
        )}
        <span className="display-tool-group-summary">{summary}</span>
        <span className="display-tool-group-names">
          {toolNames.join(" · ")}
        </span>
        <span className="expand-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {expanded && (
        <div className="display-tool-group-content">
          {item.tools.map((tool) => (
            <ToolCallRow
              key={tool.id}
              id={tool.id}
              toolName={tool.toolName}
              toolInput={tool.toolInput}
              toolResult={tool.toolResult}
              status={tool.status}
              sessionProvider={sessionProvider}
              partialOutput={tool.partialOutput}
            />
          ))}
        </div>
      )}
    </div>
  );
}
