import type { CodexNativeItem } from "../../../types/renderItems";
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
 * tool_call, userMessage → user_prompt) are not double-rendered here: the
 * canonical overlay only projects the ThreadItem variants that lack a legacy
 * RenderItem equivalent, so this dispatcher only needs to cover the subset
 * that would otherwise be invisible.
 */
export function CodexNativeItemBlock({ item }: Props) {
  const { threadItem, lifecycle } = item;

  switch (threadItem.type) {
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
          kind={asString(threadItem.kind)}
          agentPath={asString(threadItem.agentPath)}
          agentThreadId={asString(threadItem.agentThreadId)}
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
