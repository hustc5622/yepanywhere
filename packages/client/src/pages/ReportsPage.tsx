import type {
  ReportComment,
  ReportCommentAnchor,
  ReportDocument,
  ReportDocumentResponse,
} from "@yep-anywhere/shared";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { api, getDesktopAuthToken } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { Modal } from "../components/ui/Modal";
import { useToastContext } from "../contexts/ToastContext";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { writeClipboardText } from "../lib/clipboard";
import { formatSmartTime } from "../lib/datetime";
import {
  applyReportCommentHighlights,
  createReportCommentAnchor,
  resolveReportCommentAnchor,
} from "../lib/reportComments";
import { UI_KEYS } from "../lib/storageKeys";

interface HeadingItem {
  id: string;
  depth: number;
  text: string;
}

interface ReportSelectionDraft {
  anchor: ReportCommentAnchor;
  top: number;
  left: number;
}

interface ReportCommentEditorState {
  reportPath: string;
  anchor: ReportCommentAnchor;
  commentId?: string;
  body: string;
}

const HEADING_PATTERN = /^(#{1,4})\s+(.+?)\s*#*$/;

function loadDocumentPanelExpanded(): boolean {
  if (typeof window === "undefined") return true;

  try {
    const stored = window.localStorage.getItem(
      UI_KEYS.reportsDocumentPanelExpanded,
    );
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function saveDocumentPanelExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(
      UI_KEYS.reportsDocumentPanelExpanded,
      String(expanded),
    );
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
}

function DocumentPanelToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <polyline points={expanded ? "16 9 13 12 16 15" : "13 9 16 12 13 15"} />
    </svg>
  );
}

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

function readReportSelection(
  article: HTMLElement,
): ReportSelectionDraft | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const anchor = createReportCommentAnchor(article, range);
  if (!anchor || anchor.exact.length > 4_000) return null;

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const horizontalMargin = 72;
  const left = Math.min(
    Math.max(horizontalMargin, rect.left + rect.width / 2),
    Math.max(horizontalMargin, window.innerWidth - horizontalMargin),
  );
  const top =
    rect.bottom + 52 <= window.innerHeight
      ? rect.bottom + 8
      : Math.max(8, rect.top - 44);

  return { anchor, top, left };
}

