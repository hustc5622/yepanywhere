import {
  SIDE_CONVERSATION_MAX_ATTACHMENT_BYTES,
  type SideConversationAttachment,
} from "@yep-anywhere/shared";
import {
  ManagedUploadResolutionError,
  UPLOADS_DIR,
  resolveManagedUpload,
} from "../uploads/manager.js";

/** A side question image after validation: a real file inside the uploads dir. */
export interface SideImage {
  path: string;
  name: string;
  mimeType: string;
}

/**
 * Side conversations accept only images the user uploaded through Yep: the
 * request is not authority to make the provider read arbitrary paths.
 */
export async function resolveSideImages(
  attachments: readonly SideConversationAttachment[] | undefined,
  uploadsDir = UPLOADS_DIR,
): Promise<SideImage[]> {
  if (!attachments?.length) return [];
  const images: SideImage[] = [];
  for (const attachment of attachments) {
    const mimeType = attachment.mimeType.trim().toLowerCase();
    if (!mimeType.startsWith("image/")) {
      throw new Error(
        `Side conversations accept images only: ${attachment.name}`,
      );
    }
    const upload = await resolveManagedUpload(
      { ref: attachment.ref, path: attachment.path, mimeType },
      uploadsDir,
    ).catch((error: unknown) => {
      if (error instanceof ManagedUploadResolutionError) {
        throw new Error(`Attachment is not a Yep upload: ${attachment.name}`);
      }
      throw error;
    });
    if (upload.size > SIDE_CONVERSATION_MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Image is too large for a side question: ${attachment.name}`,
      );
    }
    images.push({ path: upload.path, name: attachment.name, mimeType });
  }
  return images;
}
