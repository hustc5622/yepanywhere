import type { ProviderName, UploadedFile } from "@yep-anywhere/shared";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ENTER_SENDS_MESSAGE } from "../constants";
import {
  type DraftControls,
  useDraftPersistence,
} from "../hooks/useDraftPersistence";
import { useI18n } from "../i18n";
import type { AgentCommandConfig } from "../lib/agentCommands";
import { readClipboardUserInput } from "../lib/clipboard";
import { hasCoarsePointer } from "../lib/deviceDetection";
import type { ContextUsage, PermissionMode } from "../types";
import { MessageInputToolbar } from "./MessageInputToolbar";
import type { VoiceInputButtonRef } from "./VoiceInputButton";

/** Progress info for an in-flight upload */
export interface UploadProgress {
  fileId: string;
  fileName: string;
  bytesUploaded: number;
  totalBytes: number;
  percent: number;
}

/** Format file size in human-readable form */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

type CommandPrefix = "/" | "$";

interface ActiveCommandToken {
  start: number;
  end: number;
  query: string;
}

function findActiveCommandToken(
  text: string,
  cursorPosition: number,
  prefix: CommandPrefix,
): ActiveCommandToken | null {
  if (cursorPosition < 0 || cursorPosition > text.length) return null;

  const beforeCursor = text.slice(0, cursorPosition);
  const tokenStart = Math.max(
    beforeCursor.lastIndexOf(" "),
    beforeCursor.lastIndexOf("\n"),
    beforeCursor.lastIndexOf("\t"),
  );
  const start = tokenStart + 1;
  const token = beforeCursor.slice(start);

  if (!token.startsWith(prefix)) return null;
  if (token.length > 1 && token.includes(prefix, 1)) return null;

  return {
    start,
    end: cursorPosition,
    query: token.slice(prefix.length),
  };
}

function filterCommands(commands: string[], query: string): string[] {
  const normalizedQuery = query.toLowerCase();
  const deduped = Array.from(new Set(commands)).filter(Boolean);

  if (!normalizedQuery) return deduped;

  return deduped
    .filter((command) => command.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(normalizedQuery);
      const bStarts = b.toLowerCase().startsWith(normalizedQuery);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.localeCompare(b);
    });
}

interface Props {
  onSend: (text: string) => void;
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
  /** Callback when user selects files to attach */
  onAttach?: (files: File[]) => void;
  /** Callback when user removes an attachment */
  onRemoveAttachment?: (id: string) => void;
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
}

