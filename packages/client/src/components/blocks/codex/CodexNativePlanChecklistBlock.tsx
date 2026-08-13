import { useOptionalI18n } from "../../../i18n";
import {
  type ChecklistItem,
  ChecklistPanel,
  normalizeChecklistStatus,
} from "../../renderers/tools/Checklist";

interface Props {
  steps?: unknown;
  explanation?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractSteps(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    const step = typeof record.step === "string" ? record.step : undefined;
    if (!step) return [];
    return [
      {
        label: step,
        status: normalizeChecklistStatus(record.status),
      },
    ];
  });
}

/**
 * Renders a Codex turn-level plan checklist (`turn/plan/updated`).
 *
 * The `update_plan` tool emits `{ explanation?, plan: [{ step, status }] }`;
 * the canonical overlay projects the latest snapshot per turn as a `turnPlan`
 * native item. This block reuses the shared `ChecklistPanel` so the visual
 * matches Claude's TodoWrite and Codex's `UpdatePlan` tool renderers.
 *
 * This is distinct from plan-mode proposed-plan text, which is rendered by
 * `CodexNativePlanBlock`.
 */
export function CodexNativePlanChecklistBlock({ steps, explanation }: Props) {
  const i18n = useOptionalI18n();
  const checklistItems = extractSteps(steps);
  if (checklistItems.length === 0) return null;

  return (
    <ChecklistPanel
      title={i18n?.t("codexNativePlan") ?? "Plan"}
      items={checklistItems}
      note={explanation}
    />
  );
}
