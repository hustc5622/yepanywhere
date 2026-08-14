import type {
  ProviderGoalAction,
  ProviderGoalState,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import { Modal } from "./ui/Modal";

interface GoalModalProps {
  processId: string;
  onClose: () => void;
}

const PROMPT_ACTIONS = [
  { action: "pause", labelKey: "sessionGoalPause" },
  { action: "resume", labelKey: "sessionGoalResume" },
  { action: "clear", labelKey: "sessionGoalClear" },
] as const;

/**
 * Provider-neutral goal lifecycle dialog. Loads the current goal status via
 * `action: "show"` on open and offers set/replace (with objective text) and
 * pause/resume/clear actions. Some providers may start a model turn for an
 * explicit set/replace action; Codex only mutates its durable thread goal.
 *
 * Supported providers: ZCode (`session/goal` RPC) and Codex
 * (`thread/goal/*` native controls, formatted into the same `ProviderGoalState`
 * text summary).
 */
export function GoalModal({ processId, onClose }: GoalModalProps) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [objective, setObjective] = useState("");

  useEffect(() => {
    api
      .processGoal(processId, { action: "show" })
      .then((result: ProviderGoalState) => setStatus(result.response))
      .catch((err: unknown) =>
        setStatus(
          err instanceof Error ? err.message : t("sessionGoalLoadFailed"),
        ),
      )
      .finally(() => setLoading(false));
  }, [processId, t]);

  const run = useCallback(
    async (action: ProviderGoalAction | "show", text?: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await api.processGoal(processId, {
          action,
          ...(text ? { objective: text } : {}),
        });
        setStatus(result.response);
        showToast(result.response, "success");
      } catch (err: unknown) {
        showToast(
          t("sessionGoalActionFailed", {
            message: err instanceof Error ? err.message : String(err),
          }),
          "error",
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, processId, showToast, t],
  );

  return (
    <Modal title={t("sessionGoalTitle")} onClose={onClose}>
      <div className="goal-modal-content">
        {loading ? (
          <p className="settings-hint">{t("sessionGoalLoading")}</p>
        ) : (
          <pre className="goal-modal-status">{status}</pre>
        )}

        <label className="goal-modal-label" htmlFor="goal-objective">
          {t("sessionGoalObjectiveLabel")}
        </label>
        <textarea
          id="goal-objective"
          className="goal-modal-textarea"
          rows={3}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder={t("sessionGoalObjectivePlaceholder")}
          disabled={busy}
        />

        <div className="goal-modal-actions">
          <button
            type="button"
            className="goal-modal-button primary"
            disabled={busy || !objective.trim()}
            onClick={() => void run("set", objective.trim())}
          >
            {t("sessionGoalSet")}
          </button>
          <button
            type="button"
            className="goal-modal-button"
            disabled={busy || !objective.trim()}
            onClick={() => void run("replace", objective.trim())}
          >
            {t("sessionGoalReplace")}
          </button>
          {PROMPT_ACTIONS.map(({ action, labelKey }) => (
            <button
              key={action}
              type="button"
              className="goal-modal-button"
              disabled={busy}
              onClick={() => void run(action)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
