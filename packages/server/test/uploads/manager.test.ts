import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UploadManager,
  getUploadDir,
  sanitizeFilename,
} from "../../src/uploads/manager.js";

describe("sanitizeFilename", () => {
  it("generates unique ID for each call", () => {
    const result1 = sanitizeFilename("test.txt");
    const result2 = sanitizeFilename("test.txt");
    expect(result1.id).not.toBe(result2.id);
  });

  it("preserves simple filenames with UUID prefix", () => {
    const { id, sanitized } = sanitizeFilename("document.pdf");
    expect(sanitized).toBe(`${id}_document.pdf`);
  });

  it("strips path components (path traversal prevention)", () => {
    const { id, sanitized } = sanitizeFilename("../../../etc/passwd");
    expect(sanitized).toBe(`${id}_passwd`);
    expect(sanitized).not.toContain("..");
    expect(sanitized).not.toContain("/");
  });

  it("handles Windows path separators", () => {
    const { id, sanitized } = sanitizeFilename("C:\\Users\\test\\file.txt");
    expect(sanitized).toBe(`${id}_file.txt`);
  });

  it("replaces null bytes", () => {
    const { sanitized } = sanitizeFilename("file\x00.txt");
    expect(sanitized).not.toContain("\x00");
  });

  it("handles Windows-invalid characters", () => {
    // Test invalid characters: < > : " | ? * (note: / and \ are path separators)
    const { id, sanitized } = sanitizeFilename('file<>:"|?*.txt');
    expect(sanitized).toBe(`${id}_file_______.txt`); // 7 underscores for 7 invalid chars
  });

  it("handles empty filename", () => {
    const { id, sanitized } = sanitizeFilename("");
    expect(sanitized).toBe(`${id}_unnamed`);
  });

  it("handles dot-only filenames", () => {
    const { id, sanitized } = sanitizeFilename(".");
    expect(sanitized).toBe(`${id}_unnamed`);

    const { id: id2, sanitized: sanitized2 } = sanitizeFilename("..");
    expect(sanitized2).toBe(`${id2}_unnamed`);
  });

  it("truncates very long filenames but preserves extension", () => {
    const longName = `${"a".repeat(300)}.pdf`;
    const { sanitized } = sanitizeFilename(longName);
    // UUID (36) + _ (1) + truncated name (200) + .pdf (4) = 241
    expect(sanitized.length).toBeLessThan(250);
    expect(sanitized).toMatch(/\.pdf$/);
  });

  it("handles filenames with only extension", () => {
    const { id, sanitized } = sanitizeFilename(".gitignore");
    expect(sanitized).toBe(`${id}_.gitignore`);
  });
});

describe("getUploadDir", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `upload-test-${randomUUID()}`);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("creates nested directory structure", async () => {
    const dir = await getUploadDir("encoded-project", "session-123", tempDir);
    expect(dir).toBe(join(tempDir, "encoded-project", "session-123"));

    const stats = await stat(dir);
    expect(stats.isDirectory()).toBe(true);
  });

  it("handles special characters in project path", async () => {
    // base64url encoded paths may have - and _
    const dir = await getUploadDir(
      "abc-def_ghi",
      "session-with-dashes",
      tempDir,
    );
    expect(dir).toContain("abc-def_ghi");
    expect(dir).toContain("session-with-dashes");
  });

  it("rejects path segments before creating directories", async () => {
    await expect(
      getUploadDir("../outside", "session", tempDir),
    ).rejects.toThrow("Invalid upload project ID");
    await expect(
      getUploadDir("encoded-project", "../outside", tempDir),
    ).rejects.toThrow("Invalid upload session ID");
  });
});

