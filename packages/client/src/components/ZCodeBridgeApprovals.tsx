import type { ZCodeBridgePendingInput } from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";

const POLL_INTERVAL_MS = 5_000;
const INPUT_PREVIEW_MAX = 180;

function summarizeInput(input: unknown): string | null {
  if (input === undefined) return null;
  const text =
    typeof input === "string" ? input : JSON.stringify(input, null, 0);
  if (!text) return null;
  return text.length > INPUT_PREVIEW_MAX
    ? `${text.slice(0, INPUT_PREVIEW_MAX)}…`
    : text;
}

/**
 * Lightweight ZCode bridge surface (v1): pending tool approvals from
 * externally started `zcode tui` sessions. Polls the bridge on an interval
 * and hides entirely when nothing is waiting — external-session transcripts
 * already render through the normal zcode session reader.
 */
export function ZCodeBridgeApprovals() {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [pending, setPending] = useState<ZCodeBridgePendingInput[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await api.listZCodeBridgePendingInputs();
      setPending(response.pendingInputs);
    } catch {
      // Bridge not installed / server reachable blip: stay hidden.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  if (pending.length === 0) return null;

  const decide = async (
    input: ZCodeBridgePendingInput,
    behavior: "allow" | "deny",
  ) => {
    setDecidingId(input.id);
    try {
      await api.decideZCodeBridgePendingInput(input.id, { behavior });
      setPending((prev) => prev.filter((p) => p.id !== input.id));
    } catch (error) {
      showToast(
        t("zcodeBridgeDecisionFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
      // The pending input may already be gone (timeout/decided elsewhere).
      void refresh();
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <section className="zcode-bridge-approvals">
      <h3 className="zcode-bridge-approvals-title">
        {t("zcodeBridgeApprovalsTitle")}
      </h3>
      <ul className="zcode-bridge-approvals-list">
        {pending.map((input) => {
          const preview = summarizeInput(input.toolInput);
          return (
            <li key={input.id} className="zcode-bridge-approval">
              <div className="zcode-bridge-approval-body">
                <span className="zcode-bridge-approval-tool">
                  {input.toolName}
                </span>
                <span className="zcode-bridge-approval-session">
                  {input.cwd ?? input.sessionId}
                </span>
                {preview && (
                  <code className="zcode-bridge-approval-input">{preview}</code>
                )}
              </div>
              <div className="zcode-bridge-approval-actions">
                <button
                  type="button"
                  className="zcode-bridge-approval-button approve"
                  disabled={decidingId === input.id}
                  onClick={() => void decide(input, "allow")}
                >
                  {t("zcodeBridgeApprove")}
                </button>
                <button
                  type="button"
                  className="zcode-bridge-approval-button deny"
                  disabled={decidingId === input.id}
                  onClick={() => void decide(input, "deny")}
                >
                  {t("zcodeBridgeDeny")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
