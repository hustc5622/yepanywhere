import { getMediaPreviewKind } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import {
  type FileRef,
  type FileSnapshot,
  fileRefFromPath,
} from "../../../lib/fileRef";
import { validateToolResult } from "../../../lib/validateToolResult";
import { FileOpenButton } from "../../FilePreviewPanel";
import { SchemaWarning } from "../../SchemaWarning";
import type {
  ImageFile,
  PdfFile,
  ReadInput,
  ReadResult,
  TextFile,
  ToolRenderer,
} from "./types";

/** Extended result type with server-rendered syntax highlighting */
interface ReadResultWithAugment extends ReadResult {
  _highlightedContentHtml?: string;
  _highlightedLanguage?: string;
  _highlightedTruncated?: boolean;
  _renderedMarkdownHtml?: string;
  session_id?: string | number;
}

const PDF_OBJECT_URL_LIFETIME_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getReadInputFilePath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return [input.file_path, input.path, input.filePath].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function getReadSessionId(result: unknown): string | number | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const sessionId = result.session_id;
  if (typeof sessionId === "string" || typeof sessionId === "number") {
    return sessionId;
  }
  return undefined;
}

/**
 * Providers that flatten tool-result content blocks to text (Pi, and any
 * provider whose image block degrades to `[Image]`) lose the image bytes, so
 * the result looks like a two-line text file. Recognize that shape and preview
 * the image from its path instead of showing the placeholder as file content.
 */
function getImagePlaceholderReadPath(
  result: unknown,
  input: unknown,
): string | undefined {
  if (typeof result !== "string") return undefined;
  const filePath = getReadInputFilePath(input);
  if (!filePath) return undefined;
  const text = result.trim();
  if (/^Read image file \[image\/[^\]]+\]/.test(text)) return filePath;
  if (
    getMediaPreviewKind(filePath) === "image" &&
    /(^|\n)\[Image\]$/.test(text)
  ) {
    return filePath;
  }
  return undefined;
}

function isPtyHandoffTextRead(
  result: ReadResultWithAugment | undefined,
): boolean {
  if (!result || result.type !== "text") {
    return false;
  }
  const sessionId = getReadSessionId(result);
  if (sessionId === undefined) {
    return false;
  }
  const file = result.file as TextFile | undefined;
  return !!file && file.content.length === 0;
}

function normalizeReadResult(
  result: ReadResultWithAugment | string | undefined,
  input?: Partial<ReadInput>,
): ReadResultWithAugment | undefined {
  if (!result) {
    return undefined;
  }

  if (typeof result !== "string") {
    return result;
  }

  const filePath = getXmlTag(result, "path") ?? getReadInputFilePath(input);
  if (!filePath) {
    return undefined;
  }

  const rawContent =
    getXmlTag(result, "content") ?? getXmlTag(result, "entries");
  const type = getXmlTag(result, "type");
  const text =
    type === "directory"
      ? (rawContent ?? result).trim()
      : stripNumberedReadLines(rawContent ?? result);
  const startLine = parseReadStartLine(rawContent ?? "");
  const numLines = text ? text.split("\n").length : 0;
  const totalLines =
    parseReadTotalLines(result) ??
    Math.max(startLine + Math.max(numLines - 1, 0), numLines);

  return {
    type: "text",
    file: {
      filePath,
      content: text,
      numLines,
      startLine,
      totalLines,
    },
  };
}

function getXmlTag(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1]?.trim();
}

function stripNumberedReadLines(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("(End of file") && !line.startsWith("(Showing lines"),
    )
    .map((line) => line.replace(/^\d+:\s?/, ""))
    .join("\n")
    .trimEnd();
}

function parseReadStartLine(text: string): number {
  const firstNumberedLine = text.match(/^(\d+):/m);
  return firstNumberedLine?.[1] ? Number.parseInt(firstNumberedLine[1], 10) : 1;
}

function parseReadTotalLines(text: string): number | undefined {
  const totalMatch =
    text.match(/total\s+(\d+)\s+lines/i) ?? text.match(/of\s+(\d+)\s+lines/i);
  return totalMatch?.[1] ? Number.parseInt(totalMatch[1], 10) : undefined;
}

/**
 * Extract filename from path
 */
