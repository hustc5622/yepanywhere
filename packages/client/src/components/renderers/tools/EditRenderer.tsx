import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useExpandedDiff } from "../../../hooks/useExpandedDiff";
import {
  classifyToolError,
  getErrorClassSuffix,
  isUserRejection,
} from "../../../lib/classifyToolError";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { DetailPanel } from "../../ui/DetailPanel";
import type { EditInput, EditResult, PatchHunk, ToolRenderer } from "./types";

/**
 * Compact icon button used in collapsed diff/patch previews to open the
 * full-content modal. Replaces the previous bulky text buttons
 * ("Show full diff", "Show full patch", "Click to expand"). The descriptive
 * label is preserved via aria-label / title so screen readers and
 * hover-tooltips still surface intent.
 */
function DiffExpandButton({
  label,
  onClick,
}: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className="diff-expand-button"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* Diagonal arrows pointing outward = "expand to full view" */}
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </svg>
    </button>
  );
}

const MAX_VISIBLE_LINES = 12;

/** Extended input type with embedded augment data from server */
interface EditInputWithAugment extends EditInput {
  _structuredPatch?: PatchHunk[];
  _diffHtml?: string;
  _rawPatch?: string;
}

function extractFilePathFromRawPatch(rawPatch?: string): string | undefined {
  if (typeof rawPatch !== "string" || rawPatch.trim().length === 0) {
    return undefined;
  }

  const lines = rawPatch.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const match = line.match(
      /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):\s+(.+?)\s*$/,
    );
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function getEditFilePath(
  input?: EditInputWithAugment,
  result?: Partial<EditResult>,
): string {
  return (
    result?.filePath ??
    input?.file_path ??
    extractFilePathFromRawPatch(input?._rawPatch) ??
    ""
  );
}

/**
 * Extract filename from path.
 * Some Codex tool aliases (e.g. apply_patch -> Edit) may not include file_path.
 */
