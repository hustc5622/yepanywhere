import { randomUUID } from "node:crypto";
import { type Dirent, createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  ReportComment,
  ReportCommentAnchor,
  ReportCommentMutationResponse,
  ReportDocument,
  ReportDocumentKind,
  ReportDocumentResponse,
  ReportImageUploadResponse,
  ReportUploadResponse,
  ReportsListResponse,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import { sanitizeFilename } from "../uploads/index.js";

export interface ReportsDeps {
  reportsDir?: string;
  /** Yep Anywhere data directory used for report comment persistence. */
  dataDir?: string;
  /** Optional reverse-proxy prefix used in rendered report image URLs. */
  basePath?: string;
  /** Maximum upload file size in bytes. 0 = unlimited */
  maxUploadSizeBytes?: number;
}

const MAX_DOCUMENTS = 500;
const MAX_SCAN_DEPTH = 5;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const BILIBILI_TRANSCRIPT_PREFIX = "outputs/bilibili_transcripts/";
const BILIBILI_TRANSCRIPT_FILENAMES = new Map<string, string>([
  ["codex_corrected_speaker_turns.txt", "Codex 校正版"],
  ["deepseek_corrected_speaker_turns.txt", "DeepSeek 校正版"],
  ["speaker_turns.txt", "FunASR 分说话人稿"],
  ["m3_corrected_speaker_turns.txt", "M3 校正版"],
]);
const MANUAL_UPLOAD_PREFIX = "uploads/";
const MANUAL_UPLOAD_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const PUBLIC_MARKDOWN_DIRECTORY_NAMES = new Set(["reports", "research"]);
const INTERNAL_MARKDOWN_DIRECTORY_NAMES = new Set([
  "briefs",
  "codex_chunks",
  "feishu_chunks",
  "notes",
  "prompts",
]);
const INTERNAL_MARKDOWN_FILENAMES = new Set(["readme.md"]);
const INTERNAL_MARKDOWN_NAME_PATTERN = /(^|[_.-])(draft|prompt)([_.-]|$)/i;
const COMMENT_STORE_VERSION = 1;
const MAX_COMMENT_BODY_LENGTH = 10_000;
const MAX_COMMENT_EXACT_LENGTH = 4_000;
const MAX_COMMENT_CONTEXT_LENGTH = 128;
const MAX_REPORT_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const REPORT_IMAGE_CONTENT_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".tiff", "image/tiff"],
  [".tif", "image/tiff"],
  [".svg", "image/svg+xml"],
]);

interface StoredReportComment extends ReportComment {
  reportRoot: string;
}

interface ReportCommentStore {
  version: number;
  comments: StoredReportComment[];
}

interface ResolvedReportImage {
  filePath: string;
  contentType: string;
  size: number;
}

function getReportsRoot(configuredDir?: string): string {
  const deployRepoRoot = process.env.YEP_DEPLOY_REPO_ROOT;
  const raw =
    configuredDir ||
    process.env.YEP_REPORTS_DIR ||
    process.env.RESEARCH_TASKS_DIR ||
    (deployRepoRoot
      ? resolve(deployRepoRoot, "../research_tasks")
      : "../research_tasks");
  return resolve(process.cwd(), raw);
}

function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());
}

function getBilibiliTranscriptVariant(filePath: string): string | null {
  const filename = basename(filePath).toLowerCase();
  const normalizedFilename = filename.replace(/\.md$/, ".txt");
  return BILIBILI_TRANSCRIPT_FILENAMES.get(normalizedFilename) ?? null;
}

function isBilibiliTranscriptPath(root: string, filePath: string): boolean {
  const relativePath = toPosixPath(relative(root, filePath));
  if (!relativePath.startsWith(BILIBILI_TRANSCRIPT_PREFIX)) return false;
  return getBilibiliTranscriptVariant(filePath) !== null;
}

function isManualUploadedTextPath(root: string, filePath: string): boolean {
  const relativePath = toPosixPath(relative(root, filePath));
  if (!relativePath.startsWith(MANUAL_UPLOAD_PREFIX)) return false;
  return extname(filePath).toLowerCase() === ".txt";
}

function getReportKind(
  root: string,
  filePath: string,
): ReportDocumentKind | null {
  if (isBilibiliTranscriptPath(root, filePath)) return "transcript";
  if (isMarkdownPath(filePath)) return "markdown";
  if (isManualUploadedTextPath(root, filePath)) return "text";
  return null;
}