function getFileName(filePath: string | undefined): string {
  if (!filePath) return "Reading...";
  return filePath.split("/").pop() || filePath;
}

function getLineCountLabel(file: TextFile): string {
  if (file.numLines < file.totalLines || file.startLine > 1) {
    return `${file.numLines} of ${file.totalLines} lines`;
  }
  return `${file.numLines} lines`;
}

/**
 * Read tool use - shows file path being read
 */
function ReadToolUse({ input }: { input: Partial<ReadInput> }) {
  const fileName = getFileName(getReadInputFilePath(input));
  return (
    <div className="read-tool-use">
      <span className="file-path">{fileName}</span>
      {(input.offset !== undefined || input.limit !== undefined) && (
        <span className="read-range">
          {input.offset !== undefined && ` from line ${input.offset}`}
          {input.limit !== undefined && ` (${input.limit} lines)`}
        </span>
      )}
    </div>
  );
}

/** Side-panel reference for a Read; partial reads target their line range. */
function useReadFileRef(file: TextFile): FileRef {
  const metadata = useOptionalSessionMetadata();
  const partial = file.startLine > 1 || file.numLines < file.totalLines;
  return fileRefFromPath(
    file.filePath,
    metadata,
    partial
      ? {
          lineNumber: file.startLine,
          lineEnd: file.startLine + Math.max(file.numLines - 1, 0),
        }
      : {},
  );
}

function textSnapshot(
  file: TextFile,
  result: ReadResultWithAugment | undefined,
): FileSnapshot {
  return {
    kind: "text",
    content: file.content ?? "",
    startLine: file.startLine,
    totalLines: file.totalLines,
    highlightedHtml: result?._highlightedContentHtml,
    highlightedTruncated: result?._highlightedTruncated,
    renderedMarkdownHtml: result?._renderedMarkdownHtml,
  };
}

/**
 * Image read whose bytes are not in the transcript (providers that flatten
 * image blocks to `[Image]`): open the image file by path.
 */
function ImagePathRead({
  filePath,
  inline,
}: {
  filePath: string;
  inline: boolean;
}) {
  const metadata = useOptionalSessionMetadata();
  const button = (
    <FileOpenButton
      fileRef={fileRefFromPath(filePath, metadata)}
      className={inline ? "file-link-inline" : "file-link-button"}
      stopPropagation
    >
      {getFileName(filePath)}
      <span className={inline ? "file-line-count-inline" : "file-line-count"}>
        (image)
      </span>
    </FileOpenButton>
  );
  return inline ? button : <div className="read-text-result">{button}</div>;
}

/**
 * Text file result - clickable filename that opens the side panel
 */
function TextFileResult({
  file,
  result,
  isPtyHandoff = false,
}: {
  file: TextFile;
  result?: ReadResultWithAugment;
  isPtyHandoff?: boolean;
}) {
  const fileName = getFileName(file.filePath);
  const showRange = file.startLine > 1 || file.numLines < file.totalLines;
  const fileRef = useReadFileRef(file);

  if (isPtyHandoff) {
    return (
      <div className="read-text-result">
        <span className="file-path">{fileName}</span>{" "}
        <span className="file-line-count">continues in Shell</span>
      </div>
    );
  }

  return (
    <div className="read-text-result">
      <FileOpenButton
        fileRef={fileRef}
        snapshot={textSnapshot(file, result)}
        className="file-link-button"
      >
        {fileName}
        {showRange && (
          <span className="file-range">
            {" "}
            (lines {file.startLine}-{file.startLine + file.numLines - 1})
          </span>
        )}
        <span className="file-line-count">{getLineCountLabel(file)}</span>
      </FileOpenButton>
    </div>
  );
}

/**
 * Image file result - renders as img tag
 */
function ImageFileResult({ file }: { file: ImageFile }) {
  const sizeKB = file.originalSize ? Math.round(file.originalSize / 1024) : 0;
  const { dimensions } = file;
  const hasDimensions =
    dimensions?.originalWidth != null && dimensions?.originalHeight != null;

  return (
    <div className="read-image-result">
      {(hasDimensions || sizeKB > 0) && (
        <div className="image-info">
          {hasDimensions && (
            <>
              {dimensions.originalWidth}x{dimensions.originalHeight}
            </>
          )}
          {hasDimensions && sizeKB > 0 && " "}
          {sizeKB > 0 && <>({sizeKB}KB)</>}
        </div>
      )}
      <img
        className="read-image"
        src={`data:${file.type};base64,${file.base64}`}
        alt="File content"
        width={dimensions?.displayWidth}
        height={dimensions?.displayHeight}
      />
    </div>
  );
}

