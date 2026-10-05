import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../lib/apiPath";

interface PreviewAttachment {
  id: string;
  apiPath?: string;
  mimeType?: string;
}

interface PreviewRequest {
  apiPath: string;
  controller: AbortController;
  url?: string;
}

function imageApiPath(item: PreviewAttachment): string | undefined {
  return /^image\//i.test(item.mimeType ?? "") ? item.apiPath : undefined;
}

function requestUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith(API_BASE)) {
    return path;
  }
  const endpoint = path.startsWith("/api") ? path.slice(4) : path;
  return `${API_BASE}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
}

function releasePreview(request: PreviewRequest): void {
  request.controller.abort();
  if (request.url) URL.revokeObjectURL(request.url);
}

/** Fetch composer thumbnails through the active transport, including remote mode. */
export function useComposerAttachmentPreviews(
  items: readonly PreviewAttachment[],
): Record<string, string> {
  const requestsRef = useRef(new Map<string, PreviewRequest>());
  const [loaded, setLoaded] = useState<
    Record<string, { apiPath: string; url: string }>
  >({});

  useEffect(() => {
    const requests = requestsRef.current;
    const wanted = new Map(
      items.flatMap((item) => {
        const apiPath = imageApiPath(item);
        return apiPath ? [[item.id, apiPath] as const] : [];
      }),
    );
    const publish = () => {
      setLoaded(
        Object.fromEntries(
          [...requests].flatMap(([id, request]) =>
            request.url
              ? [[id, { apiPath: request.apiPath, url: request.url }]]
              : [],
          ),
        ),
      );
    };

    let removed = false;
    for (const [id, request] of requests) {
      if (wanted.get(id) === request.apiPath) continue;
      requests.delete(id);
      releasePreview(request);
      removed ||= !!request.url;
    }
    if (removed) publish();

    for (const [id, apiPath] of wanted) {
      if (requests.has(id)) continue;
      const request: PreviewRequest = {
        apiPath,
        controller: new AbortController(),
      };
      requests.set(id, request);
      void (async () => {
        try {
          const response = await fetch(requestUrl(apiPath), {
            credentials: "include",
            signal: request.controller.signal,
          });
          if (!response.ok) return;
          const blob = await response.blob();
          // Some remote transports cannot cancel an in-flight request.
          if (requests.get(id) !== request) return;
          request.url = URL.createObjectURL(blob);
          publish();
        } catch {
          // A failed thumbnail keeps the attachment's normal image icon.
        }
      })();
    }
  }, [items]);

  useEffect(() => {
    const requests = requestsRef.current;
    return () => {
      for (const request of requests.values()) releasePreview(request);
      requests.clear();
    };
  }, []);

  // Hide a stale URL immediately, before the effect releases its old request.
  return Object.fromEntries(
    items.flatMap((item) => {
      const preview = loaded[item.id];
      return preview && preview.apiPath === imageApiPath(item)
        ? [[item.id, preview.url]]
        : [];
    }),
  );
}
