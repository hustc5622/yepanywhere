import {
  isLikelyFilePath,
  parseLineColumn,
  splitTextWithFilePaths,
} from "@yep-anywhere/shared";
import {
  Marked,
  Renderer,
  type RendererObject,
  type RendererThis,
  type Tokens,
} from "marked";
import sanitizeHtml from "sanitize-html";

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const ALLOWED_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "svg",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv", "ogv"]);

const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

export interface SafeMarkdownOptions {
  /** Resolve a non-HTTP image reference in a trusted, caller-specific scope. */
  resolveImageUrl?: (href: string) => string | null;
  /**
   * How links are rendered.
   * - `message` (default): chat transcripts keep the original link source
   *   visible and turn relative file paths into links that the transcript
   *   click handler resolves against the session project.
   * - `document`: file previews render standard Markdown link labels. Relative
   *   destinations stay inert text because they belong to the previewed
   *   document's directory and no preview click handler resolves them.
   */
  linkStyle?: "message" | "document";
}

/**
 * Check if a string looks like an absolute local file path.
 * Must start with / (but not //) and contain a file extension.
 */
function isLocalFilePath(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return false;
  // Must have a file extension after the last /
  const basename = trimmed.split("/").pop() ?? "";
  return basename.includes(".");
}

/** Relative file links are resolved against the session project by the client. */
function getRelativeFilePath(href: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.trim());
  } catch {
    return null;
  }
  const { path } = parseLineColumn(decoded);
  if (
    !path ||
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    /^[\/~]/.test(path) ||
    /[?#\\\p{C}]/u.test(path)
  ) {
    return null;
  }
  return isLikelyFilePath(path) ? decoded : null;
}

/**
 * Get the file extension from a path (lowercase, without the dot).
 */
function getExtension(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

/**
 * Get the filename from a path.
 */
function getFileName(path: string): string {
  return path.trim().split("/").pop() ?? path;
}

/**
 * Rewrite a local media path to the local-image API endpoint.
 */
function localMediaApiUrl(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(path.trim())}`;
}

function localTextFileApiUrl(
  path: string,
  line?: number,
  column?: number,
): string {
  const params = new URLSearchParams({ path: path.trim() });
  if (line !== undefined) params.set("line", String(line));
  if (column !== undefined) params.set("column", String(column));
  return `/api/local-file?${params.toString()}`;
}

/**
 * Render a local media file as a clickable placeholder link.
 * The client intercepts clicks on .local-media-link to open a modal.
 */
function renderLocalMediaLink(
  path: string,
  label: string,
  ext: string,
): string {
  const apiUrl = escapeHtml(localMediaApiUrl(path));
  const escapedLabel = escapeHtml(label || getFileName(path));
  const mediaType = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  const typeLabel = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  return `<a href="${apiUrl}" class="local-media-link" data-media-type="${mediaType}">${escapedLabel}<span class="local-media-type">(${typeLabel})</span></a>`;
}

/**
 * Render a local text file link without routing it through the media endpoint.
 * The client maps project-local paths to FileViewer and can fetch other
 * local text files through /api/local-file without a project or session scope.
 */
function renderLocalTextFileLink(
  rawPath: string,
  renderedText: string,
  title?: string | null,
): string {
  const parsed = parseLineColumn(rawPath.trim());
  const apiUrl = escapeHtml(
    localTextFileApiUrl(parsed.path, parsed.line, parsed.column),
  );
  const dataAttrs = [
    `data-file-path="${escapeHtml(parsed.path)}"`,
    parsed.line !== undefined ? `data-line="${parsed.line}"` : "",
    parsed.column !== undefined ? `data-column="${parsed.column}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const titleAttr = ` title="${escapeHtml(title || rawPath)}"`;
  return `<a href="${apiUrl}" class="local-file-link" ${dataAttrs}${titleAttr}>${renderedText}</a>`;
}

function renderTextWithLocalMediaLinks(text: string): string {
  return splitTextWithFilePaths(text)
    .map((segment) => {
      if (segment.type === "text") {
        return escapeHtml(segment.content);
      }

      const path = segment.detected.filePath;
      if (!isLocalFilePath(path)) {
        return escapeHtml(segment.detected.match);
      }

      const ext = getExtension(path);
      if (!MEDIA_EXTENSIONS.has(ext)) {
        return escapeHtml(segment.detected.match);
      }

      return renderLocalMediaLink(path, segment.detected.match, ext);
    })
    .join("");
}

