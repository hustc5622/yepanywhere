import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type { ToolRenderer, WebSearchInput, WebSearchResult } from "./types";

const MAX_SEARCH_CONTENT_LINES = 40;

interface SearchLink {
  title: string;
  url: string;
}

type RenderableWebSearchResult = WebSearchResult | string | null | undefined;

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

function getCodexWebSearchActionLabel(action: unknown): string | undefined {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return undefined;
  }

  const record = action as Record<string, unknown>;
  const actionType =
    typeof record.type === "string" && record.type.trim()
      ? record.type.trim()
      : undefined;

  if (actionType === "search") {
    const query =
      typeof record.query === "string" && record.query.trim()
        ? record.query.trim()
        : Array.isArray(record.queries) && typeof record.queries[0] === "string"
          ? record.queries[0].trim()
          : undefined;
    return query ? `Search: ${query}` : "Search";
  }

  if (actionType === "open_page" || actionType === "openPage") {
    const url =
      typeof record.url === "string" && record.url.trim()
        ? record.url.trim()
        : undefined;
    return url ? `Open page: ${url}` : "Open page";
  }

  if (actionType === "find_in_page" || actionType === "findInPage") {
    const pattern =
      typeof record.pattern === "string" && record.pattern.trim()
        ? record.pattern.trim()
        : undefined;
    const url =
      typeof record.url === "string" && record.url.trim()
        ? record.url.trim()
        : undefined;
    const target = [pattern, url].filter(Boolean).join(" @ ");
    return target ? `Find in page: ${target}` : "Find in page";
  }

  return actionType;
}

function getWebSearchDisplayText(
  value: WebSearchInput | RenderableWebSearchResult,
  fallback?: string,
) {
  if (!isRecord(value)) {
    return fallback ?? "Web search";
  }

  const record = value as WebSearchInput & WebSearchResult;
  return (
    record.query?.trim() ||
    record.codexActionLabel?.trim() ||
    getCodexWebSearchActionLabel(record.action ?? record.codexAction) ||
    fallback ||
    "Web search"
  );
}

function isRedundantSearchActionLabel(
  actionLabel: string | undefined,
  query: string | undefined,
) {
  if (!actionLabel || !query) return false;
  return actionLabel === `Search: ${query}`;
}

function getRawSearchText(
  result: RenderableWebSearchResult,
): string | undefined {
  if (typeof result === "string") {
    return result.trim() ? result : undefined;
  }

  if (!isRecord(result)) {
    return undefined;
  }

  return (
    getStringField(result, "content") ||
    getStringField(result, "output") ||
    getStringField(result, "text")
  );
}

function cleanUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/g, "");
}

function getUrlTitle(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function pushUniqueLink(links: SearchLink[], link: SearchLink) {
  if (!link.url || links.some((existing) => existing.url === link.url)) {
    return;
  }
  links.push(link);
}

function extractLinksFromText(text: string): SearchLink[] {
  const links: SearchLink[] = [];
  const markdownLinkPattern = /\[([^\]]{1,200})\]\((https?:\/\/[^)\s]+)\)/g;
  const bareUrlPattern = /https?:\/\/[^\s<>"')\]]+/g;

  for (const match of text.matchAll(markdownLinkPattern)) {
    const title = match[1]?.trim();
    const url = match[2] ? cleanUrl(match[2]) : undefined;
    if (url) {
      pushUniqueLink(links, {
        title: title || getUrlTitle(url),
        url,
      });
    }
  }

  for (const match of text.matchAll(bareUrlPattern)) {
    const url = match[0] ? cleanUrl(match[0]) : undefined;
    if (url) {
      pushUniqueLink(links, {
        title: getUrlTitle(url),
        url,
      });
    }
  }

  return links;
}

function collectStructuredLinks(
  result: RenderableWebSearchResult,
): SearchLink[] {
  if (!isRecord(result) || !Array.isArray(result.results)) {
    return [];
  }

  const links: SearchLink[] = [];
  for (const entry of result.results) {
    if (typeof entry === "string") {
      for (const link of extractLinksFromText(entry)) {
        pushUniqueLink(links, link);
      }
      continue;
    }

    if (!isRecord(entry) || !Array.isArray(entry.content)) {
      continue;
    }

    for (const item of entry.content) {
      if (!isRecord(item)) {
        continue;
      }
      const url = getStringField(item, "url");
      if (!url) {
        continue;
      }
      pushUniqueLink(links, {
        title: getStringField(item, "title") || getUrlTitle(url),
        url,
      });
    }
  }

  return links;
}

