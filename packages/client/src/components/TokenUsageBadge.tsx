import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  formatTokenCount,
  formatTokenUsageBreakdown,
  getEffectiveTokenTotal,
  getTokenUsageBreakdownRows,
} from "../lib/tokens";
import type { ContextCumulativeUsage } from "../types";

interface TokenUsageBadgeProps {
  usage: ContextCumulativeUsage | undefined;
  className: string;
}

function getPopoverPlacement(element: HTMLElement): {
  className: string;
  style: CSSProperties;
} {
  const rect = element.getBoundingClientRect();
  const gutter = 12;
  const viewportWidth = window.innerWidth;
  const width =
    viewportWidth <= 640
      ? Math.max(0, viewportWidth - gutter * 2)
      : Math.min(260, Math.max(0, viewportWidth - gutter * 2));
  const left = Math.min(
    Math.max(gutter, rect.left),
    Math.max(gutter, viewportWidth - width - gutter),
  );
  const estimatedHeight = 180;
  const placeAbove =
    rect.bottom + estimatedHeight > window.innerHeight &&
    rect.top > estimatedHeight;

  return {
    className: placeAbove ? " is-above" : "",
    style: {
      left,
      top: placeAbove ? rect.top - gutter : rect.bottom + gutter,
      width,
    },
  };
}

export function TokenUsageBadge({ usage, className }: TokenUsageBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();
  const effectiveTotal = getEffectiveTokenTotal(usage);
  const rows = getTokenUsageBreakdownRows(usage);
  const title = formatTokenUsageBreakdown(usage);
  const placement =
    isOpen && rootRef.current
      ? getPopoverPlacement(rootRef.current)
      : undefined;

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      if (target && popoverRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  if (effectiveTotal === null || rows.length === 0) return null;

  const handleToggle = (
    event:
      | ReactMouseEvent<HTMLSpanElement>
      | ReactKeyboardEvent<HTMLSpanElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setIsOpen((open) => !open);
  };

  const popover =
    isOpen && placement
      ? createPortal(
          <span
            ref={popoverRef}
            id={popoverId}
            className={`token-usage-popover${placement.className}`}
            style={placement.style}
            role="tooltip"
          >
            {rows.map((row) => (
              <span
                key={row.label}
                className={`token-usage-popover__row${
                  row.tone === "muted" ? " is-muted" : ""
                }`}
              >
                <span className="token-usage-popover__label">{row.label}</span>
                <span className="token-usage-popover__value">{row.value}</span>
              </span>
            ))}
          </span>,
          document.body,
        )
      : null;

  return (
    <span
      ref={rootRef}
      className={`${className} token-usage-badge${isOpen ? " is-open" : ""}`}
      title={title}
      role="button"
      tabIndex={0}
      aria-label="Show token usage breakdown"
      aria-expanded={isOpen}
      aria-controls={isOpen ? popoverId : undefined}
      onClick={handleToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          handleToggle(event);
        }
      }}
    >
      {formatTokenCount(effectiveTotal)}
      {popover}
    </span>
  );
}
