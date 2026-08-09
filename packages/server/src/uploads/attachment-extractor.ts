import { inflateRawSync, inflateSync } from "node:zlib";
import type { UploadedFile } from "@yep-anywhere/shared";

const DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_ENTRIES = 10_000;
const DEFAULT_MAX_ARCHIVE_ENTRY_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_TOTAL_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_EXPANSION_RATIO = 100;
const MAX_PDF_OBJECTS = 50_000;
const MAX_PDF_PAGES = 10_000;
const MAX_PDF_REFERENCES_PER_PAGE = 2_048;

export type AttachmentExtractionDisposition =
  | "extracted"
  | "metadata-only"
  | "skipped"
  | "rejected"
  | "failed";

export type AttachmentExtractionIssueCode =
  | "ACTIVE_CONTENT_NOT_EXECUTED"
  | "ARCHIVE_LIST_ONLY"
  | "COMMENTS_NOT_EXTRACTED"
  | "FORMULAS_PRESERVED_WITH_CACHED_VALUES"
  | "MIME_CONTAINER_MISMATCH"
  | "OCR_NOT_CONFIGURED"
  | "PDF_NO_TEXT_LAYER"
  | "PRESENTATION_NOTES_NOT_FOUND"
  | "TRACKED_CHANGES_VISIBLE_TEXT"
  | "TRUNCATED"
  | "VIDEO_METADATA_ONLY"
  | "VIDEO_DURATION_UNAVAILABLE";

export type AttachmentExtractionFailureCode =
  | "ARCHIVE_BOMB"
  | "ARCHIVE_DUPLICATE_ENTRY"
  | "ARCHIVE_PATH_TRAVERSAL"
  | "ARCHIVE_SYMLINK"
  | "ARCHIVE_TOO_MANY_ENTRIES"
  | "ARTIFACT_WRITE_FAILED"
  | "ATTACHMENT_READ_FAILED"
  | "EXTRACTION_LIMIT_EXCEEDED"
  | "MALFORMED_CONTAINER"
  | "MALFORMED_PDF"
  | "PASSWORD_PROTECTED"
  | "UNSUPPORTED_COMPRESSION";

export interface AttachmentExtractionIssue {
  code: AttachmentExtractionIssueCode;
  message: string;
}

export interface AttachmentExtractionFailure {
  code: AttachmentExtractionFailureCode;
  message: string;
  retryable: boolean;
}

export interface AttachmentExtractionArtifact {
  kind: "text" | "metadata" | "archive-index";
  pathRef: string;
  mime: string;
  sizeBytes: number;
}

export interface AttachmentArtifactWriteInput {
  projectId: string;
  sessionId: string;
  source: UploadedFile;
  kind: AttachmentExtractionArtifact["kind"];
  label: string;
  mime: string;
  content: Uint8Array;
}

/**
 * Storage boundary used by extractors. Implementations return an opaque ref;
 * absolute paths must never be included in an extraction result.
 */
export interface AttachmentArtifactWriter {
  readTaskPathRefBytes(
    scope: { projectId: string; sessionId: string },
    pathRef: string,
    maxBytes: number,
  ): Promise<Uint8Array>;
  writeDerivedArtifact(
    input: AttachmentArtifactWriteInput,
  ): Promise<AttachmentExtractionArtifact>;
}

export interface AttachmentExtractionInput {
  projectId: string;
  sessionId: string;
  attachment: UploadedFile;
  localPathRef: string;
}

export interface AttachmentExtractionResult {
  disposition: AttachmentExtractionDisposition;
  extractor: string;
  version: string;
  artifacts: AttachmentExtractionArtifact[];
  issues: AttachmentExtractionIssue[];
  truncated: boolean;
  detectedMime?: string;
  failure?: AttachmentExtractionFailure;
}

export interface AttachmentExtractor {
  extract(
    input: AttachmentExtractionInput,
  ): Promise<AttachmentExtractionResult>;
}

export interface SafeAttachmentExtractorOptions {
  artifactWriter: AttachmentArtifactWriter;
  maxInputBytes?: number;
  maxArtifactBytes?: number;
  maxArchiveEntries?: number;
  maxArchiveEntryBytes?: number;
  maxArchiveTotalBytes?: number;
  maxArchiveExpansionRatio?: number;
}

export interface ValidatedZipEntry {
  name: string;
  content: Buffer;
}

export interface ValidatedZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxExpansionRatio: number;
}

/**
 * Parse a complete ZIP with central/local header agreement, CRC validation,
 * bounded expansion, and no encrypted, duplicate, traversal, or symlink entry.
 */
export function readValidatedZipEntries(
  buffer: Buffer,
  limits: ValidatedZipLimits,
): ValidatedZipEntry[] {
  assertArchiveLimits(limits);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (
    eocdOffset < 0 ||
    eocdOffset + 22 > buffer.length ||
    eocdOffset + 22 + buffer.readUInt16LE(eocdOffset + 20) !== buffer.length
  ) {
    throw new Error("ZIP container has trailing or malformed data");
  }
  const archive = parseZip(buffer, limits);
  return archive.entries.map((entry) => ({
    name: entry.name,
    content: archive.readRequired(entry.name),
  }));
}

/**
 * A deliberately small, bounded extractor for the formats accepted from
 * Feishu. It executes no macros, scripts, external programs, OCR, or media
 * codecs. Every parser works against an in-memory buffer with explicit limits.
 */
export class SafeAttachmentExtractor implements AttachmentExtractor {
  readonly name = "yep-safe-attachment";
  readonly version = "1";

  private readonly artifactWriter: AttachmentArtifactWriter;
  private readonly maxInputBytes: number;
  private readonly maxArtifactBytes: number;
  private readonly archiveLimits: ArchiveLimits;

