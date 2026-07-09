import type {
  ReportDocument,
  ReportDocumentResponse,
} from "@yep-anywhere/shared";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { useToastContext } from "../contexts/ToastContext";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { writeClipboardText } from "../lib/clipboard";
import { formatSmartTime } from "../lib/datetime";

interface HeadingItem {
  id: string;
  depth: number;
  text: string;
}

const HEADING_PATTERN = /^(#{1,4})\s+(.+?)\s*#*$/;

function parseHeadings(markdown: string): HeadingItem[] {
  const seen = new Map<string, number>();
  const headings: HeadingItem[] = [];
  let inFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = HEADING_PATTERN.exec(trimmed);
    if (!match?.[1] || !match[2]) continue;

    const text = cleanHeadingText(match[2]);
    if (!text) continue;

    const baseId = slugify(text) || `section-${headings.length + 1}`;
    const count = seen.get(baseId) ?? 0;
    seen.set(baseId, count + 1);
    headings.push({
      id: count === 0 ? baseId : `${baseId}-${count + 1}`,
      depth: match[1].length,
      text,
    });
  }

  return headings;
}

function cleanHeadingText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~#]/g, "")
    .trim();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countMarkdownLines(markdown: string): number {
  if (!markdown) return 0;
  return markdown.split(/\r?\n/).length;
}

function getDisplayPath(document: ReportDocument): string {
  return document.absolutePath || document.path;
}

function ReportsDocumentMenu({ report }: { report: ReportDocument }) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!wrapperRef.current?.contains(target)) {
        setIsOpen(false);
        triggerRef.current?.blur();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const closeMenu = () => {
    setIsOpen(false);
    triggerRef.current?.blur();
  };

  const handleCopyPath = async () => {
    closeMenu();
    try {
      await writeClipboardText(getDisplayPath(report));
      showToast(t("reportsPathCopied"), "success");
    } catch (error) {
      console.error("Failed to copy report path:", error);
      showToast(t("reportsPathCopyFailed"), "error");
    }
  };

  return (
    <div
      className={`session-menu-wrapper reports-document-menu ${
        isOpen ? "is-open" : ""
      }`}
      ref={wrapperRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className="session-menu-trigger"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsOpen((open) => !open);
        }}
        title={t("reportsDocumentOptions")}
        aria-label={t("reportsDocumentOptions")}
        aria-expanded={isOpen}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="none"
          aria-hidden="true"
        >
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {isOpen && (
        <div className="session-menu-dropdown">
          <button type="button" onClick={handleCopyPath}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {t("reportsCopyPath")}
          </button>
        </div>
      )}
    </div>
  );
}

