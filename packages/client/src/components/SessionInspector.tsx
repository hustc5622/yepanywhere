import type {
  MarkdownAugment,
  ProviderInfo,
  SessionQuestion,
  ThinkingOption,
} from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useGitStatus } from "../hooks/useGitStatus";
import { useModelSettings } from "../hooks/useModelSettings";
import { useI18n } from "../i18n";
import { formatSmartTime } from "../lib/datetime";
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
import { RepoTree } from "./RepoTree";
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
  onSelectMessage: (messageId: string) => void;
  /** Open a repository file (relative path) in a page tab. */
  onOpenFile?: (filePath: string) => void;
  /** Active process id, when the session is running (enables live model switch). */
  processId?: string;
  /** Provider info list (for model list + codex reasoning-effort levels). */
  providers?: ProviderInfo[];
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
  onSelectMessage,
  onOpenFile,
  processId,
  providers,
}: SessionInspectorProps) {
  const { t, locale } = useI18n();
  const [activeTab, setActiveTab] = useState<InspectorTab>("questions");
  const [copiedSessionId, setCopiedSessionId] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Optimistic local state for model select (prop may lag after API call).
  const [selectedModel, setSelectedModel] = useState(model ?? "default");
  // Sync optimistic state when prop changes externally (SSE, re-fetch, etc.).
  const prevModelRef = useRef(model);
  useEffect(() => {
    if (model !== prevModelRef.current) {
      setSelectedModel(model ?? "default");
      prevModelRef.current = model;
    }
  }, [model]);
  const {
    gitStatus,
    loading: gitLoading,
    error: gitError,
  } = useGitStatus(projectId);
  const isCodexProvider = provider === "codex" || provider === "codex-oss";
  const { thinkingOption, setThinkingOption } = useModelSettings();

  const providerInfo = useMemo(
    () => providers?.find((p) => p.name === provider) ?? null,
    [providers, provider],
  );

  // --- Live model switch (Codex-native model list) ---
  const modelOptions = useMemo(
    () => providerInfo?.models ?? [],
    [providerInfo],
  );

  // --- Model switch (live process or preset for next start) ---
  const handleModelChange = useCallback(
    (nextModel: string) => {
      const resolvedModel = nextModel === "default" ? undefined : nextModel;
      // Optimistic UI update
      setSelectedModel(nextModel);
      if (processId) {
        // Live session: switch model on the running process immediately.
        api.setProcessModel(processId, resolvedModel).catch((err) => {
          console.error("Failed to switch model:", err);
          // Revert on error
          setSelectedModel(model ?? "default");
        });
      } else {
        // Stopped/idle session: store as preset default for next start.
        api
          .updateSessionMetadata(sessionId, { model: resolvedModel })
          .catch((err) => {
            console.error("Failed to save preset model:", err);
            // Revert on error
            setSelectedModel(model ?? "default");
          });
      }
    },
    [processId, sessionId, model],
  );

  // --- Thinking / reasoning-effort switch (matches local provider) ---
  // Render the provider's native levels verbatim — no cross-provider remapping.
  const thinkingOptions = useMemo(() => {
    const nativeLevels = providerInfo?.reasoningEffortLevels;
    if (nativeLevels && nativeLevels.length > 0) {
      return [
        { value: "off", label: t("inspectorThinkingOff") },
        ...nativeLevels.map((level) => ({
          value: `on:${level}` as ThinkingOption,
          label: getReasoningLevelLabel(t, level),
        })),
      ];
    }
    // Fallback for providers that don't expose discrete effort levels.
    return [
      { value: "off", label: t("inspectorThinkingOff") },
      { value: "auto", label: t("inspectorThinkingAuto") },
      { value: "on:low", label: t("inspectorThinkingLow") },
      { value: "on:medium", label: t("inspectorThinkingMedium") },
      { value: "on:high", label: t("inspectorThinkingHigh") },
      { value: "on:max", label: t("inspectorThinkingMax") },
    ];
  }, [providerInfo, t]);

  // Map the stored option to the option list.
  const selectedThinking = useMemo(() => {
    if (thinkingOption === "off") return "off";
    if (thinkingOption === "auto") return "auto";
    if (thinkingOption.startsWith("on:")) {
      const match = thinkingOptions.find((o) => o.value === thinkingOption);
      if (match) return match.value;
      // Stored level not in current provider's set — fall back to last option.
      return thinkingOptions[thinkingOptions.length - 1]?.value;
    }
    return thinkingOptions[thinkingOptions.length - 1]?.value;
  }, [thinkingOption, thinkingOptions]);

  const handleThinkingChange = useCallback(
    (next: string) => {
      setThinkingOption(next as ThinkingOption);
    },
    [setThinkingOption],
  );

  const toggleSection = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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
  const planProgress = useMemo(
    () => buildPlanProgress(renderItems, t),
    [renderItems, t],
  );
  const codexChannelSummaries = useMemo(
    () => (isCodexProvider ? buildCodexChannelSummaries(messages) : []),
    [isCodexProvider, messages],
  );

  const gitStatusHasChanges = useMemo(
    () =>
      !!gitStatus &&
      gitStatus.isGitRepo &&
      !gitStatus.isClean &&
      (gitStatus.files?.length ?? 0) > 0,
    [gitStatus],
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
        {presentation === "drawer" && (
          <button
            type="button"
            className="session-inspector-close"
            onClick={onClose}
            aria-label={t("sessionInspectorClose")}
          >
            <CloseIcon />
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
            <label className="session-inspector-field">
              <span className="session-inspector-field-label">
                {t("inspectorModel")}
              </span>
              <select
                className="session-inspector-select"
                value={selectedModel}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={modelOptions.length === 0}
              >
                <option value="default">{t("inspectorModelDefault")}</option>
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="session-inspector-field">
              <span className="session-inspector-field-label">
                {t("inspectorThinking")}
              </span>
              <select
                className="session-inspector-select"
                value={selectedThinking}
                onChange={(e) => handleThinkingChange(e.target.value)}
              >
                {thinkingOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
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
        {presentation === "sidebar" && onOpenFile && (
          <CollapsibleSection
            title={t("inspectorRepo")}
            sectionKey="repo"
            collapsed={collapsed}
            onToggle={toggleSection}
          >
            <RepoTree projectId={projectId} onOpenFile={onOpenFile} />
          </CollapsibleSection>
        )}

        {(presentation === "sidebar" || activeTab === "questions") &&
          questions.length > 0 && (
            <CollapsibleSection
              title={t("sessionInspectorQuestions")}
              count={questions.length}
              sectionKey="questions"
              collapsed={collapsed}
              onToggle={toggleSection}
            >
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
            </CollapsibleSection>
          )}

        {(presentation === "sidebar" || activeTab === "files") &&
          fileActivities.length > 0 && (
            <CollapsibleSection
              title={t("sessionInspectorFiles")}
              count={fileActivities.length}
              sectionKey="files"
              collapsed={collapsed}
              onToggle={toggleSection}
            >
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
            </CollapsibleSection>
          )}

        {(presentation === "sidebar" || activeTab === "checks") &&
          checks.length > 0 && (
            <CollapsibleSection
              title={t("sessionInspectorChecks")}
              count={checks.length}
              sectionKey="checks"
              collapsed={collapsed}
              onToggle={toggleSection}
            >
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
            </CollapsibleSection>
          )}

        {(presentation === "sidebar" || activeTab === "git") &&
          gitStatusHasChanges && (
            <CollapsibleSection
              title={t("sessionInspectorGit")}
              count={gitStatus?.files.length}
              sectionKey="git"
              collapsed={collapsed}
              onToggle={toggleSection}
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
            </CollapsibleSection>
          )}
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
      className="session-inspector session-inspector--sidebar"
      aria-label={t("sessionInspectorTitle")}
    >
      {body}
    </aside>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="session-inspector-empty">{text}</div>;
}

/**
 * Collapsible inspector section. The header is a toggle button; the body is
 * hidden when collapsed. Rendered only when the caller decides there is
 * content (non-empty) to show.
 */
function CollapsibleSection({
  title,
  count,
  sectionKey,
  collapsed,
  onToggle,
  action,
  children,
}: {
  title: string;
  count?: number;
  sectionKey: string;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  const isCollapsed = collapsed.has(sectionKey);
  return (
    <section
      className={`session-inspector-section${isCollapsed ? " is-collapsed" : ""}`}
    >
      <div className="session-inspector-section-header">
        <button
          type="button"
          className="session-inspector-section-toggle"
          onClick={() => onToggle(sectionKey)}
          aria-expanded={!isCollapsed}
        >
          <ChevronIcon open={!isCollapsed} />
          <h3>
            {title}
            {count !== undefined && (
              <span className="session-inspector-count">{count}</span>
            )}
          </h3>
        </button>
        {action}
      </div>
      {!isCollapsed && children}
    </section>
  );
}

/** Localized label for a Codex reasoning-effort level keyword. */
function getReasoningLevelLabel(t: TFunction, level: string): string {
  switch (level) {
    case "low":
      return t("inspectorThinkingLow");
    case "medium":
      return t("inspectorThinkingMedium");
    case "high":
      return t("inspectorThinkingHigh");
    case "xhigh":
    case "max":
      return t("inspectorThinkingMax");
    default:
      return level;
  }
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`session-inspector-chevron${open ? " is-open" : ""}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
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
