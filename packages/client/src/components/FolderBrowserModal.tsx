import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { apiPath } from "../lib/apiPath";
import { Modal } from "./ui/Modal";

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FsBrowseResponse {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  error?: string;
}

interface FolderBrowserModalProps {
  /** Called with the selected absolute directory path on the server. */
  onSelect: (absolutePath: string) => void;
  onClose: () => void;
}

function browseUrl(path: string | null): string {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return apiPath(`/filesystem/browse${qs}`);
}

/**
 * Server-side folder picker.
 *
 * This browses the filesystem of the machine running the Yep Anywhere server
 * (not the client device), so it works identically from a desktop browser, a
 * phone, or a tablet. The chosen directory becomes the project's working
 * directory on the *server* device.
 */
export function FolderBrowserModal({
  onSelect,
  onClose,
}: FolderBrowserModalProps) {
  const { t } = useI18n();
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (path: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(browseUrl(path), { credentials: "include" });
        const data = (await res.json()) as FsBrowseResponse;
        if (!res.ok) {
          setError(data.error ?? t("folderBrowseError"));
          setEntries([]);
          return;
        }
        setCurrentPath(data.path);
        setParent(data.parent);
        setEntries(data.entries);
        if (data.error) {
          // Non-fatal (e.g. permission denied for this folder) — still show what we can.
          setError(data.error);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t("folderBrowseError"));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const enter = (entry: FsEntry) => {
    if (!entry.isDirectory) return;
    void load(entry.path);
  };

  const goUp = () => {
    if (parent !== null) void load(parent);
  };

  return (
    <Modal
      title={t("folderBrowseTitle")}
      onClose={onClose}
      backLabel={t("folderBrowseClose")}
    >
      <div className="folder-browser">
        <div className="folder-browser-path" aria-live="polite">
          <span className="folder-browser-path-label">
            {t("folderBrowseCurrent")}
          </span>
          <code className="folder-browser-path-value">
            {currentPath === ""
              ? t("folderBrowseDrives")
              : (currentPath ?? "…")}
          </code>
        </div>

        <div className="folder-browser-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={goUp}
            disabled={loading || parent === null}
          >
            {t("folderBrowseUp")}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => currentPath && onSelect(currentPath)}
            disabled={loading || !currentPath}
          >
            {t("folderBrowseSelectHere")}
          </button>
        </div>

        {error && <div className="folder-browser-error">{error}</div>}

        <div className="folder-browser-list" role="listbox" tabIndex={0}>
          {loading ? (
            <div className="folder-browser-loading">
              {t("folderBrowseLoading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="folder-browser-empty">{t("folderBrowseEmpty")}</div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="folder-browser-item"
                role="option"
                aria-selected={false}
                onClick={() => enter(entry)}
                title={entry.path}
              >
                <span className="folder-browser-item-icon" aria-hidden="true">
                  📁
                </span>
                <span className="folder-browser-item-name">{entry.name}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
