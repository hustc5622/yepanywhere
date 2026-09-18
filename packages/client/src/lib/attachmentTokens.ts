/**
 * Inline attachment tokens.
 *
 * Attachments used to be listed below the composer, which lost the ordering
 * information between text and images. Instead we insert a short textual
 * token at the caret position (`@[name.png]`) so the prompt itself records
 * where each file belongs. The composer highlights the token as a chip and
 * the transcript renders it inline in the user bubble.
 */

/** Matches `@[some name.png]` tokens. */
const TOKEN_PATTERN = /@\[([^[\]\n]+)\]/g;

export interface AttachmentTokenMatch {
  /** Index of the leading `@`. */
  start: number;
  /** Index just past the closing `]`. */
  end: number;
  /** Sanitized attachment name carried by the token. */
  name: string;
  /** Raw token text. */
  raw: string;
}

export type ComposerSegment =
  | { type: "text"; value: string }
  | { type: "token"; name: string; raw: string; start: number; end: number };

/**
 * Normalizes a file name so it can live inside a token without breaking the
 * `@[...]` delimiters.
 *
 * Uses the same character class as the server-side attachment manifest
 * (`safeAttachmentLabel` in `packages/server/src/sdk/messageQueue.ts`) so a
 * token in the prompt text always matches the name listed in the manifest.
 */
export function sanitizeAttachmentTokenName(name: string): string {
  const leaf = name.split(/[\\/]/).at(-1) ?? name;
  return (
    leaf
      .replace(/[^\p{L}\p{N} ._()+@-]+/gu, "_")
      .trim()
      .slice(0, 160) || "attachment"
  );
}

/** Builds the inline token text for an attachment name. */
export function buildAttachmentToken(name: string): string {
  return `@[${sanitizeAttachmentTokenName(name)}]`;
}

/**
 * Finds attachment tokens in `text`.
 *
 * When `names` is provided, only tokens whose name matches a known attachment
 * are returned, so unrelated `@[...]` text typed by the user is left alone.
 */
export function findAttachmentTokens(
  text: string,
  names?: Iterable<string>,
): AttachmentTokenMatch[] {
  const allowed = names
    ? new Set([...names].map(sanitizeAttachmentTokenName))
    : null;
  const matches: AttachmentTokenMatch[] = [];
  const pattern = new RegExp(TOKEN_PATTERN.source, "g");
  let match = pattern.exec(text);
  while (match) {
    const name = match[1] ?? "";
    if (!allowed || allowed.has(name)) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        name,
        raw: match[0],
      });
    }
    match = pattern.exec(text);
  }
  return matches;
}

/** Number of tokens referencing `name`. */
export function countAttachmentTokens(text: string, name: string): number {
  const target = sanitizeAttachmentTokenName(name);
  return findAttachmentTokens(text).filter((token) => token.name === target)
    .length;
}

/** True when `text` already references `name`. */
export function hasAttachmentToken(text: string, name: string): boolean {
  return countAttachmentTokens(text, name) > 0;
}

/**
 * Inserts an attachment token at `cursor`, padding with single spaces so the
 * token never glues onto neighbouring words.
 */
export function insertAttachmentToken(
  text: string,
  cursor: number,
  name: string,
): { text: string; cursor: number } {
  const token = buildAttachmentToken(name);
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, safeCursor);
  const after = text.slice(safeCursor);
  const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trailing = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const nextText = `${before}${leading}${token}${trailing}${after}`;
  return {
    text: nextText,
    cursor: before.length + leading.length + token.length + trailing.length,
  };
}

/**
 * Removes the last token referencing `name` (the most likely one the user
 * wants gone when they dismiss a chip), collapsing leftover double spaces.
 */
export function removeAttachmentToken(text: string, name: string): string {
  const target = sanitizeAttachmentTokenName(name);
  const tokens = findAttachmentTokens(text).filter(
    (token) => token.name === target,
  );
  const token = tokens.at(-1);
  if (!token) return text;

  let start = token.start;
  let end = token.end;
  // Swallow one adjacent space so removing a token does not leave "a  b".
  if (text[end] === " " && /\s|^$/.test(text[start - 1] ?? "")) {
    end += 1;
  } else if (text[start - 1] === " ") {
    start -= 1;
  }
  return text.slice(0, start) + text.slice(end);
}

/** Splits text into plain runs and attachment token runs, in order. */
export function splitByAttachmentTokens(
  text: string,
  names?: Iterable<string>,
): ComposerSegment[] {
  const tokens = findAttachmentTokens(text, names);
  if (tokens.length === 0) {
    return text ? [{ type: "text", value: text }] : [];
  }

  const segments: ComposerSegment[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, token.start) });
    }
    segments.push({
      type: "token",
      name: token.name,
      raw: token.raw,
      start: token.start,
      end: token.end,
    });
    cursor = token.end;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }
  return segments;
}

/**
 * Handles Backspace/Delete next to an inline token so the chip behaves like a
 * single atomic character instead of losing one letter at a time.
 *
 * Returns `null` when the caret is not adjacent to (or inside) a token, in
 * which case the caller should let the browser handle the key normally.
 */
export function deleteAttachmentTokenAtCaret(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  direction: "backward" | "forward",
  names?: Iterable<string>,
): { text: string; cursor: number; name: string } | null {
  if (selectionStart !== selectionEnd) return null;

  const caret = selectionStart;
  const token = findAttachmentTokens(text, names).find((candidate) =>
    direction === "backward"
      ? caret > candidate.start && caret <= candidate.end
      : caret >= candidate.start && caret < candidate.end,
  );
  if (!token) return null;

  let start = token.start;
  let end = token.end;
  // Swallow one adjacent space so the sentence does not keep a double gap.
  if (text[end] === " " && /\s|^$/.test(text[start - 1] ?? "")) {
    end += 1;
  } else if (text[start - 1] === " ") {
    start -= 1;
  }

  return {
    text: text.slice(0, start) + text.slice(end),
    cursor: start,
    name: token.name,
  };
}

/**
 * Renders prompt text for compact, non-interactive surfaces (session titles,
 * list previews): inline tokens are dropped so `@[shot.png]` noise does not
 * eat the title. Attachment-only prompts fall back to the file names.
 */
export function stripAttachmentTokensForTitle(text: string): string {
  const tokens = findAttachmentTokens(text);
  if (tokens.length === 0) return text;

  let out = "";
  let cursor = 0;
  for (const token of tokens) {
    out += text.slice(cursor, token.start);
    cursor = token.end;
  }
  out += text.slice(cursor);
  out = out.replace(/[ \t]{2,}/g, " ").trim();

  return out || tokens.map((token) => token.name).join(", ");
}

/**
 * Picks the attachment matching a token occurrence. Duplicated file names are
 * resolved positionally: the n-th token for a name maps to the n-th matching
 * attachment.
 */
export function matchTokenToAttachment<T>(
  items: T[],
  getName: (item: T) => string,
  tokenName: string,
  occurrence: number,
): T | undefined {
  const candidates = items.filter(
    (item) => sanitizeAttachmentTokenName(getName(item)) === tokenName,
  );
  return candidates[occurrence] ?? candidates[0];
}