  constructor(options: SafeAttachmentExtractorOptions) {
    this.artifactWriter = options.artifactWriter;
    this.maxInputBytes = boundedPositiveInteger(
      options.maxInputBytes,
      DEFAULT_MAX_INPUT_BYTES,
      DEFAULT_MAX_INPUT_BYTES,
    );
    const defaultArtifactBytes = Math.min(
      DEFAULT_MAX_ARTIFACT_BYTES,
      this.maxInputBytes,
    );
    this.maxArtifactBytes = boundedPositiveInteger(
      options.maxArtifactBytes,
      defaultArtifactBytes,
      defaultArtifactBytes,
    );
    this.archiveLimits = {
      maxEntries: boundedPositiveInteger(
        options.maxArchiveEntries,
        DEFAULT_MAX_ARCHIVE_ENTRIES,
        DEFAULT_MAX_ARCHIVE_ENTRIES,
      ),
      maxEntryBytes: boundedPositiveInteger(
        options.maxArchiveEntryBytes,
        DEFAULT_MAX_ARCHIVE_ENTRY_BYTES,
        DEFAULT_MAX_ARCHIVE_ENTRY_BYTES,
      ),
      maxTotalBytes: boundedPositiveInteger(
        options.maxArchiveTotalBytes,
        DEFAULT_MAX_ARCHIVE_TOTAL_BYTES,
        DEFAULT_MAX_ARCHIVE_TOTAL_BYTES,
      ),
      maxExpansionRatio: boundedPositiveInteger(
        options.maxArchiveExpansionRatio,
        DEFAULT_MAX_ARCHIVE_EXPANSION_RATIO,
        DEFAULT_MAX_ARCHIVE_EXPANSION_RATIO,
      ),
    };
    assertArchiveLimits(this.archiveLimits);
  }

  async extract(
    input: AttachmentExtractionInput,
  ): Promise<AttachmentExtractionResult> {
    if (!isSupportedMime(input.attachment.mimeType)) {
      return this.result("skipped");
    }
    if (input.attachment.size > this.maxInputBytes) {
      return this.failure(
        "failed",
        "EXTRACTION_LIMIT_EXCEEDED",
        "Attachment exceeds the configured extraction limit.",
      );
    }

    let buffer: Buffer;
    try {
      if (input.localPathRef !== `upload:${input.attachment.id}`) {
        throw new Error("Attachment reference does not match its manifest");
      }
      buffer = Buffer.from(
        await this.artifactWriter.readTaskPathRefBytes(
          { projectId: input.projectId, sessionId: input.sessionId },
          input.localPathRef,
          this.maxInputBytes,
        ),
      );
    } catch {
      return this.failure(
        "failed",
        "ATTACHMENT_READ_FAILED",
        "The stored attachment could not be read.",
        true,
      );
    }
    if (buffer.byteLength > this.maxInputBytes) {
      return this.failure(
        "failed",
        "EXTRACTION_LIMIT_EXCEEDED",
        "Attachment exceeds the configured extraction limit.",
      );
    }
    if (buffer.byteLength !== input.attachment.size) {
      return this.failure(
        "failed",
        "ATTACHMENT_READ_FAILED",
        "The stored attachment no longer matches its manifest.",
      );
    }

    try {
      if (input.attachment.mimeType === "application/pdf") {
        return await this.extractPdf(input, buffer);
      }
      if (isZipMime(input.attachment.mimeType)) {
        return await this.extractZipBased(input, buffer);
      }
      if (input.attachment.mimeType.startsWith("video/")) {
        return await this.extractVideoMetadata(input, buffer);
      }
      return this.result("skipped");
    } catch (error) {
      if (error instanceof SafeExtractionError) {
        return this.failure(
          error.rejected ? "rejected" : "failed",
          error.code,
          error.safeMessage,
        );
      }
      return this.failure(
        "failed",
        "ATTACHMENT_READ_FAILED",
        "Attachment extraction failed safely.",
      );
    }
  }

  private async extractPdf(
    input: AttachmentExtractionInput,
    buffer: Buffer,
  ): Promise<AttachmentExtractionResult> {
    const pdf = parsePdf(buffer, this.maxArtifactBytes);
    const issues: AttachmentExtractionIssue[] = [];
    const artifacts: AttachmentExtractionArtifact[] = [];
    if (pdf.text.length > 0) {
      artifacts.push(
        await this.writeArtifact(
          input,
          "text",
          "pdf-pages.txt",
          "text/plain",
          pdf.text,
        ),
      );
    } else {
      issues.push(
        issue(
          "PDF_NO_TEXT_LAYER",
          "No readable PDF text layer was found; the document may be scanned.",
        ),
        issue(
          "OCR_NOT_CONFIGURED",
          "OCR was not run by the minimum safe extractor.",
        ),
      );
    }
    if (pdf.truncated) {
      issues.push(
        issue("TRUNCATED", "PDF extraction reached its output limit."),
      );
    }
    artifacts.push(
      await this.writeArtifact(
        input,
        "metadata",
        "pdf-metadata.json",
        "application/json",
        JSON.stringify(
          {
            format: "pdf",
            pages: pdf.pageCount,
            textLayer: pdf.text.length > 0,
            ocr: { status: "not_configured" },
            truncated: pdf.truncated,
          },
          null,
          2,
        ),
      ),
    );
    return this.result(pdf.text.length > 0 ? "extracted" : "metadata-only", {
      artifacts,
      issues,
      truncated: pdf.truncated,
    });
  }

