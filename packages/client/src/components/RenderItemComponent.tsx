import { memo, useCallback } from "react";
import { getMessageId } from "../lib/mergeMessages";
import { canEditPersistedUserPrompt } from "../lib/sessionBranching";
import type { RenderItem } from "../types/renderItems";
import { GoalInlineBlock } from "./blocks/GoalInlineRenderer";
import { SessionSetupBlock } from "./blocks/SessionSetupBlock";
import { TextBlock } from "./blocks/TextBlock";
import { ThinkingBlock } from "./blocks/ThinkingBlock";
import { ToolCallRow } from "./blocks/ToolCallRow";
import { UserPromptBlock } from "./blocks/UserPromptBlock";
import { CodexNativeItemBlock } from "./blocks/codex/CodexNativeItemBlock";

interface Props {
  item: RenderItem;
  isStreaming: boolean;
  thinkingExpanded: boolean;
  toggleThinkingExpanded: () => void;
  sessionProvider?: string;
  /**
   * When provided, user prompts show an edit button. Called with the prompt's
   * parsed text plus its DAG identity so the parent can rewind/fork from here.
   */
  onEditUserPrompt?: (args: {
    text: string;
    uuid: string;
    parentUuid: string | null;
  }) => void;
  /** Switch the rendered derived branch. */
  onSelectBranch?: (branchId: string) => void;
}

function getMessageIdLike(message: Record<string, unknown>): string {
  if (typeof message.uuid === "string" && message.uuid.length > 0) {
    return message.uuid;
  }
  if (typeof message.id === "string" && message.id.length > 0) {
    return message.id;
  }
  return "<missing>";
}

function summarizeSourceMessages(messages: RenderItem["sourceMessages"]) {
  const bySource: Record<string, number> = {
    sdk: 0,
    jsonl: 0,
    unknown: 0,
  };
  const byType: Record<string, number> = {};
  const ids: string[] = [];
  let streamEventCount = 0;
  let streamingPlaceholderCount = 0;

  for (const message of messages) {
    const source =
      message._source === "sdk" || message._source === "jsonl"
        ? message._source
        : "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;

    const type = typeof message.type === "string" ? message.type : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    if (type === "stream_event") {
      streamEventCount++;
    }
    if (message._isStreaming) {
      streamingPlaceholderCount++;
    }

    ids.push(getMessageIdLike(message as Record<string, unknown>));
  }

  return {
    total: messages.length,
    bySource,
    byType,
    streamEventCount,
    streamingPlaceholderCount,
    ids,
  };
}

function buildDebugSnapshot(
  item: RenderItem,
  props: {
    isStreaming: boolean;
    thinkingExpanded: boolean;
    sessionProvider?: string;
  },
) {
  const sourceSummary = summarizeSourceMessages(item.sourceMessages);

  return {
    render: {
      id: item.id,
      type: item.type,
      isSubagent: item.isSubagent ?? false,
    },
    uiContext: {
      sessionProvider: props.sessionProvider ?? "unknown",
      sessionIsStreaming: props.isStreaming,
      thinkingExpanded: props.thinkingExpanded,
    },
    itemContext:
      item.type === "tool_call"
        ? {
            toolName: item.toolName,
            status: item.status,
            hasToolResult: Boolean(item.toolResult),
            hasStructuredResult: item.toolResult?.structured !== undefined,
            toolUseId: item.id,
          }
        : item.type === "text"
          ? {
              isStreamingTextBlock: item.isStreaming ?? false,
              hasAugmentHtml: Boolean(item.augmentHtml),
            }
          : item.type === "thinking"
            ? {
                status: item.status,
                thinkingLength: item.thinking.length,
              }
            : item.type === "system"
              ? {
                  subtype: item.subtype,
                  status: item.status ?? null,
                }
              : item.type === "session_setup"
                ? {
                    promptCount: item.prompts.length,
                  }
                : null,
    sourceSummary,
    sourceMessages: item.sourceMessages,
    renderItem: item,
  };
}

export const RenderItemComponent = memo(function RenderItemComponent({
  item,
  isStreaming,
  thinkingExpanded,
  toggleThinkingExpanded,
  sessionProvider,
  onEditUserPrompt,
  onSelectBranch,
}: Props) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't interfere with text selection (important for mobile long-press)
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return;
      }

      // Shift+click to debug (not Cmd/Ctrl+click, which opens links in new tabs)
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        console.log(
          "[DEBUG] Render snapshot",
          buildDebugSnapshot(item, {
            isStreaming,
            thinkingExpanded,
            sessionProvider,
          }),
        );
      }
    },
    [item, isStreaming, thinkingExpanded, sessionProvider],
  );

  const renderContent = () => {
    switch (item.type) {
      case "text":
        return (
          <TextBlock
            text={item.text}
            isStreaming={item.isStreaming}
            augmentHtml={item.augmentHtml}
            phase={item.phase}
          />
        );

      case "thinking":
        return (
          <ThinkingBlock
            thinking={item.thinking}
            status={item.status}
            isExpanded={thinkingExpanded}
            onToggle={toggleThinkingExpanded}
          />
        );

      case "tool_call":
        return (
          <ToolCallRow
            id={item.id}
            toolName={item.toolName}
            toolInput={item.toolInput}
            toolResult={item.toolResult}
            status={item.status}
            sessionProvider={sessionProvider}
            partialOutput={item.partialOutput}
          />
        );

      case "user_prompt": {
        const src = item.sourceMessages[0];
        const uuid = src ? getMessageId(src) : "";
        const canEdit = canEditPersistedUserPrompt(
          sessionProvider,
          src?._source,
        );
        return (
          <UserPromptBlock
            content={item.content}
            timestamp={src?.timestamp}
            contextBefore={src?.contextBefore}
            branch={src?.branch}
            codexBranch={src?.codexBranch}
            onSelectBranch={onSelectBranch}
            onEdit={
              onEditUserPrompt && uuid && canEdit
                ? (text) =>
                    onEditUserPrompt({
                      text,
                      uuid,
                      parentUuid: src?.parentUuid ?? null,
                    })
                : undefined
            }
          />
        );
      }

      case "session_setup":
        return <SessionSetupBlock title={item.title} prompts={item.prompts} />;

      case "system": {
        // Kimi goal lifecycle snapshots — render the inline goal card.
        if (item.subtype === "kimi_goal") {
          if (item.goalSnapshot) {
            return <GoalInlineBlock snapshot={item.goalSnapshot} />;
          }
          return null;
        }
        // Different styling for compacting vs completed compaction
        const isCompacting =
          item.subtype === "status" && item.status === "compacting";
        const isError = item.subtype === "error";
        const isWarning = item.subtype === "warning";
        const icon = isError ? "!" : isWarning ? "⚠" : "⟳";
        return (
          <div
            className={`system-message ${isCompacting ? "system-message-compacting" : ""} ${isError ? "system-message-error" : ""} ${isWarning ? "system-message-warning" : ""}`}
          >
            <span
              className={`system-message-icon ${isCompacting ? "spinning" : ""}`}
            >
              {icon}
            </span>
            <span className="system-message-text">{item.content}</span>
          </div>
        );
      }

      case "codex_native_item":
        return <CodexNativeItemBlock item={item} />;

      default:
        return null;
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: debug feature, shift+click only
    <div
      className={item.isSubagent ? "subagent-item" : undefined}
      data-render-type={item.type}
      data-render-id={item.id}
      onClick={handleClick}
    >
      {renderContent()}
    </div>
  );
});
