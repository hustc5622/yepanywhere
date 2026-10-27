import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  AttachmentComposerHandle,
  ComposerAttachment,
} from "../components/AttachmentComposer";
import type { VoiceInputButtonRef } from "../components/VoiceInputButton";
import type { AgentCommandConfig } from "../lib/agentCommands";
import type { ClipboardAttachmentSource } from "../lib/clipboard";
import {
  handleComposerSubmitKey,
  isComposerComposing,
} from "../lib/composerKeyboard";
import { useCommandCompletion } from "./useCommandCompletion";
import { useComposerDocument } from "./useComposerDocument";

export interface UseComposerOptions<T> {
  /** Committed draft text; the container owns persistence. */
  text: string;
  setText: (value: string) => void;
  attachments: T[];
  describeAttachment: (attachment: T) => ComposerAttachment;
  getClipboardSource?: (attachment: T) => ClipboardAttachmentSource | null;
  onAttach?: (files: File[], beforeAttachmentId?: string) => void;
  onRemove?: (ids: string[]) => void;
  onRestore?: (ids: string[]) => void;
  canAttach?: boolean;
  acceptFile?: (file: File) => boolean;
  onRejectFiles?: (files: File[]) => void;
  disabled?: boolean;
  commandConfigs: AgentCommandConfig[];
  onCustomCommand?: (command: string) => boolean;
  onCommandMenuOpen?: () => void;
  /** Enter (per the shared keyboard policy). */
  onSubmit: () => void;
  /** Ctrl+Enter while queueing is available. */
  onQueue?: () => void;
}

/**
 * Everything a chat composer does between the editor and its container:
 * voice dictation, `/`/`$` completion, attachment/clipboard document rules,
 * the shared keyboard policy and attachment preview. Containers keep only
 * what differs: draft storage, uploads, submission and their toolbar slots.
 */
export function useComposer<T>({
  text,
  setText,
  attachments,
  describeAttachment,
  getClipboardSource,
  onAttach,
  onRemove,
  onRestore,
  canAttach,
  acceptFile,
  onRejectFiles,
  disabled,
  commandConfigs,
  onCustomCommand,
  onCommandMenuOpen,
  onSubmit,
  onQueue,
}: UseComposerOptions<T>) {
  const editorRef = useRef<AttachmentComposerHandle>(null);
  const voiceRef = useRef<VoiceInputButtonRef>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Committed text plus the live (not yet final) dictation.
  const displayText = interimTranscript
    ? text + (text.trimEnd() ? " " : "") + interimTranscript
    : text;

  // Programmatic updates do not scroll the editor on their own.
  useEffect(() => {
    if (interimTranscript && editorRef.current) {
      editorRef.current.scrollTop = editorRef.current.scrollHeight;
    }
  }, [interimTranscript]);

  const setTextFromEditor = useCallback(
    (value: string) => {
      setInterimTranscript("");
      setText(value);
    },
    [setText],
  );

  const completion = useCommandCompletion({
    text,
    setText: setTextFromEditor,
    editorRef,
    configs: commandConfigs,
    onCustomCommand,
    onActivate: onCommandMenuOpen,
  });

  const composerDocument = useComposerDocument({
    value: displayText,
    editorRef,
    attachments,
    describeAttachment,
    getClipboardSource,
    disabled,
    canAttach,
    acceptFile,
    onRejectFiles,
    onAttach,
    onRemove,
    onRestore,
    onTextChange: (value, cursor) => {
      setInterimTranscript("");
      completion.handleTextChange(cursor);
      setText(value);
    },
  });

  /**
   * Stop dictation and return the text to submit: committed text plus any
   * pending transcript, trailing whitespace removed.
   */
  const takeText = useCallback((): string => {
    const pendingVoice = voiceRef.current?.stopAndFinalize() ?? "";
    let finalText = text.trimEnd();
    if (pendingVoice) {
      finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
    }
    setInterimTranscript("");
    return finalText;
  }, [text]);

  const handleKeyDown = (event: KeyboardEvent) => {
    // IME confirmation and deletion belong to the native editor.
    if (isComposerComposing(event)) return;
    // Ctrl+Space toggles voice input.
    if (
      event.key === " " &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      if (voiceRef.current?.isAvailable) voiceRef.current.toggle();
      return;
    }
    if (completion.handleKeyDown(event)) return;
    handleComposerSubmitKey(event, {
      onSubmit,
      onQueue,
      isListening: voiceRef.current?.isListening,
    });
  };

  const onVoiceTranscript = useCallback(
    (transcript: string) => {
      // Mobile speech APIs pad transcripts with spaces.
      const trimmed = transcript.trim();
      if (!trimmed) return;
      const committed = text.trimEnd();
      setText(committed ? `${committed} ${trimmed}` : trimmed);
      setInterimTranscript("");
      setTimeout(() => {
        const editor = editorRef.current;
        if (editor) editor.scrollTop = editor.scrollHeight;
      }, 0);
    },
    [text, setText],
  );

  const previewAttachment = previewId
    ? composerDocument.composerAttachments.find(
        (attachment) => attachment.id === previewId,
      )
    : undefined;

  return {
    editorRef,
    voiceRef,
    fileInputRef,
    displayText,
    isDictating: interimTranscript.length > 0,
    completion,
    document: composerDocument,
    handleKeyDown,
    takeText,
    voice: {
      ref: voiceRef,
      onTranscript: onVoiceTranscript,
      onInterimTranscript: setInterimTranscript,
      onListeningStart: () => editorRef.current?.focus(),
    },
    openFilePicker: () => fileInputRef.current?.click(),
    preview: {
      attachment: previewAttachment,
      open: setPreviewId,
      close: () => setPreviewId(null),
    },
    describeAttachment,
  };
}

export type ComposerController<T> = ReturnType<typeof useComposer<T>>;
