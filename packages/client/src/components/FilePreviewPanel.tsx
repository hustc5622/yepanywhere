import { type ReactNode, useCallback, useState } from "react";
import {
  type FileRef,
  type FileSnapshot,
  getFileRefName,
  sameFileRef,
} from "../lib/fileRef";
import { FileViewer } from "./FileViewer";
import { DetailPanel } from "./ui/DetailPanel";

interface FilePreviewPanelProps {
  fileRef: FileRef;
  snapshot?: FileSnapshot;
  onClose: () => void;
}

/**
 * The file side panel: desktop docked panel / mobile modal around
 * `FileViewer`. Links inside the preview (e.g. markdown) navigate in place.
 */
export function FilePreviewPanel({
  fileRef,
  snapshot,
  onClose,
}: FilePreviewPanelProps) {
  const [current, setCurrent] = useState<{
    ref: FileRef;
    snapshot?: FileSnapshot;
  }>({ ref: fileRef, snapshot });
  // A different file from the caller replaces any in-panel navigation.
  const [opened, setOpened] = useState({ fileRef, snapshot });
  if (!sameFileRef(opened.fileRef, fileRef) || opened.snapshot !== snapshot) {
    setOpened({ fileRef, snapshot });
    setCurrent({ ref: fileRef, snapshot });
  }

  const label = current.ref.path || getFileRefName(current.ref);
  return (
    <DetailPanel
      title={label}
      ariaLabel={label}
      onClose={onClose}
      hideHeader
      flush
    >
      <FileViewer
        key={`${current.ref.projectId ?? ""}:${current.ref.path}:${current.ref.lineNumber ?? ""}`}
        fileRef={current.ref}
        snapshot={current.snapshot}
        onClose={onClose}
        onNavigate={(ref) => setCurrent({ ref })}
      />
    </DetailPanel>
  );
}

export interface OpenFileOptions {
  snapshot?: FileSnapshot;
}

/**
 * Entry point for every surface that shows a file: call `openFile` and render
 * `filePreview` once. Each caller keeps its own panel so nesting inside other
 * detail panels (subagent transcripts) keeps working; `DetailPanel` already
 * closes the previously docked panel when a new one opens.
 */
export function useFilePreview(): {
  openFile: (ref: FileRef, options?: OpenFileOptions) => void;
  closeFile: () => void;
  filePreview: ReactNode;
} {
  const [state, setState] = useState<{
    ref: FileRef;
    snapshot?: FileSnapshot;
  } | null>(null);
  const openFile = useCallback((ref: FileRef, options?: OpenFileOptions) => {
    setState({ ref, snapshot: options?.snapshot });
  }, []);
  const closeFile = useCallback(() => setState(null), []);
  const filePreview = state ? (
    <FilePreviewPanel
      fileRef={state.ref}
      snapshot={state.snapshot}
      onClose={closeFile}
    />
  ) : null;
  return { openFile, closeFile, filePreview };
}

/**
 * A button that opens a file in the side panel. Used by tool renderers that
 * show a file name (Read, View Image, …).
 */
export function FileOpenButton({
  fileRef,
  snapshot,
  className,
  stopPropagation = false,
  title,
  children,
}: {
  fileRef: FileRef;
  snapshot?: FileSnapshot;
  className: string;
  /** Keep the click from toggling an enclosing collapsible row. */
  stopPropagation?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const { openFile, filePreview } = useFilePreview();
  return (
    <>
      <button
        type="button"
        className={className}
        title={title ?? fileRef.path}
        onClick={(event) => {
          if (stopPropagation) event.stopPropagation();
          openFile(fileRef, { snapshot });
        }}
      >
        {children}
      </button>
      {filePreview}
    </>
  );
}
