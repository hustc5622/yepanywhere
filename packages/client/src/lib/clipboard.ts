const RECENT_SELECTION_TTL_MS = 2000;

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