function getFileName(filePath?: string): string {
  if (typeof filePath !== "string") return "Patch";
  const trimmed = filePath.trim();
  if (!trimmed) return "Patch";
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

/**
 * Check if this is a Claude plan file
 */
function isPlanFile(filePath: string): boolean {
  return filePath.includes(".claude/plans/");
}

/**
 * Compute change summary from structuredPatch
 */
function computeChangeSummary(structuredPatch: PatchHunk[]): string | null {
  if (!structuredPatch || structuredPatch.length === 0) return null;

  const additions = structuredPatch
    .flatMap((h) => h.lines)
    .filter((l) => l.startsWith("+")).length;
  const deletions = structuredPatch
    .flatMap((h) => h.lines)
    .filter((l) => l.startsWith("-")).length;

  if (additions > 0 && deletions > 0) {
    return `Modified ${additions + deletions} lines`;
  }
  if (additions > 0) {
    return `Added ${additions} line${additions !== 1 ? "s" : ""}`;
  }
  if (deletions > 0) {
    return `Removed ${deletions} line${deletions !== 1 ? "s" : ""}`;
  }
  return null;
}

function truncateByLines(
  text: string,
  maxLines: number,
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

/**
 * Render diff lines (shared between pending preview and result fallback)
 * Memoized to prevent scroll reset when parent re-renders.
 */
const DiffLines = memo(function DiffLines({ lines }: { lines: string[] }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          // Use line content hash for stable keys
          const key = `${i}-${line.slice(0, 50)}`;
          return (
            <div key={key} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});

/**
 * Render pre-highlighted diff HTML from shiki.
 * Used when diffHtml is available from the augment.
 * Memoized to prevent scroll reset when parent re-renders.
 */
const HighlightedDiff = memo(function HighlightedDiff({
  diffHtml,
  truncateLines,
}: {
  diffHtml: string;
  truncateLines?: number;
}) {
  // If truncation is needed, we need to limit the visible lines
  // The HTML is wrapped in <pre class="shiki"><code>...</code></pre>
  // Each line is a <span class="line ...">...</span>
  const htmlToRender = useMemo(() => {
    if (!truncateLines) return diffHtml;

    // Parse and truncate by counting line spans
    // Match any span with class starting with "line" (e.g. "line", "line line-deleted")
    const lineRegex = /<span class="line[^"]*">/g;
    const matches = [...diffHtml.matchAll(lineRegex)];
    if (matches.length <= truncateLines) return diffHtml;

    // Find the position to truncate at (after truncateLines lines)
    const lastMatch = matches[truncateLines - 1];
    if (!lastMatch) return diffHtml;

    // Find the closing </span> for this line
    const startPos = (lastMatch.index ?? 0) + lastMatch[0].length;
    const closeSpanPos = diffHtml.indexOf("</span>", startPos);
    if (closeSpanPos === -1) return diffHtml;

    // Truncate and close tags
    return `${diffHtml.slice(0, closeSpanPos + 7)}</code></pre>`;
  }, [diffHtml, truncateLines]);

  return (
    <div
      className="highlighted-diff"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is safe
      dangerouslySetInnerHTML={{ __html: htmlToRender }}
    />
  );
});

/**
 * Render a single diff hunk (without @@ header for cleaner display)
 * Memoized to prevent scroll reset when parent re-renders.
 */
const DiffHunk = memo(function DiffHunk({ hunk }: { hunk: PatchHunk }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {hunk.lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          return (
            <div key={`${hunk.oldStart}-${i}`} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});

function RawPatchPreview({
  rawPatch,
  truncateLines,
}: {
  rawPatch: string;
  truncateLines?: number;
}) {
  const preview = useMemo(() => {
    if (!truncateLines) {
      return { text: rawPatch, truncated: false };
    }
    return truncateByLines(rawPatch, truncateLines);
  }, [rawPatch, truncateLines]);

  return (
    <div
      className={`diff-view-container ${preview.truncated ? "truncated" : ""}`}
    >
      <div className="diff-view">
        <pre className="code-block">
          <code>{preview.text}</code>
        </pre>
      </div>
      {preview.truncated && <div className="diff-fade-overlay" />}
    </div>
  );
}

function RawPatchModalContent({ rawPatch }: { rawPatch: string }) {
  return (
    <div className="diff-modal-content">
      <pre className="code-block">
        <code>{rawPatch}</code>
      </pre>
    </div>
  );
}

/**
 * Edit tool use - shows file path and diff preview
 * Reads augment data directly from input._structuredPatch and input._diffHtml.
 */
function EditToolUse({ input }: { input: EditInputWithAugment }) {
  // Show loading state if augment data not yet available
  if (!input._structuredPatch || input._structuredPatch.length === 0) {
    if (input._rawPatch) {
      return (
        <div className="edit-result">
          <RawPatchPreview rawPatch={input._rawPatch} />
        </div>
      );
    }
    return (
      <div className="edit-result">
        <div className="edit-loading">Computing diff...</div>
      </div>
    );
  }

  const diffLines = input._structuredPatch.flatMap((hunk) => hunk.lines);
  const changeSummary = computeChangeSummary(input._structuredPatch);
  const isTruncated = diffLines.length > MAX_VISIBLE_LINES;

  return (
    <div className="edit-result">
      {changeSummary && (
        <div className="edit-change-summary">{changeSummary}</div>
      )}
      <div className={`diff-view-container ${isTruncated ? "truncated" : ""}`}>
        <div className="diff-view">
          {input._diffHtml ? (
            <HighlightedDiff
              diffHtml={input._diffHtml}
              truncateLines={isTruncated ? MAX_VISIBLE_LINES : undefined}
            />
          ) : (
            <DiffLines lines={diffLines} />
          )}
        </div>
        {isTruncated && <div className="diff-fade-overlay" />}
      </div>
    </div>
  );
}

/**
 * Get relative file path by stripping project path prefix
 */
function getRelativePath(filePath: string, projectPath: string | null): string {
  if (projectPath && filePath.startsWith(projectPath)) {
    // Strip project path and leading slash
    const relative = filePath.slice(projectPath.length);
    return relative.startsWith("/") ? relative.slice(1) : relative;
  }
  return filePath;
}

/**
 * Modal content for viewing complete diff with optional full file context.
 * Full context toggle is only available when originalFile is provided.
 */
function DiffModalContent({
  diffHtml,
  structuredPatch,
  filePath,
  oldString,
  newString,
  originalFile,
}: {
  diffHtml?: string;
  structuredPatch: PatchHunk[];
  filePath: string;
  oldString: string;
  newString: string;
  /** Complete file content from SDK Edit result (never truncated). Null for file creation. */
  originalFile?: string | null;
}) {
  const { projectPath } = useSessionMetadata();
  const [showFullContext, setShowFullContext] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Only fetch expanded diff when originalFile is available (not for file creation)
  // The SDK's originalFile is never truncated - it's the complete file content.
  const canExpandContext = !!originalFile;
  const { loading, error, result, fetchExpandedDiff } = useExpandedDiff({
    filePath,
    oldString,
    newString,
    originalFile: originalFile ?? "", // Empty string won't be used if canExpandContext is false
  });

  const handleToggle = useCallback(async () => {
    if (!canExpandContext) return;
    if (!showFullContext && !result) {
      await fetchExpandedDiff();
    }
    setShowFullContext(!showFullContext);
  }, [canExpandContext, showFullContext, result, fetchExpandedDiff]);

  // Scroll to the first changed line when showing full context
  useEffect(() => {
    if (showFullContext && result && contentRef.current) {
      // Wait for DOM to update with new content
      requestAnimationFrame(() => {
        const firstChange = contentRef.current?.querySelector(
          ".line-deleted, .line-inserted",
        );
        if (firstChange) {
          firstChange.scrollIntoView({ block: "center", behavior: "instant" });
        }
      });
    }
  }, [showFullContext, result]);

  // Use expanded result when showing full context
  const displayHtml =
    showFullContext && result?.diffHtml ? result.diffHtml : diffHtml;
  const displayPatch =
    showFullContext && result?.structuredPatch
      ? result.structuredPatch
      : structuredPatch;

  // Strip project path prefix for display
  const displayPath = getRelativePath(filePath, projectPath);

  return (
    <div className="diff-modal-content" ref={contentRef}>
      <div className="diff-context-controls">
        <span className="diff-context-path">{displayPath}</span>
        {canExpandContext && (
          <button
            type="button"
            className="diff-context-toggle"
            onClick={handleToggle}
            disabled={loading}
          >
            {loading
              ? "Loading..."
              : showFullContext
                ? "Show diff only"
                : "Show full context"}
          </button>
        )}
        {error && <span className="diff-context-error">{error}</span>}
      </div>

      {displayHtml ? (
        <HighlightedDiff diffHtml={displayHtml} />
      ) : (
        <DiffLines lines={displayPatch.flatMap((h) => h.lines)} />
      )}
    </div>
  );
}

/**
 * Collapsed preview showing diff with expand button
 * Clicking opens a modal with the full diff.
 * Reads augment data directly from input._structuredPatch and input._diffHtml.
 */
function EditCollapsedPreview({
  input,
  result,
  isError,
}: {
  input: EditInputWithAugment;
  result: EditResult | undefined;
  isError: boolean;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");

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

  // Use result data if available, fall back to input
  const filePath = getEditFilePath(input, result);
  const fileName = getFileName(filePath);
  const oldString = result?.oldString ?? input.old_string;
  const newString = result?.newString ?? input.new_string;
  const originalFile = result?.originalFile;

  // Get structuredPatch - prefer result, then input augment
  const structuredPatch =
    result?.structuredPatch ?? input._structuredPatch ?? [];

  // Get diffHtml from input augment (only used for tool_use display)
  const diffHtml = input._diffHtml;
  const rawPatch = input._rawPatch;

  if (isError) {
    // Extract error message - can be a string or object with content
    let errorMessage: string | null = null;
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }

    // Classify the error for appropriate styling
    const classification = errorMessage
      ? classifyToolError(errorMessage)
      : {
          classification: "unknown" as const,
          label: "Error",
          cleanedMessage: "",
        };
    const classSuffix = getErrorClassSuffix(classification.classification);
    const isRejection = isUserRejection(classification.classification);

    // For user rejections, show the proposed diff alongside the declined badge
    const hasProposedDiff =
      isRejection &&
      input._structuredPatch &&
      input._structuredPatch.length > 0;
    const proposedDiffLines = hasProposedDiff
      ? (input._structuredPatch?.flatMap((hunk) => hunk.lines) ?? [])
      : [];
    const proposedDiffTruncated = proposedDiffLines.length > MAX_VISIBLE_LINES;

    return (
      <>
        <div className={`edit-collapsed-preview edit-collapsed-${classSuffix}`}>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
          <span className={`badge badge-${classSuffix}`}>
            {isRejection
              ? classification.label
              : `Edit ${classification.label.toLowerCase()}`}
          </span>
          {classification.userReason ? (
            <span className="edit-error-message">
              {classification.userReason}
            </span>
          ) : classification.cleanedMessage && !isRejection ? (
            <span className="edit-error-message">
              {classification.cleanedMessage}
            </span>
          ) : null}
          {hasProposedDiff && (
            <div
              className={`diff-view-container ${proposedDiffTruncated ? "truncated" : ""}`}
            >
              <div className="diff-view">
                {input._diffHtml ? (
                  <HighlightedDiff
                    diffHtml={input._diffHtml}
                    truncateLines={
                      proposedDiffTruncated ? MAX_VISIBLE_LINES : undefined
                    }
                  />
                ) : (
                  <DiffLines lines={proposedDiffLines} />
                )}
              </div>
              {proposedDiffTruncated && <div className="diff-fade-overlay" />}
            </div>
          )}
          {hasProposedDiff && proposedDiffTruncated && (
            <DiffExpandButton
              label="Show full diff"
              onClick={(e) => {
                e.stopPropagation();
                setIsModalOpen(true);
              }}
            />
          )}
        </div>
        {isModalOpen && hasProposedDiff && (
          <DetailPanel
            title={<span className="file-path">{fileName}</span>}
            onClose={handleClose}
          >
            <DiffModalContent
              diffHtml={diffHtml}
              structuredPatch={structuredPatch}
              filePath={filePath}
              oldString={oldString}
              newString={newString}
            />
          </DetailPanel>
        )}
      </>
    );
  }

  // Pending edit without augment data yet
  if (structuredPatch.length === 0) {
    if (result === undefined) {
      return (
        <div className="edit-collapsed-preview">
          <div className="edit-loading">Computing diff...</div>
        </div>
      );
    }

    if (rawPatch) {
      const rawPatchPreview = truncateByLines(rawPatch, MAX_VISIBLE_LINES);
      return (
        <>
          <div className="edit-collapsed-preview">
            {showValidationWarning && validationErrors && (
              <SchemaWarning toolName="Edit" errors={validationErrors} />
            )}
            <RawPatchPreview
              rawPatch={rawPatch}
              truncateLines={MAX_VISIBLE_LINES}
            />
            {rawPatchPreview.truncated && (
              <DiffExpandButton
                label="Show full patch"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsModalOpen(true);
                }}
              />
            )}
          </div>
          {isModalOpen && (
            <DetailPanel
              title={<span className="file-path">{fileName}</span>}
              onClose={handleClose}
            >
              <RawPatchModalContent rawPatch={rawPatch} />
            </DetailPanel>
          )}
        </>
      );
    }

    return (
      <div className="edit-collapsed-preview">
        <span>Patch preview unavailable</span>
      </div>
    );
  }

  const diffLines = structuredPatch.flatMap((hunk) => hunk.lines);
  const isTruncated = diffLines.length > MAX_VISIBLE_LINES;

  return (
    <>
      <div className="edit-collapsed-preview">
        {result?.userModified && (
          <span className="badge badge-info">User modified</span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
        <div
          className={`diff-view-container ${isTruncated ? "truncated" : ""}`}
        >
          <div className="diff-view">
            {diffHtml ? (
              <HighlightedDiff
                diffHtml={diffHtml}
                truncateLines={isTruncated ? MAX_VISIBLE_LINES : undefined}
              />
            ) : (
              <DiffLines lines={diffLines} />
            )}
          </div>
          {isTruncated && <div className="diff-fade-overlay" />}
        </div>
        {isTruncated && (
          <DiffExpandButton label="Show full diff" onClick={handleClick} />
        )}
      </div>
      {isModalOpen && (
        <DetailPanel
          title={<span className="file-path">{fileName}</span>}
          onClose={handleClose}
        >
          <DiffModalContent
            diffHtml={diffHtml}
            structuredPatch={structuredPatch}
            filePath={filePath}
            oldString={oldString}
            newString={newString}
            originalFile={originalFile}
          />
        </DetailPanel>
      )}
    </>
  );
}

/**
 * Interactive summary for Edit tool - shows filename and change summary inline
 * Similar to Read tool's interactive summary
 */
function EditInteractiveSummary({
  input,
  result,
  isError,
}: {
  input: EditInputWithAugment;
  result: EditResult | undefined;
  isError: boolean;
}) {
  const [showModal, setShowModal] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");

  const filePath = getEditFilePath(input, result);
  const fileName = getFileName(filePath);
  const oldString = result?.oldString ?? input.old_string;
  const newString = result?.newString ?? input.new_string;
  const originalFile = result?.originalFile;

  // Get structuredPatch - prefer result, then input augment
  const structuredPatch =
    result?.structuredPatch ?? input._structuredPatch ?? [];
  const diffHtml = input._diffHtml;
  const changeSummary = computeChangeSummary(structuredPatch);

  if (isError) {
    return (
      <span>
        {fileName}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
      </span>
    );
  }

  // Show loading state if no patch yet
  if (structuredPatch.length === 0) {
    return <span title={filePath}>{fileName}</span>;
  }

  return (
    <>
      <button
        type="button"
        className="file-link-inline"
        title={filePath}
        onClick={(e) => {
          e.stopPropagation();
          setShowModal(true);
        }}
      >
        {fileName}
        {changeSummary && (
          <span className="file-line-count-inline">{changeSummary}</span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
      </button>
      {showModal && (
        <DetailPanel
          title={<span className="file-path">{fileName}</span>}
          onClose={() => setShowModal(false)}
        >
          <DiffModalContent
            diffHtml={diffHtml}
            structuredPatch={structuredPatch}
            filePath={filePath}
            oldString={oldString}
            newString={newString}
            originalFile={originalFile}
          />
        </DetailPanel>
      )}
    </>
  );
}

/**
 * Edit tool result - shows diff view with truncation and modal expand
 */
function EditToolResult({
  result,
  input,
  isError,
}: {
  result: EditResult;
  input?: EditInput;
  isError: boolean;
}) {
  const [showModal, setShowModal] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");

  const inputWithAugment = input as EditInputWithAugment | undefined;
  const filePath = getEditFilePath(inputWithAugment, result);
  const fileName = getFileName(filePath);
  const structuredPatch =
    result?.structuredPatch ?? inputWithAugment?._structuredPatch ?? [];
  const diffHtml = inputWithAugment?._diffHtml;
  const rawPatch = inputWithAugment?._rawPatch;
  const inputRecord = inputWithAugment as
    | (EditInputWithAugment & Record<string, unknown>)
    | undefined;
  const oldString =
    result?.oldString ??
    inputWithAugment?.old_string ??
    (typeof inputRecord?.oldString === "string"
      ? inputRecord.oldString
      : undefined);
  const newString =
    result?.newString ??
    inputWithAugment?.new_string ??
    (typeof inputRecord?.newString === "string"
      ? inputRecord.newString
      : undefined);
  const originalFile = result?.originalFile;

  // Count total lines in all hunks
  const totalLines = useMemo(() => {
    return structuredPatch.reduce(
      (sum, hunk) => sum + hunk.lines.length + 1, // +1 for hunk header
      0,
    );
  }, [structuredPatch]);

  const isTruncated = totalLines > MAX_VISIBLE_LINES;

  // Compute change summary
  const changeSummary = useMemo(() => {
    if (structuredPatch.length === 0) return null;
    const additions = structuredPatch
      .flatMap((h) => h.lines)
      .filter((l) => l.startsWith("+")).length;
    const deletions = structuredPatch
      .flatMap((h) => h.lines)
      .filter((l) => l.startsWith("-")).length;

    if (additions > 0 && deletions > 0) {
      return `Modified ${additions + deletions} lines`;
    }
    if (additions > 0) {
      return `Added ${additions} line${additions !== 1 ? "s" : ""}`;
    }
    if (deletions > 0) {
      return `Removed ${deletions} line${deletions !== 1 ? "s" : ""}`;
    }
    return null;
  }, [structuredPatch]);

  if (isError) {
    // Extract error message - can be a string or object with content
    let errorMessage: string | null = null;
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }

    // Classify the error for appropriate styling
    const classification = errorMessage
      ? classifyToolError(errorMessage)
      : {
          classification: "unknown" as const,
          label: "Error",
          cleanedMessage: "",
        };
    const classSuffix = getErrorClassSuffix(classification.classification);
    const isRejection = isUserRejection(classification.classification);

    // For user rejections, show the proposed diff alongside the declined badge
    const hasProposedDiff =
      isRejection &&
      inputWithAugment?._structuredPatch &&
      inputWithAugment._structuredPatch.length > 0;
    const proposedDiffLines = hasProposedDiff
      ? (inputWithAugment._structuredPatch?.flatMap((hunk) => hunk.lines) ?? [])
      : [];
    const proposedDiffTruncated = proposedDiffLines.length > MAX_VISIBLE_LINES;

    return (
      <>
        <div className={`edit-result edit-result-${classSuffix}`}>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
          <span className={`badge badge-${classSuffix}`}>
            {isRejection
              ? classification.label
              : `Edit ${classification.label.toLowerCase()}`}
          </span>
          {classification.userReason ? (
            <div className="edit-error-message">
              {classification.userReason}
            </div>
          ) : classification.cleanedMessage && !isRejection ? (
            <div className="edit-error-message">
              {classification.cleanedMessage}
            </div>
          ) : null}
          {hasProposedDiff && (
            <div
              className={`diff-view-container ${proposedDiffTruncated ? "truncated" : ""}`}
            >
              <div className="diff-view">
                {inputWithAugment?._diffHtml ? (
                  <HighlightedDiff
                    diffHtml={inputWithAugment._diffHtml}
                    truncateLines={
                      proposedDiffTruncated ? MAX_VISIBLE_LINES : undefined
                    }
                  />
                ) : (
                  <DiffLines lines={proposedDiffLines} />
                )}
              </div>
              {proposedDiffTruncated && (
                <>
                  <div className="diff-fade-overlay" />
                  <DiffExpandButton
                    label="Show full diff"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowModal(true);
                    }}
                  />
                </>
              )}
            </div>
          )}
        </div>
        {showModal && hasProposedDiff && inputWithAugment && (
          <DetailPanel
            title={<span className="file-path">{fileName}</span>}
            onClose={() => setShowModal(false)}
          >
            <DiffModalContent
              diffHtml={inputWithAugment._diffHtml}
              structuredPatch={structuredPatch}
              filePath={filePath}
              oldString={oldString}
              newString={newString}
            />
          </DetailPanel>
        )}
      </>
    );
  }

  // Handle case where result doesn't have structuredPatch
  // Use input data as fallback when result data is missing
  if (structuredPatch.length === 0) {
    if (rawPatch) {
      const rawPatchPreview = truncateByLines(rawPatch, MAX_VISIBLE_LINES);
      return (
        <>
          <div className="edit-result">
            <div className="edit-header">
              <span className="file-path">
                {filePath ? getFileName(filePath) : "Patch"}
              </span>
              {showValidationWarning && validationErrors && (
                <SchemaWarning toolName="Edit" errors={validationErrors} />
              )}
            </div>
            <RawPatchPreview
              rawPatch={rawPatch}
              truncateLines={MAX_VISIBLE_LINES}
            />
            {rawPatchPreview.truncated && (
              <DiffExpandButton
                label="Show full patch"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowModal(true);
                }}
              />
            )}
          </div>
          {showModal && (
            <DetailPanel
              title={<span className="file-path">{fileName}</span>}
              onClose={() => setShowModal(false)}
            >
              <RawPatchModalContent rawPatch={rawPatch} />
            </DetailPanel>
          )}
        </>
      );
    }

    const isPlan = filePath ? isPlanFile(filePath) : false;

    return (
      <div className="edit-result">
        <div className="edit-header">
          <span className="file-path">
            {filePath ? getFileName(filePath) : "File"}
          </span>
          {isPlan && <span className="badge badge-muted">Plan</span>}
          {result?.userModified && (
            <span className="badge badge-info">User modified</span>
          )}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
        </div>
        <div className="edit-simple">
          <div className="edit-old">
            <div className="edit-label">Removed:</div>
            <pre className="code-block">
              <code>{oldString || "(empty)"}</code>
            </pre>
          </div>
          <div className="edit-new">
            <div className="edit-label">Added:</div>
            <pre className="code-block">
              <code>{newString || "(empty)"}</code>
            </pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="edit-result">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
        {changeSummary && (
          <div className="edit-change-summary">{changeSummary}</div>
        )}
        {result.userModified && (
          <span className="badge badge-info">User modified</span>
        )}
        <div
          className={`diff-view-container ${isTruncated ? "truncated" : ""}`}
        >
          <div className="diff-view">
            {structuredPatch.map((hunk, i) => (
              <DiffHunk key={`hunk-${hunk.oldStart}-${i}`} hunk={hunk} />
            ))}
          </div>
          {isTruncated && (
            <>
              <div className="diff-fade-overlay" />
              <DiffExpandButton
                label="Click to expand"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowModal(true);
                }}
              />
            </>
          )}
        </div>
      </div>
      {showModal && (
        <DetailPanel
          title={<span className="file-path">{fileName}</span>}
          onClose={() => setShowModal(false)}
        >
          <DiffModalContent
            structuredPatch={structuredPatch}
            filePath={filePath}
            oldString={oldString ?? ""}
            newString={newString ?? ""}
            originalFile={originalFile}
          />
        </DetailPanel>
      )}
    </>
  );
}

