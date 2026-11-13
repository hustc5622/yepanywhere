/**
 * File upload protocol types shared between client and server.
 * Uses WebSocket streaming with binary chunks.
 */

/**
 * A managed upload as seen by clients. `ref` is its identity: the
 * authenticated download route. Absolute server paths never cross the wire;
 * the server resolves `ref` again whenever the file is used.
 */
export interface UploadedFile {
  /** Unique identifier (UUID) */
  id: string;
  /** Managed upload reference (see {@link managedUploadRef}) */
  ref: string;
  /** Original filename from client */
  originalName: string;
  /** Sanitized filename on disk (UUID prefix + sanitized original) */
  name: string;
  /** File size in bytes */
  size: number;
  /** MIME type */
  mimeType: string;
}

/** Server-only view of a managed upload. Never serialize it to a client. */
export interface StoredUpload extends UploadedFile {
  /** Absolute path on server */
  path: string;
}

/** How a stored file entered Yep. */
export type UploadSource = "web" | "feishu" | "generated";

export interface UploadSessionRef {
  projectId: string;
  sessionId: string;
}

/** One stored file as listed on the uploads page. */
export interface UploadCatalogEntry extends UploadSessionRef {
  /** Managed upload reference; also the identity used to delete the file. */
  ref: string;
  id: string;
  name: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  source: UploadSource;
  /**
   * Sessions that sent this file. Only ever grows: rollback or editing does
   * not remove a session. Files stored before tracking began count their own
   * session.
   */
  usedBy: UploadSessionRef[];
  /** Authenticated download route; absent when the file cannot be served. */
  downloadUrl?: string;
}

export interface UploadTotals {
  count: number;
  bytes: number;
}

export interface UploadSessionSummary extends UploadSessionRef, UploadTotals {
  lastUploadedAt: string;
}

export interface UploadListResponse {
  entries: UploadCatalogEntry[];
  nextCursor: string | null;
  totals: UploadTotals;
}

export interface UploadSessionListResponse {
  sessions: UploadSessionSummary[];
  nextCursor: string | null;
  totals: UploadTotals;
}

/** Where a managed upload lives inside the uploads root. */
export interface ManagedUploadLocation {
  projectId: string;
  sessionId: string;
  fileName: string;
}

const MANAGED_UPLOAD_REF_PATTERN =
  /^\/api\/projects\/([A-Za-z0-9_-]+)\/sessions\/([^/?#]+)\/upload\/([^/?#]+)$/;

/** Session directory names under the uploads root. Dot-directories are internal. */
export function isSafeUploadSessionId(value: string): boolean {
  return value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** `<uuid>_<name>` with no path separators, control characters or `..`. */
export function isSafeManagedUploadFileName(value: string): boolean {
  return (
    value.length <= 280 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/.test(
      value,
    ) &&
    !value.includes("..") &&
    !hasUnsafeManagedUploadFileNameCharacter(value.slice(37))
  );
}

export function managedUploadRef(location: ManagedUploadLocation): string {
  return `/api/projects/${location.projectId}/sessions/${location.sessionId}/upload/${encodeURIComponent(location.fileName)}`;
}

/** Parse a canonical managed upload reference; anything else is rejected. */
export function parseManagedUploadRef(
  value: unknown,
): ManagedUploadLocation | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  const match = MANAGED_UPLOAD_REF_PATTERN.exec(value);
  const projectId = match?.[1];
  const sessionId = match?.[2];
  const encodedFileName = match?.[3];
  if (
    !projectId ||
    !sessionId ||
    !encodedFileName ||
    !isSafeUploadSessionId(sessionId)
  ) {
    return null;
  }

  let fileName: string;
  try {
    fileName = decodeURIComponent(encodedFileName);
  } catch {
    return null;
  }
  if (
    encodeURIComponent(fileName) !== encodedFileName ||
    !isSafeManagedUploadFileName(fileName)
  ) {
    return null;
  }
  return { projectId, sessionId, fileName };
}

/**
 * Validate the path-free, authenticated API route used to download a managed
 * user upload. Local filesystem paths must never cross the public boundary;
 * this relative URL is the only attachment location accepted by the client.
 */
export function isManagedUploadDownloadUrl(value: unknown): value is string {
  return parseManagedUploadRef(value) !== null;
}

/**
 * Map a legacy absolute upload path (`…/uploads/<project>/<session>/<file>`)
 * to its managed reference. Only a shape check: the server still resolves the
 * reference against its own uploads root before trusting it.
 */
export function managedUploadRefFromLegacyPath(
  filePath: string,
): string | null {
  const normalized = filePath.replaceAll("\\", "/");
  if (
    !/^(?:\/(?!\/)|[A-Za-z]:\/)/.test(normalized) ||
    !normalized.includes("/uploads/")
  ) {
    return null;
  }
  const parts = normalized.split("/");
  const fileName = parts.at(-1);
  const sessionId = parts.at(-2);
  const projectId = parts.at(-3);
  if (!fileName || !sessionId || !projectId) return null;
  const ref = managedUploadRef({ projectId, sessionId, fileName });
  return parseManagedUploadRef(ref) ? ref : null;
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
