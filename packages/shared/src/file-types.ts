/**
 * Single source of truth for how Yep classifies files for preview.
 *
 * Server routes (`/api/projects/:id/files`, `/api/local-file`,
 * `/api/local-image`), markdown augments, file path detection and client
 * viewers all derive their extension lists from this table. Add a new file
 * type here instead of keeping a local extension set.
 *
 * Syntax-highlighting language ids are intentionally not here: they are
 * shiki-specific and live in `packages/server/src/highlighting`.
 */

/** How a file is shown in the side preview. */
export type PreviewKind =
  | "text"
  | "markdown"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "office"
  | "binary";

export interface FileTypeInfo {
  kind: PreviewKind;
  mimeType: string;
  /** Content is UTF-8 text and may be returned inline (SVG is an image *and* text). */
  isText: boolean;
}

const TEXT_PLAIN = "text/plain";
const OCTET_STREAM = "application/octet-stream";

type Group = {
  kind: PreviewKind;
  isText: boolean;
  /** Extension (lowercase, no dot) → MIME type; `null` uses `defaultMime`. */
  entries: Record<string, string | null>;
  defaultMime: string;
};

const GROUPS: Group[] = [
  {
    kind: "markdown",
    isText: true,
    defaultMime: "text/markdown",
    entries: { md: null, markdown: null, mdx: "text/mdx" },
  },
  {
    kind: "text",
    isText: true,
    defaultMime: TEXT_PLAIN,
    entries: {
      // Documentation / data
      txt: null,
      rst: "text/x-rst",
      log: null,
      csv: "text/csv",
      tsv: "text/tab-separated-values",
      json: "application/json",
      jsonl: "application/x-ndjson",
      ndjson: "application/x-ndjson",
      jsonc: "application/json",
      json5: "application/json5",
      xml: "application/xml",
      yaml: "text/yaml",
      yml: "text/yaml",
      toml: "text/x-toml",
      ini: "text/x-ini",
      conf: null,
      cfg: null,
      env: null,
      properties: null,
      lock: null,
      edn: "application/edn",
      ipynb: "application/x-ipynb+json",
      // TypeScript / JavaScript
      ts: "text/typescript",
      tsx: "text/typescript",
      mts: "text/typescript",
      cts: "text/typescript",
      js: "text/javascript",
      jsx: "text/javascript",
      mjs: "text/javascript",
      cjs: "text/javascript",
      // Web
      html: "text/html",
      htm: "text/html",
      css: "text/css",
      scss: "text/x-scss",
      sass: "text/x-sass",
      less: "text/x-less",
      vue: "text/x-vue",
      svelte: "text/x-svelte",
      astro: "text/x-astro",
      // Shell
      sh: "text/x-shellscript",
      bash: "text/x-shellscript",
      zsh: "text/x-shellscript",
      fish: "text/x-shellscript",
      ps1: "text/x-powershell",
      bat: "text/x-batch",
      cmd: "text/x-batch",
      // Languages
      py: "text/x-python",
      pyi: "text/x-python",
      pyx: "text/x-python",
      rb: "text/x-ruby",
      erb: "text/x-ruby",
      rake: "text/x-ruby",
      go: "text/x-go",
      mod: null,
      sum: null,
      rs: "text/x-rust",
      java: "text/x-java",
      kt: "text/x-kotlin",
      kts: "text/x-kotlin",
      scala: "text/x-scala",
      sbt: "text/x-scala",
      gradle: "text/x-gradle",
      c: "text/x-c",
      h: "text/x-c",
      cpp: "text/x-c++",
      hpp: "text/x-c++",
      cc: "text/x-c++",
      cxx: "text/x-c++",
      hxx: "text/x-c++",
      cs: "text/x-csharp",
      swift: "text/x-swift",
      m: "text/x-objectivec",
      mm: "text/x-objectivec",
      php: "text/x-php",
      pl: "text/x-perl",
      pm: "text/x-perl",
      t: "text/x-perl",
      lua: "text/x-lua",
      r: "text/x-r",
      rmd: "text/x-r",
      jl: "text/x-julia",
      sql: "text/x-sql",
      graphql: "text/x-graphql",
      gql: "text/x-graphql",
      proto: "text/x-protobuf",
      prisma: "text/x-prisma",
      elm: "text/x-elm",
      ex: "text/x-elixir",
      exs: "text/x-elixir",
      erl: "text/x-erlang",
      hrl: "text/x-erlang",
      hs: "text/x-haskell",
      lhs: "text/x-haskell",
      clj: "text/x-clojure",
      cljs: "text/x-clojure",
      cljc: "text/x-clojure",
      ml: "text/x-ocaml",
      mli: "text/x-ocaml",
      fs: "text/x-fsharp",
      fsx: "text/x-fsharp",
      fsi: "text/x-fsharp",
      dart: "text/x-dart",
      nim: "text/x-nim",
      zig: "text/x-zig",
      cr: "text/x-crystal",
      v: "text/x-v",
      sol: "text/x-solidity",
      vim: null,
      el: "text/x-elisp",
      tf: null,
      tfvars: null,
      dockerfile: "text/x-dockerfile",
      makefile: "text/x-makefile",
      cmake: "text/x-cmake",
    },
  },
  {
    kind: "image",
    isText: false,
    defaultMime: OCTET_STREAM,
    entries: {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      tiff: "image/tiff",
      tif: "image/tiff",
      avif: "image/avif",
      ico: "image/x-icon",
    },
  },
  {
    kind: "video",
    isText: false,
    defaultMime: OCTET_STREAM,
    entries: {
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      mkv: "video/x-matroska",
      ogv: "video/ogg",
    },
  },
  {
    kind: "audio",
    isText: false,
    defaultMime: OCTET_STREAM,
    entries: {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      flac: "audio/flac",
      opus: "audio/opus",
    },
  },
  {
    kind: "pdf",
    isText: false,
    defaultMime: "application/pdf",
    entries: { pdf: null },
  },
  {
    kind: "office",
    isText: false,
    defaultMime: OCTET_STREAM,
    entries: {
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      docm: "application/vnd.ms-word.document.macroEnabled.12",
      xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
      pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ppt: "application/vnd.ms-powerpoint",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      odt: "application/vnd.oasis.opendocument.text",
      ods: "application/vnd.oasis.opendocument.spreadsheet",
      odp: "application/vnd.oasis.opendocument.presentation",
      rtf: "application/rtf",
    },
  },
  {
    kind: "binary",
    isText: false,
    defaultMime: OCTET_STREAM,
    entries: {
      zip: "application/zip",
      tar: "application/x-tar",
      gz: "application/gzip",
      tgz: "application/gzip",
      wasm: "application/wasm",
      woff: "font/woff",
      woff2: "font/woff2",
      ttf: "font/ttf",
      otf: "font/otf",
      eot: "application/vnd.ms-fontobject",
    },
  },
];

