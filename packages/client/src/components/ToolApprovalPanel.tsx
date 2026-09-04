import {
  getToolApprovalPersistence,
  supportsToolApprovalFeedback,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToolApprovalFeedbackDraft } from "../hooks/useDrafts";
import { useI18n } from "../i18n";
import type { InputRequest } from "../types";
import { toolRegistry } from "./renderers/tools";
import type { RenderContext } from "./renderers/types";
import { getToolSummary } from "./tools/summaries";
import { Modal } from "./ui/Modal";

// Tools that can be auto-approved with "accept edits" mode
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

// Check if this is an ExitPlanMode approval (needs custom UI)
const isExitPlanMode = (toolName: string | undefined) =>
  toolName === "ExitPlanMode";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function getMcpApprovalScopes(request: InputRequest): string[] {
  const input = asRecord(request.toolInput);
  if (input?.approvalKind !== "mcp_tool_call") return [];
  return getStringArray(input.persistScopes);
}

function getApprovalKind(request: InputRequest): string | undefined {
  return getString(asRecord(request.toolInput)?.approvalKind);
}

/**
 * A subagent (child session) permission request is routed into the parent
 * session but carries the origin child's identity so the panel can explain
 * which subagent is asking. Prefer a human title, then the agent type.
 */
function getSubagentOriginTitle(request: InputRequest): string | undefined {
  const input = asRecord(request.toolInput);
  if (!input) return undefined;
  if (!getString(input.originSessionId)) return undefined;
  return (
    getString(input.originSessionTitle) ??
    getString(input.originAgent) ??
    undefined
  );
}

function getApprovalPrompt(request: InputRequest): string | undefined {
  return getString(asRecord(request.toolInput)?.approvalPrompt);
}

function getApprovalAction(
  request: InputRequest,
): { url: string; label: string } | null {
  const input = asRecord(request.toolInput);
  const rawUrl = getString(input?.actionUrl);
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return {
      url: url.toString(),
      label: getString(input?.actionLabel) ?? "Open link",
    };
  } catch {
    return null;
  }
}

interface Props {
  request: InputRequest;
  sessionId: string;
  agentName?: string;
  onApprove: () => Promise<void>;
  onDeny: () => Promise<void>;
  onApproveAcceptEdits?: () => Promise<void>;
  onApproveForSession?: () => Promise<void>;
  onApproveStrictAutoReview?: () => Promise<void>;
  onApproveAlways?: () => Promise<void>;
  onDenyWithFeedback?: (feedback: string) => Promise<void>;
  /** Approve ExitPlanMode without changing the session permission mode. */
  preserveModeOnPlanApproval?: boolean;
  /** Whether the panel is collapsed (controlled externally) */
  collapsed?: boolean;
  /** Callback when collapse state changes */
  onCollapsedChange?: (collapsed: boolean) => void;
}

// Delay before buttons become clickable to prevent accidental clicks
const CLICK_PROTECTION_MS = 150;

