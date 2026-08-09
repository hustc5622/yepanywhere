import { memo, useState } from "react";
import { useFetchedImage } from "../../hooks/useRemoteImage";
import {
  type SkillInfo,
  type UploadedFileInfo,
  getFilename,
  parseUserPrompt,
} from "../../lib/parseUserPrompt";
import type {
  CodexBranchOption,
  ContentBlock,
  ContextUsage,
  SessionBranchOption,
} from "../../types";
import { MessageActions } from "../MessageActions";
import { Modal } from "../ui/Modal";

const MAX_LINES = 12;
const MAX_CHARS = MAX_LINES * 100;

interface Props {
  content: string | ContentBlock[];
  /** ISO timestamp from the source JSONL entry, used for hover-revealed time. */
  timestamp?: string;
  /** Context-window usage snapshot associated with this prompt. */
  contextBefore?: ContextUsage;
  /** Provider-agnostic branch metadata for editable conversation history. */
  branch?: {
    sessionId: string;
    branchId: string;
    activeBranchId: string | null;
    selectedBranchId: string | null;
    parentId: string | null;
    siblingIndex: number;
    siblingCount: number;
    alternatives: SessionBranchOption[];
  };
  /** Codex-only compatibility alias for branch metadata. */
  codexBranch?: {
    sessionId: string;
    branchId: string;
    activeBranchId: string | null;
    selectedBranchId: string | null;
    parentId: string | null;
    siblingIndex: number;
    siblingCount: number;
    alternatives: CodexBranchOption[];
  };
  /** Switch the rendered derived branch. */
  onSelectBranch?: (branchId: string) => void;
  /** Codex-only compatibility alias for branch switching. */
  onSelectCodexBranch?: (branchId: string) => void;
  /**
   * When provided, show an edit button on the prompt. Called with the parsed
   * prompt text so the parent can prefill the input and rewind from here.
   */
  onEdit?: (text: string) => void;
}

interface InputImageBlock extends ContentBlock {
  type: "input_image";
  file_path?: string;
  image_url?: string;
  mime_type?: string;
}

/**
 * Renders file metadata (opened files) below the user prompt
 */
function OpenedFilesMetadata({ files }: { files: string[] }) {
  if (files.length === 0) return null;

  return (
    <div className="user-prompt-metadata">
      {files.map((filePath) => (
        <span
          key={filePath}
          className="opened-file"
          title={`file was opened in editor: ${filePath}`}
        >
          {getFilename(filePath)}
        </span>
      ))}
    </div>
  );
}

/**
 * Check if a MIME type is an image type
 */
function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Extract URL components from an uploaded file path.
 * Path format: /.../.yep-anywhere/uploads/{projectId}/{sessionId}/{filename}
 */
function getUploadUrl(filePath: string): string | null {
  // Split path and get last 3 components: projectId, sessionId, filename
  const parts = filePath.split("/");
  if (parts.length < 3) return null;

  const filename = parts[parts.length - 1];
  const sessionId = parts[parts.length - 2];
  const projectId = parts[parts.length - 3];

  if (!filename || !sessionId || !projectId) return null;

  // Validate filename has UUID prefix
  if (!/^[0-9a-f-]{36}_/.test(filename)) return null;

  return `/api/projects/${projectId}/sessions/${sessionId}/upload/${encodeURIComponent(filename)}`;
}

function isInputImageBlock(block: ContentBlock): block is InputImageBlock {
  return block.type === "input_image";
}

function stripCodexImageMarkers(text: string): string {
  return text
    .replace(/<image\b[^>]*>\s*<\/image>/gi, "\n")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !/^<image\b[^>]*>$/i.test(trimmed) && trimmed !== "</image>";
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseInlineImageData(imageUrl: string): {
  mimeType?: string;
  bytes?: number;
} {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(imageUrl);
  if (!match) return {};

  const rawMime = match[1]?.trim();
  const mimeType = rawMime || undefined;
  const isBase64 = Boolean(match[2]);
  const payload = (match[3] ?? "").trim();
  if (!payload) return { mimeType };

  if (!isBase64) {
    const decoded = decodeURIComponent(payload);
    return { mimeType, bytes: decoded.length };
  }

  const sanitized = payload.replace(/\s+/g, "");
  const padding = sanitized.endsWith("==")
    ? 2
    : sanitized.endsWith("=")
      ? 1
      : 0;
  const bytes = Math.max(0, Math.floor((sanitized.length * 3) / 4) - padding);
  return { mimeType, bytes };
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getMimeTypeFromPath(path: string): string | undefined {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg"))
    return "image/jpeg";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".bmp")) return "image/bmp";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  return undefined;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/svg+xml") return "svg";
  const slashIndex = normalized.indexOf("/");
  if (slashIndex === -1) return "png";
  const ext = normalized.slice(slashIndex + 1);
  return ext || "png";
}

