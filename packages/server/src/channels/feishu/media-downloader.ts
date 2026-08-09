import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import type { UploadedFile } from "@yep-anywhere/shared";
import {
  type AttachmentExtractionArtifact,
  type AttachmentExtractionFailureCode,
  type AttachmentExtractor,
  SafeAttachmentExtractor,
} from "../../uploads/attachment-extractor.js";
import {
  UploadContainerError,
  type UploadManager,
} from "../../uploads/manager.js";
import type {
  FeishuAttachmentManifest,
  FeishuMessageApi,
  FeishuResourceDescriptor,
} from "./normalization/types.js";

const DEFAULT_MAX_FILE_BYTES = 30 * 1024 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_AUDIO_STAGING_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AUDIO_STAGING_DIRECTORY = "yep-feishu-audio-staging";
const AUDIO_STAGING_PREFIX = "yep-feishu-audio-";

export interface FeishuMediaDownloaderOptions {
  uploadManager: UploadManager;
  extractor?: AttachmentExtractor;
  maxFileBytes?: number;
  maxMessageBytes?: number;
  retentionMs?: number;
  /** Override only for isolated tests; production uses the process temp root. */
  audioStagingRoot?: string;
  audioStagingRetentionMs?: number;
}

export interface FeishuMediaDownloadInput {
  api: FeishuMessageApi;
  messageId: string;
  projectId: string;
  sessionId: string;
  taskId: string;
  resources: FeishuResourceDescriptor[];
}

export interface FeishuMediaDownloadFailure {
  fileKey: string;
  messageId: string;
  resourceType: FeishuResourceDescriptor["type"];
  stage:
    | "authorize"
    | "download"
    | "size-validation"
    | "ingest"
    | "extract"
    | "stage"
    | "retention";
  retryable: boolean;
  code:
    | "DOWNLOAD_CAPABILITY_MISSING"
    | "DOWNLOAD_FAILED"
    | "FILE_TOO_LARGE"
    | "MESSAGE_TOO_LARGE"
    | "AUDIO_STAGING_FAILED"
    | "RETENTION_REGISTRATION_FAILED"
    | AttachmentExtractionFailureCode;
}

export interface FeishuMediaDownloadResult {
  attachments: UploadedFile[];
  manifests: FeishuAttachmentManifest[];
  failures: FeishuMediaDownloadFailure[];
}

export class FeishuMediaDownloader {
  private readonly uploadManager: UploadManager;
  private readonly extractor: AttachmentExtractor;
  private readonly maxFileBytes: number;
  private readonly maxMessageBytes: number;
  private readonly retentionMs: number;
  private readonly audioStagingRoot: string;
  private readonly audioStagingRetentionMs: number;
  private readonly audioStagingByTask = new Map<string, Map<string, number>>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanupStart?: Promise<void>;
  private cleanupEpoch = 0;
  private cleanupInFlight = false;

