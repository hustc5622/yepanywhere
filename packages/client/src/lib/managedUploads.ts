import type { UploadedFile } from "@yep-anywhere/shared";
import { api } from "../api/client";

/**
 * Reuse an upload that is already on the server instead of downloading and
 * uploading it again. The server checks the reference exists; it resolves it
 * once more when the message is sent.
 */
export async function adoptManagedUpload(
  ref: string,
  originalName?: string,
): Promise<UploadedFile> {
  const { entry } = await api.getUploadEntry(ref);
  if (entry.source === "generated") {
    throw new Error(
      `Generated files cannot be attached: ${entry.originalName}`,
    );
  }
  return {
    id: entry.id,
    ref: entry.ref,
    originalName: originalName || entry.originalName,
    name: entry.name,
    size: entry.size,
    mimeType: entry.mimeType,
  };
}
