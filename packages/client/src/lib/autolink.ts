/**
 * Shared autolink helpers for turning bare URLs inside provider text into
 * links, without swallowing the prose that follows them.
 *
 * A naive `https?:\/\/\S+` match is wrong for Chinese text: CJK writing puts
 * full-width punctuation and following words directly against a URL with no
 * space in between (`https://example.com/，完成上线验收`), so the comma and the
 * rest of the sentence end up inside `href`. Treat CJK / full-width / general
 * punctuation blocks and quoting characters as URL boundaries, then trim the
 * ASCII sentence punctuation that can still legitimately abut a URL.
 */

const BARE_URL_STOP_CLASS =
  "\\s<>\"'`\\u2000-\\u206F\\u2E80-\\uA4CF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFE10-\\uFE4F\\uFF00-\\uFFEF";

/** Regex source for a bare `http(s)` URL, usable inside a larger pattern. */
export const BARE_URL_SOURCE = `https?://[^${BARE_URL_STOP_CLASS}]+`;

/** Regex source for an inline Markdown link, capturing label then URL. */
export const MARKDOWN_LINK_SOURCE =
  "\\[([^\\]\\n]{1,300})\\]\\((https?://[^\\s)]+)\\)";

/** Fresh stateful matcher for bare URLs (each call gets its own `lastIndex`). */
export function createBareUrlPattern(): RegExp {
  return new RegExp(BARE_URL_SOURCE, "gi");
}

/**
 * Fresh matcher for Markdown links plus bare URLs. Capture groups:
 * 1 = Markdown label, 2 = Markdown URL, 3 = bare URL.
 */
export function createLinkPattern(): RegExp {
  return new RegExp(`${MARKDOWN_LINK_SOURCE}|(${BARE_URL_SOURCE})`, "gi");
}

const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", '"', "'"]);

const CLOSING_PAIRS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

function countChar(value: string, char: string): number {
  let total = 0;
  for (const candidate of value) if (candidate === char) total += 1;
  return total;
}

/**
 * Split sentence punctuation that a bare URL match greedily absorbed, e.g.
 * `https://example.com/.` or an unbalanced `https://example.com/foo)`.
 * Balanced brackets are kept, so `.../wiki/Foo_(bar)` survives intact.
 */
export function splitTrailingUrlPunctuation(url: string): [string, string] {
  let end = url.length;

  while (end > 0) {
    const char = url[end - 1] ?? "";
    if (TRAILING_PUNCTUATION.has(char)) {
      end -= 1;
      continue;
    }
    const opening = CLOSING_PAIRS[char];
    if (opening) {
      const head = url.slice(0, end);
      if (countChar(head, char) > countChar(head, opening)) {
        end -= 1;
        continue;
      }
    }
    break;
  }

  return [url.slice(0, end), url.slice(end)];
}

/** `splitTrailingUrlPunctuation` keeping only the URL part. */
export function trimUrlTrailingPunctuation(url: string): string {
  return splitTrailingUrlPunctuation(url)[0];
}