function filenameFromUrl(imageUrl: string): string | null {
  if (imageUrl.startsWith("data:")) return null;

  try {
    const parsed = new URL(imageUrl, "https://codex.local");
    const pathname = parsed.pathname || "";
    const segment = pathname.split("/").filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
}

function extractCodexImageFiles(content: ContentBlock[]): UploadedFileInfo[] {
  const files: UploadedFileInfo[] = [];
  let imageIndex = 0;

  for (const block of content) {
    if (!isInputImageBlock(block)) continue;
    imageIndex += 1;

    const filePath =
      typeof block.file_path === "string" ? block.file_path.trim() : "";
    const imageUrl =
      typeof block.image_url === "string" ? block.image_url.trim() : "";
    const inlineData = imageUrl ? parseInlineImageData(imageUrl) : {};

    const mimeType =
      (typeof block.mime_type === "string" && block.mime_type.trim()) ||
      inlineData.mimeType ||
      (filePath ? getMimeTypeFromPath(filePath) : undefined) ||
      (imageUrl ? getMimeTypeFromPath(imageUrl) : undefined) ||
      "image/*";

    const fileName =
      (filePath && getFilename(filePath)) ||
      (imageUrl && filenameFromUrl(imageUrl)) ||
      `pasted-image-${imageIndex}.${extensionForMimeType(mimeType)}`;

    const path =
      filePath ||
      (imageUrl && !imageUrl.startsWith("data:") ? imageUrl : "") ||
      `codex-inline://image/${imageIndex}`;

    files.push({
      originalName: fileName,
      size: formatFileSize(inlineData.bytes),
      mimeType,
      path,
      previewUrl: imageUrl || undefined,
    });
  }

  return files;
}

function mergeUploadedFiles(
  primary: UploadedFileInfo[],
  secondary: UploadedFileInfo[],
): UploadedFileInfo[] {
  const seen = new Set<string>();
  const merged: UploadedFileInfo[] = [];

  for (const file of [...primary, ...secondary]) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    merged.push(file);
  }

  return merged;
}

function UploadedImageError({ message }: { message: string }) {
  return (
    <div className="uploaded-image-error" role="alert">
      <strong>Failed to load image</strong>
      <pre>{message}</pre>
    </div>
  );
}

function FetchedUploadedImage({
  apiPath,
  alt,
}: {
  apiPath: string;
  alt: string;
}) {
  const { url, loading, error, bytes, mimeType } = useFetchedImage(apiPath);
  const [decodeError, setDecodeError] = useState<string | null>(null);

  if (loading) return <div className="image-loading">Loading image...</div>;
  if (error) return <UploadedImageError message={error} />;
  if (!url) {
    return (
      <UploadedImageError
        message={`Image request completed without a preview URL\nURL: ${apiPath}`}
      />
    );
  }
  if (decodeError) return <UploadedImageError message={decodeError} />;

  return (
    <img
      src={url}
      alt={alt}
      onError={() => {
        const message = [
          "Image bytes were fetched, but Android WebView could not decode them.",
          `URL: ${apiPath}`,
          `Blob Content-Type: ${mimeType ?? "unknown"}`,
          `Blob bytes: ${bytes ?? "unknown"}`,
        ].join("\n");
        console.error("[UploadedFileItem] Failed to decode fetched image", {
          apiPath,
          mimeType,
          bytes,
        });
        setDecodeError(message);
      }}
    />
  );
}

/**
 * Single uploaded file attachment - clickable for images
 */
