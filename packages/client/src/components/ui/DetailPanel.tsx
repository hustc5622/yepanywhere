import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { DESKTOP_BREAKPOINT } from "../../hooks/useSidebarWidth";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import { useI18n } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";

const DESKTOP_DETAIL_PANEL_QUERY = `(min-width: ${DESKTOP_BREAKPOINT}px)`;
const DETAIL_PANEL_OPEN_EVENT = "yep:detail-panel-open";
const DEFAULT_DETAIL_PANEL_RATIO = 0.4;
const MIN_DETAIL_PANEL_WIDTH = 320;
const ABSOLUTE_MIN_DETAIL_PANEL_WIDTH = 240;
const MIN_SESSION_WIDTH = 360;
const MAX_DETAIL_PANEL_RATIO = 0.72;
const RESIZE_KEYBOARD_STEP = 24;

interface DetailPanelProps {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /**
   * FileViewer owns its richer header and action bar, so it can ask the
   * surrounding panel to provide layout only.
   */
  hideHeader?: boolean;
  /** Remove the default content padding for a child that owns its chrome. */
  flush?: boolean;
  /** Accessible name used when the visual header is hidden. */
  ariaLabel?: string;
}

interface DetailPanelOpenEventDetail {
  panelId: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadDetailPanelRatio(): number {
  if (typeof window === "undefined") return DEFAULT_DETAIL_PANEL_RATIO;
  const stored = localStorage.getItem(UI_KEYS.detailPanelWidthRatio);
  if (stored === null) return DEFAULT_DETAIL_PANEL_RATIO;
  const parsed = Number.parseFloat(stored);
  return Number.isFinite(parsed)
    ? clamp(parsed, 0.1, MAX_DETAIL_PANEL_RATIO)
    : DEFAULT_DETAIL_PANEL_RATIO;
}

function saveDetailPanelRatio(ratio: number): void {
  localStorage.setItem(UI_KEYS.detailPanelWidthRatio, ratio.toFixed(4));
}

function getDetailPanelWidthBounds(
  layoutRoot: HTMLElement | null,
  viewportWidth: number,
): { min: number; max: number } {
  const sidebarWidth =
    layoutRoot
      ?.querySelector<HTMLElement>(".sidebar-desktop")
      ?.getBoundingClientRect().width ?? 0;
  const availableWidth = Math.max(
    ABSOLUTE_MIN_DETAIL_PANEL_WIDTH,
    viewportWidth - sidebarWidth - MIN_SESSION_WIDTH,
  );
  const min = Math.min(MIN_DETAIL_PANEL_WIDTH, availableWidth);
  const max = Math.max(
    min,
    Math.min(viewportWidth * MAX_DETAIL_PANEL_RATIO, availableWidth),
  );
  return { min, max };
}

function getDetailPanelWidth(
  ratio: number,
  layoutRoot: HTMLElement | null,
  viewportWidth: number,
): number {
  const { min, max } = getDetailPanelWidthBounds(layoutRoot, viewportWidth);
  return Math.round(clamp(viewportWidth * ratio, min, max));
}

/**
 * File/report detail surface.
 *
 * Inside the desktop navigation layout it is portalled directly into the
 * session flex row, making it a real right-hand sibling of the conversation.
 * On smaller viewports (and outside that layout) it retains the familiar
 * modal/full-screen behaviour.
 */
export function DetailPanel({
  title,
  children,
  onClose,
  hideHeader = false,
  flush = false,
  ariaLabel,
}: DetailPanelProps) {
  const { t } = useI18n();
  const panelId = useId();
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const viewportWidth = useViewportWidth();
  const [widthRatio, setWidthRatio] = useState(loadDetailPanelRatio);
  const widthRatioRef = useRef(widthRatio);
  const [isResizing, setIsResizing] = useState(false);
  const resizePointerIdRef = useRef<number | null>(null);

  const desktopViewport = useMediaQuery(DESKTOP_DETAIL_PANEL_QUERY);
  const layoutRoot =
    desktopViewport && typeof document !== "undefined"
      ? document.querySelector<HTMLElement>(".session-page")
      : null;
  const isDocked = layoutRoot !== null;
  const portalTarget = layoutRoot ?? document.body;
  const panelWidth = getDetailPanelWidth(widthRatio, layoutRoot, viewportWidth);

  const updatePanelWidth = useCallback(
    (requestedWidth: number, persist: boolean) => {
      const { min, max } = getDetailPanelWidthBounds(layoutRoot, viewportWidth);
      const nextWidth = clamp(requestedWidth, min, max);
      const nextRatio = nextWidth / Math.max(viewportWidth, 1);
      widthRatioRef.current = nextRatio;
      setWidthRatio(nextRatio);
      if (persist) saveDetailPanelRatio(nextRatio);
    },
    [layoutRoot, viewportWidth],
  );

  const handleResizePointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!isDocked || (event.pointerType === "mouse" && event.button !== 0)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    resizePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
  };

