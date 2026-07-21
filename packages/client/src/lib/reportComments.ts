import type { ReportComment, ReportCommentAnchor } from "@yep-anywhere/shared";

export interface ResolvedReportCommentAnchor {
  start: number;
  end: number;
}

const ANCHOR_CONTEXT_LENGTH = 64;
const HIGHLIGHT_SELECTOR = ".report-comment-highlight";

/** Build a Web Annotation-style text quote selector from a DOM selection. */
export function createReportCommentAnchor(
  root: HTMLElement,
  range: Range,
): ReportCommentAnchor | null {
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return null;
  }

  const selectedText = range.toString();
  const exact = selectedText.trim();
  if (!exact) return null;

  const leadingWhitespace =
    selectedText.length - selectedText.trimStart().length;
  const before = root.ownerDocument.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);

  const fullText = root.textContent ?? "";
  const start = before.toString().length + leadingWhitespace;
  const end = start + exact.length;
  if (fullText.slice(start, end) !== exact) return null;

  return {
    exact,
    prefix: fullText.slice(Math.max(0, start - ANCHOR_CONTEXT_LENGTH), start),
    suffix: fullText.slice(end, end + ANCHOR_CONTEXT_LENGTH),
    start,
    end,
  };
}

/**
 * Resolve a saved selector against current rendered text. The original offset
 * is fastest; quote plus surrounding text recovers from nearby edits.
 */
export function resolveReportCommentAnchor(
  text: string,
  anchor: ReportCommentAnchor,
): ResolvedReportCommentAnchor | null {
  if (
    anchor.start >= 0 &&
    anchor.end === anchor.start + anchor.exact.length &&
    text.slice(anchor.start, anchor.end) === anchor.exact
  ) {
    return { start: anchor.start, end: anchor.end };
  }

  const candidates: Array<ResolvedReportCommentAnchor & { score: number }> = [];
  let searchFrom = 0;
  while (searchFrom <= text.length - anchor.exact.length) {
    const start = text.indexOf(anchor.exact, searchFrom);
    if (start < 0) break;
    const end = start + anchor.exact.length;
    candidates.push({
      start,
      end,
      score:
        matchingPrefixLength(text.slice(0, start), anchor.prefix) +
        matchingSuffixLength(text.slice(end), anchor.suffix),
    });
    searchFrom = start + Math.max(1, anchor.exact.length);
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    return candidate ? { start: candidate.start, end: candidate.end } : null;
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const runnerUp = candidates[1];
  if (!best || best.score === 0 || best.score === runnerUp?.score) return null;
  return { start: best.start, end: best.end };
}

function matchingPrefixLength(textBefore: string, prefix: string): number {
  let count = 0;
  const max = Math.min(textBefore.length, prefix.length);
  while (
    count < max &&
    textBefore[textBefore.length - count - 1] ===
      prefix[prefix.length - count - 1]
  ) {
    count += 1;
  }
  return count;
}

function matchingSuffixLength(textAfter: string, suffix: string): number {
  let count = 0;
  const max = Math.min(textAfter.length, suffix.length);
  while (count < max && textAfter[count] === suffix[count]) {
    count += 1;
  }
  return count;
}

/** Remove previously injected highlights without changing the rendered text. */
export function clearReportCommentHighlights(root: HTMLElement): void {
  const highlights = Array.from(root.querySelectorAll(HIGHLIGHT_SELECTOR));
  for (const highlight of highlights) {
    highlight.replaceWith(...Array.from(highlight.childNodes));
  }
  root.normalize();
}

/** Inject clickable underline segments for every comment that still resolves. */
export function applyReportCommentHighlights(
  root: HTMLElement,
  comments: ReportComment[],
  accessibleLabel: string,
): Map<string, ResolvedReportCommentAnchor> {
  clearReportCommentHighlights(root);

  const fullText = root.textContent ?? "";
  const resolved = new Map<string, ResolvedReportCommentAnchor>();
  for (const comment of comments) {
    const range = resolveReportCommentAnchor(fullText, comment.anchor);
    if (range) resolved.set(comment.id, range);
  }
  if (resolved.size === 0) return resolved;

  const document = root.ownerDocument;
  const showText = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = document.createTreeWalker(root, showText);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }

  let nodeStart = 0;
  for (const textNode of textNodes) {
    const value = textNode.data;
    const nodeEnd = nodeStart + value.length;
    const intersecting = comments.flatMap((comment) => {
      const range = resolved.get(comment.id);
      if (!range || range.start >= nodeEnd || range.end <= nodeStart) return [];
      return [{ comment, range }];
    });

    if (intersecting.length > 0) {
      const boundaries = new Set<number>([0, value.length]);
      for (const { range } of intersecting) {
        boundaries.add(Math.max(0, range.start - nodeStart));
        boundaries.add(Math.min(value.length, range.end - nodeStart));
      }
      const points = Array.from(boundaries).sort((a, b) => a - b);
      const fragment = document.createDocumentFragment();

      for (let index = 0; index < points.length - 1; index += 1) {
        const localStart = points[index];
        const localEnd = points[index + 1];
        if (localStart === undefined || localEnd === undefined) continue;
        const segment = value.slice(localStart, localEnd);
        const segmentStart = nodeStart + localStart;
        const segmentEnd = nodeStart + localEnd;
        const covering = intersecting.filter(
          ({ range }) => range.start < segmentEnd && range.end > segmentStart,
        );

        if (covering.length === 0) {
          fragment.append(document.createTextNode(segment));
          continue;
        }

        const highlight = document.createElement("mark");
        highlight.className = "report-comment-highlight";
        highlight.dataset.reportCommentIds = covering
          .map(({ comment }) => comment.id)
          .join(",");
        highlight.setAttribute("role", "button");
        highlight.setAttribute("tabindex", "0");
        highlight.setAttribute("aria-label", accessibleLabel);
        highlight.append(document.createTextNode(segment));
        fragment.append(highlight);
      }

      textNode.replaceWith(fragment);
    }
    nodeStart = nodeEnd;
  }

  return resolved;
}
