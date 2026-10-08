import {
  type UploadedFile,
  isManagedUploadDownloadUrl,
} from "@yep-anywhere/shared";
import { APP_BASE } from "./apiPath";
import {
  countAttachmentTokens,
  insertAttachmentToken,
  sanitizeAttachmentTokenName,
} from "./attachmentTokens";
import type { Connection } from "./connection/types";
import type { UploadedFileInfo } from "./parseUserPrompt";
import { type EditableUserPrompt, getUploadUrl } from "./userPromptContent";

/** Read only attachment routes; prompt text is not authority to call other APIs. */
function readApiAttachment(
  path: string,
  connection: Pick<Connection, "fetchBlob">,
): Promise<Blob> {
  const location: unknown = path;
  if (isManagedUploadDownloadUrl(location)) {
    return connection.fetchBlob(path.slice(4));
  }
  if (path.startsWith("/api/local-image?") && !path.includes("#")) {
    const params = new URLSearchParams(path.slice("/api/local-image?".length));
    const filePath = params.get("path");
    if (params.size === 1 && filePath?.startsWith("/")) {
      return connection.fetchBlob(
        `/local-image?path=${encodeURIComponent(filePath)}`,
      );
    }
  }
  throw new Error("Attachment URL is not an allowed image or upload route");
}

function logicalApiPath(path: string): string {
  return APP_BASE &&
    (path === `${APP_BASE}/api` || path.startsWith(`${APP_BASE}/api/`))
    ? path.slice(APP_BASE.length)
    : path;
}

async function readAttachment(
  attachment: UploadedFileInfo,
  connection: Pick<Connection, "fetchBlob">,
): Promise<Blob> {
  // Managed uploads always use the active authenticated connection, including
  // remote sessions. Never pass their absolute server paths to browser fetch.
  const managedUrl = getUploadUrl(attachment.path);
  if (managedUrl) return connection.fetchBlob(managedUrl.slice(4));

  const previewUrl = (attachment.previewUrl || attachment.path).trim();
  const apiPath = logicalApiPath(previewUrl);
  if (apiPath === "/api" || apiPath.startsWith("/api/")) {
    return readApiAttachment(apiPath, connection);
  }
  if (/^https?:/i.test(previewUrl)) {
    const url = new URL(previewUrl);
    if (url.origin === window.location.origin) {
      return readApiAttachment(
        logicalApiPath(`${url.pathname}${url.search}${url.hash}`),
        connection,
      );
    }
    const response = await fetch(previewUrl, { credentials: "omit" });
    if (!response.ok) {
      throw new Error(`${attachment.originalName}: HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) {
      throw new Error(`Image response unavailable: ${attachment.originalName}`);
    }
    return blob;
  }
  if (/^(?:data:|blob:)/i.test(previewUrl)) {
    const response = await fetch(previewUrl);
    if (!response.ok) {
      throw new Error(`${attachment.originalName}: HTTP ${response.status}`);
    }
    return response.blob();
  }
  if (attachment.path.startsWith("/")) {
    // Provider-native image paths are checked by the server's image allowlist.
    return connection.fetchBlob(
      `/local-image?path=${encodeURIComponent(attachment.path)}`,
    );
  }
  throw new Error(`Attachment unavailable: ${attachment.originalName}`);
}

/** Restore a complete editable document before replacing the current draft. */
export async function restorePromptAttachments(
  prompt: EditableUserPrompt,
  connection: Pick<Connection, "fetchBlob" | "upload">,
  projectId: string,
  sessionId: string,
): Promise<{ text: string; attachments: UploadedFile[] }> {
  // Read every source before uploading. A missing image must fail the whole
  // restoration, rather than let a seemingly valid text-only edit be sent.
  const files = await Promise.all(
    prompt.attachments.map(async (attachment) => {
      const blob = await readAttachment(attachment, connection);
      if (
        blob.size === 0 &&
        (blob.type.startsWith("image/") ||
          attachment.mimeType.startsWith("image/"))
      ) {
        throw new Error(`Image data unavailable: ${attachment.originalName}`);
      }
      return new File([blob], attachment.originalName, {
        type: blob.type || attachment.mimeType,
      });
    }),
  );
  const attachments = await Promise.all(
    files.map((file) => connection.upload(projectId, sessionId, file)),
  );

  let text = prompt.text;
  const occurrences = new Map<string, number>();
  for (const file of attachments) {
    const name = sanitizeAttachmentTokenName(file.originalName);
    const occurrence = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, occurrence);
    if (countAttachmentTokens(text, name) < occurrence) {
      text = insertAttachmentToken(text, text.length, name).text;
    }
  }
  return { text, attachments };
}
