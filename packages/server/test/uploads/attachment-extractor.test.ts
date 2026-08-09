import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UploadedFile } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SafeAttachmentExtractor } from "../../src/uploads/attachment-extractor.js";
import { UploadManager } from "../../src/uploads/manager.js";

describe("SafeAttachmentExtractor", () => {
  let tempDir: string;
  let manager: UploadManager;
  let extractor: SafeAttachmentExtractor;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yep-attachment-extractor-"));
    manager = new UploadManager({ uploadsDir: tempDir });
    extractor = new SafeAttachmentExtractor({ artifactWriter: manager });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("extracts page-addressable PDF text without exposing absolute paths", async () => {
    const attachment = await ingest("report.pdf", "application/pdf", textPdf());
    const result = await extract(attachment);

    expect(result.disposition).toBe("extracted");
    expect(result.failure).toBeUndefined();
    expect(result.artifacts).toHaveLength(2);
    expect(
      result.artifacts.every((item) => item.pathRef.startsWith("upload:")),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(tempDir);

    const textArtifact = result.artifacts.find((item) => item.kind === "text");
    expect(textArtifact).toBeDefined();
    const path = await manager.resolveTaskPathRef(
      scope,
      required(textArtifact).pathRef,
    );
    expect(await readFile(path, "utf8")).toContain("## Page 1\nHello PDF");
  });

  it("uses the opaque managed reference instead of the manifest path", async () => {
    const attachment = await ingest("report.pdf", "application/pdf", textPdf());
    const result = await extractor.extract({
      ...scope,
      attachment: {
        ...attachment,
        path: "/private/forged/provider-path.pdf",
      },
      localPathRef: `upload:${attachment.id}`,
    });

    expect(result.disposition).toBe("extracted");
    expect(JSON.stringify(result)).not.toContain("/private/forged");
  });

  it("fails closed for mismatched opaque refs and manifests", async () => {
    const attachment = await ingest("report.pdf", "application/pdf", textPdf());
    const wrongReference = await extractor.extract({
      ...scope,
      attachment,
      localPathRef: "upload:123e4567-e89b-12d3-a456-426614174000",
    });
    const wrongSize = await extractor.extract({
      ...scope,
      attachment: { ...attachment, size: attachment.size + 1 },
      localPathRef: `upload:${attachment.id}`,
    });

    expect(wrongReference).toMatchObject({
      disposition: "failed",
      failure: { code: "ATTACHMENT_READ_FAILED" },
    });
    expect(wrongSize).toMatchObject({
      disposition: "failed",
      failure: { code: "ATTACHMENT_READ_FAILED" },
    });
    expect(JSON.stringify([wrongReference, wrongSize])).not.toContain(tempDir);
  });

  it("rejects extraction limits that weaken the hard bounds", () => {
    expect(
      () =>
        new SafeAttachmentExtractor({
          artifactWriter: manager,
          maxInputBytes: 64 * 1024 * 1024 + 1,
        }),
    ).toThrow("Invalid attachment extraction limit");
    expect(
      () =>
        new SafeAttachmentExtractor({
          artifactWriter: manager,
          maxArchiveEntryBytes: 10,
          maxArchiveTotalBytes: 9,
        }),
    ).toThrow("Invalid attachment archive limits");
  });

  it("reports a scanned PDF explicitly when OCR is not configured", async () => {
    const attachment = await ingest(
      "scan.pdf",
      "application/pdf",
      scannedPdf(),
    );
    const result = await extract(attachment);

    expect(result.disposition).toBe("metadata-only");
    expect(result.issues.map((item) => item.code)).toEqual([
      "PDF_NO_TEXT_LAYER",
      "OCR_NOT_CONFIGURED",
    ]);
    const path = await manager.resolveTaskPathRef(
      scope,
      required(result.artifacts[0]).pathRef,
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      pages: 1,
      textLayer: false,
      ocr: { status: "not_configured" },
    });
  });

  it("extracts DOCX paragraphs and preserves their order", async () => {
    const attachment = await ingest(
      "report.docx",
      "application/zip",
      createZip([
        entry("[Content_Types].xml", "<Types/>"),
        entry(
          "word/document.xml",
          "<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格 A</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>最后一段</w:t></w:r></w:p></w:body></w:document>",
        ),
      ]),
    );
    expect(attachment.mimeType).toContain("wordprocessingml");

    const result = await extract(attachment);
    const content = await artifactText(required(result.artifacts[0]).pathRef);

    expect(result.disposition).toBe("extracted");
    expect(content.indexOf("第一段")).toBeLessThan(content.indexOf("表格 A"));
    expect(content.indexOf("表格 A")).toBeLessThan(content.indexOf("最后一段"));
  });

  it("extracts XLSX sheet names, ranges, formulas and cached values", async () => {
    const attachment = await ingest(
      "sheet.xlsx",
      "application/zip",
      createZip([
        entry("[Content_Types].xml", "<Types/>"),
        entry(
          "xl/workbook.xml",
          '<workbook><sheets><sheet name="预算" r:id="rId1"/></sheets></workbook>',
        ),
        entry(
          "xl/_rels/workbook.xml.rels",
          '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
        entry("xl/sharedStrings.xml", "<sst><si><t>收入</t></si></sst>"),
        entry(
          "xl/worksheets/sheet1.xml",
          '<worksheet><dimension ref="A1:B1"/><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(1,2)</f><v>3</v></c></row></sheetData></worksheet>',
        ),
      ]),
    );

    const result = await extract(attachment);
    const content = await artifactText(required(result.artifacts[0]).pathRef);

    expect(content).toContain("## Sheet: 预算 (A1:B1)");
    expect(content).toContain("A1\t收入");
    expect(content).toContain("B1\t=SUM(1,2)\t3");
    expect(result.issues.map((item) => item.code)).toContain(
      "FORMULAS_PRESERVED_WITH_CACHED_VALUES",
    );
  });

  it("extracts PPTX slides and notes in slide order", async () => {
    const attachment = await ingest(
      "slides.pptx",
      "application/zip",
      createZip([
        entry("[Content_Types].xml", "<Types/>"),
        entry("ppt/presentation.xml", "<p:presentation/>"),
        entry("ppt/slides/slide2.xml", "<p:sld><a:t>第二页</a:t></p:sld>"),
        entry("ppt/slides/slide1.xml", "<p:sld><a:t>第一页</a:t></p:sld>"),
        entry(
          "ppt/notesSlides/notesSlide1.xml",
          "<p:notes><a:t>演讲者备注</a:t></p:notes>",
        ),
      ]),
    );

    const result = await extract(attachment);
    const content = await artifactText(required(result.artifacts[0]).pathRef);

    expect(content.indexOf("第一页")).toBeLessThan(content.indexOf("第二页"));
    expect(content).toContain("Notes:\n演讲者备注");
  });

  it("marks macro-enabled OOXML as active content without executing it", async () => {
    const attachment = await ingest(
      "report.docm",
      "application/zip",
      createZip([
        entry("[Content_Types].xml", "<Types/>"),
        entry(
          "word/document.xml",
          "<w:document><w:p><w:r><w:t>Safe text</w:t></w:r></w:p></w:document>",
        ),
        entry("word/vbaProject.bin", "macro bytes"),
      ]),
    );

    const result = await extract(attachment);

    expect(attachment.mimeType).toBe(
      "application/vnd.ms-word.document.macroEnabled.12",
    );
    expect(result.disposition).toBe("extracted");
    expect(result.issues.map((item) => item.code)).toContain(
      "ACTIVE_CONTENT_NOT_EXECUTED",
    );
  });

  it.each([
    {
      name: "password-protected",
      archive: createZip([entry("secret.txt", "secret", { flags: 0x1 })]),
      code: "PASSWORD_PROTECTED",
    },
    {
      name: "zip-slip",
      archive: createZip([entry("../escape.txt", "escape")]),
      code: "ARCHIVE_PATH_TRAVERSAL",
    },
    {
      name: "archive-bomb",
      archive: createZip([
        entry("huge.txt", "x", { centralUncompressedSize: 101 * 1024 * 1024 }),
      ]),
      code: "ARCHIVE_BOMB",
    },
    {
      name: "unsupported-compression",
      archive: createZip([
        entry("unsupported.bin", "bytes", { compression: 99 }),
      ]),
      code: "UNSUPPORTED_COMPRESSION",
    },
  ])("rejects $name with a typed failure", async ({ archive, code }) => {
    const result = await extractUntrustedBytes(
      "unsafe.zip",
      "application/zip",
      archive,
    );

    expect(result.disposition).toBe("rejected");
    expect(result.failure?.code).toBe(code);
    expect(result.artifacts).toEqual([]);
  });

  it("fails closed on a damaged ZIP central directory", async () => {
    const attachment = await storedAttachment(
      "damaged.zip",
      "application/zip",
      Buffer.from("PK\u0003\u0004damaged"),
    );
    const result = await extract(attachment);

    expect(result.disposition).toBe("failed");
    expect(result.failure?.code).toBe("MALFORMED_CONTAINER");
  });

  it("fails closed on trailing ZIP polyglot data", async () => {
    const attachment = await storedAttachment(
      "trailing.zip",
      "application/zip",
      Buffer.concat([
        createZip([entry("safe.txt", "safe")]),
        Buffer.from("trailing-data"),
      ]),
    );
    const result = await extract(attachment);

    expect(result.disposition).toBe("failed");
    expect(result.failure?.code).toBe("MALFORMED_CONTAINER");
  });

  it("produces a metadata-only video fallback with duration when available", async () => {
    const video = mp4WithDuration(5_000);
    const attachment = await ingest(
      "clip.mp4",
      "application/octet-stream",
      video,
    );
    const result = await extract(attachment);

    expect(result.disposition).toBe("metadata-only");
    expect(result.issues.map((item) => item.code)).toContain(
      "VIDEO_METADATA_ONLY",
    );
    expect(
      JSON.parse(await artifactText(required(result.artifacts[0]).pathRef)),
    ).toMatchObject({ format: "iso-bmff", durationMs: 5_000 });
  });

  const scope = { projectId: "encoded-project", sessionId: "session-123" };

  async function ingest(
    name: string,
    mimeType: string,
    content: Buffer,
  ): Promise<UploadedFile> {
    return manager.ingest({
      ...scope,
      originalName: name,
      mimeType,
      expectedSize: content.length,
      stream: chunks(content),
    });
  }

  async function storedAttachment(
    name: string,
    mimeType: string,
    content: Buffer,
  ): Promise<UploadedFile> {
    return ingest(name, mimeType, content);
  }

  async function extractUntrustedBytes(
    name: string,
    mimeType: string,
    content: Buffer,
  ) {
    const attachment: UploadedFile = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      originalName: name,
      name: `123e4567-e89b-12d3-a456-426614174000_${name}`,
      path: "ignored-by-opaque-store",
      size: content.length,
      mimeType,
    };
    const directExtractor = new SafeAttachmentExtractor({
      artifactWriter: {
        async readTaskPathRefBytes(requestedScope, pathRef, maxBytes) {
          expect(requestedScope).toEqual(scope);
          expect(pathRef).toBe(`upload:${attachment.id}`);
          if (content.length > maxBytes) throw new Error("bounded read");
          return content;
        },
        async writeDerivedArtifact() {
          throw new Error("unsafe fixture must not produce an artifact");
        },
      },
    });
    return directExtractor.extract({
      ...scope,
      attachment,
      localPathRef: `upload:${attachment.id}`,
    });
  }

  async function extract(attachment: UploadedFile) {
    return extractor.extract({
      ...scope,
      attachment,
      localPathRef: `upload:${attachment.id}`,
    });
  }

  async function artifactText(pathRef: string): Promise<string> {
    return readFile(await manager.resolveTaskPathRef(scope, pathRef), "utf8");
  }
});

