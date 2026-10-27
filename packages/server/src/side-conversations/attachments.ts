import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  SIDE_CONVERSATION_MAX_ATTACHMENT_BYTES,
  type SideConversationAttachment,
} from "@yep-anywhere/shared";
import { UPLOADS_DIR } from "../uploads/manager.js";

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
  const root = await realpath(uploadsDir).catch(() => {
    throw new Error("Uploads are unavailable for side conversations.");
  });
  const images: SideImage[] = [];
  for (const attachment of attachments) {
    const mimeType = attachment.mimeType.trim().toLowerCase();
    if (!mimeType.startsWith("image/")) {
      throw new Error(
        `Side conversations accept images only: ${attachment.name}`,
      );
    }
    if (!isAbsolute(attachment.path)) {
      throw new Error(`Attachment is not a Yep upload: ${attachment.name}`);
    }
    const resolved = await realpath(attachment.path).catch(() => {
      throw new Error(`Attachment no longer exists: ${attachment.name}`);
    });
    const fromRoot = relative(root, resolved);
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error(`Attachment is not a Yep upload: ${attachment.name}`);
    }
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new Error(`Attachment is not a file: ${attachment.name}`);
    }
    if (info.size > SIDE_CONVERSATION_MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Image is too large for a side question: ${attachment.name}`,
      );
    }
    images.push({ path: resolved, name: attachment.name, mimeType });
  }
  return images;
}
