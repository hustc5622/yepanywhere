import type { FileContentResponse } from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../lib/apiPath";
import { DetailPanel } from "./ui/DetailPanel";

interface LocalFileModalProps {
  path: string;
  lineNumber?: number;
  columnNumber?: number;
  onClose: () => void;
}

interface LocalFileResponse extends FileContentResponse {
  lineNumber?: number;
  columnNumber?: number;
}

export interface LocalFileTarget {
  path: string;
  lineNumber?: number;
  columnNumber?: number;
}

function getFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function localFileApiPath({
  path,
  lineNumber,
  columnNumber,
}: LocalFileTarget): string {
  const params = new URLSearchParams({ path });
  if (lineNumber !== undefined) params.set("line", String(lineNumber));
  if (columnNumber !== undefined) params.set("column", String(columnNumber));
  return `/api/local-file?${params.toString()}`;
}

export function extractLocalFileTargetFromUrl(
  href: string,
): LocalFileTarget | null {
  try {
    const url = new URL(href, "http://localhost");
    if (!url.pathname.endsWith("/api/local-file")) return null;
    const path = url.searchParams.get("path");
    if (!path) return null;
    return {
      path,
      lineNumber: parseOptionalNumber(url.searchParams.get("line")),
      columnNumber: parseOptionalNumber(url.searchParams.get("column")),
    };
  } catch {
    return null;
  }
}

function directApiUrl(path: string): string {
  if (path.startsWith(API_BASE)) return path;
  return `${API_BASE}${path.startsWith("/api") ? path.slice(4) : path}`;
}

export function LocalFileModal({
  path,
  lineNumber,
  columnNumber,
  onClose,
}: LocalFileModalProps) {
  const [data, setData] = useState<LocalFileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    const apiPath = localFileApiPath({ path, lineNumber, columnNumber });
    fetch(directApiUrl(apiPath), { credentials: "include" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          const message =
            typeof body?.error === "string"
              ? body.error
              : `${response.status} ${response.statusText}`;
          throw new Error(message);
        }
        return body as LocalFileResponse;
      })
      .then((body) => {
        if (!cancelled) {
          setData(body);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load file");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path, lineNumber, columnNumber]);

  const highlightedLine = lineNumber ?? data?.lineNumber;
  const title = getFileName(path);
  const content = data?.content ?? "";

  const setHighlightedLineElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      requestAnimationFrame(() => {
        if (typeof element.scrollIntoView !== "function") return;
        element.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
      });
    },
    [],
  );

  const showMarkdownPreview =
    !!data?.renderedMarkdownHtml && highlightedLine === undefined;

  return (
    <DetailPanel title={title} onClose={onClose}>
      <div className="local-file-modal-content">
        {loading && <div className="local-file-loading">Loading...</div>}
        {error && (
          <div className="local-file-error">
            <div>{error}</div>
            <code>{path}</code>
          </div>
        )}
        {data && (
          <>
            <div className="local-file-meta" title={path}>
              {path}
            </div>
            {showMarkdownPreview ? (
              <div className="markdown-preview">
                <div
                  className="markdown-rendered"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered sanitized markdown HTML
                  dangerouslySetInnerHTML={{
                    __html: data.renderedMarkdownHtml ?? "",
                  }}
                />
              </div>
            ) : (
              <pre className="local-file-text">
                <code>
                  {content.split("\n").map((line, index) => {
                    const currentLine = index + 1;
                    const isHighlighted = currentLine === highlightedLine;
                    return (
                      <div
                        key={`${currentLine}-${line}`}
                        ref={
                          isHighlighted ? setHighlightedLineElement : undefined
                        }
                        className={`local-file-line${isHighlighted ? " highlighted-line" : ""}`}
                      >
                        <span className="local-file-line-number">
                          {currentLine}
                        </span>
                        <span className="local-file-line-content">
                          {line || " "}
                        </span>
                      </div>
                    );
                  })}
                </code>
              </pre>
            )}
          </>
        )}
      </div>
    </DetailPanel>
  );
}