interface ZipEntryFixture {
  name: string;
  data: Buffer;
  flags: number;
  compression: number;
  centralUncompressedSize?: number;
}

function entry(
  name: string,
  data: string | Buffer,
  options: Partial<
    Pick<ZipEntryFixture, "flags" | "compression" | "centralUncompressedSize">
  > = {},
): ZipEntryFixture {
  return {
    name,
    data: Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"),
    flags: options.flags ?? 0,
    compression: options.compression ?? 0,
    ...(options.centralUncompressedSize !== undefined
      ? { centralUncompressedSize: options.centralUncompressedSize }
      : {}),
  };
}

function createZip(entries: ZipEntryFixture[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, "utf8");
    const checksum = crc32(item.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(item.flags, 6);
    local.writeUInt16LE(item.compression, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(item.data.length, 18);
    local.writeUInt32LE(item.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, item.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(item.flags, 8);
    central.writeUInt16LE(item.compression, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(item.data.length, 20);
    central.writeUInt32LE(item.centralUncompressedSize ?? item.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
    localOffset += local.length + name.length + item.data.length;
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

function textPdf(): Buffer {
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
(Hello PDF) Tj
endstream
endobj
trailer << /Root 1 0 R >>
%%EOF`);
}

function scannedPdf(): Buffer {
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 7 >>
stream
/Im0 Do
endstream
endobj
%%EOF`);
}

function mp4WithDuration(durationMs: number): Buffer {
  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write("isom", 0, "ascii");
  ftypPayload.writeUInt32BE(0, 4);
  ftypPayload.write("isom", 8, "ascii");
  ftypPayload.write("mp42", 12, "ascii");
  const mvhdPayload = Buffer.alloc(20);
  mvhdPayload.writeUInt32BE(1_000, 12);
  mvhdPayload.writeUInt32BE(durationMs, 16);
  return Buffer.concat([
    isoBox("ftyp", ftypPayload),
    isoBox("moov", isoBox("mvhd", mvhdPayload)),
  ]);
}

function isoBox(type: string, payload: Buffer): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, "ascii");
  payload.copy(box, 8);
  return box;
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

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing expected test value");
  return value;
}
