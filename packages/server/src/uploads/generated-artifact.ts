import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  type GeneratedArtifactBlockReason,
  type GeneratedArtifactKind,
  type GeneratedArtifactManifest,
  type GeneratedArtifactSourceType,
  type GeneratedArtifactWarning,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { readValidatedZipEntries } from "./attachment-extractor.js";
import type { UploadManager } from "./manager.js";

export const MAX_GENERATED_ARTIFACT_BYTES = 30 * 1024 * 1024;
export const MAX_INLINE_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_GENERATED_ARTIFACTS_PER_TASK = 8;
export const GENERATED_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;

const MAX_OFFICE_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_OFFICE_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_OFFICE_ENTRIES = 2_048;
const MAX_OFFICE_EXPANSION_RATIO = 100;
const READ_CHUNK_BYTES = 64 * 1024;

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_SIGNATURE = Buffer.from("ffd8ff", "hex");
const SEVEN_ZIP_SIGNATURE = Buffer.from("377abcaf271c", "hex");
const RAR4_SIGNATURE = Buffer.from("526172211a0700", "hex");
const RAR5_SIGNATURE = Buffer.from("526172211a070100", "hex");
const GZIP_SIGNATURE = Buffer.from("1f8b", "hex");

export interface CodexGeneratedArtifactGrant {
  projectId: string;
  sessionId: string;
  taskId: string;
  workspaceRoot: string;
  threadId: string;
  turnId: string;
  /** Exact provider-journal item event used to prevent source merging on replay. */
  canonicalEventId: string;
  canonicalEventSequence: number;
}

export interface CodexGeneratedArtifactItemInput {
  lifecycle: "started" | "completed";
  item: unknown;
  threadId?: string;
  turnId?: string;
  replay?: boolean;
}

export interface GeneratedArtifactMaterialization {
  artifacts: GeneratedArtifactManifest[];
  warnings: GeneratedArtifactWarning[];
}

export interface GeneratedArtifactMaterializerOptions {
  uploadManager: UploadManager;
  maxArtifactBytes?: number;
  maxInlineImageBytes?: number;
  maxArtifactsPerTask?: number;
  retentionMs?: number;
  now?: () => number;
  /** Test-only race hook; production callers must not set it. */
  beforeOpenForTest?: (candidatePath: string) => void | Promise<void>;
  /** Test-only race hook; production callers must not set it. */
  beforeFinalValidationForTest?: (
    candidatePath: string,
  ) => void | Promise<void>;
  /** Test-only mount boundary simulation; production callers must not set it. */
  workspaceRootDeviceForTest?: bigint;
}

interface ArtifactCandidate {
  sourceId: string;
  sourceType: GeneratedArtifactSourceType;
  fileName?: string;
  bytes?: Buffer;
  providerPath?: string;
}

interface InspectedArtifact {
  fileName: string;
  bytes: Buffer;
  mimeType: string;
  kind: GeneratedArtifactKind;
}

interface ArtifactFormat {
  mimeType: string;
  kind: GeneratedArtifactKind;
}

class GeneratedArtifactPolicyError extends Error {
  readonly reason: GeneratedArtifactBlockReason;

  constructor(reason: GeneratedArtifactBlockReason) {
    super(reason);
    this.name = "GeneratedArtifactPolicyError";
    this.reason = reason;
  }
}

/**
 * Converts canonical completed Codex items into Yep-managed, path-free
 * artifacts. Provider paths are read only after matching an explicit active
 * turn grant, validating realpath containment and taking a stable file copy.
 */
export class GeneratedArtifactMaterializer {
  private readonly options: GeneratedArtifactMaterializerOptions;
  private readonly maxArtifactBytes: number;
  private readonly maxInlineImageBytes: number;
  private readonly maxArtifactsPerTask: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<
    string,
    Promise<GeneratedArtifactMaterialization>
  >();
  private readonly taskCounts = new Map<string, number>();

