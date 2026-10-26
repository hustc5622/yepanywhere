import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { type FileRef, fileRefFromPath } from "../../../lib/fileRef";
import { FileOpenButton } from "../../FilePreviewPanel";

/**
 * Resolve a path printed by a search tool. Relative results are relative to
 * the tool's search root when it is absolute, otherwise to the project.
 */
export function useSearchResultFileRef(): (
  path: string,
  searchRoot: string | undefined,
  lineNumber?: number,
) => FileRef {
  const metadata = useOptionalSessionMetadata();
  return (path, searchRoot, lineNumber) =>
    fileRefFromPath(
      path,
      searchRoot?.startsWith("/")
        ? { projectId: metadata?.projectId, projectPath: searchRoot }
        : metadata,
      { lineNumber },
    );
}

function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/** One clickable row in a Glob/Grep file list. */
export function FileListItem({
  path,
  searchRoot,
}: {
  path: string;
  searchRoot?: string;
}) {
  const toRef = useSearchResultFileRef();
  return (
    <FileOpenButton
      fileRef={toRef(path, searchRoot)}
      className="file-list-item file-list-link"
    >
      <span className="file-path">{getFileName(path)}</span>
      <span className="file-dir">{path}</span>
    </FileOpenButton>
  );
}

const GREP_LINE_PATTERN = /^(.+?)([:-])(\d+)([:-])/;

/**
 * One line of grep content output. `path:12:text` (match) and `path-12-text`
 * (context) get a clickable `path:12` prefix; other lines stay plain.
 */
export function GrepContentLine({
  line,
  searchRoot,
}: {
  line: string;
  searchRoot?: string;
}) {
  const toRef = useSearchResultFileRef();
  const match = GREP_LINE_PATTERN.exec(line);
  const [prefix, path, , lineText] = match ?? [];
  // A file name must contain a dot or slash; a bare `12:` is a single-file grep.
  if (!prefix || !path || !lineText || !/[./]/.test(path)) {
    return <>{line}</>;
  }
  return (
    <>
      <FileOpenButton
        fileRef={toRef(path, searchRoot, Number.parseInt(lineText, 10))}
        className="grep-line-link"
      >
        {prefix.slice(0, -1)}
      </FileOpenButton>
      {line.slice(prefix.length - 1)}
    </>
  );
}