export function ToolApprovalPanel({
  request,
  sessionId,
  agentName = "Claude",
  onApprove,
  onDeny,
  onApproveAcceptEdits,
  onApproveForSession,
  onApproveStrictAutoReview,
  onApproveAlways,
  onDenyWithFeedback,
  preserveModeOnPlanApproval = false,
  collapsed = false,
  onCollapsedChange,
}: Props) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  // Prevent accidental clicks by disabling buttons briefly when panel appears
  const [armed, setArmed] = useState(false);
  // Show feedback panel if there's already draft text from localStorage
  const [feedback, setFeedback, clearFeedback] =
    useToolApprovalFeedbackDraft(sessionId);
  const [showFeedback, setShowFeedback] = useState(() => feedback.length > 0);
  const feedbackInputRef = useRef<HTMLInputElement>(null);

  // Reset armed state when request changes (new approval appears)
  // biome-ignore lint/correctness/useExhaustiveDependencies: request.id triggers reset on new request
  useEffect(() => {
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), CLICK_PROTECTION_MS);
    return () => clearTimeout(timer);
  }, [request.id]);

  const isEditTool = request.toolName && EDIT_TOOLS.includes(request.toolName);
  const approvalKind = getApprovalKind(request);
  const subagentOriginTitle = getSubagentOriginTitle(request);
  const mcpApprovalScopes = getMcpApprovalScopes(request);
  const isScopedMcpApproval = mcpApprovalScopes.length > 0;
  const isPermissionsApproval = approvalKind === "permissions";
  const usesProviderPersistentApproval =
    approvalKind === "command_execution" || approvalKind === "file_change";
  const approvalPersistence = getToolApprovalPersistence(request.toolInput);
  const canApproveMcpForSession = mcpApprovalScopes.includes("session");
  const canApproveMcpAlways = mcpApprovalScopes.includes("always");
  const canApprovePersistently =
    !isScopedMcpApproval &&
    !isPermissionsApproval &&
    (isEditTool || approvalPersistence !== undefined);
  const canDenyWithFeedback =
    Boolean(onDenyWithFeedback) &&
    supportsToolApprovalFeedback(request.toolInput, request.source);

  const handleApprove = useCallback(async () => {
    setSubmitting(true);
    try {
      await onApprove();
    } finally {
      setSubmitting(false);
    }
  }, [onApprove]);

  const handleApproveAcceptEdits = useCallback(async () => {
    if (!onApproveAcceptEdits) return;
    setSubmitting(true);
    try {
      await onApproveAcceptEdits();
    } finally {
      setSubmitting(false);
    }
  }, [onApproveAcceptEdits]);

  const handleApproveForSession = useCallback(async () => {
    if (!onApproveForSession) return;
    setSubmitting(true);
    try {
      await onApproveForSession();
    } finally {
      setSubmitting(false);
    }
  }, [onApproveForSession]);

  const handleApproveAlways = useCallback(async () => {
    if (!onApproveAlways) return;
    setSubmitting(true);
    try {
      await onApproveAlways();
    } finally {
      setSubmitting(false);
    }
  }, [onApproveAlways]);

  const handleApproveStrictAutoReview = useCallback(async () => {
    if (!onApproveStrictAutoReview) return;
    setSubmitting(true);
    try {
      await onApproveStrictAutoReview();
    } finally {
      setSubmitting(false);
    }
  }, [onApproveStrictAutoReview]);

  const handleDeny = useCallback(async () => {
    setSubmitting(true);
    try {
      await onDeny();
    } finally {
      setSubmitting(false);
    }
  }, [onDeny]);

  const handleDenyWithFeedback = useCallback(async () => {
    if (!onDenyWithFeedback || !feedback.trim()) return;
    setSubmitting(true);
    try {
      await onDenyWithFeedback(feedback.trim());
      // Clear feedback draft from localStorage on successful submit
      clearFeedback();
      setShowFeedback(false);
    } finally {
      setSubmitting(false);
    }
  }, [onDenyWithFeedback, feedback, clearFeedback]);

  const handlePersistentApproval = usesProviderPersistentApproval
    ? approvalPersistence?.response === "approve_always"
      ? handleApproveAlways
      : handleApproveForSession
    : handleApproveAcceptEdits;
  const hasPersistentApprovalHandler = usesProviderPersistentApproval
    ? approvalPersistence?.response === "approve_always"
      ? Boolean(onApproveAlways)
      : Boolean(onApproveForSession)
    : Boolean(onApproveAcceptEdits);

  // Focus feedback input when shown
  useEffect(() => {
    if (showFeedback && feedbackInputRef.current) {
      feedbackInputRef.current.focus();
    }
  }, [showFeedback]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (submitting || !armed) return;

      // Don't handle shortcuts when typing in feedback
      if (showFeedback) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShowFeedback(false);
          clearFeedback();
        } else if (e.key === "Enter" && feedback.trim()) {
          e.preventDefault();
          handleDenyWithFeedback();
        }
        return;
      }

      const isPlanMode = isExitPlanMode(request.toolName);

      if (isPermissionsApproval) {
        if (e.key === "1") {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "2" && onApproveStrictAutoReview) {
          e.preventDefault();
          handleApproveStrictAutoReview();
        } else if (e.key === "3" && onApproveForSession) {
          e.preventDefault();
          handleApproveForSession();
        } else if (e.key === "4" || e.key === "Escape") {
          e.preventDefault();
          handleDeny();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleApprove();
        }
      } else if (isScopedMcpApproval) {
        if (e.key === "1") {
          e.preventDefault();
          handleApprove();
        } else if (
          e.key === "2" &&
          canApproveMcpForSession &&
          onApproveForSession
        ) {
          e.preventDefault();
          handleApproveForSession();
        } else if (e.key === "3" && canApproveMcpAlways && onApproveAlways) {
          e.preventDefault();
          handleApproveAlways();
        } else if (e.key === "4" || e.key === "Escape") {
          e.preventDefault();
          handleDeny();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleApprove();
        }
      } else if (isPlanMode) {
        if (preserveModeOnPlanApproval) {
          if (e.key === "1" || (e.key === "Enter" && !e.shiftKey)) {
            e.preventDefault();
            handleApprove();
          } else if (e.key === "2" || e.key === "Escape") {
            e.preventDefault();
            handleDeny();
          }
          return;
        }
        // ExitPlanMode: 1=auto-accept, 2=manual, 3=deny
        if (e.key === "1" && onApproveAcceptEdits) {
          e.preventDefault();
          handleApproveAcceptEdits();
        } else if (e.key === "2") {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "3") {
          e.preventDefault();
          handleDeny();
        } else if (e.key === "Enter" && !e.shiftKey && onApproveAcceptEdits) {
          e.preventDefault();
          handleApproveAcceptEdits();
        } else if (e.key === "Escape") {
          e.preventDefault();
          handleDeny();
        }
      } else {
        // Standard tool approval: 1=yes, 2=yes+persistent, 2/3=no
        if (e.key === "1") {
          e.preventDefault();
          handleApprove();
        } else if (
          e.key === "2" &&
          canApprovePersistently &&
          hasPersistentApprovalHandler
        ) {
          e.preventDefault();
          handlePersistentApproval();
        } else if (
          e.key === "3" ||
          (e.key === "2" &&
            (!canApprovePersistently || !hasPersistentApprovalHandler))
        ) {
          e.preventDefault();
          handleDeny();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "Escape") {
          e.preventDefault();
          handleDeny();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleApprove,
    handleApproveAcceptEdits,
    handleApproveAlways,
    handleApproveForSession,
    handleApproveStrictAutoReview,
    handlePersistentApproval,
    handleDeny,
    handleDenyWithFeedback,
    submitting,
    armed,
    showFeedback,
    feedback,
    clearFeedback,
    canApprovePersistently,
    canApproveMcpAlways,
    canApproveMcpForSession,
    hasPersistentApprovalHandler,
    isPermissionsApproval,
    isScopedMcpApproval,
    onApproveAlways,
    onApproveAcceptEdits,
    onApproveForSession,
    onApproveStrictAutoReview,
    preserveModeOnPlanApproval,
    request.toolName,
  ]);

  const displayToolName = request.toolName;
  const summary = request.toolName
    ? getToolSummary(request.toolName, request.toolInput, undefined, "pending")
    : request.prompt;
  const approvalPrompt = getApprovalPrompt(request);
  const approvalAction = getApprovalAction(request);

  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Only show "View details" when the approval summary text itself is too
  // long to display inline. The full tool details (diffs, etc.) are already
  // visible in the session stream above.
  const summaryText =
    approvalPrompt ?? `Allow ${displayToolName ?? ""} ${summary ?? ""}?`;
  const showViewDetails = summaryText.length > 120;

  const renderContext: RenderContext = useMemo(
    () => ({
      isStreaming: true,
      theme: "dark",
      toolUseId: request.id,
    }),
    [request.id],
  );

  return (
    <div className="tool-approval-wrapper">
      {/* Floating toggle button */}
      <button
        type="button"
        className={`tool-approval-toggle ${collapsed ? "has-pending" : ""}`}
        onClick={() => onCollapsedChange?.(!collapsed)}
        aria-label={
          collapsed ? t("toolApprovalExpand") : t("toolApprovalCollapse")
        }
        aria-expanded={!collapsed}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={collapsed ? "chevron-up" : "chevron-down"}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {!collapsed && (
        <div className="tool-approval-panel">
          <div className="tool-approval-header">
            {subagentOriginTitle && (
              <span className="tool-approval-subagent-origin">
                {t("subagentApprovalOrigin", { title: subagentOriginTitle })}
              </span>
            )}
            {isExitPlanMode(request.toolName) ? (
              <>
                <span className="tool-approval-title">
                  {t("toolApprovalPlanTitle")}
                </span>
                <span className="tool-approval-subtitle">
                  {t("toolApprovalPlanSubtitle")}
                </span>
              </>
            ) : (
              <>
                <div className="tool-approval-question-row">
                  <span className="tool-approval-question">
                    {approvalPrompt ??
                      t("toolApprovalAllow", {
                        tool: displayToolName ?? "",
                        summary: summary ?? "",
                      })}
                  </span>
                  {showViewDetails && (
                    <button
                      type="button"
                      className="tool-approval-view-details"
                      onClick={() => setShowPreviewModal(true)}
                    >
                      {t("toolApprovalViewDetails")}
                    </button>
                  )}
                </div>
                {approvalAction && (
                  <a
                    className="tool-approval-action-link"
                    href={approvalAction.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {approvalAction.label}
                  </a>
                )}
                {showPreviewModal && request.toolName && (
                  <Modal
                    title={t("toolApprovalDetailsTitle", {
                      tool: request.toolName,
                    })}
                    onClose={() => setShowPreviewModal(false)}
                  >
                    <div className="tool-use-expanded">
                      {toolRegistry.renderToolUse(
                        request.toolName,
                        request.toolInput,
                        renderContext,
                      )}
                    </div>
                  </Modal>
                )}
              </>
            )}
          </div>

          <div className="tool-approval-options">
            {isPermissionsApproval ? (
              <>
                <button
                  type="button"
                  className="tool-approval-option primary"
                  onClick={handleApprove}
                  disabled={!armed || submitting}
                >
                  <kbd>1</kbd>
                  <span>{t("toolApprovalGrantForTurn")}</span>
                </button>

                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleApproveStrictAutoReview}
                  disabled={!armed || submitting || !onApproveStrictAutoReview}
                >
                  <kbd>2</kbd>
                  <span>{t("toolApprovalGrantWithReview")}</span>
                </button>

                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleApproveForSession}
                  disabled={!armed || submitting || !onApproveForSession}
                >
                  <kbd>3</kbd>
                  <span>{t("toolApprovalGrantForSession")}</span>
                </button>

                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleDeny}
                  disabled={!armed || submitting}
                >
                  <kbd>4</kbd>
                  <span>{t("toolApprovalContinueWithoutPermissions")}</span>
                </button>
              </>
            ) : isScopedMcpApproval ? (
              <>
                <button
                  type="button"
                  className="tool-approval-option primary"
                  onClick={handleApprove}
                  disabled={!armed || submitting}
                >
                  <kbd>1</kbd>
                  <span>{t("toolApprovalAllowOnce")}</span>
                </button>

                {canApproveMcpForSession && onApproveForSession && (
                  <button
                    type="button"
                    className="tool-approval-option"
                    onClick={handleApproveForSession}
                    disabled={!armed || submitting}
                  >
                    <kbd>2</kbd>
                    <span>{t("toolApprovalAllowForSession")}</span>
                  </button>
                )}

                {canApproveMcpAlways && onApproveAlways && (
                  <button
                    type="button"
                    className="tool-approval-option"
                    onClick={handleApproveAlways}
                    disabled={!armed || submitting}
                  >
                    <kbd>3</kbd>
                    <span>{t("toolApprovalAlwaysAllow")}</span>
                  </button>
                )}

                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleDeny}
                  disabled={!armed || submitting}
                >
                  <kbd>4</kbd>
                  <span>{t("toolApprovalCancel")}</span>
                </button>
              </>
            ) : isExitPlanMode(request.toolName) &&
              preserveModeOnPlanApproval ? (
              <>
                <button
                  type="button"
                  className="tool-approval-option primary"
                  onClick={handleApprove}
                  disabled={!armed || submitting}
                >
                  <kbd>1</kbd>
                  <span>{t("toolApprovalApproveKeepMode")}</span>
                </button>
                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleDeny}
                  disabled={!armed || submitting}
                >
                  <kbd>2</kbd>
                  <span>{t("toolApprovalNoKeepPlanning")}</span>
                </button>
              </>
            ) : isExitPlanMode(request.toolName) ? (
              <>
                <button
                  type="button"
                  className="tool-approval-option primary"
                  onClick={handleApproveAcceptEdits}
                  disabled={!armed || submitting || !onApproveAcceptEdits}
                >
                  <kbd>1</kbd>
                  <span>{t("toolApprovalYesAuto")}</span>
                </button>
                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleApprove}
                  disabled={!armed || submitting}
                >
                  <kbd>2</kbd>
                  <span>{t("toolApprovalYesManual")}</span>
                </button>
                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleDeny}
                  disabled={!armed || submitting}
                >
                  <kbd>3</kbd>
                  <span>{t("toolApprovalNoKeepPlanning")}</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="tool-approval-option primary"
                  onClick={handleApprove}
                  disabled={!armed || submitting}
                >
                  <kbd>1</kbd>
                  <span>{t("toolApprovalYes")}</span>
                </button>

                {canApprovePersistently && hasPersistentApprovalHandler && (
                  <button
                    type="button"
                    className="tool-approval-option"
                    onClick={handlePersistentApproval}
                    disabled={!armed || submitting}
                  >
                    <kbd>2</kbd>
                    <span>
                      {usesProviderPersistentApproval
                        ? approvalPersistence?.kind === "command-policy"
                          ? t("toolApprovalApplyCommandPolicy")
                          : approvalPersistence?.kind === "network-policy"
                            ? t("toolApprovalApplyNetworkPolicy")
                            : t("toolApprovalAllowForSession")
                        : t("toolApprovalYesDontAsk")}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleDeny}
                  disabled={!armed || submitting}
                >
                  <kbd>
                    {canApprovePersistently && hasPersistentApprovalHandler
                      ? "3"
                      : "2"}
                  </kbd>
                  <span>{t("toolApprovalNo")}</span>
                </button>
              </>
            )}

            {canDenyWithFeedback && !showFeedback && (
              <button
                type="button"
                className="tool-approval-option feedback-toggle"
                onClick={() => setShowFeedback(true)}
                disabled={!armed || submitting}
              >
                <span>
                  {t("toolApprovalTellInstead", { agent: agentName })}
                </span>
              </button>
            )}

            {canDenyWithFeedback && showFeedback && (
              <div className="tool-approval-feedback">
                <input
                  ref={feedbackInputRef}
                  type="text"
                  placeholder={t("toolApprovalFeedbackPlaceholder", {
                    agent: agentName,
                  })}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  disabled={!armed || submitting}
                  className="tool-approval-feedback-input"
                />
                <button
                  type="button"
                  className="tool-approval-feedback-submit"
                  onClick={handleDenyWithFeedback}
                  disabled={!armed || submitting || !feedback.trim()}
                >
                  {t("toolApprovalSend")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