  constructor(options: GeneratedArtifactMaterializerOptions) {
    this.options = options;
    this.maxArtifactBytes = positiveBoundedInteger(
      options.maxArtifactBytes,
      MAX_GENERATED_ARTIFACT_BYTES,
      MAX_GENERATED_ARTIFACT_BYTES,
    );
    this.maxInlineImageBytes = positiveBoundedInteger(
      options.maxInlineImageBytes ??
        Math.min(MAX_INLINE_GENERATED_IMAGE_BYTES, this.maxArtifactBytes),
      Math.min(MAX_INLINE_GENERATED_IMAGE_BYTES, this.maxArtifactBytes),
      this.maxArtifactBytes,
    );
    this.maxArtifactsPerTask = positiveBoundedInteger(
      options.maxArtifactsPerTask,
      MAX_GENERATED_ARTIFACTS_PER_TASK,
      32,
    );
    this.retentionMs = positiveBoundedInteger(
      options.retentionMs,
      GENERATED_ARTIFACT_RETENTION_MS,
      30 * 24 * 60 * 60 * 1000,
    );
    this.now = options.now ?? Date.now;
  }

  async materialize(
    input: CodexGeneratedArtifactItemInput,
    grant: CodexGeneratedArtifactGrant,
  ): Promise<GeneratedArtifactMaterialization> {
    const item = objectValue(input.item);
    if (
      input.replay === true ||
      input.lifecycle !== "completed" ||
      !item ||
      (item.type !== "imageGeneration" && item.type !== "fileChange")
    ) {
      return { artifacts: [], warnings: [] };
    }

    const itemId = stringValue(item.id);
    if (!itemId || !isSafeOpaqueId(itemId)) {
      return {
        artifacts: [],
        warnings: [{ sourceId: "invalid-item", reason: "invalid_payload" }],
      };
    }
    if (!isValidMaterializationGrant(input, grant)) {
      return {
        artifacts: [],
        warnings: [{ sourceId: itemId, reason: "scope_mismatch" }],
      };
    }

    const cacheKey = [
      grant.projectId,
      grant.sessionId,
      grant.taskId,
      grant.workspaceRoot,
      input.threadId ?? "",
      input.turnId ?? "",
      itemId,
      grant.canonicalEventId,
      String(grant.canonicalEventSequence),
    ].join("\0");
    const existing = this.cache.get(cacheKey);
    if (existing) return cloneResult(await existing);

    const operation = this.materializeUncached(input, grant, item, itemId);
    this.cache.set(cacheKey, operation);
    return cloneResult(await operation);
  }

  private async materializeUncached(
    input: CodexGeneratedArtifactItemInput,
    grant: CodexGeneratedArtifactGrant,
    item: Record<string, unknown>,
    itemId: string,
  ): Promise<GeneratedArtifactMaterialization> {
    const selected = selectCandidates(item, itemId, this.maxInlineImageBytes);
    if ("warning" in selected) {
      return { artifacts: [], warnings: [selected.warning] };
    }

    const artifacts: GeneratedArtifactManifest[] = [];
    const warnings: GeneratedArtifactWarning[] = [];
    for (const candidate of selected.candidates) {
      const taskKey = `${grant.projectId}\0${grant.sessionId}\0${grant.taskId}`;
      const currentCount = this.taskCounts.get(taskKey) ?? 0;
      if (currentCount >= this.maxArtifactsPerTask) {
        warnings.push({
          sourceId: candidate.sourceId,
          reason: "count_limit",
        });
        continue;
      }
      // Reserve before the first await so concurrent completed items cannot
      // both pass the same per-task count check.
      this.taskCounts.set(taskKey, currentCount + 1);

      try {
        const inspected = candidate.bytes
          ? inspectBytes(
              candidate.bytes,
              candidate.fileName ?? "codex-generated.png",
              candidate.sourceType,
              this.maxArtifactBytes,
            )
          : await this.inspectWorkspaceCandidate(candidate, grant);
        const manifest = await this.persist(
          inspected,
          candidate.sourceType,
          itemId,
          grant,
        );
        artifacts.push(manifest);
      } catch (error) {
        const reservedCount = this.taskCounts.get(taskKey) ?? 1;
        if (reservedCount <= 1) this.taskCounts.delete(taskKey);
        else this.taskCounts.set(taskKey, reservedCount - 1);
        warnings.push({
          sourceId: candidate.sourceId,
          reason:
            error instanceof GeneratedArtifactPolicyError
              ? error.reason
              : "storage_failed",
        });
      }
    }
    return { artifacts, warnings };
  }

