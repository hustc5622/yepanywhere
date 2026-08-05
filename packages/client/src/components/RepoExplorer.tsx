import { memo, useCallback, useEffect, useState } from "react";
import {
  type ProjectBrowseEntry,
  type ProjectBrowseResponse,
  api,
} from "../api/client";
import { useProjectFileWatch } from "../hooks/useProjectFileWatch";
import { useI18n } from "../i18n";

type ExplorerPresentation = "sidebar" | "drawer";

interface RepoExplorerProps {
  projectId: string;
  presentation: ExplorerPresentation;
  isOpen?: boolean;
  onClose?: () => void;
  /** Open a file in a large centered viewer (handled by the parent page). */
  onOpenFile?: (filePath: string) => void;
}

interface TreeNode {
  entries: ProjectBrowseEntry[];
  error?: string;
}

/**
 * RepoExplorer — an in-session "project repository" panel (Codex-style).
 *
 * Lives on the right side of the chat and lets the user proactively browse the
 * repository file tree (unlike the inspector's passive "files touched this
 * session" list). It is purely a tree browser: clicking a file delegates to
 * `onOpenFile`, which the parent renders in a wide centered modal so the file
 * content is not cramped inside this narrow panel.
 *
 * The panel can be hidden (close button / header toggle) and reopened; the
 * open/closed preference is persisted by the parent.
 */
export const RepoExplorer = memo(function RepoExplorer({
  projectId,
  presentation,
  isOpen = true,
  onClose,
  onOpenFile,
}: RepoExplorerProps) {
  const { t } = useI18n();
  const [currentPath, setCurrentPath] = useState("");
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (relativePath: string) => {
      setLoading(true);
      setCurrentPath(relativePath);
      api
        .browseProjectFiles(projectId, relativePath)
        .then((data: ProjectBrowseResponse) => {
          setTree({ entries: data.entries, error: data.error });
          setLoading(false);
        })
        .catch(() => {
          setTree({ entries: [], error: t("repoError" as never) });
          setLoading(false);
        });
    },
    [projectId, t],
  );

  useEffect(() => {
    load("");
  }, [load]);

  // Refresh the current directory in real time when the project repo changes.
  const refreshCurrent = useCallback(() => {
    load(currentPath);
  }, [load, currentPath]);
  useProjectFileWatch(projectId, refreshCurrent);

  const enter = useCallback(
    (entry: ProjectBrowseEntry) => {
      if (entry.type === "dir") {
        load(entry.path);
      } else {
        onOpenFile?.(entry.path);
      }
    },
    [load, onOpenFile],
  );

  const goUp = useCallback(() => {
    if (currentPath === "") return;
    const parent = currentPath.split("/").slice(0, -1).join("/");
    load(parent);
  }, [currentPath, load]);

  const body = (
    <>
      <div className="repo-explorer-header">
        <div>
          <h2 className="repo-explorer-title">{t("repoTitle" as never)}</h2>
          <div className="repo-explorer-subtitle">
            {t("repoSubtitle" as never)}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            className="repo-explorer-close"
            onClick={onClose}
            aria-label={t("repoClose" as never)}
            title={t("repoClose" as never)}
          >
            <CloseIcon />
          </button>
        )}
        <button
          type="button"
          className="repo-explorer-refresh"
          onClick={refreshCurrent}
          aria-label={t("repoRefresh" as never)}
          title={t("repoRefresh" as never)}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="repo-explorer-body">
        <div className="repo-explorer-pathbar">
          <button
            type="button"
            className="repo-explorer-up"
            onClick={goUp}
            disabled={currentPath === ""}
            aria-label={t("repoUp" as never)}
            title={t("repoUp" as never)}
          >
            <UpIcon />
          </button>
          <span className="repo-explorer-current" title={currentPath || "/"}>
            {currentPath === "" ? "/" : currentPath}
          </span>
        </div>

        {loading ? (
          <div className="repo-explorer-loading">
            {t("repoLoading" as never)}
          </div>
        ) : tree?.error ? (
          <div className="repo-explorer-error">{tree.error}</div>
        ) : tree && tree.entries.length === 0 ? (
          <div className="repo-explorer-empty">{t("repoEmpty" as never)}</div>
        ) : (
          <div className="repo-explorer-list" role="listbox" tabIndex={0}>
            {tree?.entries.map((entry) => (
              <div key={entry.path}>
                <button
                  type="button"
                  className={`repo-explorer-item repo-explorer-item--${entry.type}`}
                  role="option"
                  aria-selected={false}
                  onClick={() => enter(entry)}
                  title={entry.path}
                >
                  <span className="repo-explorer-item-icon" aria-hidden="true">
                    {entry.type === "dir" ? <FolderIcon /> : <FileIcon />}
                  </span>
                  <span className="repo-explorer-item-name">{entry.name}</span>
                  {entry.type === "file" && typeof entry.size === "number" && (
                    <span className="repo-explorer-item-meta">
                      {formatSize(entry.size)}
                    </span>
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );

  if (presentation === "drawer") {
    if (!isOpen) return null;
    return (
      <div
        className="repo-explorer-overlay"
        role="presentation"
        onClick={onClose}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose?.();
        }}
      >
        <aside
          className="repo-explorer repo-explorer--drawer"
          aria-label={t("repoTitle" as never)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {body}
        </aside>
      </div>
    );
  }

  return (
    <aside
      className="repo-explorer repo-explorer--sidebar"
      aria-label={t("repoTitle" as never)}
    >
      {body}
    </aside>
  );
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function UpIcon() {
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
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3v5h5" />
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}
