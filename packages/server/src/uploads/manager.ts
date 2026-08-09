import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  type BigIntStats,
  type WriteStream,
  createWriteStream,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import {
  type GeneratedArtifactKind,
  type GeneratedArtifactManifest,
  type GeneratedArtifactSource,
  type UploadedFile,
  isGeneratedArtifactDownloadUrl,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { getDataDir } from "../config.js";

/** Root directory for uploads (uses dataDir from config for profile support) */
export const UPLOADS_DIR = join(getDataDir(), "uploads");

/**
 * State machine for a single upload operation.
 * Handles streaming chunks to disk with proper cleanup on error.
 */
export interface UploadState {
  id: string;
  originalName: string;
  sanitizedName: string;
  filePath: string;
  expectedSize: number | null;
  bytesReceived: number;
  mimeType: string;
  writeStream: WriteStream | null;
  status: "pending" | "streaming" | "complete" | "error" | "cancelled";
}

/**
 * Sanitize filename to prevent path traversal and invalid characters.
 *
 * - Strips directory components (handles both Unix and Windows paths)
 * - Replaces dangerous characters
 * - Adds UUID prefix to prevent collisions
 */
export function sanitizeFilename(original: string): {
  id: string;
  sanitized: string;
} {
  const id = randomUUID();

  // Extract just the filename (handle both Unix and Windows path separators)
  // On Linux, basename() doesn't handle Windows paths, so we manually split first
  let baseFilename = original;
  const lastSlash = Math.max(
    original.lastIndexOf("/"),
    original.lastIndexOf("\\"),
  );
  if (lastSlash >= 0) {
    baseFilename = original.slice(lastSlash + 1);
  }

  // Remove null bytes and other dangerous characters
  let sanitized = baseFilename
    .replace(/\0/g, "")
    .replace(/[<>:"/\\|?*]/g, "_") // Windows-invalid chars (includes path separators)
    .replace(/\.\./g, "_") // path traversal
    .trim();

  // Handle empty or only-underscore/dot names
  if (!sanitized || /^[_.\s]*$/.test(sanitized)) {
    sanitized = "unnamed";
  }

  // Ensure reasonable length (keep extension)
  const ext = extname(sanitized);
  const nameWithoutExt = sanitized.slice(0, sanitized.length - ext.length);
  if (nameWithoutExt.length > 200) {
    sanitized = nameWithoutExt.slice(0, 200) + ext;
  }

  // Prefix with UUID
  return {
    id,
    sanitized: `${id}_${sanitized}`,
  };
}

/**
 * Get the upload directory for a project+session.
 * Creates the directory if it doesn't exist.
 *
 * @param encodedProjectPath - base64url encoded project path
 * @param sessionId - Session identifier
 * @param uploadsDir - Base uploads directory (defaults to UPLOADS_DIR)
 */
export async function getUploadDir(
  encodedProjectPath: string,
  sessionId: string,
  uploadsDir: string = UPLOADS_DIR,
): Promise<string> {
  if (!isUrlProjectId(encodedProjectPath)) {
    throw new Error("Invalid upload project ID");
  }
  if (!isSafePathSegment(sessionId)) {
    throw new Error("Invalid upload session ID");
  }
  const dir = join(uploadsDir, encodedProjectPath, sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface UploadManagerOptions {
  uploadsDir?: string;
  /** Maximum upload file size in bytes. 0 = unlimited */
  maxUploadSizeBytes?: number;
}

export interface IngestUploadInput {
  projectId: string;
  sessionId: string;
  originalName: string;
  mimeType: string;
  expectedSize?: number;
  stream: AsyncIterable<Uint8Array>;
  /** Server-only storage class. Browser/user uploads always use `user`. */
  storageClass?: "user" | "generated";
}

export interface DerivedUploadArtifactInput {
  projectId: string;
  sessionId: string;
  source: UploadedFile;
  kind: "text" | "metadata" | "archive-index";
  label: string;
  mime: string;
  content: Uint8Array;
}

export interface DerivedUploadArtifact {
  kind: DerivedUploadArtifactInput["kind"];
  pathRef: string;
  mime: string;
  sizeBytes: number;
}

export interface AttachmentStorageScope {
  projectId: string;
  sessionId: string;
}

export interface TaskAttachmentScope extends AttachmentStorageScope {
  taskId: string;
}

export interface TaskAttachmentRetentionRecord extends TaskAttachmentScope {
  schemaVersion: 1;
  attachmentIds: string[];
  createdAtMs: number;
  expiresAtMs: number;
}

export interface GeneratedArtifactStorageRecord extends AttachmentStorageScope {
  schemaVersion: 1;
  artifactId: string;
  managedRef: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAtMs: number;
  expiresAtMs: number;
  /** Added records bind the managed copy to one exact canonical journal item. */
  kind?: GeneratedArtifactKind;
  source?: GeneratedArtifactSource;
  canonicalEvent?: {
    eventId: string;
    sequence: number;
  };
}

export interface GeneratedArtifactReplayEvent {
  eventId: string;
  sequence: number;
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
}

export interface GeneratedArtifactReadExpectation {
  artifactId: string;
  sha256: string;
  fileName?: string;
  managedRef?: string;
  mimeType?: string;
  sizeBytes?: number;
  expiresAtMs?: number;
}

export interface GeneratedArtifactReadResult {
  record: GeneratedArtifactStorageRecord;
  bytes: Uint8Array;
}

export interface AttachmentRetentionCleanupResult {
  scannedTasks: number;
  removedTasks: number;
  removedBytes: number;
  skippedTasks: number;
  failures: Array<{
    taskRef: string;
    code: "INVALID_RETENTION_RECORD" | "CLEANUP_FAILED";
  }>;
}

const CONTAINER_PROBE_LIMIT = 2 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_EXPANSION_RATIO = 100;
const DERIVED_DIR_NAME = ".derived";
const RETENTION_DIR_NAME = ".retention";
const GENERATED_ARTIFACT_REGISTRY_DIR_NAME = ".generated";
const MAX_RETENTION_RECORD_BYTES = 16 * 1024;
const MAX_GENERATED_ARTIFACT_RECORD_BYTES = 16 * 1024;
const MAX_GENERATED_ARTIFACT_REGISTRY_ENTRIES = 4_096;
const MAX_GENERATED_ARTIFACT_REPLAY_COUNT = 64;
const MAX_GENERATED_ARTIFACT_REPLAY_BYTES = 64 * 1024 * 1024;
const GENERATED_ARTIFACT_STORAGE_MARKER = ".yep-generated-";

export class UploadContainerError extends Error {
  readonly code:
    | "ARCHIVE_PATH_TRAVERSAL"
    | "ARCHIVE_BOMB"
    | "PASSWORD_PROTECTED";

  constructor(code: UploadContainerError["code"]) {
    super(code);
    this.name = "UploadContainerError";
    this.code = code;
  }
}

export class GeneratedArtifactAccessError extends Error {
  readonly code: "NOT_FOUND" | "EXPIRED" | "INTEGRITY" | "INVALID";

  constructor(code: GeneratedArtifactAccessError["code"]) {
    super(code);
    this.name = "GeneratedArtifactAccessError";
    this.code = code;
  }
}

/**
 * Manages file upload operations with streaming to disk.
 */
export class UploadManager {
  private uploads = new Map<string, UploadState>();
  private uploadsDir: string;
  private maxUploadSizeBytes: number;
  /** Fair bounded cursor for repeated retention sweeps. */
  private cleanupCursor: string | null = null;

  constructor(options: UploadManagerOptions = {}) {
    this.uploadsDir = options.uploadsDir ?? UPLOADS_DIR;
    this.maxUploadSizeBytes = options.maxUploadSizeBytes ?? 0;
    if (
      !Number.isSafeInteger(this.maxUploadSizeBytes) ||
      this.maxUploadSizeBytes < 0
    ) {
      throw new Error("Invalid maximum upload size");
    }
  }

  /**
   * Start a new upload.
   *
   * @returns Upload ID for tracking this upload
   * @throws Error if file size exceeds maxUploadSizeBytes limit
   */
  async startUpload(
    encodedProjectPath: string,
    sessionId: string,
    originalName: string,
    expectedSize: number | null,
    mimeType: string,
    storageClass: "user" | "generated" = "user",
  ): Promise<{ uploadId: string; state: UploadState }> {
    if (!isUrlProjectId(encodedProjectPath)) {
      throw new Error("Invalid upload project ID");
    }
    if (!isSafePathSegment(sessionId)) {
      throw new Error("Invalid upload session ID");
    }
    if (
      expectedSize !== null &&
      (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
    ) {
      throw new Error("Invalid expected upload size");
    }
    // Check file size limit
    if (
      this.maxUploadSizeBytes > 0 &&
      expectedSize !== null &&
      expectedSize > this.maxUploadSizeBytes
    ) {
      const maxMB = Math.round(this.maxUploadSizeBytes / (1024 * 1024));
      throw new Error(`File size exceeds maximum allowed size of ${maxMB}MB`);
    }

    const uploadDir = await getUploadDir(
      encodedProjectPath,
      sessionId,
      this.uploadsDir,
    );
    const { id, sanitized } = sanitizeFilename(originalName);
    const publicSuffix = sanitized.slice(id.length + 1);
    const storageName =
      storageClass === "generated"
        ? `${id}_${GENERATED_ARTIFACT_STORAGE_MARKER}${publicSuffix}`
        : publicSuffix.startsWith(GENERATED_ARTIFACT_STORAGE_MARKER)
          ? `${id}_user-${publicSuffix}`
          : sanitized;
    const filePath = join(uploadDir, storageName);
    await assertContainedUploadPath(this.uploadsDir, filePath);

    const state: UploadState = {
      id,
      originalName,
      sanitizedName: storageName,
      filePath,
      expectedSize,
      bytesReceived: 0,
      mimeType: normalizeMimeType(mimeType),
      writeStream: null,
      status: "pending",
    };

    this.uploads.set(id, state);
    return { uploadId: id, state };
  }

  /**
   * Write a chunk of data to the upload.
   * Opens the write stream on first chunk (lazy initialization).
   * @throws Error if writing would exceed maxUploadSizeBytes limit
   */
  async writeChunk(uploadId: string, chunk: Buffer): Promise<number> {
    const state = this.uploads.get(uploadId);
    if (!state) {
      throw new Error(`Upload not found: ${uploadId}`);
    }

    if (state.status === "cancelled" || state.status === "error") {
      throw new Error(`Upload is ${state.status}`);
    }

    const newTotal = state.bytesReceived + chunk.length;
    if (!Number.isSafeInteger(newTotal)) {
      throw new Error("Upload size exceeds safe integer range");
    }
    if (state.expectedSize !== null && newTotal > state.expectedSize) {
      throw new Error("Upload exceeds declared size");
    }

    // Check if this chunk would exceed the size limit
    if (this.maxUploadSizeBytes > 0) {
      if (newTotal > this.maxUploadSizeBytes) {
        const maxMB = Math.round(this.maxUploadSizeBytes / (1024 * 1024));
        throw new Error(`Upload exceeds maximum allowed size of ${maxMB}MB`);
      }
    }

    // Lazy-create write stream on first chunk
    if (!state.writeStream) {
      state.writeStream = createWriteStream(state.filePath, {
        flags: "wx",
        mode: 0o600,
      });
      state.status = "streaming";

      // Handle stream errors
      state.writeStream.on("error", () => {
        state.status = "error";
      });
    }

    // Write chunk and track bytes
    return new Promise((resolve, reject) => {
      const canContinue = state.writeStream?.write(chunk, (err) => {
        if (err) {
          state.status = "error";
          reject(err);
        } else {
          state.bytesReceived += chunk.length;
          resolve(state.bytesReceived);
        }
      });

      // Handle backpressure - wait for drain if buffer is full
      if (!canContinue) {
        state.writeStream?.once("drain", () => {
          // Already resolved in callback above
        });
      }
    });
  }

  /**
   * Complete an upload.
   * Closes the write stream and verifies the file.
   */
  async completeUpload(uploadId: string): Promise<UploadedFile> {
    const state = this.uploads.get(uploadId);
    if (!state) {
      throw new Error(`Upload not found: ${uploadId}`);
    }

    if (state.status !== "streaming" && state.status !== "pending") {
      throw new Error(`Cannot complete upload in status: ${state.status}`);
    }

    // Materialize a declared empty upload even if the transport sent no chunk.
    if (!state.writeStream) {
      const handle = await open(state.filePath, "wx", 0o600);
      await handle.close();
    }

    // Close the write stream
    if (state.writeStream) {
      await new Promise<void>((resolve, reject) => {
        state.writeStream?.end((err: Error | null | undefined) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    // Verify the final path is still the regular file created for this upload.
    await assertContainedExistingUploadPath(this.uploadsDir, state.filePath);
    const stats = await lstat(state.filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new Error("Completed upload is not a regular managed file");
    }
    if (
      state.expectedSize !== null &&
      (state.bytesReceived !== state.expectedSize ||
        stats.size !== state.expectedSize)
    ) {
      throw new Error("Upload size did not match expected size");
    }

    state.status = "complete";
    this.uploads.delete(uploadId);

    return {
      id: state.id,
      originalName: state.originalName,
      name: state.sanitizedName,
      path: state.filePath,
      size: stats.size,
      mimeType: state.mimeType,
    };
  }

  /**
   * Cancel or cleanup a failed upload.
   * Closes stream and removes partial file.
   */
  async cancelUpload(uploadId: string): Promise<void> {
    const state = this.uploads.get(uploadId);
    if (!state) {
      return; // Already cleaned up
    }

    state.status = "cancelled";

    // Close the write stream
    if (state.writeStream) {
      state.writeStream.destroy();
    }

    // Remove partial file
    try {
      await rm(state.filePath, { force: true });
    } catch {
      // Ignore - file may not exist yet
    }

    this.uploads.delete(uploadId);
  }

  /**
   * Import a trusted server-side stream through the same upload state machine
   * used by browser uploads. This is intentionally transport-agnostic so
   * channel adapters do not need to impersonate a WebSocket client.
   */
  async ingest(input: IngestUploadInput): Promise<UploadedFile> {
    const expectedSize = input.expectedSize ?? null;
    const { uploadId, state } = await this.startUpload(
      input.projectId,
      input.sessionId,
      input.originalName,
      expectedSize,
      normalizeMimeType(input.mimeType),
      input.storageClass ?? "user",
    );

    try {
      await assertContainedUploadPath(this.uploadsDir, state.filePath);
      let prefix = Buffer.alloc(0);
      let containerProbe = Buffer.alloc(0);
      let receivedAnyChunk = false;
      for await (const value of input.stream) {
        const chunk = Buffer.from(value);
        receivedAnyChunk = true;
        if (prefix.length < 16) {
          prefix = Buffer.concat([
            prefix,
            chunk.subarray(0, 16 - prefix.length),
          ]);
        }
        if (containerProbe.length < CONTAINER_PROBE_LIMIT) {
          containerProbe = Buffer.concat([
            containerProbe,
            chunk.subarray(0, CONTAINER_PROBE_LIMIT - containerProbe.length),
          ]);
        }
        await this.writeChunk(uploadId, chunk);
      }

      if (!receivedAnyChunk) {
        await this.writeChunk(uploadId, Buffer.alloc(0));
      }
      state.mimeType = detectMimeType(prefix, containerProbe) ?? state.mimeType;
      return await this.completeUpload(uploadId);
    } catch (error) {
      await this.cancelUpload(uploadId);
      throw error;
    }
  }

  /**
   * Persist a bounded extraction artifact beside its source attachment. The
   * returned reference is opaque and contains no absolute filesystem path.
   */
  async writeDerivedArtifact(
    input: DerivedUploadArtifactInput,
  ): Promise<DerivedUploadArtifact> {
    assertStorageScope(input);
    if (!/^[A-Za-z0-9-]{1,128}$/.test(input.source.id)) {
      throw new Error("Invalid source attachment ID");
    }
    if (input.content.byteLength > 2 * 1024 * 1024) {
      throw new Error("Derived artifact exceeds maximum allowed size");
    }
    await assertContainedUploadPath(this.uploadsDir, input.source.path);
    const sourceRealPath = await realpath(input.source.path);
    if (
      !(await isPathInsideTaskDir(
        this.uploadsDir,
        input.projectId,
        input.sessionId,
        sourceRealPath,
      ))
    ) {
      throw new Error("Source attachment is outside the requested task scope");
    }

    const taskDir = taskUploadDir(
      this.uploadsDir,
      input.projectId,
      input.sessionId,
    );
    const artifactId = randomUUID();
    const safeLabel = sanitizeArtifactLabel(input.label);
    const artifactDir = join(taskDir, DERIVED_DIR_NAME, input.source.id);
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    await assertContainedUploadPath(
      this.uploadsDir,
      join(artifactDir, safeLabel),
    );
    const artifactPath = join(artifactDir, `${artifactId}_${safeLabel}`);
    const handle = await open(artifactPath, "wx", 0o600);
    try {
      await handle.writeFile(input.content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return {
      kind: input.kind,
      pathRef: `upload:${input.source.id}:artifact:${artifactId}`,
      mime: normalizeMimeType(input.mime),
      sizeBytes: input.content.byteLength,
    };
  }

  /**
   * Resolve an opaque upload reference inside a known task scope. This method
   * is server-only; callers must not serialize the returned absolute path.
   */
  async resolveTaskPathRef(
    scope: AttachmentStorageScope,
    pathRef: string,
  ): Promise<string> {
    assertStorageScope(scope);
    const parsed = parseUploadPathRef(pathRef);
    const taskDir = taskUploadDir(
      this.uploadsDir,
      scope.projectId,
      scope.sessionId,
    );
    const taskEntries = await readdir(taskDir, { withFileTypes: true });
    let candidate: string | undefined;
    if (parsed.artifactId) {
      const artifactDir = join(taskDir, DERIVED_DIR_NAME, parsed.attachmentId);
      const entries = await readdir(artifactDir, { withFileTypes: true });
      candidate = entries.find(
        (entry) =>
          entry.isFile() && entry.name.startsWith(`${parsed.artifactId}_`),
      )?.name;
      if (candidate) candidate = join(artifactDir, candidate);
    } else {
      const entry = taskEntries.find(
        (item) =>
          item.isFile() && item.name.startsWith(`${parsed.attachmentId}_`),
      );
      if (entry) candidate = join(taskDir, entry.name);
    }
    if (!candidate) throw new Error("Upload path reference was not found");
    const resolved = await realpath(candidate);
    if (
      !(await isPathInsideTaskDir(
        this.uploadsDir,
        scope.projectId,
        scope.sessionId,
        resolved,
      ))
    ) {
      throw new Error("Upload path reference escapes task scope");
    }
    return resolved;
  }

  /**
   * Read an opaque managed reference without following a last-minute symlink
   * or allowing a file to grow beyond the caller's delivery limit. This is
   * used by outbound channel adapters after artifact materialization; provider
   * supplied paths must never be passed here directly.
   */
  async readTaskPathRefBytes(
    scope: AttachmentStorageScope,
    pathRef: string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Invalid managed read limit");
    }
    const resolved = await this.resolveTaskPathRef(scope, pathRef);
    const before = await lstat(resolved, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size <= 0n ||
      before.size > BigInt(maxBytes)
    ) {
      throw new Error("Managed reference is not a bounded regular file");
    }

    const handle = await open(
      resolved,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameStableFile(before, opened)) {
        throw new Error("Managed file changed before it could be read");
      }
      const chunks: Buffer[] = [];
      let position = 0;
      for (;;) {
        const remaining = maxBytes + 1 - position;
        if (remaining <= 0) {
          throw new Error("Managed file exceeds the delivery limit");
        }
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (bytesRead === 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (!sameStableFile(opened, after) || BigInt(position) !== after.size) {
        throw new Error("Managed file changed while it was being read");
      }
      const resolvedAfter = await realpath(resolved);
      if (resolvedAfter !== resolved) {
        throw new Error(
          "Managed file identity changed while it was being read",
        );
      }
      return Buffer.concat(chunks, position);
    } finally {
      await handle.close();
    }
  }

  /**
   * Register a generated artifact after its managed copy and retention record
   * both exist. The registry is the explicit discriminator between generated
   * output and an ordinary user upload.
   */
  async registerGeneratedArtifact(
    record: GeneratedArtifactStorageRecord,
  ): Promise<GeneratedArtifactStorageRecord> {
    assertGeneratedArtifactRecord(record);
    const parsedRef = parseUploadPathRef(record.managedRef);
    if (parsedRef.artifactId) {
      throw new GeneratedArtifactAccessError("INVALID");
    }
    const storagePath = await this.resolveTaskPathRef(
      record,
      record.managedRef,
    );
    if (!isGeneratedArtifactStorageFilename(basename(storagePath))) {
      throw new GeneratedArtifactAccessError("INVALID");
    }
    const retention = await this.getTaskAttachmentRetention({
      projectId: record.projectId,
      sessionId: record.sessionId,
      taskId: `generated-${parsedRef.attachmentId}`,
    });
    if (
      !retention ||
      !retention.attachmentIds.includes(parsedRef.attachmentId) ||
      retention.createdAtMs !== record.createdAtMs ||
      retention.expiresAtMs !== record.expiresAtMs
    ) {
      throw new GeneratedArtifactAccessError("INVALID");
    }
    const bytes = await this.readTaskPathRefBytes(
      record,
      record.managedRef,
      record.sizeBytes,
    );
    if (
      bytes.byteLength !== record.sizeBytes ||
      sha256Digest(bytes) !== record.sha256
    ) {
      throw new GeneratedArtifactAccessError("INTEGRITY");
    }

    const registryDir = generatedArtifactRegistryDir(
      this.uploadsDir,
      record.projectId,
      record.sessionId,
    );
    await mkdir(registryDir, { recursive: true, mode: 0o700 });
    const finalPath = join(registryDir, `${record.artifactId}.json`);
    await assertContainedUploadPath(this.uploadsDir, finalPath);
    const existing = await readGeneratedArtifactRecord(
      finalPath,
      record,
      this.uploadsDir,
    );
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new GeneratedArtifactAccessError("INTEGRITY");
      }
      return structuredClone(existing);
    }
    const temporaryPath = join(
      registryDir,
      `.${record.artifactId}-${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, finalPath);
      return structuredClone(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = await readGeneratedArtifactRecord(
        finalPath,
        record,
        this.uploadsDir,
      );
      if (!winner || JSON.stringify(winner) !== JSON.stringify(record)) {
        throw new GeneratedArtifactAccessError("INTEGRITY");
      }
      return structuredClone(winner);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  /**
   * Rebuild public manifests from the private registry after reconnect/restart.
   *
   * A record is returned only when its exact item event exists in the selected
   * canonical source and the registry, retention metadata, managed bytes and
   * content hash all still validate. Provider and bridge journals therefore
   * cannot be merged through the artifact sidecar.
   */
  async listReplayableGeneratedArtifacts(
    scope: AttachmentStorageScope,
    canonicalEvents: readonly GeneratedArtifactReplayEvent[],
    nowMs = Date.now(),
  ): Promise<GeneratedArtifactManifest[]> {
    assertStorageScope(scope);
    if (!Number.isSafeInteger(nowMs)) {
      throw new GeneratedArtifactAccessError("INVALID");
    }
    const eventsById = new Map(
      canonicalEvents
        .filter(
          (event) =>
            event.method === "item/completed" &&
            event.threadId !== undefined &&
            event.turnId !== undefined &&
            event.itemId !== undefined,
        )
        .map((event) => [event.eventId, event] as const),
    );
    if (eventsById.size === 0) return [];

    const registryDir = generatedArtifactRegistryDir(
      this.uploadsDir,
      scope.projectId,
      scope.sessionId,
    );
    const entries = await readdir(registryDir, {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (entries.length > MAX_GENERATED_ARTIFACT_REGISTRY_ENTRIES) return [];

    const manifests: Array<{
      sequence: number;
      manifest: GeneratedArtifactManifest;
    }> = [];
    const seenArtifactIds = new Set<string>();
    let attemptedArtifactCount = 0;
    let attemptedArtifactBytes = 0;
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isFile() || !/^ga_[a-f0-9]{32}\.json$/.test(entry.name)) {
        continue;
      }
      let record: GeneratedArtifactStorageRecord | null;
      try {
        record = await readGeneratedArtifactRecord(
          join(registryDir, entry.name),
          scope,
          this.uploadsDir,
        );
      } catch {
        continue;
      }
      if (
        !record ||
        !record.kind ||
        !record.source ||
        !record.canonicalEvent ||
        seenArtifactIds.has(record.artifactId)
      ) {
        continue;
      }
      const event = eventsById.get(record.canonicalEvent.eventId);
      if (
        !event ||
        record.canonicalEvent.sequence !== event.sequence ||
        record.source.threadId !== event.threadId ||
        record.source.turnId !== event.turnId ||
        record.source.itemId !== event.itemId ||
        record.expiresAtMs <= nowMs
      ) {
        continue;
      }
      if (
        attemptedArtifactCount >= MAX_GENERATED_ARTIFACT_REPLAY_COUNT ||
        attemptedArtifactBytes + record.sizeBytes >
          MAX_GENERATED_ARTIFACT_REPLAY_BYTES
      ) {
        continue;
      }
      attemptedArtifactCount += 1;
      attemptedArtifactBytes += record.sizeBytes;

      try {
        await this.readGeneratedArtifactBytes(
          scope,
          {
            artifactId: record.artifactId,
            managedRef: record.managedRef,
            fileName: record.fileName,
            mimeType: record.mimeType,
            sizeBytes: record.sizeBytes,
            sha256: record.sha256,
            expiresAtMs: record.expiresAtMs,
          },
          nowMs,
        );
      } catch {
        continue;
      }

      const downloadUrl = `/api/projects/${encodeURIComponent(
        scope.projectId,
      )}/sessions/${encodeURIComponent(
        scope.sessionId,
      )}/generated-artifact/${record.artifactId}/${record.sha256.slice(
        "sha256:".length,
      )}/${encodeURIComponent(record.fileName)}`;
      if (!isGeneratedArtifactDownloadUrl(downloadUrl)) continue;
      const manifest: GeneratedArtifactManifest = {
        schemaVersion: 1,
        id: record.artifactId,
        managedRef: record.managedRef,
        fileName: record.fileName,
        kind: record.kind,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        source: structuredClone(record.source),
        retention: {
          policy: "temporary",
          expiresAt: new Date(record.expiresAtMs).toISOString(),
        },
        downloadUrl,
        ...(record.kind === "image" ? { previewUrl: downloadUrl } : {}),
      };
      seenArtifactIds.add(record.artifactId);
      manifests.push({
        sequence: record.canonicalEvent.sequence,
        manifest,
      });
    }
    return manifests
      .sort(
        (left, right) =>
          left.sequence - right.sequence ||
          left.manifest.id.localeCompare(right.manifest.id),
      )
      .map(({ manifest }) => manifest);
  }

  /**
   * Resolve and verify a generated artifact for HTTP or channel delivery.
   * Missing/expired retention and registry state always fail closed.
   */
  async readGeneratedArtifactBytes(
    scope: AttachmentStorageScope,
    expected: GeneratedArtifactReadExpectation,
    nowMs = Date.now(),
  ): Promise<GeneratedArtifactReadResult> {
    assertStorageScope(scope);
    assertGeneratedArtifactExpectation(expected);
    if (!Number.isSafeInteger(nowMs)) {
      throw new GeneratedArtifactAccessError("INVALID");
    }
    const record = await readGeneratedArtifactRecord(
      join(
        generatedArtifactRegistryDir(
          this.uploadsDir,
          scope.projectId,
          scope.sessionId,
        ),
        `${expected.artifactId}.json`,
      ),
      scope,
      this.uploadsDir,
    );
    if (!record) throw new GeneratedArtifactAccessError("NOT_FOUND");
    if (!matchesGeneratedArtifactExpectation(record, expected)) {
      throw new GeneratedArtifactAccessError("NOT_FOUND");
    }
    if (record.expiresAtMs <= nowMs) {
      throw new GeneratedArtifactAccessError("EXPIRED");
    }
    const parsedRef = parseUploadPathRef(record.managedRef);
    const retention = await this.getTaskAttachmentRetention({
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      taskId: `generated-${parsedRef.attachmentId}`,
    });
    if (
      !retention ||
      retention.expiresAtMs <= nowMs ||
      retention.expiresAtMs !== record.expiresAtMs ||
      retention.createdAtMs !== record.createdAtMs ||
      !retention.attachmentIds.includes(parsedRef.attachmentId)
    ) {
      throw new GeneratedArtifactAccessError(
        retention?.expiresAtMs !== undefined && retention.expiresAtMs <= nowMs
          ? "EXPIRED"
          : "NOT_FOUND",
      );
    }
    let bytes: Uint8Array;
    try {
      const storagePath = await this.resolveTaskPathRef(
        scope,
        record.managedRef,
      );
      if (!isGeneratedArtifactStorageFilename(basename(storagePath))) {
        throw new GeneratedArtifactAccessError("INTEGRITY");
      }
      bytes = await this.readTaskPathRefBytes(
        scope,
        record.managedRef,
        record.sizeBytes,
      );
    } catch {
      throw new GeneratedArtifactAccessError("INTEGRITY");
    }
    if (
      bytes.byteLength !== record.sizeBytes ||
      sha256Digest(bytes) !== record.sha256
    ) {
      throw new GeneratedArtifactAccessError("INTEGRITY");
    }
    return { record: structuredClone(record), bytes };
  }

  /** Assign a task-scoped expiry without exposing the storage path. */
  async setTaskAttachmentRetention(
    scope: TaskAttachmentScope,
    attachmentIds: string[],
    expiresAtMs: number,
    nowMs = Date.now(),
  ): Promise<TaskAttachmentRetentionRecord> {
    assertTaskScope(scope);
    const uniqueAttachmentIds = [...new Set(attachmentIds)].sort();
    if (
      uniqueAttachmentIds.length === 0 ||
      uniqueAttachmentIds.some((id) => !isSafeAttachmentId(id))
    ) {
      throw new Error("Invalid task attachment IDs");
    }
    if (
      !Number.isSafeInteger(expiresAtMs) ||
      !Number.isSafeInteger(nowMs) ||
      expiresAtMs <= nowMs
    ) {
      throw new Error("Invalid attachment retention expiry");
    }
    const taskDir = taskUploadDir(
      this.uploadsDir,
      scope.projectId,
      scope.sessionId,
    );
    await mkdir(taskDir, { recursive: true, mode: 0o700 });
    const retentionDir = join(taskDir, RETENTION_DIR_NAME);
    await mkdir(retentionDir, { recursive: true, mode: 0o700 });
    await assertContainedUploadPath(
      this.uploadsDir,
      join(retentionDir, `${scope.taskId}.json`),
    );
    const record: TaskAttachmentRetentionRecord = {
      schemaVersion: 1,
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      taskId: scope.taskId,
      attachmentIds: uniqueAttachmentIds,
      createdAtMs: nowMs,
      expiresAtMs,
    };
    const temporaryPath = join(
      retentionDir,
      `.${scope.taskId}-${randomUUID()}.tmp`,
    );
    const finalPath = join(retentionDir, `${scope.taskId}.json`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, finalPath);
    return record;
  }

  /** Read a task-scoped retention record without exposing its local path. */
  async getTaskAttachmentRetention(
    scope: TaskAttachmentScope,
  ): Promise<TaskAttachmentRetentionRecord | null> {
    assertTaskScope(scope);
    const record = await readRetentionRecord(
      join(
        taskUploadDir(this.uploadsDir, scope.projectId, scope.sessionId),
        RETENTION_DIR_NAME,
        `${scope.taskId}.json`,
      ),
      scope,
      this.uploadsDir,
    );
    return record ? structuredClone(record) : null;
  }

  /**
   * Remove an exact set of task-scoped source files and derived artifacts.
   * This is the fail-closed cleanup path when a retention record could not be
   * persisted; it deliberately does not require or remove a retention record.
   */
  async discardTaskAttachments(
    scope: AttachmentStorageScope,
    attachmentIds: string[],
  ): Promise<{ removedBytes: number }> {
    assertStorageScope(scope);
    const uniqueAttachmentIds = [...new Set(attachmentIds)].sort();
    if (
      uniqueAttachmentIds.length === 0 ||
      uniqueAttachmentIds.some((id) => !isSafeAttachmentId(id))
    ) {
      throw new Error("Invalid task attachment IDs");
    }
    const taskDir = taskUploadDir(
      this.uploadsDir,
      scope.projectId,
      scope.sessionId,
    );
    let taskStats: Awaited<ReturnType<typeof lstat>>;
    try {
      taskStats = await lstat(taskDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { removedBytes: 0 };
      }
      throw error;
    }
    if (!taskStats.isDirectory() || taskStats.isSymbolicLink()) {
      throw new Error("Task attachment scope is not a safe directory");
    }
    const taskRealPath = await realpath(taskDir);
    if (!(await isPathInsideRoot(this.uploadsDir, taskRealPath))) {
      throw new Error("Task attachment scope escapes uploads directory");
    }
    let removedBytes = 0;
    for (const attachmentId of uniqueAttachmentIds) {
      removedBytes += await removeTaskAttachmentFiles(taskDir, attachmentId);
    }
    return { removedBytes };
  }

  /** Remove one exact task attachment scope, including derived artifacts. */
  async cleanupTaskAttachments(
    scope: TaskAttachmentScope,
  ): Promise<{ removed: boolean; removedBytes: number }> {
    assertTaskScope(scope);
    const taskDir = taskUploadDir(
      this.uploadsDir,
      scope.projectId,
      scope.sessionId,
    );
    const retentionPath = join(
      taskDir,
      RETENTION_DIR_NAME,
      `${scope.taskId}.json`,
    );
    const record = await readRetentionRecord(
      retentionPath,
      scope,
      this.uploadsDir,
    );
    if (!record) return { removed: false, removedBytes: 0 };

    const taskStats = await lstat(taskDir);
    if (!taskStats.isDirectory() || taskStats.isSymbolicLink()) {
      throw new Error("Task attachment scope is not a safe directory");
    }
    const taskRealPath = await realpath(taskDir);
    if (!(await isPathInsideRoot(this.uploadsDir, taskRealPath))) {
      throw new Error("Task attachment scope escapes uploads directory");
    }
    let removedBytes = 0;
    for (const attachmentId of record.attachmentIds) {
      removedBytes += await removeTaskAttachmentFiles(taskDir, attachmentId);
    }
    removedBytes += (await lstat(retentionPath)).size;
    await rm(retentionPath, { force: true });
    return { removed: true, removedBytes };
  }

  /** Scan retention records and clean only scopes whose expiry has elapsed. */
  async cleanupExpiredTaskAttachments(
    options: {
      nowMs?: number;
      limit?: number;
    } = {},
  ): Promise<AttachmentRetentionCleanupResult> {
    const nowMs = options.nowMs ?? Date.now();
    const limit = options.limit ?? 100;
    if (
      !Number.isSafeInteger(nowMs) ||
      !Number.isSafeInteger(limit) ||
      limit <= 0
    ) {
      throw new Error("Invalid attachment cleanup options");
    }
    const result: AttachmentRetentionCleanupResult = {
      scannedTasks: 0,
      removedTasks: 0,
      removedBytes: 0,
      skippedTasks: 0,
      failures: [],
    };
    const candidates = await listRetentionCleanupCandidates(this.uploadsDir);
    if (candidates.length === 0) {
      this.cleanupCursor = null;
      return result;
    }
    const startIndex = this.cleanupCursor
      ? firstCandidateAfter(candidates, this.cleanupCursor)
      : 0;
    const scanCount = Math.min(limit, candidates.length);
    for (let offset = 0; offset < scanCount; offset += 1) {
      const candidate = candidates[(startIndex + offset) % candidates.length];
      if (!candidate) continue;
      this.cleanupCursor = candidate.key;
      result.scannedTasks += 1;
      const taskRef = taskReference(candidate.scope);
      let record: TaskAttachmentRetentionRecord | null;
      try {
        record = await readRetentionRecord(
          candidate.retentionPath,
          candidate.scope,
          this.uploadsDir,
        );
      } catch {
        result.failures.push({
          taskRef,
          code: "INVALID_RETENTION_RECORD",
        });
        continue;
      }
      if (!record || record.expiresAtMs > nowMs) {
        result.skippedTasks += 1;
        continue;
      }
      try {
        const removed = await this.cleanupTaskAttachments(candidate.scope);
        if (removed.removed) {
          result.removedTasks += 1;
          result.removedBytes += removed.removedBytes;
        }
      } catch {
        result.failures.push({ taskRef, code: "CLEANUP_FAILED" });
      }
    }
    return result;
  }

  /**
   * Get current state of an upload.
   */
  getState(uploadId: string): UploadState | undefined {
    return this.uploads.get(uploadId);
  }
}

interface RetentionCleanupCandidate {
  key: string;
  scope: TaskAttachmentScope;
  retentionPath: string;
}

async function listRetentionCleanupCandidates(
  uploadsDir: string,
): Promise<RetentionCleanupCandidate[]> {
  const projects = await readdir(uploadsDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const candidates: RetentionCleanupCandidate[] = [];
  for (const project of projects) {
    if (!project.isDirectory() || !isSafePathSegment(project.name)) continue;
    const projectDir = join(uploadsDir, project.name);
    const sessions = await readdir(projectDir, { withFileTypes: true }).catch(
      () => [],
    );
    for (const session of sessions) {
      if (!session.isDirectory() || !isSafePathSegment(session.name)) continue;
      const retentionDir = join(projectDir, session.name, RETENTION_DIR_NAME);
      const records = await readdir(retentionDir, {
        withFileTypes: true,
      }).catch(() => []);
      for (const entry of records) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const taskId = entry.name.slice(0, -".json".length);
        if (!isSafePathSegment(taskId)) continue;
        const scope = {
          projectId: project.name,
          sessionId: session.name,
          taskId,
        };
        candidates.push({
          key: `${project.name}\0${session.name}\0${taskId}`,
          scope,
          retentionPath: join(retentionDir, entry.name),
        });
      }
    }
  }
  return candidates.sort((left, right) => left.key.localeCompare(right.key));
}

function firstCandidateAfter(
  candidates: readonly RetentionCleanupCandidate[],
  cursor: string,
): number {
  const index = candidates.findIndex((candidate) => candidate.key > cursor);
  return index < 0 ? 0 : index;
}

function assertStorageScope(scope: AttachmentStorageScope): void {
  if (!isUrlProjectId(scope.projectId)) {
    throw new Error("Invalid upload project ID");
  }
  if (!isSafePathSegment(scope.sessionId)) {
    throw new Error("Invalid upload session ID");
  }
}

function assertTaskScope(scope: TaskAttachmentScope): void {
  assertStorageScope(scope);
  if (!isSafePathSegment(scope.taskId)) {
    throw new Error("Invalid attachment task ID");
  }
}

function taskUploadDir(
  uploadsDir: string,
  projectId: string,
  sessionId: string,
): string {
  return join(uploadsDir, projectId, sessionId);
}

function generatedArtifactRegistryDir(
  uploadsDir: string,
  projectId: string,
  sessionId: string,
): string {
  return join(
    taskUploadDir(uploadsDir, projectId, sessionId),
    GENERATED_ARTIFACT_REGISTRY_DIR_NAME,
  );
}

function sanitizeArtifactLabel(label: string): string {
  const sanitized = label
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.\./g, "_")
    .slice(0, 120);
  return sanitized && sanitized !== "." && sanitized !== ".."
    ? sanitized
    : "artifact.bin";
}

function parseUploadPathRef(pathRef: string): {
  attachmentId: string;
  artifactId?: string;
} {
  const match =
    /^upload:([A-Za-z0-9-]{1,128})(?::artifact:([A-Za-z0-9-]{1,128}))?$/.exec(
      pathRef,
    );
  if (!match?.[1]) throw new Error("Invalid upload path reference");
  return {
    attachmentId: match[1],
    ...(match[2] ? { artifactId: match[2] } : {}),
  };
}

async function isPathInsideTaskDir(
  uploadsDir: string,
  projectId: string,
  sessionId: string,
  filePath: string,
): Promise<boolean> {
  const taskDir = await realpath(
    taskUploadDir(uploadsDir, projectId, sessionId),
  );
  const fromTask = relative(taskDir, filePath);
  return (
    fromTask !== "" &&
    fromTask !== ".." &&
    !fromTask.startsWith(`..${sep}`) &&
    !isAbsolute(fromTask)
  );
}

async function isPathInsideRoot(
  uploadsDir: string,
  filePath: string,
): Promise<boolean> {
  const root = await realpath(uploadsDir);
  const fromRoot = relative(root, filePath);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function directoryByteSize(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile()) {
      total += (await stat(path)).size;
    } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
      total += await directoryByteSize(path);
    }
  }
  return total;
}

async function removeTaskAttachmentFiles(
  taskDir: string,
  attachmentId: string,
): Promise<number> {
  let removedBytes = 0;
  const entries = await readdir(taskDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(`${attachmentId}_`)) continue;
    const sourcePath = join(taskDir, entry.name);
    const sourceStats = await lstat(sourcePath);
    if (sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) continue;
    removedBytes += sourceStats.size;
    await rm(sourcePath, { force: true });
  }
  const derivedPath = join(taskDir, DERIVED_DIR_NAME, attachmentId);
  const derivedStats = await lstat(derivedPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (derivedStats) {
    removedBytes +=
      derivedStats.isDirectory() && !derivedStats.isSymbolicLink()
        ? await directoryByteSize(derivedPath)
        : derivedStats.size;
    await rm(derivedPath, {
      recursive: derivedStats.isDirectory() && !derivedStats.isSymbolicLink(),
      force: true,
    });
  }
  removedBytes += await removeGeneratedArtifactRegistryRecords(
    taskDir,
    attachmentId,
  );
  return removedBytes;
}

async function removeGeneratedArtifactRegistryRecords(
  taskDir: string,
  attachmentId: string,
): Promise<number> {
  const registryDir = join(taskDir, GENERATED_ARTIFACT_REGISTRY_DIR_NAME);
  const entries = await readdir(registryDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  let removedBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^ga_[a-f0-9]{32}\.json$/.test(entry.name)) {
      continue;
    }
    const recordPath = join(registryDir, entry.name);
    const stats = await lstat(recordPath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.size <= 0 ||
      stats.size > MAX_GENERATED_ARTIFACT_RECORD_BYTES
    ) {
      continue;
    }
    let managedRef: unknown;
    try {
      managedRef = (
        JSON.parse(await readFile(recordPath, "utf8")) as {
          managedRef?: unknown;
        }
      ).managedRef;
    } catch {
      continue;
    }
    if (managedRef !== `upload:${attachmentId}`) continue;
    removedBytes += stats.size;
    await rm(recordPath, { force: true });
  }
  return removedBytes;
}

function isSafeAttachmentId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,128}$/.test(value);
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.nlink === 1n &&
    right.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readRetentionRecord(
  filePath: string,
  expectedScope: TaskAttachmentScope,
  uploadsDir: string,
): Promise<TaskAttachmentRetentionRecord | null> {
  let before: BigIntStats;
  try {
    before = await lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(MAX_RETENTION_RECORD_BYTES)
  ) {
    throw new Error("Invalid attachment retention record");
  }
  const resolvedBefore = await assertContainedExistingUploadPath(
    uploadsDir,
    filePath,
  );
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let text: string;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStableFile(before, opened)) {
      throw new Error("Invalid attachment retention record");
    }
    text = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    const resolvedAfter = await realpath(filePath);
    if (
      !sameStableFile(opened, after) ||
      resolvedAfter !== resolvedBefore ||
      Buffer.byteLength(text, "utf8") !== Number(after.size)
    ) {
      throw new Error("Invalid attachment retention record");
    }
  } finally {
    await handle.close();
  }
  const parsed = JSON.parse(text) as Partial<TaskAttachmentRetentionRecord>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.projectId !== expectedScope.projectId ||
    parsed.sessionId !== expectedScope.sessionId ||
    parsed.taskId !== expectedScope.taskId ||
    !Array.isArray(parsed.attachmentIds) ||
    parsed.attachmentIds.length === 0 ||
    parsed.attachmentIds.some((id) => !isSafeAttachmentId(id)) ||
    !Number.isSafeInteger(parsed.createdAtMs) ||
    !Number.isSafeInteger(parsed.expiresAtMs) ||
    (parsed.expiresAtMs ?? 0) <= (parsed.createdAtMs ?? 0)
  ) {
    throw new Error("Invalid attachment retention record");
  }
  return parsed as TaskAttachmentRetentionRecord;
}

async function readGeneratedArtifactRecord(
  filePath: string,
  expectedScope: AttachmentStorageScope,
  uploadsDir: string,
): Promise<GeneratedArtifactStorageRecord | null> {
  let before: BigIntStats;
  try {
    before = await lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(MAX_GENERATED_ARTIFACT_RECORD_BYTES)
  ) {
    throw new GeneratedArtifactAccessError("INVALID");
  }
  let resolvedBefore: string;
  try {
    resolvedBefore = await assertContainedExistingUploadPath(
      uploadsDir,
      filePath,
    );
  } catch {
    throw new GeneratedArtifactAccessError("INVALID");
  }
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => {
    throw new GeneratedArtifactAccessError("INVALID");
  });
  let text: string;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStableFile(before, opened)) {
      throw new GeneratedArtifactAccessError("INVALID");
    }
    text = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    const resolvedAfter = await realpath(filePath).catch(() => "");
    if (
      !sameStableFile(opened, after) ||
      resolvedAfter !== resolvedBefore ||
      Buffer.byteLength(text, "utf8") !== Number(after.size)
    ) {
      throw new GeneratedArtifactAccessError("INVALID");
    }
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeneratedArtifactAccessError("INVALID");
  }
  assertGeneratedArtifactRecord(parsed);
  const record = parsed as GeneratedArtifactStorageRecord;
  if (
    record.projectId !== expectedScope.projectId ||
    record.sessionId !== expectedScope.sessionId
  ) {
    throw new GeneratedArtifactAccessError("INVALID");
  }
  return record;
}

async function assertContainedExistingUploadPath(
  uploadsDir: string,
  filePath: string,
): Promise<string> {
  const [root, resolved] = await Promise.all([
    realpath(uploadsDir),
    realpath(filePath),
  ]);
  const fromRoot = relative(root, resolved);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error("Managed upload path escapes uploads directory");
  }
  return resolved;
}

function assertGeneratedArtifactRecord(
  value: unknown,
): asserts value is GeneratedArtifactStorageRecord {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<GeneratedArtifactStorageRecord>)
      : undefined;
  if (
    record?.schemaVersion !== 1 ||
    typeof record.projectId !== "string" ||
    !isUrlProjectId(record.projectId) ||
    typeof record.sessionId !== "string" ||
    !isSafePathSegment(record.sessionId) ||
    typeof record.artifactId !== "string" ||
    !/^ga_[a-f0-9]{32}$/.test(record.artifactId) ||
    typeof record.managedRef !== "string" ||
    !/^upload:[a-f0-9-]{36}$/.test(record.managedRef) ||
    typeof record.fileName !== "string" ||
    !isSafeGeneratedArtifactFileName(record.fileName) ||
    typeof record.mimeType !== "string" ||
    !isSafeMimeType(record.mimeType) ||
    typeof record.sizeBytes !== "number" ||
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes <= 0 ||
    record.sizeBytes > 30 * 1024 * 1024 ||
    typeof record.sha256 !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(record.sha256) ||
    typeof record.createdAtMs !== "number" ||
    !Number.isSafeInteger(record.createdAtMs) ||
    typeof record.expiresAtMs !== "number" ||
    !Number.isSafeInteger(record.expiresAtMs) ||
    record.expiresAtMs <= record.createdAtMs ||
    !isValidGeneratedArtifactReplayBinding(record)
  ) {
    throw new GeneratedArtifactAccessError("INVALID");
  }
}

function isValidGeneratedArtifactReplayBinding(
  record: Partial<GeneratedArtifactStorageRecord>,
): boolean {
  const fields = [record.kind, record.source, record.canonicalEvent];
  if (fields.every((field) => field === undefined)) return true;
  if (fields.some((field) => field === undefined)) return false;
  const kind = record.kind;
  const source = record.source;
  const canonicalEvent = record.canonicalEvent;
  return (
    (kind === "image" ||
      kind === "document" ||
      kind === "spreadsheet" ||
      kind === "presentation" ||
      kind === "text" ||
      kind === "video") &&
    source?.provider === "codex" &&
    (source.type === "image_generation" || source.type === "file_change") &&
    isSafeGeneratedArtifactOpaqueId(source.threadId) &&
    isSafeGeneratedArtifactOpaqueId(source.turnId) &&
    isSafeGeneratedArtifactOpaqueId(source.itemId) &&
    typeof canonicalEvent?.eventId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(canonicalEvent.eventId) &&
    typeof canonicalEvent.sequence === "number" &&
    Number.isSafeInteger(canonicalEvent.sequence) &&
    canonicalEvent.sequence > 0
  );
}

function isSafeGeneratedArtifactOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
  );
}

function assertGeneratedArtifactExpectation(
  expected: GeneratedArtifactReadExpectation,
): void {
  if (
    !/^ga_[a-f0-9]{32}$/.test(expected.artifactId) ||
    !/^sha256:[a-f0-9]{64}$/.test(expected.sha256) ||
    (expected.fileName !== undefined &&
      !isSafeGeneratedArtifactFileName(expected.fileName)) ||
    (expected.managedRef !== undefined &&
      !/^upload:[a-f0-9-]{36}$/.test(expected.managedRef)) ||
    (expected.mimeType !== undefined && !isSafeMimeType(expected.mimeType)) ||
    (expected.sizeBytes !== undefined &&
      (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes <= 0)) ||
    (expected.expiresAtMs !== undefined &&
      !Number.isSafeInteger(expected.expiresAtMs))
  ) {
    throw new GeneratedArtifactAccessError("INVALID");
  }
}

function matchesGeneratedArtifactExpectation(
  record: GeneratedArtifactStorageRecord,
  expected: GeneratedArtifactReadExpectation,
): boolean {
  return (
    record.artifactId === expected.artifactId &&
    record.sha256 === expected.sha256 &&
    (expected.fileName === undefined ||
      record.fileName === expected.fileName) &&
    (expected.managedRef === undefined ||
      record.managedRef === expected.managedRef) &&
    (expected.mimeType === undefined ||
      record.mimeType === expected.mimeType) &&
    (expected.sizeBytes === undefined ||
      record.sizeBytes === expected.sizeBytes) &&
    (expected.expiresAtMs === undefined ||
      record.expiresAtMs === expected.expiresAtMs)
  );
}

function isSafeGeneratedArtifactFileName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 120 ||
    value === "." ||
    value === ".." ||
    value.includes("..")
  ) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      character === "/" ||
      character === "\\"
    ) {
      return false;
    }
  }
  return true;
}

function isSafeMimeType(value: string): boolean {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value);
}

function sha256Digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** A reserved storage filename can only be created by server-side ingest. */
export function isGeneratedArtifactStorageFilename(value: string): boolean {
  return (
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_/.test(
      value,
    ) && value.slice(37).startsWith(GENERATED_ARTIFACT_STORAGE_MARKER)
  );
}

function taskReference(scope: TaskAttachmentScope): string {
  return `upload-task:${scope.projectId}:${scope.sessionId}:${scope.taskId}`;
}

function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

async function assertContainedUploadPath(
  uploadsDir: string,
  filePath: string,
): Promise<void> {
  const [root, parent] = await Promise.all([
    realpath(uploadsDir),
    realpath(dirname(filePath)),
  ]);
  const pathFromRoot = relative(root, parent);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Upload path escapes uploads directory");
  }
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
    normalized,
  )
    ? normalized
    : "application/octet-stream";
}

function detectMimeType(
  prefix: Buffer,
  containerProbe: Buffer,
): string | undefined {
  if (prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (prefix.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) {
    return "image/jpeg";
  }
  if (
    prefix.subarray(0, 6).toString("ascii") === "GIF87a" ||
    prefix.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return "image/gif";
  }
  if (
    prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
    prefix.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (prefix.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (prefix.subarray(0, 4).equals(Buffer.from("504b0304", "hex"))) {
    return detectOoxmlMimeType(containerProbe) ?? "application/zip";
  }
  if (
    prefix.length >= 12 &&
    prefix.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    return "video/mp4";
  }
  return undefined;
}

function detectOoxmlMimeType(probe: Buffer): string | undefined {
  const entries = readZipEntryNames(probe);
  if (!entries.has("[Content_Types].xml")) return undefined;

  if ([...entries].some((name) => name.startsWith("word/"))) {
    return entries.has("word/vbaProject.bin")
      ? "application/vnd.ms-word.document.macroEnabled.12"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if ([...entries].some((name) => name.startsWith("xl/"))) {
    return entries.has("xl/vbaProject.bin")
      ? "application/vnd.ms-excel.sheet.macroEnabled.12"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if ([...entries].some((name) => name.startsWith("ppt/"))) {
    return entries.has("ppt/vbaProject.bin")
      ? "application/vnd.ms-powerpoint.presentation.macroEnabled.12"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  return undefined;
}

function readZipEntryNames(probe: Buffer): Set<string> {
  const names = new Set<string>();
  let offset = 0;
  while (offset + 30 <= probe.length) {
    const signature = probe.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const flags = probe.readUInt16LE(offset + 6);
    const compressedSize = probe.readUInt32LE(offset + 18);
    const uncompressedSize = probe.readUInt32LE(offset + 22);
    const nameLength = probe.readUInt16LE(offset + 26);
    const extraLength = probe.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > probe.length) break;
    const name = probe.subarray(nameStart, nameEnd).toString("utf8");
    if (flags & 0x1) {
      throw new UploadContainerError("PASSWORD_PROTECTED");
    }
    if (!isSafeArchiveEntryName(name)) {
      throw new UploadContainerError("ARCHIVE_PATH_TRAVERSAL");
    }
    if (
      uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES ||
      (uncompressedSize > 0 && compressedSize === 0) ||
      (compressedSize > 0 &&
        uncompressedSize / compressedSize > MAX_ARCHIVE_EXPANSION_RATIO)
    ) {
      throw new UploadContainerError("ARCHIVE_BOMB");
    }
    names.add(name);
    const next = nameEnd + extraLength + compressedSize;
    offset = next > offset ? next : offset + 4;
  }
  return names;
}

function isSafeArchiveEntryName(name: string): boolean {
  if (
    !name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name)
  ) {
    return false;
  }
  const segments = name.split("/");
  return !segments.some((segment) => segment === ".." || segment === ".");
}
