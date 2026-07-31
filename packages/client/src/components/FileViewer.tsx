import type { FileContentResponse } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "../api/client";
import { useI18n } from "../i18n";

interface FileViewerProps {
  projectId: string;
  filePath: string;
  onClose?: () => void;
  /** If true, renders as standalone page layout instead of modal content */
  standalone?: boolean;
  /** Line number to scroll to and highlight (1-indexed) */
  lineNumber?: number;
  /** End line for range highlighting (1-indexed). If not provided, only lineNumber is highlighted. */
  lineEnd?: number;
}

/**
 * Format file size for display.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get language hint from file extension for potential future syntax highlighting.
 */
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    php: "php",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    md: "markdown",
    markdown: "markdown",
  };
  return langMap[ext] || "plaintext";
}

/**
 * Check if file is markdown.
 */
function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

/**
 * Get filename from path.
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function getErrorFilePath(err: unknown, fallbackPath: string): string | null {
  const apiError = err as Partial<ApiError> | null;
  if (typeof apiError?.absolutePath === "string") {
    return apiError.absolutePath;
  }
  if (typeof apiError?.path === "string" && apiError.path.startsWith("/")) {
    return apiError.path;
  }
  return fallbackPath.startsWith("/") ? fallbackPath : null;
}

function extOf(filePath: string): string {
  const base = filePath.split("/").pop() || filePath;
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** What kind of inline preview (if any) this file supports. */
type PreviewKind = "image" | "pdf" | "docx" | "spreadsheet" | "csv" | "binary";

function getPreviewKind(filePath: string, mimeType: string): PreviewKind {
  const ext = extOf(filePath);
  if (mimeType.startsWith("image/")) return "image";
  if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xls") return "spreadsheet";
  if (ext === "csv" || ext === "tsv") return "csv";
  return "binary";
}

/** Cap on raw bytes we parse in the browser to keep the UI responsive. */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
/** Max rows rendered per sheet (remaining rows are dropped with a notice). */
const MAX_SHEET_ROWS = 1000;
/** Max rows rendered for CSV previews. */
const MAX_CSV_ROWS = 5000;

interface SheetView {
  name: string;
  rows: (string | number)[][];
  totalRows: number;
  truncated: boolean;
}

interface ParsedPreview {
  kind: "spreadsheet" | "csv";
  sheets: SheetView[];
  truncated: boolean;
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

async function parseSpreadsheet(buffer: ArrayBuffer): Promise<ParsedPreview> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(new Uint8Array(buffer), {
    type: "array",
    cellDates: true,
  });
  const sheets: SheetView[] = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws) {
      return { name, rows: [], totalRows: 0, truncated: false };
    }
    const json = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      defval: "",
      raw: false,
      blankrows: false,
    });
    const allRows = json as (string | number)[][];
    const truncated = allRows.length > MAX_SHEET_ROWS;
    return {
      name,
      rows: allRows.slice(0, MAX_SHEET_ROWS),
      totalRows: allRows.length,
      truncated,
    };
  });
  return {
    kind: "spreadsheet",
    sheets,
    truncated: sheets.some((s) => s.truncated),
  };
}

async function parseCsv(
  buffer: ArrayBuffer,
  delimiter: string,
): Promise<ParsedPreview> {
  const text = new TextDecoder("utf-8").decode(new Uint8Array(buffer));
  const Papa = (await import("papaparse")).default;
  const result = Papa.parse<unknown[]>(text, {
    delimiter,
    skipEmptyLines: false,
  });
  const allRows = result.data as (string | number)[][];
  const truncated = allRows.length > MAX_CSV_ROWS;
  return {
    kind: "csv",
    sheets: [
      {
        name: "CSV",
        rows: allRows.slice(0, MAX_CSV_ROWS),
        totalRows: allRows.length,
        truncated,
      },
    ],
    truncated,
  };
}

/**
 * FileViewer component - displays file content with appropriate formatting.
 */
