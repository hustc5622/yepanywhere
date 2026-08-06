const MAX_URL_LABEL_LENGTH = 256;
const YEP_UPLOAD_METADATA_MARKER = "\n\nUser uploaded files:\n";
const OPENCODE_NATIVE_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Return the canonical MIME type when an upload is safe to forward as an
 * OpenCode-native model attachment. Other uploads remain available through
 * the local path that MessageQueue includes in the user prompt.
 */
export function normalizeOpenCodeNativeAttachmentMime(
  mimeType: string | undefined,
): string | undefined {
  const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!normalized) return undefined;
  const canonical = normalized === "image/jpg" ? "image/jpeg" : normalized;
  return OPENCODE_NATIVE_ATTACHMENT_MIME_TYPES.has(canonical)
    ? canonical
    : undefined;
}

/** Whether a user prompt already contains Yep's renderable upload metadata. */
export function hasYepUploadMetadata(text: string | undefined): boolean {
  return text?.includes(YEP_UPLOAD_METADATA_MARKER) ?? false;
}

/** Whether Yep's upload metadata names the given native OpenCode file part. */
export function hasYepUploadMetadataForFile(
  text: string | undefined,
  filename: string | undefined,
): boolean {
  if (!filename || !hasYepUploadMetadata(text)) return false;
  const uploadSection = text?.split(YEP_UPLOAD_METADATA_MARKER, 2)[1];
  return (
    uploadSection
      ?.split("\n")
      .some((line) => line.startsWith(`- ${filename} (`)) ?? false
  );
}

/**
 * Keep OpenCode file markers readable without copying inline attachment bytes
 * (typically a multi-megabyte data URI) into the transcript.
 */
export function getOpenCodeAttachmentLabel(file: {
  filename?: string;
  url?: string;
}): string {
  const filename = file.filename?.trim();
  if (filename) return filename;

  const url = file.url?.trim();
  if (!url || /^data:/iu.test(url) || url.length > MAX_URL_LABEL_LENGTH) {
    return "attachment";
  }
  return url;
}