function ReportCommentEditor({
  editor,
  saving,
  onBodyChange,
  onClose,
  onSubmit,
}: {
  editor: ReportCommentEditorState;
  saving: boolean;
  onBodyChange: (body: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { t } = useI18n();
  const editing = Boolean(editor.commentId);

  return (
    <Modal
      title={editing ? t("reportsEditComment") : t("reportsAddComment")}
      onClose={onClose}
    >
      <form className="report-comment-editor" onSubmit={onSubmit}>
        <blockquote className="report-comment-quote">
          {editor.anchor.exact}
        </blockquote>
        <label className="report-comment-label" htmlFor="report-comment-body">
          {t("reportsCommentLabel")}
        </label>
        <textarea
          id="report-comment-body"
          value={editor.body}
          onChange={(event) => onBodyChange(event.target.value)}
          placeholder={t("reportsCommentPlaceholder")}
          maxLength={10_000}
          rows={6}
          required
        />
        <div className="report-comment-editor-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={saving}
          >
            {t("reportsCommentCancel")}
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={saving || !editor.body.trim()}
          >
            {saving ? t("reportsCommentSaving") : t("reportsCommentSave")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReportsDocumentMenu({ report }: { report: ReportDocument }) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{
    top: number;
    left?: number;
    right?: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedInWrapper = wrapperRef.current?.contains(target);
      const clickedInDropdown = dropdownRef.current?.contains(target);
      if (!clickedInWrapper && !clickedInDropdown) {
        setIsOpen(false);
        setDropdownPosition(null);
        triggerRef.current?.blur();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      setDropdownPosition(null);
      triggerRef.current?.blur();
    };
    const handleScroll = () => {
      setIsOpen(false);
      setDropdownPosition(null);
      triggerRef.current?.blur();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [isOpen]);

  const closeMenu = () => {
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
  };

  const toggleMenu = () => {
    if (isOpen) {
      closeMenu();
      return;
    }

    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const dropdownWidth = 176;
      const dropdownHeight = 42;
      const margin = 8;
      const top =
        rect.bottom + margin + dropdownHeight > window.innerHeight
          ? Math.max(margin, rect.top - dropdownHeight - margin)
          : rect.bottom + margin;

      if (rect.right - dropdownWidth < margin) {
        setDropdownPosition({ top, left: Math.max(margin, rect.left) });
      } else {
        setDropdownPosition({
          top,
          right: Math.max(margin, window.innerWidth - rect.right),
        });
      }
    }
    setIsOpen(true);
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
          toggleMenu();
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
      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            className="session-menu-dropdown reports-document-menu-dropdown"
            style={{
              position: "fixed",
              top: dropdownPosition?.top ?? 100,
              ...(dropdownPosition?.left !== undefined
                ? { left: dropdownPosition.left }
                : { right: dropdownPosition?.right ?? 20 }),
            }}
          >
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
          </div>,
          document.body,
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
  const [uploadingImage, setUploadingImage] = useState(false);
  const [selectionDraft, setSelectionDraft] =
    useState<ReportSelectionDraft | null>(null);
  const [commentEditor, setCommentEditor] =
    useState<ReportCommentEditorState | null>(null);
  const [savingComment, setSavingComment] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [isDocumentPanelExpanded, setIsDocumentPanelExpanded] = useState(
    loadDocumentPanelExpanded,
  );
  const articleRef = useRef<HTMLElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

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
    setSelectionDraft(null);
    setCommentEditor(null);
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
  const comments = useMemo(
    () => documentData?.comments ?? [],
    [documentData?.comments],
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

  useEffect(() => {
    if (!renderedHtml) return;
    const article = articleRef.current;
    if (!article) return;

    const controller = new AbortController();
    const blobUrls: string[] = [];
    const needsAuthenticatedFetch = Boolean(getDesktopAuthToken());
    const images = article.querySelectorAll<HTMLImageElement>("img");
    for (const image of images) {
      image.loading = "lazy";
      image.decoding = "async";
      const source = image.getAttribute("src") ?? "";
      if (!needsAuthenticatedFetch || !source.includes("/api/reports/image?")) {
        continue;
      }

      void api
        .loadReportImage(source, controller.signal)
        .then((blob) => {
          if (controller.signal.aborted) return;
          const blobUrl = URL.createObjectURL(blob);
          blobUrls.push(blobUrl);
          image.src = blobUrl;
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          console.error("Failed to load report image:", error);
          image.classList.add("report-image-load-failed");
        });
    }

    return () => {
      controller.abort();
      for (const blobUrl of blobUrls) URL.revokeObjectURL(blobUrl);
    };
  }, [renderedHtml]);

  useEffect(() => {
    if (!renderedHtml) return;
    const article = articleRef.current;
    if (!article) return;
    applyReportCommentHighlights(article, comments, t("reportsOpenComment"));
  }, [comments, renderedHtml, t]);

  useEffect(() => {
    if (!selectionDraft) return;
    const hideSelectionAction = () => setSelectionDraft(null);
    window.addEventListener("scroll", hideSelectionAction, true);
    window.addEventListener("resize", hideSelectionAction);
    return () => {
      window.removeEventListener("scroll", hideSelectionAction, true);
      window.removeEventListener("resize", hideSelectionAction);
    };
  }, [selectionDraft]);

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

  const openComment = useCallback((comment: ReportComment) => {
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    setCommentEditor({
      reportPath: comment.reportPath,
      anchor: comment.anchor,
      commentId: comment.id,
      body: comment.body,
    });
  }, []);

  const openCommentFromHighlight = useCallback(
    (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      const highlight = target.closest<HTMLElement>(
        ".report-comment-highlight",
      );
      if (!highlight || !articleRef.current?.contains(highlight)) return false;

      const ids = (highlight.dataset.reportCommentIds ?? "").split(",");
      const comment = comments.find((candidate) => ids.includes(candidate.id));
      if (!comment) return false;
      openComment(comment);
      return true;
    },
    [comments, openComment],
  );

  const handleArticleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!openCommentFromHighlight(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    [openCommentFromHighlight],
  );

  const handleArticleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!openCommentFromHighlight(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    [openCommentFromHighlight],
  );

  const updateSelectionDraft = useCallback(() => {
    if (commentEditor) return;
    const article = articleRef.current;
    setSelectionDraft(article ? readReportSelection(article) : null);
  }, [commentEditor]);

  const handleOpenSelectionComment = useCallback(() => {
    if (!selectionDraft || !documentData) return;

    const articleText = articleRef.current?.textContent ?? "";
    const overlappingComment = comments.find((comment) => {
      const resolved = resolveReportCommentAnchor(articleText, comment.anchor);
      return (
        resolved !== null &&
        resolved.start < selectionDraft.anchor.end &&
        resolved.end > selectionDraft.anchor.start
      );
    });

    if (overlappingComment) {
      openComment(overlappingComment);
      return;
    }

    window.getSelection()?.removeAllRanges();
    setSelectionDraft(null);
    setCommentEditor({
      reportPath: documentData.metadata.path,
      anchor: selectionDraft.anchor,
      body: "",
    });
  }, [comments, documentData, openComment, selectionDraft]);

  const closeCommentEditor = useCallback(() => {
    if (!savingComment) setCommentEditor(null);
  }, [savingComment]);

  const handleSaveComment = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!commentEditor || savingComment) return;
      const body = commentEditor.body.trim();
      if (!body) return;

      const editorSnapshot = commentEditor;
      setSavingComment(true);
      try {
        const response = editorSnapshot.commentId
          ? await api.updateReportComment(
              editorSnapshot.reportPath,
              editorSnapshot.commentId,
              body,
            )
          : await api.createReportComment(
              editorSnapshot.reportPath,
              editorSnapshot.anchor,
              body,
            );

        setDocumentData((current) => {
          if (!current || current.metadata.path !== editorSnapshot.reportPath) {
            return current;
          }
          const currentComments = current.comments ?? [];
          const index = currentComments.findIndex(
            (comment) => comment.id === response.comment.id,
          );
          const nextComments = [...currentComments];
          if (index >= 0) nextComments[index] = response.comment;
          else nextComments.push(response.comment);
          return { ...current, comments: nextComments };
        });
        setCommentEditor(null);
        showToast(
          t(
            editorSnapshot.commentId
              ? "reportsCommentUpdated"
              : "reportsCommentCreated",
          ),
          "success",
        );
      } catch (error) {
        showToast(
          t("reportsCommentSaveFailed", {
            message:
              error instanceof Error
                ? error.message
                : t("reportsCommentUnknownError"),
          }),
          "error",
        );
      } finally {
        setSavingComment(false);
      }
    },
    [commentEditor, savingComment, showToast, t],
  );

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

  const handleImageInputChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || !selectedDocument || uploadingImage) return;

      setUploadingImage(true);
      try {
        const result = await api.uploadReportImage(selectedDocument.path, file);
        try {
          await writeClipboardText(result.markdown);
          showToast(t("reportsImageUploadedAndCopied"), "success");
        } catch {
          showToast(
            t("reportsImageUploadedCopyFailed", { markdown: result.markdown }),
            "error",
          );
        }
      } catch (error) {
        showToast(
          t("reportsImageUploadFailed", {
            message:
              error instanceof Error
                ? error.message
                : t("reportsCommentUnknownError"),
          }),
          "error",
        );
      } finally {
        setUploadingImage(false);
      }
    },
    [selectedDocument, showToast, t, uploadingImage],
  );

  const toggleDocumentPanel = useCallback(() => {
    setIsDocumentPanelExpanded((expanded) => {
      const next = !expanded;
      saveDocumentPanelExpanded(next);
      return next;
    });
  }, []);

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

  const renderDocumentPanelToggle = () => {
    const label = isDocumentPanelExpanded
      ? t("reportsCollapseDocuments")
      : t("reportsExpandDocuments");

    return (
      <button
        type="button"
        className="reports-document-panel-toggle"
        onClick={toggleDocumentPanel}
        title={label}
        aria-label={label}
        aria-controls="reports-document-panel"
        aria-expanded={isDocumentPanelExpanded}
      >
        <DocumentPanelToggleIcon expanded={isDocumentPanelExpanded} />
      </button>
    );
  };

  const renderDocumentList = () => (
    <aside
      id="reports-document-panel"
      className={`reports-document-panel ${
        isDocumentPanelExpanded ? "" : "is-collapsed"
      }`}
      aria-label={t("reportsDocuments")}
    >
      <div className="reports-document-panel-header">
        {isDocumentPanelExpanded && (
          <div className="reports-document-panel-heading">
            <h2>{t("reportsDocuments")}</h2>
            {rootPath && <p title={rootPath}>{rootPath}</p>}
          </div>
        )}
        <div className="reports-document-panel-actions">
          {renderDocumentPanelToggle()}
          {isDocumentPanelExpanded && renderUploadButton()}
        </div>
      </div>
      {isDocumentPanelExpanded && (
        <>
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
              <div className="reports-state-inline">
                {t("reportsNoMatches")}
              </div>
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
        </>
      )}
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

        {selectionDraft &&
          createPortal(
            <button
              type="button"
              className="report-comment-selection-action"
              style={{ top: selectionDraft.top, left: selectionDraft.left }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={handleOpenSelectionComment}
            >
              {t("reportsAddComment")}
            </button>,
            document.body,
          )}

        {commentEditor && (
          <ReportCommentEditor
            editor={commentEditor}
            saving={savingComment}
            onBodyChange={(body) =>
              setCommentEditor((current) =>
                current ? { ...current, body } : current,
              )
            }
            onClose={closeCommentEditor}
            onSubmit={handleSaveComment}
          />
        )}

        <main className="page-scroll-container reports-scroll-container">
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            className="reports-upload-input"
            onChange={handleUploadInputChange}
          />
          <input
            ref={imageInputRef}
            type="file"
            accept=".png,.jpg,.jpeg,.gif,.webp,.avif,.bmp,.tiff,.tif,.svg,image/*"
            className="reports-upload-input"
            onChange={handleImageInputChange}
          />
          <div
            className={`reports-content-inner ${
              isWideScreen && !isDocumentPanelExpanded
                ? "documents-collapsed"
                : ""
            }`}
          >
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
                    <p className="reports-comment-hint">
                      {comments.length > 0
                        ? t("reportsCommentCount", { count: comments.length })
                        : t("reportsCommentHint")}
                    </p>
                  </div>
                  <div className="reports-reader-actions">
                    <button
                      type="button"
                      className="reports-upload-button"
                      onClick={() => imageInputRef.current?.click()}
                      disabled={uploadingImage}
                      title={t("reportsUploadImage")}
                      aria-label={t("reportsUploadImage")}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                        <line x1="12" y1="5" x2="12" y2="11" />
                        <line x1="9" y1="8" x2="15" y2="8" />
                      </svg>
                    </button>
                    <ReportsDocumentMenu report={selectedDocument} />
                  </div>
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
                  onClick={handleArticleClick}
                  onKeyDown={handleArticleKeyDown}
                  onKeyUp={updateSelectionDraft}
                  onMouseUp={updateSelectionDraft}
                  onTouchEnd={() => {
                    window.setTimeout(updateSelectionDraft, 0);
                  }}
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