  constructor(options: FeishuMediaDownloaderOptions) {
    this.uploadManager = options.uploadManager;
    this.extractor =
      options.extractor ??
      new SafeAttachmentExtractor({ artifactWriter: options.uploadManager });
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.audioStagingRoot = resolve(
      options.audioStagingRoot ??
        join(tmpdir(), DEFAULT_AUDIO_STAGING_DIRECTORY),
    );
    this.audioStagingRetentionMs =
      options.audioStagingRetentionMs ?? DEFAULT_AUDIO_STAGING_RETENTION_MS;
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs <= 0) {
      throw new Error("Invalid Feishu attachment retention duration");
    }
    if (
      !Number.isSafeInteger(this.audioStagingRetentionMs) ||
      this.audioStagingRetentionMs <= 0
    ) {
      throw new Error("Invalid Feishu audio staging retention duration");
    }
  }

  async downloadAll(
    input: FeishuMediaDownloadInput,
  ): Promise<FeishuMediaDownloadResult> {
    if (input.resources.length > 0) {
      await this.startRetentionCleanup();
    }
    const attachments: UploadedFile[] = [];
    const manifests: FeishuAttachmentManifest[] = [];
    const failures: FeishuMediaDownloadFailure[] = [];
    let totalBytes = 0;

    for (const [index, resource] of input.resources.entries()) {
      if (!input.api.downloadMessageResource) {
        failures.push({
          fileKey: resource.fileKey,
          messageId: resource.messageId ?? input.messageId,
          resourceType: resource.type,
          stage: "authorize",
          retryable: false,
          code: "DOWNLOAD_CAPABILITY_MISSING",
        });
        continue;
      }
      try {
        const declaredMime = defaultResourceMime(resource);
        const sha256 = createHash("sha256");
        const source = await input.api.downloadMessageResource(
          resource.messageId ?? input.messageId,
          resource.fileKey,
          resource.type === "image" || resource.type === "sticker"
            ? "image"
            : "file",
        );
        const guarded = this.guardSize(
          source,
          () => totalBytes,
          (bytes) => {
            totalBytes += bytes;
          },
          (chunk) => sha256.update(chunk),
        );
        const attachment = await this.uploadManager.ingest({
          projectId: input.projectId,
          sessionId: input.sessionId,
          originalName:
            resource.fileName ?? defaultResourceName(resource, index),
          mimeType: declaredMime,
          stream: guarded,
        });
        const extraction = await this.extractor.extract({
          projectId: input.projectId,
          sessionId: input.sessionId,
          attachment,
          localPathRef: `upload:${attachment.id}`,
        });
        const detectedMime = extraction.detectedMime ?? attachment.mimeType;
        const manifest: FeishuAttachmentManifest = {
          attachmentId: attachment.id,
          source: {
            platform: "feishu",
            messageId: resource.messageId ?? input.messageId,
            resourceKey: resource.fileKey,
            resourceType: resource.type,
          },
          originalName: resource.fileName,
          sanitizedName: attachment.name,
          declaredMime,
          detectedMime,
          kind: attachmentKind(detectedMime),
          sizeBytes: attachment.size,
          sha256: sha256.digest("hex"),
          localPathRef: `upload:${attachment.id}`,
          status:
            extraction.disposition === "extracted"
              ? "extracted"
              : extraction.disposition === "metadata-only"
                ? "scanned"
                : extraction.disposition === "rejected"
                  ? "rejected"
                  : extraction.disposition === "failed"
                    ? "failed"
                    : "downloaded",
          ...(extraction.disposition !== "skipped"
            ? {
                extraction: {
                  extractor: extraction.extractor,
                  version: extraction.version,
                  artifacts: extraction.artifacts,
                  warnings: extraction.issues.map(
                    (item) => `${item.code}: ${item.message}`,
                  ),
                  truncated: extraction.truncated,
                },
              }
            : {}),
        };
        manifests.push(manifest);
        if (
          extraction.disposition !== "rejected" &&
          extraction.disposition !== "failed"
        ) {
          let forwardedAttachment = attachment;
          if (resource.type === "audio") {
            try {
              forwardedAttachment = await this.stageAudioAttachment(
                input.taskId,
                attachment,
              );
            } catch {
              manifest.status = "failed";
              failures.push({
                fileKey: resource.fileKey,
                messageId: resource.messageId ?? input.messageId,
                resourceType: resource.type,
                stage: "stage",
                retryable: true,
                code: "AUDIO_STAGING_FAILED",
              });
              continue;
            }
          }
          try {
            const derivedAttachments = await Promise.all(
              extraction.artifacts.map(
                async (artifact, artifactIndex) =>
                  await this.resolveDerivedAttachment(
                    input,
                    attachment,
                    artifact,
                    artifactIndex,
                  ),
              ),
            );
            // The opaque refs remain the only paths serialized in the
            // canonical manifest. Absolute paths cross only the internal
            // UploadedFile boundary so MessageQueue can give Codex a readable
            // file; they are never copied into Feishu output.
            attachments.push(forwardedAttachment, ...derivedAttachments);
          } catch {
            manifest.status = "failed";
            failures.push({
              fileKey: resource.fileKey,
              messageId: resource.messageId ?? input.messageId,
              resourceType: resource.type,
              stage: "extract",
              retryable: false,
              code: "ARTIFACT_WRITE_FAILED",
            });
          }
        }
        if (extraction.failure) {
          failures.push({
            fileKey: resource.fileKey,
            messageId: resource.messageId ?? input.messageId,
            resourceType: resource.type,
            stage: "extract",
            retryable: extraction.failure.retryable,
            code: extraction.failure.code,
          });
        }
      } catch (error) {
        failures.push({
          fileKey: resource.fileKey,
          messageId: resource.messageId ?? input.messageId,
          resourceType: resource.type,
          stage:
            error instanceof FeishuMediaLimitError
              ? "size-validation"
              : error instanceof UploadContainerError
                ? "ingest"
                : "download",
          retryable:
            !(error instanceof FeishuMediaLimitError) &&
            !(error instanceof UploadContainerError),
          code:
            error instanceof FeishuMediaLimitError
              ? error.code
              : error instanceof UploadContainerError
                ? error.code
                : "DOWNLOAD_FAILED",
        });
      }
    }

    if (manifests.length > 0) {
      const attachmentIds = manifests.map((manifest) => manifest.attachmentId);
      try {
        await this.uploadManager.setTaskAttachmentRetention(
          {
            projectId: input.projectId,
            sessionId: input.sessionId,
            taskId: input.taskId,
          },
          attachmentIds,
          Date.now() + this.retentionMs,
        );
      } catch {
        await this.uploadManager
          .discardTaskAttachments(
            { projectId: input.projectId, sessionId: input.sessionId },
            attachmentIds,
          )
          .catch(() => undefined);
        await this.releaseTaskAudioStaging(input.taskId);
        attachments.length = 0;
        for (const manifest of manifests) manifest.status = "failed";
        failures.push({
          fileKey: "retention",
          messageId: input.messageId,
          resourceType: "file",
          stage: "retention",
          retryable: true,
          code: "RETENTION_REGISTRATION_FAILED",
        });
      }
    }

    return { attachments, manifests, failures };
  }

  /** Start bounded periodic cleanup. Safe to call more than once. */
  async startRetentionCleanup(
    intervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
  ): Promise<void> {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) {
      throw new Error("Invalid Feishu attachment cleanup interval");
    }
    if (this.cleanupTimer) return;
    if (!this.cleanupStart) {
      const epoch = this.cleanupEpoch;
      const task = this.startCleanupTimer(intervalMs, epoch).finally(() => {
        if (this.cleanupStart === task) this.cleanupStart = undefined;
      });
      this.cleanupStart = task;
    }
    await this.cleanupStart;
  }

  stopRetentionCleanup(): void {
    this.cleanupEpoch += 1;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  /** Remove only the random temp directories created for this inbound task. */
  async releaseTaskAudioStaging(taskId: string): Promise<void> {
    const staged = this.audioStagingByTask.get(taskId);
    if (!staged) return;
    this.audioStagingByTask.delete(taskId);
    await Promise.allSettled(
      [...staged.keys()].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  }

  private async runRetentionCleanup(): Promise<void> {
    if (this.cleanupInFlight) return;
    this.cleanupInFlight = true;
    try {
      await this.uploadManager.cleanupExpiredTaskAttachments({ limit: 100 });
      await this.cleanupExpiredAudioStaging();
    } catch {
      // A later sweep retries. Raw filesystem errors must not reach channel output.
    } finally {
      this.cleanupInFlight = false;
    }
  }

  private async startCleanupTimer(
    intervalMs: number,
    epoch: number,
  ): Promise<void> {
    await this.runRetentionCleanup();
    if (epoch !== this.cleanupEpoch || this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      void this.runRetentionCleanup();
    }, intervalMs);
    this.cleanupTimer.unref();
  }

  private async stageAudioAttachment(
    taskId: string,
    attachment: UploadedFile,
  ): Promise<UploadedFile> {
    const stagingRoot = await this.ensureAudioStagingRoot();
    const directory = await mkdtemp(join(stagingRoot, AUDIO_STAGING_PREFIX));
    try {
      await chmod(directory, 0o700);
      const rawExtension = extname(attachment.name).toLowerCase();
      const extension = /^\.[a-z0-9]{1,10}$/.test(rawExtension)
        ? rawExtension
        : ".audio";
      const stagedName = `input${extension}`;
      const stagedPath = join(directory, stagedName);
      await copyFile(attachment.path, stagedPath, fsConstants.COPYFILE_EXCL);
      await chmod(stagedPath, 0o600);
      const metadata = await stat(stagedPath);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.size !== attachment.size
      ) {
        throw new Error("Invalid staged audio copy");
      }
      const expiresAt = Date.now() + this.audioStagingRetentionMs;
      const taskEntries = this.audioStagingByTask.get(taskId) ?? new Map();
      taskEntries.set(directory, expiresAt);
      this.audioStagingByTask.set(taskId, taskEntries);
      return { ...attachment, name: stagedName, path: stagedPath };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  private async ensureAudioStagingRoot(): Promise<string> {
    await mkdir(this.audioStagingRoot, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.audioStagingRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Invalid Feishu audio staging root");
    }
    await chmod(this.audioStagingRoot, 0o700);
    return await realpath(this.audioStagingRoot);
  }

  private async cleanupExpiredAudioStaging(now = Date.now()): Promise<void> {
    for (const [taskId, entries] of this.audioStagingByTask) {
      const expired = [...entries].filter(([, expiresAt]) => expiresAt <= now);
      await Promise.allSettled(
        expired.map(([directory]) =>
          rm(directory, { recursive: true, force: true }),
        ),
      );
      for (const [directory] of expired) entries.delete(directory);
      if (entries.size === 0) this.audioStagingByTask.delete(taskId);
    }

    const root = await realpath(this.audioStagingRoot).catch(() => undefined);
    if (!root) return;
    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    const cutoff = now - this.audioStagingRetentionMs;
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !/^yep-feishu-audio-[A-Za-z0-9]{6}$/.test(entry.name)
      ) {
        continue;
      }
      const candidate = join(root, entry.name);
      const metadata = await stat(candidate).catch(() => undefined);
      if (!metadata || metadata.mtimeMs > cutoff) continue;
      const resolvedCandidate = await realpath(candidate).catch(
        () => undefined,
      );
      if (!resolvedCandidate || !isDirectChild(root, resolvedCandidate))
        continue;
      await rm(resolvedCandidate, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async resolveDerivedAttachment(
    input: Pick<FeishuMediaDownloadInput, "projectId" | "sessionId">,
    source: UploadedFile,
    artifact: AttachmentExtractionArtifact,
    index: number,
  ): Promise<UploadedFile> {
    const path = await this.uploadManager.resolveTaskPathRef(
      { projectId: input.projectId, sessionId: input.sessionId },
      artifact.pathRef,
    );
    const label =
      artifact.kind === "text"
        ? "extracted.txt"
        : artifact.kind === "metadata"
          ? "metadata.json"
          : "archive-index.txt";
    return {
      id: `${source.id}-artifact-${index + 1}`,
      originalName: `${source.originalName}.${label}`,
      name: basename(path),
      path,
      size: artifact.sizeBytes,
      mimeType: artifact.mime,
    };
  }

  private async *guardSize(
    source: AsyncIterable<Uint8Array>,
    getTotalBytes: () => number,
    addTotalBytes: (bytes: number) => void,
    observeChunk: (chunk: Uint8Array) => void,
  ): AsyncIterable<Uint8Array> {
    let fileBytes = 0;
    for await (const chunk of source) {
      fileBytes += chunk.byteLength;
      if (fileBytes > this.maxFileBytes) {
        throw new FeishuMediaLimitError("FILE_TOO_LARGE");
      }
      if (getTotalBytes() + chunk.byteLength > this.maxMessageBytes) {
        throw new FeishuMediaLimitError("MESSAGE_TOO_LARGE");
      }
      addTotalBytes(chunk.byteLength);
      observeChunk(chunk);
      yield chunk;
    }
  }
}

class FeishuMediaLimitError extends Error {
  readonly code: "FILE_TOO_LARGE" | "MESSAGE_TOO_LARGE";

  constructor(code: FeishuMediaLimitError["code"]) {
    super(code);
    this.code = code;
  }
}

function defaultResourceName(
  resource: FeishuResourceDescriptor,
  index: number,
): string {
  const extension =
    resource.type === "image" || resource.type === "sticker"
      ? ".image"
      : resource.type === "audio"
        ? ".audio"
        : resource.type === "video"
          ? ".video"
          : "";
  return `feishu-${index + 1}${extension}`;
}

function defaultResourceMime(resource: FeishuResourceDescriptor): string {
  if (resource.type === "image" || resource.type === "sticker")
    return "image/unknown";
  if (resource.type === "audio") return "audio/unknown";
  if (resource.type === "video") return "video/unknown";
  return "application/octet-stream";
}

function attachmentKind(mimeType: string): FeishuAttachmentManifest["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/vnd.ms-word.document.macroEnabled.12"
  ) {
    return "word";
  }
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel.sheet.macroEnabled.12"
  ) {
    return "excel";
  }
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mimeType === "application/vnd.ms-powerpoint.presentation.macroEnabled.12"
  ) {
    return "ppt";
  }
  if (mimeType.startsWith("text/")) return "text";
  if (mimeType === "application/zip") return "archive";
  if (mimeType === "application/octet-stream") return "binary";
  return "unknown";
}

function isDirectChild(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!candidate.startsWith(prefix)) return false;
  return !candidate.slice(prefix.length).includes(sep);
}
