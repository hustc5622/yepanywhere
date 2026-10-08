import {
  type ChangeEvent,
  type ClipboardEvent,
  type RefObject,
  useCallback,
} from "react";
import type {
  AttachmentComposerChangeEvent,
  AttachmentComposerHandle,
  ComposerAttachment,
} from "../components/AttachmentComposer";
import {
  countAttachmentTokens,
  findAttachmentAfterPosition,
  insertAttachmentToken,
  removeAttachmentTokenOccurrence,
  sanitizeAttachmentTokenName,
} from "../lib/attachmentTokens";
import { readClipboardUserInput } from "../lib/clipboard";

interface Options<T> {
  value: string;
  editorRef: RefObject<AttachmentComposerHandle | null>;
  attachments: T[];
  describeAttachment: (attachment: T) => ComposerAttachment;
  onTextChange: (value: string, cursor: number) => void;
  onAttach?: (files: File[], beforeAttachmentId?: string) => void;
  onRemove?: (ids: string[]) => void;
  onRestore?: (ids: string[]) => void;
  disabled?: boolean;
  canAttach?: boolean;
}

/**
 * Shared editing rules for new sessions, replies and restored historical
 * messages. Pages own file storage/upload and submission; this hook owns the
 * relationship between text, selection and the ordered attachment list.
 */
export function useComposerDocument<T>({
  value,
  editorRef,
  attachments,
  describeAttachment,
  onTextChange,
  onAttach,
  onRemove,
  onRestore,
  disabled = false,
  canAttach = !!onAttach,
}: Options<T>) {
  const composerAttachments = attachments.map(describeAttachment);
  const occurrences = new Map<string, number>();
  const detachedAttachments = attachments.filter((_, index) => {
    const file = composerAttachments[index];
    if (!file) return false;
    const name = sanitizeAttachmentTokenName(file.name);
    const occurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, occurrence + 1);
    return occurrence >= countAttachmentTokens(value, name);
  });

  const setCaretSoon = useCallback(
    (position: number) => {
      // Don't move the caret into a different editor after route navigation.
      const editor = editorRef.current;
      const apply = () => {
        if (!editor) return;
        editor.focus();
        editor.setSelectionRange(position, position);
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(apply);
      } else {
        setTimeout(apply, 0);
      }
    },
    [editorRef],
  );

  const handleChange = (event: AttachmentComposerChangeEvent) => {
    if (disabled) return;
    const { removedAttachmentIds, restoredAttachmentIds } = event.target;
    if (removedAttachmentIds?.length) onRemove?.(removedAttachmentIds);
    if (restoredAttachmentIds?.length) onRestore?.(restoredAttachmentIds);
    onTextChange(event.target.value, event.target.selectionStart);
  };

  const attachFiles = (files: File[], copiedText = "") => {
    if (disabled || !canAttach || !onAttach || files.length === 0) return;
    const editor = editorRef.current;
    const currentValue = editor?.value ?? value;
    const start = editor?.selectionStart ?? currentValue.length;
    const end = editor?.selectionEnd ?? start;
    const selectedIds = editor?.getSelectedAttachmentIds() ?? [];
    const anchor = findAttachmentAfterPosition(
      currentValue,
      end,
      composerAttachments,
      (file) => file.name,
    );
    const beforeId =
      anchor && !selectedIds.includes(anchor.id) ? anchor.id : undefined;
    if (selectedIds.length) onRemove?.(selectedIds);
    if (beforeId) onAttach(files, beforeId);
    else onAttach(files);

    let nextText = `${currentValue.slice(0, start)}${copiedText}${currentValue.slice(end)}`;
    let cursor = start + copiedText.length;
    const consumed = new Map<string, number>();
    for (const file of files) {
      const name = sanitizeAttachmentTokenName(file.name);
      const used = consumed.get(name) ?? 0;
      consumed.set(name, used + 1);
      // The rich clipboard's text may already carry these exact tokens.
      if (countAttachmentTokens(copiedText, name) > used) continue;
      const inserted = insertAttachmentToken(nextText, cursor, file.name);
      nextText = inserted.text;
      cursor = inserted.cursor;
    }
    onTextChange(nextText, cursor);
    setCaretSoon(cursor);
  };

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files?.length) attachFiles(Array.from(files));
    event.target.value = "";
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    if (disabled || !canAttach || !onAttach) return;
    const copiedInput = readClipboardUserInput(event.clipboardData);
    if (copiedInput?.images.length) {
      event.preventDefault();
      attachFiles(copiedInput.images, copiedInput.text);
      return;
    }
    const files = Array.from(event.clipboardData.items ?? []).flatMap(
      (item) => {
        const file = item.kind === "file" ? item.getAsFile() : null;
        return file ? [file] : [];
      },
    );
    if (files.length) {
      event.preventDefault();
      attachFiles(files);
    }
  };

  const removeAttachment = (id: string) => {
    if (disabled || !onRemove) return;
    const file = composerAttachments.find((candidate) => candidate.id === id);
    if (!file) return;
    const matching = composerAttachments.filter(
      (candidate) =>
        sanitizeAttachmentTokenName(candidate.name) ===
        sanitizeAttachmentTokenName(file.name),
    );
    const deletion = removeAttachmentTokenOccurrence(
      editorRef.current?.value ?? value,
      file.name,
      matching.findIndex((candidate) => candidate.id === id),
    );
    if (deletion) {
      onTextChange(deletion.text, deletion.cursor);
      setCaretSoon(deletion.cursor);
    }
    onRemove([id]);
  };

  return {
    composerAttachments,
    detachedAttachments,
    handleChange,
    handleFileSelect,
    handlePaste,
    removeAttachment,
    setCaretSoon,
  };
}