  private async inspectWorkspaceCandidate(
    candidate: ArtifactCandidate,
    grant: CodexGeneratedArtifactGrant,
  ): Promise<InspectedArtifact> {
    const providerPath = candidate.providerPath;
    if (!providerPath || providerPath.includes("\0")) {
      throw new GeneratedArtifactPolicyError("invalid_payload");
    }

    const workspaceGrantRoot = resolve(grant.workspaceRoot);
    let workspaceRoot: string;
    let workspaceDevice: bigint;
    try {
      workspaceRoot = await realpath(grant.workspaceRoot);
      const rootStats = await lstat(workspaceRoot, { bigint: true });
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new GeneratedArtifactPolicyError("scope_mismatch");
      }
      workspaceDevice =
        this.options.workspaceRootDeviceForTest ?? rootStats.dev;
    } catch (error) {
      if (error instanceof GeneratedArtifactPolicyError) throw error;
      throw new GeneratedArtifactPolicyError("scope_mismatch");
    }

    const lexicalCandidate = resolveProviderCandidate(
      providerPath,
      workspaceGrantRoot,
      workspaceRoot,
    );
    await assertNoSymlinkComponents(workspaceRoot, lexicalCandidate);

    let resolvedCandidate: string;
    let before: BigIntStats;
    try {
      resolvedCandidate = await realpath(lexicalCandidate);
      if (!isContained(workspaceRoot, resolvedCandidate)) {
        throw new GeneratedArtifactPolicyError("outside_workspace");
      }
      before = await lstat(lexicalCandidate, { bigint: true });
    } catch (error) {
      if (error instanceof GeneratedArtifactPolicyError) throw error;
      throw new GeneratedArtifactPolicyError("not_regular_file");
    }
    if (before.isSymbolicLink()) {
      throw new GeneratedArtifactPolicyError("symlink");
    }
    if (!before.isFile() || before.size <= 0n) {
      throw new GeneratedArtifactPolicyError("not_regular_file");
    }
    if (before.nlink !== 1n) {
      throw new GeneratedArtifactPolicyError("hard_link");
    }
    if (before.dev !== workspaceDevice) {
      throw new GeneratedArtifactPolicyError("cross_device");
    }
    if (before.size > BigInt(this.maxArtifactBytes)) {
      throw new GeneratedArtifactPolicyError("size_limit");
    }

    const fileName = sanitizePublicFileName(basename(resolvedCandidate));
    await this.options.beforeOpenForTest?.(lexicalCandidate);

