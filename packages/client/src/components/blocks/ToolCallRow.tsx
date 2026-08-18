import { memo, useMemo, useState } from "react";
import {
  getDisplayBashCommandFromInput,
  isCodexLikeBashInput,
} from "../../lib/bashCommand";
import type { ToolResultData } from "../../types/renderItems";
import { toolRegistry } from "../renderers/tools";
import type { RenderContext } from "../renderers/types";
import { getToolSummary } from "../tools/summaries";

interface Props {
  id: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResultData;
  status: "pending" | "complete" | "error" | "aborted";
  sessionProvider?: string;
  /** Live streaming output preview while the tool is still running. */
  partialOutput?: string;
}

type ToolCallStatus = Props["status"];

export const ToolCallRow = memo(function ToolCallRow({
  id,
  toolName,
  toolInput,
  toolResult,
  status,
  sessionProvider,
  partialOutput,
}: Props) {
  // Create a minimal render context for tool renderers
  const renderContext: RenderContext = useMemo(
    () => ({
      isStreaming: status === "pending",
      theme: "dark",
      toolUseId: id,
      provider: sessionProvider,
    }),
    [status, id, sessionProvider],
  );

  // Get structured result for interactive summary
  const structuredResult = toolResult?.structured ?? toolResult?.content;

  const hasInlineRenderer = toolRegistry.hasInlineRenderer(toolName);
  const suppressCollapsedPreview = shouldSuppressBashCollapsedPreview(
    toolName,
    toolInput,
    sessionProvider,
    status,
  );

  const interactiveSummaryContent = useMemo(() => {
    if (status !== "complete") {
      return null;
    }
    return toolRegistry.renderInteractiveSummary(
      toolName,
      toolInput,
      structuredResult,
      toolResult?.isError ?? false,
      renderContext,
    );
  }, [
    status,
    toolName,
    toolInput,
    structuredResult,
    toolResult,
    renderContext,
  ]);

  const hasInteractiveSummary =
    interactiveSummaryContent !== null &&
    interactiveSummaryContent !== undefined &&
    interactiveSummaryContent !== false;

  const collapsedPreviewContent = useMemo(() => {
    if (suppressCollapsedPreview) {
      return null;
    }
    return toolRegistry.renderCollapsedPreview(
      toolName,
      toolInput,
      structuredResult,
      toolResult?.isError ?? false,
      renderContext,
    );
  }, [
    suppressCollapsedPreview,
    toolName,
    toolInput,
    structuredResult,
    toolResult,
    renderContext,
  ]);

  const hasCollapsedPreview =
    collapsedPreviewContent !== null &&
    collapsedPreviewContent !== undefined &&
    collapsedPreviewContent !== false;
  const hideSummaryWhenPreviewVisible =
    isBashToolName(toolName) &&
    status === "pending" &&
    hasCollapsedPreview &&
    isCodexLikeBashInput(toolInput, sessionProvider);
  // Tools with collapsed preview or interactive summary don't expand
  const isNonExpandable = hasInteractiveSummary || hasCollapsedPreview;

  // Edit and TodoWrite tools are expanded by default
  const [expanded, setExpanded] = useState(
    !isNonExpandable && (toolName === "Edit" || toolName === "TodoWrite"),
  );

  const summary = useMemo(() => {
    return getToolSummary(toolName, toolInput, toolResult, status, {
      provider: sessionProvider,
    });
  }, [toolName, toolInput, toolResult, status, sessionProvider]);

  const handleToggle = () => {
    if (!isNonExpandable) {
      setExpanded(!expanded);
    }
  };

  // Inline renderers bypass the entire tool-row structure
  if (hasInlineRenderer) {
    return (
      <div className="tool-inline timeline-item">
        {toolRegistry.renderInline(
          toolName,
          toolInput,
          structuredResult,
          toolResult?.isError ?? false,
          status,
          renderContext,
        )}
      </div>
    );
  }

  return (
    <div
      className={`tool-row timeline-item ${expanded ? "expanded" : "collapsed"} status-${status} ${isNonExpandable ? "interactive" : ""}`}
    >
      <div
        className={`tool-row-header ${isNonExpandable ? "non-expandable" : ""}`}
        onClick={isNonExpandable ? undefined : handleToggle}
        onKeyDown={
          isNonExpandable
            ? undefined
            : (e) => e.key === "Enter" && handleToggle()
        }
        role={isNonExpandable ? "presentation" : "button"}
        tabIndex={isNonExpandable ? undefined : 0}
      >
        {status === "pending" && (
          <span className="tool-spinner" aria-label="Running">
            <Spinner />
          </span>
        )}
        {status === "aborted" && (
          <span className="tool-aborted-icon" aria-label="Interrupted">
            ⨯
          </span>
        )}

        <span className="tool-name">
          {toolRegistry.getDisplayName(toolName, toolInput)}
        </span>

        {hasInteractiveSummary && status === "complete" ? (
          <span className="tool-summary interactive-summary">
            {interactiveSummaryContent}
          </span>
        ) : !hideSummaryWhenPreviewVisible ? (
          <span className="tool-summary">
            {summary}
            {status === "aborted" && (
              <span className="tool-aborted-label"> (interrupted)</span>
            )}
          </span>
        ) : null}

        {!isNonExpandable && (
          <span className="expand-chevron" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </div>

      {/* Collapsed preview - shown when tool supports it (non-expandable) */}
      {hasCollapsedPreview && (
        <div className="tool-row-collapsed-preview">
          {collapsedPreviewContent}
        </div>
      )}

      {/* Live output stream while the command is still running (Codex TUI parity) */}
      {status === "pending" && partialOutput && (
        <LiveOutputPreview output={partialOutput} />
      )}

      {expanded && !isNonExpandable && (
        <div className="tool-row-content">
          {status === "pending" || status === "aborted" ? (
            <ToolUseExpanded
              toolName={toolName}
              toolInput={toolInput}
              context={renderContext}
            />
          ) : (
            <ToolResultExpanded
              toolName={toolName}
              toolInput={toolInput}
              toolResult={toolResult}
              context={renderContext}
            />
          )}
        </div>
      )}
    </div>
  );
});

function shouldSuppressBashCollapsedPreview(
  toolName: string,
  toolInput: unknown,
  sessionProvider?: string,
  status?: ToolCallStatus,
): boolean {
  if (!isBashToolName(toolName)) {
    return false;
  }

  if (!isCodexLikeBashInput(toolInput, sessionProvider)) {
    return false;
  }

  // Keep Codex bash rows compact by default (header + expandable details) for
  // both running and completed commands to avoid persistent IN/OUT cards.
  if (
    status === "pending" ||
    status === "complete" ||
    status === "error" ||
    status === "aborted"
  ) {
    return true;
  }

  const command = getDisplayBashCommandFromInput(toolInput);
  if (!command) {
    return false;
  }

  return /^(rg|grep|sed|nl|cat)\b/.test(command.trimStart());
}

function isBashToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === "bash" || normalized === "shell";
}

const LIVE_OUTPUT_MAX_LINES = 12;

/** Scrolling tail of a running command's output, like the Codex TUI exec cell. */
function LiveOutputPreview({ output }: { output: string }) {
  const tail = useMemo(() => {
    const lines = output.replace(/\r\n?/g, "\n").split("\n");
    // Drop a trailing blank line from a final newline so the tail stays dense.
    if (lines.length > 1 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines.slice(-LIVE_OUTPUT_MAX_LINES).join("\n");
  }, [output]);

  if (!tail.trim()) {
    return null;
  }

  return (
    <div className="tool-live-output" aria-live="polite">
      <pre>{tail}</pre>
    </div>
  );
}

function ToolUseExpanded({
  toolName,
  toolInput,
  context,
}: {
  toolName: string;
  toolInput: unknown;
  context: RenderContext;
}) {
  return (
    <div className="tool-use-expanded">
      {toolRegistry.renderToolUse(toolName, toolInput, context)}
    </div>
  );
}

function ToolResultExpanded({
  toolName,
  toolInput,
  toolResult,
  context,
}: {
  toolName: string;
  toolInput: unknown;
  toolResult: ToolResultData | undefined;
  context: RenderContext;
}) {
  if (!toolResult) {
    return <div className="tool-no-result">No result data</div>;
  }

  // Use structured result if available, otherwise fall back to content
  const result = toolResult.structured ?? toolResult.content;

  return (
    <div className="tool-result-expanded">
      {toolRegistry.renderToolResult(
        toolName,
        result,
        toolResult.isError,
        context,
        toolInput,
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="spinner"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="24"
        strokeDashoffset="8"
      />
    </svg>
  );
}