function UploadedFileItem({ file }: { file: UploadedFileInfo }) {
  const [showModal, setShowModal] = useState(false);
  const isImage = isImageMimeType(file.mimeType);
  const apiPath = isImage ? getUploadUrl(file.path) : null;
  const directPreviewUrl = isImage ? (file.previewUrl ?? null) : null;

  if (isImage && (apiPath || directPreviewUrl)) {
    return (
      <>
        <button
          type="button"
          className="uploaded-file uploaded-file-clickable"
          title={`${file.mimeType}, ${file.size}`}
          onClick={() => setShowModal(true)}
        >
          📎 {file.originalName}
        </button>
        {showModal && (
          <Modal title={file.originalName} onClose={() => setShowModal(false)}>
            <div className="uploaded-image-modal">
              {directPreviewUrl ? (
                <img src={directPreviewUrl} alt={file.originalName} />
              ) : apiPath ? (
                <FetchedUploadedImage
                  apiPath={apiPath}
                  alt={file.originalName}
                />
              ) : null}
            </div>
          </Modal>
        )}
      </>
    );
  }

  return (
    <span className="uploaded-file" title={`${file.mimeType}, ${file.size}`}>
      📎 {file.originalName}
    </span>
  );
}

/**
 * Renders uploaded file attachments below the user prompt
 */
function UploadedFilesMetadata({ files }: { files: UploadedFileInfo[] }) {
  if (files.length === 0) return null;

  return (
    <div className="user-prompt-metadata">
      {files.map((file, index) => (
        <UploadedFileItem
          key={`${file.path}:${file.originalName}:${index}`}
          file={file}
        />
      ))}
    </div>
  );
}

function getSkillCopyText(skills: SkillInfo[]): string {
  return skills.map((skill) => skill.raw).join("\n\n");
}

