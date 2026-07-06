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
import { formatTokenCount } from "../lib/tokens";
import type { ContextCompactEvent } from "../types";

interface CompactCountBadgeProps {
  count: number | undefined;
  events: ContextCompactEvent[] | undefined;
  className: string;
}

interface CompactDetailRow {
  label: string;
  value: string;
  tone?: "muted";
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
      : Math.min(280, Math.max(0, viewportWidth - gutter * 2));
  const left = Math.min(
    Math.max(gutter, rect.left),
    Math.max(gutter, viewportWidth - width - gutter),
  );
  const estimatedHeight = 220;
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

function formatCompactCount(count: number): string {
  return `${count.toLocaleString()} compact${count === 1 ? "" : "s"}`;
}

function formatCompactTime(timestamp: string | undefined): string | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return undefined;

  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTokenRange(event: ContextCompactEvent): string {
  if (event.beforeTokens !== undefined && event.afterTokens !== undefined) {
    return `${formatTokenCount(event.beforeTokens)} -> ${formatTokenCount(
      event.afterTokens,
    )}`;
  }
  if (event.beforeTokens !== undefined) {
    return `Before ${formatTokenCount(event.beforeTokens)}`;
  }
  if (event.afterTokens !== undefined) {
    return `After ${formatTokenCount(event.afterTokens)}`;
  }
  return "Details unavailable";
}

function getCompactDetailRows(
  count: number,
  events: ContextCompactEvent[] | undefined,
): CompactDetailRow[] {
  const rows: CompactDetailRow[] = [
    { label: "Total", value: formatCompactCount(count) },
  ];

  if (!events || events.length === 0) {
    rows.push({ label: "Details", value: "Unavailable", tone: "muted" });
    return rows;
  }

  const firstVisibleIndex = Math.max(0, events.length - 4);
  if (firstVisibleIndex > 0) {
    rows.push({
      label: "Older",
      value: `${firstVisibleIndex.toLocaleString()} more`,
      tone: "muted",
    });
  }

  events.slice(firstVisibleIndex).forEach((event, visibleIndex) => {
    const eventIndex = firstVisibleIndex + visibleIndex + 1;
    const trigger = event.trigger ? ` ${event.trigger}` : "";
    rows.push({
      label: `#${eventIndex}${trigger}`,
      value: formatTokenRange(event),
    });

    if (event.reclaimedTokens !== undefined) {
      rows.push({
        label: "Saved",
        value: formatTokenCount(event.reclaimedTokens),
      });
    }

    const time = formatCompactTime(event.timestamp);
    if (time) {
      rows.push({ label: "Time", value: time, tone: "muted" });
    }
  });

  return rows;
}

function formatCompactTitle(
  count: number,
  events: ContextCompactEvent[] | undefined,
): string {
  const lines = [formatCompactCount(count)];
  if (!events || events.length === 0) {
    lines.push("Details unavailable");
    return lines.join("\n");
  }

  for (const [index, event] of events.entries()) {
    const trigger = event.trigger ? ` ${event.trigger}` : "";
    const saved =
      event.reclaimedTokens !== undefined
        ? `, saved ${event.reclaimedTokens.toLocaleString()}`
        : "";
    const time = formatCompactTime(event.timestamp);
    lines.push(
      `#${index + 1}${trigger}: ${formatTokenRange(event)}${saved}${
        time ? ` (${time})` : ""
      }`,
    );
  }

  return lines.join("\n");
}

export function CompactCountBadge({
  count,
  events,
  className,
}: CompactCountBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();

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

  if (!count || count <= 0) return null;

  const rows = getCompactDetailRows(count, events);
  const label = formatCompactCount(count);
  const title = formatCompactTitle(count, events);
  const placement =
    isOpen && rootRef.current
      ? getPopoverPlacement(rootRef.current)
      : undefined;

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
            {rows.map((row, index) => (
              <span
                key={`${row.label}:${index}`}
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
      className={`${className} compact-count-badge${isOpen ? " is-open" : ""}`}
      title={title}
      role="button"
      tabIndex={0}
      aria-label="Show compact history"
      aria-expanded={isOpen}
      aria-controls={isOpen ? popoverId : undefined}
      onClick={handleToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          handleToggle(event);
        }
      }}
    >
      {label}
      {popover}
    </span>
  );
}
