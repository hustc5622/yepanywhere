import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useSubagentDetail } from "../../../contexts/SubagentDetailContext";
import { useOptionalI18n } from "../../../i18n";
import {
  type CodexAgentTranslate,
  codexAgentFallbackText,
  codexAgentStatusLabel,
  normalizeCodexAgentStatus,
} from "../../../lib/codexAgentStatus";
import type { CodexSubagentActivity } from "../../../types/renderItems";

interface Props {
  kind?: string;
  agentPath?: string;
  agentThreadId?: string;
  projectId?: string;
  tool?: string;
  model?: string;
  reasoningEffort?: string;
  agentsStates?: unknown;
  receiverThreadIds?: unknown[];
  prompt?: string;
  /** The collaboration operation's lifecycle, not the child agent's status. */
  status?: string;
  lifecycle: "started" | "completed";
  activity?: CodexSubagentActivity;
  startedAt?: string;
  operation?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function taskName(path: string | undefined, fallback: string): string {
  return path?.split("/").filter(Boolean).at(-1) ?? fallback;
}

function activityLabel(
  kind: string | undefined,
  t: CodexAgentTranslate,
): string {
  switch (kind?.toLowerCase()) {
    case "started":
      return t("codexAgentTaskStarted");
    // Older/local Codex builds also emit a completed activity extension.
    case "completed":
      return t("codexAgentTaskCompleted");
    case "interrupted":
      return t("codexAgentTaskInterrupted");
    case "interacted":
      return t("codexAgentInteraction");
    default:
      return t("codexAgentActivity");
  }
}

function toolLabel(
  tool: string,
  status: string | undefined,
  t: CodexAgentTranslate,
): string {
  if (status === "failed") return t("codexAgentOperationFailed");
  switch (tool) {
    case "spawnAgent":
      return status === "inProgress"
        ? t("codexAgentStatusStarting")
        : t("codexNativeSubagentSpawned");
    case "sendInput":
      return t("codexNativeSubagentSentInput");
    case "wait":
      return t("codexNativeSubagentWaiting");
    case "closeAgent":
      return t("codexNativeSubagentClosed");
    case "resumeAgent":
      return t("codexNativeSubagentResuming");
    default:
      return t("codexAgentActivity");
  }
}

/** Compact task cards open a child transcript inside its parent conversation. */
export function CodexNativeSubAgentBlock(props: Props) {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? codexAgentFallbackText;
  const session = useOptionalSessionMetadata();
  const detail = useSubagentDetail();
  const parentSessionId = session?.sessionId;
  const canOpen = !!(detail && parentSessionId);

  const openButton = (
    agentId: string | undefined,
    name: string,
    status?: string,
  ) =>
    canOpen && agentId && agentId !== parentSessionId && name !== "/root" ? (
      <button
        type="button"
        className="codex-native-subagent-open"
        aria-label={t("codexAgentDetailsLabel", { agent: name })}
        onClick={() =>
          detail?.openAgent({
            agentId,
            parentSessionId,
            name,
            ...(status ? { status } : {}),
          })
        }
      >
        {t("codexAgentDetails")}
        <span aria-hidden="true"> →</span>
      </button>
    ) : null;

  if (props.tool) {
    const states = asRecord(props.agentsStates) ?? {};
    // receiverThreadIds is authoritative even while agentsStates is empty.
    const ids = [
      ...new Set([
        ...(props.receiverThreadIds ?? []).filter(
          (id): id is string => !!asString(id),
        ),
        ...Object.keys(states),
      ]),
    ];
    return (
      <div className="codex-native-subagent codex-native-subagent-collab">
        <div className="codex-native-subagent-heading">
          <span className="codex-native-subagent-event">
            {toolLabel(props.tool, props.status, t)}
          </span>
          {props.model && (
            <span className="codex-native-subagent-model">
              {props.model}
              {props.reasoningEffort ? ` · ${props.reasoningEffort}` : ""}
            </span>
          )}
        </div>
        <div className="codex-native-subagent-states">
          {ids.map((threadId) => {
            const state = asRecord(states[threadId]);
            const path =
              asString(state?.agentPath) ?? asString(state?.agent_path);
            const nickname =
              asString(state?.nickname) ?? asString(state?.agent_nickname);
            const role = asString(state?.role) ?? asString(state?.agent_type);
            const name = taskName(path, nickname ?? threadId.slice(0, 8));
            const normalized = normalizeCodexAgentStatus(states[threadId]);
            return (
              <div
                key={threadId}
                className={`codex-native-subagent-state status-${normalized.status}`}
              >
                <div className="codex-native-subagent-info">
                  <div className="codex-native-subagent-title">
                    <span className="codex-native-subagent-name">{name}</span>
                    {role && role !== "default" && (
                      <span className="codex-native-subagent-role">{role}</span>
                    )}
                    <span className="codex-native-subagent-state-status">
                      {codexAgentStatusLabel(normalized.status, t)}
                    </span>
                  </div>
                  <code className="codex-native-subagent-path">
                    {path ?? threadId}
                  </code>
                </div>
                {openButton(
                  threadId,
                  path ?? nickname ?? threadId,
                  normalized.status,
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const name = taskName(
    props.agentPath,
    props.agentThreadId?.slice(0, 8) ?? t("codexNativeSubagentFallback"),
  );
  if (props.kind === "interacted") {
    const recipient =
      props.agentPath === "/root"
        ? t("codexAgentMainAgent")
        : (props.agentPath ?? name);
    return (
      <div className="codex-agent-interaction">
        {t(
          props.operation === "send_message"
            ? "codexAgentInteractionSent"
            : "codexAgentInteractionRecorded",
          { agent: recipient },
        )}
      </div>
    );
  }
  const historicalStatus =
    props.kind === "completed" || props.kind === "interrupted"
      ? props.kind
      : undefined;
  const hasStart =
    props.kind === "started" ||
    props.activity?.events.some((event) => event.kind === "started");
  const startDate =
    hasStart && props.startedAt ? new Date(props.startedAt) : undefined;
  const startTime =
    startDate && Number.isFinite(startDate.getTime())
      ? startDate.toLocaleTimeString(i18n?.locale, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : undefined;
  const entryLabel =
    props.activity?.entryKind === "followup" ||
    props.operation === "followup_task"
      ? "codexAgentDelegatedFollowup"
      : hasStart && !props.activity?.orphanTerminal
        ? "codexAgentDelegatedTask"
        : "codexAgentTaskRecord";
  return (
    <div className="codex-native-subagent codex-native-subagent-activity">
      <div className="codex-native-subagent-info">
        <div className="codex-native-subagent-title">
          <span className="codex-native-subagent-action">{t(entryLabel)}</span>
          <span className="codex-native-subagent-name">{name}</span>
        </div>
        <div className="codex-native-subagent-meta">
          <span className="codex-native-subagent-event">
            {activityLabel(props.kind, t)}
          </span>
          {startTime && (
            <time
              dateTime={props.startedAt}
              title={startDate?.toLocaleString(i18n?.locale)}
            >
              {t("codexAgentAssignedAt", { time: startTime })}
            </time>
          )}
        </div>
        {(props.agentPath || props.agentThreadId) && (
          <code className="codex-native-subagent-path">
            {props.agentPath ?? props.agentThreadId}
          </code>
        )}
      </div>
      {openButton(
        props.agentThreadId,
        props.agentPath ?? name,
        historicalStatus,
      )}
    </div>
  );
}
