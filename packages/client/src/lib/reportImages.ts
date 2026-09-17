/**
 * Report image resilience.
 *
 * Report images are served by `/api/reports/image` and are normally loaded by
 * the browser straight from the `<img src>` emitted by the server-rendered
 * markdown. That native load has no error path: when it fails (asset not yet
 * written when the document was opened, a flaky mobile link, a WebView that
 * dropped the request) the user is left with a bare broken-image icon and no
 * way to retry short of reloading the whole app.
 *
 * This module wraps every report image so that:
 *  - a failed native load is retried through the authenticated `fetch` path,
 *    which also recovers environments where the direct load is blocked;
 *  - if that retry fails too, the reason (e.g. `HTTP 404`) becomes visible and
 *    a retry affordance is rendered.
 *
 * DOM constraint: report comments are anchored by text offsets over
 * `article.textContent`, so this must not introduce any text nodes. All user
 * visible strings are exposed through attributes and painted with CSS
 * pseudo-elements.
 */

const REPORT_IMAGE_ENDPOINT = "/api/reports/image?";
const FRAME_CLASS = "report-image-frame";
const FAILED_CLASS = "report-image-load-failed";
const LOADING_CLASS = "report-image-recovering";
const ENHANCED_FLAG = "reportImageEnhanced";

export interface ReportImageStrings {
  /** Headline shown in place of a broken image. */
  failed: string;
  /** Label for the retry control. */
  retry: string;
}

export interface EnhanceReportImagesOptions {
  /** Aborts in-flight recovery when the document changes or unmounts. */
  signal: AbortSignal;
  /** Authenticated image fetch (adds desktop token / credentials). */
  loadImage: (url: string, signal?: AbortSignal) => Promise<Blob>;
  /**
   * Skip the native load and fetch immediately. Required inside the Tauri
   * desktop iframe, where `<img>` cannot carry the desktop auth token.
   */
  preferFetch: boolean;
  strings: ReportImageStrings;
  /** Collects blob URLs so the caller can revoke them on cleanup. */
  onBlobUrl?: (blobUrl: string) => void;
}

/** Append a cache-busting parameter so a retry bypasses any cached failure. */
function withCacheBuster(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_retry=${Date.now()}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    // "Failed to load report image: HTTP 404" -> "HTTP 404"
    const match = error.message.match(/HTTP\s+\d{3}/);
    return match ? match[0] : error.message;
  }
  return "network error";
}

/** Wrap the image in a positioned frame that can paint the failure state. */
function frameImage(image: HTMLImageElement): HTMLElement {
  const parent = image.parentElement;
  if (parent?.classList.contains(FRAME_CLASS)) return parent;

  const doc = image.ownerDocument;
  const frame = doc.createElement("span");
  frame.className = FRAME_CLASS;
  image.replaceWith(frame);
  frame.append(image);
  return frame;
}

function enhanceReportImage(
  image: HTMLImageElement,
  options: EnhanceReportImagesOptions,
): void {
  image.loading = "lazy";
  image.decoding = "async";

  const source = image.getAttribute("src") ?? "";
  if (!source.includes(REPORT_IMAGE_ENDPOINT)) return;
  if (image.dataset[ENHANCED_FLAG] === "1") return;
  image.dataset[ENHANCED_FLAG] = "1";

  const frame = frameImage(image);
  const doc = image.ownerDocument;

  const retryButton = doc.createElement("button");
  retryButton.type = "button";
  retryButton.className = "report-image-retry";
  retryButton.dataset.label = options.strings.retry;
  retryButton.setAttribute("aria-label", options.strings.retry);
  frame.append(retryButton);

  let blobUrl: string | null = null;
  let recovering = false;

  const clearFailure = () => {
    frame.classList.remove(FAILED_CLASS);
    image.classList.remove(FAILED_CLASS);
    delete frame.dataset.reportImageError;
  };

  const markFailure = (detail: string) => {
    frame.dataset.reportImageError = `${options.strings.failed} · ${detail}`;
    frame.classList.add(FAILED_CLASS);
    image.classList.add(FAILED_CLASS);
  };

  const recover = (bustCache: boolean) => {
    if (recovering || options.signal.aborted) return;
    recovering = true;
    frame.classList.add(LOADING_CLASS);

    options
      .loadImage(bustCache ? withCacheBuster(source) : source, options.signal)
      .then((blob) => {
        if (options.signal.aborted) return;
        const nextUrl = URL.createObjectURL(blob);
        blobUrl = nextUrl;
        options.onBlobUrl?.(nextUrl);
        clearFailure();
        image.src = nextUrl;
      })
      .catch((error: unknown) => {
        if (options.signal.aborted) return;
        console.error("Failed to load report image:", error);
        markFailure(describeError(error));
      })
      .finally(() => {
        recovering = false;
        frame.classList.remove(LOADING_CLASS);
      });
  };

  image.addEventListener("error", () => {
    if (options.signal.aborted) return;
    if (blobUrl && image.src === blobUrl) {
      // The bytes arrived but could not be decoded — retrying the same URL
      // would loop, so surface the failure instead.
      markFailure("decode failed");
      return;
    }
    recover(false);
  });

  image.addEventListener("load", () => {
    if (image.naturalWidth > 0) clearFailure();
  });

  retryButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearFailure();
    recover(true);
  });

  if (options.preferFetch) recover(false);
}

/** Make every report image in `root` self-healing and diagnosable. */
export function enhanceReportImages(
  root: HTMLElement,
  options: EnhanceReportImagesOptions,
): void {
  for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
    enhanceReportImage(image, options);
  }
}
