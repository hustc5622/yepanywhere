import type { ReactNode } from "react";
import { useOptionalI18n } from "../../../i18n";

type Translate = NonNullable<ReturnType<typeof useOptionalI18n>>["t"];

interface Props {
  /** Activity kind ("started" | "interacted" | "interrupted"). */
  kind?: string;
  /** V2: agent path (e.g. "/root/task_name"). */
  agentPath?: string;
  /** V2: sub-agent thread id. */
  agentThreadId?: string;

  /** Collaboration tool ("spawnAgent" | "sendInput" | "wait" | ...). */
  tool?: string;
  /** V1: model used by the spawned agent. */
  model?: string;
  /** V1: reasoning effort. */
  reasoningEffort?: string;
  /** V1: per-agent status map. */
  agentsStates?: unknown;

  lifecycle: "started" | "completed";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

interface AgentState {
  threadId: string;
  nickname: string;
  role: string;
  status: string;
  lastMessage?: string;
}

/**
 * Extract collaboration-agent status entries from the `agentsStates` map.
 *
 * The map key is the agent thread id. Current `CollabAgentState` values carry
 * only `status` and optional `message`; older payloads may also include
 * nickname/role aliases, which are preserved when present.
 */
function extractAgentStates(value: unknown): AgentState[] {
  const record = asRecord(value);
  if (!record) return [];

  return Object.entries(record).flatMap(([threadId, raw]) => {
    const state = asRecord(raw);
    if (!state) return [];
    const nickname = asString(state.nickname) ?? asString(state.agent_nickname);
    const role =
      asString(state.role) ?? asString(state.agent_type) ?? "default";
    const status = asString(state.status) ?? "unknown";
    const lastMessage = asString(state.message) ?? asString(state.last_message);
    return [
      {
        threadId,
        nickname: nickname ?? threadId,
        role,
        status,
        lastMessage,
      },
    ];
  });
}

function collabToolLabel(tool: string, t: Translate | undefined): string {
  switch (tool) {
    case "spawnAgent":
      return t?.("codexNativeSubagentSpawned") ?? "Spawned";
    case "sendInput":
      return t?.("codexNativeSubagentSentInput") ?? "Sent input to";
    case "wait":
      return t?.("codexNativeSubagentWaiting") ?? "Waiting for";
    case "closeAgent":
      return t?.("codexNativeSubagentClosed") ?? "Closed";
    case "resumeAgent":
      return t?.("codexNativeSubagentResuming") ?? "Resuming";
    default:
      return tool;
  }
}

function collabTitle(
  tool: string,
  agents: AgentState[],
  t: Translate | undefined,
): ReactNode {
  const label = collabToolLabel(tool, t);
  if (agents.length === 0) return <span>{label}</span>;
  const first = agents[0];
  if (!first) return <span>{label}</span>;
  return (
    <span>
      {label}{" "}
      <code className="codex-native-subagent-nickname">{first.nickname}</code>
      {first.role && first.role !== "default" && (
        <span className="codex-native-subagent-role"> [{first.role}]</span>
      )}
    </span>
  );
}

function v2Title(
  kind: string | undefined,
  agentPath: string | undefined,
  agentThreadId: string | undefined,
  t: Translate | undefined,
): ReactNode {
  const path = asString(agentPath);
  const display =
    path ??
    asString(agentThreadId) ??
    t?.("codexNativeSubagentFallback") ??
    "agent";
  switch (kind?.toLowerCase()) {
    case "started":
      return (
        <span>
          {t?.("codexNativeSubagentStarted") ?? "Started"}{" "}
          <code className="codex-native-subagent-nickname">{display}</code>
        </span>
      );
    case "interrupted":
      return (
        <span>
          {t?.("codexNativeSubagentInterrupted") ?? "Interrupted"}{" "}
          <code className="codex-native-subagent-nickname">{display}</code>
        </span>
      );
    case "interacted":
      return (
        <span>
          {t?.("codexNativeSubagentInteracted") ?? "Interacted with"}{" "}
          <code className="codex-native-subagent-nickname">{display}</code>
        </span>
      );
    default:
      return (
        <span>
          {kind ?? t?.("codexNativeSubagentActivity") ?? "Activity"}{" "}
          <code className="codex-native-subagent-nickname">{display}</code>
        </span>
      );
  }
}

function statusClassName(status: string): string {
  switch (status) {
    case "running":
    case "in_progress":
    case "inProgress":
      return "running";
    case "completed":
    case "complete":
      return "completed";
    case "errored":
    case "error":
    case "failed":
      return "errored";
    case "interrupted":
      return "interrupted";
    default:
      return "unknown";
  }
}

function statusLabel(status: string, t: Translate | undefined): string {
  switch (status) {
    case "running":
    case "in_progress":
    case "inProgress":
      return t?.("subagentStatusRunning") ?? "running";
    case "completed":
    case "complete":
      return t?.("subagentStatusCompleted") ?? "completed";
    case "errored":
    case "error":
    case "failed":
      return t?.("subagentStatusFailed") ?? "failed";
    case "interrupted":
      return t?.("subagentStatusInterrupted") ?? "interrupted";
    case "queued":
      return t?.("subagentStatusQueued") ?? "queued";
    case "starting":
      return t?.("subagentStatusStarting") ?? "starting";
    case "suspended":
      return t?.("subagentStatusSuspended") ?? "suspended";
    default:
      return status;
  }
}

/**
 * Renders Codex sub-agent ThreadItems.
 *
 * Handles two variants:
 * - `subAgentActivity`: lightweight lifecycle marker (started/interacted/
 *   Interrupted) with an agent path.
 * - `collabAgentToolCall`: spawn/sendInput/wait/close/resume with a
 *   per-agent status map (`agentsStates`).
 *
 * Visual style mirrors the Codex TUI `multi_agents.rs`: nickname in cyan,
 * role in brackets, model/reasoning in muted tone, per-agent status rows.
 */
export function CodexNativeSubAgentBlock(props: Props) {
  const i18n = useOptionalI18n();
  const t = i18n?.t;
  const { kind, agentPath, agentThreadId, tool, model, reasoningEffort } =
    props;

  // collabAgentToolCall path
  if (tool) {
    const agents = extractAgentStates(props.agentsStates);
    return (
      <div className="codex-native-subagent codex-native-subagent-collab">
        <div className="codex-native-subagent-title">
          {collabTitle(tool, agents, t)}
          {model && (
            <span className="codex-native-subagent-model">
              {" "}
              {model}
              {reasoningEffort ? ` · ${reasoningEffort}` : ""}
            </span>
          )}
        </div>
        {agents.length > 0 && (
          <div className="codex-native-subagent-states">
            {agents.map((agent) => (
              <div
                key={agent.threadId}
                className={`codex-native-subagent-state status-${statusClassName(agent.status)}`}
              >
                <span className="codex-native-subagent-state-name">
                  {agent.nickname}
                </span>
                {agent.role && agent.role !== "default" && (
                  <span className="codex-native-subagent-state-role">
                    [{agent.role}]
                  </span>
                )}
                <span className="codex-native-subagent-state-status">
                  {statusLabel(agent.status, t)}
                </span>
                {agent.lastMessage && (
                  <span className="codex-native-subagent-state-message">
                    {agent.lastMessage}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // subAgentActivity path
  return (
    <div className="codex-native-subagent codex-native-subagent-activity">
      <div className="codex-native-subagent-title">
        {v2Title(kind, agentPath, agentThreadId, t)}
      </div>
    </div>
  );
}