export const FileViewer = memo(function FileViewer({
  projectId,
  filePath,
  onClose,
  standalone = false,
  lineNumber,
  lineEnd,
}: FileViewerProps) {
  const { t } = useI18n();
  const [fileData, setFileData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorFilePath, setErrorFilePath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [highlightedLineRef, setHighlightedLineRef] =
    useState<HTMLElement | null>(null);

  // Office / tabular preview state
  const [parsed, setParsed] = useState<ParsedPreview | null>(null);
  const [rawBytes, setRawBytes] = useState<ArrayBuffer | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const docxRef = useRef<HTMLDivElement>(null);

  // Correct, BASE_PATH-aware URL for binary/inline content (fixes broken
  // images/PDF under sub-path deployments and the desktop shell).
  const rawUrl = api.getFileRawUrl(projectId, filePath);
  const previewKind: PreviewKind = fileData
    ? getPreviewKind(filePath, fileData.metadata.mimeType)
    : "binary";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setErrorFilePath(null);

    // Request highlighting for code files
    api
      .getFile(projectId, filePath, true)
      .then((data) => {
        if (!cancelled) {
          setFileData(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || t("fileViewerLoadFailed" as never));
          setErrorFilePath(getErrorFilePath(err, filePath));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, filePath, t]);

  // Fetch + parse office/tabular formats in the browser.
  useEffect(() => {
    if (!fileData) return;
    setParsed(null);
    setRawBytes(null);
    setPreviewError(null);
    setPreviewLoading(false);

    const k = getPreviewKind(filePath, fileData.metadata.mimeType);
    if (k === "image" || k === "pdf" || k === "binary") return;

    if (fileData.metadata.size > MAX_PREVIEW_BYTES) {
      setPreviewError("too-large");
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);
    fetchBytes(rawUrl)
      .then(async (buf) => {
        if (cancelled) return;
        if (k === "docx") {
          setRawBytes(buf);
          setPreviewLoading(false);
        } else if (k === "spreadsheet") {
          const p = await parseSpreadsheet(buf);
          if (!cancelled) {
            setParsed(p);
            setPreviewLoading(false);
          }
        } else if (k === "csv") {
          const p = await parseCsv(buf, extOf(filePath) === "tsv" ? "\t" : ",");
          if (!cancelled) {
            setParsed(p);
            setPreviewLoading(false);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPreviewError(
            err instanceof Error ? err.message : "preview-failed",
          );
          setPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, fileData, rawUrl]);

  // Render DOCX once bytes are ready.
  useEffect(() => {
    if (previewKind !== "docx" || !docxRef.current || !rawBytes) return;
    let cancelled = false;
    setPreviewLoading(true);
    void (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled || !docxRef.current) return;
        docxRef.current.innerHTML = "";
        await renderAsync(new Blob([rawBytes]), docxRef.current);
        if (!cancelled) setPreviewLoading(false);
      } catch (err) {
        if (!cancelled) {
          setPreviewError(err instanceof Error ? err.message : "docx-failed");
          setPreviewLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewKind, rawBytes]);

  // Handle Escape key to exit fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fullscreen]);

  // Scroll to highlighted line when it's rendered
  useEffect(() => {
    if (highlightedLineRef) {
      // Small delay to ensure layout is complete
      requestAnimationFrame(() => {
        highlightedLineRef.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      });
    }
  }, [highlightedLineRef]);

  const handleCopy = useCallback(async () => {
    if (!fileData?.content) return;
    try {
      await navigator.clipboard.writeText(fileData.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [fileData?.content]);

  const handleDownload = useCallback(() => {
    const url = api.getFileRawUrl(projectId, filePath, true);
    window.open(url, "_blank");
  }, [projectId, filePath]);

  const handleOpenInNewTab = useCallback(() => {
    const url = `${window.location.origin}/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`;
    window.open(url, "_blank");
  }, [projectId, filePath]);

  const fileName = getFileName(filePath);
  const language = getLanguageFromPath(filePath);

  // Render loading state
  if (loading) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-loading">
          {t("fileViewerLoading" as never, { name: fileName })}
        </div>
      </div>
    );
  }

  // Render error state
  if (error || !fileData) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-error">
          <div className="file-viewer-error-content">
            <div>{error || t("fileViewerNotFound" as never)}</div>
            {errorFilePath && (
              <div className="file-viewer-error-path">
                <span>{t("fileViewerAttemptedPath" as never)}</span>
                <code>{errorFilePath}</code>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const { metadata, content } = fileData;
  const displayPath = metadata.absolutePath ?? filePath;

  // Render content based on file type
  const renderContent = () => {
    // Image files
    if (previewKind === "image") {
      return (
        <div className="file-viewer-image">
          <img src={rawUrl} alt={fileName} />
        </div>
      );
    }

    // PDF files (native browser rendering, zero dependencies)
    if (previewKind === "pdf") {
      return (
        <div className="file-viewer-pdf">
          <iframe src={rawUrl} title={fileName} />
        </div>
      );
    }

    // DOCX files (rendered from bytes via docx-preview)
    if (previewKind === "docx") {
      if (previewError === "too-large")
        return <LargeFileNotice onDownload={handleDownload} />;
      if (previewError)
        return <PreviewErrorNotice onDownload={handleDownload} />;
      return (
        <div className="file-viewer-docx">
          <div ref={docxRef} className="docx-body" />
          {previewLoading && (
            <div className="file-viewer-loading-inline">
              {t("fileViewerParsing" as never)}
            </div>
          )}
        </div>
      );
    }

    // Spreadsheet (xlsx/xls) and CSV/TSV files
    if (previewKind === "spreadsheet" || previewKind === "csv") {
      if (previewError === "too-large")
        return <LargeFileNotice onDownload={handleDownload} />;
      if (previewError)
        return <PreviewErrorNotice onDownload={handleDownload} />;
      if (previewLoading || !parsed) {
        return (
          <div className="file-viewer-loading-inline">
            {t("fileViewerParsing" as never)}
          </div>
        );
      }
      return <TablePreview data={parsed} />;
    }

    // Text files
    if (content !== undefined) {
      const isMarkdown = isMarkdownFile(filePath);
      const hasMarkdownPreview = isMarkdown && !!fileData.renderedMarkdownHtml;

      // Toggle button for markdown files
      const toggleButton = hasMarkdownPreview && (
        <div className="markdown-view-toggle">
          <button
            type="button"
            className={`toggle-btn ${!showPreview ? "active" : ""}`}
            onClick={() => setShowPreview(false)}
          >
            {t("fileViewerSource" as never)}
          </button>
          <button
            type="button"
            className={`toggle-btn ${showPreview ? "active" : ""}`}
            onClick={() => setShowPreview(true)}
          >
            {t("fileViewerPreview" as never)}
          </button>
        </div>
      );

      // Show rendered markdown preview
      if (showPreview && fileData.renderedMarkdownHtml) {
        return (
          <>
            {toggleButton}
            <div className="markdown-preview">
              <div
                className="markdown-rendered"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
                dangerouslySetInnerHTML={{
                  __html: fileData.renderedMarkdownHtml,
                }}
              />
            </div>
          </>
        );
      }

      // Server-rendered syntax highlighting (preferred)
      if (fileData.highlightedHtml) {
        return (
          <>
            {toggleButton}
            <div
              className="file-viewer-code file-viewer-code-highlighted"
              data-language={fileData.highlightedLanguage ?? language}
            >
              <div
                className="shiki-container"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
                dangerouslySetInnerHTML={{ __html: fileData.highlightedHtml }}
              />
              {fileData.highlightedTruncated && (
                <div className="file-viewer-truncated">
                  {t("fileViewerHighlightTruncated" as never)}
                </div>
              )}
            </div>
          </>
        );
      }

      // Fallback: plain code (no syntax highlighting available)
      const lines = content.split("\n");
      const highlightStart = lineNumber ?? 0;
      const highlightEnd = lineEnd ?? highlightStart;

      return (
        <>
          {toggleButton}
          <div className="file-viewer-code" data-language={language}>
            <div className="code-highlighter-plain">
              <div className="code-line-numbers">
                {lines.map((_, i) => (
                  <div key={`ln-${i + 1}`}>{i + 1}</div>
                ))}
              </div>
              <pre className="code-content">
                <code>
                  {lines.map((line, i) => {
                    const num = i + 1;
                    const isHighlighted =
                      lineNumber &&
                      num >= highlightStart &&
                      num <= highlightEnd;
                    return (
                      <div
                        key={`line-${i + 1}`}
                        ref={
                          lineNumber && num === highlightStart
                            ? (el) => setHighlightedLineRef(el)
                            : undefined
                        }
                        className={
                          isHighlighted ? "highlighted-line" : undefined
                        }
                        style={
                          isHighlighted
                            ? {
                                backgroundColor: "rgba(255, 255, 0, 0.15)",
                                marginLeft: "-0.75rem",
                                marginRight: "-0.75rem",
                                paddingLeft: "0.75rem",
                                paddingRight: "0.75rem",
                              }
                            : undefined
                        }
                      >
                        {line || " "}
                      </div>
                    );
                  })}
                </code>
              </pre>
            </div>
          </div>
        </>
      );
    }

    // Binary files or unsupported formats (e.g. legacy .doc) -> download only
    return (
      <div className="file-viewer-binary">
        <p>{t("fileViewerBinary" as never)}</p>
        <p>
          <strong>{t("fileViewerType" as never)}</strong> {metadata.mimeType}
        </p>
        <p>
          <strong>{t("fileViewerSize" as never)}</strong>{" "}
          {formatFileSize(metadata.size)}
        </p>
        <button
          type="button"
          className="file-viewer-download-btn"
          onClick={handleDownload}
        >
          {t("fileViewerDownloadFile" as never)}
        </button>
      </div>
    );
  };

  // Header with file info and actions
  const header = (
    <div className="file-viewer-header">
      <div className="file-viewer-info">
        <span className="file-viewer-path" title={displayPath}>
          {displayPath}
        </span>
        <span className="file-viewer-meta">
          {formatFileSize(metadata.size)}
          {metadata.isText &&
            content &&
            ` \u2022 ${t("fileViewerLines" as never, {
              count: content.split("\n").length,
            })}`}
        </span>
      </div>
      <div className="file-viewer-actions">
        {content && (
          <button
            type="button"
            className={`file-viewer-action ${copied ? "copied" : ""}`}
            onClick={handleCopy}
            title={
              copied
                ? t("fileViewerCopied" as never)
                : t("fileViewerCopyContent" as never)
            }
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        )}
        {!standalone && (
          <button
            type="button"
            className="file-viewer-action"
            onClick={handleOpenInNewTab}
            title={t("fileViewerOpenNewTab" as never)}
          >
            <ExternalLinkIcon />
          </button>
        )}
        <button
          type="button"
          className="file-viewer-action"
          onClick={handleDownload}
          title={t("fileViewerDownload" as never)}
        >
          <DownloadIcon />
        </button>
        <button
          type="button"
          className="file-viewer-action"
          onClick={() => setFullscreen(!fullscreen)}
          title={
            fullscreen
              ? t("fileViewerExitFullscreen" as never)
              : t("fileViewerFullscreen" as never)
          }
        >
          {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
        </button>
        {onClose && (
          <button
            type="button"
            className="file-viewer-action file-viewer-close"
            onClick={onClose}
            title={t("modalClose")}
          >
            <CloseIcon />
          </button>
        )}
      </div>
    </div>
  );

  const viewerClass = [
    "file-viewer",
    standalone && "file-viewer-standalone",
    fullscreen && "file-viewer-fullscreen",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={viewerClass}>
      {header}
      <div className="file-viewer-body">{renderContent()}</div>
    </div>
  );
});

/** Shown when a previewable file exceeds the in-browser size limit. */
function LargeFileNotice({ onDownload }: { onDownload: () => void }) {
  const { t } = useI18n();
  return (
    <div className="file-viewer-binary">
      <p>{t("fileViewerTooLarge" as never)}</p>
      <button
        type="button"
        className="file-viewer-download-btn"
        onClick={onDownload}
      >
        {t("fileViewerDownloadFile" as never)}
      </button>
    </div>
  );
}

/** Shown when parsing a previewable file fails. */
function PreviewErrorNotice({ onDownload }: { onDownload: () => void }) {
  const { t } = useI18n();
  return (
    <div className="file-viewer-binary">
      <p>{t("fileViewerPreviewFailed" as never)}</p>
      <button
        type="button"
        className="file-viewer-download-btn"
        onClick={onDownload}
      >
        {t("fileViewerDownloadFile" as never)}
      </button>
    </div>
  );
}

/** Renders parsed tabular data (CSV / XLSX) as a scrollable, escaped table. */
function TablePreview({ data }: { data: ParsedPreview }) {
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  const sheet = data.sheets[active] ?? data.sheets[0];
  if (!sheet) return null;
  const maxCols = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0);

  return (
    <div className="file-viewer-table-wrap">
      {data.sheets.length > 1 && (
        <div className="sheet-tabs">
          {data.sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              className={`sheet-tab ${i === active ? "active" : ""}`}
              onClick={() => setActive(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="table-scroll">
        <table className="preview-table">
          <tbody>
            {sheet.rows.map((row, ri) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional rows in a read-only table preview
              <tr key={ri}>
                {Array.from({ length: maxCols }).map((_, ci) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional cells in a read-only table preview
                  <td key={ci}>{row[ci] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncated && (
        <div className="table-truncated-note">
          {t("fileViewerTruncatedRows" as never, {
            shown: sheet.rows.length,
            total: sheet.totalRows,
          })}
        </div>
      )}
    </div>
  );
}

// Icons
function CopyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5L6.5 12L13 4" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2v9M4 8l4 4 4-4M2 14h12" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4M9 2h5v5M6 10l8-8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" />
    </svg>
  );
}

function ExitFullscreenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 2v3H2M14 5h-3V2M11 14v-3h3M2 11h3v3" />
    </svg>
  );
}
