import {
  parseOpenedFiles,
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
 * Safe, display-oriented summary of metadata appended by the Feishu channel.
 * Raw manifests contain internal refs and diagnostics, so the client exposes
 * only the small amount of provenance that is useful in the conversation UI.
 */
export interface FeishuPromptInfo {
  messageCount: number;
  attachmentCount: number;
  contextMode?: string;
  complete: boolean;
  hasWarnings: boolean;
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
  /** Skill references injected into the prompt */
  skills: SkillInfo[];
  /** Present when the prompt was dispatched through the Feishu channel */
  feishu?: FeishuPromptInfo;
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
const FEISHU_CONTEXT_BLOCK_PATTERN =
  /<feishu_context_manifest>\s*([\s\S]*?)\s*<\/feishu_context_manifest>/gi;
const FEISHU_ATTACHMENT_BLOCK_PATTERN =
  /<feishu_attachment_manifest>\s*([\s\S]*?)\s*<\/feishu_attachment_manifest>/gi;

interface FeishuContextFields {
  messages?: number;
  attachments?: number;
  effectiveMode?: string;
  complete?: boolean;
  warnings: string[];
}

function parseNonNegativeInteger(
  value: string | undefined,
): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseFeishuContextFields(block: string): FeishuContextFields {
  const fields = new Map<string, string>();
  for (const line of block.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim(),
    );
  }

  const warningValue = fields.get("warnings");
  return {
    messages: parseNonNegativeInteger(fields.get("messages")),
    attachments: parseNonNegativeInteger(fields.get("attachments")),
    effectiveMode:
      fields.get("effective_mode") || fields.get("mode") || undefined,
    complete:
      fields.get("complete") === "true"
        ? true
        : fields.get("complete") === "false"
          ? false
          : undefined,
    warnings:
      !warningValue || warningValue.toLowerCase() === "none"
        ? []
        : warningValue
            .split(",")
            .map((warning) => warning.trim())
            .filter(Boolean),
  };
}

function cleanFeishuDisplayText(content: string): string {
  return (
    content
      // Batch headings are transport framing. The compact source row carries
      // the useful message count without making users read prompt syntax.
      .replace(/^\s*##\s+飞书消息\s+\d+\/\d+\s*$/gim, "\n")
      // Feishu's normalizer emits Markdown, while user prompts intentionally use
      // a plain/safe renderer. Remove presentation-only markers that would
      // otherwise leak through as literal punctuation.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/^\s*>\s?/gm, "")
      // Resource keys are not usable links. The downloaded image is rendered
      // from the managed attachment; on download failure the typed failure copy
      // remains visible without leaking the opaque key.
      .replace(
        /^\s*!\[(?:image|图片)?\]\((?!https?:\/\/|data:)[^)\n]+\)\s*$/gim,
        "\n",
      )
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function parseFeishuMetadata(content: string): {
  textWithoutFeishuMetadata: string;
  feishu?: FeishuPromptInfo;
} {
  const contexts: FeishuContextFields[] = [];
  const attachmentKinds: string[] = [];
  let foundContextBlock = false;
  let foundAttachmentBlock = false;

  let textWithoutFeishuMetadata = content.replace(
    FEISHU_CONTEXT_BLOCK_PATTERN,
    (_raw, block: string) => {
      foundContextBlock = true;
      contexts.push(parseFeishuContextFields(block));
      return "\n";
    },
  );
  textWithoutFeishuMetadata = textWithoutFeishuMetadata.replace(
    FEISHU_ATTACHMENT_BLOCK_PATTERN,
    (_raw, block: string) => {
      foundAttachmentBlock = true;
      for (const line of block.split("\n")) {
        const kind = /(?:^|\|)\s*kind=([a-z0-9_-]+)/i.exec(line)?.[1];
        if (kind) attachmentKinds.push(kind.toLowerCase());
      }
      return "\n";
    },
  );

  if (!foundContextBlock && !foundAttachmentBlock) {
    return { textWithoutFeishuMetadata: content };
  }

  const modes = [
    ...new Set(
      contexts.flatMap((context) =>
        context.effectiveMode ? [context.effectiveMode] : [],
      ),
    ),
  ];
  const contextAttachmentCount = contexts.reduce(
    (sum, context) => sum + (context.attachments ?? 0),
    0,
  );
  const feishu: FeishuPromptInfo = {
    messageCount: Math.max(
      1,
      contexts.reduce((sum, context) => sum + (context.messages ?? 0), 0),
    ),
    attachmentCount: Math.max(contextAttachmentCount, attachmentKinds.length),
    contextMode: modes.length === 1 ? modes[0] : undefined,
    complete: contexts.every((context) => context.complete !== false),
    hasWarnings: contexts.some((context) => context.warnings.length > 0),
  };

  return {
    textWithoutFeishuMetadata: cleanFeishuDisplayText(
      textWithoutFeishuMetadata,
    ),
    feishu,
  };
}

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
  // Extract skills before cleaning channel-generated Markdown so a Feishu
  // prompt cannot accidentally rewrite headings inside an injected skill.
  const { textWithoutSkills, skills } = parseSkillReferences(content);
  // Channel metadata is removed before the generic upload section so old and
  // new persisted sessions get the same clean, retroactive presentation.
  const { textWithoutFeishuMetadata, feishu } =
    parseFeishuMetadata(textWithoutSkills);
  const { textWithoutUploads, uploadedFiles } = parseUploadedFiles(
    textWithoutFeishuMetadata,
  );

  // Then process IDE metadata on the remaining text
  return {
    text: stripIdeMetadata(textWithoutUploads),
    openedFiles: parseOpenedFiles(textWithoutUploads),
    uploadedFiles,
    skills,
    ...(feishu ? { feishu } : {}),
  };
}
