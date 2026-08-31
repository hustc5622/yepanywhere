import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";

interface ExpandableSessionTitleProps {
  /** The concise title rendered in the session header. */
  title: string;
  /** The provider's unabridged title/original prompt, when available. */
  fullTitle?: string | null;
}

function getPopoverStyle(trigger: HTMLElement | null): CSSProperties {
  if (!trigger) return {};

  const gutter = 8;
  const triggerRect = trigger.getBoundingClientRect();
  const width = Math.min(720, Math.max(0, window.innerWidth - gutter * 2));
  const maxLeft = Math.max(gutter, window.innerWidth - width - gutter);

  return {
    position: "fixed",
    top: triggerRect.bottom + 4,
    left: Math.min(Math.max(gutter, triggerRect.left), maxLeft),
    width,
  };
}

/**
 * Keeps the session header compact while making the complete current-session
 * title available in-place. Session navigation lives in the sidebar.
 */
export function ExpandableSessionTitle({
  title,
  fullTitle,
}: ExpandableSessionTitleProps) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const headingId = `${panelId}-heading`;
  const detailedTitle = fullTitle?.trim() || title;

  useEffect(() => {
    if (!isExpanded) return;

    const close = () => setIsExpanded(false);
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        close();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) {
        return;
      }
      close();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [isExpanded]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="session-title session-title-expand-trigger"
        onClick={() => setIsExpanded((current) => !current)}
        title={detailedTitle}
        aria-label={
          isExpanded
            ? t("sessionCollapseFullTitle", { title })
            : t("sessionExpandFullTitle", { title })
        }
        aria-expanded={isExpanded}
        aria-controls={panelId}
        aria-haspopup="dialog"
      >
        <span className="session-title-text">{title}</span>
        <svg
          className="session-title-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {isExpanded &&
        createPortal(
          <div
            ref={popoverRef}
            id={panelId}
            className="session-title-details-popover"
            style={getPopoverStyle(triggerRef.current)}
            role="dialog"
            aria-labelledby={headingId}
          >
            <div id={headingId} className="session-title-details-heading">
              {t("sessionFullTitle")}
            </div>
            <div className="session-title-details-text">{detailedTitle}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
