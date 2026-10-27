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
import { useOptionalToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import {
  countAttachmentTokens,
  dropAttachmentTokens,
  findAttachmentAfterPosition,
  insertAttachmentToken,
  removeAttachmentTokenOccurrence,
  sanitizeAttachmentTokenName,
} from "../lib/attachmentTokens";
import {
  type ClipboardAttachmentSource,
  type ClipboardUserInput,
  type ClipboardUserInputCopyResult,
  readClipboardUserInput,
  writeClipboardUserInput,
} from "../lib/clipboard";
import { useConnection } from "./useConnection";

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
  /** How an attachment is copied; null/absent sources are reported as missing. */
  getClipboardSource?: (attachment: T) => ClipboardAttachmentSource | null;
  /** Reads a managed upload referenced by a pasted Yep copy (`/api/...`). */
  fetchClipboardReference?: (apiPath: string) => Promise<Blob>;
  /** Files this composer can take; others are dropped before any token is inserted. */
  acceptFile?: (file: File) => boolean;
  onRejectFiles?: (files: File[]) => void;
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
  getClipboardSource,
  fetchClipboardReference,
  acceptFile,
  onRejectFiles,
}: Options<T>) {
  const { t } = useI18n();
  const toast = useOptionalToastContext();
  const connection = useConnection();
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

  const attachFiles = (incoming: File[], pastedText = "") => {
    if (disabled || !canAttach || !onAttach) return;
    const files = acceptFile ? incoming.filter(acceptFile) : incoming;
    const rejected = incoming.filter((file) => !files.includes(file));
    let copiedText = pastedText;
    if (rejected.length > 0) {
      onRejectFiles?.(rejected);
      // Pasted Yep text may carry tokens for the files left out.
      for (const file of rejected) {
        copiedText = dropAttachmentTokens(copiedText, file.name, 1);
      }
    }
    if (files.length === 0 && !copiedText) return;
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
    if (files.length > 0) {
      if (beforeId) onAttach(files, beforeId);
      else onAttach(files);
    }

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

  const reportMissing = (names: string[], key: "paste" | "copy") => {
    if (names.length === 0) return;
    toast?.showToast(
      t(key === "paste" ? "composerPasteMissing" : "composerCopyMissing", {
        names: Array.from(new Set(names)).join(", "),
      }),
      "error",
    );
  };

  /** Restore a Yep rich copy: every attachment, then text without orphans. */
  const restoreCopiedInput = async (copied: ClipboardUserInput) => {
    const files: File[] = [];
    const failed = [...copied.missingNames];
    const fetchReference =
      fetchClipboardReference ??
      ((path: string) => connection.fetchBlob(path.slice("/api".length)));
    for (const entry of copied.attachments) {
      if (entry.kind === "file") {
        files.push(entry.file);
        continue;
      }
      try {
        const blob = await fetchReference(entry.path);
        files.push(
          new File([blob], entry.name, { type: blob.type || entry.mimeType }),
        );
      } catch {
        failed.push(entry.name);
      }
    }
    let text = copied.text;
    const failedCounts = new Map<string, number>();
    for (const name of failed) {
      const key = sanitizeAttachmentTokenName(name);
      failedCounts.set(key, (failedCounts.get(key) ?? 0) + 1);
    }
    for (const [name, count] of failedCounts) {
      const restored = files.filter(
        (file) => sanitizeAttachmentTokenName(file.name) === name,
      ).length;
      const excess = countAttachmentTokens(text, name) - restored;
      if (excess > 0)
        text = dropAttachmentTokens(text, name, Math.min(excess, count));
    }
    attachFiles(files, text);
    reportMissing(failed, "paste");
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    if (disabled || !canAttach || !onAttach) return;
    const copiedInput = readClipboardUserInput(event.clipboardData);
    if (
      copiedInput &&
      (copiedInput.attachments.length > 0 ||
        copiedInput.missingNames.length > 0)
    ) {
      event.preventDefault();
      void restoreCopiedInput(copiedInput);
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

  /** Files dropped onto the editor (caret already at the drop point). */
  const handleDropFiles = (files: File[]) => attachFiles(files);

  const copyInput = async (
    text: string,
    selected: T[],
  ): Promise<ClipboardUserInputCopyResult> => {
    const sources = selected.map((attachment) => {
      const described = describeAttachment(attachment);
      return (
        getClipboardSource?.(attachment) ?? {
          name: described.name,
          mimeType: described.mimeType,
        }
      );
    });
    const result = await writeClipboardUserInput(text, sources);
    reportMissing(result.failedNames, "copy");
    return result;
  };

  /** Copy the whole draft: text plus every attachment, in order. */
  const copyAll = () =>
    copyInput(editorRef.current?.value ?? value, attachments);

  /** Native copy/cut of a selection that includes attachment cards. */
  const handleCopyAttachments = (text: string, ids: string[]) => {
    const selected = attachments.filter((attachment) =>
      ids.includes(describeAttachment(attachment).id),
    );
    if (selected.length === 0) return;
    void copyInput(text, selected).catch(() => {
      toast?.showToast(t("composerCopyFailed"), "error");
    });
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
    handleCopyAttachments,
    handleDropFiles,
    copyAll,
    removeAttachment,
    setCaretSoon,
  };
}
