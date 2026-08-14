import type { SubagentMetrics, SubagentStatus } from "@yep-anywhere/shared";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ZodError } from "zod";
import { AgentContentContext } from "../../../contexts/AgentContentContext";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useSessionMetadata } from "../../../contexts/SessionMetadataContext";
import type { AgentContent } from "../../../hooks/useSessionMessages";
import { useI18n } from "../../../i18n";
import { classifyToolError } from "../../../lib/classifyToolError";
import { isPlanProgressItem } from "../../../lib/preprocessMessages";
import {
  type PreprocessMessagesCache,
  preprocessMessagesCached,
} from "../../../lib/preprocessMessagesCache";
import {
  type SubagentStatLabels,
  buildSubagentStatChips,
  joinStatChips,
} from "../../../lib/subagentStats";
import { validateToolResult } from "../../../lib/validateToolResult";
import type { Message } from "../../../types";
import { RenderItemComponent } from "../../RenderItemComponent";
import { SchemaWarning } from "../../SchemaWarning";
import { ContentBlockRenderer } from "../ContentBlockRenderer";
import type { TaskInput, TaskResult, ToolRenderer } from "./types";

const MAX_PROMPT_LENGTH = 200;
const MAX_ERROR_SUMMARY_LENGTH = 80;

type OuterStatus = "pending" | "complete" | "error" | "aborted";

/**
 * Extract error message from tool result.
 * Handles both structured errors and raw string errors.
 */
function extractErrorMessage(
  result: unknown,
): { raw: string; summary: string; label: string } | null {
  if (!result) return null;

  let rawMessage = "";

  if (typeof result === "string") {
    rawMessage = result;
  } else if (typeof result === "object" && result !== null) {
    if ("content" in result) {
      const content = (result as { content: unknown }).content;
      if (typeof content === "string") {
        rawMessage = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text" &&
            "text" in block
          ) {
            rawMessage = String(block.text);
            break;
          }
        }
      }
    }
  }

  if (!rawMessage) return null;

  const classified = classifyToolError(rawMessage);
  const summary =
    classified.cleanedMessage.length > MAX_ERROR_SUMMARY_LENGTH
      ? `${classified.cleanedMessage.slice(0, MAX_ERROR_SUMMARY_LENGTH)}...`
      : classified.cleanedMessage;

  return { raw: rawMessage, summary, label: classified.label };
}

/**
 * Resolve the rich lifecycle status for a subagent card from the several
 * signals available: the server-derived descriptor (authoritative), the live
 * content status, and the outer tool_use/tool_result status.
 *
 * Never guesses "completed" from mere presence of content — an outer
 * `pending` (tool_use without a result) with no terminal descriptor stays
 * `running`.
 */
function resolveSubagentStatus(
  descriptorStatus: SubagentStatus | undefined,
  liveStatus: AgentContent["status"] | undefined,
  outerStatus: OuterStatus,
  isError: boolean,
): SubagentStatus {
  if (descriptorStatus) return descriptorStatus;
  if (isError) return "failed";
  if (outerStatus === "aborted") return "interrupted";
  if (outerStatus === "error") return "failed";
  if (outerStatus === "complete") {
    if (liveStatus === "failed") return "failed";
    return "completed";
  }
  // outerStatus === "pending": no tool_result yet → still running.
  if (liveStatus === "completed") return "completed";
  if (liveStatus === "failed") return "failed";
  return "running";
}

function isRunningStatus(status: SubagentStatus): boolean {
  return status === "running" || status === "starting" || status === "queued";
}

