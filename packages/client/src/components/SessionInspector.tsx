import type {
  AppSessionSummary,
  MarkdownAugment,
  SessionQuestion,
} from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useGitStatus } from "../hooks/useGitStatus";
import { useI18n } from "../i18n";
import { formatSmartTime } from "../lib/datetime";
import { getOpenCodeSubagentSessionId } from "../lib/openCodeSubagents";
import {
  type ActiveToolApproval,
  isPlanProgressItem,
  preprocessMessages,
} from "../lib/preprocessMessages";
import type {
  ContentBlock,
  Message,
  ProviderName,
  SessionStatus,
} from "../types";
import type { RenderItem, ToolCallItem } from "../types/renderItems";
import { ProviderBadge } from "./ProviderBadge";
import {
  type ChecklistItem,
  normalizeChecklistStatus,
} from "./renderers/tools/Checklist";

type InspectorPresentation = "sidebar" | "drawer";
type InspectorTab = "questions" | "files" | "checks" | "git";
type FileActivityKind = "modified" | "read" | "searched" | "other";
type CheckStatus = "passed" | "failed" | "running" | "pending";
type CodexMessagePhase = "commentary" | "final_answer";
type TFunction = ReturnType<typeof useI18n>["t"];

interface SessionInspectorProps {
  presentation: InspectorPresentation;
  isOpen?: boolean;
  onClose?: () => void;
  messages: Message[];
  userQuestions?: SessionQuestion[];
  markdownAugments?: Record<string, MarkdownAugment>;
  activeToolApproval?: ActiveToolApproval;
  projectId: string;
  sessionId: string;
  provider?: ProviderName;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  basePath?: string;
  status: SessionStatus;
  processState?: string;
  /** Persisted Codex lineage. Only these entries are safe navigation targets. */
  subagentThreads?: NonNullable<AppSessionSummary["subagentThreads"]>;
  onSelectMessage: (messageId: string) => void;
}

interface QuestionItem {
  id: string;
  text: string;
  timestamp?: string;
}

interface FileActivity {
  path: string;
  kind: FileActivityKind;
  tools: Set<string>;
  count: number;
  messageId: string;
  lastIndex: number;
}

interface CheckItem {
  id: string;
  command: string;
  label: string;
  status: CheckStatus;
  messageId: string;
  timestamp?: string;
  lastIndex: number;
}

interface PlanProgress {
  title: string;
  completed: number;
  total: number;
  items: ChecklistItem[];
  note?: string;
}

/** A provider-native subagent session spawned from this session's task tool. */
interface SubagentItem {
  /** Child session id (target of the navigation link). */
  sessionId: string;
  description: string;
  agent?: string;
  status?: ToolCallItem["status"] | "starting";
  /** Canonical activity alone is not proof that a persisted session exists. */
  navigable: boolean;
  /** Relative depth within the displayed child tree. */
  depth: number;
}

interface CodexChannelSummary {
  phase: CodexMessagePhase;
  count: number;
}

const BASE_TAB_KEYS: InspectorTab[] = ["questions", "files", "checks", "git"];

const MUTATING_FILE_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Write",
  "apply_patch",
  "applyPatch",
]);
const READ_FILE_TOOLS = new Set(["Read"]);
const SEARCH_FILE_TOOLS = new Set(["Glob", "Grep"]);
const CHECK_COMMAND_RE =
  /\b((pnpm|npm|yarn|bun)\s+(--filter\s+\S+\s+)?(run\s+)?(lint|typecheck|test(?::e2e)?|build)\b|tsc\b|vitest\b|playwright\s+test\b|biome\s+check\b)/i;