  const handleResizePointerMove = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (resizePointerIdRef.current !== event.pointerId) return;
    if (!Number.isFinite(event.clientX)) return;
    event.preventDefault();
    const measuredRight = layoutRoot?.getBoundingClientRect().right ?? 0;
    const layoutRight = measuredRight > 0 ? measuredRight : viewportWidth;
    updatePanelWidth(layoutRight - event.clientX, false);
  };

  const finishResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (resizePointerIdRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizePointerIdRef.current = null;
    setIsResizing(false);
    saveDetailPanelRatio(widthRatioRef.current);
  };

  const resetPanelWidth = () => {
    widthRatioRef.current = DEFAULT_DETAIL_PANEL_RATIO;
    setWidthRatio(DEFAULT_DETAIL_PANEL_RATIO);
    saveDetailPanelRatio(DEFAULT_DETAIL_PANEL_RATIO);
  };

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      resetPanelWidth();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey
      ? RESIZE_KEYBOARD_STEP * 3
      : RESIZE_KEYBOARD_STEP;
    updatePanelWidth(
      panelWidth + (event.key === "ArrowLeft" ? step : -step),
      true,
    );
  };

  // Escape closes the detail surface. A fullscreen FileViewer consumes the
  // first Escape itself so users return to the side panel before closing it.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".file-viewer-fullscreen")) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // The conversation remains interactive beside a docked panel. Opening a
  // second file therefore replaces the previous file instead of accumulating
  // multiple flex siblings and squeezing the session to zero width.
  useEffect(() => {
    if (!isDocked) return;

    const handleOtherPanelOpen = (event: Event) => {
      const detail = (event as CustomEvent<DetailPanelOpenEventDetail>).detail;
      if (detail?.panelId !== panelId) {
        onCloseRef.current();
      }
    };

    window.addEventListener(DETAIL_PANEL_OPEN_EVENT, handleOtherPanelOpen);
    window.dispatchEvent(
      new CustomEvent<DetailPanelOpenEventDetail>(DETAIL_PANEL_OPEN_EVENT, {
        detail: { panelId },
      }),
    );

    return () => {
      window.removeEventListener(DETAIL_PANEL_OPEN_EVENT, handleOtherPanelOpen);
    };
  }, [isDocked, panelId]);

  // Only the fallback modal locks document scrolling. The desktop app already
  // owns its scroll containers, and the session must remain usable when the
  // panel is docked.
  useEffect(() => {
    if (isDocked) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isDocked]);

  // Preserve mobile browser/Android back semantics from the shared Modal.
  useEffect(() => {
    if (isDocked) return;

    window.history.pushState({ yepDetailPanelOpen: true }, "");
    let markerOnStack = true;

    const handlePopState = () => {
      markerOnStack = false;
      onCloseRef.current();
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (markerOnStack) {
        window.history.back();
      }
    };
  }, [isDocked]);

  useEffect(() => {
    if (!hideHeader) {
      closeButtonRef.current?.focus({ preventScroll: true });
    }
  }, [hideHeader]);

  useEffect(() => {
    if (!isResizing) return;
    document.body.classList.add("detail-panel-resizing");
    return () => {
      document.body.classList.remove("detail-panel-resizing");
    };
  }, [isResizing]);

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isDocked && event.target === event.currentTarget) {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    }
  };

  const panel = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled globally; click dismisses only the fallback backdrop
    <div
      className={`modal-overlay detail-panel-host${
        isDocked ? " detail-panel-host--docked" : " detail-panel-host--overlay"
      }${isResizing ? " detail-panel-host--resizing" : ""}`}
      style={
        isDocked
          ? ({
              "--detail-panel-width": `${panelWidth}px`,
            } as CSSProperties)
          : undefined
      }
      onClick={handleBackdropClick}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {isDocked && (
        <div
          className={`detail-panel-resize-handle${isResizing ? " active" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("actionResizeDetailPanel")}
          aria-valuemin={
            getDetailPanelWidthBounds(layoutRoot, viewportWidth).min
          }
          aria-valuemax={
            getDetailPanelWidthBounds(layoutRoot, viewportWidth).max
          }
          aria-valuenow={panelWidth}
          tabIndex={0}
          title={t("actionResizeDetailPanelHint")}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onDoubleClick={resetPanelWidth}
          onKeyDown={handleResizeKeyDown}
        />
      )}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only isolates the panel from its backdrop */}
      <div
        className={`modal detail-panel${
          hideHeader ? " detail-panel--headerless" : ""
        }`}
        role="dialog"
        aria-modal={isDocked ? undefined : true}
        aria-labelledby={hideHeader ? undefined : titleId}
        aria-label={hideHeader ? ariaLabel : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        {!hideHeader && (
          <div className="modal-header detail-panel-header">
            <span id={titleId} className="modal-title detail-panel-title">
              {title}
            </span>
            <button
              ref={closeButtonRef}
              type="button"
              className="modal-close"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current();
              }}
              aria-label={t("modalClose")}
            >
              ×
            </button>
          </div>
        )}
        <div
          className={`modal-content detail-panel-content${
            flush ? " detail-panel-content--flush" : ""
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );

  return createPortal(panel, portalTarget);
}
