import { useCallback, useEffect, useState } from "react";
import type React from "react";
import type { ProjectBrowseEntry, ProjectBrowseResponse } from "../api/client";
import { api } from "../api/client";
import { useI18n } from "../i18n";

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

// ─── Icon components (VS Code / vscode-icons inspired) ────────────────

/** Base size for all icons */
const ICON_SIZE = 16;

interface IconProps {
  size?: number;
  className?: string;
}

/** Helper: create an SVG with consistent attributes */
function S({
  size = ICON_SIZE,
  className,
  children,
  viewBox = "0 0 24 24",
  ...rest
}: IconProps & React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

// ─── Folder icons ─────────────────────────────────────────────────────

function FolderIcon({ isOpen }: { isOpen?: boolean }) {
  return (
    <S viewBox="0 0 24 24">
      {/* Folder tab */}
      <path
        d="M3 7C3 5.89543 3.89543 5 5 5H9L11 7H19C20.1046 7 21 7.89543 21 9V18C21 19.1046 20.1046 20 19 20H5C3.89543 20 3 19.1046 3 18V7Z"
        fill="#dcb67a"
        stroke="#c9a55a"
        strokeWidth="1"
      />
      {/* Front flap - darker for depth */}
      <path
        d="M3 10H21V18C21 19.1046 20.1046 20 19 20H5C3.89543 20 3 19.1046 3 18V10Z"
        fill="#e8c882"
        opacity="0.3"
      />
      {isOpen && (
        <path d="M3 14H21" stroke="#c9a55a" strokeWidth="1" opacity="0.4" />
      )}
    </S>
  );
}

// ��── Code / language icons ────────────────────────────────────────────

function PythonIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#3776ab" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="11"
        fontWeight="bold"
        fill="#ffd43b"
        fontFamily="monospace"
      >
        Py
      </text>
    </S>
  );
}

function JavascriptIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#f7df1e" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="10"
        fontWeight="bold"
        fill="#323330"
        fontFamily="monospace"
      >
        JS
      </text>
    </S>
  );
}

function TypescriptIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#3178c6" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="9"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        TS
      </text>
    </S>
  );
}

function RustIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#dea584" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="10"
        fontWeight="bold"
        fill="#000"
        fontFamily="monospace"
      >
        Rs
      </text>
    </S>
  );
}

function GoIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#00add8" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="11"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        Go
      </text>
    </S>
  );
}

function JavaIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#ed8b00" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="9"
        fontWeight="bold"
        fill="#fff"
        fontFamily="serif"
      >
        Jv
      </text>
    </S>
  );
}

function CppIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#00599c" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="9"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        C++
      </text>
    </S>
  );
}

function CSharpIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#68217a" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="9"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        C#
      </text>
    </S>
  );
}

function RubyIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#cc342d" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="11"
        fontWeight="bold"
        fill="#fff"
        fontFamily="serif"
      >
        Rb
      </text>
    </S>
  );
}

function PhpIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#777bb4" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="10"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        Php
      </text>
    </S>
  );
}

function SwiftIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#f05138" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="9"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        Sw
      </text>
    </S>
  );
}

function KotlinIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#7f52ff" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="8"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        Kt
      </text>
    </S>
  );
}

function ScalaIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#dc322f" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="8"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        Sc
      </text>
    </S>
  );
}

function LuaIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#000080" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="10"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        Lu
      </text>
    </S>
  );
}

function RIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#276dc3" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="12"
        fontWeight="bold"
        fill="#fff"
        fontFamily="serif"
      >
        R
      </text>
    </S>
  );
}

function ShellIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#89e051" />
      <path
        d="M7 9l4 3-4 3"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M15 15h2" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </S>
  );
}

function HtmlIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#e34f26" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="8"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        &lt;/&gt;
      </text>
    </S>
  );
}

function CssIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#1572b6" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="8"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        CSS
      </text>
    </S>
  );
}

function VueIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#41b883" />
      <path d="M12 7L7 16h10L12 7z" fill="#35495e" />
      <path d="M12 7l2.5 4.5h-5L12 7z" fill="#42b883" />
    </S>
  );
}

function SvelteIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#ff3e00" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="8"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        Sv
      </text>
    </S>
  );
}

// ─── Data / config icons ──────────────────────────────────────────────

function JsonIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#cbcb41" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="8"
        fontWeight="bold"
        fill="#333"
        fontFamily="monospace"
      >
        {"{ }"}
      </text>
    </S>
  );
}

function YamlIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#cb171e" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="7"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        YAML
      </text>
    </S>
  );
}

function XmlIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#e37933" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="7"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        XML
      </text>
    </S>
  );
}

function SvgIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#ffb13b" />
      <circle
        cx="12"
        cy="12"
        r="5"
        stroke="#fff"
        strokeWidth="1.5"
        fill="none"
      />
      <path d="M9 12h6M12 9v6" stroke="#fff" strokeWidth="1.5" />
    </S>
  );
}

function ConfigIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#6d8086" />
      <path
        d="M7 8h10M7 12h10M7 16h6"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </S>
  );
}

function TsconfigIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#3178c6" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="6"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        TSCFG
      </text>
    </S>
  );
}

function SqlIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#e38c00" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="7"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        SQL
      </text>
    </S>
  );
}

function GraphqlIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#e10098" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="6"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        GQL
      </text>
    </S>
  );
}

function PackageIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#cb3837" />
      <path
        d="M7 7v10l5 3 5-3V7l-5-3-5 3z"
        stroke="#fff"
        strokeWidth="1.2"
        fill="none"
      />
    </S>
  );
}

function EnvIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#ecd53f" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="8"
        fontWeight="bold"
        fill="#333"
        fontFamily="monospace"
      >
        .ENV
      </text>
    </S>
  );
}

function DockerIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#2496ed" />
      <rect x="7" y="8" width="2.5" height="3" rx="0.5" fill="#fff" />
      <rect x="10.75" y="8" width="2.5" height="3" rx="0.5" fill="#fff" />
      <rect x="14.5" y="8" width="2.5" height="3" rx="0.5" fill="#fff" />
      <rect x="7" y="11.5" width="2.5" height="3" rx="0.5" fill="#fff" />
      <rect x="14.5" y="11.5" width="2.5" height="3" rx="0.5" fill="#fff" />
      <path
        d="M6 16c0-1.5 2-2.5 6-2.5s6 1 6 2.5"
        stroke="#fff"
        strokeWidth="1"
        fill="none"
      />
    </S>
  );
}

function BuildIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#67809c" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="7"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        BUILD
      </text>
    </S>
  );
}

function LicenseIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#a4aa04" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="6"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        LICENSE
      </text>
    </S>
  );
}

// ─── Document icons ───────────────────────────────────────────────────

function MarkdownIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#083fa1" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="7"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        MD
      </text>
      <path
        d="M7 10h3l1.5 2L13 10h3"
        stroke="#fff"
        strokeWidth="1"
        fill="none"
        opacity="0.5"
      />
    </S>
  );
}

function TextIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#6d8086" />
      <path
        d="M7 9h10M7 12.5h7M7 16h4"
        stroke="#fff"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </S>
  );
}

function PdfIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#f40f02" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="8"
        fontWeight="bold"
        fill="#fff"
        fontFamily="serif"
      >
        PDF
      </text>
      {/* Folded corner effect */}
      <path d="M17 3l4 4h-4z" fill="#cc0d00" />
    </S>
  );
}

function WordIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#2b579a" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="7"
        fontWeight="bold"
        fill="#fff"
        fontFamily="sans-serif"
      >
        W
      </text>
      <path d="M17 3l4 4h-4z" fill="#1e3a6e" />
    </S>
  );
}

function ExcelIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#207245" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="8"
        fontWeight="bold"
        fill="#fff"
        fontFamily="sans-serif"
      >
        X
      </text>
      {/* Grid lines hint */}
      <path
        d="M6 10h5M6 13.5h5M12 10h5M12 13.5h5"
        stroke="#fff"
        strokeWidth="0.6"
        opacity="0.4"
      />
      <path d="M17 3l4 4h-4z" fill="#185c33" />
    </S>
  );
}

function PowerpointIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#d24726" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="8"
        fontWeight="bold"
        fill="#fff"
        fontFamily="sans-serif"
      >
        P
      </text>
      <path d="M17 3l4 4h-4z" fill="#a33a1e" />
    </S>
  );
}

// ─── Special / system icons ───────────────────────────────────────────

function GitIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#f05032" />
      <g transform="translate(12,12)">
        <circle cx="-3" cy="-3" r="2" fill="#fff" />
        <circle cx="3" cy="-3" r="2" fill="#fff" />
        <circle cx="0" cy="3.5" r="2" fill="#fff" />
        <line
          x1="-1.5"
          y1="-1.5"
          x2="1.5"
          y2="1.5"
          stroke="#fff"
          strokeWidth="1.2"
        />
        <line
          x1="1.5"
          y1="-1.5"
          x2="0.5"
          y2="1.5"
          stroke="#fff"
          strokeWidth="1.2"
        />
      </g>
    </S>
  );
}

function SystemIcon() {
  return (
    <S>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="2"
        fill="#999"
        opacity="0.4"
      />
      <circle
        cx="12"
        cy="12"
        r="4"
        stroke="#999"
        strokeWidth="1.2"
        fill="none"
      />
      <line x1="12" y1="8" x2="12" y2="10" stroke="#999" strokeWidth="1.2" />
      <line x1="12" y1="14" x2="12" y2="16" stroke="#999" strokeWidth="1.2" />
      <line x1="8" y1="12" x2="10" y2="12" stroke="#999" strokeWidth="1.2" />
      <line x1="14" y1="12" x2="16" y2="12" stroke="#999" strokeWidth="1.2" />
    </S>
  );
}

function ImageIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#a074c4" />
      {/* Simple landscape icon */}
      <circle cx="8.5" cy="10" r="2.5" fill="#fff" opacity="0.8" />
      <path
        d="M5 17l4-4 3 3 3-4 4 5"
        stroke="#fff"
        strokeWidth="1.2"
        fill="none"
        strokeLinejoin="round"
      />
    </S>
  );
}

function ArchiveIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#ac733c" />
      <rect
        x="7"
        y="9"
        width="10"
        height="8"
        rx="1"
        stroke="#fff"
        strokeWidth="1.2"
        fill="none"
      />
      <path d="M10 9V7h4v2" stroke="#fff" strokeWidth="1.2" />
    </S>
  );
}

function BinaryIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#757575" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="7"
        fontWeight="bold"
        fill="#fff"
        fontFamily="monospace"
      >
        0100
      </text>
    </S>
  );
}

function FontIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#1a6b9b" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="14"
        fontWeight="bold"
        fill="#fff"
        fontFamily="serif"
      >
        Aa
      </text>
    </S>
  );
}

function AudioIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#0071bc" />
      <path
        d="M9 9v6M9 9l4-2v10l-4-2zM6 12v0.01M15 12v0.01"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </S>
  );
}

function VideoIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#ff5050" />
      <polygon points="10,8 16,12 10,16" fill="#fff" />
    </S>
  );
}

function MapIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#ffc107" />
      <path
        d="M7 7l3 2 3-2 3 2v9l-3-2-3 2-3-2V7z"
        stroke="#333"
        strokeWidth="1"
        fill="none"
      />
    </S>
  );
}

function KeyIcon() {
  return (
    <S>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#e37933" />
      <circle
        cx="10"
        cy="12"
        r="3"
        stroke="#fff"
        strokeWidth="1.2"
        fill="none"
      />
      <line
        x1="12.5"
        y1="14.5"
        x2="17"
        y2="17"
        stroke="#fff"
        strokeWidth="1.5"
      />
      <line x1="15" y1="15" x2="17" y2="17" stroke="#fff" strokeWidth="1.5" />
    </S>
  );
}

/** Default generic file icon */
function DefaultFileIcon() {
  return (
    <S>
      <path
        d="M5 3h8.5L19 8.5V19a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"
        fill="#e8e8e8"
        stroke="#bbb"
        strokeWidth="1"
      />
      <path d="M13.5 3v5.5H19" fill="#ccc" stroke="#bbb" strokeWidth="1" />
      <path
        d="M7 13h10M7 16h6"
        stroke="#aaa"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </S>
  );
}

// ─── Icon lookup table ────────────────────────────────────────────────

type IconFactory = () => React.JSX.Element;

const FILE_ICONS: Record<string, IconFactory> & { default: IconFactory } = {
  folder: () => <FolderIcon />,
  python: () => <PythonIcon />,
  javascript: () => <JavascriptIcon />,
  typescript: () => <TypescriptIcon />,
  tsx: () => <TypescriptIcon />,
  jsx: () => <JavascriptIcon />,
  rust: () => <RustIcon />,
  go: () => <GoIcon />,
  java: () => <JavaIcon />,
  cpp: () => <CppIcon />,
  csharp: () => <CSharpIcon />,
  ruby: () => <RubyIcon />,
  php: () => <PhpIcon />,
  swift: () => <SwiftIcon />,
  kotlin: () => <KotlinIcon />,
  scala: () => <ScalaIcon />,
  lua: () => <LuaIcon />,
  r: () => <RIcon />,
  shell: () => <ShellIcon />,
  html: () => <HtmlIcon />,
  css: () => <CssIcon />,
  vue: () => <VueIcon />,
  svelte: () => <SvelteIcon />,
  json: () => <JsonIcon />,
  yaml: () => <YamlIcon />,
  xml: () => <XmlIcon />,
  svg: () => <SvgIcon />,
  config: () => <ConfigIcon />,
  tsconfig: () => <TsconfigIcon />,
  sql: () => <SqlIcon />,
  graphql: () => <GraphqlIcon />,
  package: () => <PackageIcon />,
  env: () => <EnvIcon />,
  docker: () => <DockerIcon />,
  build: () => <BuildIcon />,
  license: () => <LicenseIcon />,
  markdown: () => <MarkdownIcon />,
  text: () => <TextIcon />,
  pdf: () => <PdfIcon />,
  word: () => <WordIcon />,
  excel: () => <ExcelIcon />,
  powerpoint: () => <PowerpointIcon />,
  git: () => <GitIcon />,
  system: () => <SystemIcon />,
  image: () => <ImageIcon />,
  archive: () => <ArchiveIcon />,
  binary: () => <BinaryIcon />,
  font: () => <FontIcon />,
  audio: () => <AudioIcon />,
  video: () => <VideoIcon />,
  map: () => <MapIcon />,
  key: () => <KeyIcon />,
  default: () => <DefaultFileIcon />,
};

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
              <FolderIcon isOpen />
            ) : (
              <FolderIcon />
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
