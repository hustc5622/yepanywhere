import { useCallback, useEffect, useMemo, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useOptionalI18n } from "../../../i18n";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Modal } from "../../ui/Modal";
import type { ToolRenderer, WriteResult } from "./types";

const MAX_LINES_COLLAPSED = 30;
const PREVIEW_LINES = 3;

/** Extended input type with embedded augment data from server */
interface WriteInputAugments {
  _highlightedContentHtml?: string;
  _highlightedLanguage?: string;
  _highlightedTruncated?: boolean;
  _renderedMarkdownHtml?: string;
}

interface NormalizedWriteInput extends WriteInputAugments {
  filePath?: string;
  content?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeWriteInput(input: unknown): NormalizedWriteInput {
  if (!isRecord(input)) return {};
  return {
    filePath:
      getString(input.file_path) ??
      getString(input.path) ??
      getString(input.filePath),
    content: getString(input.content),
    _highlightedContentHtml: getString(input._highlightedContentHtml),
    _highlightedLanguage: getString(input._highlightedLanguage),
    _highlightedTruncated:
      typeof input._highlightedTruncated === "boolean"
        ? input._highlightedTruncated
        : undefined,
    _renderedMarkdownHtml: getString(input._renderedMarkdownHtml),
  };
}

/**
 * Check if file is markdown based on extension.
 */
function isMarkdownFile(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

/**
 * Extract filename from path
 */
function getFileName(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  return filePath.replace(/\\/g, "/").split("/").pop() || filePath;
}

function normalizeWriteResult(
  result: unknown,
  input?: unknown,
): WriteResult | undefined {
  if (isRecord(result) && isRecord(result.file)) {
    const filePath =
      getString(result.file.filePath) ?? getString(result.file.file_path);
    const content = getString(result.file.content);
    if (filePath !== undefined && content !== undefined) {
      const numLines = content.split("\n").length;
      return {
        ...(result as unknown as WriteResult),
        file: {
          ...(result.file as WriteResult["file"]),
          filePath,
          content,
          numLines:
            typeof result.file.numLines === "number"
              ? result.file.numLines
              : numLines,
          startLine:
            typeof result.file.startLine === "number"
              ? result.file.startLine
              : 1,
          totalLines:
            typeof result.file.totalLines === "number"
              ? result.file.totalLines
              : numLines,
        },
      };
    }
  }

  const normalizedInput = normalizeWriteInput(input);
  if (!normalizedInput.filePath || normalizedInput.content === undefined) {
    return undefined;
  }

  const lineCount = normalizedInput.content.split("\n").length;
  return {
    type: "text",
    file: {
      filePath: normalizedInput.filePath,
      content: normalizedInput.content,
      numLines: lineCount,
      startLine: 1,
      totalLines: lineCount,
    },
  };
}

/**
 * Truncate highlighted HTML to a specified number of lines.
 * Shiki output wraps each line in <span class="line">.
 */
function truncateHighlightedHtml(html: string, maxLines: number): string {
  const lines = html.split('<span class="line">');
  if (lines.length <= maxLines + 1) return html;

  // Rebuild with only maxLines worth of lines
  const truncated = lines.slice(0, maxLines + 1).join('<span class="line">');
  // Close any open tags
  return `${truncated}</code></pre>`;
}

/**
 * Write tool use - shows file path being written
 */
function WriteToolUse({ input }: { input: unknown }) {
  const normalized = normalizeWriteInput(input);
  const i18n = useOptionalI18n();
  const fileName = getFileName(normalized.filePath);
  const lineCount = normalized.content?.split("\n").length;
  return (
    <div className="write-tool-use">
      <span className="file-path">
        {fileName ?? (i18n ? i18n.t("writePreparing") : "Preparing write")}
      </span>
      {lineCount !== undefined && (
        <span className="write-info">{lineCount} lines</span>
      )}
    </div>
  );
}

/**
 * Modal content for viewing full file contents
 */
function WriteModalContent({
  file,
  input,
}: {
  file: WriteResult["file"];
  input?: WriteInputAugments;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const lines = file.content.split("\n");

  const isMarkdown = isMarkdownFile(file.filePath);
  const hasMarkdownPreview = isMarkdown && !!input?._renderedMarkdownHtml;

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
  if (showPreview && input?._renderedMarkdownHtml) {
    return (
      <div className="file-content-modal">
        {toggleButton}
        <div className="markdown-preview">
          <div
            className="markdown-rendered"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: input._renderedMarkdownHtml }}
          />
        </div>
      </div>
    );
  }

  // Use highlighted HTML if available from input augment
  if (input?._highlightedContentHtml) {
    return (
      <div className="file-content-modal">
        {toggleButton}
        <div className="file-viewer-code file-viewer-code-highlighted">
          <div
            className="shiki-container"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: input._highlightedContentHtml }}
          />
          {input._highlightedTruncated && (
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
 * Write tool result - shows written content with line numbers
 * Uses highlighted HTML from input augment when available.
 */
function WriteToolResult({
  result,
  isError,
  input,
}: {
  result: unknown;
  isError: boolean;
  input?: unknown;
}) {
  const normalizedResult = useMemo(
    () => normalizeWriteResult(result, input),
    [result, input],
  );
  const normalizedInput = useMemo(() => normalizeWriteInput(input), [input]);
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && normalizedResult) {
      const validation = validateToolResult("Write", normalizedResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Write", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, normalizedResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Write");

  if (isError || !normalizedResult?.file) {
    // Extract error message - can be a string or object with content
    let errorMessage = "Failed to write file";
    if (typeof result === "string") {
      errorMessage = result;
    } else if (isRecord(result)) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }
    return (
      <div className="write-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Write" errors={validationErrors} />
        )}
        {errorMessage}
      </div>
    );
  }

  const { file } = normalizedResult;
  const lines = file.content.split("\n");
  const needsCollapse = lines.length > MAX_LINES_COLLAPSED;
  const fileName = getFileName(file.filePath) ?? file.filePath;

  // Use highlighted HTML if available from input augment
  if (normalizedInput._highlightedContentHtml) {
    return (
      <div className="write-result">
        <div className="file-header">
          <span className="file-path">{fileName}</span>
          <span className="file-range">{file.numLines} lines written</span>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Write" errors={validationErrors} />
          )}
        </div>
        <div className="file-viewer-code file-viewer-code-highlighted">
          <div
            className="shiki-container"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{
              __html: normalizedInput._highlightedContentHtml,
            }}
          />
          {normalizedInput._highlightedTruncated && (
            <div className="file-viewer-truncated">
              Content truncated for highlighting (showing first 2000 lines)
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback: plain text with line numbers and expand/collapse
  const displayLines =
    needsCollapse && !isExpanded ? lines.slice(0, MAX_LINES_COLLAPSED) : lines;

  return (
    <div className="write-result">
      <div className="file-header">
        <span className="file-path">{fileName}</span>
        <span className="file-range">{file.numLines} lines written</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Write" errors={validationErrors} />
        )}
      </div>
      <div className="file-content-with-lines">
        <div className="line-numbers">
          {displayLines.map((_, i) => {
            const lineNum = file.startLine + i;
            return <div key={`line-${lineNum}`}>{lineNum}</div>;
          })}
          {needsCollapse && !isExpanded && <div>...</div>}
        </div>
        <pre className="line-content">
          <code>{displayLines.join("\n")}</code>
        </pre>
      </div>
      {needsCollapse && (
        <button
          type="button"
          className="expand-button"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

/**
 * Collapsed preview showing line count and code preview with fade
 * Clicking opens a modal with the full content
 */
function WriteCollapsedPreview({
  input,
  result,
  isError,
}: {
  input: unknown;
  result: unknown;
  isError: boolean;
}) {
  const normalizedInput = useMemo(() => normalizeWriteInput(input), [input]);
  const normalizedResult = useMemo(
    () => normalizeWriteResult(result, input),
    [result, input],
  );
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && normalizedResult) {
      const validation = validateToolResult("Write", normalizedResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Write", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, normalizedResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Write");

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isError) {
        setIsModalOpen(true);
      }
    },
    [isError],
  );

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  // Use result data if available, otherwise fall back to input
  const content = normalizedResult?.file?.content ?? normalizedInput.content;
  const filePath = normalizedResult?.file?.filePath ?? normalizedInput.filePath;
  const fileName = getFileName(filePath) ?? filePath ?? "Write";

  // Truncate highlighted HTML for preview
  const previewHtml = useMemo(() => {
    if (!normalizedInput._highlightedContentHtml) return null;
    return truncateHighlightedHtml(
      normalizedInput._highlightedContentHtml,
      PREVIEW_LINES,
    );
  }, [normalizedInput._highlightedContentHtml]);

  if (isError) {
    // Extract error message from result - can be a string or object with content
    let errorMessage = "Failed to write file";
    if (typeof result === "string") {
      errorMessage = result;
    } else if (isRecord(result)) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }
    return (
      <div className="write-collapsed-preview write-collapsed-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Write" errors={validationErrors} />
        )}
        <span className="write-preview-error">{errorMessage}</span>
      </div>
    );
  }

  if (!filePath || content === undefined) return null;
  const lines = content.split("\n");
  const lineCount = normalizedResult?.file?.numLines ?? lines.length;
  const isTruncated = lines.length > PREVIEW_LINES;

  return (
    <>
      <button
        type="button"
        className="write-collapsed-preview"
        onClick={handleClick}
      >
        <div className="write-preview-lines">
          {lineCount} lines
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Write" errors={validationErrors} />
          )}
        </div>
        <div
          className={`write-preview-content ${isTruncated ? "write-preview-truncated" : ""}`}
        >
          {previewHtml ? (
            <div
              className="shiki-container"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <pre>
              <code>{lines.slice(0, PREVIEW_LINES).join("\n")}</code>
            </pre>
          )}
          {isTruncated && <div className="write-preview-fade" />}
        </div>
      </button>
      {isModalOpen && (
        <Modal
          title={<span className="file-path">{fileName}</span>}
          onClose={handleClose}
        >
          <WriteModalContent
            file={
              normalizedResult?.file ?? {
                filePath,
                content,
                numLines: lineCount,
                startLine: 1,
                totalLines: lineCount,
              }
            }
            input={normalizedInput}
          />
        </Modal>
      )}
    </>
  );
}

export const writeRenderer: ToolRenderer<unknown, unknown> = {
  tool: "Write",

  renderToolUse(input, _context) {
    return <WriteToolUse input={input} />;
  },

  renderToolResult(result, isError, _context, input) {
    return <WriteToolResult result={result} isError={isError} input={input} />;
  },

  getUseSummary(input) {
    return getFileName(normalizeWriteInput(input).filePath) ?? "Writing...";
  },

  getResultSummary(result, isError, input?) {
    if (isError) return "Error";
    const r = normalizeWriteResult(result, input);
    if (r?.file) {
      return getFileName(r.file.filePath) ?? "Writing...";
    }
    // Fall back to input if result not ready
    if (input) {
      return getFileName(normalizeWriteInput(input).filePath) ?? "Writing...";
    }
    return "Writing...";
  },

  renderCollapsedPreview(input, result, isError, _context) {
    if (!isError && !normalizeWriteResult(result, input)) return null;
    return (
      <WriteCollapsedPreview input={input} result={result} isError={isError} />
    );
  },
};
