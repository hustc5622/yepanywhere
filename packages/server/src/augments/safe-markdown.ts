import { parseLineColumn, splitTextWithFilePaths } from "@yep-anywhere/shared";
import {
  Marked,
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
 * The client maps project-local paths to FileViewer and can fetch configured
 * local text files through /api/local-file.
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
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
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

/**
 * GitHub-style slugger state for heading ids. Reset per render so ids stay
 * stable within a single document but don't collide across documents.
 */
const headingSlugs = new Map<string, number>();

/**
 * Turn a heading's raw text into a stable, url-safe slug.
 * Keeps CJK characters and word characters, drops markdown/emphasis markers
 * and HTML tags, and collapses whitespace to dashes.
 */
function slugify(text: string): string {
  const cleaned = text
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\w一-鿿\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "section";
}

/** Match fenced ```mermaid code blocks produced by marked (after sanitize). */
const MERMAID_BLOCK_RE =
  /<pre><code class="language-mermaid(?:\s[^"]*)?">([\s\S]*?)<\/code><\/pre>/g;

const MARKDOWN_SANITIZE_OPTIONS = {
  allowedTags: [
    "a",
    "blockquote",
    "br",
    "code",
    "del",
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
    div: ["class"],
    h1: ["id"],
    h2: ["id"],
    h3: ["id"],
    h4: ["id"],
    h5: ["id"],
    h6: ["id"],
    img: ["src", "alt", "title"],
    input: ["type", "checked", "disabled"],
    ol: ["start"],
    span: ["class"],
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

const renderer: RendererObject<string, string> = {
  html({ text }) {
    // Disable raw HTML passthrough from markdown by escaping it.
    return escapeHtml(text);
  },
  text({ text }: Tokens.Text | Tokens.Escape) {
    return renderTextWithLocalMediaLinks(text);
  },
  link(
    this: RendererThis<string, string>,
    { href, title, tokens }: Tokens.Link,
  ) {
    // Check for local file paths first — rewrite to clickable media placeholder
    if (isLocalFilePath(href)) {
      const ext = getExtension(href);
      const renderedText = this.parser.parseInline(tokens);

      if (MEDIA_EXTENSIONS.has(ext)) {
        return renderLocalMediaLink(href, renderedText, ext);
      }
      return renderLocalTextFileLink(href, renderedText, title);
    }

    const safeHref = sanitizeUrl(href);
    const renderedText = this.parser.parseInline(tokens);

    if (!safeHref) {
      // Keep readable text when URL protocol is unsafe.
      return renderedText;
    }

    const escapedHref = escapeHtml(safeHref);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapedHref}"${titleAttr}>${renderedText}</a>`;
  },
  image({ href, title, text }: Tokens.Image) {
    // Check for local file paths first — rewrite to clickable media placeholder
    if (isLocalFilePath(href)) {
      const ext = getExtension(href);

      if (MEDIA_EXTENSIONS.has(ext)) {
        return renderLocalMediaLink(href, text, ext);
      }
      // Unrecognized extension — just show text
      return escapeHtml(text || getFileName(href));
    }

    const safeSrc = sanitizeUrl(href, ALLOWED_IMAGE_PROTOCOLS);
    if (!safeSrc) {
      return escapeHtml(text);
    }

    const escapedSrc = escapeHtml(safeSrc);
    const altAttr = text ? ` alt="${escapeHtml(text)}"` : ' alt=""';
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapedSrc}"${altAttr}${titleAttr}>`;
  },
  heading(
    this: RendererThis<string, string>,
    { tokens, depth, text }: Tokens.Heading,
  ) {
    const inner = this.parser.parseInline(tokens);
    const base = slugify(text);
    const count = headingSlugs.get(base) ?? 0;
    const id = count === 0 ? base : `${base}-${count + 1}`;
    headingSlugs.set(base, count + 1);
    return `<h${depth} id="${escapeHtml(id)}" class="md-heading">${inner}<a class="md-heading-anchor" href="#${escapeHtml(id)}" aria-hidden="true" tabindex="-1">#</a></h${depth}>\n`;
  },
};

const markdownRenderer = new Marked({
  async: false,
  gfm: true,
});

markdownRenderer.use({ renderer });

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
export function renderSafeMarkdown(markdown: string): string {
  // Reset per-document slug state so heading ids are unique within a file.
  headingSlugs.clear();
  const rendered = markdownRenderer.parse(markdown, { async: false });
  const html = typeof rendered === "string" ? rendered : "";
  const sanitized = sanitizeHtml(html, MARKDOWN_SANITIZE_OPTIONS);
  // Promote ```mermaid fenced blocks to <div class="mermaid"> for client rendering.
  const withMermaid = sanitized.replace(
    MERMAID_BLOCK_RE,
    (_match, code: string) => `<div class="mermaid">${code}</div>`,
  );
  return withMermaid.trim();
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
