import type { CodexNativeItem } from "../../../types/renderItems";
import { CodexAgentMessageBlock } from "./CodexAgentMessageBlock";
import { CodexAgentWaitBlock } from "./CodexAgentWaitBlock";
import { CodexNativeGoalBlock } from "./CodexNativeGoalBlock";
import { CodexNativePlanBlock } from "./CodexNativePlanBlock";
import { CodexNativePlanChecklistBlock } from "./CodexNativePlanChecklistBlock";
import { CodexNativeSubAgentBlock } from "./CodexNativeSubAgentBlock";

interface Props {
  item: CodexNativeItem;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Dispatcher for Codex app-server native ThreadItems projected through the
 * canonical overlay.
 *
 * The server emits every ThreadItem as a `codex_native_item` render item
 * carrying a `threadItem` payload. This component routes the payload to a
 * dedicated renderer based on `threadItem.type`, matching the
 * `CODEX_THREAD_ITEM_RENDER_POLICY` classification in the shared schema.
 *
 * ThreadItem types that already have a first-class representation elsewhere
 * (agentMessage → text, reasoning → thinking, commandExecution/fileChange →
 * tool_call, userMessage → user_prompt) are filtered during preprocessing,
 * so this dispatcher only handles dedicated native UI and future unknown
 * variants that would otherwise be invisible.
 */
export function CodexNativeItemBlock({ item }: Props) {
  const { threadItem, lifecycle } = item;

  switch (threadItem.type) {
    case "agentWait":
      return (
        <CodexAgentWaitBlock
          status={asString(threadItem.status)}
          startedAt={asString(threadItem.startedAt)}
          completedAt={asString(threadItem.completedAt)}
          durationMs={asNumber(threadItem.durationMs)}
          outcome={asString(threadItem.outcome)}
        />
      );
    case "interAgentMessage":
      return (
        <CodexAgentMessageBlock
          kind={asString(threadItem.kind)}
          sender={asString(threadItem.sender)}
          recipient={asString(threadItem.recipient)}
          text={asString(threadItem.text)}
          encrypted={threadItem.encrypted === true}
          truncated={threadItem.truncated === true}
          resultAlreadyShown={threadItem.resultAlreadyShown === true}
          timestamp={item.sourceMessages[0]?.timestamp}
        />
      );

    // Thread-level goal snapshot (objective, status, token/time budget).
    case "threadGoal":
      return (
        <CodexNativeGoalBlock
          objective={asString(threadItem.objective)}
          status={asString(threadItem.status)}
          tokenBudget={asNumber(threadItem.tokenBudget)}
          tokensUsed={asNumber(threadItem.tokensUsed)}
          timeUsedSeconds={asNumber(threadItem.timeUsedSeconds)}
        />
      );

    // Proposed-plan text (plan mode). Checklist/Todo updates arrive via the
    // `turn/plan/updated` notification and are not projected as ThreadItems.
    case "plan":
      return (
        <CodexNativePlanBlock
          text={asString(threadItem.text)}
          lifecycle={lifecycle}
        />
      );

    // Turn-level checklist from the `update_plan` tool / `turn/plan/updated`
    // notification. Distinct from plan-mode proposed-plan text above.
    case "turnPlan":
      return (
        <CodexNativePlanChecklistBlock
          steps={asArray(threadItem.steps)}
          explanation={asString(threadItem.explanation)}
        />
      );

    // Sub-agent lifecycle activity.
    case "subAgentActivity":
      return (
        <CodexNativeSubAgentBlock
          activity={item.subagentActivity}
          startedAt={item.sourceMessages[0]?.timestamp}
          operation={asString(threadItem.operation)}
          kind={asString(threadItem.kind)}
          agentPath={asString(threadItem.agentPath)}
          agentThreadId={asString(threadItem.agentThreadId)}
          projectId={item.projectId}
          lifecycle={lifecycle}
        />
      );

    // Collaboration tool calls (spawn/sendInput/wait/close/resume).
    case "collabAgentToolCall":
      return (
        <CodexNativeSubAgentBlock
          tool={asString(threadItem.tool)}
          model={asString(threadItem.model)}
          reasoningEffort={asString(threadItem.reasoningEffort)}
          agentsStates={threadItem.agentsStates}
          receiverThreadIds={asArray(threadItem.receiverThreadIds)}
          prompt={asString(threadItem.prompt)}
          status={asString(threadItem.status)}
          projectId={item.projectId}
          lifecycle={lifecycle}
        />
      );

    default:
      // Unknown or not-yet-rendered ThreadItem types render a compact label
      // instead of vanishing silently, so users can at least see that Codex
      // emitted something.
      return (
        <div className="codex-native-item codex-native-item-unknown">
          <span className="codex-native-item-label">{threadItem.type}</span>
        </div>
      );
  }
}