function SkillReferences({ skills }: { skills: SkillInfo[] }) {
  const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(null);

  if (skills.length === 0) return null;

  return (
    <>
      <div className="skill-reference-list">
        {skills.map((skill, index) => (
          <button
            key={`${skill.path || skill.name}-${index}`}
            type="button"
            className="skill-reference-link"
            title={skill.path || skill.name}
            onClick={() => setSelectedSkill(skill)}
          >
            <span className="skill-reference-kind">Skill</span>
            <span className="skill-reference-name">{skill.name}</span>
          </button>
        ))}
      </div>
      {selectedSkill && (
        <Modal
          title={`Skill: ${selectedSkill.name}`}
          onClose={() => setSelectedSkill(null)}
        >
          <div className="skill-detail-modal">
            {selectedSkill.path && (
              <div className="skill-detail-row">
                <div className="skill-detail-label">Path</div>
                <code className="skill-detail-value">{selectedSkill.path}</code>
              </div>
            )}
            {selectedSkill.description && (
              <div className="skill-detail-row">
                <div className="skill-detail-label">Description</div>
                <div className="skill-detail-description">
                  {selectedSkill.description}
                </div>
              </div>
            )}
            <div className="skill-detail-section">
              <div className="skill-detail-label">Details</div>
              <pre className="skill-detail-content">
                {selectedSkill.markdown || selectedSkill.raw}
              </pre>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function BranchControls({
  branch,
  onSelect,
}: {
  branch: NonNullable<Props["branch"]>;
  onSelect?: (branchId: string) => void;
}) {
  if (branch.alternatives.length <= 1) return null;

  const selectedIndex = Math.max(
    0,
    branch.alternatives.findIndex(
      (alternative) => alternative.id === branch.branchId,
    ),
  );
  const previousBranch = branch.alternatives[selectedIndex - 1];
  const nextBranch = branch.alternatives[selectedIndex + 1];

  return (
    <div className="codex-branch-panel">
      <div
        className="codex-branch-switcher"
        aria-label="Conversation branch switcher"
      >
        <button
          type="button"
          className="codex-branch-nav"
          aria-label="Previous conversation branch"
          disabled={!previousBranch || !onSelect}
          onClick={() => previousBranch && onSelect?.(previousBranch.id)}
        >
          ‹
        </button>
        <span className="codex-branch-position">
          Branch {branch.siblingIndex}/{branch.siblingCount}
        </span>
        <button
          type="button"
          className="codex-branch-nav"
          aria-label="Next conversation branch"
          disabled={!nextBranch || !onSelect}
          onClick={() => nextBranch && onSelect?.(nextBranch.id)}
        >
          ›
        </button>
      </div>
      <div className="codex-branch-session">Session {branch.sessionId}</div>
    </div>
  );
}

/**
 * Renders text content with optional truncation and "Show more" button
 */
function CollapsibleText({ text }: { text: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = text.split("\n");
  const exceedsLines = lines.length > MAX_LINES;
  const exceedsChars = text.length > MAX_CHARS;
  const needsTruncation = exceedsLines || exceedsChars;

  if (!needsTruncation || isExpanded) {
    return (
      <div className="text-block">
        {text}
        {isExpanded && needsTruncation && (
          <button
            type="button"
            className="show-more-btn"
            onClick={() => setIsExpanded(false)}
          >
            Show less
          </button>
        )}
      </div>
    );
  }

  // Truncate by lines first, then by characters if still too long
  let truncatedText = exceedsLines
    ? lines.slice(0, MAX_LINES).join("\n")
    : text;
  if (truncatedText.length > MAX_CHARS) {
    truncatedText = truncatedText.slice(0, MAX_CHARS);
  }

  return (
    <div className="text-block collapsible-text">
      <div className="truncated-content">
        {truncatedText}
        <div className="fade-overlay" />
      </div>
      <button
        type="button"
        className="show-more-btn"
        onClick={() => setIsExpanded(true)}
      >
        Show more
      </button>
    </div>
  );
}

export const UserPromptBlock = memo(function UserPromptBlock({
  content,
  timestamp,
  contextBefore,
  branch,
  codexBranch,
  onSelectBranch,
  onSelectCodexBranch,
  onEdit,
}: Props) {
  const branchMetadata = branch ?? codexBranch;
  const handleSelectBranch = onSelectBranch ?? onSelectCodexBranch;

  if (typeof content === "string") {
    const { text, openedFiles, uploadedFiles, skills } =
      parseUserPrompt(content);

    // Don't render if there's no actual text content
    if (!text && skills.length === 0) {
      const hasMetadata = openedFiles.length > 0 || uploadedFiles.length > 0;
      return hasMetadata ? (
        <>
          <UploadedFilesMetadata files={uploadedFiles} />
          <OpenedFilesMetadata files={openedFiles} />
        </>
      ) : null;
    }

    const copyText = text || getSkillCopyText(skills);

    return (
      <div className="user-prompt-container">
        <MessageActions
          timestamp={timestamp}
          contextBefore={contextBefore}
          copyText={copyText}
          onEdit={onEdit && text ? () => onEdit(text) : undefined}
        />
        <div className="message message-user-prompt">
          <div className="message-content">
            {text && <CollapsibleText text={text} />}
            <SkillReferences skills={skills} />
            <UploadedFilesMetadata files={uploadedFiles} />
          </div>
        </div>
        {branchMetadata && (
          <BranchControls
            branch={branchMetadata}
            onSelect={handleSelectBranch}
          />
        )}
        <OpenedFilesMetadata files={openedFiles} />
      </div>
    );
  }

  // Array content - extract text blocks for display
  const textContent = content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
  const codexImageFiles = extractCodexImageFiles(content);
  const textForParsing =
    codexImageFiles.length > 0
      ? stripCodexImageMarkers(textContent)
      : textContent;

  // Parse the combined text content for metadata
  const { text, openedFiles, uploadedFiles, skills } =
    parseUserPrompt(textForParsing);
  const allUploadedFiles = mergeUploadedFiles(uploadedFiles, codexImageFiles);

  if (!text && skills.length === 0) {
    const hasMetadata = openedFiles.length > 0 || allUploadedFiles.length > 0;
    return hasMetadata ? (
      <>
        <UploadedFilesMetadata files={allUploadedFiles} />
        <OpenedFilesMetadata files={openedFiles} />
      </>
    ) : (
      <div className="message message-user-prompt">
        <div className="message-content">
          <div className="text-block">[Complex content]</div>
        </div>
      </div>
    );
  }

  const copyText = text || getSkillCopyText(skills);

  return (
    <div className="user-prompt-container">
      <MessageActions
        timestamp={timestamp}
        contextBefore={contextBefore}
        copyText={copyText}
        onEdit={onEdit && text ? () => onEdit(text) : undefined}
      />
      <div className="message message-user-prompt">
        <div className="message-content">
          {text && <CollapsibleText text={text} />}
          <SkillReferences skills={skills} />
          <UploadedFilesMetadata files={allUploadedFiles} />
        </div>
      </div>
      {branchMetadata && (
        <BranchControls branch={branchMetadata} onSelect={handleSelectBranch} />
      )}
      <OpenedFilesMetadata files={openedFiles} />
    </div>
  );
});