  private async extractZipBased(
    input: AttachmentExtractionInput,
    buffer: Buffer,
  ): Promise<AttachmentExtractionResult> {
    const archive = parseZip(buffer, this.archiveLimits);
    const mime = input.attachment.mimeType;
    const containerMime = detectOoxmlMime(archive);
    const effectiveMime = containerMime ?? mime;
    if (isWordMime(effectiveMime)) {
      return addContainerMimeIssue(
        await this.extractDocx(input, archive),
        mime,
        containerMime,
      );
    }
    if (isExcelMime(effectiveMime)) {
      return addContainerMimeIssue(
        await this.extractXlsx(input, archive),
        mime,
        containerMime,
      );
    }
    if (isPowerPointMime(effectiveMime)) {
      return addContainerMimeIssue(
        await this.extractPptx(input, archive),
        mime,
        containerMime,
      );
    }

    const inventory = archive.entries.map((entry) => ({
      name: entry.name,
      compressedBytes: entry.compressedSize,
      uncompressedBytes: entry.uncompressedSize,
      directory: entry.name.endsWith("/"),
    }));
    const artifact = await this.writeArtifact(
      input,
      "archive-index",
      "archive-index.json",
      "application/json",
      JSON.stringify({ entries: inventory }, null, 2),
    );
    return this.result("metadata-only", {
      artifacts: [artifact],
      issues: [
        issue(
          "ARCHIVE_LIST_ONLY",
          "Archive contents were listed but not extracted to the filesystem.",
        ),
      ],
    });
  }

  private async extractDocx(
    input: AttachmentExtractionInput,
    archive: ParsedZip,
  ): Promise<AttachmentExtractionResult> {
    const documentXml = archive
      .readRequired("word/document.xml")
      .toString("utf8");
    const paragraphs = extractXmlParagraphs(documentXml, "w");
    const media = archive.entries
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("word/media/") && !name.endsWith("/"));
    const comments = archive.has("word/comments.xml");
    const trackedChanges = /<w:(?:ins|del)\b/i.test(documentXml);
    const rendered = [
      "# Word document",
      "",
      ...paragraphs,
      ...(media.length > 0
        ? ["", "## Embedded media", ...media.map((name) => `- ${name}`)]
        : []),
    ].join("\n");
    const bounded = boundText(rendered, this.maxArtifactBytes);
    const issues: AttachmentExtractionIssue[] = [];
    if (archive.activeContent) {
      issues.push(activeContentIssue());
    }
    if (comments) {
      issues.push(
        issue(
          "COMMENTS_NOT_EXTRACTED",
          "Word comments are present but were not included in extracted text.",
        ),
      );
    }
    if (trackedChanges) {
      issues.push(
        issue(
          "TRACKED_CHANGES_VISIBLE_TEXT",
          "Tracked-change text is preserved as visible text; revision semantics are not applied.",
        ),
      );
    }
    if (bounded.truncated) issues.push(truncatedIssue());
    const artifact = await this.writeArtifact(
      input,
      "text",
      "word-content.txt",
      "text/plain",
      bounded.text,
    );
    return this.result("extracted", {
      artifacts: [artifact],
      issues,
      truncated: bounded.truncated,
    });
  }

  private async extractXlsx(
    input: AttachmentExtractionInput,
    archive: ParsedZip,
  ): Promise<AttachmentExtractionResult> {
    const sharedStrings = archive.has("xl/sharedStrings.xml")
      ? extractSharedStrings(
          archive.readRequired("xl/sharedStrings.xml").toString("utf8"),
        )
      : [];
    const sheets = resolveWorkbookSheets(archive);
    const rendered: string[] = ["# Excel workbook"];
    let hasFormula = false;
    for (const sheet of sheets) {
      const xml = archive.readRequired(sheet.path).toString("utf8");
      const range = firstXmlAttribute(xml, "dimension", "ref");
      rendered.push("", `## Sheet: ${sheet.name}${range ? ` (${range})` : ""}`);
      for (const cell of extractSpreadsheetCells(xml, sharedStrings)) {
        if (cell.formula) hasFormula = true;
        rendered.push(
          `${cell.reference}\t${cell.formula ? `=${cell.formula}\t` : ""}${cell.value}`,
        );
      }
    }
    const bounded = boundText(rendered.join("\n"), this.maxArtifactBytes);
    const issues: AttachmentExtractionIssue[] = [];
    if (archive.activeContent) issues.push(activeContentIssue());
    if (hasFormula) {
      issues.push(
        issue(
          "FORMULAS_PRESERVED_WITH_CACHED_VALUES",
          "Spreadsheet formulas and their cached values were preserved; formulas were not executed.",
        ),
      );
    }
    if (bounded.truncated) issues.push(truncatedIssue());
    const artifact = await this.writeArtifact(
      input,
      "text",
      "workbook-content.txt",
      "text/plain",
      bounded.text,
    );
    return this.result("extracted", {
      artifacts: [artifact],
      issues,
      truncated: bounded.truncated,
    });
  }

  private async extractPptx(
    input: AttachmentExtractionInput,
    archive: ParsedZip,
  ): Promise<AttachmentExtractionResult> {
    const slides = archive.entries
      .map((entry) => entry.name)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort(naturalNumericSort);
    if (slides.length === 0) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "The presentation contains no readable slides.",
      );
    }
    const rendered: string[] = ["# PowerPoint presentation"];
    let notesFound = false;
    for (const [index, slidePath] of slides.entries()) {
      const slideXml = archive.readRequired(slidePath).toString("utf8");
      rendered.push("", `## Slide ${index + 1}`);
      rendered.push(...extractXmlTextRuns(slideXml, "a"));
      const notesPath = `ppt/notesSlides/notesSlide${index + 1}.xml`;
      if (archive.has(notesPath)) {
        notesFound = true;
        rendered.push(
          "",
          "Notes:",
          ...extractXmlTextRuns(
            archive.readRequired(notesPath).toString("utf8"),
            "a",
          ),
        );
      }
    }
    const bounded = boundText(rendered.join("\n"), this.maxArtifactBytes);
    const issues: AttachmentExtractionIssue[] = [];
    if (archive.activeContent) issues.push(activeContentIssue());
    if (!notesFound) {
      issues.push(
        issue(
          "PRESENTATION_NOTES_NOT_FOUND",
          "No presentation notes were found.",
        ),
      );
    }
    if (bounded.truncated) issues.push(truncatedIssue());
    const artifact = await this.writeArtifact(
      input,
      "text",
      "presentation-content.txt",
      "text/plain",
      bounded.text,
    );
    return this.result("extracted", {
      artifacts: [artifact],
      issues,
      truncated: bounded.truncated,
    });
  }

  private async extractVideoMetadata(
    input: AttachmentExtractionInput,
    buffer: Buffer,
  ): Promise<AttachmentExtractionResult> {
    const metadata = parseVideoMetadata(buffer, input.attachment.mimeType);
    const issues = [
      issue(
        "VIDEO_METADATA_ONLY",
        "Only bounded container metadata was extracted; no transcript or keyframes were generated.",
      ),
    ];
    if (metadata.durationMs === undefined) {
      issues.push(
        issue(
          "VIDEO_DURATION_UNAVAILABLE",
          "Video duration was unavailable from the minimum metadata parser.",
        ),
      );
    }
    const artifact = await this.writeArtifact(
      input,
      "metadata",
      "video-metadata.json",
      "application/json",
      JSON.stringify(metadata, null, 2),
    );
    return this.result("metadata-only", { artifacts: [artifact], issues });
  }

  private async writeArtifact(
    input: AttachmentExtractionInput,
    kind: AttachmentExtractionArtifact["kind"],
    label: string,
    mime: string,
    content: string,
  ): Promise<AttachmentExtractionArtifact> {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > this.maxArtifactBytes) {
      throw new SafeExtractionError(
        "EXTRACTION_LIMIT_EXCEEDED",
        "Extracted artifact exceeds the configured limit.",
      );
    }
    try {
      return await this.artifactWriter.writeDerivedArtifact({
        projectId: input.projectId,
        sessionId: input.sessionId,
        source: input.attachment,
        kind,
        label,
        mime,
        content: bytes,
      });
    } catch {
      throw new SafeExtractionError(
        "ARTIFACT_WRITE_FAILED",
        "The extracted artifact could not be stored.",
        false,
      );
    }
  }

  private result(
    disposition: AttachmentExtractionDisposition,
    values: Partial<
      Pick<
        AttachmentExtractionResult,
        "artifacts" | "issues" | "truncated" | "detectedMime" | "failure"
      >
    > = {},
  ): AttachmentExtractionResult {
    return {
      disposition,
      extractor: this.name,
      version: this.version,
      artifacts: values.artifacts ?? [],
      issues: values.issues ?? [],
      truncated: values.truncated ?? false,
      ...(values.detectedMime ? { detectedMime: values.detectedMime } : {}),
      ...(values.failure ? { failure: values.failure } : {}),
    };
  }

  private failure(
    disposition: "rejected" | "failed",
    code: AttachmentExtractionFailureCode,
    message: string,
    retryable = false,
  ): AttachmentExtractionResult {
    return this.result(disposition, {
      failure: { code, message, retryable },
    });
  }
}

