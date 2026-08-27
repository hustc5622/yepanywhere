const RECENT_SELECTION_TTL_MS = 2000;

const USER_INPUT_CLIPBOARD_ATTRIBUTE = "data-yep-anywhere-user-input";
const USER_INPUT_CLIPBOARD_VERSION = "1";
const USER_INPUT_IMAGE_NAME_ATTRIBUTE = "data-yep-anywhere-attachment-name";

export interface ClipboardImageSource {
  name: string;
  mimeType?: string;
  /** Browser-readable URL. Missing URLs are reported as a partial copy. */
  sourceUrl?: string;
}

export interface ClipboardUserInputCopyResult {
  requestedImageCount: number;
  copiedImageCount: number;
}

export interface ClipboardUserInput {
  text: string;
  images: File[];
}

type RecentTextSelection = {
  text: string;
  ranges: Range[];
  recordedAt: number;
};

let recentTextSelection: RecentTextSelection | null = null;
let selectionTrackingCleanup: (() => void) | null = null;
let suppressSelectionTracking = false;

function hasUsableText(text: string): boolean {
  return text.trim().length > 0;
}

function rangeIntersectsRoot(range: Range, root: Node): boolean {
  if (typeof range.intersectsNode === "function") {
    try {
      return range.intersectsNode(root);
    } catch {
      // Fall through to containment checks for detached or unsupported nodes.
    }
  }

  const commonAncestor = range.commonAncestorContainer;
  return (
    root === commonAncestor ||
    root.contains(commonAncestor) ||
    root.contains(range.startContainer) ||
    root.contains(range.endContainer)
  );
}

function rangesIntersectRoot(ranges: Range[], root?: Node | null): boolean {
  if (!root) return true;
  return ranges.some((range) => rangeIntersectsRoot(range, root));
}

function readCurrentTextSelection(
  root?: Node | null,
): RecentTextSelection | null {
  if (typeof window === "undefined" || !window.getSelection) return null;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const text = selection.toString();
  if (!hasUsableText(text)) return null;

  const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index).cloneRange(),
  );
  if (!rangesIntersectRoot(ranges, root)) return null;

  return {
    text,
    ranges,
    recordedAt: Date.now(),
  };
}

function rememberCurrentTextSelection(): void {
  if (suppressSelectionTracking) return;
  const selection = readCurrentTextSelection();
  if (selection) {
    recentTextSelection = selection;
  }
}

export function initTextSelectionTracking(): () => void {
  if (typeof document === "undefined") return () => {};
  if (selectionTrackingCleanup) return selectionTrackingCleanup;

  document.addEventListener("selectionchange", rememberCurrentTextSelection);

  selectionTrackingCleanup = () => {
    document.removeEventListener(
      "selectionchange",
      rememberCurrentTextSelection,
    );
    selectionTrackingCleanup = null;
    recentTextSelection = null;
  };

  return selectionTrackingCleanup;
}

/**
 * True while the user has a real (non-collapsed) text selection that touches
 * `root`. Callers use this to avoid DOM mutations that would silently destroy
 * an in-progress selection, e.g. prepending older transcript rows or switching
 * the message list into virtualized mode.
 *
 * Deliberately avoids `selection.toString()`: this runs on `selectionchange`,
 * and serializing a large selection on every drag frame is expensive.
 */
export function hasActiveTextSelectionWithin(root?: Node | null): boolean {
  if (typeof window === "undefined" || !window.getSelection) return false;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  if (!root) return true;

  const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index),
  );
  return rangesIntersectRoot(ranges, root);
}

export function getSelectionAwareCopyText(
  fallbackText: string,
  root?: Node | null,
): string {
  const currentSelection = readCurrentTextSelection(root);
  if (currentSelection) {
    recentTextSelection = currentSelection;
    return currentSelection.text;
  }

  if (
    recentTextSelection &&
    Date.now() - recentTextSelection.recordedAt <= RECENT_SELECTION_TTL_MS &&
    rangesIntersectRoot(recentTextSelection.ranges, root)
  ) {
    return recentTextSelection.text;
  }

  return fallbackText;
}

type TextControlSelection = {
  element: HTMLInputElement | HTMLTextAreaElement;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
};

function getTextControlSelection(
  element: HTMLElement | null,
): TextControlSelection | null {
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement)
  ) {
    return null;
  }

  try {
    const { selectionStart, selectionEnd, selectionDirection } = element;
    if (selectionStart === null || selectionEnd === null) return null;
    return {
      element,
      start: selectionStart,
      end: selectionEnd,
      direction: selectionDirection ?? "none",
    };
  } catch {
    return null;
  }
}

function restoreFocusAndSelection(
  activeElement: HTMLElement | null,
  textControlSelection: TextControlSelection | null,
  selection: Selection | null,
  ranges: Range[],
): void {
  if (activeElement?.isConnected) {
    try {
      activeElement.focus({ preventScroll: true });
    } catch {
      // Focus restoration is best-effort and must not mask the copy result.
    }
  }

  if (textControlSelection?.element.isConnected) {
    try {
      textControlSelection.element.setSelectionRange(
        textControlSelection.start,
        textControlSelection.end,
        textControlSelection.direction,
      );
    } catch {
      // Some input types expose selectionStart but reject setSelectionRange.
    }
  }

  if (selection) {
    try {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    } catch {
      // DOM mutations can detach a saved range; restoration remains best-effort.
    }
  }
}

