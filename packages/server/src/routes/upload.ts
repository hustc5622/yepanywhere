import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type UploadClientMessage,
  type UploadCompleteMessage,
  type UploadErrorMessage,
  type UploadProgressMessage,
  type UploadServerMessage,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { WSContext, WSEvents } from "hono/ws";
import type { ProjectScanner } from "../projects/scanner.js";
import {
  GeneratedArtifactAccessError,
  UPLOADS_DIR,
  UploadManager,
  isGeneratedArtifactStorageFilename,
} from "../uploads/index.js";

/** Progress update interval in bytes (64KB) */
const PROGRESS_INTERVAL_BYTES = 64 * 1024;
const STABLE_MANAGED_DOWNLOAD_BYTES = 30 * 1024 * 1024;

// biome-ignore lint/suspicious/noExplicitAny: Complex third-party type from @hono/node-ws
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface UploadDeps {
  scanner: ProjectScanner;
  upgradeWebSocket: UpgradeWebSocketFn;
  /** Maximum upload file size in bytes. 0 = unlimited */
  maxUploadSizeBytes?: number;
  /** Test/embedding override; must refer to the same root as uploadManager. */
  uploadsDir?: string;
  uploadManager?: UploadManager;
  now?: () => number;
}

export function createUploadRoutes(deps: UploadDeps): Hono {
  const routes = new Hono();
  const uploadsDir = deps.uploadsDir ?? UPLOADS_DIR;
  const uploadManager =
    deps.uploadManager ??
    new UploadManager({
      uploadsDir,
      maxUploadSizeBytes: deps.maxUploadSizeBytes,
    });
  const now = deps.now ?? Date.now;

  const sendMessage = (ws: WSContext, msg: UploadServerMessage) => {
    ws.send(JSON.stringify(msg));
  };

  const sendError = (ws: WSContext, message: string, code?: string) => {
    const errorMsg: UploadErrorMessage = { type: "error", message, code };
    sendMessage(ws, errorMsg);
  };

  // WebSocket endpoint: /projects/:projectId/sessions/:sessionId/upload/ws
  routes.get(
    "/projects/:projectId/sessions/:sessionId/upload/ws",
    deps.upgradeWebSocket((c) => {
      const projectId = c.req.param("projectId") as string;
      const sessionId = c.req.param("sessionId") as string;

      // Track current upload for this connection
      let currentUploadId: string | null = null;
      let lastProgressSent = 0;

      // Validation promise - we need to await this before processing messages
      // because onOpen can be async but @hono/node-ws doesn't wait for it
      let validationPromise: Promise<boolean> | null = null;
      let validationResult: boolean | null = null;

      // Message queue to serialize async message handling
      // This prevents race conditions where binary chunks arrive before
      // the async startUpload() completes
      let messageQueue: Promise<void> = Promise.resolve();

      const validate = async (): Promise<boolean> => {
        // Validate projectId format
        if (!isUrlProjectId(projectId)) {
          return false;
        }

        // Validate project exists
        const project = await deps.scanner.getProject(projectId);
        if (!project) {
          return false;
        }

        return true;
      };

      // Process a single message - must be called sequentially via the queue
      const processMessage = async (
        data: string | ArrayBuffer | SharedArrayBuffer | Buffer | Blob,
        ws: WSContext,
      ): Promise<void> => {
        // Wait for validation to complete if it hasn't yet
        if (validationResult === null && validationPromise) {
          validationResult = await validationPromise;
        }

        if (!validationResult) {
          sendError(ws, "Connection not validated", "NOT_VALIDATED");
          return;
        }

        // When using the unified upgrade handler with wss.handleUpgrade,
        // the 'ws' library delivers ALL messages as Buffer by default,
        // bypassing @hono/node-ws's text/binary conversion.
        // We need to handle both Buffer and string data types.

        // Convert Buffer/ArrayBuffer to string for potential JSON parsing
        let stringData: string | null = null;
        let bufferData: Buffer | null = null;

        if (typeof data === "string") {
          stringData = data;
        } else if (
          data instanceof ArrayBuffer ||
          data instanceof SharedArrayBuffer ||
          Buffer.isBuffer(data)
        ) {
          bufferData = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
          // Try to interpret as UTF-8 string for JSON control messages
          stringData = bufferData.toString("utf8");
        } else if (data instanceof Blob) {
          // Blob handling (rare in Node.js WebSocket but possible)
          const arrayBuffer = await data.arrayBuffer();
          bufferData = Buffer.from(arrayBuffer);
          stringData = bufferData.toString("utf8");
        }

        // Try to parse as JSON control message first
        let msg: UploadClientMessage | null = null;
        if (stringData) {
          const trimmed = stringData.trim();
          if (trimmed.startsWith("{")) {
            try {
              msg = JSON.parse(trimmed) as UploadClientMessage;
            } catch {
              // Not valid JSON - treat as binary data
              msg = null;
            }
          }
        }

        // If we parsed a control message, handle it
        if (msg !== null) {
          switch (msg.type) {
            case "start": {
              // Clean up any previous upload
              if (currentUploadId) {
                await uploadManager.cancelUpload(currentUploadId);
              }

              try {
                const { uploadId } = await uploadManager.startUpload(
                  projectId,
                  sessionId,
                  msg.name,
                  msg.size,
                  msg.mimeType,
                );
                currentUploadId = uploadId;
                lastProgressSent = 0;
              } catch (err) {
                const message =
                  err instanceof Error ? err.message : "Failed to start upload";
                sendError(ws, message, "START_ERROR");
              }
              break;
            }

            case "end": {
              if (!currentUploadId) {
                sendError(ws, "No upload in progress", "NO_UPLOAD");
                return;
              }

              const uploadId = currentUploadId;
              try {
                const file = await uploadManager.completeUpload(uploadId);
                const complete: UploadCompleteMessage = {
                  type: "complete",
                  file,
                };
                sendMessage(ws, complete);
                currentUploadId = null;
              } catch (err) {
                const message =
                  err instanceof Error
                    ? err.message
                    : "Failed to complete upload";
                sendError(ws, message, "COMPLETE_ERROR");
                await uploadManager.cancelUpload(uploadId);
                currentUploadId = null;
              }
              break;
            }

            case "cancel": {
              if (currentUploadId) {
                await uploadManager.cancelUpload(currentUploadId);
                currentUploadId = null;
              }
              break;
            }
          }
          return;
        }

        // Otherwise, treat as binary chunk data
        if (!currentUploadId) {
          sendError(
            ws,
            "No upload started - send start message first",
            "NO_UPLOAD",
          );
          return;
        }

        const uploadId = currentUploadId;
        try {
          // Convert to Buffer if needed (bufferData should already be set at this point)
          const chunk =
            bufferData ?? (typeof data === "string" ? Buffer.from(data) : null);
          if (!chunk) {
            sendError(ws, "Invalid chunk data", "INVALID_CHUNK");
            return;
          }

          const bytesReceived = await uploadManager.writeChunk(uploadId, chunk);

          // Send progress updates periodically
          if (bytesReceived - lastProgressSent >= PROGRESS_INTERVAL_BYTES) {
            const progress: UploadProgressMessage = {
              type: "progress",
              bytesReceived,
            };
            sendMessage(ws, progress);
            lastProgressSent = bytesReceived;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Write failed";
          sendError(ws, message, "WRITE_ERROR");
          await uploadManager.cancelUpload(uploadId);
          currentUploadId = null;
        }
      };

      return {
        onOpen(_evt, ws) {
          // Start validation (don't await - @hono/node-ws doesn't support async onOpen)
          validationPromise = validate();
          validationPromise.then((result) => {
            validationResult = result;
            if (!result) {
              sendError(ws, "Project validation failed", "VALIDATION_FAILED");
              ws.close(1008, "Validation failed");
            }
          });
        },

        onMessage(evt, ws) {
          // Queue this message to be processed after all previous messages complete
          // This serializes async processing and prevents race conditions
          messageQueue = messageQueue.then(() =>
            processMessage(evt.data, ws).catch((err) => {
              console.error("[Upload WS] Unexpected error:", err);
              sendError(ws, "Internal error", "INTERNAL_ERROR");
            }),
          );
        },

        async onClose(_evt, _ws) {
          // Wait for any pending messages to complete
          await messageQueue;
          // Clean up partial uploads on disconnect
          if (currentUploadId) {
            await uploadManager.cancelUpload(currentUploadId);
          }
        },

        onError(_evt, _ws) {
          // Clean up on error
          if (currentUploadId) {
            uploadManager.cancelUpload(currentUploadId).catch(() => {});
          }
        },
      };
    }),
  );

  // Generated artifacts have a separate hash-bound route. Registry and
  // retention are mandatory here; ordinary uploads never enter this branch.
  routes.get(
    "/projects/:projectId/sessions/:sessionId/generated-artifact/:artifactId/:sha256/:filename",
    async (c) => {
      const projectId = c.req.param("projectId") as string;
      const sessionId = c.req.param("sessionId") as string;
      const artifactId = c.req.param("artifactId") as string;
      const sha256 = c.req.param("sha256") as string;
      const fileName = c.req.param("filename") as string;
      if (
        !isUrlProjectId(projectId) ||
        !isSafeUploadPathSegment(sessionId) ||
        !/^ga_[a-f0-9]{32}$/.test(artifactId) ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        !isSafeGeneratedArtifactPublicFileName(fileName)
      ) {
        return c.json({ error: "Invalid generated artifact" }, 400);
      }
      try {
        const result = await uploadManager.readGeneratedArtifactBytes(
          { projectId, sessionId },
          {
            artifactId,
            sha256: `sha256:${sha256}`,
            fileName,
          },
          now(),
        );
        c.header("Content-Type", result.record.mimeType);
        c.header("Content-Length", result.record.sizeBytes.toString());
        c.header("Cache-Control", "private, no-store");
        c.header("X-Content-Type-Options", "nosniff");
        if (
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            result.record.mimeType,
          ) ||
          c.req.query("download") === "1"
        ) {
          c.header(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeRfc5987Value(fileName)}`,
          );
        }
        const responseBytes = new Uint8Array(result.bytes.byteLength);
        responseBytes.set(result.bytes);
        return c.body(responseBytes);
      } catch (error) {
        if (error instanceof GeneratedArtifactAccessError) {
          if (error.code === "EXPIRED") {
            return c.json({ error: "Artifact expired" }, 410);
          }
          if (error.code === "INTEGRITY") {
            return c.json({ error: "Artifact integrity check failed" }, 409);
          }
          return c.json({ error: "Artifact not found" }, 404);
        }
        return c.json({ error: "Artifact not found" }, 404);
      }
    },
  );

  // GET endpoint: /projects/:projectId/sessions/:sessionId/upload/:filename
  // Serves uploaded files for viewing in the client
  routes.get(
    "/projects/:projectId/sessions/:sessionId/upload/:filename",
    async (c) => {
      const projectId = c.req.param("projectId") as string;
      const sessionId = c.req.param("sessionId") as string;
      const filename = c.req.param("filename") as string;

      // Validate projectId format
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID" }, 400);
      }

      if (!isSafeUploadPathSegment(sessionId)) {
        return c.json({ error: "Invalid session ID" }, 400);
      }

      // Validate filename - must have UUID prefix format
      if (!isSafeManagedUploadFilename(filename)) {
        return c.json({ error: "Invalid filename" }, 400);
      }
      if (isGeneratedArtifactStorageFilename(filename)) {
        return c.json({ error: "File not found" }, 404);
      }

      const uploadsRoot = resolve(uploadsDir);
      const filePath = resolve(uploadsRoot, projectId, sessionId, filename);
      if (!isContainedUploadPath(uploadsRoot, filePath)) {
        return c.json({ error: "Invalid path" }, 400);
      }

      try {
        const rootRealPath = await realpath(uploadsRoot);
        await assertNoSymlinkUploadComponents(rootRealPath, [
          projectId,
          sessionId,
          filename,
        ]);
        const before = await lstat(filePath, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink()) {
          return c.json({ error: "Not a file" }, 404);
        }
        const fileRealPath = await realpath(filePath);
        if (!isContainedUploadPath(rootRealPath, fileRealPath)) {
          return c.json({ error: "Invalid path" }, 400);
        }
        const handle = await open(
          filePath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        const opened = await handle
          .stat({ bigint: true })
          .catch(async (error) => {
            await handle.close().catch(() => undefined);
            throw error;
          });
        if (!sameUploadFile(before, opened)) {
          await handle.close();
          return c.json({ error: "File changed" }, 409);
        }
        let stableBytes: Buffer | undefined;
        if (opened.size <= BigInt(STABLE_MANAGED_DOWNLOAD_BYTES)) {
          try {
            stableBytes = await handle.readFile();
            const after = await handle.stat({ bigint: true });
            const realPathAfterRead = await realpath(filePath);
            if (
              !sameUploadFile(opened, after) ||
              BigInt(stableBytes.length) !== after.size ||
              realPathAfterRead !== fileRealPath
            ) {
              await handle.close();
              return c.json({ error: "File changed" }, 409);
            }
          } catch (error) {
            await handle.close();
            throw error;
          }
          await handle.close();
        }

        // Determine content type from filename extension
        const ext = filename.split(".").pop()?.toLowerCase() ?? "";
        const mimeTypes: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          pdf: "application/pdf",
          txt: "text/plain; charset=utf-8",
          md: "text/markdown; charset=utf-8",
          csv: "text/csv; charset=utf-8",
          json: "application/json",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          mp4: "video/mp4",
        };
        const contentType = mimeTypes[ext] ?? "application/octet-stream";
        const canPreview = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);

        c.header("Content-Type", contentType);
        c.header("Content-Length", opened.size.toString());
        c.header("Cache-Control", "private, no-store");
        c.header("X-Content-Type-Options", "nosniff");
        if (!canPreview || c.req.query("download") === "1") {
          c.header(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeRfc5987Value(filename)}`,
          );
        }

        if (stableBytes) {
          const responseBytes = new Uint8Array(stableBytes.byteLength);
          responseBytes.set(stableBytes);
          return c.body(responseBytes);
        }
        return stream(c, async (s) => {
          try {
            const readable = handle.createReadStream({ autoClose: false });
            for await (const chunk of readable) {
              await s.write(chunk);
            }
          } finally {
            await handle.close();
          }
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return c.json({ error: "File not found" }, 404);
        }
        if ((err as NodeJS.ErrnoException).code === "EINVAL") {
          return c.json({ error: "Invalid path" }, 400);
        }
        console.error(
          "[Upload] Error serving managed file:",
          (err as NodeJS.ErrnoException).code ?? "UNKNOWN",
        );
        return c.json({ error: "Internal error" }, 500);
      }
    },
  );

  return routes;
}

function isSafeUploadPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}

function isSafeManagedUploadFilename(value: string): boolean {
  return (
    value.length <= 280 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/.test(
      value,
    ) &&
    !hasUnsafeUploadPathCharacter(value.slice(37)) &&
    !value.includes("..")
  );
}

function isSafeGeneratedArtifactPublicFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("..") &&
    !hasUnsafeUploadPathCharacter(value)
  );
}

function hasUnsafeUploadPathCharacter(value: string): boolean {
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

function isContainedUploadPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

async function assertNoSymlinkUploadComponents(
  root: string,
  components: string[],
): Promise<void> {
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    if (!isContainedUploadPath(root, current)) {
      throw Object.assign(new Error("Upload path escaped its root"), {
        code: "EINVAL",
      });
    }
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw Object.assign(new Error("Upload path contains a symlink"), {
        code: "EINVAL",
      });
    }
  }
}

function sameUploadFile(left: BigIntStats, right: BigIntStats): boolean {
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

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