class SafeExtractionError extends Error {
  constructor(
    readonly code: AttachmentExtractionFailureCode,
    readonly safeMessage: string,
    readonly rejected = isSafetyRejection(code),
  ) {
    super(code);
    this.name = "SafeExtractionError";
  }
}

interface ArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxExpansionRatio: number;
}

interface ParsedZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compression: number;
  crc32: number;
  dataStart: number;
}

class ParsedZip {
  readonly activeContent: boolean;
  private readonly byName: Map<string, ParsedZipEntry>;

  constructor(
    readonly buffer: Buffer,
    readonly entries: ParsedZipEntry[],
    private readonly limits: ArchiveLimits,
  ) {
    this.byName = new Map(entries.map((entry) => [entry.name, entry]));
    this.activeContent = entries.some((entry) =>
      /(?:^|\/)vbaProject\.bin$/i.test(entry.name),
    );
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  readRequired(name: string): Buffer {
    const entry = this.byName.get(name);
    if (!entry) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        `Required document part is missing: ${safePartName(name)}.`,
      );
    }
    const compressed = this.buffer.subarray(
      entry.dataStart,
      entry.dataStart + entry.compressedSize,
    );
    let output: Buffer;
    try {
      if (entry.compression === 0) {
        output = Buffer.from(compressed);
      } else if (entry.compression === 8) {
        output = inflateRawSync(compressed, {
          maxOutputLength: Math.min(
            this.limits.maxEntryBytes,
            entry.uncompressedSize + 1,
          ),
        });
      } else {
        throw new SafeExtractionError(
          "UNSUPPORTED_COMPRESSION",
          "The archive uses an unsupported compression method.",
          true,
        );
      }
    } catch (error) {
      if (error instanceof SafeExtractionError) throw error;
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "An archive entry could not be decompressed.",
      );
    }
    if (
      output.byteLength !== entry.uncompressedSize ||
      crc32(output) !== entry.crc32
    ) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "An archive entry failed its size or checksum validation.",
      );
    }
    return output;
  }
}

