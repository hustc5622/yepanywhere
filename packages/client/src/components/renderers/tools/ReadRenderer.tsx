import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { FileViewerModal } from "../../FilePathLink";
import { SchemaWarning } from "../../SchemaWarning";
import { Modal } from "../../ui/Modal";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
  input?: ReadInput,
): ReadResultWithAugment | undefined {
  if (!result) {
    return undefined;
  }

  if (typeof result !== "string") {
    return result;
  }

  const filePath =
    getXmlTag(result, "path") ??
    input?.file_path ??
    (isRecord(input) && typeof input.filePath === "string"
      ? input.filePath
      : undefined);
  if (!filePath) {
    return undefined;
  }

  const rawContent =
    getXmlTag(result, "content") ?? getXmlTag(result, "entries");
  const type = getXmlTag(result, "type");
  const text =
    type === "directory"
      ? (rawContent ?? result).trim()
      : stripOpenCodeReadLineNumbers(rawContent ?? result);
  const startLine = parseOpenCodeReadStartLine(rawContent ?? "");
  const numLines = text ? text.split("\n").length : 0;
  const totalLines =
    parseOpenCodeReadTotalLines(result) ??
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

function stripOpenCodeReadLineNumbers(text: string): string {
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

function parseOpenCodeReadStartLine(text: string): number {
  const firstNumberedLine = text.match(/^(\d+):/m);
  return firstNumberedLine?.[1] ? Number.parseInt(firstNumberedLine[1], 10) : 1;
}

function parseOpenCodeReadTotalLines(text: string): number | undefined {
  const totalMatch =
    text.match(/total\s+(\d+)\s+lines/i) ?? text.match(/of\s+(\d+)\s+lines/i);
  return totalMatch?.[1] ? Number.parseInt(totalMatch[1], 10) : undefined;
}

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function getProjectRelativePath(
  filePath: string,
  projectPath: string | null | undefined,
): string | null {
  if (!projectPath) return null;

  const root = projectPath.replace(/\/+$/, "");
  if (!root) return null;

  if (filePath === root) return "";
  if (!filePath.startsWith(`${root}/`)) return null;
  return filePath.slice(root.length + 1);
}

function isProjectRelativePath(filePath: string): boolean {
  return !filePath.startsWith("/") && !filePath.includes("://");
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
function ReadToolUse({ input }: { input: ReadInput }) {
  const fileName = getFileName(input.file_path);
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

/**
 * Modal content for viewing file contents
 */
function FileModalContent({
  file,
  highlightedHtml,
  highlightedTruncated,
  renderedMarkdownHtml,
}: {
  file: TextFile;
  highlightedHtml?: string;
  highlightedTruncated?: boolean;
  renderedMarkdownHtml?: string;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const lines = (file.content ?? "").split("\n");
  const hasMarkdownPreview = !!renderedMarkdownHtml;
  const showRangeNotice = file.startLine > 1 || file.numLines < file.totalLines;

  // Toggle button for markdown files
  const toggleButton = hasMarkdownPreview && (
    <div className="markdown-view-toggle">
      <button
        type="button"
        className={`toggle-btn ${!showPreview ? "active" : ""}`}
        onClick={() => setShowPreview(false)}
      >
        Source
      </button>
      <button
        type="button"
        className={`toggle-btn ${showPreview ? "active" : ""}`}
        onClick={() => setShowPreview(true)}
      >
        Preview
      </button>
    </div>
  );

  // Show rendered markdown preview
  if (showPreview && renderedMarkdownHtml) {
    return (
      <div className="file-content-modal">
        {showRangeNotice && (
          <div className="file-content-range-notice">
            Showing lines {file.startLine}-{file.startLine + file.numLines - 1}{" "}
            of {file.totalLines}
          </div>
        )}
        {toggleButton}
        <div className="markdown-preview">
          <div
            className="markdown-rendered"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: renderedMarkdownHtml }}
          />
        </div>
      </div>
    );
  }

  // Use highlighted HTML if available
  if (highlightedHtml) {
    return (
      <div className="file-content-modal">
        {showRangeNotice && (
          <div className="file-content-range-notice">
            Showing lines {file.startLine}-{file.startLine + file.numLines - 1}{" "}
            of {file.totalLines}
          </div>
        )}
        {toggleButton}
        <div className="file-viewer-code file-viewer-code-highlighted">
          <div
            className="shiki-container"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
          {highlightedTruncated && (
            <div className="file-viewer-truncated">
              Content truncated for highlighting (showing first 2000 lines)
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback: plain text with line numbers
  return (
    <div className="file-content-modal">
      {showRangeNotice && (
        <div className="file-content-range-notice">
          Showing lines {file.startLine}-{file.startLine + file.numLines - 1} of{" "}
          {file.totalLines}
        </div>
      )}
      {toggleButton}
      <div className="file-content-with-lines">
        <div className="line-numbers">
          {lines.map((_, i) => (
            <div key={`ln-${i + 1}`}>{file.startLine + i}</div>
          ))}
        </div>
        <pre className="line-content">
          <code>{file.content}</code>
        </pre>
      </div>
    </div>
  );
}

/**
 * Build modal title for file with optional range info
 */
function FileModalTitle({ file }: { file: TextFile }) {
  const fileName = getFileName(file.filePath);
  const showRange = file.startLine > 1 || file.numLines < file.totalLines;

  return (
    <span className="file-path">
      {fileName}
      {showRange && (
        <span className="file-range">
          {" "}
          (lines {file.startLine}-{file.startLine + file.numLines - 1} of{" "}
          {file.totalLines})
        </span>
      )}
    </span>
  );
}

type ReadModalTarget =
  | { type: "project"; relativePath: string; lineNumber?: number }
  | { type: "fragment" };

function useReadModalTarget(file: TextFile): ReadModalTarget {
  const metadata = useOptionalSessionMetadata();
  const relativeFromProject = getProjectRelativePath(
    file.filePath,
    metadata?.projectPath,
  );
  const lineNumber = file.startLine > 1 ? file.startLine : undefined;

  if (metadata?.projectId && relativeFromProject) {
    return {
      type: "project",
      relativePath: relativeFromProject,
      lineNumber,
    };
  }

  if (metadata?.projectId && isProjectRelativePath(file.filePath)) {
    return {
      type: "project",
      relativePath: file.filePath,
      lineNumber,
    };
  }

  return { type: "fragment" };
}

function ReadFileModal({
  target,
  file,
  highlightedHtml,
  highlightedTruncated,
  renderedMarkdownHtml,
  onClose,
}: {
  target: ReadModalTarget;
  file: TextFile;
  highlightedHtml?: string;
  highlightedTruncated?: boolean;
  renderedMarkdownHtml?: string;
  onClose: () => void;
}) {
  const metadata = useOptionalSessionMetadata();

  if (target.type === "project" && metadata?.projectId) {
    return (
      <FileViewerModal
        projectId={metadata.projectId}
        filePath={target.relativePath}
        lineNumber={target.lineNumber}
        onClose={onClose}
      />
    );
  }

  return (
    <Modal title={<FileModalTitle file={file} />} onClose={onClose}>
      <FileModalContent
        file={file}
        highlightedHtml={highlightedHtml}
        highlightedTruncated={highlightedTruncated}
        renderedMarkdownHtml={renderedMarkdownHtml}
      />
    </Modal>
  );
}

/**
 * Text file result - clickable filename that opens modal
 */
function TextFileResult({
  file,
  highlightedHtml,
  highlightedTruncated,
  renderedMarkdownHtml,
  isPtyHandoff = false,
}: {
  file: TextFile;
  highlightedHtml?: string;
  highlightedTruncated?: boolean;
  renderedMarkdownHtml?: string;
  isPtyHandoff?: boolean;
}) {
  const [showModal, setShowModal] = useState(false);
  const fileName = getFileName(file.filePath);
  const showRange = file.startLine > 1 || file.numLines < file.totalLines;
  const modalTarget = useReadModalTarget(file);

  if (isPtyHandoff) {
    return (
      <div className="read-text-result">
        <span className="file-path">{fileName}</span>{" "}
        <span className="file-line-count">continues in Shell</span>
      </div>
    );
  }

  return (
    <>
      <div className="read-text-result">
        <button
          type="button"
          className="file-link-button"
          onClick={() => setShowModal(true)}
        >
          {fileName}
          {showRange && (
            <span className="file-range">
              {" "}
              (lines {file.startLine}-{file.startLine + file.numLines - 1})
            </span>
          )}
          <span className="file-line-count">{getLineCountLabel(file)}</span>
        </button>
      </div>
      {showModal && (
        <ReadFileModal
          target={modalTarget}
          file={file}
          highlightedHtml={highlightedHtml}
          highlightedTruncated={highlightedTruncated}
          renderedMarkdownHtml={renderedMarkdownHtml}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
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
  window.open(url, "_blank");
}

/**
 * PDF file result - button to open in new tab
 */
function PdfFileResult({
  file,
  filePath,
}: { file: PdfFile; filePath?: string }) {
  const sizeKB = file.originalSize ? Math.round(file.originalSize / 1024) : 0;
  const fileName = filePath ? getFileName(filePath) : "document.pdf";

  return (
    <div className="read-pdf-result">
      <button
        type="button"
        className="file-link-button"
        onClick={() => openPdfInNewTab(file.base64)}
      >
        {fileName}
        {sizeKB > 0 && <span className="file-line-count">({sizeKB}KB)</span>}
        <span className="file-line-count">Open PDF</span>
      </button>
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
  input?: ReadInput;
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
        <PdfFileResult file={normalizedResult.file as PdfFile} />
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
        highlightedHtml={normalizedResult._highlightedContentHtml}
        highlightedTruncated={normalizedResult._highlightedTruncated}
        renderedMarkdownHtml={normalizedResult._renderedMarkdownHtml}
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
  input: ReadInput;
  result: ReadResultWithAugment | string | undefined;
  isError: boolean;
}) {
  const normalizedResult = normalizeReadResult(result, input);
  const [showModal, setShowModal] = useState(false);
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

  const fileName = getFileName(input.file_path);

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
    return (
      <button
        type="button"
        className="file-link-inline"
        onClick={(e) => {
          e.stopPropagation();
          openPdfInNewTab(pdfFile.base64);
        }}
      >
        {fileName}
        <span className="file-line-count-inline">(PDF)</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </button>
    );
  }

  if (normalizedResult.type === "image") {
    const imageFile = normalizedResult.file as ImageFile;
    return (
      <>
        <button
          type="button"
          className="file-link-inline"
          onClick={(e) => {
            e.stopPropagation();
            setShowModal(true);
          }}
        >
          {fileName}
          <span className="file-line-count-inline">(image)</span>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Read" errors={validationErrors} />
          )}
        </button>
        {showModal && (
          <Modal title={fileName} onClose={() => setShowModal(false)}>
            <ImageFileResult file={imageFile} />
          </Modal>
        )}
      </>
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
  const [showModal, setShowModal] = useState(false);
  const modalTarget = useReadModalTarget(file);

  if (isPtyHandoff) {
    return (
      <span>
        {fileName}{" "}
        <span className="file-line-count-inline">continues in Shell</span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="file-link-inline"
        onClick={(e) => {
          e.stopPropagation();
          setShowModal(true);
        }}
      >
        {fileName}
        <span className="file-line-count-inline">
          {getLineCountLabel(file)}
        </span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </button>
      {showModal && (
        <ReadFileModal
          target={modalTarget}
          file={file}
          highlightedHtml={result._highlightedContentHtml}
          highlightedTruncated={result._highlightedTruncated}
          renderedMarkdownHtml={result._renderedMarkdownHtml}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

export const readRenderer: ToolRenderer<ReadInput, ReadResult> = {
  tool: "Read",

  renderToolUse(input, _context) {
    return <ReadToolUse input={input as ReadInput} />;
  },

  renderToolResult(result, isError, _context, input) {
    return (
      <ReadToolResult
        result={result as ReadResultWithAugment | string | undefined}
        isError={isError}
        input={input as ReadInput | undefined}
      />
    );
  },

  getUseSummary(input) {
    return getFileName((input as ReadInput).file_path);
  },

  getResultSummary(result, isError, input?) {
    if (isError && input) return getFileName((input as ReadInput).file_path);
    if (isError) return "Error";
    const r = normalizeReadResult(
      result as ReadResultWithAugment | string | undefined,
      input as ReadInput | undefined,
    );
    if (!r?.file) return "Reading...";
    if (isPtyHandoffTextRead(r)) return "continues in Shell";
    if (r.type === "pdf") return "PDF";
    if (r.type === "image") return "Image";
    return getFileName((r.file as TextFile).filePath);
  },

  renderInteractiveSummary(input, result, isError, _context) {
    return (
      <ReadInteractiveSummary
        input={input as ReadInput}
        result={result as ReadResultWithAugment | string | undefined}
        isError={isError}
      />
    );
  },
};
