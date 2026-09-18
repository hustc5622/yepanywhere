import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { splitByAttachmentTokens } from "../lib/attachmentTokens";

/** Style properties that must match the textarea for the mirror to align. */
const MIRRORED_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "fontKerning",
  "fontFeatureSettings",
  "fontVariationSettings",
  "textRendering",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "tabSize",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
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
  /** Opens a preview for the clicked attachment token. */
  onTokenClick?: (name: string, occurrence: number) => void;
}

/**
 * Renders a mirror of the textarea content on top of it so inline attachment
 * tokens (`@[name.png]`) can be painted as clickable chips.
 *
 * The textarea keeps handling input, selection and the caret; its own glyphs
 * are hidden (`color: transparent`, caret color preserved) while this mirror
 * paints the identical text. The mirror reads the live DOM value on every
 * input/composition event so IME pre-edit text never disappears, even before
 * React re-renders with the new value.
 */
export function ComposerTokenHighlight({
  textareaRef,
  text,
  names,
  onTokenClick,
}: Props) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [liveText, setLiveText] = useState(text);

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

  // Follow the controlled value, and the DOM value while an IME is active.
  useLayoutEffect(() => {
    setLiveText(textareaRef.current?.value ?? text);
  }, [text, textareaRef]);

  // Re-align on mount and whenever the content changes (wrapping, scrolling).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-align whenever the mirrored content changes
  useLayoutEffect(() => {
    syncGeometry();
  }, [syncGeometry, liveText]);

  // Hide the textarea glyphs while the mirror paints them, but keep the caret
  // visible in the original text color.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const resolvedColor = window.getComputedStyle(textarea).color;
    textarea.style.caretColor = resolvedColor;
    textarea.style.color = "transparent";
    return () => {
      textarea.style.color = "";
      textarea.style.caretColor = "";
    };
  }, [textareaRef]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleScroll = () => {
      const mirror = mirrorRef.current;
      if (!mirror) return;
      mirror.scrollTop = textarea.scrollTop;
      mirror.scrollLeft = textarea.scrollLeft;
    };
    // `input` also fires during IME composition in every supported browser, so
    // the mirror stays in sync with the pre-edit string.
    const handleInput = () => setLiveText(textarea.value);

    textarea.addEventListener("scroll", handleScroll);
    textarea.addEventListener("input", handleInput);
    textarea.addEventListener("compositionupdate", handleInput);
    textarea.addEventListener("compositionend", handleInput);

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => syncGeometry());
    observer?.observe(textarea);
    window.addEventListener("resize", syncGeometry);

    return () => {
      textarea.removeEventListener("scroll", handleScroll);
      textarea.removeEventListener("input", handleInput);
      textarea.removeEventListener("compositionupdate", handleInput);
      textarea.removeEventListener("compositionend", handleInput);
      observer?.disconnect();
      window.removeEventListener("resize", syncGeometry);
    };
  }, [syncGeometry, textareaRef]);

  const segments = splitByAttachmentTokens(liveText, names);
  const occurrences = new Map<string, number>();

  return (
    <div ref={mirrorRef} className="composer-token-mirror" aria-hidden="true">
      {segments.map((segment, index) => {
        if (segment.type === "text") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
            <span key={`text-${index}`}>{segment.value}</span>
          );
        }
        const occurrence = occurrences.get(segment.name) ?? 0;
        occurrences.set(segment.name, occurrence + 1);
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
            key={`token-${index}`}
            className="composer-token-chip"
            title={segment.name}
            onMouseDown={(event) => {
              // Keep the caret where it is; the click opens a preview instead.
              if (onTokenClick) event.preventDefault();
            }}
            onClick={() => onTokenClick?.(segment.name, occurrence)}
            onKeyDown={(event) => {
              // The mirror is aria-hidden and not focusable; this only exists
              // so the click target still answers Enter/Space if focused.
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onTokenClick?.(segment.name, occurrence);
              }
            }}
          >
            {segment.raw}
          </span>
        );
      })}
      {/* Trailing newline needs an anchor so the mirror keeps the same height. */}
      {"\u200b"}
    </div>
  );
}