function parseZip(buffer: Buffer, limits: ArchiveLimits): ParsedZip {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0 || eocdOffset + 22 > buffer.length) {
    throw new SafeExtractionError(
      "MALFORMED_CONTAINER",
      "The ZIP container has no valid central directory.",
    );
  }
  const disk = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const commentLength = buffer.readUInt16LE(eocdOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    eocdOffset + 22 + commentLength !== buffer.length ||
    centralOffset + centralSize !== eocdOffset
  ) {
    throw new SafeExtractionError(
      "MALFORMED_CONTAINER",
      "The ZIP container structure is unsupported or malformed.",
    );
  }
  if (entryCount > limits.maxEntries) {
    throw new SafeExtractionError(
      "ARCHIVE_TOO_MANY_ENTRIES",
      "The archive contains too many entries.",
    );
  }

  const entries: ParsedZipEntry[] = [];
  const occupiedRanges: Array<{ start: number; end: number }> = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    ) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "The ZIP central directory is truncated.",
      );
    }
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (next > buffer.length) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "A ZIP directory entry is truncated.",
      );
    }
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    const encodedName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    if (flags & 0x1 || flags & 0x40) {
      throw new SafeExtractionError(
        "PASSWORD_PROTECTED",
        "The attachment is encrypted or password protected.",
      );
    }
    if (!isSafeArchiveEntryName(name)) {
      throw new SafeExtractionError(
        "ARCHIVE_PATH_TRAVERSAL",
        "The archive contains an unsafe path.",
      );
    }
    if (!Buffer.from(name, "utf8").equals(encodedName)) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "The archive contains an invalid UTF-8 entry name.",
      );
    }
    if (compression !== 0 && compression !== 8) {
      throw new SafeExtractionError(
        "UNSUPPORTED_COMPRESSION",
        "The archive uses an unsupported compression method.",
        true,
      );
    }
    if (names.has(name)) {
      throw new SafeExtractionError(
        "ARCHIVE_DUPLICATE_ENTRY",
        "The archive contains duplicate entry names.",
      );
    }
    names.add(name);
    const unixMode = versionMadeBy >> 8 === 3 ? externalAttributes >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new SafeExtractionError(
        "ARCHIVE_SYMLINK",
        "The archive contains a symbolic link.",
      );
    }
    totalUncompressed += uncompressedSize;
    if (
      uncompressedSize > limits.maxEntryBytes ||
      totalUncompressed > limits.maxTotalBytes ||
      (uncompressedSize > 0 && compressedSize === 0) ||
      (compressedSize > 0 &&
        uncompressedSize / compressedSize > limits.maxExpansionRatio)
    ) {
      throw new SafeExtractionError(
        "ARCHIVE_BOMB",
        "The archive exceeds safe expansion limits.",
      );
    }
    if (
      localHeaderOffset + 30 > centralOffset ||
      buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "A ZIP local header is missing or invalid.",
      );
    }
    const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
    const localCompression = buffer.readUInt16LE(localHeaderOffset + 8);
    const localChecksum = buffer.readUInt32LE(localHeaderOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localHeaderOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localHeaderOffset + 22);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const localNameStart = localHeaderOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    if (localNameEnd > centralOffset) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "A ZIP local entry name is truncated.",
      );
    }
    const localEncodedName = buffer.subarray(localNameStart, localNameEnd);
    const localName = localEncodedName.toString("utf8");
    if (localFlags & 0x1 || localFlags & 0x40) {
      throw new SafeExtractionError(
        "PASSWORD_PROTECTED",
        "The attachment is encrypted or password protected.",
      );
    }
    if (
      localName !== name ||
      !localEncodedName.equals(encodedName) ||
      localFlags !== flags ||
      localCompression !== compression ||
      !isSafeArchiveEntryName(localName)
    ) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "A ZIP local header disagrees with its central directory entry.",
      );
    }
    const dataStart =
      localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > centralOffset) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "A ZIP entry exceeds its declared bounds.",
      );
    }
    const usesDataDescriptor = (flags & 0x8) !== 0;
    if (
      (!usesDataDescriptor &&
        (localChecksum !== checksum ||
          localCompressedSize !== compressedSize ||
          localUncompressedSize !== uncompressedSize)) ||
      (usesDataDescriptor &&
        ((localChecksum !== 0 && localChecksum !== checksum) ||
          (localCompressedSize !== 0 &&
            localCompressedSize !== compressedSize) ||
          (localUncompressedSize !== 0 &&
            localUncompressedSize !== uncompressedSize)))
    ) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "A ZIP local header disagrees with its central directory sizes.",
      );
    }
    const occupied = {
      start: localHeaderOffset,
      end: dataStart + compressedSize,
    };
    if (
      occupiedRanges.some(
        (range) => occupied.start < range.end && range.start < occupied.end,
      )
    ) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "The archive contains overlapping entries.",
      );
    }
    occupiedRanges.push(occupied);
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      compression,
      crc32: checksum,
      dataStart,
    });
    offset = next;
  }
  if (offset !== centralOffset + centralSize) {
    throw new SafeExtractionError(
      "MALFORMED_CONTAINER",
      "The ZIP central directory size is inconsistent.",
    );
  }
  return new ParsedZip(buffer, entries, limits);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
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
  const withoutTrailingSlash = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!withoutTrailingSlash) return false;
  return withoutTrailingSlash
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
}

