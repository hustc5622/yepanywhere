import { isManagedUploadDownloadUrl } from "@yep-anywhere/shared";

const RECENT_SELECTION_TTL_MS = 2000;

const USER_INPUT_CLIPBOARD_ATTRIBUTE = "data-yep-anywhere-user-input";
/** v1 carried images only; v2 carries every attachment, in order. */
const USER_INPUT_CLIPBOARD_VERSION = "2";
const USER_INPUT_READABLE_VERSIONS = ["1", "2"];
const ATTACHMENT_NAME_ATTRIBUTE = "data-yep-anywhere-attachment-name";
const ATTACHMENT_TYPE_ATTRIBUTE = "data-yep-anywhere-attachment-type";
const ATTACHMENT_DATA_ATTRIBUTE = "data-yep-anywhere-attachment-data";
const ATTACHMENT_REF_ATTRIBUTE = "data-yep-anywhere-attachment-ref";
const ATTACHMENT_MISSING_ATTRIBUTE = "data-yep-anywhere-attachment-missing";

/** Larger files travel as a same-server reference instead of inline bytes. */
export const CLIPBOARD_INLINE_FILE_LIMIT = 5 * 1024 * 1024;
export const CLIPBOARD_INLINE_TOTAL_LIMIT = 20 * 1024 * 1024;

export interface ClipboardAttachmentSource {
  name: string;
  mimeType?: string;
  /** Reads the bytes to inline (uploads via the active connection, local Files). */
  read?: () => Promise<Blob>;
  /** Browser-readable URL, used when `read` is absent. */
  sourceUrl?: string;
  /**
   * Managed upload path (`/api/projects/.../upload/...`) another Yep composer
   * can fetch again when the file is too large to inline.
   */
  reference?: string;
}

/** @deprecated Images are ordinary attachment sources now. */
export type ClipboardImageSource = ClipboardAttachmentSource;

export interface ClipboardUserInputCopyResult {
  requestedAttachmentCount: number;
  copiedAttachmentCount: number;
  /** Names that could not be read or referenced. */
  failedNames: string[];
}

export type ClipboardAttachmentEntry =
  | { kind: "file"; file: File }
  | { kind: "reference"; name: string; mimeType: string; path: string };