const MARKDOWN_SANITIZE_OPTIONS = {
  allowedTags: [
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "details",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "input",
    "li",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "summary",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  allowedAttributes: {
    a: [
      "href",
      "title",
      "class",
      "data-media-type",
      "data-file-path",
      "data-line",
      "data-column",
    ],
    code: ["class"],
    details: ["class", "open"],
    div: ["class", "tabindex"],
    img: ["src", "alt", "title"],
    input: ["type", "checked", "disabled"],
    ol: ["start"],
    span: ["class"],
    summary: ["class"],
    td: ["align"],
    th: ["align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
    img: ["http", "https"],
  },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "escape" as const,
};

const DETAILS_PLACEHOLDER_PREFIX = "YEP_MARKDOWN_DETAILS_BLOCK_";
const MAX_DETAILS_DEPTH = 8;

function sanitizeResolvedImageUrl(url: string): string | null {
  const trimmed = url.trim();
  if (
    !trimmed ||
    /\p{C}/u.test(trimmed) ||
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//")
  ) {
    return null;
  }
  return trimmed;
}

function createRenderer(
  options: SafeMarkdownOptions = {},
): RendererObject<string, string> {
  return {
    table(this: RendererThis<string, string>, token: Tokens.Table) {
      // Preserve GFM cells/alignment and isolate wide tables from page scrolling.
      const renderer = new Renderer();
      renderer.parser = this.parser;
      return `<div class="markdown-table-wrapper" tabindex="0">${renderer.table(token)}</div>\n`;
    },
    html({ text }) {
      // Disable raw HTML passthrough from markdown by escaping it.
      return escapeHtml(text);
    },
    text(
      this: RendererThis<string, string>,
      token: Tokens.Text | Tokens.Escape,
    ) {
      // Tight list items contain a text token with already-parsed inline
      // children. Preserve those links/emphasis instead of escaping raw syntax.
      if ("tokens" in token && token.tokens) {
        return this.parser.parseInline(token.tokens);
      }
      return renderTextWithLocalMediaLinks(token.text);
    },
    link(this: RendererThis<string, string>, token: Tokens.Link) {
      const { href, title } = token;
      if (options.linkStyle === "document") {
        return renderDocumentLink(this.parser.parseInline(token.tokens), token);
      }
      // Add navigation to the original source instead of replacing it with
      // the label: destinations, titles and inline syntax stay visible.
      const source = getLinkSource(token);
      const renderedText = escapeHtml(source);
      // Check for local file paths first — rewrite to clickable media placeholder
      if (isLocalFilePath(href)) {
        const ext = getExtension(href);
        if (MEDIA_EXTENSIONS.has(ext)) {
          return renderLocalMediaLink(href, source, ext);
        }
        return renderLocalTextFileLink(href, renderedText, title);
      }

      const relativePath = getRelativeFilePath(href);
      if (relativePath) {
        return renderLocalTextFileLink(relativePath, renderedText, title);
      }

      const safeHref = sanitizeUrl(href);
      if (!safeHref) {
        // An unsupported destination must not erase the original path/URL.
        // Escape the entire token so unsafe protocols remain inert text.
        return renderedText;
      }

      const escapedHref = escapeHtml(safeHref);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapedHref}"${titleAttr}>${renderedText}</a>`;
    },
    image(token: Tokens.Image) {
      const { href, title, text } = token;
      const documentStyle = options.linkStyle === "document";
      // Check for local file paths first — rewrite to clickable media placeholder
      if (isLocalFilePath(href)) {
        const ext = getExtension(href);

        if (MEDIA_EXTENSIONS.has(ext)) {
          return renderLocalMediaLink(
            href,
            documentStyle ? text : getLinkSource(token),
            ext,
          );
        }
        return escapeHtml(
          documentStyle ? text || getFileName(href) : getLinkSource(token),
        );
      }

      const safeSrc =
        sanitizeUrl(href, ALLOWED_IMAGE_PROTOCOLS) ??
        (options.resolveImageUrl
          ? sanitizeResolvedImageUrl(options.resolveImageUrl(href) ?? "")
          : null);
      if (!safeSrc) {
        if (documentStyle) return escapeHtml(text);
        const relativePath = getRelativeFilePath(href);
        if (relativePath) {
          return renderLocalTextFileLink(
            relativePath,
            escapeHtml(getLinkSource(token)),
            title,
          );
        }
        return escapeHtml(getLinkSource(token));
      }

      const escapedSrc = escapeHtml(safeSrc);
      const altAttr = text ? ` alt="${escapeHtml(text)}"` : ' alt=""';
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapedSrc}"${altAttr}${titleAttr}>`;
    },
  };
}