/**
 * Open base64 PDF data in a new browser tab
 */
function openPdfInNewTab(base64Data: string) {
  const byteChars = atob(base64Data);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteArray[i] = byteChars.charCodeAt(i);
  }
  const blob = new Blob([byteArray], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  try {
    const openedWindow = window.open(url, "_blank");
    if (!openedWindow) {
      URL.revokeObjectURL(url);
      return;
    }
    // Give the browser/PDF viewer time to consume the Blob, then release the
    // registry entry. Keeping it forever makes every click retain a full PDF.
    window.setTimeout(
      () => URL.revokeObjectURL(url),
      PDF_OBJECT_URL_LIFETIME_MS,
    );
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * PDF file result - button to open in new tab
 */
function PdfFileResult({
  file,
  filePath,
}: { file: PdfFile; filePath?: string }) {
  const metadata = useOptionalSessionMetadata();
  const sizeKB = file.originalSize ? Math.round(file.originalSize / 1024) : 0;
  const fileName = filePath ? getFileName(filePath) : "document.pdf";
  const label = (
    <>
      {fileName}
      {sizeKB > 0 && <span className="file-line-count">({sizeKB}KB)</span>}
      <span className="file-line-count">Open PDF</span>
    </>
  );

  return (
    <div className="read-pdf-result">
      {filePath ? (
        <FileOpenButton
          fileRef={fileRefFromPath(filePath, metadata)}
          className="file-link-button"
        >
          {label}
        </FileOpenButton>
      ) : (
        <button
          type="button"
          className="file-link-button"
          onClick={() => openPdfInNewTab(file.base64)}
        >
          {label}
        </button>
      )}
    </div>
  );
}

/**
 * Read tool result - dispatches to text or image handler
 */
function ReadToolResult({
  result,
  isError,
  input,
}: {
  result: ReadResultWithAugment | string | undefined;
  isError: boolean;
  input?: Partial<ReadInput>;
}) {
  const normalizedResult = normalizeReadResult(result, input);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && normalizedResult) {
      const validation = validateToolResult("Read", normalizedResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Read", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, normalizedResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Read");

  if (isError || !normalizedResult?.file) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="read-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Failed to read file"}
      </div>
    );
  }

  if (normalizedResult.type === "pdf") {
    return (
      <>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        <PdfFileResult
          file={normalizedResult.file as PdfFile}
          filePath={getReadInputFilePath(input)}
        />
      </>
    );
  }

  if (normalizedResult.type === "image") {
    return (
      <>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        <ImageFileResult file={normalizedResult.file as ImageFile} />
      </>
    );
  }

  return (
    <>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Read" errors={validationErrors} />
      )}
      <TextFileResult
        file={normalizedResult.file as TextFile}
        result={normalizedResult}
        isPtyHandoff={isPtyHandoffTextRead(normalizedResult)}
      />
    </>
  );
}

/**
 * Interactive summary for Read tool - clickable filename that opens modal
 */
