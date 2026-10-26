import type {
  ContextUsage,
  PermissionMode,
  ProviderName,
  SessionDisplayActivity,
  UploadedFile,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { type ComponentProps, memo } from "react";
import { api } from "../api/client";
import { MessageInput, type UploadProgress } from "../components/MessageInput";
import { MessageInputToolbar } from "../components/MessageInputToolbar";
import { MessageList } from "../components/MessageList";
import { QuestionAnswerPanel } from "../components/QuestionAnswerPanel";
import { SideConversationButton } from "../components/SideConversationButton";
import { SessionMessagesSkeleton } from "../components/Skeleton";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import { ProjectedToolStepRow } from "../components/blocks/ProjectedToolGroupRow";
import { AgentContentProvider } from "../contexts/AgentContentContext";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import type { DraftControls } from "../hooks/useDraftPersistence";
import type {
  AgentContentMap,
  ProcessState,
  SessionTurnHealth,
} from "../hooks/useSession";
import { useI18n } from "../i18n";
import type { AgentCommandConfig } from "../lib/agentCommands";
import type { InputRequest, SessionStatus } from "../types";

type AgentContentProps = ComponentProps<typeof AgentContentProvider>;
type TranscriptListProps = ComponentProps<typeof MessageList>;

/**
 * Transcript subtree. It re-renders with the stream so the turn timer and
 * message list stay live. It is a sibling of the composer so those updates
 * do not have to render the input.
 */
export const SessionTranscript = memo(function SessionTranscript({
  loading,
  projectId,
  projectPath,
  sessionId,
  actualSessionId,
  provider,
  messages,
  renderItems,
  isProcessing,
  lastActivityAt,
  isCompacting,
  scrollTrigger,
  pendingMessages,
  deferredMessages,
  markdownAugments,
  activeToolApproval,
  hasOlderMessages,
  hasNewerMessages,
  loadingOlder,
  loadingNewer,
  loadingTargetMessage,
  onLoadOlderMessages,
  onLoadNewerMessages,
  onLoadTargetMessage,
  onFollowingBottomChange,
  onEditUserPrompt,
  onSelectBranch,
  focusBranchId,
  onBranchFocused,
  targetMessageId,
  onTargetFocused,
  transcriptKey,
  agentContent,
  setAgentContent,
  toolUseToAgent,
  toolUseToAgentIds,
  displayActivity,
  displayRevision,
  sessionUpdatesConnected,
  selectedBranchId,
}: {
  loading: boolean;
  projectId: string;
  projectPath: string | null;
  sessionId: string;
  actualSessionId: string;
  provider?: string;
  messages: TranscriptListProps["messages"];
  renderItems: TranscriptListProps["preprocessedItems"];
  isProcessing: boolean;
  lastActivityAt: string | null;
  isCompacting: boolean;
  scrollTrigger: number;
  pendingMessages: TranscriptListProps["pendingMessages"];
  deferredMessages: TranscriptListProps["deferredMessages"];
  markdownAugments: TranscriptListProps["markdownAugments"];
  activeToolApproval: TranscriptListProps["activeToolApproval"];
  hasOlderMessages?: boolean;
  hasNewerMessages?: boolean;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  loadingTargetMessage?: boolean;
  onLoadOlderMessages: TranscriptListProps["onLoadOlderMessages"];
  onLoadNewerMessages: TranscriptListProps["onLoadNewerMessages"];
  onLoadTargetMessage: TranscriptListProps["onLoadTargetMessage"];
  onFollowingBottomChange: TranscriptListProps["onFollowingBottomChange"];
  onEditUserPrompt: TranscriptListProps["onEditUserPrompt"];
  onSelectBranch: TranscriptListProps["onSelectBranch"];
  focusBranchId: TranscriptListProps["focusBranchId"];
  onBranchFocused: TranscriptListProps["onBranchFocused"];
  targetMessageId: TranscriptListProps["targetMessageId"];
  onTargetFocused: TranscriptListProps["onTargetFocused"];
  transcriptKey: string;
  agentContent: AgentContentMap;
  setAgentContent: AgentContentProps["setAgentContent"];
  toolUseToAgent: Map<string, string>;
  toolUseToAgentIds?: Map<string, string[]>;
  displayActivity: SessionDisplayActivity | null | undefined;
  displayRevision?: string;
  sessionUpdatesConnected: boolean;
  selectedBranchId?: string | null;
}) {
  const { t } = useI18n();
  return (
    <main className="session-messages">
      {loading ? (
        <SessionMessagesSkeleton />
      ) : (
        <SessionMetadataProvider
          projectId={projectId}
          projectPath={projectPath}
          sessionId={actualSessionId}
        >
          <AgentContentProvider
            agentContent={agentContent}
            setAgentContent={setAgentContent}
            toolUseToAgent={toolUseToAgent}
            toolUseToAgentIds={toolUseToAgentIds}
            projectId={projectId}
            sessionId={sessionId}
          >
            <>
              <MessageList
                messages={messages}
                preprocessedItems={renderItems}
                provider={provider}
                isProcessing={isProcessing}
                lastActivityAt={lastActivityAt}
                isCompacting={isCompacting}
                scrollTrigger={scrollTrigger}
                pendingMessages={pendingMessages}
                deferredMessages={deferredMessages}
                onCancelDeferred={(tempId) =>
                  api.cancelDeferredMessage(sessionId, tempId)
                }
                markdownAugments={markdownAugments}
                activeToolApproval={activeToolApproval}
                hasOlderMessages={hasOlderMessages}
                hasNewerMessages={hasNewerMessages}
                loadingOlder={loadingOlder}
                loadingNewer={loadingNewer}
                loadingTargetMessage={loadingTargetMessage}
                onLoadOlderMessages={onLoadOlderMessages}
                onLoadNewerMessages={onLoadNewerMessages}
                onLoadTargetMessage={onLoadTargetMessage}
                onFollowingBottomChange={onFollowingBottomChange}
                onEditUserPrompt={onEditUserPrompt}
                onSelectBranch={onSelectBranch}
                focusBranchId={focusBranchId}
                onBranchFocused={onBranchFocused}
                targetMessageId={targetMessageId}
                onTargetFocused={onTargetFocused}
                transcriptKey={transcriptKey}
              />
              {displayActivity && (
                <div className="display-tool-group-state" role="status">
                  {!sessionUpdatesConnected
                    ? t("sessionDisplaySyncing")
                    : displayActivity.state === "finishing"
                      ? t("sessionDisplayFinishing")
                      : displayActivity.state === "interrupted"
                        ? t("sessionDisplayInterrupted")
                        : displayActivity.state === "failed"
                          ? t("sessionDisplayFailed")
                          : displayActivity.state === "unknown" &&
                              displayActivity.runningCount > 0
                            ? t("sessionDisplayUnknown")
                            : null}
                </div>
              )}
              {displayActivity && displayActivity.tools.length > 0 && (
                <div className="display-current-activity">
                  <div className="display-tool-group-state">
                    {t("sessionDisplayPreviousTools")}
                  </div>
                  {displayActivity.tools.map((step) => (
                    <ProjectedToolStepRow
                      key={`${displayRevision}:${step.id}`}
                      step={step}
                      projectId={projectId}
                      sessionId={sessionId}
                      branchId={selectedBranchId ?? undefined}
                      sessionProvider={provider}
                    />
                  ))}
                </div>
              )}
            </>
          </AgentContentProvider>
        </SessionMetadataProvider>
      )}
    </main>
  );
});

/**
 * Composer subtree. Props stay stable across token deltas, so memo skips
 * re-rendering the input while the transcript updates.
 */
export const SessionComposer = memo(function SessionComposer({
  sessionConnectionStatus,
  pendingInputRequest,
  actualSessionId,
  sessionId,
  projectId,
  isAskUserQuestion,
  isPersistedInputRequest,
  hasSideConversation,
  sideVisible,
  openSideConversation,
  approvalAgentName,
  provider,
  approvalCollapsed,
  setApprovalCollapsed,
  permissionMode,
  setPermissionMode,
  holdModeEnabled,
  isHeld,
  setHold,
  supportsPermissionMode,
  permissionModes,
  supportsThinkingToggle,
  contextUsage,
  status,
  processState,
  onAbort,
  turnHealth,
  retryActionLink,
  isRestoringEdit,
  onCancelEdit,
  historyRewritePending,
  onSend,
  onQueue,
  editRewindActive,
  attachments,
  onAttach,
  onRemoveAttachment,
  onRestoreAttachment,
  attachmentOrder,
  uploadProgress,
  commandPrefix,
  commandLabel,
  commands,
  showCommandButton,
  commandButtons,
  onCustomCommand,
  onDraftControlsReady,
  onQuestionSubmit,
  onDeny,
  onApprove,
  onApproveAcceptEdits,
  onApproveForSession,
  onApproveStrictAutoReview,
  onApproveAlways,
  onDenyWithFeedback,
}: {
  sessionConnectionStatus: string;
  pendingInputRequest: InputRequest | null;
  actualSessionId: string;
  sessionId: string;
  projectId: string;
  isAskUserQuestion: boolean;
  isPersistedInputRequest: boolean;
  hasSideConversation: boolean;
  sideVisible: boolean;
  openSideConversation: () => void;
  approvalAgentName?: string;
  provider?: ProviderName;
  approvalCollapsed: boolean;
  setApprovalCollapsed: (collapsed: boolean) => void;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  holdModeEnabled: boolean;
  isHeld: boolean;
  setHold: (held: boolean) => void;
  supportsPermissionMode: boolean;
  permissionModes: readonly PermissionMode[];
  supportsThinkingToggle: boolean;
  contextUsage?: ContextUsage;
  status: SessionStatus;
  processState: ProcessState;
  onAbort: () => void;
  turnHealth: SessionTurnHealth | null;
  retryActionLink?: string | null;
  isRestoringEdit: boolean;
  onCancelEdit: () => void;
  historyRewritePending: boolean;
  onSend: (text: string, interruptBeforeSend?: boolean) => void;
  onQueue: (text: string) => void;
  editRewindActive: boolean;
  attachments: UploadedFile[];
  onAttach?: (files: File[], beforeAttachmentId?: string) => void;
  onRemoveAttachment: (id: string) => void;
  onRestoreAttachment: (file: UploadedFile) => void;
  attachmentOrder: string[];
  uploadProgress: UploadProgress[];
  commandPrefix?: ComponentProps<typeof MessageInput>["commandPrefix"];
  commandLabel?: ComponentProps<typeof MessageInput>["commandLabel"];
  commands: string[];
  showCommandButton: boolean;
  commandButtons: AgentCommandConfig[];
  onCustomCommand?: (command: string) => boolean;
  onDraftControlsReady?: (controls: DraftControls) => void;
  onQuestionSubmit: (answers: UserQuestionAnswers) => Promise<void>;
  onDeny: () => Promise<void>;
  onApprove: () => Promise<void>;
  onApproveAcceptEdits: () => Promise<void>;
  onApproveForSession: () => Promise<void>;
  onApproveStrictAutoReview: () => Promise<void>;
  onApproveAlways: () => Promise<void>;
  onDenyWithFeedback: (feedback: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const approvalVisible =
    pendingInputRequest?.sessionId === actualSessionId && !isAskUserQuestion;
  const questionVisible =
    pendingInputRequest?.sessionId === actualSessionId && isAskUserQuestion;
  const canInterrupt =
    provider === "codex" &&
    status.owner === "self" &&
    processState === "in-turn" &&
    !editRewindActive;
  const canQueue =
    !editRewindActive && status.owner !== "none" && processState !== "idle";
  const placeholder =
    status.owner === "external"
      ? t("sessionPlaceholderExternal")
      : processState === "idle"
        ? t("sessionPlaceholderResume")
        : t("sessionPlaceholderQueue");

  return (
    <footer className="session-input">
      <div
        className={`session-connection-bar session-connection-${sessionConnectionStatus}`}
      />
      <div className="session-input-inner">
        {pendingInputRequest && questionVisible && (
          <QuestionAnswerPanel
            key={pendingInputRequest.id}
            request={pendingInputRequest}
            sessionId={actualSessionId}
            onSubmit={onQuestionSubmit}
            onDeny={onDeny}
            readOnly={isPersistedInputRequest}
          />
        )}

        {hasSideConversation &&
          isAskUserQuestion &&
          pendingInputRequest?.sessionId === actualSessionId && (
            <div className="side-conversation-question-entry">
              <SideConversationButton
                onClick={openSideConversation}
                expanded={sideVisible}
              />
            </div>
          )}

        {pendingInputRequest && approvalVisible && (
          <>
            <ToolApprovalPanel
              request={pendingInputRequest}
              sessionId={actualSessionId}
              agentName={approvalAgentName}
              onApprove={onApprove}
              onDeny={onDeny}
              onApproveAcceptEdits={onApproveAcceptEdits}
              onApproveForSession={onApproveForSession}
              onApproveStrictAutoReview={onApproveStrictAutoReview}
              onApproveAlways={onApproveAlways}
              onDenyWithFeedback={onDenyWithFeedback}
              collapsed={approvalCollapsed}
              onCollapsedChange={setApprovalCollapsed}
            />
            <MessageInputToolbar
              mode={permissionMode}
              onModeChange={setPermissionMode}
              isHeld={holdModeEnabled ? isHeld : undefined}
              onHoldChange={holdModeEnabled ? setHold : undefined}
              supportsPermissionMode={supportsPermissionMode}
              provider={provider}
              permissionModes={permissionModes}
              supportsThinkingToggle={supportsThinkingToggle}
              contextUsage={contextUsage}
              projectId={projectId}
              sessionId={actualSessionId}
              isRunning={status.owner === "self"}
              isThinking={processState === "in-turn"}
              onStop={onAbort}
              onOpenSideConversation={
                hasSideConversation ? openSideConversation : undefined
              }
              sideConversationOpen={sideVisible}
              pendingApproval={
                approvalCollapsed
                  ? {
                      type: "tool-approval",
                      onExpand: () => setApprovalCollapsed(false),
                    }
                  : undefined
              }
            />
          </>
        )}

        {turnHealth?.retryStatus && processState === "in-turn" && (
          <div
            className="turn-health-banner turn-health-banner-retry"
            data-testid="turn-health-retry"
          >
            <span className="turn-health-banner-text">
              {typeof turnHealth.retryStatus.attempt === "number" &&
              turnHealth.retryStatus.attempt > 0
                ? t("statusBadgeRetryingAttempt", {
                    attempt: String(turnHealth.retryStatus.attempt),
                  })
                : t("statusBadgeRetrying")}
              {turnHealth.retryStatus.message
                ? ` — ${turnHealth.retryStatus.message}`
                : ""}
            </span>
            {retryActionLink && (
              <a
                className="turn-health-banner-action"
                href={retryActionLink}
                target="_blank"
                rel="noreferrer"
              >
                {turnHealth.retryStatus.actionLabel ?? retryActionLink}
              </a>
            )}
          </div>
        )}
        {turnHealth?.lastErrorMessage &&
          turnHealth.lastTurnStatus === "failed" &&
          processState === "idle" && (
            <div
              className="turn-health-banner turn-health-banner-error"
              data-testid="turn-health-error"
            >
              <span className="turn-health-banner-text">
                {t("statusBadgeFailed")}: {turnHealth.lastErrorMessage}
              </span>
            </div>
          )}

        {(editRewindActive || isRestoringEdit) && (
          <div className="edit-rewind-banner" data-testid="edit-rewind-banner">
            <span className="edit-rewind-banner-text">
              {isRestoringEdit
                ? t("sessionRestoringEditAttachments")
                : t("sessionEditingFromHere")}
            </span>
            <button
              type="button"
              className="edit-rewind-banner-cancel"
              onClick={onCancelEdit}
            >
              {t("actionCancel")}
            </button>
          </div>
        )}

        {historyRewritePending && !editRewindActive && (
          <div
            className="session-branch-sync-banner"
            data-testid="branch-sync-banner"
            role="status"
            aria-live="polite"
          >
            <span className="session-branch-sync-spinner" aria-hidden="true" />
            <span className="session-branch-sync-text">
              {t("sessionSyncingBranch")}
            </span>
          </div>
        )}

        <div
          hidden={!!approvalVisible && !editRewindActive && !isRestoringEdit}
        >
          <MessageInput
            disabled={isRestoringEdit}
            onSend={onSend}
            onInterruptSend={
              canInterrupt ? (text) => onSend(text, true) : undefined
            }
            onQueue={canQueue ? onQueue : undefined}
            placeholder={placeholder}
            mode={permissionMode}
            onModeChange={setPermissionMode}
            isHeld={holdModeEnabled ? isHeld : undefined}
            onHoldChange={holdModeEnabled ? setHold : undefined}
            supportsPermissionMode={supportsPermissionMode}
            provider={provider}
            permissionModes={permissionModes}
            supportsThinkingToggle={supportsThinkingToggle}
            isRunning={status.owner === "self"}
            isThinking={processState === "in-turn"}
            onStop={onAbort}
            onOpenSideConversation={
              hasSideConversation ? openSideConversation : undefined
            }
            sideConversationOpen={sideVisible}
            draftKey={`draft-message-${sessionId}`}
            onDraftControlsReady={onDraftControlsReady}
            collapsed={
              !editRewindActive &&
              !isRestoringEdit &&
              pendingInputRequest?.sessionId === actualSessionId
            }
            contextUsage={contextUsage}
            projectId={projectId}
            sessionId={sessionId}
            attachments={attachments}
            onAttach={onAttach}
            onRemoveAttachment={onRemoveAttachment}
            onRestoreAttachment={onRestoreAttachment}
            attachmentOrder={attachmentOrder}
            uploadProgress={uploadProgress}
            commandPrefix={commandPrefix}
            commandLabel={commandLabel}
            commands={commands}
            showCommandButton={showCommandButton}
            commandButtons={commandButtons}
            onCustomCommand={onCustomCommand}
          />
        </div>
      </div>
    </footer>
  );
});
