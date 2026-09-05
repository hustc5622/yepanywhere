import type { ProviderName, UploadedFile } from "@yep-anywhere/shared";
import { type RefObject, useState } from "react";
import { useModelSettings } from "../hooks/useModelSettings";
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
  provider?: ProviderName;
  permissionModes?: readonly PermissionMode[];

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
  supportsThinkingToggle = true,
  provider,
  permissionModes,
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
  const { thinkingMode, cycleThinkingMode, thinkingLevel } = useModelSettings();
  const [isContextModalOpen, setIsContextModalOpen] = useState(false);
  const showStop = isRunning && onStop && isThinking;
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
    <div
      className={`message-input-toolbar${onQueue ? " message-input-toolbar-send-options" : ""}`}
    >
      <div className="message-input-left">
        {onModeChange && supportsPermissionMode && (
          <ModeSelector
            mode={mode}
            onModeChange={onModeChange}
            isHeld={isHeld}
            onHoldChange={onHoldChange}
            provider={provider}
            permissionModes={permissionModes}
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
        {supportsThinkingToggle && (
          <button
            type="button"
            className={`thinking-toggle-button ${thinkingMode !== "off" ? `active ${thinkingMode}` : ""}`}
            onClick={cycleThinkingMode}
            title={
              thinkingMode === "off"
                ? t("newSessionThinkingOff")
                : thinkingMode === "auto"
                  ? t("newSessionThinkingAuto")
                  : t("newSessionThinkingOn", { level: thinkingLevel })
            }
            aria-label={t("newSessionThinkingMode", { mode: thinkingMode })}
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
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
              {thinkingMode === "auto" && (
                <g>
                  <circle
                    cx="19"
                    cy="5"
                    r="5.5"
                    fill="currentColor"
                    stroke="none"
                  />
                  <text
                    x="19"
                    y="5"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="var(--bg-primary, #1a1a2e)"
                    fontSize="8"
                    fontWeight="700"
                    fontFamily="system-ui, sans-serif"
                    stroke="none"
                  >
                    A
                  </text>
                </g>
              )}
            </svg>
          </button>
        )}
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
          labelMode="tokens"
          onClick={
            projectId && sessionId
              ? () => setIsContextModalOpen(true)
              : undefined
          }
          ariaLabel={t("contextBreakdownTitle")}
        />
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
        {onSend && (onQueue || !showStop || canSend) && (
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !canSend}
            className={`send-button${onQueue ? " message-submit-choice" : ""}`}
            title={onQueue ? t("toolbarInsertTitle") : undefined}
            aria-label={onQueue ? t("toolbarInsertLabel") : t("toolbarSend")}
          >
            <span className="send-icon" aria-hidden="true">
              ↑
            </span>
            {onQueue && <span>{t("toolbarInsertLabel")}</span>}
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
