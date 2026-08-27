import { parseKimiReadMediaOutput } from "@yep-anywhere/shared";
import { useOptionalI18n } from "../../../i18n";
import { viewImageRenderer } from "./ViewImageRenderer";
import type { ToolRenderer } from "./types";

interface ReadMediaResult {
  type?: string;
  kind: "image" | "video" | "audio";
  path?: string;
  mimeType?: string;
  bytes?: number;
  filePath?: string;
  previewUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getFileName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || normalized;
}

function normalizeReadMediaResult(
  result: unknown,
  input?: unknown,
): ReadMediaResult | null {
  const resultRecord = isRecord(result) ? result : null;
  const inputRecord = isRecord(input) ? input : null;
  const parsed = parseKimiReadMediaOutput(result);
  const rawKind = resultRecord?.kind ?? parsed?.kind;
  const kind =
    rawKind === "image" || rawKind === "video" || rawKind === "audio"
      ? rawKind
      : undefined;
  if (!kind) return null;

  return {
    type: "media",
    kind,
    path:
      getString(resultRecord?.path) ??
      parsed?.path ??
      getString(inputRecord?.path) ??
      getString(inputRecord?.file_path) ??
      getString(inputRecord?.filePath),
    mimeType: getString(resultRecord?.mimeType) ?? parsed?.mimeType,
    bytes:
      typeof resultRecord?.bytes === "number"
        ? resultRecord.bytes
        : parsed?.bytes,
    filePath: getString(resultRecord?.filePath),
    previewUrl:
      getString(resultRecord?.previewUrl) ??
      getString(resultRecord?.url) ??
      parsed?.mediaUrl,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readMediaError(result: unknown): string {
  if (typeof result === "string" && result.trim()) return result;
  if (isRecord(result)) {
    return (
      getString(result.message) ??
      getString(result.content) ??
      getString(result.error) ??
      "ReadMediaFile failed"
    );
  }
  return "ReadMediaFile failed";
}

function getImageInput(summary: ReadMediaResult) {
  const title = getFileName(summary.path);
  if (summary.filePath) return { path: summary.filePath, title };
  if (summary.path) return { path: summary.path, title };
  return { url: summary.previewUrl, title };
}

function MediaMeta({ summary }: { summary: ReadMediaResult }) {
  const i18n = useOptionalI18n();
  const kindLabel = i18n
    ? i18n.t(
        summary.kind === "image"
          ? "readMediaKindImage"
          : summary.kind === "video"
            ? "readMediaKindVideo"
            : "readMediaKindAudio",
      )
    : summary.kind;
  const details = [
    kindLabel,
    summary.mimeType,
    summary.bytes !== undefined ? formatBytes(summary.bytes) : undefined,
  ].filter(Boolean);

  return <span className="image-info">{details.join(" · ")}</span>;
}

function MediaResultView({
  result,
  input,
  isError,
}: {
  result: unknown;
  input?: unknown;
  isError: boolean;
}) {
  const i18n = useOptionalI18n();
  if (isError) {
    return <div className="viewimage-error">{readMediaError(result)}</div>;
  }

  const summary = normalizeReadMediaResult(result, input);
  if (!summary) {
    return (
      <div className="viewimage-error">
        {i18n
          ? i18n.t("readMediaPreviewUnavailable")
          : "Media loaded, but preview details are unavailable"}
      </div>
    );
  }

  const imageInput = getImageInput(summary);
  return (
    <div className="read-image-result">
      {summary.kind === "image"
        ? viewImageRenderer.renderToolResult(
            imageInput,
            false,
            { isStreaming: false, theme: "dark" },
            imageInput,
          )
        : null}
      <div className="file-header">
        <span className="file-path">
          {getFileName(summary.path) ?? summary.kind}
        </span>
        <MediaMeta summary={summary} />
      </div>
    </div>
  );
}

function MediaInteractiveSummary({
  input,
  result,
  isError,
}: {
  input: unknown;
  result: unknown;
  isError: boolean;
}) {
  if (isError) return null;
  const summary = normalizeReadMediaResult(result, input);
  if (!summary || summary.kind !== "image") return null;
  const imageInput = getImageInput(summary);
  const imageLink = viewImageRenderer.renderInteractiveSummary?.(
    imageInput,
    undefined,
    false,
    { isStreaming: false, theme: "dark" },
  );
  if (!imageLink) return null;
  return (
    <span className="read-media-inline-summary">
      {imageLink}
      <MediaMeta summary={summary} />
    </span>
  );
}

export const readMediaFileRenderer: ToolRenderer<unknown, unknown> = {
  tool: "ReadMediaFile",
  displayName: "Read Media",

  renderToolUse(input) {
    const record = isRecord(input) ? input : {};
    const path =
      getString(record.path) ??
      getString(record.file_path) ??
      getString(record.filePath);
    return <div className="file-path">{getFileName(path) ?? "Media"}</div>;
  },

  renderToolResult(result, isError, _context, input) {
    return <MediaResultView result={result} input={input} isError={isError} />;
  },

  getUseSummary(input) {
    const record = isRecord(input) ? input : {};
    return (
      getFileName(
        getString(record.path) ??
          getString(record.file_path) ??
          getString(record.filePath),
      ) ?? "Media"
    );
  },

  getResultSummary(result, isError, input) {
    if (isError) return "Error";
    const summary = normalizeReadMediaResult(result, input);
    return summary
      ? `${summary.kind[0]?.toUpperCase()}${summary.kind.slice(1)} loaded`
      : "Media loaded";
  },

  renderInteractiveSummary(input, result, isError) {
    const summary = normalizeReadMediaResult(result, input);
    if (isError || !summary || summary.kind !== "image") return null;
    return (
      <MediaInteractiveSummary
        input={input}
        result={result}
        isError={isError}
      />
    );
  },
};
