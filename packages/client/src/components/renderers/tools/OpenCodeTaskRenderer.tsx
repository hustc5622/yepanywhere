import { Link } from "react-router-dom";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useGlobalSessions } from "../../../hooks/useGlobalSessions";
import { useRemoteBasePath } from "../../../hooks/useRemoteBasePath";
import { useI18n } from "../../../i18n";
import {
  type OpenCodeSubagentStatus,
  getOpenCodeSubagentSessionId,
  resolveOpenCodeTaskStatus,
  stringifyOpenCodeTaskResult,
} from "../../../lib/openCodeSubagents";
import type { RenderContext } from "../types";
import type { ToolRenderer } from "./types";

/**
 * OpenCode `task` tool renderer.
 *
 * Unlike Claude's Task tool (which nests the subagent transcript inline via
 * agentContent), OpenCode spawns each subagent as its own session and records
 * the child session id in the tool part metadata. We surface that as a compact,
 * clickable card that links to the subagent's own session page — keeping the
 * parent/child relationship legible without duplicating the transcript.
 */
interface OpenCodeTaskInput {
  description?: string;
  prompt?: string;
  subagent_type?: string;
  opencodeTitle?: string;
  opencodeMetadata?: {
    sessionId?: string;
    parentSessionId?: string;
    model?: { modelID?: string; providerID?: string };
    background?: boolean;
  } | null;
}

function getChildSessionId(input: OpenCodeTaskInput): string | undefined {
  return getOpenCodeSubagentSessionId(input);
}

function getDescription(input: OpenCodeTaskInput): string {
  return (
    input.description?.trim() ||
    input.opencodeTitle?.trim() ||
    input.prompt?.trim().split("\n")[0] ||
    ""
  );
}

function OpenCodeSubagentCard({
  input,
  status,
}: {
  input: OpenCodeTaskInput;
  status: OpenCodeSubagentStatus;
}) {
  const { t } = useI18n();
  const metadata = useOptionalSessionMetadata();
  const basePath = useRemoteBasePath();

  const childSessionId = getChildSessionId(input);
  const description = getDescription(input);
  const agent = input.subagent_type?.trim();

  // A running subagent may block on its own permission/question request. That
  // request is projected onto this (parent) session so the parent enters
  // needs-attention, but the child session itself reports "waiting-input" in
  // the global session list. Surface it on the card so the operator sees the
  // subagent needs approval without opening the child.
  const { sessions } = useGlobalSessions();
  const approvalNeeded =
    !!childSessionId &&
    (status === "pending" || status === "complete"
      ? sessions.find((session) => session.id === childSessionId)?.activity ===
        "waiting-input"
      : false);

  const statusBadge = ((): { className: string; label: string } => {
    if (approvalNeeded) {
      return {
        className: "badge-warning",
        label: t("subagentStatusApprovalNeeded"),
      };
    }
    switch (status) {
      case "pending":
        return {
          className: "badge-running",
          label: t("subagentStatusRunning"),
        };
      case "error":
        return { className: "badge-error", label: t("subagentStatusFailed") };
      case "aborted":
        return {
          className: "badge-warning",
          label: t("subagentStatusInterrupted"),
        };
      default:
        return {
          className: "badge-success",
          label: t("subagentStatusCompleted"),
        };
    }
  })();

  const inner = (
    <>
      <span className="opencode-subagent-card-icon" aria-hidden="true">
        ⛓
      </span>
      <span className="opencode-subagent-card-main">
        <span className="opencode-subagent-card-top">
          <span className="opencode-subagent-card-label">
            {t("subagentCardLabel")}
          </span>
          {agent && <span className="badge badge-info">{agent}</span>}
          <span className={`badge ${statusBadge.className}`}>
            {statusBadge.label}
          </span>
        </span>
        {description && (
          <span className="opencode-subagent-card-title" title={description}>
            {description}
          </span>
        )}
      </span>
      {childSessionId && (
        <span className="opencode-subagent-card-arrow" aria-hidden="true">
          →
        </span>
      )}
    </>
  );

  // When we can resolve both the project and the child session, render a link
  // that navigates to the subagent's dedicated session page.
  if (childSessionId && metadata?.projectId) {
    return (
      <Link
        className="opencode-subagent-card is-link"
        to={`${basePath}/projects/${metadata.projectId}/sessions/${childSessionId}`}
        title={t("subagentCardOpen")}
      >
        {inner}
      </Link>
    );
  }

  return <div className="opencode-subagent-card">{inner}</div>;
}

function OpenCodeTaskResultDetails({
  input,
  result,
  isError,
}: {
  input: OpenCodeTaskInput;
  result: unknown;
  isError: boolean;
}) {
  const resultText = stringifyOpenCodeTaskResult(result);
  const status = resolveOpenCodeTaskStatus(
    input,
    result,
    isError ? "error" : "complete",
  );
  const showResult = isError || !getChildSessionId(input);

  return (
    <div className="opencode-subagent-result">
      <OpenCodeSubagentCard input={input} status={status} />
      {showResult && resultText && (
        <pre
          className={`tool-fallback ${isError ? "tool-fallback-error" : ""}`}
        >
          <code>{resultText}</code>
        </pre>
      )}
    </div>
  );
}

export const openCodeTaskRenderer: ToolRenderer<OpenCodeTaskInput, unknown> = {
  tool: "task",

  renderToolUse(input) {
    return <OpenCodeSubagentCard input={input} status="pending" />;
  },

  renderToolResult(_result, isError, _context, input) {
    return (
      <OpenCodeTaskResultDetails
        input={input ?? {}}
        result={_result}
        isError={isError}
      />
    );
  },

  getUseSummary(input) {
    return getDescription(input);
  },

  renderInline(input, _result, _isError, status, _context: RenderContext) {
    return <OpenCodeSubagentCard input={input} status={status} />;
  },
};
