import {
  MANAGED_ATTACHMENT_MARKER,
  sanitizeManagedAttachmentPrompt,
} from "../sdk/messageQueue.js";

interface CodexLocalMediaShape {
  kind: "image" | "audio";
  label: "Image" | "Audio";
}

const CODEX_LOCAL_MEDIA_SHAPES: readonly CodexLocalMediaShape[] = [
  { kind: "image", label: "Image" },
  { kind: "audio", label: "Audio" },
];

const CODEX_LOCAL_MEDIA_ERROR_PREFIXES = [
  "Codex could not read the local image at `",
  "Codex could not read the local audio at `",
  "Image located at `",
  "Codex cannot attach image at `",
  "Codex cannot attach audio at `",
] as const;

function codexLocalMediaPlaceholder(kind: "image" | "audio"): string {
  return `[managed ${kind} attachment]`;
}

function isCodexLocalMediaOpenTag(
  text: string,
  shape: CodexLocalMediaShape,
): boolean {
  const prefix = `<${shape.kind} name=[${shape.label} #`;
  if (!text.startsWith(prefix) || !text.endsWith('">')) return false;

  const labelEnd = text.indexOf('] path="', prefix.length);
  if (labelEnd < 0) return false;
  const labelNumber = text.slice(prefix.length, labelEnd);
  return /^\d+$/u.test(labelNumber);
}

/**
 * Project one Codex response-item InputText block for public display.
 *
 * These branches mirror pinned upstream 0.147 shapes. Successful local media
 * uses a dedicated opening label block adjacent to input_image/input_audio;
 * read failures use one of the fixed error prefixes below. We replace the
 * whole provider-generated block, including its raw error, rather than trying
 * to recognize arbitrary absolute paths in user prose.
 */
export function sanitizeCodexUserContentBlockText(text: string): string {
  for (const shape of CODEX_LOCAL_MEDIA_SHAPES) {
    if (isCodexLocalMediaOpenTag(text, shape)) {
      return `<${shape.kind}>`;
    }
  }

  for (const prefix of CODEX_LOCAL_MEDIA_ERROR_PREFIXES) {
    if (!text.startsWith(prefix)) continue;
    const kind = prefix.toLowerCase().includes("audio") ? "audio" : "image";
    return `Codex could not read the ${codexLocalMediaPlaceholder(kind)}.`;
  }

  return text;
}

function sanitizeCodexPairedLocalMediaMarkup(text: string): string {
  let sanitized = text;

  for (const shape of CODEX_LOCAL_MEDIA_SHAPES) {
    const prefix = `<${shape.kind} name=[${shape.label} #`;
    const closeTag = `</${shape.kind}>`;
    let searchFrom = 0;

    while (searchFrom < sanitized.length) {
      const start = sanitized.indexOf(prefix, searchFrom);
      if (start < 0) break;

      const labelEnd = sanitized.indexOf('] path="', start + prefix.length);
      const labelNumber =
        labelEnd < 0 ? "" : sanitized.slice(start + prefix.length, labelEnd);
      if (!/^\d+$/u.test(labelNumber)) {
        searchFrom = start + prefix.length;
        continue;
      }

      const close = sanitized.indexOf(closeTag, labelEnd + 8);
      if (close < 0) {
        // A provider-generated opening tag without its paired media block is
        // malformed. Fail closed at this fixed marker instead of returning a
        // possibly adversarial path suffix.
        sanitized = `${sanitized.slice(0, start)}${codexLocalMediaPlaceholder(
          shape.kind,
        )}`;
        break;
      }

      const replacement = `<${shape.kind}></${shape.kind}>`;
      sanitized = `${sanitized.slice(0, start)}${replacement}${sanitized.slice(
        close + closeTag.length,
      )}`;
      searchFrom = start + replacement.length;
    }
  }

  return sanitized;
}

function sanitizeCodexLocalMediaErrorSuffix(text: string): string {
  let firstMatch: { index: number; kind: "image" | "audio" } | undefined;

  for (const prefix of CODEX_LOCAL_MEDIA_ERROR_PREFIXES) {
    const index = text.indexOf(prefix);
    if (index < 0 || (firstMatch && firstMatch.index <= index)) continue;
    firstMatch = {
      index,
      kind: prefix.toLowerCase().includes("audio") ? "audio" : "image",
    };
  }

  if (!firstMatch) return text;
  return `${text.slice(0, firstMatch.index)}Codex could not read the ${codexLocalMediaPlaceholder(
    firstMatch.kind,
  )}.`;
}

/** Public canonicalization shared by refresh, summaries, branch metadata and edit matching. */
export function sanitizeCodexPublicUserPrompt(text: string): string {
  return sanitizeCodexLocalMediaErrorSuffix(
    sanitizeCodexPairedLocalMediaMarkup(sanitizeManagedAttachmentPrompt(text)),
  );
}

/** Provider-neutral public prompt projection for persisted user messages. */
export function sanitizePublicUserPrompt(
  text: string,
  options: { codex?: boolean } = {},
): string {
  return options.codex
    ? sanitizeCodexPublicUserPrompt(text)
    : sanitizeManagedAttachmentPrompt(text);
}

export { MANAGED_ATTACHMENT_MARKER };
