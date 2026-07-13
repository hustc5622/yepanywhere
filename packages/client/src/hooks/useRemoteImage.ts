import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../lib/apiPath";

/**
 * For browser fetches under a reverse-proxy prefix (Caddy mounts the
 * server at /yep/), a callsite passing "/api/foo" would resolve against
 * the document host root and miss the mounted server. Templating with
 * BASE_URL here lets every existing caller keep passing "/api/foo".
 */
function directApiUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  if (path.startsWith(API_BASE)) return path;

  const endpoint = path.startsWith("/api") ? path.slice(4) : path;
  return `${API_BASE}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
}

interface RemoteImageResult {
  /** URL to use for the image src (either direct path or blob URL) */
  url: string | null;
  /** Whether the image is currently loading */
  loading: boolean;
  /** Error message if loading failed */
  error: string | null;
  /** Size of fetched image bytes, when loaded through fetch */
  bytes: number | null;
  /** MIME type of fetched image bytes, when available */
  mimeType: string | null;
}

const MAX_ERROR_RESPONSE_CHARS = 500;

function truncateErrorResponse(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_ERROR_RESPONSE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_ERROR_RESPONSE_CHARS)}…`;
}

async function describeFailedResponse(
  response: Response,
  requestUrl: string,
): Promise<string> {
  const statusText = response.statusText.trim();
  const contentType = response.headers.get("content-type") ?? "unknown";
  const details = [
    `Image request failed: HTTP ${response.status}${statusText ? ` ${statusText}` : ""}`,
    `URL: ${requestUrl}`,
    `Content-Type: ${contentType}`,
  ];

  try {
    const responseText = truncateErrorResponse(await response.text());
    if (responseText) details.push(`Response: ${responseText}`);
  } catch {
    details.push("Response: <unreadable response body>");
  }

  return details.join("\n");
}

/**
 * Hook for loading images by API path.
 *
 * Returns a browser-loadable URL for use as an image src. Retained for
 * call-site compatibility; it does not fetch the image bytes.
 *
 * @param apiPath - The API path for the image (e.g., "/api/projects/.../upload/image.png")
 * @returns Object with url, loading state, and error
 */
export function useRemoteImage(apiPath: string | null): RemoteImageResult {
  const url = apiPath ? directApiUrl(apiPath) : null;
  return {
    url,
    loading: false,
    error: null,
    bytes: null,
    mimeType: null,
  };
}

/**
 * Hook that always fetches images via fetch and returns a blob URL.
 * Unlike useRemoteImage, this fetches the bytes so auth headers/cookies are
 * included (important for endpoints that require authentication like
 * /api/local-image).
 */
export function useFetchedImage(apiPath: string | null): RemoteImageResult {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!apiPath) {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setBlobUrl(null);
      setError(null);
      setBytes(null);
      setMimeType(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setBytes(null);
    setMimeType(null);

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
      setBlobUrl(null);
    }

    const requestUrl = directApiUrl(apiPath);

    fetch(requestUrl, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(await describeFailedResponse(res, requestUrl));
        }
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobUrl(url);
        setBytes(blob.size);
        setMimeType(blob.type || null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const rawMessage =
          err instanceof Error ? err.message : String(err ?? "Unknown error");
        const message = rawMessage.includes("\nURL:")
          ? rawMessage
          : `Image request failed: ${rawMessage}\nURL: ${requestUrl}`;
        console.error("[useFetchedImage] Failed to fetch image", {
          apiPath,
          requestUrl,
          error: message,
        });
        setError(message);
        setBytes(null);
        setMimeType(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [apiPath]);

  if (!apiPath) {
    return {
      url: null,
      loading: false,
      error: null,
      bytes: null,
      mimeType: null,
    };
  }

  return { url: blobUrl, loading, error, bytes, mimeType };
}

/**
 * Resolve an image API path. Retained for call-site compatibility.
 *
 * @param apiPath - The API path for the image
 * @returns A browser-loadable URL for the API path
 */
export async function preloadRemoteImage(
  apiPath: string,
): Promise<string | null> {
  return directApiUrl(apiPath);
}
