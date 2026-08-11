/**
 * File upload protocol types shared between client and server.
 * Uses WebSocket streaming with binary chunks.
 */

/** Metadata about an uploaded file */
export interface UploadedFile {
  /** Unique identifier (UUID) */
  id: string;
  /** Original filename from client */
  originalName: string;
  /** Sanitized filename on disk (UUID prefix + sanitized original) */
  name: string;
  /** Absolute path on server */
  path: string;
  /** File size in bytes */
  size: number;
  /** MIME type */
  mimeType: string;
}

/**
 * Validate the path-free, authenticated API route used to download a managed
 * user upload. Local filesystem paths must never cross the public boundary;
 * this relative URL is the only attachment location accepted by the client.
 */
export function isManagedUploadDownloadUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;

  const match =
    /^\/api\/projects\/([A-Za-z0-9_-]+)\/sessions\/([A-Za-z0-9._-]+)\/upload\/([^/?#]+)$/.exec(
      value,
    );
  const sessionId = match?.[2];
  const encodedFileName = match?.[3];
  if (
    !sessionId ||
    sessionId.length > 256 ||
    sessionId === "." ||
    sessionId === ".." ||
    !encodedFileName
  ) {
    return false;
  }

  let fileName: string;
  try {
    fileName = decodeURIComponent(encodedFileName);
  } catch {
    return false;
  }

  return (
    encodeURIComponent(fileName) === encodedFileName &&
    fileName.length <= 280 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/.test(
      fileName,
    ) &&
    !fileName.includes("..") &&
    !hasUnsafeManagedUploadFileNameCharacter(fileName.slice(37))
  );
}

function hasUnsafeManagedUploadFileNameCharacter(value: string): boolean {
  if (!value) return true;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      character === "/" ||
      character === "\\"
    ) {
      return true;
    }
  }
  return false;
}

/** Client -> Server: Start upload */
export interface UploadStartMessage {
  type: "start";
  /** Original filename */
  name: string;
  /** Expected total size in bytes */
  size: number;
  /** MIME type (e.g., "image/png", "application/pdf") */
  mimeType: string;
}

/** Client -> Server: End upload */
export interface UploadEndMessage {
  type: "end";
}

/** Client -> Server: Cancel upload */
export interface UploadCancelMessage {
  type: "cancel";
}

/** Server -> Client: Progress update */
export interface UploadProgressMessage {
  type: "progress";
  bytesReceived: number;
}

/** Server -> Client: Upload complete */
export interface UploadCompleteMessage {
  type: "complete";
  file: UploadedFile;
}

/** Server -> Client: Error occurred */
export interface UploadErrorMessage {
  type: "error";
  message: string;
  code?: string;
}

/** All client-to-server message types */
export type UploadClientMessage =
  | UploadStartMessage
  | UploadEndMessage
  | UploadCancelMessage;

/** All server-to-client message types */
export type UploadServerMessage =
  | UploadProgressMessage
  | UploadCompleteMessage
  | UploadErrorMessage;