function isReadableReportPath(root: string, filePath: string): boolean {
  return getReportKind(root, filePath) !== null;
}

function isListedMarkdownReportPath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const filename = parts.at(-1) ?? "";

  if (normalized.startsWith(MANUAL_UPLOAD_PREFIX)) return true;
  if (INTERNAL_MARKDOWN_FILENAMES.has(filename)) return false;
  if (INTERNAL_MARKDOWN_NAME_PATTERN.test(filename)) return false;
  if (parts.some((part) => INTERNAL_MARKDOWN_DIRECTORY_NAMES.has(part))) {
    return false;
  }

  if (parts.length === 1) return true;
  if (PUBLIC_MARKDOWN_DIRECTORY_NAMES.has(parts[0] ?? "")) return true;

  if (parts[0] === "outputs") {
    return parts.length === 3;
  }

  return false;
}

function isListedReportPath(root: string, filePath: string): boolean {
  const relativePath = toPosixPath(relative(root, filePath));
  if (isBilibiliTranscriptPath(root, filePath)) return true;
  if (isManualUploadedTextPath(root, filePath)) return true;
  if (!isMarkdownPath(filePath)) return false;
  return isListedMarkdownReportPath(relativePath);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}

function resolveReportPath(root: string, relativePath: string): string | null {
  const trimmed = relativePath.trim();
  if (!trimmed || isAbsolute(trimmed)) return null;

  const candidate = resolve(root, trimmed);
  if (!isWithinRoot(root, candidate)) return null;
  if (!isReadableReportPath(root, candidate)) return null;

  return candidate;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function normalizeBasePath(basePath?: string): string {
  const trimmed = (basePath ?? "").trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function normalizeReportImagePath(imagePath: string): string | null {
  const trimmed = imagePath.trim();
  if (
    !trimmed ||
    trimmed.length > 2_048 ||
    isAbsolute(trimmed) ||
    trimmed.startsWith("\\") ||
    trimmed.includes("\0") ||
    trimmed.includes("\\") ||
    !REPORT_IMAGE_CONTENT_TYPES.has(extname(trimmed).toLowerCase())
  ) {
    return null;
  }
  return trimmed;
}

function normalizeReportImageReference(href: string): string | null {
  const trimmed = href.trim();
  if (
    !trimmed ||
    trimmed.length > 2_048 ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.startsWith("#") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return null;
  }
  return normalizeReportImagePath(decoded);
}

function buildReportImageUrl(
  deps: ReportsDeps,
  reportPath: string,
  imagePath: string,
): string {
  const params = new URLSearchParams({
    path: reportPath,
    image: imagePath,
  });
  return `${normalizeBasePath(deps.basePath)}/api/reports/image?${params.toString()}`;
}

function reportImageUrl(
  deps: ReportsDeps,
  reportPath: string,
  imageReference: string,
): string | null {
  const normalizedImage = normalizeReportImageReference(imageReference);
  if (!normalizedImage) return null;
  return buildReportImageUrl(deps, reportPath, normalizedImage);
}

function reportImageUrlFromPath(
  deps: ReportsDeps,
  reportPath: string,
  imagePath: string,
): string | null {
  const normalizedImage = normalizeReportImagePath(imagePath);
  return normalizedImage
    ? buildReportImageUrl(deps, reportPath, normalizedImage)
    : null;
}

async function resolveReportImage(
  root: string,
  reportPath: string,
  imageReference: string,
): Promise<ResolvedReportImage | null> {
  const reportFilePath = resolveReportPath(root, reportPath);
  const normalizedImage = normalizeReportImagePath(imageReference);
  if (!reportFilePath || !normalizedImage) return null;

  const candidate = resolve(dirname(reportFilePath), normalizedImage);
  if (!isWithinRoot(root, candidate)) return null;

  try {
    const [resolvedRoot, resolvedImagePath] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    if (!isWithinRoot(resolvedRoot, resolvedImagePath)) return null;

    const imageStats = await stat(resolvedImagePath);
    const contentType = REPORT_IMAGE_CONTENT_TYPES.get(
      extname(resolvedImagePath).toLowerCase(),
    );
    if (!imageStats.isFile() || !contentType) return null;
    return {
      filePath: resolvedImagePath,
      contentType,
      size: imageStats.size,
    };
  } catch {
    return null;
  }
}

function reportAssetDirectoryName(reportFilePath: string): string {
  const reportName = basename(reportFilePath, extname(reportFilePath));
  return (
    reportName
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "report"
  );
}

function markdownImageAlt(filename: string): string {
  const name = basename(filename, extname(filename)).trim() || "Report image";
  return name.replace(/[\[\]\\\r\n]/g, " ").slice(0, 200);
}

function getCommentStorePath(deps: ReportsDeps, root: string): string {
  if (deps.dataDir) {
    return join(resolve(deps.dataDir), "report-comments.json");
  }
  return join(root, ".yep-report-comments.json");
}

function isReportCommentAnchor(value: unknown): value is ReportCommentAnchor {
  if (!isRecord(value)) return false;
  const { exact, prefix, suffix, start, end } = value;
  return (
    typeof exact === "string" &&
    exact.length > 0 &&
    exact.length <= MAX_COMMENT_EXACT_LENGTH &&
    typeof prefix === "string" &&
    prefix.length <= MAX_COMMENT_CONTEXT_LENGTH &&
    typeof suffix === "string" &&
    suffix.length <= MAX_COMMENT_CONTEXT_LENGTH &&
    typeof start === "number" &&
    Number.isInteger(start) &&
    start >= 0 &&
    typeof end === "number" &&
    Number.isInteger(end) &&
    end === start + exact.length
  );
}

function isStoredReportComment(value: unknown): value is StoredReportComment {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.reportRoot === "string" &&
    typeof value.reportPath === "string" &&
    isReportCommentAnchor(value.anchor) &&
    typeof value.body === "string" &&
    value.body.length > 0 &&
    value.body.length <= MAX_COMMENT_BODY_LENGTH &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

async function readCommentStore(filePath: string): Promise<ReportCommentStore> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.comments)) {
      return { version: COMMENT_STORE_VERSION, comments: [] };
    }
    return {
      version: COMMENT_STORE_VERSION,
      comments: parsed.comments.filter(isStoredReportComment),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[Reports] Failed to read report comments:", error);
    }
    return { version: COMMENT_STORE_VERSION, comments: [] };
  }
}