const FILE_TYPES: ReadonlyMap<string, FileTypeInfo> = (() => {
  const map = new Map<string, FileTypeInfo>();
  for (const group of GROUPS) {
    for (const [ext, mime] of Object.entries(group.entries)) {
      map.set(ext, {
        kind: group.kind,
        mimeType: mime ?? group.defaultMime,
        isText: group.isText,
      });
    }
  }
  // SVG is shown as an image but is XML text underneath.
  map.set("svg", { kind: "image", mimeType: "image/svg+xml", isText: true });
  return map;
})();

/**
 * Extensionless (or dot-only) file names that are plain text. Matched
 * case-insensitively against the basename.
 */
const TEXT_FILENAMES = new Set(
  [
    ".env",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".editorconfig",
    ".prettierrc",
    ".prettierignore",
    ".eslintrc",
    ".eslintignore",
    ".babelrc",
    ".npmrc",
    ".nvmrc",
    ".dockerignore",
    ".browserslistrc",
    ".stylelintrc",
    "dockerfile",
    "makefile",
    "rakefile",
    "gemfile",
    "procfile",
    "vagrantfile",
    "pipfile",
    "license",
  ].map((name) => name.toLowerCase()),
);

/** Basename of a POSIX or Windows path. */
export function getPathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/**
 * Lowercase extension without the dot, following Node's `extname` rules:
 * a leading dot alone (`.env`) is not an extension.
 */
export function getFileExtension(path: string): string {
  const name = getPathBasename(path);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

/** Type information for a path, or `undefined` when the type is unknown. */
export function getFileTypeInfo(path: string): FileTypeInfo | undefined {
  const ext = getFileExtension(path);
  if (ext) return FILE_TYPES.get(ext);
  if (TEXT_FILENAMES.has(getPathBasename(path).toLowerCase())) {
    return { kind: "text", mimeType: TEXT_PLAIN, isText: true };
  }
  return undefined;
}

/** MIME type for a path; unknown types are `application/octet-stream`. */
export function getFileMimeType(path: string): string {
  return getFileTypeInfo(path)?.mimeType ?? OCTET_STREAM;
}

/**
 * Preview kind for a path. A known MIME type (for example from content
 * sniffing) wins for unknown extensions.
 */
export function classifyPreview(path: string, mimeType?: string): PreviewKind {
  const info = getFileTypeInfo(path);
  if (info) return info.kind;
  if (mimeType) {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType === "application/pdf") return "pdf";
    if (mimeType.startsWith("text/")) return "text";
  }
  return "binary";
}

/** Whether a path is UTF-8 text whose content can be shown inline. */
export function isTextFilePath(path: string): boolean {
  return getFileTypeInfo(path)?.isText ?? false;
}

export function isMarkdownFilePath(path: string): boolean {
  return getFileTypeInfo(path)?.kind === "markdown";
}

/**
 * `image` / `video` for paths served by the local media endpoint, otherwise
 * `null`. Audio is deliberately excluded until the viewer supports it.
 */
export function getMediaPreviewKind(path: string): "image" | "video" | null {
  const kind = getFileTypeInfo(path)?.kind;
  return kind === "image" || kind === "video" ? kind : null;
}

/** Every extension in the table (lowercase, no dot), for path detection. */
export function getKnownFileExtensions(): ReadonlySet<string> {
  return new Set(FILE_TYPES.keys());
}

/**
 * Whether a path detected in prose or inline code should become a preview
 * link. Absolute paths need a dotted basename; relative ones need a directory
 * part and a known file type, so words like `and/or` or `src/utils` stay text.
 */
export function isPreviewLinkablePath(path: string): boolean {
  if (path.startsWith("/")) {
    return !path.startsWith("//") && getPathBasename(path).includes(".");
  }
  if (path.startsWith("~")) return false;
  return path.includes("/") && getFileTypeInfo(path) !== undefined;
}