function collectSearchLinks(result: RenderableWebSearchResult): SearchLink[] {
  const links = collectStructuredLinks(result);
  const rawText = getRawSearchText(result);
  if (rawText) {
    for (const link of extractLinksFromText(rawText)) {
      pushUniqueLink(links, link);
    }
  }
  return links;
}

function WebSearchTextContent({ text }: { text: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = text.split("\n");
  const needsCollapse = lines.length > MAX_SEARCH_CONTENT_LINES;
  const displayLines =
    needsCollapse && !isExpanded
      ? lines.slice(0, MAX_SEARCH_CONTENT_LINES)
      : lines;

  return (
    <>
      <pre className="websearch-content code-block">
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
  );
}

/**
 * WebSearch tool use - shows search query
 */
function WebSearchToolUse({ input }: { input: WebSearchInput }) {
  const displayText = getWebSearchDisplayText(input);
  return (
    <div className="websearch-tool-use">
      <span className="websearch-query">{displayText}</span>
    </div>
  );
}

/**
 * WebSearch tool result - shows search results as links
 */
function WebSearchToolResult({
  result,
  isError,
  input,
}: {
  result: RenderableWebSearchResult;
  isError: boolean;
  input?: WebSearchInput;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("WebSearch", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("WebSearch", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("WebSearch");

  const rawText = getRawSearchText(result);

  if (isError) {
    return (
      <div className="websearch-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebSearch" errors={validationErrors} />
        )}
        {rawText || "Search failed"}
      </div>
    );
  }

  if (!result && !rawText) {
    return <div className="websearch-empty">No results</div>;
  }

  const allResults = collectSearchLinks(result);
  const inputDisplayText = input ? getWebSearchDisplayText(input) : undefined;
  const displayText = getWebSearchDisplayText(result, inputDisplayText);
  const queryText = isRecord(result)
    ? getStringField(result, "query") ||
      (input ? input.query?.trim() : undefined)
    : input?.query?.trim();
  const actionLabel =
    (isRecord(result)
      ? getStringField(result, "codexActionLabel") ||
        getCodexWebSearchActionLabel(result.codexAction)
      : undefined) ||
    (input ? getCodexWebSearchActionLabel(input.action) : undefined);
  const showActionLabel = !isRedundantSearchActionLabel(actionLabel, queryText);
  const durationSeconds =
    isRecord(result) && typeof result.durationSeconds === "number"
      ? result.durationSeconds
      : undefined;

  return (
    <div className="websearch-result">
      <div className="websearch-header">
        <span className="websearch-query-display">
          {queryText ? `"${queryText}"` : displayText}
        </span>
        {durationSeconds !== undefined && (
          <span className="badge">{durationSeconds.toFixed(2)}s</span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebSearch" errors={validationErrors} />
        )}
      </div>
      {actionLabel && actionLabel !== displayText && showActionLabel && (
        <div className="websearch-action">{actionLabel}</div>
      )}
      {allResults.length > 0 ? (
        <ul className="websearch-links">
          {allResults.map((item, i) => (
            <li key={`${item.url}-${i}`} className="websearch-link-item">
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="websearch-link"
              >
                {item.title}
              </a>
              <span className="websearch-url">{item.url}</span>
            </li>
          ))}
        </ul>
      ) : rawText ? null : actionLabel ? null : (
        <div className="websearch-empty">No results found</div>
      )}
      {rawText && <WebSearchTextContent text={rawText} />}
    </div>
  );
}

export const webSearchRenderer: ToolRenderer<
  WebSearchInput,
  WebSearchResult | string
> = {
  tool: "WebSearch",
  displayName: "WebSearch",

  renderToolUse(input, _context) {
    return <WebSearchToolUse input={input as WebSearchInput} />;
  },

  renderToolResult(result, isError, _context, input) {
    return (
      <WebSearchToolResult
        result={result as RenderableWebSearchResult}
        isError={isError}
        input={input as WebSearchInput | undefined}
      />
    );
  },

  getUseSummary(input) {
    return getWebSearchDisplayText(input as WebSearchInput);
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result as RenderableWebSearchResult;
    const count = collectSearchLinks(r).length;
    if (count > 0) {
      return `${count} ${count === 1 ? "link" : "links"}`;
    }
    if (getRawSearchText(r)) {
      return "Search output";
    }
    if (isRecord(r) && (r.codexActionLabel || r.codexAction)) {
      return getWebSearchDisplayText(r);
    }
    return `${count} results`;
  },
};
