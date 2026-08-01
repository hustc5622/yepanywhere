import { useCallback, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

// ===== Configuration Constants (easy to tweak) =====
export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 560;
export const INSPECTOR_DEFAULT_WIDTH = 320;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadWidth(): number {
  if (typeof window === "undefined") return INSPECTOR_DEFAULT_WIDTH;
  const stored = localStorage.getItem(UI_KEYS.inspectorWidth);
  if (stored === null) return INSPECTOR_DEFAULT_WIDTH;
  const parsed = Number.parseInt(stored, 10);
  if (Number.isNaN(parsed)) return INSPECTOR_DEFAULT_WIDTH;
  return clamp(parsed, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH);
}

function saveWidth(width: number): void {
  localStorage.setItem(UI_KEYS.inspectorWidth, String(width));
}

export interface UseInspectorWidthResult {
  /** Current inspector width in pixels */
  width: number;
  /** Set inspector width (clamped to min/max) */
  setWidth: (width: number) => void;
  /** Whether inspector is currently being resized */
  isResizing: boolean;
  /** Set resizing state (disables transitions during drag) */
  setIsResizing: (resizing: boolean) => void;
}

export function useInspectorWidth(): UseInspectorWidthResult {
  const [width, setWidthState] = useState(loadWidth);
  const [isResizing, setIsResizing] = useState(false);

  const setWidth = useCallback((newWidth: number) => {
    const clamped = clamp(newWidth, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH);
    setWidthState(clamped);
    saveWidth(clamped);
  }, []);

  return {
    width,
    setWidth,
    isResizing,
    setIsResizing,
  };
}

/**
 * Get inspector width from localStorage without React state.
 * Useful for initial calculations before component mounts.
 */
export function getInspectorWidth(): number {
  return loadWidth();
}
