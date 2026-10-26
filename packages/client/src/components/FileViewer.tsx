import {
  type FileLocateCandidate,
  type FilePreviewResponse,
  getPathBasename,
} from "@yep-anywhere/shared";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ApiError, api } from "../api/client";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { useI18n } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";
import { delimiterForPath, parseDelimitedText } from "../lib/delimitedText";
import {
  type FileRef,
  type FileSnapshot,
  extractFileLinkTarget,
  filePageUrl,
  fileRawUrl,
  fileRefFromPath,
} from "../lib/fileRef";
import { OfficeView } from "./OfficeView";

interface FileViewerProps {
  fileRef: FileRef;
  /** What a tool saw when it read the file; offered next to the current file. */
  snapshot?: FileSnapshot;
  onClose?: () => void;
  /** If true, renders as standalone page layout instead of panel content */
  standalone?: boolean;
  /** Open another file from a link inside this preview (e.g. markdown). */
  onNavigate?: (ref: FileRef) => void;
}

type CopyFeedback = "copied" | "failed" | null;
type ViewSource = "current" | "snapshot";

function FileViewerCopyAction({
  value,
  label,
  copiedLabel,
  failedLabel,
  kind,
}: {
  value: string;
  label: string;
  copiedLabel: string;
  failedLabel: string;
  kind: "title" | "path" | "content";
}) {
  const [feedback, setFeedback] = useState<CopyFeedback>(null);

  useEffect(() => {
    if (!feedback) return;
    const handle = setTimeout(() => setFeedback(null), 2000);
    return () => clearTimeout(handle);
  }, [feedback]);

  const handleCopy = useCallback(async () => {
    try {
      await writeClipboardText(value);
      setFeedback("copied");
    } catch (err) {
      console.error(`Failed to copy file ${kind}:`, err);
      setFeedback("failed");
    }
  }, [kind, value]);

  const feedbackLabel =
    feedback === "copied"
      ? copiedLabel
      : feedback === "failed"
        ? failedLabel
        : label;

  return (
    <button
      type="button"
      className={`file-viewer-action${
        feedback === "copied"
          ? " copied"
          : feedback === "failed"
            ? " copy-failed"
            : ""
      }`}
      onClick={handleCopy}
      aria-label={feedbackLabel}
      aria-live="polite"
      title={feedbackLabel}
    >
      {feedback === "copied" ? (
        <CheckIcon />
      ) : feedback === "failed" ? (
        <CopyFailedIcon />
      ) : kind === "title" ? (
        <CopyTitleIcon />
      ) : kind === "path" ? (
        <CopyPathIcon />
      ) : (
        <CopyIcon />
      )}
    </button>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFilePathParts(filePath: string): {
  fileName: string;
  directory?: string;
} {
  const separatorIndex = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  if (separatorIndex < 0) {
    return { fileName: filePath };
  }

  return {
    fileName: filePath.slice(separatorIndex + 1) || filePath,
    directory:
      separatorIndex === 0 ? filePath[0] : filePath.slice(0, separatorIndex),
  };
}

/** Show project files relative to the session's project root. */
function compactDisplayPath(
  path: string,
  projectPath: string | null | undefined,
): string {
  const root = projectPath?.replace(/\/+$/, "");
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

/**
 * Start a same-document download instead of opening a popup. Android WebView
 * does not implement browser-style popup downloads, but a normal download
 * navigation is handed to its native DownloadListener.
 */
function startFileDownload(url: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
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

function FileViewerHeaderInfo({
  displayPath,
  compactPath,
  meta,
}: {
  displayPath: string;
  compactPath?: string;
  meta?: string;
}) {
  const { fileName, directory } = getFilePathParts(compactPath ?? displayPath);

  return (
    <div className="file-viewer-info">
      <span className="file-viewer-name" title={displayPath}>
        {fileName}
      </span>
      {(directory || meta) && (
        <span className="file-viewer-subtitle">
          {directory && (
            <span className="file-viewer-directory" title={directory}>
              {directory}
            </span>
          )}
          {directory && meta && (
            <span className="file-viewer-meta-separator" aria-hidden="true">
              •
            </span>
          )}
          {meta && <span className="file-viewer-meta">{meta}</span>}
        </span>
      )}
    </div>
  );
}

function CloseAction({
  onClose,
  label,
}: { onClose: () => void; label: string }) {
  return (
    <button
      type="button"
      className="file-viewer-action file-viewer-close"
      onClick={onClose}
      title={label}
      aria-label={label}
    >
      <CloseIcon />
    </button>
  );
}

interface TextViewProps {
  content: string;
  /** Number of the first line in `content` (1 for whole files). */
  startLine: number;
  highlightedHtml?: string;
  highlightedLanguage?: string;
  highlightedTruncated?: boolean;
  renderedMarkdownHtml?: string;
  lineNumber?: number;
  lineEnd?: number;
  onLinkClick?: (event: React.MouseEvent) => void;
  /** CSV/TSV files offer a table view. */
  tableDelimiter?: "," | "\t" | null;
}

type TextMode = "source" | "preview" | "table";

function DelimitedTableView({
  content,
  delimiter,
}: {
  content: string;
  delimiter: "," | "\t";
}) {
  const { t } = useI18n();
  const table = useMemo(
    () => parseDelimitedText(content, delimiter),
    [content, delimiter],
  );
  const [header, ...body] = table.rows;
  return (
    <div className="file-viewer-table">
      <table>
        {header && (
          <thead>
            <tr>
              {header.map((cell, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <th key={index}>{cell}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <td key={index}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.truncated && (
        <div className="file-viewer-truncated">
          {t("fileViewerTableTruncated" as never, { count: table.rows.length })}
        </div>
      )}
    </div>
  );
}

/** Text body: shiki or plain lines, line targeting, md preview, CSV table. */
function TextView({
  content,
  startLine,
  highlightedHtml,
  highlightedLanguage,
  highlightedTruncated,
  renderedMarkdownHtml,
  lineNumber,
  lineEnd,
  onLinkClick,
  tableDelimiter,
}: TextViewProps) {
  const { t } = useI18n();
  const hasTarget = lineNumber !== undefined;
  const modes: TextMode[] = [
    "source",
    ...(renderedMarkdownHtml ? (["preview"] as const) : []),
    ...(tableDelimiter ? (["table"] as const) : []),
  ];
  const [mode, setMode] = useState<TextMode>(
    hasTarget ? "source" : (modes[modes.length - 1] ?? "source"),
  );
  const showPreview = mode !== "source";
  const codeRef = useRef<HTMLDivElement>(null);
  const highlightStart = lineNumber ?? 0;
  const highlightEnd = lineEnd ?? highlightStart;

  // Mark and reveal the targeted lines in either rendering.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the rendered body changes
  useLayoutEffect(() => {
    const root = codeRef.current;
    if (!root || !hasTarget || showPreview) return;
    const lines = root.querySelectorAll<HTMLElement>(
      highlightedHtml ? ".shiki-container .line" : ".code-content [data-line]",
    );
    let first: HTMLElement | null = null;
    lines.forEach((line, index) => {
      const number = startLine + index;
      const marked = number >= highlightStart && number <= highlightEnd;
      line.classList.toggle("highlighted-line", marked);
      if (marked && !first) first = line;
    });
    const target = first as HTMLElement | null;
    if (target && typeof target.scrollIntoView === "function") {
      requestAnimationFrame(() =>
        target.scrollIntoView({ behavior: "smooth", block: "center" }),
      );
    }
  }, [content, highlightedHtml, showPreview, highlightStart, highlightEnd]);

  const modeLabels: Record<TextMode, string> = {
    source: t("fileViewerSource" as never),
    preview: t("fileViewerPreview" as never),
    table: t("fileViewerTable" as never),
  };
  const toggle =
    modes.length > 1 ? (
      <div className="markdown-view-toggle">
        {modes.map((item) => (
          <button
            key={item}
            type="button"
            className={`toggle-btn ${mode === item ? "active" : ""}`}
            onClick={() => setMode(item)}
          >
            {modeLabels[item]}
          </button>
        ))}
      </div>
    ) : null;

  if (mode === "table" && tableDelimiter) {
    return (
      <>
        {toggle}
        <DelimitedTableView content={content} delimiter={tableDelimiter} />
      </>
    );
  }

  if (mode === "preview" && renderedMarkdownHtml) {
    return (
      <>
        {toggle}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: intercepts file links inside the rendered document */}
        <div className="markdown-preview" onClick={onLinkClick}>
          <div
            className="markdown-rendered"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered sanitized HTML
            dangerouslySetInnerHTML={{ __html: renderedMarkdownHtml }}
          />
        </div>
      </>
    );
  }

  if (highlightedHtml) {
    return (
      <>
        {toggle}
        <div
          ref={codeRef}
          className="file-viewer-code file-viewer-code-highlighted"
          data-language={highlightedLanguage}
        >
          <div
            className="shiki-container"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
          {highlightedTruncated && (
            <div className="file-viewer-truncated">
              {t("fileViewerHighlightTruncated" as never)}
            </div>
          )}
        </div>
      </>
    );
  }

  const lines = content.split("\n");
  return (
    <>
      {toggle}
      <div ref={codeRef} className="file-viewer-code">
        <div className="code-highlighter-plain">
          <div className="code-line-numbers">
            {lines.map((_, i) => (
              <div key={`ln-${startLine + i}`}>{startLine + i}</div>
            ))}
          </div>
          <pre className="code-content">
            <code>
              {lines.map((line, i) => (
                <div key={`line-${startLine + i}`} data-line={startLine + i}>
                  {line || " "}
                </div>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </>
  );
}

function SnapshotView({
  snapshot,
  fileRef,
  alt,
}: {
  snapshot: FileSnapshot;
  fileRef: FileRef;
  alt: string;
}) {
  if (snapshot.kind === "image") {
    return (
      <div className="file-viewer-image">
        <img src={snapshot.src} alt={alt} />
      </div>
    );
  }
  return (
    <>
      {(snapshot.startLine > 1 ||
        (snapshot.totalLines !== undefined &&
          snapshot.content.split("\n").length < snapshot.totalLines)) && (
        <SnapshotRangeNotice snapshot={snapshot} />
      )}
      <TextView
        content={snapshot.content}
        startLine={snapshot.startLine}
        highlightedHtml={snapshot.highlightedHtml}
        highlightedTruncated={snapshot.highlightedTruncated}
        renderedMarkdownHtml={snapshot.renderedMarkdownHtml}
        lineNumber={fileRef.lineNumber}
        lineEnd={fileRef.lineEnd}
        tableDelimiter={delimiterForPath(fileRef.path)}
      />
    </>
  );
}

function SnapshotRangeNotice({
  snapshot,
}: {
  snapshot: Extract<FileSnapshot, { kind: "text" }>;
}) {
  const { t } = useI18n();
  const count = snapshot.content.split("\n").length;
  return (
    <div className="file-content-range-notice">
      {t("fileViewerSnapshotRange" as never, {
        start: snapshot.startLine,
        end: snapshot.startLine + count - 1,
        total: snapshot.totalLines ?? snapshot.startLine + count - 1,
      })}
    </div>
  );
}

type LocateState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; candidates: FileLocateCandidate[] }
  | { status: "failed"; message: string };

/**
 * A relative path that is not in the directory it was resolved against
 * (usually the session's project). Explains that, and on request looks the
 * same relative path up in the other local projects.
 */
function RelativePathMiss({
  fileRef,
  relative,
  onOpen,
}: {
  fileRef: FileRef;
  relative: NonNullable<FileRef["relative"]>;
  onOpen: (ref: FileRef) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<LocateState>({ status: "idle" });
  const baseName = getPathBasename(relative.baseDir) || relative.baseDir;

  const search = () => {
    setState({ status: "loading" });
    api
      .locateFile(relative.path)
      .then(({ candidates }) =>
        setState({
          status: "done",
          candidates: candidates.filter(
            (candidate) => candidate.absolutePath !== fileRef.path,
          ),
        }),
      )
      .catch((err: unknown) =>
        setState({
          status: "failed",
          message:
            err instanceof Error && err.message
              ? err.message
              : t("fileViewerLoadFailed" as never),
        }),
      );
  };

  return (
    <div className="file-viewer-relative-miss">
      <p>
        {t("fileViewerRelativeMiss" as never, {
          path: relative.path,
          project: baseName,
        })}
      </p>
      {state.status === "idle" && (
        <button
          type="button"
          className="file-viewer-download-btn"
          onClick={search}
        >
          {t("fileViewerSearchOtherProjects" as never)}
        </button>
      )}
      {state.status === "loading" && (
        <p>{t("fileViewerSearchingOtherProjects" as never)}</p>
      )}
      {state.status === "failed" && (
        <p className="file-viewer-relative-miss-error">{state.message}</p>
      )}
      {state.status === "done" &&
        (state.candidates.length === 0 ? (
          <p>{t("fileViewerNoOtherProjectMatch" as never)}</p>
        ) : (
          <ul className="file-viewer-candidates">
            {state.candidates.map((candidate) => (
              <li key={candidate.absolutePath}>
                <button
                  type="button"
                  className="file-viewer-candidate"
                  title={candidate.absolutePath}
                  onClick={() =>
                    onOpen({
                      path: candidate.absolutePath,
                      lineNumber: fileRef.lineNumber,
                      lineEnd: fileRef.lineEnd,
                    })
                  }
                >
                  <span className="file-viewer-candidate-project">
                    {candidate.projectName}
                  </span>
                  <span className="file-viewer-candidate-path">
                    {candidate.projectPath}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/**
 * FileViewer - the single file preview surface. Loads any readable file via
 * `/api/fs/preview` and renders it by kind (text, markdown, image, video,
 * audio, pdf, other).
 */
export const FileViewer = memo(function FileViewer({
  fileRef,
  snapshot,
  onClose,
  standalone = false,
  onNavigate,
}: FileViewerProps) {
  const { t } = useI18n();
  const sessionMetadata = useOptionalSessionMetadata();
  const [fileData, setFileData] = useState<FilePreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorFilePath, setErrorFilePath] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [source, setSource] = useState<ViewSource>("current");
  const { path, projectId } = fileRef;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setErrorFilePath(null);
    setNotFound(false);
    setFileData(null);
    setSource("current");

    api
      .getFilePreview({ path, projectId }, true)
      .then((data) => {
        if (!cancelled) {
          setFileData(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || t("fileViewerLoadFailed" as never));
          setErrorFilePath(getErrorFilePath(err, path));
          setNotFound((err as Partial<ApiError>)?.status === 404);
          setLoading(false);
          // A tool snapshot is still worth showing when the file is gone.
          setSource("snapshot");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path, projectId, t]);

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

  const fileName = getPathBasename(path) || path;
  const handleDownload = useCallback(() => {
    startFileDownload(fileRawUrl({ path, projectId }, true), fileName);
  }, [path, projectId, fileName]);
  const handleOpenInNewTab = useCallback(() => {
    window.open(filePageUrl(fileRef), "_blank");
  }, [fileRef]);

  const handleLinkClick = useCallback(
    (event: React.MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest?.(
        "a.local-file-link, a.local-media-link",
      ) as HTMLAnchorElement | null;
      if (!anchor) return;
      const target = extractFileLinkTarget(anchor);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const next = fileRefFromPath(
        target.path,
        { projectId, projectPath: null },
        { lineNumber: target.lineNumber },
      );
      if (onNavigate) onNavigate(next);
      else window.open(filePageUrl(next), "_blank");
    },
    [onNavigate, projectId],
  );

  const showingSnapshot = !!snapshot && source === "snapshot";
  const displayPath = fileData?.metadata.absolutePath ?? path;
  const compactPath = compactDisplayPath(
    displayPath,
    sessionMetadata?.projectPath,
  );
  const textContent = showingSnapshot
    ? snapshot.kind === "text"
      ? snapshot.content
      : undefined
    : fileData?.content;

  const fileMeta = fileData
    ? [
        formatFileSize(fileData.metadata.size),
        fileData.content !== undefined
          ? t("fileViewerLines" as never, {
              count: fileData.content.split("\n").length,
            })
          : null,
      ]
        .filter((item): item is string => item !== null)
        .join(" • ")
    : undefined;

  const sourceToggle = snapshot ? (
    <div className="markdown-view-toggle file-viewer-source-toggle">
      <button
        type="button"
        className={`toggle-btn ${source === "current" ? "active" : ""}`}
        onClick={() => setSource("current")}
      >
        {t("fileViewerCurrentFile" as never)}
      </button>
      <button
        type="button"
        className={`toggle-btn ${source === "snapshot" ? "active" : ""}`}
        onClick={() => setSource("snapshot")}
      >
        {t("fileViewerToolSnapshot" as never)}
      </button>
    </div>
  ) : null;

  const renderCurrent = () => {
    if (loading) {
      return (
        <div className="file-viewer-loading">
          {t("fileViewerLoading" as never, { name: fileName })}
        </div>
      );
    }
    if (error || !fileData) {
      return (
        <div className="file-viewer-error">
          <div className="file-viewer-error-content">
            <div>{error || t("fileViewerNotFound" as never)}</div>
            {errorFilePath && (
              <div className="file-viewer-error-path">
                <span>{t("fileViewerAttemptedPath" as never)}</span>
                <code>{errorFilePath}</code>
              </div>
            )}
            {notFound && fileRef.relative && (
              <RelativePathMiss
                fileRef={fileRef}
                relative={fileRef.relative}
                onOpen={(next) =>
                  onNavigate
                    ? onNavigate(next)
                    : window.open(filePageUrl(next), "_blank")
                }
              />
            )}
          </div>
        </div>
      );
    }

    const rawUrl = fileRawUrl({ path, projectId });
    switch (fileData.kind) {
      case "image":
        return (
          <div className="file-viewer-image">
            <img src={rawUrl} alt={fileName} />
          </div>
        );
      case "video":
        return (
          <div className="file-viewer-image">
            {/* biome-ignore lint/a11y/useMediaCaption: local files have no captions */}
            <video className="file-viewer-media" controls src={rawUrl} />
          </div>
        );
      case "audio":
        return (
          <div className="file-viewer-image">
            {/* biome-ignore lint/a11y/useMediaCaption: local files have no captions */}
            <audio className="file-viewer-audio" controls src={rawUrl} />
          </div>
        );
      case "pdf":
        return (
          <iframe className="file-viewer-pdf" src={rawUrl} title={fileName} />
        );
    }

    if (fileData.office) {
      return <OfficeView document={fileData.office} />;
    }

    if (fileData.content !== undefined) {
      return (
        <TextView
          content={fileData.content}
          startLine={1}
          highlightedHtml={fileData.highlightedHtml}
          highlightedLanguage={fileData.highlightedLanguage}
          highlightedTruncated={fileData.highlightedTruncated}
          renderedMarkdownHtml={fileData.renderedMarkdownHtml}
          lineNumber={fileRef.lineNumber ?? fileData.lineNumber}
          lineEnd={fileRef.lineEnd}
          onLinkClick={handleLinkClick}
          tableDelimiter={delimiterForPath(path)}
        />
      );
    }

    return (
      <div className="file-viewer-binary">
        <p>
          {fileData.officeError
            ? t("fileViewerOfficeFailed" as never, {
                reason: fileData.officeError,
              })
            : t("fileViewerBinary" as never)}
        </p>
        <p>
          <strong>{t("fileViewerType" as never)}</strong>{" "}
          {fileData.metadata.mimeType}
        </p>
        <p>
          <strong>{t("fileViewerSize" as never)}</strong>{" "}
          {formatFileSize(fileData.metadata.size)}
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

  const header = (
    <div className="file-viewer-header">
      <FileViewerHeaderInfo
        displayPath={displayPath}
        compactPath={compactPath}
        meta={showingSnapshot ? undefined : fileMeta}
      />
      <div className="file-viewer-actions">
        <FileViewerCopyAction
          value={fileName}
          label={t("fileViewerCopyTitle" as never)}
          copiedLabel={t("fileViewerTitleCopied" as never)}
          failedLabel={t("fileViewerTitleCopyFailed" as never)}
          kind="title"
        />
        <FileViewerCopyAction
          value={displayPath}
          label={t("fileViewerCopyPath" as never)}
          copiedLabel={t("fileViewerPathCopied" as never)}
          failedLabel={t("fileViewerPathCopyFailed" as never)}
          kind="path"
        />
        {textContent !== undefined && (
          <FileViewerCopyAction
            value={textContent}
            label={t("fileViewerCopyFullText" as never)}
            copiedLabel={t("fileViewerFullTextCopied" as never)}
            failedLabel={t("fileViewerFullTextCopyFailed" as never)}
            kind="content"
          />
        )}
        {!standalone && (
          <button
            type="button"
            className="file-viewer-action"
            onClick={handleOpenInNewTab}
            title={t("fileViewerOpenNewTab" as never)}
            aria-label={t("fileViewerOpenNewTab" as never)}
          >
            <ExternalLinkIcon />
          </button>
        )}
        {fileData && (
          <button
            type="button"
            className="file-viewer-action"
            onClick={handleDownload}
            title={t("fileViewerDownload" as never)}
            aria-label={t("fileViewerDownload" as never)}
          >
            <DownloadIcon />
          </button>
        )}
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
        {onClose && <CloseAction onClose={onClose} label={t("modalClose")} />}
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
      <div className="file-viewer-body">
        {sourceToggle}
        {showingSnapshot && error && (
          <div className="file-content-range-notice">
            {t("fileViewerSnapshotFallback" as never)}
          </div>
        )}
        {showingSnapshot ? (
          <SnapshotView snapshot={snapshot} fileRef={fileRef} alt={fileName} />
        ) : (
          renderCurrent()
        )}
      </div>
    </div>
  );
});

// Icons
function CopyTitleIcon() {
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
      <path d="M7.25 8h4.5M9.5 8v3.75" />
    </svg>
  );
}

function CopyPathIcon() {
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
      <path d="M11.25 7.75 8.25 12.25" />
    </svg>
  );
}

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

function CopyFailedIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
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