function ReadInteractiveSummary({
  input,
  result,
  isError,
}: {
  input: Partial<ReadInput>;
  result: ReadResultWithAugment | string | undefined;
  isError: boolean;
}) {
  const normalizedResult = normalizeReadResult(result, input);
  const metadata = useOptionalSessionMetadata();
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && normalizedResult) {
      const validation = validateToolResult("Read", normalizedResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Read", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, normalizedResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Read");

  const inputPath = getReadInputFilePath(input);
  const fileName = getFileName(inputPath);
  const warning = showValidationWarning && validationErrors && (
    <SchemaWarning toolName="Read" errors={validationErrors} />
  );

  if (isError) {
    return (
      <span>
        {fileName}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </span>
    );
  }

  if (!normalizedResult?.file) {
    return <span>{fileName}</span>;
  }

  if (normalizedResult.type === "pdf") {
    const pdfFile = normalizedResult.file as PdfFile;
    const label = (
      <>
        {fileName}
        <span className="file-line-count-inline">(PDF)</span>
        {warning}
      </>
    );
    return inputPath ? (
      <FileOpenButton
        fileRef={fileRefFromPath(inputPath, metadata)}
        className="file-link-inline"
        stopPropagation
      >
        {label}
      </FileOpenButton>
    ) : (
      <button
        type="button"
        className="file-link-inline"
        onClick={(e) => {
          e.stopPropagation();
          openPdfInNewTab(pdfFile.base64);
        }}
      >
        {label}
      </button>
    );
  }

  if (normalizedResult.type === "image") {
    const imageFile = normalizedResult.file as ImageFile;
    return (
      <FileOpenButton
        fileRef={fileRefFromPath(inputPath ?? "", metadata)}
        snapshot={{
          kind: "image",
          src: `data:${imageFile.type};base64,${imageFile.base64}`,
        }}
        className="file-link-inline"
        stopPropagation
      >
        {fileName}
        <span className="file-line-count-inline">(image)</span>
        {warning}
      </FileOpenButton>
    );
  }

  const file = normalizedResult.file as TextFile;
  return (
    <TextReadInteractiveSummary
      file={file}
      fileName={fileName}
      result={normalizedResult}
      isPtyHandoff={isPtyHandoffTextRead(normalizedResult)}
      showValidationWarning={!!showValidationWarning}
      validationErrors={validationErrors}
    />
  );
}

function TextReadInteractiveSummary({
  file,
  fileName,
  result,
  isPtyHandoff,
  showValidationWarning,
  validationErrors,
}: {
  file: TextFile;
  fileName: string;
  result: ReadResultWithAugment;
  isPtyHandoff: boolean;
  showValidationWarning: boolean;
  validationErrors: ZodError | null;
}) {
  const fileRef = useReadFileRef(file);

  if (isPtyHandoff) {
    return (
      <span>
        {fileName}{" "}
        <span className="file-line-count-inline">continues in Shell</span>
      </span>
    );
  }

  return (
    <FileOpenButton
      fileRef={fileRef}
      snapshot={textSnapshot(file, result)}
      className="file-link-inline"
      stopPropagation
    >
      {fileName}
      <span className="file-line-count-inline">{getLineCountLabel(file)}</span>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Read" errors={validationErrors} />
      )}
    </FileOpenButton>
  );
}

export const readRenderer: ToolRenderer<unknown, unknown> = {
  tool: "Read",

  renderToolUse(input, _context) {
    return <ReadToolUse input={(input ?? {}) as Partial<ReadInput>} />;
  },

  renderToolResult(result, isError, _context, input) {
    const imagePath = isError
      ? undefined
      : getImagePlaceholderReadPath(result, input);
    if (imagePath) {
      return <ImagePathRead filePath={imagePath} inline={false} />;
    }
    return (
      <ReadToolResult
        result={result as ReadResultWithAugment | string | undefined}
        isError={isError}
        input={input as Partial<ReadInput> | undefined}
      />
    );
  },

  getUseSummary(input) {
    return getFileName(getReadInputFilePath(input));
  },

  getResultSummary(result, isError, input?) {
    if (isError && input) return getFileName(getReadInputFilePath(input));
    if (isError) return "Error";
    if (getImagePlaceholderReadPath(result, input)) return "Image";
    const r = normalizeReadResult(
      result as ReadResultWithAugment | string | undefined,
      input as Partial<ReadInput> | undefined,
    );
    if (!r?.file) return "Reading...";
    if (isPtyHandoffTextRead(r)) return "continues in Shell";
    if (r.type === "pdf") return "PDF";
    if (r.type === "image") return "Image";
    return getFileName((r.file as TextFile).filePath);
  },

  renderInteractiveSummary(input, result, isError, _context) {
    const partialInput = (input ?? {}) as Partial<ReadInput>;
    if (!isError && !getReadInputFilePath(partialInput) && result === undefined)
      return null;
    const imagePath = isError
      ? undefined
      : getImagePlaceholderReadPath(result, partialInput);
    if (imagePath) {
      return <ImagePathRead filePath={imagePath} inline />;
    }
    return (
      <ReadInteractiveSummary
        input={partialInput}
        result={result as ReadResultWithAugment | string | undefined}
        isError={isError}
      />
    );
  },
};
