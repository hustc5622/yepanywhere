const MAX_URL_LABEL_LENGTH = 256;
const YEP_UPLOAD_METADATA_MARKER = "\n\nUser uploaded files:\n";

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