    let bytes: Buffer;
    const handle = await open(
      lexicalCandidate,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    ).catch(() => {
      throw new GeneratedArtifactPolicyError("changed_during_read");
    });
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameStableFile(before, opened)) {
        throw new GeneratedArtifactPolicyError("changed_during_read");
      }
      bytes = await readBoundedFile(handle, this.maxArtifactBytes);
      await this.options.beforeFinalValidationForTest?.(lexicalCandidate);
      const after = await handle.stat({ bigint: true });
      if (
        !sameStableFile(opened, after) ||
        BigInt(bytes.length) !== after.size
      ) {
        throw new GeneratedArtifactPolicyError("changed_during_read");
      }
      const resolvedAfter = await realpath(lexicalCandidate).catch(() => "");
      if (
        resolvedAfter !== resolvedCandidate ||
        !isContained(workspaceRoot, resolvedAfter)
      ) {
        throw new GeneratedArtifactPolicyError("changed_during_read");
      }
    } finally {
      await handle.close();
    }

    return inspectBytes(
      bytes,
      fileName,
      candidate.sourceType,
      this.maxArtifactBytes,
    );
  }

  private async persist(
    inspected: InspectedArtifact,
    sourceType: GeneratedArtifactSourceType,
    itemId: string,
    grant: CodexGeneratedArtifactGrant,
  ): Promise<GeneratedArtifactManifest> {
    const now = this.now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - this.retentionMs
    ) {
      throw new GeneratedArtifactPolicyError("storage_failed");
    }
    const expiresAtMs = now + this.retentionMs;
    let attachmentId: string | undefined;
    try {
      const attachment = await this.options.uploadManager.ingest({
        projectId: grant.projectId,
        sessionId: grant.sessionId,
        originalName: inspected.fileName,
        mimeType: inspected.mimeType,
        expectedSize: inspected.bytes.length,
        stream: singleChunk(inspected.bytes),
        storageClass: "generated",
      });
      attachmentId = attachment.id;
      if (attachment.mimeType !== inspected.mimeType) {
        throw new GeneratedArtifactPolicyError("mime_mismatch");
      }
      const artifactId = `ga_${attachment.id.replaceAll("-", "")}`;
      const sha256 = sha256Value(inspected.bytes);
      await this.options.uploadManager.setTaskAttachmentRetention(
        {
          projectId: grant.projectId,
          sessionId: grant.sessionId,
          taskId: `generated-${attachment.id}`,
        },
        [attachment.id],
        expiresAtMs,
        now,
      );
      await this.options.uploadManager.registerGeneratedArtifact({
        schemaVersion: 1,
        projectId: grant.projectId,
        sessionId: grant.sessionId,
        artifactId,
        managedRef: `upload:${attachment.id}`,
        fileName: inspected.fileName,
        mimeType: inspected.mimeType,
        sizeBytes: inspected.bytes.length,
        sha256,
        createdAtMs: now,
        expiresAtMs,
        kind: inspected.kind,
        source: {
          provider: "codex",
          type: sourceType,
          threadId: grant.threadId,
          turnId: grant.turnId,
          itemId,
        },
        canonicalEvent: {
          eventId: grant.canonicalEventId,
          sequence: grant.canonicalEventSequence,
        },
      });
      const downloadUrl = `/api/projects/${encodeURIComponent(
        grant.projectId,
      )}/sessions/${encodeURIComponent(
        grant.sessionId,
      )}/generated-artifact/${artifactId}/${sha256.slice(
        "sha256:".length,
      )}/${encodeURIComponent(inspected.fileName)}`;
      return {
        schemaVersion: 1,
        id: artifactId,
        managedRef: `upload:${attachment.id}`,
        fileName: inspected.fileName,
        kind: inspected.kind,
        mimeType: inspected.mimeType,
        sizeBytes: inspected.bytes.length,
        sha256,
        source: {
          provider: "codex",
          type: sourceType,
          threadId: grant.threadId,
          turnId: grant.turnId,
          itemId,
        },
        retention: {
          policy: "temporary",
          expiresAt: new Date(expiresAtMs).toISOString(),
        },
        downloadUrl,
        ...(inspected.kind === "image" ? { previewUrl: downloadUrl } : {}),
      };
    } catch (error) {
      if (attachmentId) {
        const cleaned = await this.options.uploadManager
          .cleanupTaskAttachments({
            projectId: grant.projectId,
            sessionId: grant.sessionId,
            taskId: `generated-${attachmentId}`,
          })
          .catch(() => ({ removed: false }));
        if (!cleaned.removed) {
          await this.options.uploadManager
            .discardTaskAttachments(
              { projectId: grant.projectId, sessionId: grant.sessionId },
              [attachmentId],
            )
            .catch(() => undefined);
        }
      }
      if (error instanceof GeneratedArtifactPolicyError) throw error;
      throw new GeneratedArtifactPolicyError("storage_failed");
    }
  }
}

/** Re-run the materialization policy before bytes cross an outbound boundary. */
export function validateGeneratedArtifactPayload(
  artifact: GeneratedArtifactManifest,
  bytes: Uint8Array,
): boolean {
  if (
    bytes.byteLength !== artifact.sizeBytes ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      (artifact.kind === "image"
        ? MAX_INLINE_GENERATED_IMAGE_BYTES
        : MAX_GENERATED_ARTIFACT_BYTES)
  ) {
    return false;
  }
  try {
    const inspected = inspectBytes(
      Buffer.from(bytes),
      artifact.fileName,
      artifact.source.type,
      artifact.kind === "image"
        ? MAX_INLINE_GENERATED_IMAGE_BYTES
        : MAX_GENERATED_ARTIFACT_BYTES,
    );
    return (
      inspected.fileName === artifact.fileName &&
      inspected.kind === artifact.kind &&
      inspected.mimeType === artifact.mimeType &&
      inspected.bytes.length === artifact.sizeBytes &&
      sha256Value(bytes) === artifact.sha256
    );
  } catch {
    return false;
  }
}

