import { type ReactNode, useState } from "react";
import { useOptionalI18n } from "../../../i18n";
import {
  type CodexAgentStatus,
  type CodexAgentTranslate,
  codexAgentFallbackText,
  codexAgentStatusLabel,
  normalizeCodexAgentStatus,
} from "../../../lib/codexAgentStatus";
import type { ToolRenderer } from "./types";

type JsonRecord = Record<string, unknown>;
interface AgentListEntry {
  name: string;
  status: CodexAgentStatus;
  lastMessage?: string;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
function getString(record: JsonRecord | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function extractText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return (
      value.map((item) => getString(asRecord(item), "text") ?? "").join("") ||
      null
    );
  const record = asRecord(value);
  return getString(record, "content") ?? getString(record, "text") ?? null;
}
function parseResult(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  const text = extractText(value);
  if (text) {
    try {
      return asRecord(JSON.parse(text)) ?? record;
    } catch {
      /* Plain tool results need no JSON projection. */
    }
  }
  return record;
}
function targetFromInput(input: unknown, t: CodexAgentTranslate): string {
  const record = asRecord(input);
  // Relative task names resolve under the caller, which may itself be a child.
  // Only a returned canonical task_name proves an absolute /root/... address.
  return (
    getString(record, "target") ??
    getString(record, "task_name") ??
    t("codexNativeSubagentFallback")
  );
}
function agentEntries(result: unknown): AgentListEntry[] {
  const agents = parseResult(result)?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((value) => {
    const record = asRecord(value);
    const name = getString(record, "agent_name");
    if (!name || name === "/root") return [];
    const normalized = normalizeCodexAgentStatus(record?.agent_status);
    return [
      {
        name,
        status: normalized.status,
        lastMessage:
          normalized.message ?? getString(record, "last_task_message"),
      },
    ];
  });
}
function listAgentsSummary(result: unknown, t: CodexAgentTranslate): string {
  const agents = agentEntries(result);
  if (agents.length === 0) return t("codexAgentNoSubagents");
  return t(
    agents.length === 1 ? "codexAgentListSummaryOne" : "codexAgentListSummary",
    {
      running: agents.filter((agent) => agent.status === "running").length,
      total: agents.length,
    },
  );
}
function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="codex-collaboration-detail-row">
      <span className="codex-collaboration-detail-label">{label}</span>
      <span className="codex-collaboration-detail-value">{value}</span>
    </div>
  );
}
function SafeInput({ tool, input }: { tool: string; input: unknown }) {
  const t = useOptionalI18n()?.t ?? codexAgentFallbackText;
  const record = asRecord(input);
  return (
    <div className="codex-collaboration-details">
      {[
        "spawn_agent",
        "send_message",
        "followup_task",
        "interrupt_agent",
      ].includes(tool) && (
        <DetailRow
          label={t(
            tool === "spawn_agent" ? "codexAgentTask" : "codexAgentAgent",
          )}
          value={<code>{targetFromInput(input, t)}</code>}
        />
      )}
      {tool === "spawn_agent" && (
        <DetailRow
          label={t("codexAgentContext")}
          value={
            !getString(record, "fork_turns") || record?.fork_turns === "all"
              ? t("codexAgentContextAll")
              : record?.fork_turns === "none"
                ? t("codexAgentContextNone")
                : getString(record, "fork_turns")
          }
        />
      )}
      {tool === "wait_agent" && typeof record?.timeout_ms === "number" && (
        <DetailRow
          label={t("codexAgentTimeout")}
          value={t("codexAgentSeconds", { seconds: record.timeout_ms / 1000 })}
        />
      )}
      {["spawn_agent", "send_message", "followup_task"].includes(tool) && (
        <div className="codex-collaboration-note">
          {t("codexAgentInstructionsInThread")}
        </div>
      )}
    </div>
  );
}
function AgentList({ result }: { result: unknown }) {
  const t = useOptionalI18n()?.t ?? codexAgentFallbackText;
  const agents = agentEntries(result);
  if (agents.length === 0)
    return (
      <div className="codex-collaboration-empty">
        {t("codexAgentNoSubagents")}
      </div>
    );
  return (
    <div className="codex-collaboration-agent-list">
      {agents.map((agent) => (
        <div className="codex-collaboration-agent" key={agent.name}>
          <code>{agent.name}</code>
          <span className={`codex-collaboration-status status-${agent.status}`}>
            {codexAgentStatusLabel(agent.status, t)}
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
  input: unknown,
  t: CodexAgentTranslate,
): string {
  const agent = targetFromInput(input, t);
  if (isError) return t("codexAgentFailed", { agent });
  const parsed = parseResult(result);
  switch (tool) {
    case "spawn_agent":
      return t("codexAgentStarted", {
        agent: getString(parsed, "task_name") ?? agent,
      });
    case "list_agents":
      return listAgentsSummary(result, t);
    case "interrupt_agent":
      return parsed?.previous_status !== undefined
        ? t("codexAgentInterruptedPrevious", {
            agent,
            status: codexAgentStatusLabel(
              normalizeCodexAgentStatus(parsed.previous_status).status,
              t,
            ),
          })
        : t("codexAgentInterrupted", { agent });
    case "send_message":
      return t("codexAgentMessaged", { agent });
    case "followup_task":
      return t("codexAgentAssignedFollowup", { agent });
    case "wait_agent":
      return t(
        parsed?.timed_out === true
          ? "codexAgentNoUpdates"
          : "codexAgentUpdateReceived",
      );
    default:
      return t("codexAgentDone");
  }
}
function useSummary(
  tool: string,
  input: unknown,
  t: CodexAgentTranslate,
): string {
  const record = asRecord(input);
  const agent = targetFromInput(input, t);
  switch (tool) {
    case "spawn_agent":
      return t("codexAgentStarting", { agent });
    case "list_agents":
      return t("codexAgentChecking");
    case "interrupt_agent":
      return t("codexAgentInterrupting", { agent });
    case "send_message":
      return t("codexAgentMessaging", { agent });
    case "followup_task":
      return t("codexAgentAssigningFollowup", { agent });
    case "wait_agent":
      return typeof record?.timeout_ms === "number"
        ? t("codexAgentWaitingTimeout", { seconds: record.timeout_ms / 1000 })
        : t("codexAgentWaiting");
    default:
      return t("codexAgentPending");
  }
}
function ToolResult({
  tool,
  result,
  isError,
  input,
}: { tool: string; result: unknown; isError: boolean; input?: unknown }) {
  const t = useOptionalI18n()?.t ?? codexAgentFallbackText;
  if (isError)
    return (
      <div className="codex-collaboration-error">
        {extractText(result) ?? t("codexAgentOperationFailed")}
      </div>
    );
  if (tool === "list_agents") return <AgentList result={result} />;
  return (
    <div className="codex-collaboration-details">
      <DetailRow
        label={t("codexAgentResult")}
        value={resultSummary(tool, result, false, input, t)}
      />
    </div>
  );
}
const TOOL_LABELS = {
  spawn_agent: "codexAgentAgent",
  list_agents: "codexAgentAgents",
  send_message: "codexAgentMessage",
  followup_task: "codexAgentFollowupTask",
  interrupt_agent: "codexAgentAgent",
  wait_agent: "codexAgentAgents",
} as const;
type CollaborationTool = keyof typeof TOOL_LABELS;

/** Localized header/body without changing the generic tool registry's string API. */
function CollaborationToolRow({
  tool,
  input,
  result,
  isError,
  status,
}: {
  tool: CollaborationTool;
  input: unknown;
  result: unknown;
  isError: boolean;
  status: "pending" | "complete" | "error" | "aborted";
}) {
  const t = useOptionalI18n()?.t ?? codexAgentFallbackText;
  const [expanded, setExpanded] = useState(false);
  const hasResult = status === "complete" || status === "error";
  return (
    <details
      className={`tool-row codex-collaboration-tool ${expanded ? "expanded" : "collapsed"} status-${status}`}
      open={expanded}
    >
      <summary
        className="tool-row-header"
        onClick={(event) => {
          event.preventDefault();
          setExpanded((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setExpanded((current) => !current);
        }}
      >
        <span className="tool-name">{t(TOOL_LABELS[tool])}</span>
        <span className="tool-summary">
          {hasResult
            ? resultSummary(
                tool,
                result,
                isError || status === "error",
                input,
                t,
              )
            : useSummary(tool, input, t)}
        </span>
        {status === "aborted" && (
          <span className="tool-aborted-label">
            {t("codexAgentStatusInterrupted")}
          </span>
        )}
        <span className="expand-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </summary>
      {expanded && (
        <div className="tool-row-content">
          {hasResult ? (
            <ToolResult
              tool={tool}
              result={result}
              isError={isError || status === "error"}
              input={input}
            />
          ) : (
            <SafeInput tool={tool} input={input} />
          )}
        </div>
      )}
    </details>
  );
}
function renderer(tool: CollaborationTool): ToolRenderer<unknown, unknown> {
  return {
    tool,
    displayName: codexAgentFallbackText(TOOL_LABELS[tool]),
    renderToolUse(input) {
      return <SafeInput tool={tool} input={input} />;
    },
    renderToolResult(result, isError, _context, input) {
      return (
        <ToolResult
          tool={tool}
          result={result}
          isError={isError}
          input={input}
        />
      );
    },
    renderInline(input, result, isError, status) {
      return (
        <CollaborationToolRow
          tool={tool}
          input={input}
          result={result}
          isError={isError}
          status={status}
        />
      );
    },
    getUseSummary(input) {
      return useSummary(tool, input, codexAgentFallbackText);
    },
    getResultSummary(result, isError, input) {
      return resultSummary(
        tool,
        result,
        isError,
        input,
        codexAgentFallbackText,
      );
    },
  };
}
export const codexCollaborationRenderers = (
  Object.keys(TOOL_LABELS) as CollaborationTool[]
).map(renderer);