async function writeCommentStore(
  filePath: string,
  store: ReportCommentStore,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function stripStoredComment(comment: StoredReportComment): ReportComment {
  const { reportRoot: _reportRoot, ...result } = comment;
  return result;
}

async function readReportComments(
  storePath: string,
  root: string,
  reportPath: string,
): Promise<ReportComment[]> {
  const store = await readCommentStore(storePath);
  return store.comments
    .filter(
      (comment) =>
        comment.reportRoot === root && comment.reportPath === reportPath,
    )
    .map(stripStoredComment)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function parseCommentBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const body = value.trim();
  if (!body || body.length > MAX_COMMENT_BODY_LENGTH) return null;
  return body;
}

function titleFromMarkdown(content: string, fallbackPath: string): string {
  for (const line of content.split(/\r?\n/)) {
    const match = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line.trim());
    if (!match?.[2]) continue;
    return cleanHeadingText(match[2]);
  }

  const name = basename(fallbackPath).replace(/\.(md|markdown)$/i, "");
  return name || fallbackPath;
}

interface UploadedReportFile {
  name: string;
  size: number;
  type?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function isUploadedReportFile(value: unknown): value is UploadedReportFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "size" in value &&
    typeof value.size === "number" &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function titleFromBilibiliTranscript(filePath: string): Promise<string> {
  const variant = getBilibiliTranscriptVariant(filePath) || "转写稿";

  try {
    const raw = await readFile(join(dirname(filePath), "source.info.json"), {
      encoding: "utf-8",
    });
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return `${basename(dirname(filePath))} (${variant})`;

    const sourceTitle =
      pickString(parsed, "title") ||
      pickString(parsed, "fulltitle") ||
      pickString(parsed, "display_id");
    if (sourceTitle) return `${sourceTitle} (${variant})`;
  } catch {
    // Missing or partial yt-dlp metadata should not hide the transcript itself.
  }

  return `${basename(dirname(filePath))} (${variant})`;
}

async function titleFromReportContent(
  root: string,
  filePath: string,
  content: string,
): Promise<string> {
  const kind = getReportKind(root, filePath);
  if (kind === "transcript") {
    return titleFromBilibiliTranscript(filePath);
  }
  return titleFromMarkdown(content, filePath);
}

function cleanHeadingText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~#]/g, "")
    .trim();
}