/** Standard Markdown link rendering for previewed documents. */
function renderDocumentLink(renderedLabel: string, token: Tokens.Link): string {
  const { href, title } = token;
  if (isLocalFilePath(href)) {
    const ext = getExtension(href);
    if (MEDIA_EXTENSIONS.has(ext)) {
      return renderLocalMediaLink(href, token.text, ext);
    }
    return renderLocalTextFileLink(href, renderedLabel, title);
  }
  const safeHref = sanitizeUrl(href);
  if (!safeHref) return renderedLabel;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safeHref)}"${titleAttr}>${renderedLabel}</a>`;
}

function createMarkdownRenderer(options: SafeMarkdownOptions = {}): Marked {
  const instance = new Marked({
    async: false,
    gfm: true,
  });
  instance.use({ renderer: createRenderer(options) });
  return instance;
}

const messageMarkdownRenderer = createMarkdownRenderer();
const documentMarkdownRenderer = createMarkdownRenderer({
  linkStyle: "document",
});

function rendererFor(options: SafeMarkdownOptions): Marked {
  if (options.resolveImageUrl) return createMarkdownRenderer(options);
  return options.linkStyle === "document"
    ? documentMarkdownRenderer
    : messageMarkdownRenderer;
}

/**
 * Return a safe absolute URL for markdown links, or null for unsupported schemes.
 */
export function sanitizeUrl(
  url: string,
  allowedProtocols: ReadonlySet<string> = ALLOWED_LINK_PROTOCOLS,
): string | null {
  const trimmed = url.trim();
  if (!trimmed || /\p{C}/u.test(trimmed)) {
    return null;
  }

  const normalized = trimmed.replace(/\s+/g, "");
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (!allowedProtocols.has(parsed.protocol.toLowerCase())) {
      return null;
    }
  } catch {
    return null;
  }

  return normalized;
}

/**
 * Render markdown to sanitized HTML with raw HTML disabled.
 */
export function renderSafeMarkdown(
  markdown: string,
  options: SafeMarkdownOptions = {},
): string {
  const renderer = rendererFor(options);
  const { markdown: markdownWithPlaceholders, replacements } =
    extractDetailsBlocks(markdown, 0, options);
  const rendered = renderer.parse(markdownWithPlaceholders, {
    async: false,
  });
  const html = typeof rendered === "string" ? rendered : "";
  const sanitized = sanitizeHtml(html, MARKDOWN_SANITIZE_OPTIONS);
  return restoreDetailsBlocks(sanitized, replacements).trim();
}

function renderSafeMarkdownNested(
  markdown: string,
  depth: number,
  options: SafeMarkdownOptions,
): string {
  if (depth > MAX_DETAILS_DEPTH) {
    return renderSafeMarkdownWithoutDetails(markdown, options);
  }

  const renderer = rendererFor(options);
  const { markdown: markdownWithPlaceholders, replacements } =
    extractDetailsBlocks(markdown, depth, options);
  const rendered = renderer.parse(markdownWithPlaceholders, {
    async: false,
  });
  const html = typeof rendered === "string" ? rendered : "";
  const sanitized = sanitizeHtml(html, MARKDOWN_SANITIZE_OPTIONS);
  return restoreDetailsBlocks(sanitized, replacements).trim();
}

function renderSafeMarkdownWithoutDetails(
  markdown: string,
  options: SafeMarkdownOptions,
): string {
  const renderer = rendererFor(options);
  const rendered = renderer.parse(markdown, { async: false });
  const html = typeof rendered === "string" ? rendered : "";
  return sanitizeHtml(html, MARKDOWN_SANITIZE_OPTIONS).trim();
}

export function renderSafeInlineMarkdown(
  markdown: string,
  options: SafeMarkdownOptions = {},
): string {
  const rendered = rendererFor(options).parseInline(markdown, {
    async: false,
  });
  const html = typeof rendered === "string" ? rendered : "";
  return sanitizeHtml(html, MARKDOWN_SANITIZE_OPTIONS);
}

