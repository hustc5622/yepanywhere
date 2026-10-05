import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../api/client";
import { SubagentDetailContext } from "../contexts/SubagentDetailContext";
import { useDocumentVisibility } from "../hooks/useDocumentVisibility";
import { useI18n } from "../i18n";
import type { Message } from "../types";
import { SubagentTranscript } from "./SubagentTranscript";

/** Fetch the child's inherited snapshot only when the user asks to see it. */
export function InheritedSubagentContext({
  projectId,
  rootSessionId,
  agentId,
  active = true,
}: {
  projectId: string;
  rootSessionId: string;
  agentId: string;
  active?: boolean;
}) {
  const { t } = useI18n();
  const regionId = useId();
  const visible = useDocumentVisibility();
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const response = await api.getAgentSessionInTree(
        projectId,
        rootSessionId,
        agentId,
        { includeInheritedContext: true },
      );
      if (mounted.current) setMessages(response.inheritedMessages ?? []);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [projectId, rootSessionId, agentId]);

  useEffect(() => {
    if (active && expanded && visible && messages === null && !failed)
      void load();
  }, [active, expanded, visible, messages, failed, load]);

  return (
    <section className="subagent-inherited-context" hidden={!active}>
      <button
        type="button"
        className="subagent-inherited-context-toggle"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        {t("subagentDetailInheritedContext")}
      </button>
      {active && expanded && (
        <div
          id={regionId}
          role="region"
          aria-label={t("subagentDetailInheritedContext")}
          className="subagent-inherited-context-body"
        >
          <p className="subagent-inherited-context-note">
            {t("subagentDetailInheritedContextHint")}
          </p>
          {loading && <p role="status">{t("subagentDetailLoading")}</p>}
          {failed && (
            <div role="alert">
              <p>{t("subagentDetailInheritedContextFailed")}</p>
              <button type="button" onClick={() => setFailed(false)}>
                {t("subagentDetailRetry")}
              </button>
            </div>
          )}
          {messages !== null && (
            // Copied agent activities are reference history, not children of
            // the current agent; do not expose live agent actions from here.
            <SubagentDetailContext.Provider value={null}>
              <SubagentTranscript
                messages={messages}
                isStreaming={false}
                emptyMessage={t("subagentDetailInheritedContextEmpty")}
              />
            </SubagentDetailContext.Provider>
          )}
        </div>
      )}
    </section>
  );
}
