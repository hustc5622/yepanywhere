import type { GitFileChange } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { CardListSkeleton } from "../components/Skeleton";
import { Modal } from "../components/ui/Modal";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useGitStatus } from "../hooks/useGitStatus";
import { useProject, useProjects } from "../hooks/useProjects";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface GitDiffResult {
  diffHtml: string;
  structuredPatch: PatchHunk[];
  markdownHtml?: string;
}

export function GitStatusPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const { openSidebar, isWideScreen } = useNavigationLayout();

  const { projects, loading: projectsLoading } = useProjects();
  const effectiveProjectId = projectId || projects[0]?.id;
  const { project } = useProject(effectiveProjectId);
  const { gitStatus, loading, error } = useGitStatus(effectiveProjectId);

  useDocumentTitle(project?.name, t("gitStatusTitle"));

  const handleProjectChange = (newProjectId: string) => {
    setSearchParams({ projectId: newProjectId }, { replace: true });
  };

  if (!effectiveProjectId && !projectsLoading && projects.length === 0) {
    return <div className="error">{t("gitStatusNoProjects")}</div>;
  }

  const wrapperClass = isWideScreen
    ? "main-content-wrapper"
    : "main-content-mobile";
  const innerClass = isWideScreen
    ? "main-content-constrained"
    : "main-content-mobile-inner";

  return (
    <div className={wrapperClass}>
      <div className={innerClass}>
        <PageHeader
          title={project?.name ?? t("gitStatusTitle")}
          titleElement={
            effectiveProjectId ? (
              <ProjectSelector
                currentProjectId={effectiveProjectId}
                currentProjectName={project?.name}
                onProjectChange={(p) => handleProjectChange(p.id)}
              />
            ) : undefined
          }
          onOpenSidebar={openSidebar}
          isWideScreen={isWideScreen}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {loading || projectsLoading ? (
              <CardListSkeleton count={4} height={56} />
            ) : error ? (
              <div className="error">
                {t("gitStatusErrorPrefix")} {error.message}
              </div>
            ) : gitStatus && !gitStatus.isGitRepo ? (
              <div className="git-status-empty content-fade-in">
                {t("gitStatusNotRepo")}
              </div>
            ) : gitStatus && effectiveProjectId ? (
              <div className="content-fade-in">
                <GitStatusContent
                  status={gitStatus}
                  projectId={effectiveProjectId}
                  t={t as never}
                />
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

export function GitStatusContent({
  status,
  projectId,
  t,
}: {
  status: import("@yep-anywhere/shared").GitStatusInfo;
  projectId: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [selectedFile, setSelectedFile] = useState<GitFileChange | null>(null);

  const stagedFiles = status.files.filter((f) => f.staged);
  const unstagedFiles = status.files.filter(
    (f) => !f.staged && f.status !== "?",
  );
  const untrackedFiles = status.files.filter((f) => f.status === "?");

  return (
    <div className="git-status">
      <div className="git-status-branch">
        <span className="git-branch-icon">
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
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
        </span>
        <span className="git-branch-name">
          {status.branch ?? t("gitStatusDetachedHead")}
        </span>
        {status.upstream && (
          <span className="git-upstream"> → {status.upstream}</span>
        )}
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="git-ahead-behind">
            {status.ahead > 0 && ` ↑${status.ahead}`}
            {status.behind > 0 && ` ↓${status.behind}`}
          </span>
        )}
        <span
          className={`git-clean-badge ${status.isClean ? "git-clean" : "git-dirty"}`}
        >
          {status.isClean ? t("gitStatusClean") : t("gitStatusDirty")}
        </span>
      </div>

      {status.isClean ? (
        <div className="git-status-empty">{t("gitStatusWorkingTreeClean")}</div>
      ) : (
        <>
          {stagedFiles.length > 0 && (
            <GitFileSection
              title={t("gitStatusStaged")}
              files={stagedFiles}
              onFileClick={setSelectedFile}
            />
          )}
          {unstagedFiles.length > 0 && (
            <GitFileSection
              title={t("gitStatusChanges")}
              files={unstagedFiles}
              onFileClick={setSelectedFile}
            />
          )}
          {untrackedFiles.length > 0 && (
            <GitFileSection
              title={t("gitStatusUntracked")}
              files={untrackedFiles}
              onFileClick={setSelectedFile}
            />
          )}
        </>
      )}

      {selectedFile && (
        <GitDiffModal
          file={selectedFile}
          projectId={projectId}
          t={t}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
}

function GitFileSection({
  title,
  files,
  onFileClick,
}: {
  title: string;
  files: GitFileChange[];
  onFileClick: (file: GitFileChange) => void;
}) {
  return (
    <div className="git-file-section">
      <h3 className="git-file-section-title">
        {title} <span className="git-file-count">({files.length})</span>
      </h3>
      <ul className="git-file-list">
        {files.map((file) => (
          <GitFileItem
            key={`${file.path}-${file.staged}`}
            file={file}
            onClick={onFileClick}
          />
        ))}
      </ul>
    </div>
  );
}

function GitFileItem({
  file,
  onClick,
}: {
  file: GitFileChange;
  onClick: (file: GitFileChange) => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav not needed for file list
    <li
      className="git-file-item git-file-item-clickable"
      onClick={() => onClick(file)}
    >
      <span
        className={`git-status-badge git-status-${file.status.toLowerCase()}`}
      >
        {file.status}
      </span>
      <span className="git-file-path">
        {file.origPath ? (
          <>
            {file.origPath} → {file.path}
          </>
        ) : (
          file.path
        )}
      </span>
      {(file.linesAdded !== null || file.linesDeleted !== null) && (
        <span className="git-line-counts">
          {file.linesAdded !== null && (
            <span className="git-lines-added">+{file.linesAdded}</span>
          )}
          {file.linesDeleted !== null && (
            <span className="git-lines-deleted">-{file.linesDeleted}</span>
          )}
        </span>
      )}
    </li>
  );
}

function GitDiffModal({
  file,
  projectId,
  t,
  onClose,
}: {
  file: GitFileChange;
  projectId: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onClose: () => void;
}) {
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getGitDiff(projectId, {
        path: file.path,
        staged: file.staged,
        status: file.status,
      })
      .then((result) => {
        if (!cancelled) {
          setDiffResult(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || t("gitStatusLoadDiffFailed"));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, file.path, file.staged, file.status, t]);

  const fileName = file.path.split("/").pop() || file.path;

  return (
    <Modal title={fileName} onClose={onClose}>
      {loading ? (
        <div className="git-diff-loading">{t("gitStatusLoadingDiff")}</div>
      ) : error ? (
        <div className="git-diff-error">{error}</div>
      ) : diffResult ? (
        <GitDiffModalContent
          file={file}
          projectId={projectId}
          diffResult={diffResult}
          t={t}
        />
      ) : null}
    </Modal>
  );
}

function GitDiffModalContent({
  file,
  projectId,
  diffResult,
  t,
}: {
  file: GitFileChange;
  projectId: string;
  diffResult: GitDiffResult;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [showFullContext, setShowFullContext] = useState(false);
  const [fullContextResult, setFullContextResult] =
    useState<GitDiffResult | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const isMarkdown = /\.(md|markdown)$/i.test(file.path);
  const hasMarkdownPreview =
    isMarkdown &&
    !!(fullContextResult?.markdownHtml || diffResult.markdownHtml);

  const handleToggleContext = useCallback(async () => {
    if (!showFullContext && !fullContextResult) {
      setContextLoading(true);
      setContextError(null);
      try {
        const result = await api.getGitDiff(projectId, {
          path: file.path,
          staged: file.staged,
          status: file.status,
          fullContext: true,
        });
        setFullContextResult(result);
      } catch (err) {
        setContextError(
          err instanceof Error ? err.message : t("gitStatusLoadContextFailed"),
        );
        setContextLoading(false);
        return;
      }
      setContextLoading(false);
    }
    setShowFullContext(!showFullContext);
  }, [
    showFullContext,
    fullContextResult,
    projectId,
    file.path,
    file.staged,
    file.status,
    t,
  ]);

  // Scroll to first changed line when showing full context
  useEffect(() => {
    if (showFullContext && fullContextResult && contentRef.current) {
      requestAnimationFrame(() => {
        const firstChange = contentRef.current?.querySelector(
          ".line-deleted, .line-inserted",
        );
        if (firstChange) {
          firstChange.scrollIntoView({ block: "center", behavior: "instant" });
        }
      });
    }
  }, [showFullContext, fullContextResult]);

  const displayResult =
    showFullContext && fullContextResult ? fullContextResult : diffResult;

  const markdownHtml =
    fullContextResult?.markdownHtml || diffResult.markdownHtml;

  return (
    <div className="diff-modal-content" ref={contentRef}>
      <div className="diff-context-controls">
        <span className="diff-context-path">{file.path}</span>
        <div className="diff-context-buttons">
          {hasMarkdownPreview && (
            <button
              type="button"
              className={`diff-context-toggle ${showMarkdownPreview ? "active" : ""}`}
              onClick={() => setShowMarkdownPreview(!showMarkdownPreview)}
            >
              {showMarkdownPreview ? t("gitStatusDiff") : t("gitStatusPreview")}
            </button>
          )}
          {!showMarkdownPreview && (
            <button
              type="button"
              className="diff-context-toggle"
              onClick={handleToggleContext}
              disabled={contextLoading}
            >
              {contextLoading
                ? t("gitStatusLoading")
                : showFullContext
                  ? t("gitStatusDiffOnly")
                  : t("gitStatusFullContext")}
            </button>
          )}
        </div>
        {contextError && (
          <span className="diff-context-error">{contextError}</span>
        )}
      </div>

      {showMarkdownPreview && markdownHtml ? (
        <div className="markdown-preview">
          <div
            className="markdown-rendered"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: markdownHtml }}
          />
        </div>
      ) : displayResult.diffHtml ? (
        <HighlightedDiff diffHtml={displayResult.diffHtml} />
      ) : (
        <DiffLines
          lines={displayResult.structuredPatch.flatMap((h) => h.lines)}
        />
      )}
    </div>
  );
}

/** Render syntax-highlighted diff HTML from server */
const HighlightedDiff = memo(function HighlightedDiff({
  diffHtml,
}: {
  diffHtml: string;
}) {
  return (
    <div
      className="highlighted-diff"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is safe
      dangerouslySetInnerHTML={{ __html: diffHtml }}
    />
  );
});

/** Fallback plain-text diff renderer */
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
          return (
            <div key={`${i}-${line.slice(0, 50)}`} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});