function parsePdf(
  buffer: Buffer,
  maxArtifactBytes: number,
): { pageCount: number; text: string; truncated: boolean } {
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new SafeExtractionError(
      "MALFORMED_PDF",
      "The attachment is not a valid PDF document.",
    );
  }
  const source = buffer.toString("latin1");
  if (/\/Encrypt\b/.test(source)) {
    throw new SafeExtractionError(
      "PASSWORD_PROTECTED",
      "The PDF is encrypted or password protected.",
    );
  }
  if (!source.includes("%%EOF")) {
    throw new SafeExtractionError(
      "MALFORMED_PDF",
      "The PDF is incomplete or damaged.",
    );
  }
  const objects = new Map<number, string>();
  for (const match of source.matchAll(
    /(?:^|[\r\n])(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g,
  )) {
    if (objects.size >= MAX_PDF_OBJECTS) {
      throw new SafeExtractionError(
        "EXTRACTION_LIMIT_EXCEEDED",
        "The PDF contains too many objects to extract safely.",
      );
    }
    objects.set(Number(match[1]), match[2] ?? "");
  }
  const pageObjects = [...objects.values()].filter((value) =>
    /\/Type\s*\/Page\b/.test(value),
  );
  if (pageObjects.length === 0 || pageObjects.length > MAX_PDF_PAGES) {
    throw new SafeExtractionError(
      pageObjects.length === 0 ? "MALFORMED_PDF" : "EXTRACTION_LIMIT_EXCEEDED",
      pageObjects.length === 0
        ? "The PDF contains no readable page objects."
        : "The PDF contains too many pages to extract safely.",
    );
  }
  const pages: string[] = [];
  const decodedByObject = new Map<number, string | null>();
  const maxDecodedBytes = Math.min(
    DEFAULT_MAX_INPUT_BYTES,
    maxArtifactBytes * 4,
  );
  let decodedBytes = 0;
  const decodeObject = (id: number): string | null => {
    if (decodedByObject.has(id)) return decodedByObject.get(id) ?? null;
    const object = objects.get(id);
    const decoded = object?.includes("stream")
      ? decodePdfStream(object, maxArtifactBytes)
      : null;
    decodedBytes += decoded ? Buffer.byteLength(decoded, "latin1") : 0;
    if (decodedBytes > maxDecodedBytes) {
      throw new SafeExtractionError(
        "EXTRACTION_LIMIT_EXCEEDED",
        "PDF content streams exceed the safe extraction budget.",
      );
    }
    decodedByObject.set(id, decoded);
    return decoded;
  };
  let truncated = false;
  for (const [index, page] of pageObjects.entries()) {
    const refs = [...page.matchAll(/(\d+)\s+\d+\s+R/g)].map((match) =>
      Number(match[1]),
    );
    if (refs.length > MAX_PDF_REFERENCES_PER_PAGE) {
      throw new SafeExtractionError(
        "EXTRACTION_LIMIT_EXCEEDED",
        "A PDF page contains too many object references.",
      );
    }
    const chunks: string[] = [];
    for (const ref of refs) {
      const decoded = decodeObject(ref);
      if (decoded) chunks.push(extractPdfTextOperators(decoded));
    }
    if (page.includes("stream")) {
      const decoded = decodePdfStream(page, maxArtifactBytes);
      if (decoded) {
        decodedBytes += Buffer.byteLength(decoded, "latin1");
        if (decodedBytes > maxDecodedBytes) {
          throw new SafeExtractionError(
            "EXTRACTION_LIMIT_EXCEEDED",
            "PDF content streams exceed the safe extraction budget.",
          );
        }
        chunks.push(extractPdfTextOperators(decoded));
      }
    }
    const pageText = chunks.filter(Boolean).join("\n").trim();
    if (pageText) pages.push(`## Page ${index + 1}\n${pageText}`);
    if (Buffer.byteLength(pages.join("\n\n"), "utf8") > maxArtifactBytes) {
      truncated = true;
      break;
    }
  }
  const bounded = boundText(pages.join("\n\n"), maxArtifactBytes);
  return {
    pageCount: pageObjects.length,
    text: bounded.text,
    truncated: truncated || bounded.truncated,
  };
}

function decodePdfStream(
  object: string,
  maxOutputBytes: number,
): string | null {
  const streamMatch = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(object);
  if (!streamMatch) return null;
  const bytes = Buffer.from(streamMatch[1] ?? "", "latin1");
  if (/\/FlateDecode\b/.test(object.slice(0, streamMatch.index))) {
    try {
      return inflateSync(bytes, { maxOutputLength: maxOutputBytes }).toString(
        "latin1",
      );
    } catch {
      throw new SafeExtractionError(
        "MALFORMED_PDF",
        "A compressed PDF content stream could not be decoded.",
      );
    }
  }
  if (/\/Filter\b/.test(object.slice(0, streamMatch.index))) return null;
  return bytes.toString("latin1");
}

function extractPdfTextOperators(stream: string): string {
  const text: string[] = [];
  for (const match of stream.matchAll(/\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")/g)) {
    text.push(decodePdfLiteral(match[1] ?? ""));
  }
  for (const match of stream.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
    const parts: string[] = [];
    for (const part of (match[1] ?? "").matchAll(
      /\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>/g,
    )) {
      parts.push(
        part[1] !== undefined
          ? decodePdfLiteral(part[1])
          : decodePdfHex(part[2] ?? ""),
      );
    }
    text.push(parts.join(""));
  }
  for (const match of stream.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
    text.push(decodePdfHex(match[1] ?? ""));
  }
  return text.map(cleanText).filter(Boolean).join("\n");
}

function decodePdfLiteral(value: string): string {
  return value
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    )
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\\r?\n/g, "");
}

function decodePdfHex(value: string): string {
  const normalized = value.replace(/\s/g, "");
  const even = normalized.length % 2 === 0 ? normalized : `${normalized}0`;
  const bytes = Buffer.from(even, "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let output = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      output += String.fromCharCode(bytes.readUInt16BE(index));
    }
    return output;
  }
  return bytes.toString("latin1");
}

function extractXmlParagraphs(xml: string, prefix: string): string[] {
  const paragraphs: string[] = [];
  const paragraphPattern = new RegExp(
    `<${prefix}:p\\b[\\s\\S]*?<\\/${prefix}:p>`,
    "gi",
  );
  for (const match of xml.matchAll(paragraphPattern)) {
    const paragraph = match[0];
    const runs = extractXmlTextRuns(paragraph, prefix);
    const text = runs.join("").trim();
    if (!text) continue;
    const style = firstXmlAttribute(
      paragraph,
      `${prefix}:pStyle`,
      `${prefix}:val`,
    );
    paragraphs.push(
      style && /^(?:title|heading)/i.test(style) ? `## ${text}` : text,
    );
  }
  return paragraphs;
}

