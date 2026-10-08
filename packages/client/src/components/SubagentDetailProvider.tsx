import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import {
  SubagentDetailContext,
  type SubagentDetailTarget,
} from "../contexts/SubagentDetailContext";
import { useDocumentVisibility } from "../hooks/useDocumentVisibility";
import { useSubagentSession } from "../hooks/useSubagentSession";
import { useI18n } from "../i18n";
import { InheritedSubagentContext } from "./InheritedSubagentContext";
import { SubagentTranscript } from "./SubagentTranscript";
import { DetailPanel } from "./ui/DetailPanel";

interface ScopedTarget extends SubagentDetailTarget {
  parentSessionId: string;
}

function agentName(target: SubagentDetailTarget): string {
  return target.name?.split("/").filter(Boolean).at(-1) ?? target.agentId;
}

function SubagentDetailContent({
  projectId,
  projectPath,
  rootSessionId,
  target,
  onBack,
  isNested,
  onStatus,
}: {
  projectId: string;
  projectPath: string | null;
  rootSessionId: string;
  target: ScopedTarget;
  onBack: () => void;
  isNested: boolean;
  onStatus: (agentId: string, status: string | undefined) => void;
}) {
  const { t } = useI18n();
  const visible = useDocumentVisibility();
  const { data, loading, error, refresh } = useSubagentSession({
    projectId,
    parentSessionId: target.parentSessionId,
    rootSessionId,
    agentId: target.agentId,
    enabled: true,
  });
  const [tab, setTab] = useState<"conversation" | "result">("conversation");
  const isCodexAgent = data?.messages.some(
    (message) => message.codexThreadItem || message.codexMessagePhase,
  );
  const status = data?.descriptor?.status ?? data?.status;
  const isStreaming =
    status === "running" ||
    status === "starting" ||
    status === "queued" ||
    status === "pending";
  useEffect(() => {
    if (!status || error || !visible) return;
    onStatus(target.agentId, status);
    // This snapshot is authoritative only while its detail is being polled.
    // Closing, switching agents, or pausing reads must let later parent events
    // take over instead of retaining an indefinitely stale status override.
    return () => onStatus(target.agentId, undefined);
  }, [onStatus, status, target.agentId, error, visible]);
  const statusLabel =
    status === "completed"
      ? t(
          isCodexAgent
            ? "codexAgentStatusCompleted"
            : "subagentStatusCompleted",
        )
      : status === "failed"
        ? t("subagentStatusFailed")
        : status === "interrupted"
          ? t("subagentStatusInterrupted")
          : status === "suspended"
            ? t("subagentStatusSuspended")
            : status === "queued"
              ? t("subagentStatusQueued")
              : status === "starting"
                ? t("subagentStatusStarting")
                : isStreaming
                  ? t("subagentStatusRunning")
                  : t("subagentStatusUnknown");

  return (
    <div className="subagent-detail">
      <div className="subagent-detail-toolbar">
        <button type="button" onClick={onBack} className="subagent-detail-back">
          ←{" "}
          {isNested
            ? t("subagentDetailBackOneLevel")
            : t("subagentDetailBackToParent")}
        </button>
        {data && (
          <span className={`subagent-detail-status status-${status}`}>
            {statusLabel}
          </span>
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="subagent-detail-refresh"
        >
          {t("subagentDetailRefresh")}
        </button>
      </div>
      <div className="subagent-detail-identity">
        <code>
          {data?.descriptor?.description ?? target.name ?? target.agentId}
        </code>
        {data?.agentType && <span>{data.agentType}</span>}
      </div>
      <div
        className="subagent-detail-tabs"
        role="tablist"
        aria-label={t("subagentDetailViews")}
      >
        {(["conversation", "result"] as const).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            id={`subagent-tab-${view}`}
            aria-controls="subagent-detail-transcript"
            aria-selected={tab === view}
            onClick={() => setTab(view)}
          >
            {view === "conversation"
              ? t("subagentDetailConversation")
              : t("subagentDetailResult")}
          </button>
        ))}
      </div>
      {loading && !data && <p role="status">{t("subagentDetailLoading")}</p>}
      {error && (
        <div className="subagent-detail-error" role="alert">
          <p>
            {error.notFound
              ? t("subagentDetailUnavailable")
              : t("subagentDetailLoadFailed")}
          </p>
          {!error.notFound && (
            <p className="subagent-detail-error-message">{error.message}</p>
          )}
          <button type="button" onClick={refresh} disabled={loading}>
            {t("subagentDetailRetry")}
          </button>
        </div>
      )}
      {data && (
        <div
          id="subagent-detail-transcript"
          role="tabpanel"
          aria-labelledby={`subagent-tab-${tab}`}
        >
          <SessionMetadataProvider
            projectId={projectId}
            projectPath={projectPath}
            sessionId={target.agentId}
          >
            <SubagentTranscript
              messages={data.messages}
              agentPath={[data.descriptor?.description, target.name].find(
                (name) => name?.startsWith("/root/"),
              )}
              isStreaming={isStreaming}
              mode={tab}
              inheritedContext={
                data.hasInheritedContext ? (
                  <InheritedSubagentContext
                    key={`${projectId}:${rootSessionId}:${target.agentId}`}
                    projectId={projectId}
                    rootSessionId={rootSessionId}
                    agentId={target.agentId}
                    active={tab === "conversation"}
                  />
                ) : undefined
              }
              emptyMessage={
                tab === "result"
                  ? t("subagentDetailNoResult")
                  : t("subagentDetailEmpty")
              }
            />
          </SessionMetadataProvider>
        </div>
      )}
    </div>
  );
}