export const editRenderer: ToolRenderer<EditInput, EditResult> = {
  tool: "Edit",

  renderToolUse(input) {
    return <EditToolUse input={input as EditInputWithAugment} />;
  },

  renderToolResult(result, isError, _context, input) {
    return (
      <EditToolResult
        result={result as EditResult}
        input={input as EditInput | undefined}
        isError={isError}
      />
    );
  },

  getUseSummary(input) {
    return getFileName(getEditFilePath(input as EditInputWithAugment));
  },

  getResultSummary(result, isError) {
    if (isError) {
      // Extract error message for classification
      let errorMessage: string | null = null;
      if (typeof result === "string") {
        errorMessage = result;
      } else if (typeof result === "object" && result !== null) {
        const errorResult = result as { content?: unknown };
        if (errorResult.content) {
          errorMessage = String(errorResult.content);
        }
      }
      if (errorMessage) {
        const classification = classifyToolError(errorMessage);
        return classification.label;
      }
      return "Error";
    }
    const r = result as EditResult;
    return r?.filePath ? getFileName(r.filePath) : "file";
  },

  renderCollapsedPreview(input, result, isError) {
    return (
      <EditCollapsedPreview
        input={input as EditInputWithAugment}
        result={result as EditResult | undefined}
        isError={isError}
      />
    );
  },

  renderInteractiveSummary(input, result, isError, _context) {
    return (
      <EditInteractiveSummary
        input={input as EditInputWithAugment}
        result={result as EditResult | undefined}
        isError={isError}
      />
    );
  },
};
