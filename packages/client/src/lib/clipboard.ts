const RECENT_SELECTION_TTL_MS = 2000;

type RecentTextSelection = {
  text: string;
  ranges: Range[];
  recordedAt: number;
};

let recentTextSelection: RecentTextSelection | null = null;
let selectionTrackingCleanup: (() => void) | null = null;

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

export async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}
