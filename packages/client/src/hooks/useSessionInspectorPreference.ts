import { useCallback, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

function loadExpandedPreference(): boolean {
  if (typeof window === "undefined") return true;

  try {
    const stored = window.localStorage.getItem(
      UI_KEYS.sessionInspectorExpanded,
    );
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function saveExpandedPreference(expanded: boolean): void {
  try {
    window.localStorage.setItem(
      UI_KEYS.sessionInspectorExpanded,
      String(expanded),
    );
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
}

/** Persist the desktop session inspector's expanded/collapsed state. */
export function useSessionInspectorPreference(): {
  isExpanded: boolean;
  setIsExpanded: (expanded: boolean) => void;
} {
  const [isExpanded, setIsExpandedState] = useState(loadExpandedPreference);

  const setIsExpanded = useCallback((expanded: boolean) => {
    setIsExpandedState(expanded);
    saveExpandedPreference(expanded);
  }, []);

  return { isExpanded, setIsExpanded };
}