function extractXmlTextRuns(xml: string, prefix: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(
    `<${prefix}:t\\b[^>]*>([\\s\\S]*?)<\\/${prefix}:t>|<${prefix}:(tab|br)\\b[^>]*/>`,
    "gi",
  );
  for (const match of xml.matchAll(pattern)) {
    values.push(
      match[2] === "tab"
        ? "\t"
        : match[2] === "br"
          ? "\n"
          : decodeXml(match[1] ?? ""),
    );
  }
  return values;
}

function extractSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) =>
    extractUnprefixedTextRuns(match[1] ?? "").join(""),
  );
}

function extractUnprefixedTextRuns(xml: string): string[] {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((match) =>
    decodeXml(match[1] ?? ""),
  );
}

function resolveWorkbookSheets(
  archive: ParsedZip,
): Array<{ name: string; path: string }> {
  if (!archive.has("xl/workbook.xml")) {
    throw new SafeExtractionError(
      "MALFORMED_CONTAINER",
      "The workbook definition is missing.",
    );
  }
  const workbook = archive.readRequired("xl/workbook.xml").toString("utf8");
  const relationships = archive.has("xl/_rels/workbook.xml.rels")
    ? parseRelationships(
        archive.readRequired("xl/_rels/workbook.xml.rels").toString("utf8"),
      )
    : new Map<string, string>();
  const sheets: Array<{ name: string; path: string }> = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1] ?? "";
    const name =
      readAttribute(attributes, "name") ?? `Sheet ${sheets.length + 1}`;
    const relationId = readAttribute(attributes, "r:id");
    const target = relationId ? relationships.get(relationId) : undefined;
    if (!target) continue;
    const path = normalizeOoxmlTarget("xl", target);
    if (!archive.has(path)) {
      throw new SafeExtractionError(
        "MALFORMED_CONTAINER",
        "A workbook sheet part is missing.",
      );
    }
    sheets.push({ name, path });
  }
  if (sheets.length > 0) return sheets;
  return archive.entries
    .map((entry) => entry.name)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(naturalNumericSort)
    .map((path, index) => ({ name: `Sheet ${index + 1}`, path }));
}

function parseRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const id = readAttribute(match[1] ?? "", "Id");
    const target = readAttribute(match[1] ?? "", "Target");
    if (id && target) relationships.set(id, target);
  }
  return relationships;
}

function normalizeOoxmlTarget(base: string, target: string): string {
  const candidate = target.startsWith("/")
    ? target.slice(1)
    : `${base}/${target}`;
  const stack: string[] = [];
  for (const segment of candidate.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) {
        throw new SafeExtractionError(
          "ARCHIVE_PATH_TRAVERSAL",
          "An OOXML relationship escapes the document container.",
        );
      }
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack.join("/");
}

function extractSpreadsheetCells(
  xml: string,
  sharedStrings: string[],
): Array<{ reference: string; value: string; formula?: string }> {
  const cells: Array<{ reference: string; value: string; formula?: string }> =
    [];
  for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    const reference =
      readAttribute(attributes, "r") ?? `cell-${cells.length + 1}`;
    const type = readAttribute(attributes, "t");
    const rawValue = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1] ?? "";
    const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/i.exec(body)?.[1];
    let value: string;
    if (type === "s") {
      value = sharedStrings[Number(rawValue)] ?? "";
    } else if (type === "inlineStr") {
      value = extractUnprefixedTextRuns(body).join("");
    } else {
      value = decodeXml(rawValue);
    }
    cells.push({
      reference,
      value: cleanText(value),
      ...(formula ? { formula: cleanText(decodeXml(formula)) } : {}),
    });
  }
  return cells;
}

function parseVideoMetadata(
  buffer: Buffer,
  mime: string,
): {
  format: string;
  mime: string;
  majorBrand?: string;
  compatibleBrands?: string[];
  durationMs?: number;
} {
  const metadata: {
    format: string;
    mime: string;
    majorBrand?: string;
    compatibleBrands?: string[];
    durationMs?: number;
  } = { format: "unknown", mime };
  if (
    buffer.length < 12 ||
    buffer.subarray(4, 8).toString("ascii") !== "ftyp"
  ) {
    return metadata;
  }
  metadata.format = "iso-bmff";
  const firstBoxSize = buffer.readUInt32BE(0);
  if (firstBoxSize >= 12 && firstBoxSize <= buffer.length) {
    metadata.majorBrand = buffer.subarray(8, 12).toString("ascii");
    const brands: string[] = [];
    for (let offset = 16; offset + 4 <= firstBoxSize; offset += 4) {
      brands.push(buffer.subarray(offset, offset + 4).toString("ascii"));
    }
    metadata.compatibleBrands = brands;
  }
  const mvhd = findIsoBox(buffer, "mvhd");
  if (mvhd && mvhd.length >= 20) {
    const version = mvhd[0];
    const timescaleOffset = version === 1 ? 20 : 12;
    const durationOffset = version === 1 ? 24 : 16;
    if (mvhd.length >= durationOffset + (version === 1 ? 8 : 4)) {
      const timescale = mvhd.readUInt32BE(timescaleOffset);
      const duration =
        version === 1
          ? Number(mvhd.readBigUInt64BE(durationOffset))
          : mvhd.readUInt32BE(durationOffset);
      if (timescale > 0 && Number.isSafeInteger(duration)) {
        metadata.durationMs = Math.round((duration / timescale) * 1000);
      }
    }
  }
  return metadata;
}

function findIsoBox(buffer: Buffer, wanted: string): Buffer | null {
  const containers = new Set(["moov", "trak", "mdia"]);
  const visit = (start: number, end: number, depth: number): Buffer | null => {
    if (depth > 4) return null;
    let offset = start;
    while (offset + 8 <= end) {
      let size = buffer.readUInt32BE(offset);
      const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return null;
        const large = buffer.readBigUInt64BE(offset + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        size = Number(large);
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) return null;
      if (type === wanted) {
        return buffer.subarray(offset + header, offset + size);
      }
      if (containers.has(type)) {
        const nested = visit(offset + header, offset + size, depth + 1);
        if (nested) return nested;
      }
      offset += size;
    }
    return null;
  };
  return visit(0, buffer.length, 0);
}

