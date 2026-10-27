import type { ProviderName, UploadedFile } from "@yep-anywhere/shared";
import { type RefObject, useState } from "react";
import { useModelSettings } from "../hooks/useModelSettings";
import { useI18n } from "../i18n";
import type { AgentCommandConfig } from "../lib/agentCommands";
import type { ClipboardUserInputCopyResult } from "../lib/clipboard";
import type { ContextUsage, PermissionMode } from "../types";
import { ComposerToolbar } from "./ComposerToolbar";
import { ContextStatusModal } from "./ContextStatusModal";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { ModeSelector } from "./ModeSelector";
import { SideConversationButton } from "./SideConversationButton";
import { ThinkingToggleButton } from "./ThinkingToggleButton";
import type { VoiceInputButtonRef } from "./VoiceInputButton";

export interface MessageInputToolbarProps {
  // Mode selector
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  isHeld?: boolean;
  onHoldChange?: (held: boolean) => void;

  // Provider capability flags (default to true for backwards compatibility)
  supportsPermissionMode?: boolean;
  supportsThinkingToggle?: boolean;
  provider?: ProviderName;
  permissionModes?: readonly PermissionMode[];

  // Attachments
  canAttach?: boolean;
  attachmentCount?: number;
  onAttachClick?: () => void;
  /** Copy the whole draft, attachments included. */
  onCopyInput?: () => Promise<ClipboardUserInputCopyResult>;
  canCopy?: boolean;

  // Voice input
  voiceButtonRef?: RefObject<VoiceInputButtonRef | null>;
  onVoiceTranscript?: (transcript: string) => void;
  onInterimTranscript?: (transcript: string) => void;
  onListeningStart?: () => void;
  voiceDisabled?: boolean;

  // Agent commands
  commandPrefix?: "/" | "$";
  commandLabel?: string;
  commands?: string[];
  showCommandButton?: boolean;
  commandButtons?: AgentCommandConfig[];
  onSelectCommand?: (command: string) => void;

  // Context usage
  contextUsage?: ContextUsage;
  /** When provided, the ContextUsageIndicator becomes clickable and opens
   *  the context status modal. */
  projectId?: string;
  sessionId?: string;

  // Actions
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  onSend?: () => void;
  onInterruptSend?: () => void;
  /** Queue a deferred message. Only provided when agent is running. */
  onQueue?: () => void;
  onOpenSideConversation?: () => void;
  sideConversationOpen?: boolean;
  canSend?: boolean;
  disabled?: boolean;

  // Pending approval indicator
  pendingApproval?: {
    type: "tool-approval" | "user-question";
    onExpand: () => void;
  };
}