/** Map a status to a CSS badge class + i18n label key. */
function useStatusBadge(status: SubagentStatus): {
  className: string;
  label: string;
} {
  const { t } = useI18n();
  switch (status) {
    case "queued":
      return { className: "badge-pending", label: t("subagentStatusQueued") };
    case "starting":
      return {
        className: "badge-running",
        label: t("subagentStatusStarting"),
      };
    case "running":
      return { className: "badge-running", label: t("subagentStatusRunning") };
    case "suspended":
      return {
        className: "badge-warning",
        label: t("subagentStatusSuspended"),
      };
    case "interrupted":
      return {
        className: "badge-warning",
        label: t("subagentStatusInterrupted"),
      };
    case "backgrounded":
      return {
        className: "badge-info",
        label: t("subagentStatusBackgrounded"),
      };
    case "failed":
      return { className: "badge-error", label: t("subagentStatusFailed") };
    default:
      return {
        className: "badge-success",
        label: t("subagentStatusCompleted"),
      };
  }
}

function Spinner() {
  return (
    <svg
      className="spinner"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="24"
        strokeDashoffset="8"
      />
    </svg>
  );
}

/** Live-ticking elapsed clock in ms, anchored on `startedAt`. Only ticks (and
 * only returns a value) while the agent is running — a finished agent shows its
 * measured `durationMs` from metrics instead. */
function useLiveElapsedMs(
  startedAt: string | undefined,
  running: boolean,
): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  if (!running || !startedAt) return undefined;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return undefined;
  return Math.max(0, now - start);
}

function useSubagentStatLabels(): SubagentStatLabels {
  const { t } = useI18n();
  return useMemo(
    () => ({
      seconds: (count) => t("subagentStatSeconds", { count }),
      minutesSeconds: (minutes, seconds) =>
        t("subagentStatMinutesSeconds", { minutes, seconds }),
      hoursMinutes: (hours, minutes) =>
        t("subagentStatHoursMinutes", { hours, minutes }),
      tools: (count) => t("subagentStatTools", { count }),
      context: (tokens) => t("subagentStatContext", { tokens }),
      total: (tokens) => t("subagentStatTotal", { tokens }),
    }),
    [t],
  );
}

/** Stat chips row shared by single Agent and each swarm member. */
function SubagentStats({
  metrics,
  running,
  startedAt,
}: {
  metrics: SubagentMetrics | undefined;
  running: boolean;
  startedAt: string | undefined;
}) {
  const liveElapsed = useLiveElapsedMs(startedAt, running);
  const labels = useSubagentStatLabels();
  const chips = buildSubagentStatChips(metrics, {
    showTotal: !running,
    labels,
    ...(liveElapsed !== undefined ? { elapsedMs: liveElapsed } : {}),
  });
  if (chips.length === 0) return null;
  return (
    <span className="task-stats" title={joinStatChips(chips)}>
      {chips.map((chip) => (
        <span key={chip.key} className={`task-stat task-stat-${chip.key}`}>
          {chip.label}
        </span>
      ))}
    </span>
  );
}

/**
 * Nested transcript renderer — reuses the main message pipeline so subagent
 * thinking/tool rows behave identically to the top-level transcript.
 */
