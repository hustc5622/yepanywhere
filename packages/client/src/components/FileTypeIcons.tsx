// File-type icons rendered with lucide-react, tinted with VSCode-style
// language/brand colors. Most types are single-color vector glyphs that stay
// crisp at any size; markdown uses a filled document with a bold "MD" label so
// it's instantly recognizable and distinct from the outline FileText icons.

import {
  AudioLines,
  Binary,
  Boxes,
  Cpu,
  Database,
  FileArchive,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  Film,
  Folder,
  FolderOpen,
  GitBranch,
  KeyRound,
  Lock,
  Map as MapIcon,
  Network,
  Package,
  Presentation,
  ScrollText,
  Settings2,
  Table2,
  Type,
  Wrench,
} from "lucide-react";
import type React from "react";

export const ICON_SIZE = 16;

/** VSCode / language identity colors per file-type key. */
export const ICON_COLORS = {
  folder: "#dcb67a",
  python: "#3776ab",
  javascript: "#e8a418",
  typescript: "#3178c6",
  rust: "#dea584",
  go: "#00add8",
  java: "#ed8b00",
  cpp: "#00599c",
  csharp: "#9b4f96",
  ruby: "#cc342d",
  php: "#777bb4",
  swift: "#f05138",
  kotlin: "#7f52ff",
  scala: "#dc322f",
  lua: "#000080",
  r: "#276dc3",
  shell: "#89e051",
  html: "#e34f26",
  css: "#1572b6",
  vue: "#41b883",
  svelte: "#ff3e00",
  json: "#cbcb41",
  yaml: "#cb171e",
  xml: "#e37933",
  svg: "#ffb13b",
  config: "#6d8086",
  tsconfig: "#3178c6",
  sql: "#e38c00",
  graphql: "#e10098",
  package: "#cb3837",
  env: "#ecd53f",
  docker: "#2496ed",
  build: "#67809c",
  license: "#a4aa04",
  markdown: "#083fa1",
  text: "#6d8086",
  pdf: "#f40f02",
  word: "#2b579a",
  excel: "#217746",
  powerpoint: "#d24726",
  git: "#f14e32",
  system: "#9aa0a6",
  image: "#a074c4",
  archive: "#ac733c",
  binary: "#757575",
  font: "#1a6b9b",
  audio: "#0071bc",
  video: "#ff5050",
  map: "#ffc107",
  key: "#e37933",
  default: "#9aa0a6",
} satisfies Record<string, string>;

type LucideIcon = React.ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
  className?: string;
}>;

/** Colored lucide glyph factory. */
function make(color: string, Icon: LucideIcon, strokeWidth = 2) {
  return () => (
    <Icon size={ICON_SIZE} color={color} strokeWidth={strokeWidth} />
  );
}

export function FolderIconV2({
  isOpen,
}: { isOpen?: boolean }): React.JSX.Element {
  const Icon = isOpen ? FolderOpen : Folder;
  return <Icon size={ICON_SIZE} color={ICON_COLORS.folder} strokeWidth={2} />;
}

/**
 * Markdown icon: a solid Markdown-blue document with a bold white "MD" label.
 * Filled + lettered so it's instantly recognizable and clearly distinct from
 * the outline FileText used by word/pdf/text.
 */
export function MarkdownIcon(): React.JSX.Element {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
        fill={ICON_COLORS.markdown}
      />
      <text
        x="12"
        y="15.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="9"
        fontWeight="700"
        fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        fill="#ffffff"
      >
        MD
      </text>
    </svg>
  );
}

type IconFactory = () => React.JSX.Element;

/** Lucide-based icon map keyed by the same strings as fileIconKey(). */
export const FILE_ICONS_V2: Record<string, IconFactory> & {
  default: IconFactory;
} = {
  folder: () => <FolderIconV2 />,
  python: make(ICON_COLORS.python, FileCode2),
  javascript: make(ICON_COLORS.javascript, FileCode2),
  typescript: make(ICON_COLORS.typescript, FileCode2),
  tsx: make(ICON_COLORS.typescript, FileCode2),
  jsx: make(ICON_COLORS.javascript, FileCode2),
  rust: make(ICON_COLORS.rust, FileCode2),
  go: make(ICON_COLORS.go, FileCode2),
  java: make(ICON_COLORS.java, FileCode2),
  cpp: make(ICON_COLORS.cpp, FileCode2),
  csharp: make(ICON_COLORS.csharp, FileCode2),
  ruby: make(ICON_COLORS.ruby, FileCode2),
  php: make(ICON_COLORS.php, FileCode2),
  swift: make(ICON_COLORS.swift, FileCode2),
  kotlin: make(ICON_COLORS.kotlin, FileCode2),
  scala: make(ICON_COLORS.scala, FileCode2),
  lua: make(ICON_COLORS.lua, FileCode2),
  r: make(ICON_COLORS.r, FileCode2),
  shell: make(ICON_COLORS.shell, FileCode2),
  html: make(ICON_COLORS.html, FileCode2),
  css: make(ICON_COLORS.css, FileCode2),
  vue: make(ICON_COLORS.vue, FileCode2),
  svelte: make(ICON_COLORS.svelte, FileCode2),
  json: make(ICON_COLORS.json, FileJson),
  yaml: make(ICON_COLORS.yaml, FileCode2),
  xml: make(ICON_COLORS.xml, FileCode2),
  svg: make(ICON_COLORS.svg, FileImage),
  config: make(ICON_COLORS.config, Settings2),
  tsconfig: make(ICON_COLORS.tsconfig, FileJson),
  sql: make(ICON_COLORS.sql, Database),
  graphql: make(ICON_COLORS.graphql, Network),
  package: make(ICON_COLORS.package, Package),
  env: make(ICON_COLORS.env, Lock),
  docker: make(ICON_COLORS.docker, Boxes),
  build: make(ICON_COLORS.build, Wrench),
  license: make(ICON_COLORS.license, ScrollText),
  markdown: MarkdownIcon,
  text: make(ICON_COLORS.text, FileText),
  pdf: make(ICON_COLORS.pdf, FileText),
  word: make(ICON_COLORS.word, FileText),
  excel: make(ICON_COLORS.excel, Table2),
  powerpoint: make(ICON_COLORS.powerpoint, Presentation),
  git: make(ICON_COLORS.git, GitBranch),
  system: make(ICON_COLORS.system, Cpu),
  image: make(ICON_COLORS.image, FileImage),
  archive: make(ICON_COLORS.archive, FileArchive),
  binary: make(ICON_COLORS.binary, Binary),
  font: make(ICON_COLORS.font, Type),
  audio: make(ICON_COLORS.audio, AudioLines),
  video: make(ICON_COLORS.video, Film),
  map: make(ICON_COLORS.map, MapIcon),
  key: make(ICON_COLORS.key, KeyRound),
  default: make(ICON_COLORS.default, FileText),
};