function selectCandidates(
  item: Record<string, unknown>,
  itemId: string,
  maxInlineImageBytes: number,
): { candidates: ArtifactCandidate[] } | { warning: GeneratedArtifactWarning } {
  if (item.type === "imageGeneration") {
    if (item.status !== "completed") {
      return {
        warning: { sourceId: itemId, reason: "invalid_payload" },
      };
    }
    const encoded = stringValue(item.result)?.trim();
    if (encoded) {
      try {
        return {
          candidates: [
            {
              sourceId: itemId,
              sourceType: "image_generation",
              fileName: generatedImageName(itemId),
              bytes: decodeInlinePng(encoded, maxInlineImageBytes),
            },
          ],
        };
      } catch (error) {
        return {
          warning: {
            sourceId: itemId,
            reason:
              error instanceof GeneratedArtifactPolicyError
                ? error.reason
                : "invalid_payload",
          },
        };
      }
    }
    const savedPath = stringValue(item.savedPath);
    return savedPath
      ? {
          candidates: [
            {
              sourceId: itemId,
              sourceType: "image_generation",
              providerPath: savedPath,
            },
          ],
        }
      : { warning: { sourceId: itemId, reason: "invalid_payload" } };
  }

  if (item.type !== "fileChange" || item.status !== "completed") {
    return { warning: { sourceId: itemId, reason: "invalid_payload" } };
  }
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const candidates = changes.flatMap((value, index): ArtifactCandidate[] => {
    const change = objectValue(value);
    const path = stringValue(change?.path);
    const kind = changeKind(change?.kind);
    return path && kind === "add"
      ? [
          {
            sourceId: `${itemId}:${index}`,
            sourceType: "file_change",
            providerPath: path,
          },
        ]
      : [];
  });
  return candidates.length > 0
    ? { candidates }
    : { warning: { sourceId: itemId, reason: "invalid_payload" } };
}

function inspectBytes(
  bytes: Buffer,
  rawFileName: string,
  sourceType: GeneratedArtifactSourceType,
  maxBytes: number,
): InspectedArtifact {
  if (bytes.length === 0) {
    throw new GeneratedArtifactPolicyError("invalid_payload");
  }
  if (bytes.length > maxBytes) {
    throw new GeneratedArtifactPolicyError("size_limit");
  }
  const fileName = sanitizePublicFileName(rawFileName);
  const format = detectFormat(bytes, fileName, sourceType);
  return { fileName, bytes, ...format };
}

function detectFormat(
  bytes: Buffer,
  fileName: string,
  sourceType: GeneratedArtifactSourceType,
): ArtifactFormat {
  const extension = extname(fileName).toLowerCase();
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    assertExtension(extension, [".png"]);
    return { mimeType: "image/png", kind: "image" };
  }
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    assertExtension(extension, [".jpg", ".jpeg"]);
    return { mimeType: "image/jpeg", kind: "image" };
  }
  const gif = bytes.subarray(0, 6).toString("ascii");
  if (gif === "GIF87a" || gif === "GIF89a") {
    assertExtension(extension, [".gif"]);
    return { mimeType: "image/gif", kind: "image" };
  }
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    assertExtension(extension, [".webp"]);
    return { mimeType: "image/webp", kind: "image" };
  }
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    assertExtension(extension, [".pdf"]);
    return { mimeType: "application/pdf", kind: "document" };
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    assertExtension(extension, [".mp4"]);
    return { mimeType: "video/mp4", kind: "video" };
  }
  if (isZip(bytes)) {
    return inspectSafeOfficeContainer(bytes, extension);
  }
  if (isHighRiskArchive(bytes, extension)) {
    throw new GeneratedArtifactPolicyError("high_risk_archive");
  }

  const text = decodeSafeText(bytes);
  if (text === undefined) {
    throw new GeneratedArtifactPolicyError(
      sourceType === "image_generation"
        ? "unsupported_format"
        : extension
          ? "mime_mismatch"
          : "unsupported_format",
    );
  }
  switch (extension) {
    case ".txt":
    case ".md":
    case ".markdown":
      return { mimeType: "text/plain", kind: "text" };
    case ".csv":
      return { mimeType: "text/csv", kind: "spreadsheet" };
    case ".json":
      try {
        JSON.parse(text);
      } catch {
        throw new GeneratedArtifactPolicyError("mime_mismatch");
      }
      return { mimeType: "application/json", kind: "text" };
    default:
      throw new GeneratedArtifactPolicyError("unsupported_format");
  }
}