function SubagentTranscript({
  messages,
  isStreaming,
}: {
  messages: Message[];
  isStreaming: boolean;
}) {
  const [expandedThinkingItemIds, setExpandedThinkingItemIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const preprocessCacheRef = useRef<PreprocessMessagesCache | null>(null);
  const toggleThinkingExpanded = useCallback((itemId: string) => {
    setExpandedThinkingItemIds((previousIds) => {
      const nextIds = new Set(previousIds);
      if (nextIds.has(itemId)) {
        nextIds.delete(itemId);
      } else {
        nextIds.add(itemId);
      }
      return nextIds;
    });
  }, []);

  const renderItems = useMemo(() => {
    const result = preprocessMessagesCached(
      messages,
      undefined,
      preprocessCacheRef.current,
    );
    preprocessCacheRef.current = result.cache;
    return result.renderItems.filter((item) => !isPlanProgressItem(item));
  }, [messages]);

  return (
    <div className="task-nested-content">
      {renderItems.map((item) => (
        <RenderItemComponent
          key={item.id}
          item={item}
          isStreaming={isStreaming}
          thinkingExpanded={expandedThinkingItemIds.has(item.id)}
          toggleThinkingExpanded={toggleThinkingExpanded}
        />
      ))}
    </div>
  );
}

/**
 * A single subagent card: collapsible header (type, description, status, live
 * stats, spinner) + expandable transcript. Drives its own lazy-load and
 * autoscroll. Used both standalone (single `Agent`) and as an `AgentSwarm`
 * member row.
 */
function SubagentCard({
  agentId,
  subagentType,
  description,
  outerStatus,
  isError,
  errorInfo,
  fallbackContent,
  swarmIndex,
}: {
  /** Resolved subagent id, or undefined while unmapped (still running). */
  agentId: string | undefined;
  subagentType: string;
  description: string;
  outerStatus: OuterStatus;
  isError: boolean;
  /** Parent tool_result error info (single-Agent failure path). */
  errorInfo?: { raw: string; summary: string; label: string } | null;
  /** Result content blocks to show when no live transcript is available. */
  fallbackContent?: TaskResult["content"];
  swarmIndex?: number;
}) {
  const { t } = useI18n();
  const { projectId, sessionId } = useSessionMetadata();
  const context = useContext(AgentContentContext);

  const liveContent = agentId ? context?.agentContent[agentId] : undefined;
  const descriptor = liveContent?.descriptor;
  const metrics = liveContent?.metrics;
  const resolvedType =
    liveContent?.agentType ?? descriptor?.type ?? subagentType;
  const normalizedType = resolvedType?.toLowerCase();
  const typeClass =
    normalizedType === "explore" ||
    normalizedType === "coder" ||
    normalizedType === "agent" ||
    normalizedType === "plan"
      ? normalizedType
      : "unknown";

  const status = resolveSubagentStatus(
    descriptor?.status,
    liveContent?.status,
    outerStatus,
    isError,
  );
  const running = isRunningStatus(status);
  const badge = useStatusBadge(status);

  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const lastHeightRef = useRef(0);

  const scrollToBottom = useCallback((container: HTMLElement) => {
    isProgrammaticScrollRef.current = true;
    container.scrollTop = container.scrollHeight - container.clientHeight;
    lastHeightRef.current = container.scrollHeight;
    requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
    });
  }, []);

  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;
    const container = contentRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 100;
  }, []);

  useEffect(() => {
    const container = contentRef.current;
    if (!container || !isExpanded) return;
    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll, isExpanded]);

  useEffect(() => {
    const container = contentRef.current;
    if (!container || !isExpanded || !running) return;
    lastHeightRef.current = container.scrollHeight;
    const resizeObserver = new ResizeObserver(() => {
      const newHeight = container.scrollHeight;
      if (newHeight > lastHeightRef.current && shouldAutoScrollRef.current) {
        scrollToBottom(container);
      } else {
        lastHeightRef.current = newHeight;
      }
    });
    for (const child of container.children) resizeObserver.observe(child);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [isExpanded, running, scrollToBottom]);

  useEffect(() => {
    if (isExpanded && running) {
      shouldAutoScrollRef.current = true;
      const container = contentRef.current;
      if (container) {
        requestAnimationFrame(() => scrollToBottom(container));
      }
    }
  }, [isExpanded, running, scrollToBottom]);

  // Load (and, for running agents, keep refreshing) the child transcript.
  const loadContent = useCallback(
    async (force: boolean) => {
      if (!agentId || !context) return;
      setIsLoadingContent(true);
      try {
        await context.loadAgentContent(projectId, sessionId, agentId, {
          force,
        });
      } finally {
        setIsLoadingContent(false);
      }
    },
    [agentId, context, projectId, sessionId],
  );

  // First load on expand.
  const loadInitiatedRef = useRef(false);
  useEffect(() => {
    if (!isExpanded || !agentId || !context) return;
    if (loadInitiatedRef.current) return;
    loadInitiatedRef.current = true;
    void loadContent(false);
  }, [isExpanded, agentId, context, loadContent]);

  // While expanded and running, poll the child wire so live metrics/transcript
  // converge (Kimi does not stream child events over ACP; the wire.jsonl on
  // disk is the reliable live source).
  useEffect(() => {
    if (!isExpanded || !running || !agentId) return;
    const timer = setInterval(() => void loadContent(true), 3000);
    return () => clearInterval(timer);
  }, [isExpanded, running, agentId, loadContent]);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const hasLiveMessages = (liveContent?.messages.length ?? 0) > 0;
  const hasFallback = (fallbackContent?.length ?? 0) > 0;

  const emptyMessage = isLoadingContent
    ? t("subagentLoadingContent")
    : running
      ? t("subagentWaitingActivity")
      : t("subagentNoContent");

  return (
    <div
      className={`task-inline ${isExpanded ? "expanded" : "collapsed"} status-${status}`}
    >
      <button
        type="button"
        className="task-inline-header"
        onClick={handleToggle}
      >
        <span className="task-expand-icon">{isExpanded ? "▼" : "▶"}</span>
        {typeof swarmIndex === "number" && (
          <span className="task-swarm-index">#{swarmIndex + 1}</span>
        )}
        <span className={`badge task-agent-type task-agent-type-${typeClass}`}>
          {normalizedType === "explore" && "🔍 "}
          {normalizedType === "coder" && "✏️ "}
          {resolvedType ?? "task"}
        </span>
        <span className="task-inline-title" title={description}>
          {description}
        </span>
        {running && (
          <span
            className="task-spinner"
            aria-label={t("subagentStatusRunning")}
          >
            <Spinner />
          </span>
        )}
        <span className={`badge ${badge.className}`}>{badge.label}</span>
        <SubagentStats
          metrics={metrics}
          running={running}
          startedAt={descriptor?.startedAt}
        />
        {!isExpanded && errorInfo && (
          <span className="task-error-summary" title={errorInfo.raw}>
            {errorInfo.summary}
          </span>
        )}
        {agentId && (
          <span className="task-agent-id" title={t("subagentAgentIdLabel")}>
            {agentId}
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="task-inline-content" ref={contentRef}>
          {errorInfo && (
            <div className="task-error-details">
              <pre className="task-error-message">{errorInfo.raw}</pre>
            </div>
          )}
          {status === "suspended" && (
            <div className="task-status-note">{t("subagentSuspendedNote")}</div>
          )}
          {status === "backgrounded" && (
            <div className="task-status-note">
              {t("subagentBackgroundedNote")}
            </div>
          )}
          {status === "interrupted" && !errorInfo && (
            <div className="task-status-note">
              {t("subagentInterruptedNote")}
            </div>
          )}
          {!errorInfo && hasLiveMessages ? (
            <SubagentTranscript
              messages={liveContent?.messages ?? []}
              isStreaming={running}
            />
          ) : !errorInfo && hasFallback ? (
            <div className="task-content">
              {fallbackContent?.map((block) => (
                <ContentBlockRenderer
                  key={
                    block.id ??
                    `${agentId}-${block.type}-${block.text?.slice(0, 20) ?? ""}`
                  }
                  block={block}
                  context={{ isStreaming: false, theme: "dark" }}
                />
              ))}
            </div>
          ) : !errorInfo ? (
            <div className="task-empty">
              {isLoadingContent && <Spinner />} {emptyMessage}
            </div>
          ) : null}
        </div>
      )}
      {isLoadingContent && !isExpanded && (
        <span className="sr-only">{t("subagentLoadingContent")}</span>
      )}
    </div>
  );
}

