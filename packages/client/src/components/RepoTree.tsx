import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import type { ProjectBrowseEntry, ProjectBrowseResponse } from "../api/client";
import { api } from "../api/client";
import { useProjectFileWatch } from "../hooks/useProjectFileWatch";
import { useI18n } from "../i18n";
import { FILE_ICONS_V2, FolderIconV2 } from "./FileTypeIcons";

// ─── File type detection ───────────────────────────────────────────────

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Icon category derived from file name / extension. */
function fileIconKey(entry: ProjectBrowseEntry): string {
  if (entry.type === "dir") return "folder";
  const name = entry.name.toLowerCase();
  // Special filenames (no extension or well-known names)
  if (name === ".gitignore" || name === ".gitattributes") return "git";
  if (name === ".ds_store" || name === "thumbs.db") return "system";
  if (name === ".env" || name === ".env.local" || name === ".env.production")
    return "env";
  if (
    name === "dockerfile" ||
    name === "docker-compose.yml" ||
    name === "docker-compose.yaml"
  )
    return "docker";
  if (name === "makefile" || name === "cmakelists.txt") return "build";
  if (name === "license" || name === "licence" || name.endsWith(".license"))
    return "license";
  if (name === "readme" || name === "changelog" || name === "contributing")
    return "markdown";
  if (name === ".eslintrc" || name === ".eslintrc.js" || name === ".prettierrc")
    return "config";
  if (name === "tsconfig.json" || name === "jsconfig.json") return "tsconfig";
  if (
    name === "package.json" ||
    name === "package-lock.json" ||
    name === "yarn.lock" ||
    name === "pnpm-lock.yaml"
  )
    return "package";

  const ext = getFileExtension(name);
  // Programming languages
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext))
    return "javascript";
  if (["py", "pyw", "ipy"].includes(ext)) return "python";
  if (["rs"].includes(ext)) return "rust";
  if (["go"].includes(ext)) return "go";
  if (["java", "jsp"].includes(ext)) return "java";
  if (["kt", "kts"].includes(ext)) return "kotlin";
  if (["c", "h", "cpp", "hpp", "cc", "cxx"].includes(ext)) return "cpp";
  if (["cs", "csx"].includes(ext)) return "csharp";
  if (["rb"].includes(ext)) return "ruby";
  if (["php"].includes(ext)) return "php";
  if (["swift"].includes(ext)) return "swift";
  if (["scala", "sc"].includes(ext)) return "scala";
  if (["lua"].includes(ext)) return "lua";
  if (["r", "R"].includes(ext)) return "r";
  if (["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"].includes(ext))
    return "shell";
  if (["html", "htm", "shtml"].includes(ext)) return "html";
  if (["css", "scss", "sass", "less"].includes(ext)) return "css";
  if (["vue"].includes(ext)) return "vue";
  if (["svelte"].includes(ext)) return "svelte";
  if (["jsx", "tsx"].includes(ext)) return ext; // already handled above but be explicit

  // Data / markup
  if (["json", "jsonc", "json5"].includes(ext)) return "json";
  if (["yaml", "yml"].includes(ext)) return "yaml";
  if (["xml", "xsd", "xsl", "svg"].includes(ext)) return ext;
  if (["toml", "ini", "cfg", "conf", "properties"].includes(ext))
    return "config";
  if (["sql"].includes(ext)) return "sql";
  if (["graphql", "gql"].includes(ext)) return "graphql";
  if (["md", "mdx", "markdown", "rst", "adoc"].includes(ext)) return "markdown";
  if (["txt", "text", "log"].includes(ext)) return "text";

  // Documents
  if (["pdf"].includes(ext)) return "pdf";
  if (["doc", "docx", "rtf", "odt"].includes(ext)) return "word";
  if (["xls", "xlsx", "ods", "csv", "tsv"].includes(ext)) return "excel";
  if (["ppt", "pptx", "odp"].includes(ext)) return "powerpoint";

  // Images
  if (
    [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "bmp",
      "ico",
      "webp",
      "avif",
      "tiff",
      "tif",
      "psd",
      "heic",
      "heif",
    ].includes(ext)
  )
    return "image";
  if (["svg"].includes(ext)) return "svg";

  // Archives / binary
  if (["zip", "tar", "gz", "rar", "7z", "bz2", "xz", "tgz"].includes(ext))
    return "archive";
  if (
    [
      "exe",
      "msi",
      "dll",
      "so",
      "dylib",
      "a",
      "o",
      "out",
      "bin",
      "app",
      "dmg",
      "deb",
      "rpm",
    ].includes(ext)
  )
    return "binary";
  if (["ttf", "otf", "woff", "woff2", "eot"].includes(ext)) return "font";
  if (["mp3", "wav", "ogg", "flac", "m4a", "aac", "wma"].includes(ext))
    return "audio";
  if (["mp4", "webm", "mkv", "avi", "mov", "wmv", "flv", "m4v"].includes(ext))
    return "video";

  // Other common
  if (["map", "lock"].includes(ext)) return "map";
  if (["key", "pem", "crt", "cer", "pub"].includes(ext)) return "key";

  return "default";
}

