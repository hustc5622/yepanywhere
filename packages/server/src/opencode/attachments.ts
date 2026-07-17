const MAX_URL_LABEL_LENGTH = 256;

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
