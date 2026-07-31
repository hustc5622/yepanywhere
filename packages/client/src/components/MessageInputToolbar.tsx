import type { UploadedFile } from "@yep-anywhere/shared";
import { type RefObject, useState } from "react";
import { useI18n } from "../i18n";
import type { AgentCommandConfig } from "../lib/agentCommands";
import type { ContextUsage, PermissionMode } from "../types";
import { ContextStatusModal } from "./ContextStatusModal";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { ModeSelector } from "./ModeSelector";
import { SlashCommandButton } from "./SlashCommandButton";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";

export interface MessageInputToolbarProps {
  // Mode selector
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  isHeld?: boolean;
  onHoldChange?: (held: boolean) => void;

  // Provider capability flags (default to true for backwards compatibility)
  supportsPermissionMode?: boolean;
  supportsThinkingToggle?: boolean;

  // Attachments
  canAttach?: boolean;
  attachmentCount?: number;
  onAttachClick?: () => void;

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
  /** Queue a deferred message. Only provided when agent is running. */
  onQueue?: () => void;
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
  canAttach,
  attachmentCount = 0,
  onAttachClick,
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
  onQueue,
  canSend,
  disabled,
  pendingApproval,
}: MessageInputToolbarProps) {
  const { t } = useI18n();
  const [isContextModalOpen, setIsContextModalOpen] = useState(false);
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
    <div className="message-input-toolbar">
      <div className="message-input-left">
        {onModeChange && supportsPermissionMode && (
          <ModeSelector
            mode={mode}
            onModeChange={onModeChange}
            isHeld={isHeld}
            onHoldChange={onHoldChange}
          />
        )}
        <button
          type="button"
          className="attach-button"
          onClick={onAttachClick}
          disabled={!canAttach}
          title={
            canAttach ? t("toolbarAttachFiles") : t("toolbarAttachDisabled")
          }
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          {attachmentCount > 0 && (
            <span className="attach-count">{attachmentCount}</span>
          )}
        </button>
        {voiceButtonRef && onVoiceTranscript && onInterimTranscript && (
          <VoiceInputButton
            ref={voiceButtonRef}
            onTranscript={onVoiceTranscript}
            onInterimTranscript={onInterimTranscript}
            onListeningStart={onListeningStart}
            disabled={voiceDisabled}
          />
        )}
        {onSelectCommand &&
          visibleCommandButtons.map((button) => (
            <SlashCommandButton
              key={button.prefix}
              commands={button.commands}
              onSelectCommand={onSelectCommand}
              disabled={voiceDisabled}
              prefix={button.prefix}
              label={button.label}
            />
          ))}
      </div>
      <div className="message-input-actions">
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
        <ContextUsageIndicator
          usage={contextUsage}
          size={16}
          onClick={
            projectId && sessionId
              ? () => setIsContextModalOpen(true)
              : undefined
          }
          ariaLabel={t("contextBreakdownTitle")}
        />
        {/* Queue button - shown when agent is running and there's content to queue */}
        {onQueue && canSend && (
          <button
            type="button"
            onClick={onQueue}
            className="queue-button"
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
          </button>
        )}
        {/* Show stop button when thinking and nothing to send, otherwise show send */}
        {isRunning && onStop && isThinking && !canSend ? (
          <button
            type="button"
            onClick={onStop}
            className="stop-button"
            aria-label={t("toolbarStop")}
          >
            <span className="stop-icon" />
          </button>
        ) : onSend ? (
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !canSend}
            className="send-button"
            aria-label={t("toolbarSend")}
          >
            <span className="send-icon">↑</span>
          </button>
        ) : null}
      </div>
      {isContextModalOpen && projectId && sessionId && (
        <ContextStatusModal
          projectId={projectId}
          sessionId={sessionId}
          onClose={() => setIsContextModalOpen(false)}
        />
      )}
    </div>
  );
}
