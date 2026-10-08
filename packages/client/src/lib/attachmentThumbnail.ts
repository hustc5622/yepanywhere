import { API_BASE } from "./apiPath";

/** Browser-loadable sources for the small image inside an attachment label. */
export function getAttachmentThumbnailSrc({
  mimeType,
  previewUrl,
  apiPath,
}: {
  mimeType?: string;
  previewUrl?: string | null;
  apiPath?: string | null;
}): string | undefined {
  if (!mimeType?.startsWith("image/")) return undefined;
  for (const candidate of [previewUrl, apiPath]) {
    const source = candidate?.trim();
    if (!source) continue;
    if (source.startsWith(`${API_BASE}/`)) return source;
    if (source.startsWith("/api/")) return `${API_BASE}${source.slice(4)}`;
    if (/^(?:https?:|blob:|data:image\/)/i.test(source)) return source;
  }
  return undefined;
}
