import type { ReactNode } from "react";
import type { ToolRenderer } from "./types";

type JsonRecord = Record<string, unknown>;

interface AgentListEntry {
  name: string;
  status: string;
  lastMessage?: string;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function getString(record: JsonRecord | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => getString(asRecord(item), "text"))
      .filter((item): item is string => Boolean(item))
      .join("");
    return text || null;
  }
  const record = asRecord(value);
  return getString(record, "content") ?? getString(record, "text") ?? null;
}

function parseResult(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  if (record) return record;

  const text = extractText(value);
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function canonicalAgentPath(
  value: string | undefined,
  assumeTaskName = false,
): string {
  if (!value) return "agent";
  if (value.startsWith("/")) return value;
  if (value.startsWith("root/")) return `/${value}`;
  return assumeTaskName ? `/root/${value}` : value;
}

function targetFromInput(input: unknown): string {
  const record = asRecord(input);
  const target = getString(record, "target");
  if (target) return canonicalAgentPath(target);
  return canonicalAgentPath(getString(record, "task_name"), true);
}

function agentEntries(result: unknown): AgentListEntry[] {
  const agents = parseResult(result)?.agents;
  if (!Array.isArray(agents)) return [];

  return agents.flatMap((value) => {
    const record = asRecord(value);
    const name = getString(record, "agent_name");
    if (!name || name === "/root") return [];
    return [
      {
        name,
        status: getString(record, "agent_status") ?? "unknown",
        lastMessage: getString(record, "last_task_message"),
      },
    ];
  });
}

function listAgentsSummary(result: unknown): string {
  const agents = agentEntries(result);
  if (agents.length === 0) return "No subagents";
  const running = agents.filter((agent) => agent.status === "running").length;
  return `${running} running · ${agents.length} subagent${agents.length === 1 ? "" : "s"}`;
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="codex-collaboration-detail-row">
      <span className="codex-collaboration-detail-label">{label}</span>
      <span className="codex-collaboration-detail-value">{value}</span>
    </div>
  );
}

function renderSafeInput(tool: string, input: unknown): ReactNode {
  const record = asRecord(input);
  const target = targetFromInput(input);

  return (
    <div className="codex-collaboration-details">
      {(tool === "spawn_agent" ||
        tool === "send_message" ||
        tool === "followup_task" ||
        tool === "interrupt_agent") && (
        <DetailRow
          label={tool === "spawn_agent" ? "Task" : "Agent"}
          value={<code>{target}</code>}
        />
      )}
      {tool === "spawn_agent" && (
        <DetailRow
          label="Context"
          value={getString(record, "fork_turns") ?? "all"}
        />
      )}
      {tool === "wait_agent" && typeof record?.timeout_ms === "number" && (
        <DetailRow label="Timeout" value={`${record.timeout_ms / 1000}s`} />
      )}
      {(tool === "spawn_agent" ||
        tool === "send_message" ||
        tool === "followup_task") && (
        <div className="codex-collaboration-note">
          Instruction content is stored in the child thread.
        </div>
      )}
    </div>
  );
}

function renderAgentList(result: unknown): ReactNode {
  const agents = agentEntries(result);
  if (agents.length === 0) {
    return <div className="codex-collaboration-empty">No subagents</div>;
  }

  return (
    <div className="codex-collaboration-agent-list">
      {agents.map((agent) => (
        <div className="codex-collaboration-agent" key={agent.name}>
          <code>{agent.name}</code>
          <span className={`codex-collaboration-status status-${agent.status}`}>
            {agent.status}
          </span>
          {agent.lastMessage && (
            <span className="codex-collaboration-last-message">
              {agent.lastMessage}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function resultSummary(
  tool: string,
  result: unknown,
  isError: boolean,
  input?: unknown,
): string {
  if (isError) return `${targetFromInput(input)} failed`;
  const parsed = parseResult(result);

  switch (tool) {
    case "spawn_agent":
      return `Started ${canonicalAgentPath(
        getString(parsed, "task_name") ??
          getString(asRecord(input), "task_name"),
        true,
      )}`;
    case "list_agents":
      return listAgentsSummary(result);
    case "interrupt_agent": {
      const previous = getString(parsed, "previous_status");
      return `Interrupted ${targetFromInput(input)}${previous ? ` · was ${previous}` : ""}`;
    }
    case "send_message":
      return `Messaged ${targetFromInput(input)}`;
    case "followup_task":
      return `Assigned follow-up to ${targetFromInput(input)}`;
    case "wait_agent":
      return parsed?.timed_out === true
        ? "No agent updates yet"
        : "Agent update received";
    default:
      return "done";
  }
}

function useSummary(tool: string, input: unknown): string {
  const record = asRecord(input);
  switch (tool) {
    case "spawn_agent":
      return `Starting ${targetFromInput(input)}`;
    case "list_agents":
      return "Checking subagents";
    case "interrupt_agent":
      return `Interrupting ${targetFromInput(input)}`;
    case "send_message":
      return `Messaging ${targetFromInput(input)}`;
    case "followup_task":
      return `Assigning follow-up to ${targetFromInput(input)}`;
    case "wait_agent":
      return typeof record?.timeout_ms === "number"
        ? `Waiting up to ${record.timeout_ms / 1000}s`
        : "Waiting for subagents";
    default:
      return "...";
  }
}

function renderer(
  tool: string,
  displayName: string,
): ToolRenderer<unknown, unknown> {
  return {
    tool,
    displayName,
    renderToolUse(input) {
      return renderSafeInput(tool, input);
    },
    renderToolResult(result, isError, _context, input) {
      if (isError) {
        return (
          <div className="codex-collaboration-error">
            {extractText(result) ?? "Agent operation failed"}
          </div>
        );
      }
      if (tool === "list_agents") return renderAgentList(result);
      return (
        <div className="codex-collaboration-details">
          <DetailRow
            label="Result"
            value={resultSummary(tool, result, false, input)}
          />
        </div>
      );
    },
    getUseSummary(input) {
      return useSummary(tool, input);
    },
    getResultSummary(result, isError, input) {
      return resultSummary(tool, result, isError, input);
    },
  };
}

export const codexCollaborationRenderers = [
  renderer("spawn_agent", "Agent"),
  renderer("list_agents", "Agents"),
  renderer("send_message", "Message"),
  renderer("followup_task", "Agent task"),
  renderer("interrupt_agent", "Agent"),
  renderer("wait_agent", "Agents"),
];
