import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { splitByAttachmentTokens } from "../lib/attachmentTokens";

/** Style properties that must match the textarea for the mirror to align. */
const MIRRORED_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderRadius",
  "boxSizing",
] as const;

interface Props {
  /** The textarea being mirrored. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Current textarea value. */
  text: string;
  /** Known attachment names; only these tokens get chip styling. */
  names: string[];
}

/**
 * Renders a transparent mirror of the textarea content behind it so inline
 * attachment tokens (`@[name.png]`) can be painted as chips while the real
 * textarea keeps handling input, selection and caret.
 */
export function ComposerTokenHighlight({ textareaRef, text, names }: Props) {
  const mirrorRef = useRef<HTMLDivElement>(null);

  const syncGeometry = useCallback(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;

    const computed = window.getComputedStyle(textarea);
    for (const prop of MIRRORED_STYLES) {
      mirror.style[prop] = computed[prop];
    }
    mirror.style.top = `${textarea.offsetTop}px`;
    mirror.style.left = `${textarea.offsetLeft}px`;
    mirror.style.width = `${textarea.offsetWidth}px`;
    mirror.style.height = `${textarea.offsetHeight}px`;
    // A visible scrollbar shrinks the textarea's content box; mirror that with
    // extra right padding so line wrapping stays identical.
    const scrollbarWidth =
      textarea.offsetWidth -
      textarea.clientWidth -
      Number.parseFloat(computed.borderLeftWidth || "0") -
      Number.parseFloat(computed.borderRightWidth || "0");
    if (scrollbarWidth > 0) {
      mirror.style.paddingRight = `${
        Number.parseFloat(computed.paddingRight || "0") + scrollbarWidth
      }px`;
    }
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
  }, [textareaRef]);

  // Re-align on mount and whenever the content changes (wrapping, scrolling).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-align whenever the mirrored content changes
  useLayoutEffect(() => {
    syncGeometry();
  }, [syncGeometry, text]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleScroll = () => {
      const mirror = mirrorRef.current;
      if (!mirror) return;
      mirror.scrollTop = textarea.scrollTop;
      mirror.scrollLeft = textarea.scrollLeft;
    };
    textarea.addEventListener("scroll", handleScroll);

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => syncGeometry());
    observer?.observe(textarea);
    window.addEventListener("resize", syncGeometry);

    return () => {
      textarea.removeEventListener("scroll", handleScroll);
      observer?.disconnect();
      window.removeEventListener("resize", syncGeometry);
    };
  }, [syncGeometry, textareaRef]);

  const segments = splitByAttachmentTokens(text, names);

  return (
    <div ref={mirrorRef} className="composer-token-mirror" aria-hidden="true">
      {segments.map((segment, index) =>
        segment.type === "token" ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
            key={`token-${index}`}
            className="composer-token-chip"
          >
            {segment.raw}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <span key={`text-${index}`}>{segment.value}</span>
        ),
      )}
      {/* Trailing newline needs an anchor so the mirror keeps the same height. */}
      {"\u200b"}
    </div>
  );
}