export interface ClipboardUserInput {
  text: string;
  /** Every restorable attachment, in the copied order. */
  attachments: ClipboardAttachmentEntry[];
  /** Attachments the copying side could not include. */
  missingNames: string[];
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

type PreparedAttachment =
  | { kind: "inline"; name: string; mimeType: string; dataUrl: string }
  | { kind: "reference"; name: string; mimeType: string; path: string }
  | { kind: "missing"; name: string };

function buildUserInputClipboardHtml(
  text: string,
  attachments: PreparedAttachment[],
): string {
  const parts = attachments.map((attachment) => {
    const name = escapeHtml(attachment.name);
    if (attachment.kind === "missing") {
      return `<span ${ATTACHMENT_NAME_ATTRIBUTE}="${name}" ${ATTACHMENT_MISSING_ATTRIBUTE}=""></span>`;
    }
    const type = escapeHtml(attachment.mimeType);
    if (attachment.kind === "reference") {
      return `<span ${ATTACHMENT_NAME_ATTRIBUTE}="${name}" ${ATTACHMENT_TYPE_ATTRIBUTE}="${type}" ${ATTACHMENT_REF_ATTRIBUTE}="${escapeHtml(attachment.path)}">${name}</span>`;
    }
    // Images stay visible when pasted into other rich editors; other files
    // keep their bytes in an attribute only Yep reads.
    return attachment.mimeType.startsWith("image/")
      ? `<img src="${escapeHtml(attachment.dataUrl)}" alt="${name}" ${ATTACHMENT_NAME_ATTRIBUTE}="${name}" ${ATTACHMENT_TYPE_ATTRIBUTE}="${type}">`
      : `<span ${ATTACHMENT_NAME_ATTRIBUTE}="${name}" ${ATTACHMENT_TYPE_ATTRIBUTE}="${type}" ${ATTACHMENT_DATA_ATTRIBUTE}="${escapeHtml(attachment.dataUrl)}">${name}</span>`;
  });

  return [
    `<div ${USER_INPUT_CLIPBOARD_ATTRIBUTE}="${USER_INPUT_CLIPBOARD_VERSION}">`,
    `<div style="white-space: pre-wrap">${renderClipboardTextHtml(text)}</div>`,
    ...parts,
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

async function readAttachmentBlob(
  attachment: ClipboardAttachmentSource,
): Promise<Blob> {
  if (attachment.read) return attachment.read();
  const sourceUrl = attachment.sourceUrl?.trim();
  if (!sourceUrl) {
    throw new Error(`No readable source for ${attachment.name}`);
  }
  if (/^data:/i.test(sourceUrl)) {
    const inline = dataUrlToFile(
      sourceUrl,
      attachment.name,
      1,
      attachment.mimeType,
    );
    if (!inline) throw new Error(`Invalid inline data for ${attachment.name}`);
    return inline;
  }
  const response = await fetch(sourceUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error(
      `Unable to load ${attachment.name}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    );
  }
  return response.blob();
}

/** Prefer a specific declared type over generic download types. */
function resolveMimeType(blob: Blob, declared: string | undefined): string {
  const fromBlob = normalizedMimeType(blob.type);
  const fromDeclared = normalizedMimeType(declared);
  if (fromBlob && fromBlob !== "application/octet-stream") return fromBlob;
  return fromDeclared || fromBlob || "application/octet-stream";
}

async function prepareAttachments(
  attachments: ClipboardAttachmentSource[],
): Promise<PreparedAttachment[]> {
  let inlineBytes = 0;
  const prepared: PreparedAttachment[] = [];
  // Sequential: keeps the inline budget deterministic and memory bounded.
  for (const attachment of attachments) {
    const reference =
      attachment.reference && isManagedUploadDownloadUrl(attachment.reference)
        ? attachment.reference
        : undefined;
    const referenceEntry = (mimeType: string): PreparedAttachment | null =>
      reference
        ? {
            kind: "reference",
            name: attachment.name,
            mimeType,
            path: reference,
          }
        : null;
    try {
      const blob = await readAttachmentBlob(attachment);
      const mimeType = resolveMimeType(blob, attachment.mimeType);
      if (
        blob.size <= CLIPBOARD_INLINE_FILE_LIMIT &&
        inlineBytes + blob.size <= CLIPBOARD_INLINE_TOTAL_LIMIT
      ) {
        inlineBytes += blob.size;
        const typed =
          normalizedMimeType(blob.type) === mimeType
            ? blob
            : new Blob([blob], { type: mimeType });
        prepared.push({
          kind: "inline",
          name: attachment.name,
          mimeType,
          dataUrl: await blobToDataUrl(typed, mimeType),
        });
        continue;
      }
      prepared.push(
        referenceEntry(mimeType) ?? { kind: "missing", name: attachment.name },
      );
    } catch {
      prepared.push(
        referenceEntry(
          normalizedMimeType(attachment.mimeType) || "application/octet-stream",
        ) ?? { kind: "missing", name: attachment.name },
      );
    }
  }
  return prepared;
}

function copyResult(
  requested: number,
  prepared: PreparedAttachment[],
): ClipboardUserInputCopyResult {
  const failedNames = prepared.flatMap((attachment) =>
    attachment.kind === "missing" ? [attachment.name] : [],
  );
  return {
    requestedAttachmentCount: requested,
    copiedAttachmentCount: requested - failedNames.length,
    failedNames,
  };
}

/**
 * Copy a complete user input as plain text plus rich HTML that carries every
 * attachment in order. Another Yep composer restores them all as attachments
 * (small files inline, larger ones by managed upload reference); other apps
 * receive the text and the images.
 */
export async function writeClipboardUserInput(
  text: string,
  attachments: ClipboardAttachmentSource[],
): Promise<ClipboardUserInputCopyResult> {
  const requested = attachments.length;
  if (requested === 0) {
    await writeClipboardText(text);
    return {
      requestedAttachmentCount: 0,
      copiedAttachmentCount: 0,
      failedNames: [],
    };
  }

  const allFailed = (): ClipboardUserInputCopyResult => ({
    requestedAttachmentCount: requested,
    copiedAttachmentCount: 0,
    failedNames: attachments.map((attachment) => attachment.name),
  });

  const clipboardItemWriter = getClipboardItemWriter();
  if (
    !clipboardItemWriter ||
    (typeof window !== "undefined" && window.isSecureContext === false)
  ) {
    if (!hasUsableText(text)) {
      throw new Error("Rich clipboard support is required to copy attachments");
    }
    await writeClipboardText(text);
    return allFailed();
  }

  const preparedPromise = prepareAttachments(attachments);
  const htmlBlobPromise = preparedPromise.then(
    (prepared) =>
      new Blob([buildUserInputClipboardHtml(text, prepared)], {
        type: "text/html",
      }),
  );

  try {
    // Start the write before awaiting reads. This preserves the user
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
    const result = copyResult(requested, await preparedPromise);
    if (result.copiedAttachmentCount === 0 && !hasUsableText(text)) {
      throw new Error("No clipboard attachments could be loaded");
    }
    return result;
  } catch (richClipboardError) {
    if (!hasUsableText(text)) throw richClipboardError;
    try {
      await writeClipboardText(text);
      return allFailed();
    } catch (textClipboardError) {
      throw createClipboardError([richClipboardError, textClipboardError]);
    }
  }
}

function clipboardFileExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  if (mimeType.startsWith("image/")) {
    return mimeType.slice("image/".length).replace(/[^a-z0-9]/gi, "") || "png";
  }
  return "bin";
}

function leafClipboardFileName(value: string, fallback: string): string {
  return value.replaceAll("\\", "/").split("/").pop()?.trim() || fallback;
}

function dataUrlToFile(
  dataUrl: string,
  requestedName: string,
  index: number,
  declaredType?: string,
): File | null {
  if (typeof File === "undefined") return null;

  const match = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,([\s\S]*)$/i.exec(
    dataUrl,
  );
  if (!match) return null;

  const mimeType =
    normalizedMimeType(match[1]) ||
    normalizedMimeType(declaredType) ||
    "application/octet-stream";
  const payload = match[4] ?? "";
  let bytes: Uint8Array;
  try {
    if (match[3]) {
      const binary = atob(payload.replace(/\s+/g, ""));
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
  } catch {
    return null;
  }

  const fallbackName = `pasted-${mimeType.startsWith("image/") ? "image" : "file"}-${index}.${clipboardFileExtension(mimeType)}`;
  const name = leafClipboardFileName(requestedName, fallbackName);
  const ownedBytes = new Uint8Array(bytes.length);
  ownedBytes.set(bytes);
  return new File([ownedBytes.buffer], name, { type: mimeType });
}

/** Read a rich user-input copy produced by `writeClipboardUserInput` (v1 or v2). */
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
  const root = USER_INPUT_READABLE_VERSIONS.map((version) =>
    document.querySelector(`[${USER_INPUT_CLIPBOARD_ATTRIBUTE}="${version}"]`),
  ).find(Boolean);
  if (!root) return null;

  const attachments: ClipboardAttachmentEntry[] = [];
  const missingNames: string[] = [];
  const elements = Array.from(
    root.querySelectorAll(`[${ATTACHMENT_NAME_ATTRIBUTE}]`),
  );
  elements.forEach((element, index) => {
    const requestedName = element.getAttribute(ATTACHMENT_NAME_ATTRIBUTE) ?? "";
    const declaredType = element.getAttribute(ATTACHMENT_TYPE_ATTRIBUTE) ?? "";
    if (element.hasAttribute(ATTACHMENT_MISSING_ATTRIBUTE)) {
      if (requestedName) missingNames.push(requestedName);
      return;
    }
    const reference = element.getAttribute(ATTACHMENT_REF_ATTRIBUTE);
    if (reference !== null) {
      // Only managed upload routes: pasted HTML is not authority to fetch
      // arbitrary API paths.
      if (isManagedUploadDownloadUrl(reference) && requestedName) {
        attachments.push({
          kind: "reference",
          name: leafClipboardFileName(requestedName, "attachment"),
          mimeType:
            normalizedMimeType(declaredType) || "application/octet-stream",
          path: reference,
        });
      } else if (requestedName) {
        missingNames.push(requestedName);
      }
      return;
    }
    const dataUrl =
      element.tagName === "IMG"
        ? (element.getAttribute("src") ?? "")
        : (element.getAttribute(ATTACHMENT_DATA_ATTRIBUTE) ?? "");
    const file = dataUrlToFile(dataUrl, requestedName, index + 1, declaredType);
    if (file) attachments.push({ kind: "file", file });
    else if (requestedName) missingNames.push(requestedName);
  });

  let text = "";
  try {
    text = clipboardData.getData("text/plain");
  } catch {
    // The attachments can still be restored if a host dropped text/plain.
  }

  return { text, attachments, missingNames };
}