async function readReportMetadata(
  root: string,
  filePath: string,
): Promise<ReportDocument | null> {
  try {
    const [stats, content] = await Promise.all([
      stat(filePath),
      readFile(filePath, "utf-8"),
    ]);
    if (!stats.isFile()) return null;
    const kind = getReportKind(root, filePath);
    if (!kind) return null;

    return {
      path: toPosixPath(relative(root, filePath)),
      absolutePath: filePath,
      title: await titleFromReportContent(root, filePath, content),
      kind,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

async function collectMarkdownFiles(
  root: string,
  dir: string,
  depth = 0,
  files: string[] = [],
): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH || files.length >= MAX_DOCUMENTS) return files;

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (files.length >= MAX_DOCUMENTS) break;
    if (entry.name.startsWith(".")) continue;

    const fullPath = join(dir, entry.name);
    if (!isWithinRoot(root, fullPath)) continue;

    if (entry.isDirectory()) {
      await collectMarkdownFiles(root, fullPath, depth + 1, files);
      continue;
    }

    if (entry.isFile() && isListedReportPath(root, fullPath)) {
      if (
        isBilibiliTranscriptPath(root, fullPath) &&
        (await hasMarkdownSibling(fullPath))
      ) {
        continue;
      }
      files.push(fullPath);
    }
  }

  return files;
}