export function SessionInspector({
  presentation,
  isOpen = true,
  onClose,
  messages,
  userQuestions,
  markdownAugments,
  activeToolApproval,
  projectId,
  sessionId,
  provider,
  model,
  reasoningEffort,
  serviceTier,
  basePath = "",
  status,
  processState,
  subagentThreads,
  onSelectMessage,
}: SessionInspectorProps) {
  const { t, locale } = useI18n();
  const [activeTab, setActiveTab] = useState<InspectorTab>("questions");
  const [copiedSessionId, setCopiedSessionId] = useState(false);
  const {
    gitStatus,
    loading: gitLoading,
    error: gitError,
  } = useGitStatus(projectId);
  const isCodexProvider = provider === "codex" || provider === "codex-oss";

  const renderItems = useMemo(
    () =>
      preprocessMessages(messages, {
        markdown: markdownAugments,
        activeToolApproval,
      }),
    [activeToolApproval, markdownAugments, messages],
  );

  const messageQuestions = useMemo(
    () => buildQuestionItems(renderItems),
    [renderItems],
  );
  const questions = useMemo(
    () => mergeQuestionItems(userQuestions, messageQuestions),
    [messageQuestions, userQuestions],
  );
  const fileActivities = useMemo(
    () => buildFileActivities(renderItems),
    [renderItems],
  );
  const checks = useMemo(() => buildCheckItems(renderItems), [renderItems]);
  const subagents = useMemo(
    () => buildSubagentItems(renderItems, subagentThreads, sessionId),
    [renderItems, sessionId, subagentThreads],
  );
  const planProgress = useMemo(
    () => buildPlanProgress(renderItems, t),
    [renderItems, t],
  );
  const codexChannelSummaries = useMemo(
    () => (isCodexProvider ? buildCodexChannelSummaries(messages) : []),
    [isCodexProvider, messages],
  );

  const handleSelect = (messageId: string) => {
    onSelectMessage(messageId);
    if (presentation === "drawer") {
      onClose?.();
    }
  };

  useEffect(() => {
    if (!copiedSessionId) return;
    const timeout = window.setTimeout(() => setCopiedSessionId(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copiedSessionId]);

  const handleCopySessionId = async () => {
    try {
      await writeClipboardText(sessionId);
      setCopiedSessionId(true);
    } catch (error) {
      console.error("Failed to copy session ID:", error);
    }
  };

  const body = (
    <>
      <div className="session-inspector-header">
        <div>
          <h2 className="session-inspector-title">
            {t("sessionInspectorTitle")}
          </h2>
          <div className="session-inspector-subtitle">
            {questions.length} {t("sessionInspectorQuestions").toLowerCase()}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            className="session-inspector-close"
            onClick={onClose}
            title={
              presentation === "sidebar"
                ? t("sessionInspectorCollapse")
                : t("sessionInspectorClose")
            }
            aria-label={
              presentation === "sidebar"
                ? t("sessionInspectorCollapse")
                : t("sessionInspectorClose")
            }
            aria-controls="session-inspector-panel"
            aria-expanded="true"
          >
            {presentation === "sidebar" ? (
              <CollapseRightPanelIcon />
            ) : (
              <CloseIcon />
            )}
          </button>
        )}
      </div>

      <div className="session-inspector-status-card">
        <div className="session-inspector-status-top">
          <span className="session-inspector-muted">
            {t("sessionInspectorStatus")}
          </span>
          <span className="session-inspector-pill">
            {getStatusLabel(t, status, processState)}
          </span>
        </div>
        {provider && (
          <div className="session-inspector-provider-row">
            <ProviderBadge
              provider={provider}
              model={model}
              reasoningEffort={reasoningEffort}
              serviceTier={serviceTier}
            />
          </div>
        )}
        {codexChannelSummaries.length > 0 && (
          <div
            className="session-inspector-channel-summary"
            aria-label={t("sessionInspectorChannels")}
          >
            {codexChannelSummaries.map((item) => (
              <span
                key={item.phase}
                className="session-inspector-channel-summary-item"
              >
                <span
                  className={`session-inspector-channel-dot phase-${item.phase}`}
                  aria-hidden="true"
                />
                <span>{getCodexChannelLabel(t, item.phase)}</span>
                <span className="session-inspector-row-meta">
                  {t("sessionInspectorChannelMessageCount", {
                    count: item.count,
                  })}
                </span>
              </span>
            ))}
          </div>
        )}
        <div className="session-inspector-session-id">
          <span className="session-inspector-session-id-label">
            {t("sessionInspectorSessionId")}
          </span>
          <code
            className="session-inspector-session-id-value"
            title={sessionId}
          >
            {sessionId}
          </code>
          <button
            type="button"
            className={`session-inspector-copy-id${copiedSessionId ? " is-copied" : ""}`}
            onClick={handleCopySessionId}
            title={
              copiedSessionId
                ? t("sessionInspectorSessionIdCopied")
                : t("sessionInspectorCopySessionId")
            }
            aria-label={
              copiedSessionId
                ? t("sessionInspectorSessionIdCopied")
                : t("sessionInspectorCopySessionId")
            }
          >
            {copiedSessionId ? <CopiedIcon /> : <CopyIcon />}
          </button>
        </div>
      </div>

      {planProgress && <InspectorPlanProgress progress={planProgress} t={t} />}

      {presentation === "drawer" && (
        <div className="session-inspector-tabs" role="tablist">
          {BASE_TAB_KEYS.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`session-inspector-tab ${activeTab === tab ? "active" : ""}`}
              onClick={() => setActiveTab(tab)}
              role="tab"
              aria-selected={activeTab === tab}
            >
              {getTabLabel(t, tab)}
            </button>
          ))}
        </div>
      )}

      <div className="session-inspector-content">
        {subagents.length > 0 && (
          <InspectorSection
            title={t("sessionInspectorSubagents")}
            count={subagents.length}
          >
            <ul className="session-inspector-list">
              {subagents.map((subagent) => {
                const rowContent = (
                  <>
                    <span
                      className={`session-inspector-check-dot status-${getSubagentDotStatus(subagent.status)}`}
                      aria-hidden="true"
                    />
                    <span className="session-inspector-row-main">
                      <span className="session-inspector-row-title">
                        {subagent.description || subagent.sessionId}
                      </span>
                      <span className="session-inspector-row-meta">
                        {subagent.agent ? `${subagent.agent} · ` : ""}
                        {subagent.status
                          ? getSubagentStatusLabel(t, subagent.status)
                          : null}
                        {!subagent.navigable
                          ? `${subagent.status ? " · " : ""}${t(
                              "sessionInspectorSubagentUnavailable",
                            )}`
                          : null}
                      </span>
                    </span>
                  </>
                );
                const indentation = Math.max(0, subagent.depth - 1) * 12;

                return (
                  <li
                    key={subagent.sessionId}
                    data-depth={subagent.depth}
                    style={{ paddingInlineStart: `${indentation}px` }}
                  >
                    {subagent.navigable ? (
                      <Link
                        className="session-inspector-row"
                        to={`${basePath}/projects/${projectId}/sessions/${subagent.sessionId}`}
                        title={subagent.description || subagent.sessionId}
                      >
                        {rowContent}
                      </Link>
                    ) : (
                      <div
                        className="session-inspector-row"
                        title={subagent.description || subagent.sessionId}
                        aria-disabled="true"
                      >
                        {rowContent}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </InspectorSection>
        )}

        {presentation === "sidebar" || activeTab === "questions" ? (
          <InspectorSection
            title={t("sessionInspectorQuestions")}
            count={questions.length}
          >
            {questions.length > 0 ? (
              <ol className="session-inspector-list">
                {questions.map((question, index) => (
                  <li key={question.id}>
                    <button
                      type="button"
                      className="session-inspector-row session-inspector-question"
                      onClick={() => handleSelect(question.id)}
                      title={question.text}
                    >
                      <span className="session-inspector-index">
                        {index + 1}
                      </span>
                      <span className="session-inspector-row-main">
                        <span className="session-inspector-row-title">
                          {question.text}
                        </span>
                        {question.timestamp && (
                          <span className="session-inspector-row-meta">
                            {formatSmartTime(question.timestamp, locale)}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState text={t("sessionInspectorNoQuestions")} />
            )}
          </InspectorSection>
        ) : null}

        {presentation === "sidebar" || activeTab === "files" ? (
          <InspectorSection
            title={t("sessionInspectorFiles")}
            count={fileActivities.length}
          >
            {fileActivities.length > 0 ? (
              <ul className="session-inspector-list">
                {fileActivities.slice(0, 10).map((activity) => (
                  <li key={activity.path}>
                    <button
                      type="button"
                      className="session-inspector-row"
                      onClick={() => handleSelect(activity.messageId)}
                      title={activity.path}
                    >
                      <span
                        className={`session-inspector-file-dot kind-${activity.kind}`}
                      />
                      <span className="session-inspector-row-main">
                        <span className="session-inspector-row-title">
                          {shortPath(activity.path)}
                        </span>
                        <span className="session-inspector-row-meta">
                          {getFileKindLabel(t, activity.kind)} -{" "}
                          {[...activity.tools].slice(0, 3).join(", ")}
                          {activity.count > 1 ? ` - ${activity.count}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState text={t("sessionInspectorNoFiles")} />
            )}
          </InspectorSection>
        ) : null}

        {presentation === "sidebar" || activeTab === "checks" ? (
          <InspectorSection
            title={t("sessionInspectorChecks")}
            count={checks.length}
          >
            {checks.length > 0 ? (
              <ul className="session-inspector-list">
                {checks.slice(0, 8).map((check) => (
                  <li key={check.id}>
                    <button
                      type="button"
                      className="session-inspector-row"
                      onClick={() => handleSelect(check.messageId)}
                      title={check.command}
                    >
                      <span
                        className={`session-inspector-check-dot status-${check.status}`}
                      />
                      <span className="session-inspector-row-main">
                        <span className="session-inspector-row-title">
                          {check.label}
                        </span>
                        <span className="session-inspector-row-meta">
                          {getCheckStatusLabel(t, check.status)}
                          {check.timestamp
                            ? ` - ${formatSmartTime(check.timestamp, locale)}`
                            : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState text={t("sessionInspectorNoChecks")} />
            )}
          </InspectorSection>
        ) : null}

        {presentation === "sidebar" || activeTab === "git" ? (
          <InspectorSection
            title={t("sessionInspectorGit")}
            count={gitStatus?.files.length}
            action={
              <Link
                className="session-inspector-section-link"
                to={`${basePath}/settings/source-control?projectId=${encodeURIComponent(projectId)}`}
              >
                {t("gitStatusTitle")}
              </Link>
            }
          >
            {gitLoading ? (
              <EmptyState text={t("sessionInspectorGitLoading")} />
            ) : gitError ? (
              <EmptyState text={t("sessionInspectorGitUnavailable")} />
            ) : gitStatus && !gitStatus.isGitRepo ? (
              <EmptyState text={t("sessionInspectorGitNotRepo")} />
            ) : gitStatus?.isClean ? (
              <EmptyState text={t("sessionInspectorGitClean")} />
            ) : gitStatus ? (
              <div className="session-inspector-git">
                <div className="session-inspector-git-branch">
                  <span>{gitStatus.branch ?? "HEAD"}</span>
                  {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
                    <span className="session-inspector-row-meta">
                      {gitStatus.ahead > 0 ? `+${gitStatus.ahead}` : ""}
                      {gitStatus.behind > 0 ? ` -${gitStatus.behind}` : ""}
                    </span>
                  )}
                </div>
                <ul className="session-inspector-list">
                  {gitStatus.files.slice(0, 8).map((file) => (
                    <li key={`${file.path}-${file.staged}`}>
                      <Link
                        className="session-inspector-row"
                        to={`${basePath}/settings/source-control?projectId=${encodeURIComponent(projectId)}`}
                        title={file.path}
                      >
                        <span className="session-inspector-git-status">
                          {file.status}
                        </span>
                        <span className="session-inspector-row-main">
                          <span className="session-inspector-row-title">
                            {shortPath(file.path)}
                          </span>
                          <span className="session-inspector-row-meta">
                            {file.staged ? "staged" : "working"}
                            {formatLineDelta(file)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </InspectorSection>
        ) : null}
      </div>
    </>
  );

  if (presentation === "drawer") {
    if (!isOpen) return null;
    return (
      <div
        className="session-inspector-overlay"
        role="presentation"
        onClick={onClose}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose?.();
          }
        }}
      >
        <aside
          id="session-inspector-panel"
          className="session-inspector session-inspector--drawer"
          aria-label={t("sessionInspectorTitle")}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {body}
        </aside>
      </div>
    );
  }

  return (
    <aside
      id="session-inspector-panel"
      className="session-inspector session-inspector--sidebar"
      aria-label={t("sessionInspectorTitle")}
    >
      {body}
    </aside>
  );
}

function InspectorSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="session-inspector-section">
      <div className="session-inspector-section-header">
        <h3>
          {title}
          {count !== undefined && (
            <span className="session-inspector-count">{count}</span>
          )}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="session-inspector-empty">{text}</div>;
}

function InspectorPlanProgress({
  progress,
  t,
}: {
  progress: PlanProgress;
  t: TFunction;
}) {
  return (
    <section className="session-inspector-plan-card">
      <div className="session-inspector-plan-header">
        <h3>{progress.title}</h3>
        <span className="session-inspector-plan-progress">
          {t("sessionInspectorPlanProgress", {
            completed: progress.completed,
            total: progress.total,
          })}
        </span>
      </div>
      {progress.note && (
        <div className="session-inspector-plan-note">{progress.note}</div>
      )}
      <div className="session-inspector-plan-items">
        {progress.items.map((item, index) => (
          <div
            key={`${item.label}-${index}`}
            className={`session-inspector-plan-item ${getPlanStatusClassName(item.status)}`}
          >
            <span
              className="session-inspector-plan-marker"
              aria-hidden="true"
            />
            <span className="session-inspector-plan-label">{item.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function getPlanStatusClassName(status: ChecklistItem["status"]): string {
  return status === "in_progress" ? "in-progress" : status;
}

function buildPlanProgress(
  items: RenderItem[],
  t: TFunction,
): PlanProgress | null {
  const planItems = items.filter(isPlanProgressItem);
  const latest = planItems[planItems.length - 1];
  if (!latest) {
    return null;
  }

  const extracted = extractPlanProgress(latest);
  if (!extracted || extracted.items.length === 0) {
    return null;
  }

  const completed = extracted.items.filter(
    (item) => item.status === "completed",
  ).length;

  return {
    title: t("sessionInspectorPlan"),
    completed,
    total: extracted.items.length,
    items: extracted.items,
    note: extracted.note,
  };
}

function extractPlanProgress(
  item: ToolCallItem,
): { items: ChecklistItem[]; note?: string } | null {
  const normalizedToolName = item.toolName
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, "");

  if (normalizedToolName === "updateplan") {
    return extractUpdatePlanProgress(item.toolInput);
  }

  if (normalizedToolName === "todowrite") {
    return extractTodoWriteProgress(item);
  }

  return null;
}

function extractUpdatePlanProgress(
  input: unknown,
): { items: ChecklistItem[]; note?: string } | null {
  if (!isRecord(input) || !Array.isArray(input.plan)) {
    return null;
  }

  const items = input.plan
    .filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && typeof entry.step === "string" && entry.step !== "",
    )
    .map((entry) => ({
      label: entry.step as string,
      status: normalizeChecklistStatus(entry.status),
    }));

  const note =
    typeof input.explanation === "string" && input.explanation.trim()
      ? input.explanation.trim()
      : undefined;

  return { items, note };
}

function extractTodoWriteProgress(
  item: ToolCallItem,
): { items: ChecklistItem[] } | null {
  const structured = item.toolResult?.structured;
  const todos =
    isRecord(structured) && Array.isArray(structured.newTodos)
      ? structured.newTodos
      : isRecord(item.toolInput) && Array.isArray(item.toolInput.todos)
        ? item.toolInput.todos
        : null;

  if (!todos) {
    return null;
  }

  const items = todos
    .filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) &&
        typeof entry.content === "string" &&
        entry.content !== "",
    )
    .map((entry) => ({
      label: entry.content as string,
      status: normalizeChecklistStatus(entry.status),
    }));

  return { items };
}

function buildQuestionItems(items: RenderItem[]): QuestionItem[] {
  return items
    .filter((item): item is RenderItem & { type: "user_prompt" } => {
      return item.type === "user_prompt";
    })
    .map((item) => ({
      id: item.id,
      text: compactText(contentToText(item.content), 140) || "Untitled",
      timestamp: item.sourceMessages[0]?.timestamp,
    }));
}

function mergeQuestionItems(
  serverQuestions: SessionQuestion[] | undefined,
  messageQuestions: QuestionItem[],
): QuestionItem[] {
  const merged: QuestionItem[] = [];
  const seenIds = new Set<string>();
  const seenSemanticKeys = new Set<string>();

  const append = (question: QuestionItem) => {
    const text = compactText(question.text, 140) || "Untitled";
    const id = question.id || `${question.timestamp ?? ""}:${text}`;
    const semanticKey = `${question.timestamp ?? ""}\n${text}`;

    if (seenIds.has(id) || seenSemanticKeys.has(semanticKey)) {
      return;
    }

    seenIds.add(id);
    seenSemanticKeys.add(semanticKey);
    merged.push({
      id,
      text,
      timestamp: question.timestamp,
    });
  };

  for (const question of serverQuestions ?? []) {
    append(question);
  }

  for (const question of messageQuestions) {
    append(question);
  }

  return merged;
}

function buildCodexChannelSummaries(
  messages: Message[],
): CodexChannelSummary[] {
  const summaries = new Map<CodexMessagePhase, CodexChannelSummary>();

  for (const message of messages) {
    const phase = getCodexMessagePhase(message.codexMessagePhase);
    if (!phase || message.type !== "assistant") {
      continue;
    }

    const content =
      (message.message as { content?: string | ContentBlock[] } | undefined)
        ?.content ?? message.content;
    if (content === undefined) {
      continue;
    }

    const text = contentToText(content).replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }

    const current = summaries.get(phase);
    summaries.set(phase, {
      phase,
      count: (current?.count ?? 0) + 1,
    });
  }

  return (["commentary", "final_answer"] as const).flatMap((phase) => {
    const summary = summaries.get(phase);
    return summary ? [summary] : [];
  });
}

function getCodexMessagePhase(value: unknown): CodexMessagePhase | null {
  return value === "commentary" || value === "final_answer" ? value : null;
}

function buildFileActivities(items: RenderItem[]): FileActivity[] {
  const grouped = new Map<string, FileActivity>();

  items.forEach((item, index) => {
    if (item.type !== "tool_call") return;
    const paths = extractToolPaths(item);
    if (paths.length === 0) return;
    const kind = getFileActivityKind(item.toolName);
    const messageId = item.sourceMessages[0]
      ? getMessageIdLike(item.sourceMessages[0])
      : item.id;

    for (const path of paths) {
      const existing = grouped.get(path);
      if (existing) {
        existing.count += 1;
        existing.tools.add(item.toolName);
        if (index >= existing.lastIndex) {
          existing.kind = prioritizeFileKind(existing.kind, kind);
          existing.messageId = messageId;
          existing.lastIndex = index;
        }
      } else {
        grouped.set(path, {
          path,
          kind,
          tools: new Set([item.toolName]),
          count: 1,
          messageId,
          lastIndex: index,
        });
      }
    }
  });

  return [...grouped.values()].sort((a, b) => b.lastIndex - a.lastIndex);
}

function buildCheckItems(items: RenderItem[]): CheckItem[] {
  return items
    .flatMap((item, index) => {
      if (item.type !== "tool_call") return [];
      const command = extractCommand(item.toolInput);
      if (!command || !CHECK_COMMAND_RE.test(command)) return [];
      const messageId = item.sourceMessages[0]
        ? getMessageIdLike(item.sourceMessages[0])
        : item.id;
      return [
        {
          id: item.id,
          command,
          label: compactText(command, 80),
          status: getCheckStatus(item),
          messageId,
          timestamp: item.sourceMessages[0]?.timestamp,
          lastIndex: index,
        },
      ];
    })
    .sort((a, b) => b.lastIndex - a.lastIndex);
}

function getMessageIdLike(message: Message): string {
  return message.uuid ?? message.id ?? "";
}

type PersistedSubagentThread = NonNullable<
  AppSessionSummary["subagentThreads"]
>[number];

/**
 * Merge provider-native child identities with activity state.
 *
 * OpenCode keeps deriving both identity and lifecycle from its persisted task
 * tool. Codex deliberately separates the two: manifest lineage proves that a
 * child transcript exists and can be linked, while canonical render items only
 * provide lifecycle updates. A live-only Codex id remains visible but cannot
 * navigate to a session that has not been persisted/indexed yet.
 */
function buildSubagentItems(
  items: RenderItem[],
  persistedThreads: readonly PersistedSubagentThread[] | undefined,
  currentSessionId: string,
): SubagentItem[] {
  const openCodeItems = buildOpenCodeSubagentItems(items);
  const codexItems = buildCodexSubagentItems(
    items,
    persistedThreads,
    currentSessionId,
  );
  return [...openCodeItems, ...codexItems];
}

function buildOpenCodeSubagentItems(items: RenderItem[]): SubagentItem[] {
  const result: SubagentItem[] = [];
  const resultIndexBySessionId = new Map<string, number>();

  for (const item of items) {
    if (item.type !== "tool_call") continue;
    if (item.toolName.toLowerCase() !== "task") continue;
    if (!isRecord(item.toolInput)) continue;

    const sessionId = getOpenCodeSubagentSessionId(item.toolInput);
    if (!sessionId) continue;

    const description =
      (typeof item.toolInput.description === "string" &&
        item.toolInput.description.trim()) ||
      (typeof item.toolInput.opencodeTitle === "string" &&
        item.toolInput.opencodeTitle.trim()) ||
      "";
    const agent =
      typeof item.toolInput.subagent_type === "string"
        ? item.toolInput.subagent_type.trim()
        : undefined;

    const next = {
      sessionId,
      description,
      agent,
      status: item.status,
      navigable: true,
      depth: 1,
    } satisfies SubagentItem;
    const existingIndex = resultIndexBySessionId.get(sessionId);
    if (existingIndex === undefined) {
      resultIndexBySessionId.set(sessionId, result.length);
      result.push(next);
      continue;
    }

    const existing = result[existingIndex];
    if (existing) {
      // `task_id` can resume the same child. Keep its original list position
      // while reflecting the latest description, agent, and lifecycle state.
      result[existingIndex] = {
        ...next,
        description: description || existing.description,
        agent: agent || existing.agent,
      };
    }
  }

  return result;
}

function buildCodexSubagentItems(
  items: RenderItem[],
  persistedThreads: readonly PersistedSubagentThread[] | undefined,
  currentSessionId: string,
): SubagentItem[] {
  const result: SubagentItem[] = [];
  const resultIndexBySessionId = new Map<string, number>();

  for (const thread of persistedThreads ?? []) {
    const threadId = thread.sessionId.trim();
    if (!threadId || threadId === currentSessionId) continue;

    const nickname = thread.agentNickname?.trim();
    const role = thread.agentRole?.trim();
    const existingIndex = resultIndexBySessionId.get(threadId);
    const next: SubagentItem = {
      sessionId: threadId,
      description: nickname || role || formatSubagentSessionId(threadId),
      agent: nickname && role ? role : undefined,
      navigable: true,
      depth: normalizeSubagentDepth(thread.depth),
    };

    if (existingIndex === undefined) {
      resultIndexBySessionId.set(threadId, result.length);
      result.push(next);
    } else {
      result[existingIndex] = {
        ...result[existingIndex],
        ...next,
      };
    }
  }

  for (const item of items) {
    if (item.type !== "subagent") continue;

    for (const rawThreadId of item.agentThreadIds) {
      const threadId = rawThreadId.trim();
      if (!threadId || threadId === currentSessionId) continue;

      const nextStatus = getCodexSubagentStatus(item, threadId);
      const existingIndex = resultIndexBySessionId.get(threadId);
      if (existingIndex !== undefined) {
        const existing = result[existingIndex];
        if (existing && nextStatus) {
          result[existingIndex] = { ...existing, status: nextStatus };
        }
        continue;
      }

      const senderDepth = item.senderThreadId
        ? result.find(
            (candidate) => candidate.sessionId === item.senderThreadId,
          )?.depth
        : undefined;
      resultIndexBySessionId.set(threadId, result.length);
      result.push({
        sessionId: threadId,
        description: formatSubagentSessionId(threadId),
        status: nextStatus,
        navigable: false,
        depth: Math.min((senderDepth ?? 0) + 1, 10),
      });
    }
  }

  return result;
}

function getCodexSubagentStatus(
  item: Extract<RenderItem, { type: "subagent" }>,
  threadId: string,
): SubagentItem["status"] {
  const agentState = item.agentStates?.[threadId];
  if (agentState) {
    const normalized = agentState
      .trim()
      .toLowerCase()
      .replaceAll("_", "")
      .replaceAll("-", "");
    switch (normalized) {
      case "pendinginit":
      case "starting":
        return "starting";
      case "running":
        return "pending";
      case "completed":
      case "complete":
        return "complete";
      case "interrupted":
        return "aborted";
      case "errored":
      case "error":
      case "failed":
      case "notfound":
        return "error";
    }
  }

  const activity = item.activity
    .trim()
    .toLowerCase()
    .replaceAll("_", "")
    .replaceAll("-", "");
  if (activity === "started") return "pending";
  if (activity === "interrupted") return "aborted";
  // `interacted` is intentionally non-lifecycle in Codex TUI semantics.
  if (activity === "interacted") return undefined;
  if (item.status === "error" || item.status === "declined") return "error";
  if (item.status === "cancelled") return "aborted";
  if (activity === "spawnagent" && item.status !== "complete") {
    return "starting";
  }
  // Completing a collaboration tool does not imply that the child completed.
  return undefined;
}

function normalizeSubagentDepth(depth: number): number {
  if (!Number.isFinite(depth)) return 1;
  return Math.min(Math.max(Math.trunc(depth), 1), 10);
}

function formatSubagentSessionId(sessionId: string): string {
  if (sessionId.length <= 20) return sessionId;
  return `${sessionId.slice(0, 10)}…${sessionId.slice(-6)}`;
}

function getSubagentStatusLabel(
  t: TFunction,
  status: NonNullable<SubagentItem["status"]>,
): string {
  switch (status) {
    case "starting":
      return t("subagentStatusStarting");
    case "pending":
      return t("subagentStatusRunning");
    case "error":
      return t("subagentStatusFailed");
    case "aborted":
      return t("subagentStatusInterrupted");
    default:
      return t("subagentStatusCompleted");
  }
}

function getSubagentDotStatus(status: SubagentItem["status"]): CheckStatus {
  switch (status) {
    case "starting":
    case "pending":
      return "running";
    case "error":
    case "aborted":
      return "failed";
    case "complete":
      return "passed";
    default:
      return "pending";
  }
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "input_image" || block.type === "image")
        return "[image]";
      if (block.type === "document") return "[document]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractToolPaths(item: ToolCallItem): string[] {
  if (!isRecord(item.toolInput)) return [];
  const input = item.toolInput;
  const candidates = [
    input.file_path,
    input.filePath,
    input.path,
    input.notebook_path,
    input.notebookPath,
    input.old_path,
    input.oldPath,
    input.new_path,
    input.newPath,
  ];
  return uniqueStrings(candidates).filter(
    (path) => !looksLikeShellCommand(path),
  );
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function looksLikeShellCommand(value: string): boolean {
  return /\s(&&|\|\||\||;)\s/.test(value) || /^\w+=/.test(value);
}

function getFileActivityKind(toolName: string): FileActivityKind {
  if (MUTATING_FILE_TOOLS.has(toolName)) return "modified";
  if (READ_FILE_TOOLS.has(toolName)) return "read";
  if (SEARCH_FILE_TOOLS.has(toolName)) return "searched";
  return "other";
}

function prioritizeFileKind(
  previous: FileActivityKind,
  next: FileActivityKind,
): FileActivityKind {
  if (previous === "modified" || next === "modified") return "modified";
  if (previous === "searched" || next === "searched") return "searched";
  if (previous === "read" || next === "read") return "read";
  return "other";
}

function extractCommand(input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of ["command", "cmd", "script"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const args = input.args;
  if (Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
    return args.join(" ");
  }
  return null;
}

function getCheckStatus(item: ToolCallItem): CheckStatus {
  if (item.status === "pending") return "pending";
  if (item.status === "error" || item.toolResult?.isError) return "failed";
  const content = item.toolResult?.content ?? "";
  if (/exit (?:code|status)\s+[1-9]\d*/i.test(content)) return "failed";
  if (/command failed|tests? failed|failed/i.test(content)) return "failed";
  if (/exit (?:code|status)\s+0/i.test(content)) return "passed";
  return item.status === "complete" ? "passed" : "running";
}

function shortPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

function formatLineDelta(file: {
  linesAdded: number | null;
  linesDeleted: number | null;
}): string {
  const added = file.linesAdded ?? 0;
  const deleted = file.linesDeleted ?? 0;
  if (added === 0 && deleted === 0) return "";
  return ` - +${added} -${deleted}`;
}

function getTabLabel(t: TFunction, tab: InspectorTab): string {
  switch (tab) {
    case "questions":
      return t("sessionInspectorQuestions");
    case "files":
      return t("sessionInspectorFiles");
    case "checks":
      return t("sessionInspectorChecks");
    case "git":
      return t("sessionInspectorGit");
  }
}

function getCodexChannelLabel(t: TFunction, phase: CodexMessagePhase): string {
  switch (phase) {
    case "commentary":
      return t("sessionInspectorCommentary");
    case "final_answer":
      return t("sessionInspectorFinalAnswer");
  }
}

function getFileKindLabel(t: TFunction, kind: FileActivityKind): string {
  switch (kind) {
    case "modified":
      return t("sessionInspectorModified");
    case "read":
      return t("sessionInspectorRead");
    case "searched":
      return t("sessionInspectorSearched");
    case "other":
      return t("sessionInspectorOther");
  }
}

function getCheckStatusLabel(t: TFunction, status: CheckStatus): string {
  switch (status) {
    case "passed":
      return t("sessionInspectorPassed");
    case "failed":
      return t("sessionInspectorFailed");
    case "running":
      return t("sessionInspectorRunning");
    case "pending":
      return t("sessionInspectorPending");
  }
}

function getStatusLabel(
  t: TFunction,
  status: SessionStatus,
  processState?: string,
): string {
  if (status.owner === "external") return t("sessionInspectorExternal");
  if (status.owner === "self") {
    return processState === "in-turn"
      ? t("statusProcessing")
      : t("sessionInspectorSelf");
  }
  return t("sessionInspectorIdle");
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function CollapseRightPanelIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
      <polyline points="10 9 13 12 10 15" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CopiedIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