function writeClipboardTextWithExecCommand(text: string): void {
  if (typeof document === "undefined" || !document.body) {
    throw new Error("Clipboard fallback requires a document body");
  }

  const execCommand = document.execCommand;
  if (typeof execCommand !== "function") {
    throw new Error("Clipboard fallback is unavailable");
  }

  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const textControlSelection = getTextControlSelection(activeElement);
  const selection =
    typeof window !== "undefined" ? window.getSelection() : null;
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const previousRecentTextSelection = recentTextSelection;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.setAttribute("data-yep-clipboard-fallback", "");
  textarea.tabIndex = -1;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);

  suppressSelectionTracking = true;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    if (!execCommand.call(document, "copy")) {
      throw new Error("Clipboard fallback was rejected");
    }
  } finally {
    textarea.remove();
    restoreFocusAndSelection(
      activeElement,
      textControlSelection,
      selection,
      ranges,
    );
    recentTextSelection = previousRecentTextSelection;
    suppressSelectionTracking = false;
  }
}

function getClipboardWriter(): ((text: string) => Promise<void>) | null {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.clipboard?.writeText !== "function"
  ) {
    return null;
  }
  return navigator.clipboard.writeText.bind(navigator.clipboard);
}

function createClipboardError(errors: unknown[]): Error {
  return new AggregateError(errors, "Unable to copy text to the clipboard");
}

export async function writeClipboardText(text: string): Promise<void> {
  const clipboardWriter = getClipboardWriter();

  // The async Clipboard API is unavailable by specification in an insecure
  // context. Going straight to the synchronous fallback also preserves the
  // transient user activation required by older Android WebViews.
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    try {
      writeClipboardTextWithExecCommand(text);
      return;
    } catch (fallbackError) {
      if (!clipboardWriter) throw fallbackError;
      try {
        await clipboardWriter(text);
        return;
      } catch (clipboardError) {
        throw createClipboardError([fallbackError, clipboardError]);
      }
    }
  }

  if (clipboardWriter) {
    try {
      await clipboardWriter(text);
      return;
    } catch (clipboardError) {
      try {
        writeClipboardTextWithExecCommand(text);
        return;
      } catch (fallbackError) {
        throw createClipboardError([clipboardError, fallbackError]);
      }
    }
  }

  writeClipboardTextWithExecCommand(text);
}

interface LoadedClipboardImage {
  dataUrl: string;
  name: string;
}

function getClipboardItemWriter():
  | ((items: ClipboardItem[]) => Promise<void>)
  | null {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.clipboard?.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    return null;
  }

  if (typeof ClipboardItem.supports === "function") {
    try {
      if (!ClipboardItem.supports("text/html")) return null;
    } catch {
      return null;
    }
  }

  return navigator.clipboard.write.bind(navigator.clipboard);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderClipboardTextHtml(text: string): string {
  return escapeHtml(text).replaceAll("\n", "<br>");
}

function buildUserInputClipboardHtml(
  text: string,
  images: LoadedClipboardImage[],
): string {
  const renderedImages = images
    .map(
      (image) =>
        `<img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name)}" ${USER_INPUT_IMAGE_NAME_ATTRIBUTE}="${escapeHtml(image.name)}">`,
    )
    .join("");

  return [
    `<div ${USER_INPUT_CLIPBOARD_ATTRIBUTE}="${USER_INPUT_CLIPBOARD_VERSION}">`,
    `<div style="white-space: pre-wrap">${renderClipboardTextHtml(text)}</div>`,
    renderedImages,
    "</div>",
  ].join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

async function blobToDataUrl(blob: Blob, mimeType: string): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
        } else {
          reject(new Error("Unable to encode clipboard image"));
        }
      });
      reader.addEventListener("error", () => {
        reject(reader.error ?? new Error("Unable to read clipboard image"));
      });
      reader.readAsDataURL(blob);
    });
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

function normalizedMimeType(value: string | undefined): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function loadClipboardImage(
  image: ClipboardImageSource,
): Promise<LoadedClipboardImage> {
  const sourceUrl = image.sourceUrl?.trim();
  if (!sourceUrl) {
    throw new Error(`No browser-readable URL for ${image.name}`);
  }

  const inlineMatch = /^data:(image\/[^;,]+)(?:;base64)?,/i.exec(sourceUrl);
  if (inlineMatch) {
    return { dataUrl: sourceUrl, name: image.name };
  }

  const response = await fetch(sourceUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error(
      `Unable to load ${image.name}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    );
  }

  const responseBlob = await response.blob();
  const responseMimeType = normalizedMimeType(responseBlob.type);
  const declaredMimeType = normalizedMimeType(image.mimeType);
  const mimeType = responseMimeType.startsWith("image/")
    ? responseMimeType
    : declaredMimeType;
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Clipboard attachment is not an image: ${image.name}`);
  }

  const blob =
    responseMimeType === mimeType
      ? responseBlob
      : new Blob([responseBlob], { type: mimeType });
  return {
    dataUrl: await blobToDataUrl(blob, mimeType),
    name: image.name,
  };
}

