import {
  parseOpenedFiles,
  parseUserPromptMetadata,
  getFilename as sharedGetFilename,
  stripIdeMetadata,
} from "@yep-anywhere/shared";

/**
 * Uploaded file attachment metadata
 */
export interface UploadedFileInfo {
  originalName: string;
  size: string;
  mimeType: string;
  path: string;
  /** Optional direct preview URL for inline provider attachments (e.g. data: URLs) */
  previewUrl?: string;
}

/**
 * Skill metadata injected by Codex when a named skill is loaded.
 */
export interface SkillInfo {
  name: string;
  path: string;
  description?: string;
  markdown: string;
  raw: string;
}

/**
 * Parsed user prompt with metadata extracted
 */
export interface ParsedUserPrompt {
  /** The actual user message text (without metadata tags) */
  text: string;
  /** Full paths of files the user had open in their IDE */
  openedFiles: string[];
  /** Uploaded file attachments */
  uploadedFiles: UploadedFileInfo[];
  /** Files described by Codex Desktop's prompt wrapper. */
  mentionedFiles: UploadedFileInfo[];
  /** Skill references injected into the prompt */
  skills: SkillInfo[];
}

/**
 * Extracts the filename from a full file path.
 * Re-exported from shared for backward compatibility.
 */
export const getFilename = sharedGetFilename;

/**
 * Parse the "User uploaded files:" section from message content.
 * Format: "- filename (size, mimetype): path"
 */
function parseUploadedFiles(content: string): {
  textWithoutUploads: string;
  uploadedFiles: UploadedFileInfo[];
} {
  const uploadedFiles: UploadedFileInfo[] = [];

  // Match the "User uploaded files:" section
  const uploadMarker = "\n\nUser uploaded files:\n";
  const markerIndex = content.indexOf(uploadMarker);

  if (markerIndex === -1) {
    return { textWithoutUploads: content, uploadedFiles: [] };
  }

  const textWithoutUploads = content.slice(0, markerIndex);
  const uploadSection = content.slice(markerIndex + uploadMarker.length);

  // Parse each line: "- filename (size, mimetype): path"
  const lineRegex = /^- (.+?) \(([^,]+), ([^)]+)\): (.+)$/;
  for (const line of uploadSection.split("\n")) {
    const match = line.match(lineRegex);
    if (match) {
      uploadedFiles.push({
        originalName: match[1] ?? "",
        size: match[2] ?? "",
        mimeType: match[3] ?? "",
        path: match[4] ?? "",
      });
    }
  }

  return { textWithoutUploads, uploadedFiles };
}

const SKILL_BLOCK_PATTERN = /<skill\b[^>]*>([\s\S]*?)<\/skill>/gi;

function extractTagValue(content: string, tagName: string): string {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`,
    "i",
  );
  return pattern.exec(content)?.[1]?.trim() ?? "";
}

function stripSkillXmlHeader(content: string): string {
  return content
    .replace(/<name\b[^>]*>[\s\S]*?<\/name>/i, "")
    .replace(/<path\b[^>]*>[\s\S]*?<\/path>/i, "")
    .trim();
}

function parseFrontmatterDescription(markdown: string): string | undefined {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown);
  const description = frontmatter?.[1]?.match(/^description:\s*(.+)$/m)?.[1];
  return description?.trim().replace(/^["']|["']$/g, "") || undefined;
}

function parseSkillReferences(content: string): {
  textWithoutSkills: string;
  skills: SkillInfo[];
} {
  const skills: SkillInfo[] = [];
  const textWithoutSkills = content.replace(
    SKILL_BLOCK_PATTERN,
    (raw: string, inner: string) => {
      const markdown = stripSkillXmlHeader(inner);
      const name = extractTagValue(inner, "name") || "Unknown skill";
      const path = extractTagValue(inner, "path");

      skills.push({
        name,
        path,
        description: parseFrontmatterDescription(markdown),
        markdown,
        raw: raw.trim(),
      });

      return "\n";
    },
  );

  return { textWithoutSkills, skills };
}

/**
 * Parses user prompt content, extracting ide_opened_file metadata tags
 * and "User uploaded files:" sections.
 * Returns the cleaned text, list of opened file paths, and uploaded files.
 *
 * Also handles <ide_selection> tags by stripping them from the text.
 */
export function parseUserPrompt(content: string): ParsedUserPrompt {
  // First extract uploaded files section
  const { textWithoutUploads, uploadedFiles } = parseUploadedFiles(content);
  const { textWithoutSkills, skills } =
    parseSkillReferences(textWithoutUploads);
  const { text, mentionedFiles: mentionedFileMetadata } =
    parseUserPromptMetadata(textWithoutSkills);
  const mentionedFiles = mentionedFileMetadata.map((file) => ({
    originalName: file.name,
    size: "unknown size",
    mimeType: "application/octet-stream",
    path: file.path,
  }));

  // Then process IDE metadata on the remaining text
  return {
    text: stripIdeMetadata(text),
    openedFiles: parseOpenedFiles(textWithoutSkills),
    uploadedFiles: [...uploadedFiles, ...mentionedFiles],
    mentionedFiles,
    skills,
  };
}