function inspectSafeOfficeContainer(
  bytes: Buffer,
  extension: string,
): ArtifactFormat {
  let entries: ReturnType<typeof readValidatedZipEntries>;
  try {
    entries = readValidatedZipEntries(bytes, {
      maxEntries: MAX_OFFICE_ENTRIES,
      maxEntryBytes: MAX_OFFICE_ENTRY_BYTES,
      maxTotalBytes: MAX_OFFICE_EXPANDED_BYTES,
      maxExpansionRatio: MAX_OFFICE_EXPANSION_RATIO,
    });
  } catch {
    throw new GeneratedArtifactPolicyError("high_risk_archive");
  }
  let hasContentTypes = false;
  let hasWord = false;
  let hasWorkbook = false;
  let hasPresentation = false;
  for (const entry of entries) {
    const entryName = entry.name;
    if (!isSafeArchiveEntryName(entryName)) {
      throw new GeneratedArtifactPolicyError("high_risk_archive");
    }
    const lowerName = entryName.toLowerCase();
    if (
      lowerName.endsWith("vbaproject.bin") ||
      lowerName.includes("/embeddings/") ||
      lowerName.includes("/oleobjects/") ||
      lowerName.includes("/activex/") ||
      lowerName.includes("/customui/") ||
      lowerName.includes("/externallinks/") ||
      lowerName.includes("/macrosheets/") ||
      lowerName.includes("/dialogsheets/")
    ) {
      throw new GeneratedArtifactPolicyError("high_risk_archive");
    }
    const expanded = entry.content;
    if (
      /TargetMode\s*=\s*["']External["']|macroEnabled|vbaProject|activeX/i.test(
        expanded.toString("utf8"),
      )
    ) {
      throw new GeneratedArtifactPolicyError("high_risk_archive");
    }
    hasContentTypes ||= entryName === "[Content_Types].xml";
    hasWord ||= lowerName.startsWith("word/");
    hasWorkbook ||= lowerName.startsWith("xl/");
    hasPresentation ||= lowerName.startsWith("ppt/");
  }
  if (
    !hasContentTypes ||
    [hasWord, hasWorkbook, hasPresentation].filter(Boolean).length !== 1
  ) {
    throw new GeneratedArtifactPolicyError("high_risk_archive");
  }
  if (hasWord) {
    assertExtension(extension, [".docx"]);
    return {
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      kind: "document",
    };
  }
  if (hasWorkbook) {
    assertExtension(extension, [".xlsx"]);
    return {
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      kind: "spreadsheet",
    };
  }
  assertExtension(extension, [".pptx"]);
  return {
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    kind: "presentation",
  };
}

async function readBoundedFile(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let position = 0;
  for (;;) {
    const remaining = maxBytes + 1 - position;
    if (remaining <= 0) {
      throw new GeneratedArtifactPolicyError("size_limit");
    }
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return Buffer.concat(chunks, position);
}

async function assertNoSymlinkComponents(
  root: string,
  candidate: string,
): Promise<void> {
  const fromRoot = relative(root, candidate);
  const components = fromRoot.split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch {
      throw new GeneratedArtifactPolicyError("not_regular_file");
    }
    if (stats.isSymbolicLink()) {
      throw new GeneratedArtifactPolicyError("symlink");
    }
  }
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

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function decodeInlinePng(encoded: string, maxBytes: number): Buffer {
  const maxEncodedLength = 4 * Math.ceil(maxBytes / 3) + 4;
  if (
    encoded.length > maxEncodedLength ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    throw new GeneratedArtifactPolicyError(
      encoded.length > maxEncodedLength ? "size_limit" : "invalid_payload",
    );
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) {
    throw new GeneratedArtifactPolicyError("invalid_payload");
  }
  if (bytes.length > maxBytes) {
    throw new GeneratedArtifactPolicyError("size_limit");
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new GeneratedArtifactPolicyError("unsupported_format");
  }
  return bytes;
}

function generatedImageName(itemId: string): string {
  const publicId = createHash("sha256")
    .update(itemId)
    .digest("hex")
    .slice(0, 12);
  return `codex-generated-${publicId}.png`;
}

function sha256Value(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sanitizePublicFileName(value: string): string {
  const normalized = replaceUnsafeFileNameCharacters(
    basename(value.replaceAll("\\", "/")),
  )
    .replace(/\.\./g, "_")
    .trim();
  if (!normalized || normalized === "." || normalized === "..") {
    return "artifact.bin";
  }
  const extension = extname(normalized).slice(0, 20);
  const stem = normalized.slice(0, normalized.length - extension.length);
  return `${stem.slice(0, 100)}${extension}`;
}

function replaceUnsafeFileNameCharacters(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    sanitized +=
      code <= 0x1f || code === 0x7f || '<>:"/\\|?*'.includes(character)
        ? "_"
        : character;
  }
  return sanitized;
}

function decodeSafeText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  let suspiciousControls = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      suspiciousControls += 1;
    }
  }
  return suspiciousControls > Math.max(4, text.length / 100) ? undefined : text;
}

