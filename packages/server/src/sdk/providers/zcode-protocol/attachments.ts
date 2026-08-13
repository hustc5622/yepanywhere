/**
 * ZCode wire attachment builder.
 *
 * Maps Yep's queued user message (structured `UploadedFile[]` plus legacy
 * inline base64 image blocks) to the attachment records accepted by the real
 * ZCode CLI 0.16.1 `session/send` method.
 *
 * Wire contract (reverse-engineered from the CLI bundle's attachment
 * normalizer `Hda`, verified 2026-08-13):
 *   - `session/send` params are `.strict()`; `attachments` is an array of
 *     loose records (`z.record(z.string(), z.unknown())`).
 *   - Each record is normalized from:
 *       kind:      "image" | "file" | "audio"
 *       filename:  display name (defaults to "attachment")
 *       localPath: absolute path on the same machine (preferred; the
 *                  app-server child reads the file from disk)
 *       dataBase64: base64 payload (images become `data:` URIs internally)
 *       mimeType / sizeBytes: optional metadata
 *       sourceKind: "clipboard-text" for pasted text files
 *   - Records without a usable kind or payload are silently dropped by the
 *     CLI, so every record built here carries at least `localPath` or
 *     `dataBase64`.
 */

import type { UploadedFile } from "@yep-anywhere/shared";
import type { QueuedUserMessage } from "../../types.js";

/** Attachment record sent over the ZCode app-server protocol. */
export interface ZCodeWireAttachment {
  kind: "image" | "file";
  filename: string;
  localPath?: string;
  dataBase64?: string;
  mimeType?: string;
  sizeBytes?: number;
}

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Build ZCode wire attachments for a queued user message.
 *
 * Returns `undefined` when the message carries no attachments so the
 * `attachments` key can be omitted from the strict `session/send` params.
 */
export function buildZCodeWireAttachments(
  message: QueuedUserMessage,
): ZCodeWireAttachment[] | undefined {
  const out: ZCodeWireAttachment[] = [];

  // Structured uploads (retained because the queue uses preserveAttachments).
  for (const file of message.attachments ?? []) {
    out.push(buildFromUpload(file));
  }

  // Legacy inline base64 images (e.g. pasted screenshots).
  const content = message.message?.content;
  if (Array.isArray(content)) {
    let pastedIndex = 0;
    for (const block of content) {
      if (block?.type !== "image") continue;
      const source = block.source;
      if (source?.type !== "base64" || !source.data) continue;
      pastedIndex += 1;
      const mimeType = source.media_type || "image/png";
      const ext = IMAGE_EXTENSION_BY_MIME[mimeType] ?? "png";
      out.push({
        kind: "image",
        filename: `pasted-image-${pastedIndex}.${ext}`,
        mimeType,
        dataBase64: source.data,
      });
    }
  }

  return out.length > 0 ? out : undefined;
}

function buildFromUpload(file: UploadedFile): ZCodeWireAttachment {
  const isImage =
    typeof file.mimeType === "string" && file.mimeType.startsWith("image/");
  return {
    kind: isImage ? "image" : "file",
    filename: file.originalName || file.name || "attachment",
    localPath: file.path,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(typeof file.size === "number" ? { sizeBytes: file.size } : {}),
  };
}