export function MessageInput({
  onSend,
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
  draftKey,
  collapsed: externalCollapsed,
  onDraftControlsReady,
  contextUsage,
  projectId,
  sessionId,
  attachments = [],
  onAttach,
  onRemoveAttachment,
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
}: Props) {
  const { t } = useI18n();
  const [text, setText, controls] = useDraftPersistence(draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  // User-controlled collapse state (independent of external collapse from approval panel)
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [dismissedCompletionKey, setDismissedCompletionKey] = useState<
    string | null
  >(null);

  // Combined display text: committed text + interim transcript
  const displayText = interimTranscript
    ? text + (text.trimEnd() ? " " : "") + interimTranscript
    : text;

  // Auto-scroll textarea when voice input updates (interim transcript changes)
  // Browser handles scrolling for normal typing, but programmatic updates need explicit scroll
  useEffect(() => {
    if (interimTranscript) {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    }
  }, [interimTranscript]);

  // Panel is collapsed if user collapsed it OR if externally collapsed (approval panel showing)
  const collapsed = userCollapsed || externalCollapsed;

  const canAttach = !!(projectId && sessionId && onAttach);

  const updateCursorPosition = useCallback(() => {
    const textarea = textareaRef.current;
    setCursorPosition(textarea?.selectionStart ?? text.length);
  }, [text.length]);

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

  const activeCompletion = useMemo(() => {
    for (const config of completionConfigs) {
      if (config.commands.length === 0) continue;
      const token = findActiveCommandToken(text, cursorPosition, config.prefix);
      if (token) return { config, token };
    }
    return null;
  }, [completionConfigs, cursorPosition, text]);

  const activeCommandToken = activeCompletion?.token ?? null;
  const activeCommandConfig = activeCompletion?.config ?? null;

  const filteredCommands = useMemo(
    () =>
      activeCommandToken && activeCommandConfig
        ? filterCommands(activeCommandConfig.commands, activeCommandToken.query)
        : [],
    [activeCommandConfig, activeCommandToken],
  );

  const completionKey =
    activeCommandToken && activeCommandConfig
      ? `${activeCommandConfig.prefix}:${activeCommandToken.start}:${activeCommandToken.end}:${activeCommandToken.query}`
      : null;
  const isCommandCompletionOpen =
    !!completionKey &&
    dismissedCompletionKey !== completionKey &&
    filteredCommands.length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the active command token changes.
  useEffect(() => {
    setActiveCommandIndex(0);
  }, [completionKey]);

  const insertCommand = useCallback(
    (command: string) => {
      const prefix = command.startsWith("$") ? "$" : "/";
      const bare =
        command.startsWith("/") || command.startsWith("$")
          ? command.slice(1)
          : command;
      const activeToken = findActiveCommandToken(
        text,
        textareaRef.current?.selectionStart ?? cursorPosition,
        prefix,
      );

      if (prefix === "/" && onCustomCommand?.(bare)) {
        if (activeToken) {
          const nextText =
            text.slice(0, activeToken.start) + text.slice(activeToken.end);
          setText(nextText);
          setCursorPosition(activeToken.start);
          setTimeout(() => {
            const textarea = textareaRef.current;
            textarea?.focus();
            textarea?.setSelectionRange(activeToken.start, activeToken.start);
          }, 0);
        }
        setDismissedCompletionKey(null);
        textareaRef.current?.focus();
        return;
      }

      const fullCommand = `${prefix}${bare}`;
      let nextText: string;
      let nextCursor: number;

      if (activeToken) {
        nextText = `${text.slice(
          0,
          activeToken.start,
        )}${fullCommand} ${text.slice(activeToken.end)}`;
        nextCursor = activeToken.start + fullCommand.length + 1;
      } else {
        const textarea = textareaRef.current;
        const cursor = textarea?.selectionStart ?? text.length;
        const before = text.slice(0, cursor);
        const after = text.slice(cursor);
        const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
        const trailing = after.length > 0 && !/^\s/.test(after) ? " " : " ";

        nextText = `${before}${leading}${fullCommand}${trailing}${after}`;
        nextCursor = before.length + leading.length + fullCommand.length + 1;
      }

      setText(nextText);
      setCursorPosition(nextCursor);
      setDismissedCompletionKey(null);
      setTimeout(() => {
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(nextCursor, nextCursor);
      }, 0);
    },
    [cursorPosition, onCustomCommand, setText, text],
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length && onAttach) {
      onAttach(Array.from(files));
      e.target.value = ""; // Reset for re-selection
    }
  };

  // Provide controls to parent via callback
  useEffect(() => {
    onDraftControlsReady?.(controls);
  }, [controls, onDraftControlsReady]);

  const handleSubmit = useCallback(() => {
    // Stop voice recording and get any pending interim text
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";

    // Combine committed text with any pending voice text
    let finalText = text.trimEnd();
    if (pendingVoice) {
      finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
    }

    const hasContent = finalText.trim() || attachments.length > 0;
    if (hasContent && !disabled) {
      const message = finalText.trim();
      // Clear input state but keep localStorage for failure recovery
      controls.clearInput();
      setInterimTranscript("");
      onSend(message);
      // Refocus the textarea so user can continue typing
      textareaRef.current?.focus();
    }
  }, [text, disabled, controls, onSend, attachments.length]);

  const handleQueue = useCallback(() => {
    // Stop voice recording and get any pending interim text
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";

    let finalText = text.trimEnd();
    if (pendingVoice) {
      finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
    }

    const hasContent = finalText.trim() || attachments.length > 0;
    if (hasContent && !disabled && onQueue) {
      const message = finalText.trim();
      controls.clearInput();
      setInterimTranscript("");
      onQueue(message);
      textareaRef.current?.focus();
    }
  }, [text, disabled, controls, onQueue, attachments.length]);

  const handleKeyDown = (e: KeyboardEvent) => {
    // Ctrl+Space toggles voice input
    if (e.key === " " && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (voiceButtonRef.current?.isAvailable) {
        voiceButtonRef.current.toggle();
      }
      return;
    }

    if (isCommandCompletionOpen) {
      const selectedCommand = filteredCommands[activeCommandIndex];
      const hasExactMatch =
        activeCommandToken !== null &&
        filteredCommands.some(
          (command) =>
            command.toLowerCase() === activeCommandToken.query.toLowerCase(),
        );

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveCommandIndex((index) => (index + 1) % filteredCommands.length);
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveCommandIndex(
          (index) =>
            (index - 1 + filteredCommands.length) % filteredCommands.length,
        );
        return;
      }

      if (e.key === "Tab" && selectedCommand) {
        e.preventDefault();
        insertCommand(
          `${activeCommandConfig?.prefix ?? commandPrefix}${selectedCommand}`,
        );
        return;
      }

      if (
        e.key === "Enter" &&
        !hasExactMatch &&
        !e.shiftKey &&
        !e.ctrlKey &&
        selectedCommand
      ) {
        e.preventDefault();
        insertCommand(
          `${activeCommandConfig?.prefix ?? commandPrefix}${selectedCommand}`,
        );
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedCompletionKey(completionKey);
        return;
      }
    }

    if (e.key === "Enter") {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.nativeEvent.isComposing) return;

      // Ctrl+Enter queues a deferred message when agent is running
      if (onQueue && e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        handleQueue();
        return;
      }

      // On mobile (touch devices), Enter adds newline - must use send button
      // On desktop, Enter sends message, Shift/Ctrl+Enter adds newline
      const isMobile = hasCoarsePointer();

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        handleSubmit();
        return;
      }

      if (isMobile) {
        // Mobile: Enter always adds newline, send button required
        // Allow default behavior (newline)
        return;
      }

      if (ENTER_SENDS_MESSAGE) {
        // Desktop: Enter sends, Ctrl+Enter adds newline
        if (e.ctrlKey || e.shiftKey) {
          // Allow default behavior (newline)
          return;
        }
        e.preventDefault();
        handleSubmit();
      } else {
        // Ctrl+Enter sends, Enter adds newline
        if (e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          handleSubmit();
        }
      }
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    if (!canAttach || !onAttach) return;

    const copiedInput = readClipboardUserInput(e.clipboardData);
    if (copiedInput && copiedInput.images.length > 0) {
      e.preventDefault();

      if (copiedInput.text) {
        const textarea = textareaRef.current;
        const currentValue = textarea?.value ?? text;
        const start = textarea?.selectionStart ?? currentValue.length;
        const end = textarea?.selectionEnd ?? start;
        const nextText = `${currentValue.slice(0, start)}${copiedInput.text}${currentValue.slice(end)}`;
        const nextCursor = start + copiedInput.text.length;

        setInterimTranscript("");
        setDismissedCompletionKey(null);
        setText(nextText);
        setCursorPosition(nextCursor);
        setTimeout(() => {
          textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
        }, 0);
      }

      onAttach(copiedInput.images);
      return;
    }

    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      // Prevent default only if we have files to handle
      // This allows text paste to still work normally
      e.preventDefault();
      onAttach(files);
    }
  };

  // Voice input handlers
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      // Append transcript to existing text with space separator
      // Trim the transcript since mobile speech API includes leading/trailing spaces
      const trimmedTranscript = transcript.trim();
      if (!trimmedTranscript) return;

      const trimmedText = text.trimEnd();
      if (trimmedText) {
        setText(`${trimmedText} ${trimmedTranscript}`);
      } else {
        setText(trimmedTranscript);
      }
      setInterimTranscript("");
      // Scroll to bottom after committing voice transcript
      // Use setTimeout to ensure state update has rendered
      setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.scrollTop = textarea.scrollHeight;
        }
      }, 0);
    },
    [text, setText],
  );

  const handleInterimTranscript = useCallback((transcript: string) => {
    setInterimTranscript(transcript);
  }, []);

  // Handle slash command selection - insert command into text
  const handleSlashCommand = useCallback(
    (command: string) => {
      insertCommand(command);
    },
    [insertCommand],
  );

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
        className={`message-input ${collapsed ? "message-input-collapsed" : ""} ${interimTranscript ? "voice-recording" : ""}`}
      >
        {isCommandCompletionOpen && (
          <div
            className="command-completion-menu"
            role="listbox"
            tabIndex={-1}
            aria-label={activeCommandConfig?.label ?? commandLabel}
          >
            {filteredCommands.map((command, index) => (
              <button
                key={command}
                type="button"
                className={`command-completion-item ${index === activeCommandIndex ? "active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  insertCommand(
                    `${activeCommandConfig?.prefix ?? commandPrefix}${command}`,
                  )
                }
                role="option"
                aria-selected={index === activeCommandIndex}
              >
                <span className="command-completion-name">
                  {activeCommandConfig?.prefix ?? commandPrefix}
                  {command}
                </span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={displayText}
          onChange={(e) => {
            // If user edits while recording, only update committed text
            // This clears interim since they're now typing
            setInterimTranscript("");
            setDismissedCompletionKey(null);
            setCursorPosition(e.target.selectionStart);
            setText(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={updateCursorPosition}
          onClick={updateCursorPosition}
          onSelect={updateCursorPosition}
          onPaste={handlePaste}
          placeholder={
            externalCollapsed ? t("messageInputContinueAbove") : placeholder
          }
          disabled={disabled}
          rows={collapsed ? 1 : 3}
        />

        {/* Attachment chips - show below textarea when not collapsed */}
        {!collapsed &&
          (attachments.length > 0 || uploadProgress.length > 0) && (
            <div className="attachment-list">
              {attachments.map((file) => (
                <div key={file.id} className="attachment-chip">
                  <span className="attachment-name" title={file.path}>
                    {file.originalName}
                  </span>
                  <span className="attachment-size">
                    {formatSize(file.size)}
                  </span>
                  <button
                    type="button"
                    className="attachment-remove"
                    onClick={() => onRemoveAttachment?.(file.id)}
                    aria-label={t("messageInputRemoveAttachment", {
                      name: file.originalName,
                    })}
                  >
                    x
                  </button>
                </div>
              ))}
              {uploadProgress.map((progress) => (
                <div
                  key={progress.fileId}
                  className="attachment-chip uploading"
                >
                  <span className="attachment-name">{progress.fileName}</span>
                  <span className="attachment-progress">
                    {progress.percent}%
                  </span>
                </div>
              ))}
            </div>
          )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileSelect}
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
            onAttachClick={() => fileInputRef.current?.click()}
            voiceButtonRef={voiceButtonRef}
            onVoiceTranscript={handleVoiceTranscript}
            onInterimTranscript={handleInterimTranscript}
            onListeningStart={() => textareaRef.current?.focus()}
            voiceDisabled={disabled}
            commandPrefix={commandPrefix}
            commandLabel={commandLabel}
            commands={commands}
            showCommandButton={showCommandButton}
            commandButtons={commandButtons}
            onSelectCommand={handleSlashCommand}
            contextUsage={contextUsage}
            projectId={projectId}
            sessionId={sessionId}
            isRunning={isRunning}
            isThinking={isThinking}
            onStop={onStop}
            onSend={handleSubmit}
            onQueue={onQueue ? handleQueue : undefined}
            canSend={!!(text.trim() || attachments.length > 0)}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}