function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
}

function isHighRiskArchive(bytes: Buffer, extension: string): boolean {
  return (
    [
      ".7z",
      ".bz2",
      ".dmg",
      ".gz",
      ".iso",
      ".rar",
      ".tar",
      ".tgz",
      ".xz",
      ".zip",
    ].includes(extension) ||
    bytes.subarray(0, GZIP_SIGNATURE.length).equals(GZIP_SIGNATURE) ||
    bytes.subarray(0, SEVEN_ZIP_SIGNATURE.length).equals(SEVEN_ZIP_SIGNATURE) ||
    bytes.subarray(0, RAR4_SIGNATURE.length).equals(RAR4_SIGNATURE) ||
    bytes.subarray(0, RAR5_SIGNATURE.length).equals(RAR5_SIGNATURE) ||
    bytes.subarray(257, 262).toString("ascii") === "ustar"
  );
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
  return !name.split("/").some((component) => component === "..");
}

function assertExtension(extension: string, allowed: string[]): void {
  if (!allowed.includes(extension)) {
    throw new GeneratedArtifactPolicyError("mime_mismatch");
  }
}

function changeKind(value: unknown): string | undefined {
  return stringValue(objectValue(value)?.type);
}

function isValidMaterializationGrant(
  input: CodexGeneratedArtifactItemInput,
  grant: CodexGeneratedArtifactGrant,
): boolean {
  return (
    isUrlProjectId(grant.projectId) &&
    isSafeOpaqueId(grant.sessionId) &&
    isSafeOpaqueId(grant.taskId) &&
    isSafeOpaqueId(grant.threadId) &&
    isSafeOpaqueId(grant.turnId) &&
    grant.workspaceRoot.length > 0 &&
    grant.workspaceRoot.length <= 4_096 &&
    !grant.workspaceRoot.includes("\0") &&
    isAbsolute(grant.workspaceRoot) &&
    isSafeCanonicalEventId(grant.canonicalEventId) &&
    Number.isSafeInteger(grant.canonicalEventSequence) &&
    grant.canonicalEventSequence > 0 &&
    input.threadId === grant.threadId &&
    input.turnId === grant.turnId
  );
}

/**
 * Map only the granted workspace spelling (for example macOS `/var`) to its
 * canonical root (`/private/var`). Symlinks below that root remain forbidden.
 */
function resolveProviderCandidate(
  providerPath: string,
  workspaceGrantRoot: string,
  workspaceRealRoot: string,
): string {
  if (!isAbsolute(providerPath)) {
    return resolve(workspaceRealRoot, providerPath);
  }
  const absoluteCandidate = resolve(providerPath);
  if (isContained(workspaceRealRoot, absoluteCandidate)) {
    return absoluteCandidate;
  }
  if (!isContained(workspaceGrantRoot, absoluteCandidate)) {
    throw new GeneratedArtifactPolicyError("outside_workspace");
  }
  const mappedCandidate = resolve(
    workspaceRealRoot,
    relative(workspaceGrantRoot, absoluteCandidate),
  );
  if (!isContained(workspaceRealRoot, mappedCandidate)) {
    throw new GeneratedArtifactPolicyError("outside_workspace");
  }
  return mappedCandidate;
}

function isSafeOpaqueId(value: string): boolean {
  return (
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) &&
    !value.includes("..")
  );
}

function isSafeCanonicalEventId(value: string): boolean {
  return (
    value.length <= 512 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) &&
    !value.includes("..")
  );
}

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error("Invalid generated artifact policy limit");
  }
  return value;
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function cloneResult(
  result: GeneratedArtifactMaterialization,
): GeneratedArtifactMaterialization {
  return {
    artifacts: result.artifacts.map((artifact) => structuredClone(artifact)),
    warnings: result.warnings.map((warning) => ({ ...warning })),
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
