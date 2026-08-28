import { memo, useCallback, useState } from "react";
import { appPath } from "../lib/apiPath";
import { FileViewer } from "./FileViewer";
import { DetailPanel } from "./ui/DetailPanel";

interface FilePathLinkProps {
  /** The file path to display and link to */
  filePath: string;
  /** Project ID for fetching file content */
  projectId: string;
  /** Optional line number to display */
  lineNumber?: number;
  /** Optional column number to display */
  columnNumber?: number;
  /** Optional custom display text (defaults to filename) */
  displayText?: string;
  /** Whether to show full path or just filename */
  showFullPath?: boolean;
}

/**
 * Get filename from path.
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * FilePathLink - A clickable link component that opens a file viewer modal.
 * Used to make file paths in messages interactive.
 */
export const FilePathLink = memo(function FilePathLink({
  filePath,
  projectId,
  lineNumber,
  columnNumber,
  displayText,
  showFullPath = false,
}: FilePathLinkProps) {
  const [showModal, setShowModal] = useState(false);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowModal(true);
  }, []);

  const handleClose = useCallback(() => {
    setShowModal(false);
  }, []);

  const handleOpenInNewTab = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const url = appPath(
        `/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`,
      );
      window.open(url, "_blank");
    },
    [projectId, filePath],
  );

  // Format the display text
  const fileName = showFullPath ? filePath : getFileName(filePath);
  const text = displayText || fileName;

  // Build line/column suffix
  let suffix = "";
  if (lineNumber !== undefined) {
    suffix = `:${lineNumber}`;
    if (columnNumber !== undefined) {
      suffix += `:${columnNumber}`;
    }
  }

  return (
    <>
      <button
        type="button"
        className="file-path-link"
        onClick={handleClick}
        onAuxClick={handleOpenInNewTab}
        title={`${filePath}${suffix}\nClick to view, middle-click to open in new tab`}
      >
        <span className="file-path-link-name">{text}</span>
        {suffix && <span className="file-path-link-line">{suffix}</span>}
      </button>
      {showModal && (
        <FileViewerModal
          projectId={projectId}
          filePath={filePath}
          lineNumber={lineNumber}
          onClose={handleClose}
        />
      )}
    </>
  );
});

/** Desktop side-panel / mobile modal wrapper for FileViewer. */
export function FileViewerModal({
  projectId,
  filePath,
  lineNumber,
  onClose,
}: {
  projectId: string;
  filePath: string;
  lineNumber?: number;
  onClose: () => void;
}) {
  return (
    <DetailPanel
      title={filePath}
      ariaLabel={filePath}
      onClose={onClose}
      hideHeader
      flush
    >
      <FileViewer
        projectId={projectId}
        filePath={filePath}
        lineNumber={lineNumber}
        onClose={onClose}
      />
    </DetailPanel>
  );
}
