import type { ContextUsage } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  type ClipboardImageSource,
  getSelectionAwareCopyText,
  writeClipboardText,
  writeClipboardUserInput,
} from "../lib/clipboard";
import { formatTokenCount } from "../lib/tokens";

interface MessageActionsProps {
  /** ISO timestamp string from the source message; shown on hover. */
  timestamp?: string;
  /** Whether the timestamp represents live turn activity instead of turn start. */
  timestampIsLastUpdate?: boolean;
  /** Context-window usage snapshot associated with this message. */
  contextBefore?: ContextUsage;
  /** Plain-text payload to copy. When omitted, the copy button is hidden. */
  copyText?: string;
  /** Images belonging to the same user input. */
  copyImages?: ClipboardImageSource[];
  /** Place a copy-only action inside a message bubble and keep it visible. */
  placement?: "row" | "bubble";
  /**
   * When provided, show an "edit" button. Used on user messages to rewind the
   * conversation: forks the session up to this message and prefills the input.
   */
  onEdit?: () => void;
}

type CopyFeedback = {
  status: "copied" | "copied-images" | "partial" | "failed";
} | null;

/**
 * Hover-revealed action row for a chat bubble or assistant turn:
 *  - timestamp (formatted as a short local time)
 *  - copy-to-clipboard button
 *
 * Visibility is driven by the parent's `:hover` / `:focus-within` styles in
 * index.css. On touch devices the actions are kept faintly visible (see
 * `@media (hover: none)` block) since `:hover` never reliably triggers.
 */
export function MessageActions({
  timestamp,
  timestampIsLastUpdate = false,
  contextBefore,
  copyText,
  copyImages = [],
  placement = "row",
  onEdit,
}: MessageActionsProps) {
  const { t } = useI18n();
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>(null);
  const actionsRef = useRef<HTMLSpanElement | null>(null);

  // Reset copy success/failure feedback after a short window. A new object is
  // stored for every attempt so repeated failures restart this timer.
  useEffect(() => {
    if (!copyFeedback) return;
    const handle = setTimeout(() => setCopyFeedback(null), 1500);
    return () => clearTimeout(handle);
  }, [copyFeedback]);

  const handleCopy = useCallback(async () => {
    if (copyText === undefined) return;

    const selectionRoot =
      actionsRef.current?.closest(".assistant-turn, .user-prompt-container") ??
      actionsRef.current;
    const textToCopy = getSelectionAwareCopyText(copyText, selectionRoot);
    const shouldCopyImages = copyImages.length > 0 && textToCopy === copyText;

    try {
      if (shouldCopyImages) {
        const result = await writeClipboardUserInput(textToCopy, copyImages);
        setCopyFeedback({
          status:
            result.copiedImageCount === result.requestedImageCount
              ? "copied-images"
              : "partial",
        });
      } else {
        await writeClipboardText(textToCopy);
        setCopyFeedback({ status: "copied" });
      }
    } catch (error) {
      console.error("Failed to copy message:", error);
      setCopyFeedback({ status: "failed" });
    }
  }, [copyImages, copyText]);

  const copyStatus = copyFeedback?.status;
  const copyLabel =
    copyStatus === "copied-images"
      ? t("messageActionCopiedWithImages")
      : copyStatus === "copied"
        ? t("messageActionCopied")
        : copyStatus === "partial"
          ? t("messageActionCopiedWithoutAllImages")
          : copyStatus === "failed"
            ? t("messageActionCopyFailed")
            : copyImages.length > 0
              ? t("messageActionCopyWithImages")
              : t("messageActionCopy");

  const contextTokenLabel =
    contextBefore && contextBefore.inputTokens > 0
      ? formatTokenCount(contextBefore.inputTokens)
      : null;
  const contextTokenTitle =
    contextBefore && contextBefore.inputTokens > 0
      ? `${contextBefore.inputTokens.toLocaleString()} context tokens`
      : undefined;

  const hasCopyPayload =
    copyText !== undefined && (copyText.length > 0 || copyImages.length > 0);

  if (!timestamp && !contextTokenLabel && !hasCopyPayload && !onEdit)
    return null;

  return (
    <span
      ref={actionsRef}
      className={`message-actions${placement === "bubble" ? " message-actions-bubble" : ""}${copyFeedback ? " is-active" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {timestamp && (
        <time
          className="message-actions-time"
          dateTime={timestamp}
          title={
            timestampIsLastUpdate
              ? t("messageActionLastUpdated", {
                  time: formatFullTimestamp(timestamp),
                })
              : formatFullTimestamp(timestamp)
          }
          aria-label={
            timestampIsLastUpdate
              ? t("messageActionLastUpdated", {
                  time: formatFullTimestamp(timestamp),
                })
              : undefined
          }
        >
          {formatShortTime(timestamp)}
        </time>
      )}
      {contextTokenLabel && (
        <span className="message-actions-context" title={contextTokenTitle}>
          {contextTokenLabel}
        </span>
      )}
      {onEdit && (
        <button
          type="button"
          className="message-actions-edit"
          onClick={onEdit}
          aria-label={t("messageActionEdit")}
          title={t("messageActionEdit")}
        >
          <EditIcon />
        </button>
      )}
      {hasCopyPayload && (
        <button
          type="button"
          className={`message-actions-copy${
            copyStatus === "copied" || copyStatus === "copied-images"
              ? " is-copied"
              : copyStatus === "partial"
                ? " is-partial"
                : copyStatus === "failed"
                  ? " is-failed"
                  : ""
          }`}
          onClick={handleCopy}
          aria-label={copyLabel}
          aria-live="polite"
          title={copyLabel}
        >
          {copyStatus === "copied" || copyStatus === "copied-images" ? (
            <CopiedIcon />
          ) : copyStatus === "partial" ? (
            <CopyPartialIcon />
          ) : copyStatus === "failed" ? (
            <CopyFailedIcon />
          ) : (
            <CopyIcon />
          )}
        </button>
      )}
    </span>
  );
}

function EditIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CopiedIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CopyFailedIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function CopyPartialIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function formatShortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFullTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
