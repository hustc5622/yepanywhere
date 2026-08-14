import { useOptionalI18n } from "../../../i18n";

interface Props {
  /** Proposed-plan markdown text. May be empty while still streaming. */
  text?: string;
  lifecycle: "started" | "completed";
}

/**
 * Renders a Codex proposed-plan ThreadItem (`ThreadItem::Plan`).
 *
 * In plan mode the model streams a `<proposed_plan>` block; the canonical
 * overlay accumulates the delta into `threadItem.text`. This block surfaces
 * that text so users can see the plan the model is proposing in real time,
 * matching the Codex TUI `ProposedPlanCell`.
 *
 * Checklist/Todo updates from the `update_plan` tool are a separate stream
 * (`turn/plan/updated`) and are not projected as ThreadItems, so they are
 * out of scope here.
 */
export function CodexNativePlanBlock({ text, lifecycle }: Props) {
  const i18n = useOptionalI18n();
  const t = i18n?.t;
  const trimmed = typeof text === "string" ? text.trim() : "";

  if (!trimmed) {
    if (lifecycle === "started") {
      return (
        <div className="codex-native-plan codex-native-plan-streaming">
          <span className="codex-native-plan-title">
            {t?.("codexNativeProposedPlan") ?? "Proposed plan"}
          </span>
          <span className="codex-native-plan-streaming-cursor" />
        </div>
      );
    }
    // Completed but empty — nothing to show.
    return null;
  }

  return (
    <div className="codex-native-plan">
      <div className="codex-native-plan-header">
        <span className="codex-native-plan-title">
          {t?.("codexNativeProposedPlan") ?? "Proposed plan"}
        </span>
        {lifecycle === "started" && (
          <span className="codex-native-plan-badge">
            {t?.("codexNativeStreaming") ?? "streaming"}
          </span>
        )}
      </div>
      <pre className="codex-native-plan-text">{trimmed}</pre>
    </div>
  );
}
