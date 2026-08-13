/**
 * IDE metadata tag handling utilities.
 *
 * VSCode extension injects metadata tags like <ide_opened_file> and <ide_selection>
 * into user messages. These utilities help detect, extract, and strip that metadata.
 */

/** Pattern for all IDE metadata tags */
const IDE_TAG_PATTERN = /<ide_(opened_file|selection)>[\s\S]*?<\/ide_\1>/g;

/** Pattern for bridge-injected system context at the start of a user message. */
const SYSTEM_CONTEXT_PATTERN =
  /^\s*\[System Context\][\s\S]*?\[\/System Context\]\s*/;

/** Pattern for bridge-injected local timestamp prefixes after system context. */
const BRIDGE_TIMESTAMP_PREFIX_PATTERN =
  /^\s*\[\d{4}[/-]\d{1,2}[/-]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?\]\s*/;

const CODEX_BROWSER_CONTEXT_PATTERN =
  /<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi;
const CODEX_FILES_SECTION_PATTERN =
  /(?:^|\n)\s*# Files mentioned by the user:\s*\n([\s\S]*?)(?=\n\s*(?:<in-app-browser-context\b|## My request:)|$)/i;
const CODEX_REQUEST_MARKER_PATTERN = /(?:^|\n)\s*## My request:\s*(?:\n|$)/i;
const CODEX_MENTIONED_FILE_PATTERN = /^\s*##\s+(.+?):\s+(.+?)\s*$/gm;

/** Pattern specifically for ide_opened_file tags */
const OPENED_FILE_TAG_PATTERN =
  /<ide_opened_file>([\s\S]*?)<\/ide_opened_file>/g;

/**
 * Check if text block is purely IDE metadata (for skipping in title extraction).
 * Returns true if the trimmed text starts with an IDE metadata tag.
 */
export function isIdeMetadata(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<ide_opened_file>") ||
    trimmed.startsWith("<ide_selection>")
  );
}

/**
 * Strip all IDE metadata tags from text.
 * Returns the text with all <ide_opened_file> and <ide_selection> tags removed.
 */
export function stripIdeMetadata(text: string): string {
  return text.replace(IDE_TAG_PATTERN, "").trim();
}

/**
 * Strip metadata prepended by chat bridges before forwarding user messages.
 *
 * Matrix Lark Bridge prefixes messages with a `[System Context]` block and
 * local timestamp. Those values are useful to the agent, but should not become
 * the session title.
 */
export function stripBridgeMetadata(text: string): string {
  return text
    .replace(SYSTEM_CONTEXT_PATTERN, "")
    .replace(BRIDGE_TIMESTAMP_PREFIX_PATTERN, "")
    .trim();
}

export interface MentionedFile {
  name: string;
  path: string;
}

export interface ParsedUserPromptMetadata {
  text: string;
  mentionedFiles: MentionedFile[];
}

/**
 * Extract the user-visible parts of provider-wrapped prompt text.
 * The original text remains unchanged in provider session storage.
 */
export function parseUserPromptMetadata(
  content: string,
): ParsedUserPromptMetadata {
  const filesSection = CODEX_FILES_SECTION_PATTERN.exec(content);
  const mentionedFiles: MentionedFile[] = [];

  if (filesSection?.[1]) {
    for (const match of filesSection[1].matchAll(
      CODEX_MENTIONED_FILE_PATTERN,
    )) {
      const name = match[1]?.trim();
      const path = match[2]?.trim();
      if (name && path) {
        mentionedFiles.push({ name, path });
      }
    }
  }

  const requestMarker = CODEX_REQUEST_MARKER_PATTERN.exec(content);
  const hasCodexWrapper = Boolean(
    filesSection || CODEX_BROWSER_CONTEXT_PATTERN.test(content),
  );
  CODEX_BROWSER_CONTEXT_PATTERN.lastIndex = 0;
  const visibleContent =
    hasCodexWrapper && requestMarker
      ? content.slice(requestMarker.index + requestMarker[0].length)
      : content.replace(CODEX_FILES_SECTION_PATTERN, "\n");

  return {
    text: visibleContent.replace(CODEX_BROWSER_CONTEXT_PATTERN, "\n").trim(),
    mentionedFiles,
  };
}

/**
 * Extract file path from ide_opened_file tag content.
 * Example: "The user opened the file /path/to/file.ts in the IDE" -> "/path/to/file.ts"
 */
export function extractOpenedFilePath(tagContent: string): string | null {
  const match = tagContent.match(
    /(?:user opened the file|opened the file)\s+(.+?)\s+in the IDE/i,
  );
  return match?.[1] ?? null;
}

/**
 * Parse all opened file paths from content containing ide_opened_file tags.
 */
export function parseOpenedFiles(content: string): string[] {
  const files: string[] = [];
  for (const match of content.matchAll(OPENED_FILE_TAG_PATTERN)) {
    const tagContent = match[1];
    if (tagContent) {
      const filePath = extractOpenedFilePath(tagContent);
      if (filePath) {
        files.push(filePath);
      }
    }
  }
  return files;
}

/**
 * Extract the filename from a full file path.
 */
export function getFilename(path: string): string {
  // Guard against invalid input
  if (!path || typeof path !== "string") return "";

  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}