describe("UploadManager", () => {
  let manager: UploadManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `upload-test-${randomUUID()}`);
    manager = new UploadManager({ uploadsDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("rejects invalid configured size limits", () => {
    expect(
      () =>
        new UploadManager({
          uploadsDir: tempDir,
          maxUploadSizeBytes: Number.NaN,
        }),
    ).toThrow("Invalid maximum upload size");
    expect(
      () => new UploadManager({ uploadsDir: tempDir, maxUploadSizeBytes: -1 }),
    ).toThrow("Invalid maximum upload size");
  });

  describe("startUpload", () => {
    it("creates upload state with correct initial values", async () => {
      const { uploadId, state } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        1024,
        "text/plain",
      );

      expect(uploadId).toBeDefined();
      expect(state.status).toBe("pending");
      expect(state.bytesReceived).toBe(0);
      expect(state.originalName).toBe("test.txt");
      expect(state.expectedSize).toBe(1024);
      expect(state.mimeType).toBe("text/plain");
    });

    it("creates upload directory", async () => {
      const { state } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        1024,
        "text/plain",
      );

      const uploadDir = join(tempDir, "encoded-project", "session-123");
      const stats = await stat(uploadDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe("writeChunk", () => {
    it("writes data and tracks bytes received", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        1024,
        "text/plain",
      );

      const chunk = Buffer.from("Hello, World!");
      const bytesReceived = await manager.writeChunk(uploadId, chunk);

      expect(bytesReceived).toBe(13);
      expect(manager.getState(uploadId)?.status).toBe("streaming");
    });

    it("throws for unknown upload ID", async () => {
      await expect(
        manager.writeChunk("nonexistent", Buffer.from("data")),
      ).rejects.toThrow("Upload not found");
    });

    it("accumulates bytes across chunks", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        100,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("chunk1"));
      const total = await manager.writeChunk(uploadId, Buffer.from("chunk2"));

      expect(total).toBe(12); // 6 + 6
    });

    it("throws for cancelled upload", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        100,
        "text/plain",
      );

      await manager.cancelUpload(uploadId);

      await expect(
        manager.writeChunk(uploadId, Buffer.from("data")),
      ).rejects.toThrow("Upload not found");
    });
  });

  describe("completeUpload", () => {
    it("returns uploaded file info", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        13,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("Hello, World!"));
      const file = await manager.completeUpload(uploadId);

      expect(file.originalName).toBe("test.txt");
      expect(file.size).toBe(13);
      expect(file.mimeType).toBe("text/plain");
      expect(file.path).toContain(file.name);
    });

    it("file is readable after completion", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        13,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("Hello, World!"));
      const file = await manager.completeUpload(uploadId);

      const content = await readFile(file.path, "utf-8");
      expect(content).toBe("Hello, World!");
    });

    it("handles multiple chunks correctly", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        13,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("Hello, "));
      await manager.writeChunk(uploadId, Buffer.from("World!"));
      const file = await manager.completeUpload(uploadId);

      const content = await readFile(file.path, "utf-8");
      expect(content).toBe("Hello, World!");
    });

    it("throws for unknown upload ID", async () => {
      await expect(manager.completeUpload("nonexistent")).rejects.toThrow(
        "Upload not found",
      );
    });

    it("removes upload from tracking after completion", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        13,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("Hello, World!"));
      await manager.completeUpload(uploadId);

      expect(manager.getState(uploadId)).toBeUndefined();
    });

    it("enforces the declared size and supports a zero-byte upload", async () => {
      const tooLarge = await manager.startUpload(
        "encoded-project",
        "session-123",
        "too-large.txt",
        3,
        "text/plain",
      );
      await expect(
        manager.writeChunk(tooLarge.uploadId, Buffer.from("four")),
      ).rejects.toThrow("Upload exceeds declared size");
      await manager.cancelUpload(tooLarge.uploadId);

      const tooSmall = await manager.startUpload(
        "encoded-project",
        "session-123",
        "too-small.txt",
        4,
        "text/plain",
      );
      await manager.writeChunk(tooSmall.uploadId, Buffer.from("123"));
      await expect(manager.completeUpload(tooSmall.uploadId)).rejects.toThrow(
        "Upload size did not match expected size",
      );
      await manager.cancelUpload(tooSmall.uploadId);

      const empty = await manager.startUpload(
        "encoded-project",
        "session-123",
        "empty.txt",
        0,
        "text/plain",
      );
      const completed = await manager.completeUpload(empty.uploadId);
      expect(completed.size).toBe(0);
      expect(await readFile(completed.path)).toEqual(Buffer.alloc(0));
    });
  });

  describe("cancelUpload", () => {
    it("removes partial file", async () => {
      const { uploadId, state } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        1000,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("partial data"));
      await manager.cancelUpload(uploadId);

      // File should not exist
      await expect(stat(state.filePath)).rejects.toThrow();
    });

    it("handles cancellation of non-started upload", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        1000,
        "text/plain",
      );

      // Cancel before any chunks written
      await expect(manager.cancelUpload(uploadId)).resolves.not.toThrow();
    });

    it("handles cancellation of nonexistent upload", async () => {
      await expect(manager.cancelUpload("nonexistent")).resolves.not.toThrow();
    });

    it("removes upload from tracking after cancellation", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        100,
        "text/plain",
      );

      await manager.cancelUpload(uploadId);

      expect(manager.getState(uploadId)).toBeUndefined();
    });
  });

  describe("ingest", () => {
    it("streams a server-side source and corrects MIME from magic bytes", async () => {
      const png = Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        Buffer.from("image-body"),
      ]);

      const file = await manager.ingest({
        projectId: "encoded-project",
        sessionId: "session-123",
        originalName: "../../../preview.bin",
        mimeType: "text/plain",
        expectedSize: png.length,
        stream: chunks(png.subarray(0, 4), png.subarray(4)),
      });

      expect(file.originalName).toBe("../../../preview.bin");
      expect(file.name).toMatch(/_preview\.bin$/);
      expect(file.mimeType).toBe("image/png");
      expect(await readFile(file.path)).toEqual(png);
    });

    it("supports empty streams without leaving a pending upload", async () => {
      const file = await manager.ingest({
        projectId: "encoded-project",
        sessionId: "session-123",
        originalName: "empty.txt",
        mimeType: "text/plain",
        expectedSize: 0,
        stream: chunks(),
      });

      expect(file.size).toBe(0);
      expect(await readFile(file.path)).toEqual(Buffer.alloc(0));
      expect(manager.getState(file.id)).toBeUndefined();
    });

    it.each([
      {
        name: "report.docx",
        entries: ["[Content_Types].xml", "word/document.xml"],
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      {
        name: "sheet.xlsx",
        entries: ["[Content_Types].xml", "xl/workbook.xml"],
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      {
        name: "slides.pptm",
        entries: [
          "[Content_Types].xml",
          "ppt/presentation.xml",
          "ppt/vbaProject.bin",
        ],
        mime: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
      },
    ])(
      "detects OOXML container $name instead of generic ZIP",
      async (testCase) => {
        const archive = zipLocalHeaders(testCase.entries);
        const file = await manager.ingest({
          projectId: "encoded-project",
          sessionId: "session-123",
          originalName: testCase.name,
          mimeType: "application/zip",
          expectedSize: archive.length,
          stream: chunks(archive.subarray(0, 17), archive.subarray(17)),
        });

        expect(file.mimeType).toBe(testCase.mime);
      },
    );

    it("rejects unsafe path segments and mismatched sizes", async () => {
      await expect(
        manager.ingest({
          projectId: "encoded-project",
          sessionId: "../outside",
          originalName: "data.txt",
          mimeType: "text/plain",
          stream: chunks(Buffer.from("data")),
        }),
      ).rejects.toThrow("Invalid upload session ID");

      await expect(
        manager.ingest({
          projectId: "encoded-project",
          sessionId: "session-123",
          originalName: "data.txt",
          mimeType: "text/plain",
          expectedSize: 10,
          stream: chunks(Buffer.from("data")),
        }),
      ).rejects.toThrow("Upload size did not match expected size");
    });

    it("enforces streaming size limits even when expected size is unknown", async () => {
      const limited = new UploadManager({
        uploadsDir: tempDir,
        maxUploadSizeBytes: 5,
      });

      await expect(
        limited.ingest({
          projectId: "encoded-project",
          sessionId: "session-123",
          originalName: "data.txt",
          mimeType: "text/plain",
          stream: chunks(Buffer.from("123456")),
        }),
      ).rejects.toThrow("Upload exceeds maximum allowed size");
    });
  });

  describe("derived artifacts and task retention", () => {
    it("reads an opaque ref only as a bounded regular file in its exact scope", async () => {
      const source = await manager.ingest({
        projectId: "encoded-project",
        sessionId: "session-123",
        originalName: "result.txt",
        mimeType: "text/plain",
        stream: chunks(Buffer.from("safe result")),
      });
      const pathRef = `upload:${source.id}`;

      await expect(
        manager.readTaskPathRefBytes(
          { projectId: "encoded-project", sessionId: "session-123" },
          pathRef,
          32,
        ),
      ).resolves.toEqual(Buffer.from("safe result"));
      await expect(
        manager.readTaskPathRefBytes(
          { projectId: "encoded-project", sessionId: "other-session" },
          pathRef,
          32,
        ),
      ).rejects.toThrow();
      await expect(
        manager.readTaskPathRefBytes(
          { projectId: "encoded-project", sessionId: "session-123" },
          pathRef,
          4,
        ),
      ).rejects.toThrow("bounded regular file");

      const moved = join(tempDir, "moved-result.txt");
      await rename(source.path, moved);
      await symlink(moved, source.path);
      await expect(
        manager.readTaskPathRefBytes(
          { projectId: "encoded-project", sessionId: "session-123" },
          pathRef,
          32,
        ),
      ).rejects.toThrow();
    });

    it("stores derived artifacts behind opaque task-scoped references", async () => {
      const source = await manager.ingest({
        projectId: "encoded-project",
        sessionId: "session-123",
        originalName: "report.pdf",
        mimeType: "application/pdf",
        stream: chunks(Buffer.from("%PDF-source")),
      });

      const artifact = await manager.writeDerivedArtifact({
        projectId: "encoded-project",
        sessionId: "session-123",
        source,
        kind: "text",
        label: "../../pages.txt",
        mime: "text/plain",
        content: Buffer.from("page text"),
      });

      expect(artifact.pathRef).toMatch(
        new RegExp(`^upload:${source.id}:artifact:[A-Za-z0-9-]+$`),
      );
      expect(artifact.pathRef).not.toContain(tempDir);
      const resolved = await manager.resolveTaskPathRef(
        { projectId: "encoded-project", sessionId: "session-123" },
        artifact.pathRef,
      );
      expect(await readFile(resolved, "utf8")).toBe("page text");
      expect(resolved).not.toContain("../");

      await expect(
        manager.resolveTaskPathRef(
          { projectId: "encoded-project", sessionId: "different-session" },
          artifact.pathRef,
        ),
      ).rejects.toThrow();
    });

    it("removes only expired task scopes and reports opaque cleanup results", async () => {
      const nowMs = 2_000_000;
      const expired = await manager.ingest({
        projectId: "encoded-project",
        sessionId: "shared-session",
        originalName: "expired.txt",
        mimeType: "text/plain",
        stream: chunks(Buffer.from("expired")),
      });
      const retained = await manager.ingest({
        projectId: "encoded-project",
        sessionId: "shared-session",
        originalName: "retained.txt",
        mimeType: "text/plain",
        stream: chunks(Buffer.from("retained")),
      });
      await manager.setTaskAttachmentRetention(
        {
          projectId: "encoded-project",
          sessionId: "shared-session",
          taskId: "expired-task",
        },
        [expired.id],
        nowMs + 100,
        nowMs,
      );
      await manager.setTaskAttachmentRetention(
        {
          projectId: "encoded-project",
          sessionId: "shared-session",
          taskId: "retained-task",
        },
        [retained.id],
        nowMs + 10_000,
        nowMs,
      );
      await expect(
        manager.getTaskAttachmentRetention({
          projectId: "encoded-project",
          sessionId: "shared-session",
          taskId: "expired-task",
        }),
      ).resolves.toMatchObject({
        attachmentIds: [expired.id],
        expiresAtMs: nowMs + 100,
      });
      await expect(
        manager.getTaskAttachmentRetention({
          projectId: "encoded-project",
          sessionId: "shared-session",
          taskId: "missing-task",
        }),
      ).resolves.toBeNull();

      const result = await manager.cleanupExpiredTaskAttachments({
        nowMs: nowMs + 1_000,
      });

      expect(result).toMatchObject({
        scannedTasks: 2,
        removedTasks: 1,
        skippedTasks: 1,
        failures: [],
      });
      expect(result.removedBytes).toBeGreaterThanOrEqual(
        Buffer.byteLength("expired"),
      );
      expect(JSON.stringify(result)).not.toContain(tempDir);
      await expect(stat(expired.path)).rejects.toThrow();
      expect((await stat(retained.path)).isFile()).toBe(true);
    });

    it("advances a bounded fair cursor past retained prefixes to expired tail records", async () => {
      const nowMs = 3_000_000;
      const retained = await manager.ingest({
        projectId: "encoded-project",
        sessionId: "cursor-session",
        originalName: "retained.txt",
        mimeType: "text/plain",
        stream: chunks(Buffer.from("retained")),
      });
      const expired = await manager.ingest({
        projectId: "encoded-project",
        sessionId: "cursor-session",
        originalName: "expired.txt",
        mimeType: "text/plain",
        stream: chunks(Buffer.from("expired")),
      });
      await manager.setTaskAttachmentRetention(
        {
          projectId: "encoded-project",
          sessionId: "cursor-session",
          taskId: "a-retained",
        },
        [retained.id],
        nowMs + 10_000,
        nowMs,
      );
      await manager.setTaskAttachmentRetention(
        {
          projectId: "encoded-project",
          sessionId: "cursor-session",
          taskId: "z-expired",
        },
        [expired.id],
        nowMs + 10,
        nowMs,
      );

      const first = await manager.cleanupExpiredTaskAttachments({
        nowMs: nowMs + 100,
        limit: 1,
      });
      expect(first).toMatchObject({
        scannedTasks: 1,
        skippedTasks: 1,
        removedTasks: 0,
      });
      expect((await stat(expired.path)).isFile()).toBe(true);

      const second = await manager.cleanupExpiredTaskAttachments({
        nowMs: nowMs + 100,
        limit: 1,
      });
      expect(second).toMatchObject({
        scannedTasks: 1,
        skippedTasks: 0,
        removedTasks: 1,
      });
      await expect(stat(expired.path)).rejects.toThrow();
      expect((await stat(retained.path)).isFile()).toBe(true);
    });

    it("supports exact idempotent task cleanup and rejects broad scopes", async () => {
      const source = await manager.ingest({
        projectId: "encoded-project",
        sessionId: "shared-session",
        originalName: "data.txt",
        mimeType: "text/plain",
        stream: chunks(Buffer.from("data")),
      });
      const artifact = await manager.writeDerivedArtifact({
        projectId: "encoded-project",
        sessionId: "shared-session",
        source,
        kind: "metadata",
        label: "metadata.json",
        mime: "application/json",
        content: Buffer.from("{}"),
      });
      const artifactPath = await manager.resolveTaskPathRef(
        { projectId: "encoded-project", sessionId: "shared-session" },
        artifact.pathRef,
      );

      await expect(
        manager.cleanupTaskAttachments({
          projectId: "encoded-project",
          sessionId: "../",
          taskId: "task-to-remove",
        }),
      ).rejects.toThrow("Invalid upload session ID");
      await manager.setTaskAttachmentRetention(
        {
          projectId: "encoded-project",
          sessionId: "shared-session",
          taskId: "task-to-remove",
        },
        [source.id],
        2_100_000,
        2_000_000,
      );
      const first = await manager.cleanupTaskAttachments({
        projectId: "encoded-project",
        sessionId: "shared-session",
        taskId: "task-to-remove",
      });
      const second = await manager.cleanupTaskAttachments({
        projectId: "encoded-project",
        sessionId: "shared-session",
        taskId: "task-to-remove",
      });

      expect(first.removed).toBe(true);
      expect(first.removedBytes).toBeGreaterThanOrEqual(source.size);
      expect(second).toEqual({ removed: false, removedBytes: 0 });
      await expect(stat(source.path)).rejects.toThrow();
      await expect(stat(artifactPath)).rejects.toThrow();
    });

    it("discards an exact attachment and its artifacts without a retention record", async () => {
      const source = await manager.ingest({
        projectId: "encoded-project",
        sessionId: "shared-session",
        originalName: "orphan.txt",
        mimeType: "text/plain",
        stream: chunks(Buffer.from("orphan")),
      });
      const artifact = await manager.writeDerivedArtifact({
        projectId: "encoded-project",
        sessionId: "shared-session",
        source,
        kind: "metadata",
        label: "metadata.json",
        mime: "application/json",
        content: Buffer.from("{}"),
      });
      const artifactPath = await manager.resolveTaskPathRef(
        { projectId: "encoded-project", sessionId: "shared-session" },
        artifact.pathRef,
      );

      const discarded = await manager.discardTaskAttachments(
        { projectId: "encoded-project", sessionId: "shared-session" },
        [source.id],
      );

      expect(discarded.removedBytes).toBeGreaterThanOrEqual(source.size);
      await expect(stat(source.path)).rejects.toThrow();
      await expect(stat(artifactPath)).rejects.toThrow();
    });
  });

  describe("getState", () => {
    it("returns undefined for unknown upload", () => {
      expect(manager.getState("nonexistent")).toBeUndefined();
    });

    it("returns current state for active upload", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        100,
        "text/plain",
      );

      const state = manager.getState(uploadId);
      expect(state).toBeDefined();
      expect(state?.originalName).toBe("test.txt");
    });
  });
});

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}

function zipLocalHeaders(names: string[]): Buffer {
  return Buffer.concat(
    names.map((name) => {
      const encoded = Buffer.from(name, "utf8");
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(encoded.length, 26);
      return Buffer.concat([header, encoded]);
    }),
  );
}
