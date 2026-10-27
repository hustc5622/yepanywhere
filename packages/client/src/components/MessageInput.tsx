import type { ProviderName, UploadedFile } from "@yep-anywhere/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useComposer } from "../hooks/useComposer";
import { useConnection } from "../hooks/useConnection";
import {
  type DraftControls,
  useDraftPersistence,
} from "../hooks/useDraftPersistence";
import { useI18n } from "../i18n";
import type { AgentCommandConfig } from "../lib/agentCommands";
import type { ContextUsage, PermissionMode } from "../types";
import type { ComposerAttachment } from "./AttachmentComposer";
import { ComposerEditor } from "./ComposerEditor";
import { MessageInputToolbar } from "./MessageInputToolbar";

/** Progress info for an in-flight upload */
export interface UploadProgress {
  fileId: string;
  fileName: string;
  mimeType?: string;
  bytesUploaded: number;
  totalBytes: number;
  percent: number;
}

type CommandPrefix = "/" | "$";

interface Props {
  onSend: (text: string) => void;
  /** Explicitly interrupt the active turn before sending. */
  onInterruptSend?: (text: string) => void;
  /** Queue a deferred message (sent when agent's turn ends). Only provided when agent is running. */
  onQueue?: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  isHeld?: boolean;
  onHoldChange?: (held: boolean) => void;
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  onOpenSideConversation?: () => void;
  sideConversationOpen?: boolean;
  draftKey: string; // localStorage key for draft persistence
  /** Collapse to single-line but keep visible and focusable (for when approval panel is showing) */
  collapsed?: boolean;
  /** Callback to receive draft controls for success/failure handling */
  onDraftControlsReady?: (controls: DraftControls) => void;
  /** Context usage for displaying usage indicator */
  contextUsage?: ContextUsage;
  /** Project ID for uploads (required to enable attach button) */
  projectId?: string;
  /** Session ID for uploads (required to enable attach button) */
  sessionId?: string;
  /** Completed file attachments */
  attachments?: UploadedFile[];
  /** Selection order, including uploads that have not completed yet. */
  attachmentOrder?: string[];
  /** Callback when user selects files to attach */
  onAttach?: (files: File[], beforeAttachmentId?: string) => void;
  /** Callback when user removes an attachment */
  onRemoveAttachment?: (id: string) => void;
  onRestoreAttachment?: (file: UploadedFile) => void;
  /** Progress info for in-flight uploads */
  uploadProgress?: UploadProgress[];
  /** Whether the provider supports permission modes (default: true) */
  supportsPermissionMode?: boolean;
  /** Provider-native permission modes and labels. */
  provider?: ProviderName;
  permissionModes?: readonly PermissionMode[];
  /** Whether the provider supports thinking toggle (default: true) */
  supportsThinkingToggle?: boolean;
  /** Active command prefix for this provider */
  commandPrefix?: CommandPrefix;
  /** Available commands (without prefix) */
  commands?: string[];
  /** Whether to reserve the command button slot even before commands are ready */
  showCommandButton?: boolean;
  /** Accessible label for the active command menu */
  commandLabel?: string;
  /** Static command buttons to show in the toolbar. */
  commandButtons?: AgentCommandConfig[];
  /** Callback for custom client-side "/" commands (e.g., "model"). Return true if handled. */
  onCustomCommand?: (command: string) => boolean;
  /** A command menu opened (inline or toolbar); a good moment to refresh. */
  onCommandMenuOpen?: () => void;
}