/** Opens children in the parent session, retaining its draft and scroll position. */
export function SubagentDetailProvider({
  projectId,
  projectPath,
  sessionId,
  children,
}: {
  projectId: string;
  projectPath: string | null;
  sessionId: string;
  children: ReactNode;
}) {
  const [stack, setStack] = useState<ScopedTarget[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const openAgent = useCallback(
    (target: SubagentDetailTarget) => {
      if (!target.agentId) return;
      if (target.agentId === sessionId) {
        setStack([]);
        return;
      }
      const parentSessionId = target.parentSessionId ?? sessionId;
      if (target.agentId === parentSessionId) return;
      setStack((previous) => {
        const existing = previous.findIndex(
          (node) =>
            node.agentId === target.agentId &&
            node.parentSessionId === parentSessionId,
        );
        if (existing >= 0) return previous.slice(0, existing + 1);
        const parentIndex = previous.findIndex(
          (node) => node.agentId === parentSessionId,
        );
        const ancestors =
          parentIndex >= 0 ? previous.slice(0, parentIndex + 1) : [];
        return [...ancestors, { ...target, parentSessionId }];
      });
    },
    [sessionId],
  );
  const onStatus = useCallback(
    (agentId: string, status: string | undefined) => {
      setStatuses((previous) => {
        if (previous[agentId] === status) return previous;
        const next = { ...previous };
        if (status === undefined) delete next[agentId];
        else next[agentId] = status;
        return next;
      });
    },
    [],
  );
  const context = useMemo(
    () => ({ openAgent, statuses }),
    [openAgent, statuses],
  );
  const target = stack.at(-1);
  return (
    <SubagentDetailContext.Provider value={context}>
      {children}
      {target && (
        <DetailPanel title={agentName(target)} onClose={() => setStack([])}>
          <SubagentDetailContent
            key={`${target.parentSessionId}:${target.agentId}`}
            projectId={projectId}
            projectPath={projectPath}
            rootSessionId={sessionId}
            target={target}
            isNested={stack.length > 1}
            onBack={() => setStack((previous) => previous.slice(0, -1))}
            onStatus={onStatus}
          />
        </DetailPanel>
      )}
    </SubagentDetailContext.Provider>
  );
}
