import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type { ToolRenderer, WebFetchInput, WebFetchResult } from "./types";

const MAX_CONTENT_LINES = 30;

type RenderableWebFetchResult = WebFetchResult | string | null | undefined;

/**
 * Format bytes to human readable
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getStringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const fieldValue = value[field];
  return typeof fieldValue === "string" && fieldValue.trim()
    ? fieldValue.trim()
    : undefined;
}

function getWebFetchContent(result: RenderableWebFetchResult): string {
  if (typeof result === "string") {
    return result;
  }
  if (!isRecord(result)) {
    return "";
  }
  return (
    getStringField(result, "result") ||
    getStringField(result, "content") ||
    getStringField(result, "output") ||
    ""
  );
}

function getWebFetchUrl(
  result: RenderableWebFetchResult,
  input?: WebFetchInput,
): string | undefined {
  if (isRecord(result)) {
    const resultUrl = getStringField(result, "url");
    if (resultUrl) {
      return resultUrl;
    }
  }
  return typeof input?.url === "string" && input.url.trim()
    ? input.url.trim()
    : undefined;
}

/**
 * WebFetch tool use - shows URL and prompt
 */
function WebFetchToolUse({ input }: { input: WebFetchInput }) {
  return (
    <div className="webfetch-tool-use">
      <a
        href={input.url}
        target="_blank"
        rel="noopener noreferrer"
        className="webfetch-url"
      >
        {input.url}
      </a>
      {input.prompt && <div className="webfetch-prompt">{input.prompt}</div>}
    </div>
  );
}

/**
 * WebFetch tool result - shows fetched content
 */
function WebFetchToolResult({
  result,
  isError,
  input,
}: {
  result: RenderableWebFetchResult;
  isError: boolean;
  input?: WebFetchInput;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("WebFetch", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("WebFetch", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("WebFetch");

  const content = getWebFetchContent(result);

  if (isError) {
    return (
      <div className="webfetch-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebFetch" errors={validationErrors} />
        )}
        {content || "Fetch failed"}
      </div>
    );
  }

  if (!result && !content) {
    return <div className="webfetch-empty">No content</div>;
  }

  const lines = content.split("\n");
  const needsCollapse = lines.length > MAX_CONTENT_LINES;
  const displayLines =
    needsCollapse && !isExpanded ? lines.slice(0, MAX_CONTENT_LINES) : lines;

  const code =
    isRecord(result) && typeof result.code === "number"
      ? result.code
      : undefined;
  const codeText = isRecord(result) ? getStringField(result, "codeText") : "";
  const url = getWebFetchUrl(result, input);
  const bytes =
    isRecord(result) && typeof result.bytes === "number"
      ? result.bytes
      : undefined;
  const durationMs =
    isRecord(result) && typeof result.durationMs === "number"
      ? result.durationMs
      : undefined;
  const statusClass =
    code !== undefined && code >= 200 && code < 300
      ? "badge-success"
      : code !== undefined && code >= 400
        ? "badge-error"
        : "badge-warning";

  return (
    <div className="webfetch-result">
      <div className="webfetch-header">
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="webfetch-url"
          >
            {url}
          </a>
        )}
        {code !== undefined && (
          <span className={`badge ${statusClass}`}>
            {code} {codeText}
          </span>
        )}
        {(bytes !== undefined || durationMs !== undefined) && (
          <span className="webfetch-meta">
            {bytes !== undefined ? formatBytes(bytes) : null}
            {bytes !== undefined && durationMs !== undefined
              ? " \u00b7 "
              : null}
            {durationMs !== undefined ? `${durationMs}ms` : null}
          </span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebFetch" errors={validationErrors} />
        )}
      </div>
      {content && (
        <>
          <pre className="webfetch-content code-block">
            <code>{displayLines.join("\n")}</code>
          </pre>
          {needsCollapse && (
            <button
              type="button"
              className="expand-button"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export const webFetchRenderer: ToolRenderer<
  WebFetchInput,
  WebFetchResult | string
> = {
  tool: "WebFetch",
  displayName: "WebFetch",

  renderToolUse(input, _context) {
    return <WebFetchToolUse input={input as WebFetchInput} />;
  },

  renderToolResult(result, isError, _context, input) {
    return (
      <WebFetchToolResult
        result={result as RenderableWebFetchResult}
        isError={isError}
        input={input as WebFetchInput | undefined}
      />
    );
  },

  getUseSummary(input) {
    const url = (input as WebFetchInput).url;
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result as RenderableWebFetchResult;
    if (isRecord(r) && typeof r.code === "number") {
      return `${r.code} ${getStringField(r, "codeText") ?? ""}`.trim();
    }
    const lineCount = getWebFetchContent(r).split("\n").filter(Boolean).length;
    return lineCount > 0 ? `${lineCount} lines` : "Fetched";
  },
};