export function ReportsPage() {
  const { t, locale } = useI18n();
  const { showToast } = useToastContext();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedPath = searchParams.get("path") || "";

  const [documents, setDocuments] = useState<ReportDocument[]>([]);
  const [rootPath, setRootPath] = useState("");
  const [filter, setFilter] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [documentData, setDocumentData] =
    useState<ReportDocumentResponse | null>(null);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [uploadingReport, setUploadingReport] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  useHideSplashOnReady(!loadingList || listError !== null);

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    setListError(null);

    api
      .getReports()
      .then((res) => {
        if (cancelled) return;
        setRootPath(res.rootPath);
        setDocuments(res.documents);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setListError(err.message || t("reportsLoadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (!loadingList && !selectedPath && documents[0]) {
      setSearchParams({ path: documents[0].path }, { replace: true });
    }
  }, [documents, loadingList, selectedPath, setSearchParams]);

  useEffect(() => {
    if (!selectedPath) {
      setDocumentData(null);
      setDocumentError(null);
      setLoadingDocument(false);
      return;
    }

    let cancelled = false;
    setLoadingDocument(true);
    setDocumentError(null);

    api
      .getReport(selectedPath)
      .then((res) => {
        if (cancelled) return;
        setDocumentData(res);
        setActiveHeadingId(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setDocumentData(null);
        setDocumentError(err.message || t("reportsDocumentLoadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoadingDocument(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPath, t]);

  const headings = useMemo(
    () => parseHeadings(documentData?.content ?? ""),
    [documentData?.content],
  );
  const renderedHtml = documentData?.renderedHtml ?? "";
  const renderedMarkup = useMemo(
    () => ({ __html: renderedHtml }),
    [renderedHtml],
  );

  useEffect(() => {
    if (!renderedHtml) return;
    const article = articleRef.current;
    if (!article) return;

    const renderedHeadings = article.querySelectorAll("h1, h2, h3, h4");
    let headingIndex = 0;
    for (const node of renderedHeadings) {
      const heading = headings[headingIndex];
      headingIndex += 1;
      if (!heading) continue;
      node.id = heading.id;
      node.classList.add("report-heading-anchor");
    }

    for (const anchor of article.querySelectorAll<HTMLAnchorElement>(
      'a[href^="http"]',
    )) {
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
    }
  }, [headings, renderedHtml]);

  const filteredDocuments = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((doc) =>
      `${doc.title} ${doc.path}`.toLowerCase().includes(q),
    );
  }, [documents, filter]);

  const selectedDocument = documentData?.metadata;
  const lineCount = countMarkdownLines(documentData?.content ?? "");
  const metaText = selectedDocument
    ? [
        formatSmartTime(selectedDocument.modifiedAt, locale),
        formatBytes(selectedDocument.size),
        t("reportsLineCount", { count: lineCount }),
      ].join(" · ")
    : "";

  const handleSelectDocument = useCallback(
    (path: string) => {
      if (!path) return;
      setSearchParams({ path });
    },
    [setSearchParams],
  );

  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || uploadingReport) return;

      setUploadingReport(true);
      let uploadedCount = 0;
      let lastUploadedPath = "";

      try {
        for (const file of files) {
          try {
            const res = await api.uploadReport(file);
            uploadedCount += 1;
            lastUploadedPath = res.document.path;
            setDocuments((prev) => [
              res.document,
              ...prev.filter((doc) => doc.path !== res.document.path),
            ]);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : t("reportsUploadFailed");
            showToast(
              t("reportsUploadFileFailed", {
                file: file.name,
                message,
              }),
              "error",
            );
          }
        }

        if (uploadedCount > 0) {
          showToast(
            t("reportsUploadSucceeded", { count: uploadedCount }),
            "success",
          );
          if (lastUploadedPath) {
            setSearchParams({ path: lastUploadedPath });
          }
        }
      } finally {
        setUploadingReport(false);
      }
    },
    [setSearchParams, showToast, t, uploadingReport],
  );

  const handleUploadInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      void handleUploadFiles(files);
    },
    [handleUploadFiles],
  );

  const scrollToHeading = useCallback((heading: HeadingItem) => {
    const article = articleRef.current;
    if (!article) return;

    let element: HTMLElement | null = null;
    for (const candidate of article.querySelectorAll<HTMLElement>(
      ".report-heading-anchor",
    )) {
      if (candidate.id === heading.id) {
        element = candidate;
        break;
      }
    }

    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveHeadingId(heading.id);
  }, []);

  const renderUploadButton = (showLabel = false) => (
    <button
      type="button"
      className={`reports-upload-button ${showLabel ? "with-label" : ""}`}
      onClick={() => uploadInputRef.current?.click()}
      disabled={uploadingReport}
      title={t("reportsUpload")}
      aria-label={t("reportsUpload")}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3v12" />
        <path d="m7 8 5-5 5 5" />
        <path d="M5 21h14" />
      </svg>
      {showLabel && <span>{t("reportsUpload")}</span>}
    </button>
  );

  const renderDocumentList = () => (
    <aside
      className="reports-document-panel"
      aria-label={t("reportsDocuments")}
    >
      <div className="reports-document-panel-header">
        <div>
          <h2>{t("reportsDocuments")}</h2>
          {rootPath && <p title={rootPath}>{rootPath}</p>}
        </div>
        {renderUploadButton()}
      </div>
      <input
        className="reports-filter-input"
        type="search"
        placeholder={t("reportsSearchPlaceholder")}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="reports-document-list">
        {loadingList && (
          <div className="reports-state-inline">{t("reportsLoading")}</div>
        )}
        {!loadingList && listError && (
          <div className="reports-state-inline reports-state-error">
            {listError}
          </div>
        )}
        {!loadingList && !listError && filteredDocuments.length === 0 && (
          <div className="reports-state-inline">{t("reportsNoMatches")}</div>
        )}
        {filteredDocuments.map((doc) => (
          <div
            key={doc.path}
            className={`reports-document-item ${
              doc.path === selectedPath ? "active" : ""
            }`}
          >
            <button
              type="button"
              className="reports-document-item-main"
              onClick={() => handleSelectDocument(doc.path)}
              title={getDisplayPath(doc)}
            >
              <span className="reports-document-title">{doc.title}</span>
              <span className="reports-document-meta">
                {formatSmartTime(doc.modifiedAt, locale)} ·{" "}
                {formatBytes(doc.size)}
              </span>
            </button>
            <ReportsDocumentMenu report={doc} />
          </div>
        ))}
      </div>
    </aside>
  );

  const renderToc = (mobile = false) => {
    if (headings.length === 0) {
      return mobile ? null : (
        <aside className="reports-toc-panel">
          <h2>{t("reportsToc")}</h2>
          <p className="reports-toc-empty">{t("reportsNoToc")}</p>
        </aside>
      );
    }

    const content = (
      <nav className="reports-toc-list" aria-label={t("reportsToc")}>
        {headings.map((heading) => (
          <button
            key={heading.id}
            type="button"
            className={`reports-toc-item depth-${heading.depth} ${
              activeHeadingId === heading.id ? "active" : ""
            }`}
            onClick={() => scrollToHeading(heading)}
          >
            {heading.text}
          </button>
        ))}
      </nav>
    );

    if (mobile) {
      return (
        <details className="reports-mobile-toc">
          <summary>{t("reportsToc")}</summary>
          {content}
        </details>
      );
    }

    return (
      <aside className="reports-toc-panel">
        <h2>{t("reportsToc")}</h2>
        {content}
      </aside>
    );
  };

  const hasDocuments = documents.length > 0;

  return (
    <div
      className={isWideScreen ? "main-content-wrapper" : "main-content-mobile"}
    >
      <div
        className={
          isWideScreen
            ? "main-content-constrained reports-main"
            : "main-content-mobile-inner reports-main"
        }
      >
        <PageHeader
          title={t("reportsTitle")}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container reports-scroll-container">
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            className="reports-upload-input"
            onChange={handleUploadInputChange}
          />
          <div className="reports-content-inner">
            {isWideScreen && renderDocumentList()}

            <section className="reports-reader-column">
              {!isWideScreen && hasDocuments && (
                <div className="reports-mobile-selector">
                  <label htmlFor="reports-document-select">
                    {t("reportsSelectDocument")}
                  </label>
                  <div className="reports-mobile-selector-row">
                    <select
                      id="reports-document-select"
                      value={selectedPath}
                      onChange={(event) =>
                        handleSelectDocument(event.target.value)
                      }
                    >
                      {documents.map((doc) => (
                        <option key={doc.path} value={doc.path}>
                          {doc.title}
                        </option>
                      ))}
                    </select>
                    {renderUploadButton()}
                  </div>
                </div>
              )}

              {selectedDocument && (
                <header className="reports-reader-header">
                  <div>
                    <p className="reports-reader-meta">{metaText}</p>
                  </div>
                  <ReportsDocumentMenu report={selectedDocument} />
                </header>
              )}

              {!isWideScreen && renderToc(true)}

              {loadingDocument && (
                <div className="reports-state-block">{t("reportsLoading")}</div>
              )}

              {!loadingDocument && documentError && (
                <div className="reports-state-block reports-state-error">
                  {documentError}
                </div>
              )}

              {!loadingList && !hasDocuments && !listError && (
                <div className="reports-empty-state">
                  <h1>{t("reportsEmptyTitle")}</h1>
                  <p>{t("reportsEmptyDescription")}</p>
                  {rootPath && <code>{rootPath}</code>}
                  <div className="reports-empty-actions">
                    {renderUploadButton(true)}
                  </div>
                </div>
              )}

              {!loadingDocument && documentData && (
                <article
                  ref={articleRef}
                  className="reports-markdown"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered sanitized markdown HTML
                  dangerouslySetInnerHTML={renderedMarkup}
                />
              )}
            </section>

            {isWideScreen && renderToc()}
          </div>
        </main>
      </div>
    </div>
  );
}