function firstXmlAttribute(
  xml: string,
  element: string,
  attribute: string,
): string | undefined {
  const match = new RegExp(`<${element}\\b([^>]*)>`, "i").exec(xml);
  return match ? readAttribute(match[1] ?? "", attribute) : undefined;
}

function readAttribute(attributes: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`,
    "i",
  ).exec(attributes);
  return match ? decodeXml(match[1] ?? match[2] ?? "") : undefined;
}

function decodeXml(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi,
    (_match, decimal: string, hex: string, named: string) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return (
        { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
          named.toLowerCase()
        ] ?? ""
      );
    },
  );
}

function cleanText(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code === 0 ||
      code === 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      continue;
    }
    safe += character;
  }
  return safe.replace(/\r\n?/g, "\n").trim();
}

function boundText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const suffix = Buffer.from("\n\n[truncated]", "utf8");
  let end = Math.max(0, maxBytes - suffix.length);
  while (end > 0 && ((bytes.at(end) ?? 0) & 0xc0) === 0x80) end -= 1;
  return {
    text: Buffer.concat([bytes.subarray(0, end), suffix])
      .subarray(0, maxBytes)
      .toString("utf8"),
    truncated: true,
  };
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

function naturalNumericSort(left: string, right: string): number {
  const leftNumber = Number(/(\d+)(?!.*\d)/.exec(left)?.[1] ?? 0);
  const rightNumber = Number(/(\d+)(?!.*\d)/.exec(right)?.[1] ?? 0);
  return leftNumber - rightNumber || left.localeCompare(right);
}

function safePartName(name: string): string {
  return name.replace(/[^A-Za-z0-9._/-]/g, "_").slice(0, 160);
}

function issue(
  code: AttachmentExtractionIssueCode,
  message: string,
): AttachmentExtractionIssue {
  return { code, message };
}

function activeContentIssue(): AttachmentExtractionIssue {
  return issue(
    "ACTIVE_CONTENT_NOT_EXECUTED",
    "The Office document contains active macro content; macros were not executed.",
  );
}

function detectOoxmlMime(archive: ParsedZip): string | undefined {
  if (!archive.has("[Content_Types].xml")) return undefined;
  if (archive.has("word/document.xml")) {
    return archive.activeContent
      ? "application/vnd.ms-word.document.macroEnabled.12"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (archive.has("xl/workbook.xml")) {
    return archive.activeContent
      ? "application/vnd.ms-excel.sheet.macroEnabled.12"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (archive.has("ppt/presentation.xml")) {
    return archive.activeContent
      ? "application/vnd.ms-powerpoint.presentation.macroEnabled.12"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  return undefined;
}

function addContainerMimeIssue(
  result: AttachmentExtractionResult,
  declaredDetectedMime: string,
  containerMime: string | undefined,
): AttachmentExtractionResult {
  if (!containerMime) return result;
  return {
    ...result,
    detectedMime: containerMime,
    issues:
      containerMime === declaredDetectedMime
        ? result.issues
        : [
            ...result.issues,
            issue(
              "MIME_CONTAINER_MISMATCH",
              "The OOXML container type differs from the outer MIME type; the container type was used.",
            ),
          ],
  };
}

function truncatedIssue(): AttachmentExtractionIssue {
  return issue("TRUNCATED", "Extraction reached its configured output limit.");
}

function isSupportedMime(mime: string): boolean {
  return (
    mime === "application/pdf" || isZipMime(mime) || mime.startsWith("video/")
  );
}

function isZipMime(mime: string): boolean {
  return (
    mime === "application/zip" ||
    isWordMime(mime) ||
    isExcelMime(mime) ||
    isPowerPointMime(mime)
  );
}

function isWordMime(mime: string): boolean {
  return (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/vnd.ms-word.document.macroEnabled.12"
  );
}

function isExcelMime(mime: string): boolean {
  return (
    mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel.sheet.macroEnabled.12"
  );
}

function isPowerPointMime(mime: string): boolean {
  return (
    mime ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/vnd.ms-powerpoint.presentation.macroEnabled.12"
  );
}

function assertArchiveLimits(limits: ValidatedZipLimits): void {
  const values = [
    [limits.maxEntries, DEFAULT_MAX_ARCHIVE_ENTRIES],
    [limits.maxEntryBytes, DEFAULT_MAX_ARCHIVE_ENTRY_BYTES],
    [limits.maxTotalBytes, DEFAULT_MAX_ARCHIVE_TOTAL_BYTES],
    [limits.maxExpansionRatio, DEFAULT_MAX_ARCHIVE_EXPANSION_RATIO],
  ] as const;
  if (
    values.some(
      ([value, maximum]) =>
        !Number.isSafeInteger(value) || value <= 0 || value > maximum,
    ) ||
    limits.maxEntryBytes > limits.maxTotalBytes
  ) {
    throw new Error("Invalid attachment archive limits");
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new Error("Invalid attachment extraction limit");
  }
  return selected;
}

function isSafetyRejection(code: AttachmentExtractionFailureCode): boolean {
  return (
    code === "ARCHIVE_BOMB" ||
    code === "ARCHIVE_DUPLICATE_ENTRY" ||
    code === "ARCHIVE_PATH_TRAVERSAL" ||
    code === "ARCHIVE_SYMLINK" ||
    code === "ARCHIVE_TOO_MANY_ENTRIES" ||
    code === "PASSWORD_PROTECTED" ||
    code === "UNSUPPORTED_COMPRESSION"
  );
}
