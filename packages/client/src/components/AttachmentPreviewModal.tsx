import { useFetchedImage } from "../hooks/useRemoteImage";
import { useOptionalI18n } from "../i18n";
import { Modal } from "./ui/Modal";

interface Props {
  /** File name shown as the modal title. */
  name: string;
  /**
   * Directly usable image source (object URL for not-yet-uploaded files).
   * Takes precedence over `apiPath`.
   */
  src?: string | null;
  /** Authenticated managed-upload endpoint for already uploaded files. */
  apiPath?: string | null;
  onClose: () => void;
}

function FetchedPreview({ apiPath, alt }: { apiPath: string; alt: string }) {
  const { url, loading, error } = useFetchedImage(apiPath);
  const i18n = useOptionalI18n();

  if (loading) {
    return (
      <div className="image-loading">
        {i18n?.t("attachmentPreviewLoading") ?? "Loading image..."}
      </div>
    );
  }
  if (error || !url) {
    return (
      <div className="uploaded-image-error" role="alert">
        <pre>{error ?? `Image request failed\nURL: ${apiPath}`}</pre>
      </div>
    );
  }
  return <img src={url} alt={alt} />;
}

/**
 * Preview modal for a composer attachment, used when clicking an inline
 * `@[name]` token in the message input.
 */
export function AttachmentPreviewModal({ name, src, apiPath, onClose }: Props) {
  return (
    <Modal title={name} onClose={onClose}>
      <div className="uploaded-image-modal">
        {src ? (
          <img src={src} alt={name} />
        ) : apiPath ? (
          <FetchedPreview apiPath={apiPath} alt={name} />
        ) : (
          <div className="uploaded-image-error" role="alert">
            <pre>{`No preview available for ${name}`}</pre>
          </div>
        )}
      </div>
    </Modal>
  );
}
