import { isManagedUploadDownloadUrl } from "@yep-anywhere/shared";
import type { ContentBlock } from "../types";
import {
  type ParsedUserPrompt,
  type UploadedFileInfo,
  getFilename,
  parseUserPrompt,
} from "./parseUserPrompt";

export interface EditableUserPrompt {
  text: string;
  attachments: UploadedFileInfo[];
}

export interface EditUserPromptRequest extends EditableUserPrompt {
  uuid: string;
  parentUuid: string | null;
}

interface InputImageBlock extends ContentBlock {
  type: "input_image";
  file_path?: string;
  image_url?: string;
  mime_type?: string;
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/** Recognize managed upload URLs and legacy server upload paths. */
export function getUploadUrl(filePath: string): string | null {
  const publicLocation: unknown = filePath;
  if (isManagedUploadDownloadUrl(publicLocation)) return publicLocation;

  const normalized = filePath.replaceAll("\\", "/");
  if (
    !/^(?:\/(?!\/)|[A-Za-z]:\/)/.test(normalized) ||
    !normalized.includes("/uploads/")
  ) {
    return null;
  }
  // Split legacy absolute paths into projectId, sessionId and filename.
  const parts = normalized.split("/");
  if (parts.length < 3) return null;

  const filename = parts[parts.length - 1];
  const sessionId = parts[parts.length - 2];
  const projectId = parts[parts.length - 3];

  if (!filename || !sessionId || !projectId) return null;

  // Validate filename has UUID prefix
  if (!/^[0-9a-f-]{36}_/.test(filename)) return null;

  const url = `/api/projects/${projectId}/sessions/${sessionId}/upload/${encodeURIComponent(filename)}`;
  return isManagedUploadDownloadUrl(url) ? url : null;
}

function isInputImageBlock(block: ContentBlock): block is InputImageBlock {
  return block.type === "input_image" || block.type === "image";
}

function stripCodexImageMarkers(text: string): string {
  // Keep leading blank separators: an image-only upload manifest starts
  // with one, and parseUserPrompt needs it to recognize the manifest.
  return text
    .replace(/<image\b[^>]*>\s*<\/image>/gi, "\n")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !/^<image\b[^>]*>$/i.test(trimmed) && trimmed !== "</image>";
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function parseInlineImageData(imageUrl: string): {
  mimeType?: string;
  bytes?: number;
} {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(imageUrl);
  if (!match) return {};

  const rawMime = match[1]?.trim();
  const mimeType = rawMime || undefined;
  const isBase64 = Boolean(match[2]);
  const payload = (match[3] ?? "").trim();
  if (!payload) return { mimeType };

  if (!isBase64) {
    const decoded = decodeURIComponent(payload);
    return { mimeType, bytes: decoded.length };
  }

  const sanitized = payload.replace(/\s+/g, "");
  const padding = sanitized.endsWith("==")
    ? 2
    : sanitized.endsWith("=")
      ? 1
      : 0;
  const bytes = Math.max(0, Math.floor((sanitized.length * 3) / 4) - padding);
  return { mimeType, bytes };
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getMimeTypeFromPath(path: string): string | undefined {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg"))
    return "image/jpeg";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".bmp")) return "image/bmp";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  return undefined;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/svg+xml") return "svg";
  const slashIndex = normalized.indexOf("/");
  if (slashIndex === -1) return "png";
  const ext = normalized.slice(slashIndex + 1);
  return ext || "png";
}

function filenameFromUrl(imageUrl: string): string | null {
  if (imageUrl.startsWith("data:")) return null;

  try {
    const parsed = new URL(imageUrl, "https://codex.local");
    const pathname = parsed.pathname || "";
    const segment = pathname.split("/").filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
}

const CODEX_INLINE_IMAGE_PATH_PREFIX = "codex-inline://image/";

/**
 * A Codex `input_image` block that carries no identity of its own (no
 * file_path, no URL-derived filename). This includes deferred blocks whose
 * inline payload was stripped server-side, so we can only show a placeholder.
 */
function isAnonymousCodexInlineImage(file: UploadedFileInfo): boolean {
  return file.path.startsWith(CODEX_INLINE_IMAGE_PATH_PREFIX);
}

function extractCodexImageFiles(content: ContentBlock[]): UploadedFileInfo[] {
  const files: UploadedFileInfo[] = [];
  let imageIndex = 0;

  for (const block of content) {
    if (!isInputImageBlock(block)) continue;
    imageIndex += 1;

    const filePath =
      typeof block.file_path === "string" ? block.file_path.trim() : "";
    const source =
      block.source && typeof block.source === "object"
        ? (block.source as Record<string, unknown>)
        : undefined;
    const data = source?.data ?? block.data;
    const nativeMime = source?.media_type ?? block.mimeType;
    const rawImageUrl =
      typeof block.image_url === "string"
        ? block.image_url.trim()
        : typeof source?.url === "string"
          ? source.url.trim()
          : typeof data === "string" &&
              data.trim().length > 0 &&
              typeof nativeMime === "string"
            ? `data:${nativeMime};base64,${data}`
            : "";
    const inlineData = rawImageUrl ? parseInlineImageData(rawImageUrl) : {};
    // Pi keeps data: "" when deferring media; an empty data URI is not an
    // image source and must trigger hydration instead of a zero-byte upload.
    const hasPayload =
      !/^data:/i.test(rawImageUrl) ||
      Boolean(/^data:[^,]*,([\s\S]*)$/i.exec(rawImageUrl)?.[1]?.trim());
    const imageUrl = block.deferred !== true && hasPayload ? rawImageUrl : "";

    const mimeType =
      (typeof block.mime_type === "string" && block.mime_type.trim()) ||
      (typeof nativeMime === "string" && nativeMime.trim()) ||
      inlineData.mimeType ||
      (filePath ? getMimeTypeFromPath(filePath) : undefined) ||
      (imageUrl ? getMimeTypeFromPath(imageUrl) : undefined) ||
      "image/*";

    const fileName =
      (filePath && getFilename(filePath)) ||
      (imageUrl && filenameFromUrl(imageUrl)) ||
      `pasted-image-${imageIndex}.${extensionForMimeType(mimeType)}`;

    const path =
      filePath ||
      (imageUrl && !imageUrl.startsWith("data:") ? imageUrl : "") ||
      `${CODEX_INLINE_IMAGE_PATH_PREFIX}${imageIndex}`;

    files.push({
      originalName: fileName,
      size: formatFileSize(inlineData.bytes),
      mimeType,
      path,
      previewUrl: imageUrl || undefined,
    });
  }

  return files;
}

function mergeUploadedFiles(
  primary: UploadedFileInfo[],
  secondary: UploadedFileInfo[],
): UploadedFileInfo[] {
  const seen = new Set<string>();
  const merged: UploadedFileInfo[] = [];
  const remainingSecondary = [...secondary];

  for (const file of primary) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);

    // A managed upload listed in the prompt text and a Codex input_image
    // block usually describe the same image. Fold the Codex block into the
    // named attachment when it either carries inline preview data or is an
    // anonymous placeholder (e.g. deferred media with image_url stripped),
    // so the same image is not rendered twice.
    const companionIndex = remainingSecondary.findIndex(
      (candidate) =>
        candidate.path === file.path ||
        (!file.previewUrl &&
          isImageMimeType(file.mimeType) &&
          isImageMimeType(candidate.mimeType) &&
          (Boolean(candidate.previewUrl) ||
            isAnonymousCodexInlineImage(candidate))),
    );
    if (companionIndex === -1) {
      merged.push(file);
      continue;
    }

    const [companion] = remainingSecondary.splice(companionIndex, 1);
    if (!companion) {
      merged.push(file);
      continue;
    }
    seen.add(companion.path);
    merged.push({
      ...file,
      ...(companion.previewUrl ? { previewUrl: companion.previewUrl } : {}),
    });
  }

  for (const file of remainingSecondary) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    merged.push(file);
  }

  return merged;
}

/** One interpretation of persisted prompt content for display, copy and editing. */
export function parseUserPromptContent(
  content: string | ContentBlock[],
): ParsedUserPrompt {
  if (typeof content === "string") return parseUserPrompt(content);
  const textContent = content
    .filter(
      (block) =>
        (block.type === "text" || block.type === "input_text") && block.text,
    )
    .map((block) => block.text)
    .join("\n");
  const imageFiles = extractCodexImageFiles(content);
  const parsed = parseUserPrompt(
    imageFiles.length > 0 ? stripCodexImageMarkers(textContent) : textContent,
  );
  return {
    ...parsed,
    uploadedFiles: mergeUploadedFiles(parsed.uploadedFiles, imageFiles),
  };
}

/** Display projections omit native image bytes until their message is loaded. */
export function needsPromptAttachmentHydration(
  attachments: UploadedFileInfo[],
): boolean {
  return attachments.some(
    (file) => isAnonymousCodexInlineImage(file) && !file.previewUrl,
  );
}