const FILE_ICONS = FILE_ICONS_V2;

/** Returns the correct icon component for a given tree entry. */
function getFileIcon(entry: ProjectBrowseEntry): React.JSX.Element {
  const key = fileIconKey(entry);
  const iconFn = FILE_ICONS[key];
  if (iconFn) return iconFn();
  return FILE_ICONS.default();
}

interface RepoTreeProps {
  projectId: string;
  /** Open a file (relative path) — handled by the parent page. */
  onOpenFile?: (filePath: string) => void;
}

interface DirState {
  entries?: ProjectBrowseEntry[];
  loading: boolean;
  error?: string;
}

/**
 * RepoTree — a VS Code-style repository file tree.
 *
 * Folders expand inline (click to toggle) and their children are loaded
 * lazily on first expansion. Unlike the old drill-down explorer there is no
 * "enter folder / go back" navigation; the whole tree stays in one place.
 */
export function RepoTree({ projectId, onOpenFile }: RepoTreeProps) {
  const { t } = useI18n();
  // Map of directory relative path -> loaded state. The root ("") is always
  // present once loaded; expanded dirs get an entry here too.
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadDir = useCallback(
    (relativePath: string) => {
      setDirs((prev) => ({ ...prev, [relativePath]: { loading: true } }));
      api
        .browseProjectFiles(projectId, relativePath)
        .then((data: ProjectBrowseResponse) => {
          setDirs((prev) => ({
            ...prev,
            [relativePath]: {
              loading: false,
              entries: sortEntries(data.entries),
              error: data.error,
            },
          }));
        })
        .catch(() => {
          setDirs((prev) => ({
            ...prev,
            [relativePath]: { loading: false, error: t("repoError" as never) },
          }));
        });
    },
    [projectId, t],
  );

  // Load the root on mount.
  useEffect(() => {
    loadDir("");
  }, [loadDir]);

  const toggle = useCallback(
    (entry: ProjectBrowseEntry) => {
      if (entry.type !== "dir") {
        onOpenFile?.(entry.path);
        return;
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
          setDirs((cur) => {
            if (!cur[entry.path]) loadDir(entry.path);
            return cur;
          });
        }
        return next;
      });
    },
    [onOpenFile, loadDir],
  );

  // Refresh every currently-visible directory (root + expanded) in real time
  // when the project repository changes.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const refreshVisible = useCallback(() => {
    loadDir("");
    for (const dirPath of expandedRef.current) {
      loadDir(dirPath);
    }
  }, [loadDir]);
  useProjectFileWatch(projectId, refreshVisible);

  const root = dirs[""];

  return (
    <div className="repo-tree">
      {!root ? (
        <div className="repo-tree-loading">{t("repoLoading" as never)}</div>
      ) : root.error ? (
        <div className="repo-tree-error">{root.error}</div>
      ) : root.entries && root.entries.length === 0 ? (
        <div className="repo-tree-empty">{t("repoEmpty" as never)}</div>
      ) : (
        <ul className="repo-tree-list" role="tree">
          {root.entries?.map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              dirs={dirs}
              expanded={expanded}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface TreeNodeProps {
  entry: ProjectBrowseEntry;
  depth: number;
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  onToggle: (entry: ProjectBrowseEntry) => void;
}

function TreeNode({ entry, depth, dirs, expanded, onToggle }: TreeNodeProps) {
  const isDir = entry.type === "dir";
  const isOpen = isDir && expanded.has(entry.path);
  const dirState = isOpen ? dirs[entry.path] : undefined;

  return (
    <li role="treeitem" aria-expanded={isDir ? isOpen : undefined}>
      <button
        type="button"
        className={`repo-tree-item repo-tree-item--${entry.type}${isOpen ? " is-open" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onToggle(entry)}
        title={entry.path}
      >
        <span className="repo-tree-item-icon" aria-hidden="true">
          {isDir ? (
            isOpen ? (
              <FolderIconV2 isOpen />
            ) : (
              <FolderIconV2 />
            )
          ) : (
            getFileIcon(entry)
          )}
        </span>
        <span className="repo-tree-item-name">{entry.name}</span>
        {!isDir && typeof entry.size === "number" && (
          <span className="repo-tree-item-meta">{formatSize(entry.size)}</span>
        )}
      </button>
      {isOpen && (
        <ul className="repo-tree-list" role="group">
          {dirState?.loading ? (
            <li className="repo-tree-loading repo-tree-child">{""}</li>
          ) : dirState?.error ? (
            <li className="repo-tree-error repo-tree-child">
              {dirState.error}
            </li>
          ) : dirState?.entries && dirState.entries.length === 0 ? (
            <li className="repo-tree-empty repo-tree-child">{""}</li>
          ) : (
            dirState?.entries?.map((child) => (
              <TreeNode
                key={child.path}
                entry={child}
                depth={depth + 1}
                dirs={dirs}
                expanded={expanded}
                onToggle={onToggle}
              />
            ))
          )}
        </ul>
      )}
    </li>
  );
}

function sortEntries(entries: ProjectBrowseEntry[]): ProjectBrowseEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