async function hasMarkdownSibling(filePath: string): Promise<boolean> {
  const markdownPath = filePath.replace(/\.txt$/i, ".md");
  if (markdownPath === filePath) return false;

  try {
    const stats = await stat(markdownPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

export function createReportsRoutes(deps: ReportsDeps = {}): Hono {
  const routes = new Hono();
  let commentMutationQueue = Promise.resolve();

  const mutateComments = <T>(mutation: () => Promise<T>): Promise<T> => {
    const result = commentMutationQueue.then(mutation, mutation);
    commentMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  routes.get("/", async (c) => {
    const root = getReportsRoot(deps.reportsDir);
    const files = await collectMarkdownFiles(root, root);
    const documents = (
      await Promise.all(files.map((file) => readReportMetadata(root, file)))
    )
      .filter((doc): doc is ReportDocument => doc !== null)
      .sort(
        (a, b) =>
          new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
      );

    return c.json({
      rootPath: root,
      documents,
    } satisfies ReportsListResponse);
  });

  routes.post("/upload", async (c) => {
    const root = getReportsRoot(deps.reportsDir);
    const body = await c.req.parseBody();
    const rawFile = body.file;
    const file = Array.isArray(rawFile) ? rawFile[0] : rawFile;

    if (!isUploadedReportFile(file)) {
      return c.json({ error: "Missing file" }, 400);
    }

    const extension = extname(file.name).toLowerCase();
    if (!MANUAL_UPLOAD_EXTENSIONS.has(extension)) {
      return c.json(
        { error: "Only .md, .markdown, and .txt reports are supported" },
        400,
      );
    }

    const maxUploadSizeBytes = deps.maxUploadSizeBytes ?? 0;
    if (maxUploadSizeBytes > 0 && file.size > maxUploadSizeBytes) {
      const maxMB = Math.max(1, Math.ceil(maxUploadSizeBytes / (1024 * 1024)));
      return c.json(
        { error: `File size exceeds maximum allowed size of ${maxMB}MB` },
        413,
      );
    }

    const uploadDir = resolve(root, "uploads");
    const { sanitized } = sanitizeFilename(file.name);
    const filePath = resolve(uploadDir, sanitized);
    if (!isWithinRoot(root, filePath) || !isWithinRoot(uploadDir, filePath)) {
      return c.json({ error: "Invalid upload path" }, 400);
    }

    await mkdir(uploadDir, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    const document = await readReportMetadata(root, filePath);
    if (!document) {
      return c.json({ error: "Uploaded file is not a report" }, 500);
    }

    return c.json({ document } satisfies ReportUploadResponse, 201);
  });

  routes.get("/image", async (c) => {
    const reportPath = c.req.query("path");
    const imageReference = c.req.query("image");
    if (!reportPath || !imageReference) {
      return c.json({ error: "Missing report or image path" }, 400);
    }

    const root = getReportsRoot(deps.reportsDir);
    const image = await resolveReportImage(root, reportPath, imageReference);
    if (!image) {
      return c.json({ error: "Report image not found" }, 404);
    }

    c.header("Content-Type", image.contentType);
    c.header("Content-Length", String(image.size));
    c.header("Cache-Control", "private, max-age=3600");
    c.header("X-Content-Type-Options", "nosniff");
    if (image.contentType === "image/svg+xml") {
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    }
    return stream(c, async (output) => {
      const readable = createReadStream(image.filePath);
      for await (const chunk of readable) {
        await output.write(chunk);
      }
    });
  });

  routes.post("/images/upload", async (c) => {
    const root = getReportsRoot(deps.reportsDir);
    const body = await c.req.parseBody();
    const rawFile = body.file;
    const file = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    const rawReportPath = Array.isArray(body.path) ? body.path[0] : body.path;
    const reportPath =
      typeof rawReportPath === "string" ? rawReportPath.trim() : "";

    if (!reportPath) {
      return c.json({ error: "Missing report path" }, 400);
    }
    if (!isUploadedReportFile(file)) {
      return c.json({ error: "Missing image file" }, 400);
    }

    const extension = extname(file.name).toLowerCase();
    if (!REPORT_IMAGE_CONTENT_TYPES.has(extension)) {
      return c.json({ error: "Unsupported report image type" }, 400);
    }
    const configuredLimit = deps.maxUploadSizeBytes ?? 0;
    const maxImageSize =
      configuredLimit > 0
        ? Math.min(configuredLimit, MAX_REPORT_IMAGE_SIZE_BYTES)
        : MAX_REPORT_IMAGE_SIZE_BYTES;
    if (file.size > maxImageSize) {
      const maxMB = Math.max(1, Math.floor(maxImageSize / (1024 * 1024)));
      return c.json(
        { error: `Image size exceeds maximum allowed size of ${maxMB}MB` },
        413,
      );
    }

    const reportFilePath = resolveReportPath(root, reportPath);
    if (!reportFilePath) {
      return c.json({ error: "Invalid report path" }, 400);
    }
    try {
      const reportStats = await stat(reportFilePath);
      if (!reportStats.isFile()) {
        return c.json({ error: "Report not found" }, 404);
      }
    } catch {
      return c.json({ error: "Report not found" }, 404);
    }

    const assetDirectory = resolve(
      dirname(reportFilePath),
      "assets",
      reportAssetDirectoryName(reportFilePath),
    );
    if (!isWithinRoot(root, assetDirectory)) {
      return c.json({ error: "Invalid report asset path" }, 400);
    }
    const { sanitized } = sanitizeFilename(file.name);
    const imageFilePath = resolve(assetDirectory, sanitized);
    if (!isWithinRoot(root, imageFilePath)) {
      return c.json({ error: "Invalid report asset path" }, 400);
    }

    await mkdir(assetDirectory, { recursive: true });
    await writeFile(imageFilePath, Buffer.from(await file.arrayBuffer()), {
      mode: 0o600,
    });

    const normalizedReportPath = toPosixPath(relative(root, reportFilePath));
    const relativeImagePath = toPosixPath(
      relative(dirname(reportFilePath), imageFilePath),
    );
    const markdownPath = relativeImagePath
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const url = reportImageUrlFromPath(
      deps,
      normalizedReportPath,
      relativeImagePath,
    );
    if (!url) {
      return c.json({ error: "Failed to resolve report image" }, 500);
    }

    return c.json(
      {
        path: relativeImagePath,
        markdown: `![${markdownImageAlt(file.name)}](${markdownPath})`,
        url,
      } satisfies ReportImageUploadResponse,
      201,
    );
  });

  routes.post("/comments", async (c) => {
    const root = getReportsRoot(deps.reportsDir);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!isRecord(body)) {
      return c.json({ error: "Invalid comment" }, 400);
    }

    const reportPath = pickString(body, "path");
    const commentBody = parseCommentBody(body.body);
    const anchor = body.anchor;
    if (!reportPath || !commentBody || !isReportCommentAnchor(anchor)) {
      return c.json({ error: "Invalid comment" }, 400);
    }

    const reportFilePath = resolveReportPath(root, reportPath);
    if (!reportFilePath) {
      return c.json({ error: "Invalid report path" }, 400);
    }
    try {
      const reportStats = await stat(reportFilePath);
      if (!reportStats.isFile()) {
        return c.json({ error: "Report not found" }, 404);
      }
    } catch {
      return c.json({ error: "Report not found" }, 404);
    }

    const normalizedReportPath = toPosixPath(relative(root, reportFilePath));
    const storePath = getCommentStorePath(deps, root);
    try {
      const comment = await mutateComments(async () => {
        const store = await readCommentStore(storePath);
        const now = new Date().toISOString();
        const next: StoredReportComment = {
          id: randomUUID(),
          reportRoot: root,
          reportPath: normalizedReportPath,
          anchor,
          body: commentBody,
          createdAt: now,
          updatedAt: now,
        };
        store.comments.push(next);
        await writeCommentStore(storePath, store);
        return stripStoredComment(next);
      });
      return c.json({ comment } satisfies ReportCommentMutationResponse, 201);
    } catch (error) {
      console.error("[Reports] Failed to create report comment:", error);
      return c.json({ error: "Failed to save report comment" }, 500);
    }
  });

  routes.patch("/comments/:id", async (c) => {
    const root = getReportsRoot(deps.reportsDir);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!isRecord(body)) {
      return c.json({ error: "Invalid comment" }, 400);
    }

    const reportPath = pickString(body, "path");
    const commentBody = parseCommentBody(body.body);
    if (!reportPath || !commentBody) {
      return c.json({ error: "Invalid comment" }, 400);
    }

    const reportFilePath = resolveReportPath(root, reportPath);
    if (!reportFilePath) {
      return c.json({ error: "Invalid report path" }, 400);
    }
    try {
      const reportStats = await stat(reportFilePath);
      if (!reportStats.isFile()) {
        return c.json({ error: "Report not found" }, 404);
      }
    } catch {
      return c.json({ error: "Report not found" }, 404);
    }

    const normalizedReportPath = toPosixPath(relative(root, reportFilePath));
    const storePath = getCommentStorePath(deps, root);
    try {
      const comment = await mutateComments(async () => {
        const store = await readCommentStore(storePath);
        const index = store.comments.findIndex(
          (candidate) =>
            candidate.id === c.req.param("id") &&
            candidate.reportRoot === root &&
            candidate.reportPath === normalizedReportPath,
        );
        if (index < 0) return null;

        const current = store.comments[index];
        if (!current) return null;
        const next: StoredReportComment = {
          ...current,
          body: commentBody,
          updatedAt: new Date().toISOString(),
        };
        store.comments[index] = next;
        await writeCommentStore(storePath, store);
        return stripStoredComment(next);
      });
      if (!comment) {
        return c.json({ error: "Report comment not found" }, 404);
      }
      return c.json({ comment } satisfies ReportCommentMutationResponse);
    } catch (error) {
      console.error("[Reports] Failed to update report comment:", error);
      return c.json({ error: "Failed to save report comment" }, 500);
    }
  });

  routes.get("/document", async (c) => {
    const root = getReportsRoot(deps.reportsDir);
    const relativePath = c.req.query("path");
    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    const filePath = resolveReportPath(root, relativePath);
    if (!filePath) {
      return c.json({ error: "Invalid report path" }, 400);
    }

    try {
      const [stats, content] = await Promise.all([
        stat(filePath),
        readFile(filePath, "utf-8"),
      ]);
      if (!stats.isFile()) {
        return c.json({ error: "Report not found" }, 404);
      }
      const kind = getReportKind(root, filePath);
      if (!kind) {
        return c.json({ error: "Report not found" }, 404);
      }

      const normalizedReportPath = toPosixPath(relative(root, filePath));
      const [renderedHtml, comments] = await Promise.all([
        renderMarkdownToHtml(content, {
          resolveImageUrl: (href) =>
            reportImageUrl(deps, normalizedReportPath, href),
        }),
        readReportComments(
          getCommentStorePath(deps, root),
          root,
          normalizedReportPath,
        ),
      ]);
      return c.json({
        metadata: {
          path: normalizedReportPath,
          absolutePath: filePath,
          title: await titleFromReportContent(root, filePath, content),
          kind,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        },
        content,
        renderedHtml,
        comments,
      } satisfies ReportDocumentResponse);
    } catch {
      return c.json({ error: "Report not found" }, 404);
    }
  });

  return routes;
}