/**
 * AgentSwarm (or any tool_use that fanned out to multiple children): an
 * aggregate summary header plus one independently-expandable card per member.
 */
function AgentSwarmInline({
  input,
  agentIds,
  outerStatus,
  isError,
}: {
  input: TaskInput;
  agentIds: string[];
  outerStatus: OuterStatus;
  isError: boolean;
}) {
  const { t } = useI18n();
  const statLabels = useSubagentStatLabels();
  const context = useContext(AgentContentContext);

  const members = agentIds.map((agentId) => {
    const content = context?.agentContent[agentId];
    const status = resolveSubagentStatus(
      content?.descriptor?.status,
      content?.status,
      outerStatus,
      isError,
    );
    return { agentId, content, status };
  });

  const runningCount = members.filter(
    (m) =>
      m.status === "running" ||
      m.status === "starting" ||
      m.status === "queued",
  ).length;
  const completedCount = members.filter((m) => m.status === "completed").length;
  const failedCount = members.filter(
    (m) => m.status === "failed" || m.status === "interrupted",
  ).length;

  // Aggregate metrics across members (sum of measured values only).
  const aggregate = useMemo<SubagentMetrics>(() => {
    let tools = 0;
    let total = 0;
    let hasTools = false;
    let hasTotal = false;
    for (const m of members) {
      const metrics = m.content?.metrics;
      if (typeof metrics?.toolUseCount === "number") {
        tools += metrics.toolUseCount;
        hasTools = true;
      }
      const usage = metrics?.usage;
      if (usage) {
        const t2 =
          usage.totalTokens ??
          (usage.inputOther ?? 0) +
            (usage.inputCacheRead ?? 0) +
            (usage.inputCacheCreation ?? 0) +
            (usage.output ?? 0);
        total += t2;
        hasTotal = true;
      }
    }
    return {
      ...(hasTools ? { toolUseCount: tools } : {}),
      ...(hasTotal ? { usage: { totalTokens: total } } : {}),
    };
  }, [members]);

  const summaryChips = buildSubagentStatChips(aggregate, {
    showTotal: true,
    labels: statLabels,
  });

  return (
    <div className="agent-swarm">
      <div className="agent-swarm-header">
        <span className="badge badge-info">{t("swarmLabel")}</span>
        {input.description && (
          <span className="agent-swarm-title" title={input.description}>
            {input.description}
          </span>
        )}
        <span className="agent-swarm-counts">
          <span className="badge">
            {t("swarmMembersLabel", { count: members.length })}
          </span>
          {runningCount > 0 && (
            <span className="badge badge-running">
              {t("swarmRunningLabel", { count: runningCount })}
            </span>
          )}
          {completedCount > 0 && (
            <span className="badge badge-success">
              {t("swarmCompletedLabel", { count: completedCount })}
            </span>
          )}
          {failedCount > 0 && (
            <span className="badge badge-error">
              {t("swarmFailedLabel", { count: failedCount })}
            </span>
          )}
        </span>
        {summaryChips.length > 0 && (
          <span className="task-stats">
            {summaryChips.map((chip) => (
              <span key={chip.key} className="task-stat">
                {chip.label}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="agent-swarm-members">
        {members.map((member, index) => (
          <SubagentCard
            key={member.agentId}
            agentId={member.agentId}
            subagentType={
              member.content?.agentType ??
              member.content?.descriptor?.type ??
              input.subagent_type
            }
            description={
              member.content?.descriptor?.description ??
              `${input.description} #${index + 1}`
            }
            outerStatus={outerStatus}
            isError={isError || member.status === "failed"}
            swarmIndex={member.content?.descriptor?.swarmIndex ?? index}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Task inline entry point. Routes a single-child call to {@link SubagentCard}
 * and a multi-child (AgentSwarm) fan-out to {@link AgentSwarmInline}.
 */
function TaskInline({
  input,
  result,
  isError,
  status,
  toolUseId,
}: {
  input: TaskInput;
  result: TaskResult | undefined;
  isError: boolean;
  status: OuterStatus;
  toolUseId?: string;
}) {
  const context = useContext(AgentContentContext);
  const {
    reportValidationError,
    enabled: validationEnabled,
    isToolIgnored,
  } = useSchemaValidationContext();

  // All subagent ids produced by this tool_use (AgentSwarm → many).
  const agentIds = useMemo<string[]>(() => {
    const fromMulti = toolUseId
      ? context?.toolUseToAgentIds.get(toolUseId)
      : undefined;
    if (fromMulti && fromMulti.length > 0) return fromMulti;
    const single =
      result?.agentId ??
      (toolUseId ? context?.toolUseToAgent.get(toolUseId) : undefined);
    return single ? [single] : [];
  }, [toolUseId, context, result]);

  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );
  useEffect(() => {
    if (!result || !validationEnabled) {
      setValidationErrors(null);
      return;
    }
    const validation = validateToolResult("Task", result);
    if (!validation.valid && validation.errors) {
      setValidationErrors(validation.errors);
      reportValidationError("Task", validation.errors);
    } else {
      setValidationErrors(null);
    }
  }, [result, validationEnabled, reportValidationError]);

  const showValidationWarning =
    validationEnabled && validationErrors !== null && !isToolIgnored("Task");

  // Multi-child fan-out (AgentSwarm).
  if (agentIds.length > 1) {
    return (
      <>
        <AgentSwarmInline
          input={input}
          agentIds={agentIds}
          outerStatus={status}
          isError={isError}
        />
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Task" errors={validationErrors} />
        )}
      </>
    );
  }

  const errorInfo = isError ? extractErrorMessage(result) : null;

  return (
    <>
      <SubagentCard
        agentId={agentIds[0]}
        subagentType={input.subagent_type}
        description={input.description}
        outerStatus={status}
        isError={isError}
        errorInfo={errorInfo}
        fallbackContent={result?.content}
      />
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Task" errors={validationErrors} />
      )}
    </>
  );
}

/**
 * Task tool use - shows description and subagent type (collapsed tool-row use).
 */
function TaskToolUse({ input }: { input: TaskInput }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const promptTruncated =
    input.prompt.length > MAX_PROMPT_LENGTH
      ? `${input.prompt.slice(0, MAX_PROMPT_LENGTH)}...`
      : input.prompt;

  return (
    <div className="task-tool-use">
      <div className="task-header">
        <span className="task-description">{input.description}</span>
        <span className="badge badge-info">{input.subagent_type}</span>
        {input.model && <span className="badge">{input.model}</span>}
      </div>
      {input.prompt && (
        <div className="task-prompt">
          <button
            type="button"
            className="task-prompt-toggle"
            onClick={() => setShowPrompt(!showPrompt)}
          >
            {showPrompt ? "Hide prompt" : "Show prompt"}
          </button>
          {showPrompt && (
            <pre className="task-prompt-content">
              <code>{showPrompt ? input.prompt : promptTruncated}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export const taskRenderer: ToolRenderer<TaskInput, TaskResult> = {
  tool: "Task",

  renderToolUse(input, _context) {
    return <TaskToolUse input={input as TaskInput} />;
  },

  renderToolResult(result, isError, _context) {
    // Standalone result rendering falls back to the inline card without live
    // context; the inline path is the primary surface.
    return (
      <SubagentCard
        agentId={(result as TaskResult | undefined)?.agentId}
        subagentType=""
        description=""
        outerStatus={isError ? "error" : "complete"}
        isError={isError}
        fallbackContent={(result as TaskResult | undefined)?.content}
      />
    );
  },

  getUseSummary(input) {
    return (input as TaskInput).description;
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result as TaskResult;
    return r?.status ? `${r.status}` : "Complete";
  },

  renderInline(input, result, isError, status, context) {
    return (
      <TaskInline
        input={input as TaskInput}
        result={result as TaskResult | undefined}
        isError={isError}
        status={status}
        toolUseId={context.toolUseId}
      />
    );
  },
};