function extractDetailsBlocks(
  markdown: string,
  depth = 0,
  options: SafeMarkdownOptions = {},
): {
  markdown: string;
  replacements: Map<string, string>;
} {
  if (!/<details[\s>]/i.test(markdown)) {
    return { markdown, replacements: new Map() };
  }

  const replacements = new Map<string, string>();
  let result = "";
  let lastIndex = 0;
  let pos = 0;
  let fence: { char: "`" | "~"; length: number } | null = null;

  while (pos < markdown.length) {
    const lineStart = pos;
    const newlineIdx = markdown.indexOf("\n", pos);
    const lineEnd = newlineIdx === -1 ? markdown.length : newlineIdx + 1;
    const line = markdown.slice(lineStart, lineEnd);
    const lineWithoutNewline = line.replace(/\n$/, "");

    if (fence) {
      if (isClosingFenceLine(lineWithoutNewline, fence)) {
        fence = null;
      }
      pos = lineEnd;
      continue;
    }

    const openingFence = getOpeningFence(lineWithoutNewline);
    if (openingFence) {
      fence = openingFence;
      pos = lineEnd;
      continue;
    }

    if (/^\s*<details(?:\s[^>]*)?>/i.test(lineWithoutNewline)) {
      const rest = markdown.slice(lineStart);
      const closeMatch = /<\/details\s*>/i.exec(rest);
      if (closeMatch) {
        const blockStart = lineStart;
        const blockEnd = lineStart + closeMatch.index + closeMatch[0].length;
        const block = markdown.slice(blockStart, blockEnd);
        const renderedDetails = renderDetailsBlock(block, depth, options);
        if (renderedDetails) {
          const placeholder = `${DETAILS_PLACEHOLDER_PREFIX}${replacements.size}__`;
          result += markdown.slice(lastIndex, blockStart);
          result += `\n\n${placeholder}\n\n`;
          replacements.set(placeholder, renderedDetails);
          lastIndex = blockEnd;
          pos = blockEnd;
          continue;
        }
      }
    }

    pos = lineEnd;
  }

  if (replacements.size === 0) {
    return { markdown, replacements };
  }

  result += markdown.slice(lastIndex);
  return { markdown: result, replacements };
}

function renderDetailsBlock(
  block: string,
  depth: number,
  options: SafeMarkdownOptions,
): string | null {
  const match = /^\s*<details([^>]*)>([\s\S]*?)<\/details\s*>\s*$/i.exec(block);
  if (!match) return null;

  const attrs = match[1] ?? "";
  const inner = match[2] ?? "";
  const summaryMatch =
    /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/i.exec(inner);

  const summaryMarkdown = summaryMatch?.[1]?.trim() || "Details";
  const bodyMarkdown = summaryMatch
    ? inner.slice(summaryMatch[0].length).trim()
    : inner.trim();
  const summaryHtml = renderSafeInlineMarkdown(summaryMarkdown, options);
  const bodyHtml = bodyMarkdown
    ? renderSafeMarkdownNested(bodyMarkdown, depth + 1, options)
    : "";
  const openAttr = /\sopen(?:\s*=\s*(?:"open"|'open'|open))?(?=\s|$)/i.test(
    attrs,
  )
    ? " open"
    : "";

  return `<details class="markdown-details"${openAttr}><summary class="markdown-details__summary">${summaryHtml}</summary><div class="markdown-details__content">${bodyHtml}</div></details>`;
}

function restoreDetailsBlocks(
  html: string,
  replacements: ReadonlyMap<string, string>,
): string {
  let restored = html;
  for (const [placeholder, detailsHtml] of replacements) {
    const escaped = escapeRegExp(placeholder);
    restored = restored.replace(
      new RegExp(`<p>\\s*${escaped}\\s*</p>`, "g"),
      detailsHtml,
    );
    restored = restored.replace(new RegExp(escaped, "g"), detailsHtml);
  }
  return restored;
}

function getOpeningFence(
  line: string,
): { char: "`" | "~"; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match?.[1]) return null;
  return {
    char: match[1][0] as "`" | "~",
    length: match[1].length,
  };
}

function isClosingFenceLine(
  line: string,
  fence: { char: "`" | "~"; length: number },
): boolean {
  const trimmed = line.trim();
  const pattern =
    fence.char === "`"
      ? new RegExp(`^\`{${fence.length},}$`)
      : new RegExp(`^~{${fence.length},}$`);
  return pattern.test(trimmed);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLinkSource(token: Tokens.Link | Tokens.Image): string {
  // Reference-style links keep their destination in a separate definition,
  // which Markdown otherwise omits from the rendered output.
  const referenceDestination = token.raw.endsWith("]")
    ? ` (${token.href}${token.title ? ` "${token.title}"` : ""})`
    : "";
  return token.raw + referenceDestination;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export {
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isLocalFilePath,
  localMediaApiUrl,
  localTextFileApiUrl,
};
