import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { type ProjectDirectoryBrowseResponse, api } from "../api/client";
import { useI18n } from "../i18n";

const DIRECTORY_BROWSE_DEBOUNCE_MS = 160;

interface ProjectPathPickerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

function FolderIcon({ open = false }: { open?: boolean }) {
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
      {open ? (
        <path d="M2 10h20l-2 9H4l-2-9Zm2 0V5a2 2 0 0 1 2-2h5l2 3h5a2 2 0 0 1 2 2v2" />
      ) : (
        <path d="M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z" />
      )}
    </svg>
  );
}

function getBrowseError(
  error: unknown,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const status =
    error instanceof Error && "status" in error
      ? (error as Error & { status?: number }).status
      : undefined;
  if (status === 400) return t("projectsPathAbsoluteRequired");
  if (status === 404) return t("projectsDirectoryNotFound");
  return t("projectsDirectoryUnreadable");
}

/**
 * A path input backed by a read-only directory browser.
 *
 * Existing directories list their children. A non-existent final segment is
 * treated as an autocomplete prefix by the server.
 */
export function ProjectPathPicker({
  value,
  onChange,
  disabled = false,
  autoFocus = false,
}: ProjectPathPickerProps) {
  const { t } = useI18n();
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const listId = `${inputId}-directories`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [browseResult, setBrowseResult] =
    useState<ProjectDirectoryBrowseResponse | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (activeIndex < 0) return;
    document
      .getElementById(`${listId}-${activeIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setBrowseError(null);
    setActiveIndex(-1);

    const timeout = window.setTimeout(
      () => {
        void api
          .browseProjectDirectories(value.trim(), showHidden)
          .then((result) => {
            if (cancelled) return;
            setBrowseResult(result);
            setLoading(false);
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setBrowseResult(null);
            setBrowseError(getBrowseError(error, t));
            setLoading(false);
          });
      },
      value.trim() ? DIRECTORY_BROWSE_DEBOUNCE_MS : 0,
    );

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [showHidden, t, value]);

  const selectDirectory = useCallback(
    (path: string) => {
      onChange(path);
      setActiveIndex(-1);
    },
    [onChange],
  );

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const directories = browseResult?.directories ?? [];
    if (disabled || directories.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) =>
        current < directories.length - 1 ? current + 1 : 0,
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        current > 0 ? current - 1 : directories.length - 1,
      );
      return;
    }

    if (event.key === "Escape" && activeIndex >= 0) {
      event.preventDefault();
      setActiveIndex(-1);
      return;
    }

    const completionIndex =
      activeIndex >= 0
        ? activeIndex
        : browseResult?.exact === false && directories.length === 1
          ? 0
          : -1;
    if (
      completionIndex >= 0 &&
      (event.key === "Tab" || event.key === "Enter")
    ) {
      event.preventDefault();
      const directory = directories[completionIndex];
      if (directory) selectDirectory(directory.path);
    }
  };

  const directories = browseResult?.directories ?? [];
  const hasResults = !loading && browseError === null && directories.length > 0;

  return (
    <div className="project-path-picker">
      <label className="project-path-label" htmlFor={inputId}>
        {t("projectsPathLabel")}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        className="project-path-input"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder={t("projectsAddPlaceholder")}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={hasResults}
        aria-controls={listId}
        aria-activedescendant={
          activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
        }
        aria-describedby={hintId}
      />
      <p id={hintId} className="project-path-hint">
        {t("projectsPathBrowseHint")}
      </p>

      <div
        className="project-directory-browser"
        aria-label={t("projectsDirectoryBrowser")}
        aria-busy={loading}
      >
        <div className="project-directory-toolbar">
          <div
            className="project-directory-location"
            title={browseResult?.path}
          >
            <FolderIcon open />
            <span>
              {browseResult
                ? t(
                    browseResult.exact
                      ? "projectsDirectoryContents"
                      : "projectsDirectoryMatches",
                    { path: browseResult.path },
                  )
                : t("projectsDirectoryBrowser")}
            </span>
          </div>
          <div className="project-directory-navigation">
            <button
              type="button"
              onClick={() => {
                if (browseResult) selectDirectory(browseResult.home);
              }}
              disabled={
                disabled ||
                loading ||
                !browseResult ||
                browseResult.path === browseResult.home
              }
              title={t("projectsDirectoryHome")}
            >
              {t("projectsDirectoryHome")}
            </button>
            <button
              type="button"
              onClick={() => {
                if (browseResult?.parent) {
                  selectDirectory(browseResult.parent);
                }
              }}
              disabled={disabled || loading || !browseResult?.parent}
              title={t("projectsDirectoryUp")}
            >
              <span aria-hidden="true">..</span>
              {t("projectsDirectoryUp")}
            </button>
          </div>
        </div>

        <label className="project-directory-hidden-toggle">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => setShowHidden(event.target.checked)}
            disabled={disabled}
          />
          <span>{t("projectsDirectoryShowHidden")}</span>
        </label>

        {loading ? (
          <div className="project-directory-status" role="status">
            {t("projectsDirectoryLoading")}
          </div>
        ) : browseError ? (
          <div className="project-directory-status is-error" role="alert">
            {browseError}
          </div>
        ) : hasResults ? (
          <div
            id={listId}
            className="project-directory-list"
            role="listbox"
            tabIndex={-1}
            aria-label={t("projectsDirectoryResults")}
          >
            {directories.map((directory, index) => (
              <button
                id={`${listId}-${index}`}
                key={directory.path}
                type="button"
                className={`project-directory-item ${
                  index === activeIndex ? "is-active" : ""
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectDirectory(directory.path)}
                role="option"
                aria-selected={index === activeIndex}
                title={directory.path}
                disabled={disabled}
              >
                <FolderIcon />
                <span>{directory.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="project-directory-status">
            {t("projectsDirectoryEmpty")}
          </div>
        )}

        {!loading && browseResult?.truncated ? (
          <div className="project-directory-truncated">
            {t("projectsDirectoryTruncated", {
              count: browseResult.directories.length,
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