export function MessageInput({
  onSend,
  onInterruptSend,
  onQueue,
  disabled,
  placeholder,
  mode = "default",
  onModeChange,
  isHeld,
  onHoldChange,
  isRunning,
  isThinking,
  onStop,
  onOpenSideConversation,
  sideConversationOpen,
  draftKey,
  collapsed: externalCollapsed,
  onDraftControlsReady,
  contextUsage,
  projectId,
  sessionId,
  attachments = [],
  attachmentOrder,
  onAttach,
  onRemoveAttachment,
  onRestoreAttachment,
  uploadProgress = [],
  supportsPermissionMode = true,
  provider,
  permissionModes,
  supportsThinkingToggle = true,
  commandPrefix = "/",
  commands = [],
  showCommandButton = commands.length > 0,
  commandLabel = "Commands",
  commandButtons,
  onCustomCommand,
  onCommandMenuOpen,
}: Props) {
  const { t } = useI18n();
  const connection = useConnection();
  const [text, setText, controls] = useDraftPersistence(draftKey);
  const removedAttachmentsRef = useRef<{
    key: string;
    files: Map<string, UploadedFile>;
  }>({ key: draftKey, files: new Map() });
  if (removedAttachmentsRef.current.key !== draftKey) {
    removedAttachmentsRef.current = { key: draftKey, files: new Map() };
  }
  const removeDraftAttachment = (id: string) => {
    const file = attachments.find((candidate) => candidate.id === id);
    if (file) removedAttachmentsRef.current.files.set(id, file);
    onRemoveAttachment?.(id);
  };
  // User-controlled collapse state (independent of external collapse from approval panel)
  const [userCollapsed, setUserCollapsed] = useState(false);
  // Panel is collapsed if user collapsed it OR if externally collapsed (approval panel showing)
  const collapsed = userCollapsed || externalCollapsed;

  const canAttach = !!(projectId && sessionId && onAttach);

  const completionConfigs = useMemo<AgentCommandConfig[]>(
    () =>
      commandButtons ?? [
        {
          prefix: commandPrefix,
          label: commandLabel,
          showButton: showCommandButton,
          commands,
        },
      ],
    [commandButtons, commandLabel, commandPrefix, commands, showCommandButton],
  );

  // Provide controls to parent via callback
  useEffect(() => {
    onDraftControlsReady?.(controls);
  }, [controls, onDraftControlsReady]);

  const uploadedComposerAttachments: ComposerAttachment[] = attachments.map(
    (file) => ({
      id: file.id,
      name: file.originalName,
      mimeType: file.mimeType,
      apiPath:
        projectId && sessionId
          ? `/api/projects/${projectId}/sessions/${sessionId}/upload/${encodeURIComponent(file.name)}`
          : undefined,
    }),
  );

  const orderedAttachments: ComposerAttachment[] = [
    ...uploadedComposerAttachments,
    ...uploadProgress.map((progress) => ({
      id: progress.fileId,
      name: progress.fileName,
      mimeType: progress.mimeType,
      pending: true,
      progress: progress.percent,
    })),
  ].sort((left, right) =>
    attachmentOrder
      ? attachmentOrder.indexOf(left.id) - attachmentOrder.indexOf(right.id)
      : 0,
  );

  // Late-bound: the composer needs the submit handlers, which need the
  // composer's `takeText`.
  const submitRef = useRef<{ submit: () => void; queue?: () => void }>({
    submit: () => {},
  });

  const composer = useComposer({
    text,
    setText,
    attachments: orderedAttachments,
    describeAttachment: (file) => file,
    // Uploads are read back through the active connection; files over the
    // inline limit travel as their managed upload path. In-flight uploads
    // have no bytes yet and are reported as missing.
    getClipboardSource: (file) => {
      const apiPath = file.apiPath;
      if (!apiPath) return null;
      return {
        name: file.name,
        mimeType: file.mimeType,
        read: () => connection.fetchBlob(apiPath.slice("/api".length)),
        reference: apiPath,
      };
    },
    disabled,
    canAttach,
    onAttach,
    onRemove: onRemoveAttachment
      ? (ids) => {
          for (const id of ids) removeDraftAttachment(id);
        }
      : undefined,
    onRestore: (ids) => {
      for (const id of ids) {
        const file = removedAttachmentsRef.current.files.get(id);
        if (file) onRestoreAttachment?.(file);
      }
    },
    commandConfigs: completionConfigs,
    onCustomCommand,
    onCommandMenuOpen,
    onSubmit: () => submitRef.current.submit(),
    onQueue: onQueue ? () => submitRef.current.queue?.() : undefined,
  });

  const submitMessage = (send: (message: string) => void) => {
    const finalText = composer.takeText();
    const hasContent = finalText.trim() || attachments.length > 0;
    if (hasContent && !disabled) {
      // Clear input state but keep localStorage for failure recovery
      controls.clearInput();
      send(finalText.trim());
      // Refocus the editor so the user can continue typing
      composer.editorRef.current?.focus();
    }
  };
  const handleSubmit = () => submitMessage(onSend);
  const handleQueue = onQueue ? () => submitMessage(onQueue) : undefined;
  submitRef.current = { submit: handleSubmit, queue: handleQueue };

  return (
    <div className="message-input-wrapper">
      {/* Floating toggle button - only show when user can control collapse (not externally collapsed) */}
      {!externalCollapsed && (
        <button
          type="button"
          className="message-input-toggle"
          onClick={() => setUserCollapsed(!userCollapsed)}
          aria-label={
            userCollapsed ? t("messageInputExpand") : t("messageInputCollapse")
          }
          aria-expanded={!userCollapsed}
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
            className={userCollapsed ? "chevron-up" : "chevron-down"}
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
      <div
        className={`message-input ${collapsed ? "message-input-collapsed" : ""} ${composer.isDictating ? "voice-recording" : ""}`}
      >
        <ComposerEditor
          composer={composer}
          containerClassName="message-input-composer"
          menuFallbackLabel={commandLabel}
          placeholder={
            externalCollapsed ? t("messageInputContinueAbove") : placeholder
          }
          disabled={disabled}
          rows={collapsed ? 1 : 3}
          showDetachedAttachments={!collapsed}
          canRemove={!!onRemoveAttachment}
        />

        {!collapsed && (
          <MessageInputToolbar
            mode={mode}
            onModeChange={onModeChange}
            isHeld={isHeld}
            onHoldChange={onHoldChange}
            supportsPermissionMode={supportsPermissionMode}
            provider={provider}
            permissionModes={permissionModes}
            supportsThinkingToggle={supportsThinkingToggle}
            canAttach={canAttach}
            attachmentCount={attachments.length}
            onAttachClick={composer.openFilePicker}
            onCopyInput={composer.document.copyAll}
            canCopy={!!(text.trim() || orderedAttachments.length > 0)}
            voiceButtonRef={composer.voiceRef}
            onVoiceTranscript={composer.voice.onTranscript}
            onInterimTranscript={composer.voice.onInterimTranscript}
            onListeningStart={composer.voice.onListeningStart}
            voiceDisabled={disabled}
            commandPrefix={commandPrefix}
            commandLabel={commandLabel}
            commands={commands}
            showCommandButton={showCommandButton}
            commandButtons={commandButtons}
            onSelectCommand={composer.completion.insertCommand}
            contextUsage={contextUsage}
            projectId={projectId}
            sessionId={sessionId}
            isRunning={isRunning}
            isThinking={isThinking}
            onStop={onStop}
            onOpenSideConversation={onOpenSideConversation}
            sideConversationOpen={sideConversationOpen}
            onSend={handleSubmit}
            onInterruptSend={
              onInterruptSend ? () => submitMessage(onInterruptSend) : undefined
            }
            onQueue={handleQueue}
            canSend={!!(text.trim() || attachments.length > 0)}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}