/**
 * Copy a complete user input as plain text plus rich HTML containing every
 * readable image. The HTML carries a small Yep marker so another Yep input can
 * restore all images as file attachments, even on platforms whose native
 * clipboard supports only one item.
 */
export async function writeClipboardUserInput(
  text: string,
  images: ClipboardImageSource[],
): Promise<ClipboardUserInputCopyResult> {
  const requestedImageCount = images.length;
  if (requestedImageCount === 0) {
    await writeClipboardText(text);
    return { requestedImageCount, copiedImageCount: 0 };
  }

  const clipboardItemWriter = getClipboardItemWriter();
  if (
    !clipboardItemWriter ||
    (typeof window !== "undefined" && window.isSecureContext === false)
  ) {
    if (!hasUsableText(text)) {
      throw new Error("Rich clipboard support is required to copy images");
    }
    await writeClipboardText(text);
    return { requestedImageCount, copiedImageCount: 0 };
  }

  const loadedImagesPromise = Promise.allSettled(
    images.map((image) => loadClipboardImage(image)),
  ).then((results) =>
    results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    ),
  );
  const htmlBlobPromise = loadedImagesPromise.then(
    (loadedImages) =>
      new Blob([buildUserInputClipboardHtml(text, loadedImages)], {
        type: "text/html",
      }),
  );

  try {
    // Start the write before awaiting image requests. This preserves the user
    // activation required by Safari/WebView while ClipboardItem resolves the
    // representation promises asynchronously.
    const item = new ClipboardItem(
      {
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": htmlBlobPromise,
      },
      { presentationStyle: "inline" },
    );
    await clipboardItemWriter([item]);
    const loadedImages = await loadedImagesPromise;
    if (loadedImages.length === 0 && !hasUsableText(text)) {
      throw new Error("No clipboard images could be loaded");
    }
    return {
      requestedImageCount,
      copiedImageCount: loadedImages.length,
    };
  } catch (richClipboardError) {
    if (!hasUsableText(text)) throw richClipboardError;
    try {
      await writeClipboardText(text);
      return { requestedImageCount, copiedImageCount: 0 };
    } catch (textClipboardError) {
      throw createClipboardError([richClipboardError, textClipboardError]);
    }
  }
}

function clipboardImageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  return mimeType.slice("image/".length).replace(/[^a-z0-9]/gi, "") || "png";
}

function leafClipboardFileName(value: string, fallback: string): string {
  return value.replaceAll("\\", "/").split("/").pop()?.trim() || fallback;
}

function dataUrlToImageFile(
  dataUrl: string,
  requestedName: string,
  index: number,
): File | null {
  if (typeof File === "undefined") return null;

  const match = /^data:(image\/[^;,]+)(;base64)?,([\s\S]*)$/i.exec(dataUrl);
  if (!match) return null;

  const mimeType = normalizedMimeType(match[1]);
  const payload = match[3] ?? "";
  let bytes: Uint8Array;
  try {
    if (match[2]) {
      const binary = atob(payload.replace(/\s+/g, ""));
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
  } catch {
    return null;
  }

  const fallbackName = `pasted-image-${index}.${clipboardImageExtension(mimeType)}`;
  const name = leafClipboardFileName(requestedName, fallbackName);
  const ownedBytes = new Uint8Array(bytes.length);
  ownedBytes.set(bytes);
  return new File([ownedBytes.buffer], name, { type: mimeType });
}

/** Read a rich user-input copy produced by `writeClipboardUserInput`. */
export function readClipboardUserInput(
  clipboardData: Pick<DataTransfer, "getData"> | null | undefined,
): ClipboardUserInput | null {
  if (!clipboardData || typeof DOMParser === "undefined") return null;

  let html: string;
  try {
    html = clipboardData.getData("text/html");
  } catch {
    return null;
  }
  if (!html) return null;

  const document = new DOMParser().parseFromString(html, "text/html");
  const root = document.querySelector(
    `[${USER_INPUT_CLIPBOARD_ATTRIBUTE}="${USER_INPUT_CLIPBOARD_VERSION}"]`,
  );
  if (!root) return null;

  const images = Array.from(
    root.querySelectorAll(`img[${USER_INPUT_IMAGE_NAME_ATTRIBUTE}]`),
  ).flatMap((element, index) => {
    const dataUrl = element.getAttribute("src") ?? "";
    const requestedName =
      element.getAttribute(USER_INPUT_IMAGE_NAME_ATTRIBUTE) ?? "";
    const file = dataUrlToImageFile(dataUrl, requestedName, index + 1);
    return file ? [file] : [];
  });

  let text = "";
  try {
    text = clipboardData.getData("text/plain");
  } catch {
    // The images can still be restored if a host dropped text/plain.
  }

  return { text, images };
}
