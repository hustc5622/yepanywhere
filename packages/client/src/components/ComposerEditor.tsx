import type { ComposerController } from "../hooks/useComposer";
import { AttachmentComposer } from "./AttachmentComposer";
import { AttachmentPreviewModal } from "./AttachmentPreviewModal";
import { CommandCompletionMenu } from "./CommandCompletionMenu";
import { ComposerAttachmentCard } from "./ComposerAttachmentCard";

interface ComposerEditorProps<T> {
  composer: ComposerController<T>;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  /** Class of the editor element. */
  className?: string;
  /** Positioned container around the menu and editor. */
  containerClassName: string;
  /** Completion menu above the editor (footer) or below it (page top). */
  menuPlacement?: "above" | "below";
  menuFallbackLabel?: string;
  /** Show attachments that are not referenced inline in the text. */
  showDetachedAttachments?: boolean;
  /** Secondary text on detached cards (size, upload progress, ...). */
  attachmentDetail?: (attachment: T) => string | undefined;
  /** Whether attachments can be removed from this composer. */
  canRemove?: boolean;
}

/**
 * The editor half of every chat composer: inline command completion, the
 * attachment-aware editor, detached attachment cards, the hidden file
 * picker and the attachment preview.
 */
export function ComposerEditor<T>({
  composer,
  placeholder,
  disabled,
  rows,
  className,
  containerClassName,
  menuPlacement = "above",
  menuFallbackLabel,
  showDetachedAttachments = true,
  attachmentDetail,
  canRemove = true,
}: ComposerEditorProps<T>) {
  const { completion, document, preview } = composer;
  const removeAttachment = canRemove ? document.removeAttachment : undefined;
  const previewAttachment = preview.attachment;
  return (
    <>
      <div className={containerClassName}>
        <CommandCompletionMenu
          state={completion.state}
          onSelect={completion.selectItem}
          placement={menuPlacement}
          fallbackLabel={menuFallbackLabel}
        />
        <AttachmentComposer
          ref={composer.editorRef}
          value={composer.displayText}
          attachments={document.composerAttachments}
          onPreview={preview.open}
          onRemove={removeAttachment}
          onChange={document.handleChange}
          onKeyDown={composer.handleKeyDown}
          onKeyUp={completion.updateCursorPosition}
          onClick={completion.updateCursorPosition}
          onSelect={completion.updateCursorPosition}
          onPaste={document.handlePaste}
          onCopyAttachments={document.handleCopyAttachments}
          onDropFiles={document.handleDropFiles}
          placeholder={placeholder}
          disabled={disabled}
          rows={rows}
          className={className}
        />
      </div>

      {showDetachedAttachments && document.detachedAttachments.length > 0 && (
        <div className="attachment-list">
          {document.detachedAttachments.map((attachment) => {
            const described = composer.describeAttachment(attachment);
            return (
              <ComposerAttachmentCard
                key={described.id}
                attachment={described}
                detail={attachmentDetail?.(attachment)}
                disabled={disabled}
                onPreview={preview.open}
                onRemove={removeAttachment}
              />
            );
          })}
        </div>
      )}

      <input
        ref={composer.fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={document.handleFileSelect}
      />

      {previewAttachment &&
        (previewAttachment.previewUrl || previewAttachment.apiPath) && (
          <AttachmentPreviewModal
            name={previewAttachment.name}
            src={previewAttachment.previewUrl ?? null}
            apiPath={previewAttachment.apiPath ?? null}
            onClose={preview.close}
          />
        )}
    </>
  );
}
