import type { ProjectGitStatusSummary } from "@yep-anywhere/shared";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";

interface ProjectGitStatusButtonProps {
  status?: ProjectGitStatusSummary | null;
  projectName: string;
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_THRESHOLD = 10;
const POPOVER_WIDTH = 280;
const POPOVER_ESTIMATED_HEIGHT = 260;
const POPOVER_GUTTER = 12;
const POPOVER_TRIGGER_GAP = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getPopoverPlacement(element: HTMLElement): CSSProperties {
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(
    POPOVER_WIDTH,
    Math.max(0, viewportWidth - POPOVER_GUTTER * 2),
  );
  const fitsToRight =
    rect.right + POPOVER_TRIGGER_GAP + width <= viewportWidth - POPOVER_GUTTER;
  const left = fitsToRight
    ? rect.right + POPOVER_TRIGGER_GAP
    : clamp(
        rect.right - width,
        POPOVER_GUTTER,
        Math.max(POPOVER_GUTTER, viewportWidth - width - POPOVER_GUTTER),
      );
  const maxTop = Math.max(
    POPOVER_GUTTER,
    viewportHeight - POPOVER_ESTIMATED_HEIGHT - POPOVER_GUTTER,
  );

  return {
    left,
    top: clamp(rect.top, POPOVER_GUTTER, maxTop),
    width,
  };
}

function GitBranchIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

export function ProjectGitStatusButton({
  status,
  projectName,
}: ProjectGitStatusButtonProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const popoverId = useId();

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    pointerStartRef.current = null;
  }, []);

  const closePopover = useCallback(() => {
    setIsPinned(false);
    setIsOpen(false);
  }, []);

  const updatePlacement = useCallback(() => {
    if (buttonRef.current) {
      setPlacement(getPopoverPlacement(buttonRef.current));
    }
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPlacement(null);
      return;
    }

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [isOpen, updatePlacement]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && buttonRef.current?.contains(target)) return;
      if (target && popoverRef.current?.contains(target)) return;
      closePopover();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePopover();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closePopover, isOpen]);

  useEffect(() => clearLongPress, [clearLongPress]);

  if (!status?.isGitRepo) return null;

  const branchLabel =
    status.branch ?? (status.head ? `:${status.head}` : "HEAD");
  const buttonLabel = t("projectGitDetails", { project: projectName });
  const changeRows = [
    {
      label: t("gitStatusStaged"),
      value: status.stagedCount,
      tone: "staged",
    },
    {
      label: t("gitStatusConflicts"),
      value: status.conflictedCount,
      tone: "conflicted",
    },
    {
      label: t("gitStatusChanges"),
      value: status.unstagedCount,
      tone: "changed",
    },
    {
      label: t("gitStatusDeleted"),
      value: status.deletedCount,
      tone: "deleted",
    },
    {
      label: t("gitStatusUntracked"),
      value: status.untrackedCount,
      tone: "untracked",
    },
    {
      label: t("gitStatusStashes"),
      value: status.stashCount,
      tone: "stashed",
    },
  ].filter((row) => row.value > 0);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== "touch") return;
    clearLongPress();
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = true;
      setIsPinned(true);
      setIsOpen(true);
      longPressTimerRef.current = null;
      pointerStartRef.current = null;
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = pointerStartRef.current;
    if (!start || longPressTimerRef.current === null) return;
    const distance = Math.hypot(
      event.clientX - start.x,
      event.clientY - start.y,
    );
    if (distance > LONG_PRESS_MOVE_THRESHOLD) clearLongPress();
  };

  const handlePointerEnd = () => {
    clearLongPress();
    // A long-press is normally followed by a synthetic click. Keep the guard
    // through that click, then clear it so a browser that suppresses the click
    // does not accidentally swallow the user's next tap.
    if (suppressNextClickRef.current) {
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
    }
  };

  const popover =
    isOpen && placement
      ? createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            className="project-git-popover"
            style={placement}
            role="tooltip"
          >
            <div className="project-git-popover__header">
              <span>{t("projectGitCurrentStatus")}</span>
              <span
                className={`project-git-popover__state ${
                  status.isClean ? "is-clean" : "is-dirty"
                }`}
              >
                {status.isClean ? t("gitStatusClean") : t("gitStatusDirty")}
              </span>
            </div>
            <dl className="project-git-popover__details">
              <div>
                <dt>{t("gitStatusBranch")}</dt>
                <dd title={branchLabel}>{branchLabel}</dd>
              </div>
              {status.upstream && (
                <div>
                  <dt>{t("gitStatusUpstream")}</dt>
                  <dd title={status.upstream}>{status.upstream}</dd>
                </div>
              )}
              {(status.ahead > 0 || status.behind > 0) && (
                <div>
                  <dt>{t("gitStatusSync")}</dt>
                  <dd>
                    {status.ahead > 0
                      ? `${t("gitStatusAhead")} ${status.ahead}`
                      : ""}
                    {status.ahead > 0 && status.behind > 0 ? " · " : ""}
                    {status.behind > 0
                      ? `${t("gitStatusBehind")} ${status.behind}`
                      : ""}
                  </dd>
                </div>
              )}
            </dl>
            {changeRows.length > 0 && (
              <div className="project-git-popover__changes">
                {changeRows.map((row) => (
                  <span
                    key={row.tone}
                    className={`project-git-popover__change is-${row.tone}`}
                  >
                    <span>{row.label}</span>
                    <strong>{row.value}</strong>
                  </span>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`sidebar-project-git-button${
          status.isClean ? " is-clean" : " is-dirty"
        }${isOpen ? " is-open" : ""}`}
        aria-label={buttonLabel}
        aria-expanded={isOpen}
        aria-controls={isOpen ? popoverId : undefined}
        aria-describedby={isOpen ? popoverId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false;
            return;
          }
          const nextPinned = !isPinned;
          setIsPinned(nextPinned);
          setIsOpen(nextPinned);
        }}
        onFocus={() => setIsOpen(true)}
        onBlur={() => {
          if (!isPinned) setIsOpen(false);
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") setIsOpen(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse" && !isPinned) setIsOpen(false);
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onContextMenu={(event) => event.preventDefault()}
      >
        <GitBranchIcon />
        {!status.isClean && (
          <span
            className="sidebar-project-git-button__dot"
            aria-hidden="true"
          />
        )}
      </button>
      {popover}
    </>
  );
}
