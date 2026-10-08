import { useI18n } from "../i18n";
import { getAttachmentThumbnailSrc } from "../lib/attachmentThumbnail";
import type { ComposerAttachment } from "./AttachmentComposer";
import { AttachmentThumbnail } from "./AttachmentThumbnail";

/** The same attachment actions for legacy drafts without inline references. */
export function ComposerAttachmentCard({
  attachment,
  detail,
  disabled,
  onPreview,
  onRemove,
}: {
  attachment: ComposerAttachment;
  detail?: string;
  disabled?: boolean;
  onPreview?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  const { t } = useI18n();
  const isImage = attachment.mimeType?.startsWith("image/");
  const canPreview = isImage && (attachment.previewUrl || attachment.apiPath);
  return (
    <div
      className="attachment-composer-card"
      data-kind={isImage ? "image" : "file"}
      data-pending={attachment.pending || undefined}
    >
      <button
        type="button"
        className="attachment-composer-preview"
        disabled={disabled || !canPreview || !onPreview || attachment.pending}
        aria-label={t("composerAttachmentPreview", { name: attachment.name })}
        title={attachment.name}
        onClick={() => onPreview?.(attachment.id)}
      >
        {isImage ? (
          <AttachmentThumbnail src={getAttachmentThumbnailSrc(attachment)} />
        ) : (
          <span className="attachment-composer-icon" aria-hidden="true" />
        )}
        <span className="attachment-composer-name">{attachment.name}</span>
        {attachment.pending && attachment.progress !== undefined && (
          <span className="attachment-composer-progress">
            {Math.round(attachment.progress)}%
          </span>
        )}
        {detail && <span className="attachment-size">{detail}</span>}
      </button>
      {onRemove && (
        <button
          type="button"
          className="attachment-composer-remove"
          disabled={disabled}
          aria-label={t("composerAttachmentRemove", { name: attachment.name })}
          title={t("composerAttachmentRemove", { name: attachment.name })}
          onClick={() => onRemove(attachment.id)}
        />
      )}
    </div>
  );
}
