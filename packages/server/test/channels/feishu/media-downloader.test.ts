import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuMediaDownloader } from "../../../src/channels/feishu/media-downloader.js";
import type { FeishuMessageApi } from "../../../src/channels/feishu/normalization/types.js";
import { UploadManager } from "../../../src/uploads/manager.js";

describe("FeishuMediaDownloader", () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("downloads child-message resources through UploadManager", async () => {
    const uploadsDir = await createDataDir(dataDirs);
    const pdfFixture = minimalTextPdf();
    const downloadMessageResource = vi.fn(
      async (_messageId: string, fileKey: string) =>
        fileKey === "img_fixture"
          ? chunks(
              Buffer.concat([
                Buffer.from("89504e470d0a1a0a", "hex"),
                Buffer.from("png-body"),
              ]),
            )
          : chunks(pdfFixture),
    );
    const downloader = new FeishuMediaDownloader({
      uploadManager: new UploadManager({ uploadsDir }),
    });

    const result = await downloader.downloadAll({
      api: {
        fetchMessageItems: async () => [],
        downloadMessageResource,
      },
      messageId: "om_root",
      projectId: "encoded-project",
      sessionId: "session-123",
      taskId: "task-123",
      resources: [
        {
          type: "image",
          fileKey: "img_fixture",
          messageId: "om_child_image",
        },
        {
          type: "file",
          fileKey: "file_fixture",
          fileName: "report.pdf",
          messageId: "om_child_file",
        },
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.attachments.map((file) => file.mimeType)).toEqual([
      "image/png",
      "application/pdf",
      "text/plain",
      "application/json",
    ]);
    expect(result.manifests).toEqual([
      expect.objectContaining({
        source: {
          platform: "feishu",
          messageId: "om_child_image",
          resourceKey: "img_fixture",
          resourceType: "image",
        },
        declaredMime: "image/unknown",
        detectedMime: "image/png",
        kind: "image",
        sizeBytes: 16,
        sha256: createHash("sha256")
          .update(
            Buffer.concat([
              Buffer.from("89504e470d0a1a0a", "hex"),
              Buffer.from("png-body"),
            ]),
          )
          .digest("hex"),
        status: "downloaded",
      }),
      expect.objectContaining({
        originalName: "report.pdf",
        detectedMime: "application/pdf",
        kind: "pdf",
        sha256: createHash("sha256").update(pdfFixture).digest("hex"),
        status: "extracted",
        extraction: expect.objectContaining({
          extractor: "yep-safe-attachment",
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              kind: "text",
              pathRef: expect.stringMatching(/^upload:/),
            }),
          ]),
        }),
      }),
    ]);
    expect(result.manifests[0]?.localPathRef).toMatch(/^upload:/);
    expect(result.manifests[0]?.localPathRef).not.toContain(uploadsDir);
    expect(downloadMessageResource).toHaveBeenNthCalledWith(
      1,
      "om_child_image",
      "img_fixture",
      "image",
    );
    expect(downloadMessageResource).toHaveBeenNthCalledWith(
      2,
      "om_child_file",
      "file_fixture",
      "file",
    );
    expect(await readFile(result.attachments[1]?.path)).toEqual(pdfFixture);
    expect(await readFile(result.attachments[2]?.path, "utf8")).toContain(
      "Fixture PDF",
    );
    expect(
      JSON.parse(
        await readFile(
          join(
            uploadsDir,
            "encoded-project",
            "session-123",
            ".retention",
            "task-123.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({
      taskId: "task-123",
      attachmentIds: result.manifests
        .map((manifest) => manifest.attachmentId)
        .sort(),
    });
  });

  it("reports fixed failure codes and continues after an oversized file", async () => {
    const uploadsDir = await createDataDir(dataDirs);
    const api: FeishuMessageApi = {
      fetchMessageItems: async () => [],
      downloadMessageResource: async (_messageId, fileKey) =>
        fileKey === "too_large"
          ? chunks(Buffer.from("123456"))
          : chunks(Buffer.from("ok")),
    };
    const downloader = new FeishuMediaDownloader({
      uploadManager: new UploadManager({ uploadsDir }),
      maxFileBytes: 5,
      maxMessageBytes: 10,
    });

    const result = await downloader.downloadAll({
      api,
      messageId: "om_root",
      projectId: "encoded-project",
      sessionId: "session-123",
      taskId: "task-123",
      resources: [
        { type: "file", fileKey: "too_large" },
        { type: "file", fileKey: "small", fileName: "small.txt" },
      ],
    });

    expect(result.failures).toEqual([
      {
        fileKey: "too_large",
        messageId: "om_root",
        resourceType: "file",
        stage: "size-validation",
        retryable: false,
        code: "FILE_TOO_LARGE",
      },
    ]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.originalName).toBe("small.txt");
  });

  it("stages audio in a private process-temp path and removes it at terminal cleanup", async () => {
    const uploadsDir = await createDataDir(dataDirs);
    const audioStagingRoot = await createDataDir(dataDirs);
    const audio = Buffer.from("safe-audio-fixture");
    const downloader = new FeishuMediaDownloader({
      uploadManager: new UploadManager({ uploadsDir }),
      audioStagingRoot,
    });

    const result = await downloader.downloadAll({
      api: {
        fetchMessageItems: async () => [],
        downloadMessageResource: async () => chunks(audio),
      },
      messageId: "om_audio",
      projectId: "encoded-project",
      sessionId: "session-123",
      taskId: "task-audio",
      resources: [{ type: "audio", fileKey: "audio_fixture" }],
    });

    expect(result.failures).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    const stagedPath = result.attachments[0]?.path ?? "";
    expect(
      stagedPath.startsWith(`${await realpath(audioStagingRoot)}${sep}`),
    ).toBe(true);
    expect(stagedPath).not.toContain(uploadsDir);
    expect(await readFile(stagedPath)).toEqual(audio);
    expect((await stat(stagedPath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result.manifests)).not.toContain(audioStagingRoot);
    expect(result.manifests[0]).toMatchObject({
      kind: "audio",
      localPathRef: expect.stringMatching(/^upload:/),
    });

    await downloader.releaseTaskAudioStaging("task-audio");
    await expect(readFile(stagedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed when the configured audio staging root is a symlink", async () => {
    const uploadsDir = await createDataDir(dataDirs);
    const linkParent = await createDataDir(dataDirs);
    const linkTarget = await createDataDir(dataDirs);
    const audioStagingRoot = join(linkParent, "stage-link");
    await symlink(linkTarget, audioStagingRoot, "dir");
    const downloader = new FeishuMediaDownloader({
      uploadManager: new UploadManager({ uploadsDir }),
      audioStagingRoot,
    });

    const result = await downloader.downloadAll({
      api: {
        fetchMessageItems: async () => [],
        downloadMessageResource: async () => chunks(Buffer.from("audio")),
      },
      messageId: "om_audio",
      projectId: "encoded-project",
      sessionId: "session-123",
      taskId: "task-audio-symlink",
      resources: [{ type: "audio", fileKey: "audio_fixture" }],
    });

    expect(result.attachments).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        resourceType: "audio",
        stage: "stage",
        code: "AUDIO_STAGING_FAILED",
      }),
    ]);
    expect(result.manifests[0]?.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(linkTarget);
  });

  it("fails explicitly when download capability is unavailable", async () => {
    const uploadsDir = await createDataDir(dataDirs);
    const downloader = new FeishuMediaDownloader({
      uploadManager: new UploadManager({ uploadsDir }),
    });

    const result = await downloader.downloadAll({
      api: { fetchMessageItems: async () => [] },
      messageId: "om_root",
      projectId: "encoded-project",
      sessionId: "session-123",
      taskId: "task-123",
      resources: [{ type: "image", fileKey: "img_fixture" }],
    });

    expect(result).toEqual({
      attachments: [],
      manifests: [],
      failures: [
        {
          fileKey: "img_fixture",
          messageId: "om_root",
          resourceType: "image",
          stage: "authorize",
          retryable: false,
          code: "DOWNLOAD_CAPABILITY_MISSING",
        },
      ],
    });
  });

  it("attaches safe Office extraction artifacts to the canonical manifest", async () => {
    const uploadsDir = await createDataDir(dataDirs);
    const archive = createZip([
      ["[Content_Types].xml", "<Types/>"],
      [
        "word/document.xml",
        "<w:document><w:p><w:r><w:t>Feishu report</w:t></w:r></w:p></w:document>",
      ],
    ]);
    const downloader = new FeishuMediaDownloader({
      uploadManager: new UploadManager({ uploadsDir }),
    });

    const result = await downloader.downloadAll({
      api: {
        fetchMessageItems: async () => [],
        downloadMessageResource: async () => chunks(archive),
      },
      messageId: "om_root",
      projectId: "encoded-project",
      sessionId: "session-123",
      taskId: "task-123",
      resources: [{ type: "file", fileKey: "docx", fileName: "report.docx" }],
    });

    expect(result.failures).toEqual([]);
    expect(result.attachments.map((file) => file.mimeType)).toEqual([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ]);
    expect(await readFile(result.attachments[1]?.path, "utf8")).toContain(
      "Feishu report",
    );
    expect(result.manifests[0]).toMatchObject({
      kind: "word",
      status: "extracted",
      extraction: {
        extractor: "yep-safe-attachment",
        version: "1",
        truncated: false,
        warnings: [],
        artifacts: [
          expect.objectContaining({
            kind: "text",
            mime: "text/plain",
            pathRef: expect.stringMatching(/^upload:/),
          }),
        ],
      },
    });
    expect(JSON.stringify(result.manifests)).not.toContain(uploadsDir);
  });

  it("reports typed ingest and extraction failures without raw paths", async () => {
    const uploadsDir = await createDataDir(dataDirs);
    const protectedZip = createZip([["secret.txt", "secret"]], 0x1);
    const downloader = new FeishuMediaDownloader({
      uploadManager: new UploadManager({ uploadsDir }),
    });
    const payloads = new Map<string, Buffer>([
      ["protected", protectedZip],
      ["damaged", Buffer.from("PK\u0003\u0004damaged")],
    ]);

    const result = await downloader.downloadAll({
      api: {
        fetchMessageItems: async () => [],
        downloadMessageResource: async (_messageId, key) => {
          const payload = payloads.get(key);
          if (!payload) throw new Error("Missing media fixture");
          return chunks(payload);
        },
      },
      messageId: "om_root",
      projectId: "encoded-project",
      sessionId: "session-123",
      taskId: "task-123",
      resources: [
        { type: "file", fileKey: "protected", fileName: "protected.zip" },
        { type: "file", fileKey: "damaged", fileName: "damaged.zip" },
      ],
    });

    expect(result.failures).toEqual([
      expect.objectContaining({
        fileKey: "protected",
        stage: "ingest",
        retryable: false,
        code: "PASSWORD_PROTECTED",
      }),
      expect.objectContaining({
        fileKey: "damaged",
        stage: "extract",
        retryable: false,
        code: "MALFORMED_CONTAINER",
      }),
    ]);
    expect(result.manifests[0]).toMatchObject({
      status: "failed",
      extraction: expect.objectContaining({ extractor: "yep-safe-attachment" }),
    });
    expect(
      JSON.stringify({
        manifests: result.manifests,
        failures: result.failures,
      }),
    ).not.toContain(uploadsDir);
  });

  it("fails closed and discards media when task retention cannot be registered", async () => {
    const uploadsDir = await createDataDir(dataDirs);
    const uploadManager = new UploadManager({ uploadsDir });
    vi.spyOn(uploadManager, "setTaskAttachmentRetention").mockRejectedValue(
      new Error("private disk error"),
    );
    const discard = vi.spyOn(uploadManager, "discardTaskAttachments");
    const downloader = new FeishuMediaDownloader({ uploadManager });

    const result = await downloader.downloadAll({
      api: {
        fetchMessageItems: async () => [],
        downloadMessageResource: async () =>
          chunks(
            Buffer.concat([
              Buffer.from("89504e470d0a1a0a", "hex"),
              Buffer.from("png-body"),
            ]),
          ),
      },
      messageId: "om_retention",
      projectId: "encoded-project",
      sessionId: "session-123",
      taskId: "task-123",
      resources: [{ type: "image", fileKey: "image" }],
    });

    expect(result.attachments).toEqual([]);
    expect(result.manifests).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        stage: "retention",
        code: "RETENTION_REGISTRATION_FAILED",
      }),
    );
    expect(discard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private disk error");
    expect(JSON.stringify(result)).not.toContain(uploadsDir);
  });
});

async function createDataDir(dataDirs: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-media-"));
  dataDirs.push(dataDir);
  return dataDir;
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}

function minimalTextPdf(): Buffer {
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 17 >>
stream
(Fixture PDF) Tj
endstream
endobj
%%EOF`);
}

function createZip(entries: Array<[string, string]>, flags = 0): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const [entryName, value] of entries) {
    const name = Buffer.from(entryName, "utf8");
    const data = Buffer.from(value, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
    localOffset += local.length + name.length + data.length;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
