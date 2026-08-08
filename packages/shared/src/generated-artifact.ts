/**
 * Public, path-free description of an artifact produced by an agent turn.
 *
 * The server may retain a private filesystem path internally, but only this
 * manifest (and its opaque managed reference) is allowed onto client/channel
 * transports.
 */
export type GeneratedArtifactKind =
  | "image"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "text"
  | "video";

export type GeneratedArtifactSourceType = "image_generation" | "file_change";

export interface GeneratedArtifactSource {
  provider: "codex";
  type: GeneratedArtifactSourceType;
  threadId: string;
  turnId: string;
  itemId: string;
}

export interface GeneratedArtifactRetention {
  policy: "temporary";
  expiresAt: string;
}

export interface GeneratedArtifactManifest {
  schemaVersion: 1;
  /** Random/opaque public identity; never a local path or provider filename. */
  id: string;
  /** Opaque server-managed reference meaningful only inside the task scope. */
  managedRef: string;
  fileName: string;
  kind: GeneratedArtifactKind;
  mimeType: string;
  sizeBytes: number;
  /** Content digest captured from the validated managed copy. */
  sha256: string;
  source: GeneratedArtifactSource;
  retention: GeneratedArtifactRetention;
  /** Authenticated Yep API path. */
  downloadUrl: string;
  /** Present only for formats the browser can safely preview. */
  previewUrl?: string;
}

export type GeneratedArtifactBlockReason =
  | "invalid_payload"
  | "scope_mismatch"
  | "outside_workspace"
  | "not_regular_file"
  | "hard_link"
  | "cross_device"
  | "symlink"
  | "changed_during_read"
  | "size_limit"
  | "count_limit"
  | "sensitive_content"
  | "high_risk_archive"
  | "mime_mismatch"
  | "unsupported_format"
  | "storage_failed";

export interface GeneratedArtifactWarning {
  sourceId: string;
  reason: GeneratedArtifactBlockReason;
}

/** Validate the canonical, relative Yep route carried by public manifests. */
export function isGeneratedArtifactDownloadUrl(
  value: unknown,
): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  const match =
    /^\/api\/projects\/([A-Za-z0-9_-]+)\/sessions\/([A-Za-z0-9._-]+)\/generated-artifact\/(ga_[a-f0-9]{32})\/([a-f0-9]{64})\/([^/?#]+)$/.exec(
      value,
    );
  const sessionId = match?.[2];
  const encodedFileName = match?.[5];
  if (
    !sessionId ||
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
    fileName.length > 0 &&
    fileName.length <= 280 &&
    !fileName.includes("..") &&
    !hasUnsafeRouteFileNameCharacter(fileName)
  );
}

function hasUnsafeRouteFileNameCharacter(value: string): boolean {
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