export function MessageInputToolbar({
  mode = "default",
  onModeChange,
  isHeld,
  onHoldChange,
  supportsPermissionMode = true,
  supportsThinkingToggle = true,
  provider,
  permissionModes,
  canAttach,
  attachmentCount = 0,
  onAttachClick,
  onCopyInput,
  canCopy,
  voiceButtonRef,
  onVoiceTranscript,
  onInterimTranscript,
  onListeningStart,
  voiceDisabled,
  commandPrefix = "/",
  commandLabel = "Commands",
  commands = [],
  showCommandButton = commands.length > 0,
  commandButtons,
  onSelectCommand,
  contextUsage,
  projectId,
  sessionId,
  isRunning,
  isThinking,
  onStop,
  onSend,
  onInterruptSend,
  onQueue,
  onOpenSideConversation,
  sideConversationOpen,
  canSend,
  disabled,
  pendingApproval,
}: MessageInputToolbarProps) {
  const { t } = useI18n();
  const { thinkingMode, cycleThinkingMode, thinkingLevel } = useModelSettings();
  const [isContextModalOpen, setIsContextModalOpen] = useState(false);
  const showStop = isRunning && onStop && isThinking;
  const replyOnSend = provider === "codex";
  const activeSendLabel = t(
    replyOnSend ? "toolbarReplyContinueLabel" : "toolbarInsertLabel",
  );
  const activeSendTitle = t(
    replyOnSend ? "toolbarReplyContinueTitle" : "toolbarInsertTitle",
  );
  const visibleCommandButtons =
    commandButtons?.filter((button) => button.showButton) ??
    (showCommandButton
      ? [
          {
            prefix: commandPrefix,
            label: commandLabel,
            showButton: true,
            commands,
          },
        ]
      : []);

  return (
    <ComposerToolbar
      variant="session"
      className={onQueue ? "message-input-toolbar-send-options" : undefined}
      leading={
        onModeChange && supportsPermissionMode ? (
          <ModeSelector
            mode={mode}
            onModeChange={onModeChange}
            isHeld={isHeld}
            onHoldChange={onHoldChange}
            provider={provider}
            permissionModes={permissionModes}
          />
        ) : undefined
      }
      attach={{
        onClick: () => onAttachClick?.(),
        disabled: !canAttach,
        title: canAttach ? t("toolbarAttachFiles") : t("toolbarAttachDisabled"),
        count: attachmentCount,
      }}
      copy={onCopyInput ? { onCopy: onCopyInput, disabled: !canCopy } : null}
      thinking={
        supportsThinkingToggle ? (
          <ThinkingToggleButton
            mode={thinkingMode}
            levelLabel={thinkingLevel}
            onCycle={cycleThinkingMode}
          />
        ) : undefined
      }
      voice={
        voiceButtonRef && onVoiceTranscript && onInterimTranscript
          ? {
              ref: voiceButtonRef,
              onTranscript: onVoiceTranscript,
              onInterimTranscript,
              onListeningStart,
              disabled: voiceDisabled,
            }
          : null
      }
      commands={
        onSelectCommand
          ? {
              buttons: visibleCommandButtons,
              onSelect: onSelectCommand,
              disabled: voiceDisabled,
            }
          : null
      }
      trailing={
        <>
          {onOpenSideConversation && (
            <SideConversationButton
              onClick={onOpenSideConversation}
              expanded={sideConversationOpen}
            />
          )}
          <ContextUsageIndicator
            usage={contextUsage}
            size={16}
            labelMode="tokens"
            onClick={
              projectId && sessionId
                ? () => setIsContextModalOpen(true)
                : undefined
            }
            ariaLabel={t("contextBreakdownTitle")}
          />
        </>
      }
      actionsClassName="message-input-actions"
      actions={
        <>
          {/* Pending approval indicator */}
          {pendingApproval && (
            <button
              type="button"
              className={`pending-approval-indicator ${pendingApproval.type}`}
              onClick={pendingApproval.onExpand}
              title={
                pendingApproval.type === "tool-approval"
                  ? t("toolbarPendingApprovalExpand")
                  : t("toolbarPendingQuestionExpand")
              }
            >
              <span className="pending-approval-dot" />
              <span className="pending-approval-text">
                {pendingApproval.type === "tool-approval"
                  ? t("toolbarApproval")
                  : t("toolbarQuestion")}
              </span>
            </button>
          )}
          {/* Keep both submission choices visible while the agent is running. */}
          {onQueue && (
            <button
              type="button"
              onClick={onQueue}
              disabled={disabled || !canSend}
              className="queue-button message-submit-choice"
              title={t("toolbarQueueTitle")}
              aria-label={t("toolbarQueueLabel")}
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
                aria-hidden="true"
              >
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
              <span>{t("toolbarQueueLabel")}</span>
            </button>
          )}
          {onInterruptSend && (
            <button
              type="button"
              onClick={onInterruptSend}
              disabled={disabled || !canSend}
              className="queue-button message-submit-choice"
              title={t("toolbarInterruptTitle")}
              aria-label={t("toolbarInterruptLabel")}
            >
              <span className="message-submit-label-full">
                {t("toolbarInterruptLabel")}
              </span>
              <span className="message-submit-label-compact" aria-hidden="true">
                {t("toolbarInterruptCompact")}
              </span>
            </button>
          )}
          {onSend && (onQueue || !showStop || canSend) && (
            <button
              type="button"
              onClick={onSend}
              disabled={disabled || !canSend}
              className={`send-button${onQueue ? " message-submit-choice" : ""}`}
              title={onQueue ? activeSendTitle : undefined}
              aria-label={onQueue ? activeSendLabel : t("toolbarSend")}
            >
              <span className="send-icon" aria-hidden="true">
                ↑
              </span>
              {onQueue && (
                <>
                  <span className="message-submit-label-full">
                    {activeSendLabel}
                  </span>
                  <span
                    className="message-submit-label-compact"
                    aria-hidden="true"
                  >
                    {t(
                      replyOnSend
                        ? "toolbarReplyContinueCompact"
                        : "toolbarInsertCompact",
                    )}
                  </span>
                </>
              )}
            </button>
          )}
          {showStop && (onQueue || !canSend) && (
            <button
              type="button"
              onClick={onStop}
              className="stop-button"
              title={t("toolbarStop")}
              aria-label={t("toolbarStop")}
            >
              <span className="stop-icon" />
            </button>
          )}
        </>
      }
    >
      {isContextModalOpen && projectId && sessionId && (
        <ContextStatusModal
          projectId={projectId}
          sessionId={sessionId}
          onClose={() => setIsContextModalOpen(false)}
        />
      )}
    </ComposerToolbar>
  );
}
