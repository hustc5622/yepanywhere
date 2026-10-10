import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEBOUNCE_MS = 500;

export interface DraftControls {
  /** Clear input state only, keeping localStorage for failure recovery */
  clearInput: () => void;
  /** Clear both input state and localStorage (call on confirmed success) */
  clearDraft: () => void;
  /** Restore from localStorage (call on failure) */
  restoreFromStorage: () => void;
  /** Programmatically set the input text (e.g. prefill when editing a past message) */
  setText: (value: string) => void;
  /** Read the live editor value, including text not yet flushed to storage. */
  getText?: () => string;
}

/** Save a value to localStorage immediately */
function saveToStorage(key: string, value: string): void {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage might be full or unavailable
  }
}

/**
 * Hook for persisting draft text to localStorage with debouncing.
 * Supports failure recovery by keeping localStorage until explicitly cleared.
 *
 * @param key - localStorage key for this draft (e.g., "draft-message-{sessionId}")
 * @returns [value, setValue, controls] - state-like tuple with control functions
 */
export function useDraftPersistence(
  key: string,
): [string, (value: string) => void, DraftControls] {
  const [value, setValueInternal] = useState(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(key);
  const valueRef = useRef(value);
  const revisionRef = useRef(0);
  const submittedRef = useRef<{
    key: string;
    value: string;
    revision: number;
  } | null>(null);
  // Track pending value so we can flush on unmount/beforeunload
  const pendingValueRef = useRef<{ key: string; value: string } | null>(null);

  // Flush pending value to localStorage
  const flushPending = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (pendingValueRef.current !== null) {
      saveToStorage(pendingValueRef.current.key, pendingValueRef.current.value);
      pendingValueRef.current = null;
    }
  }, []);

  // Finish the previous draft's pending write before selecting another one.
  // The pending write also carries its own key so it can never leak between
  // sessions when React reuses the mounted composer.
  useEffect(() => {
    if (keyRef.current === key) return;
    flushPending();
    keyRef.current = key;
    revisionRef.current += 1;
    try {
      valueRef.current = localStorage.getItem(key) ?? "";
    } catch {
      valueRef.current = "";
    }
    setValueInternal(valueRef.current);
  }, [key, flushPending]);

  // Handle beforeunload to save draft before page unload (including HMR)
  useEffect(() => {
    const handleBeforeUnload = () => {
      flushPending();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [flushPending]);

  // Debounced save to localStorage
  const setValue = useCallback((newValue: string) => {
    valueRef.current = newValue;
    revisionRef.current += 1;
    setValueInternal(newValue);
    const pending = { key: keyRef.current, value: newValue };
    pendingValueRef.current = pending;

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      saveToStorage(pending.key, pending.value);
      pendingValueRef.current = null;
      timeoutRef.current = null;
    }, DEBOUNCE_MS);
  }, []);

  // Clear input state only (for optimistic UI on submit)
  const clearInput = useCallback(() => {
    flushPending();
    submittedRef.current = {
      key: keyRef.current,
      value: valueRef.current,
      revision: revisionRef.current,
    };
    valueRef.current = "";
    setValueInternal("");
  }, [flushPending]);

  // Clear both state and localStorage (for confirmed successful send)
  const clearDraft = useCallback(() => {
    const submitted = submittedRef.current;
    submittedRef.current = null;
    if (
      submitted &&
      (submitted.key !== keyRef.current ||
        submitted.revision !== revisionRef.current)
    ) {
      // The user started another draft while the request was in flight.
      // Only the submitted revision was consumed by the successful send.
      flushPending();
      return;
    }
    valueRef.current = "";
    setValueInternal("");
    pendingValueRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    try {
      localStorage.removeItem(keyRef.current);
    } catch {
      // Ignore errors
    }
  }, [flushPending]);

  // Restore from localStorage (for failure recovery)
  const restoreFromStorage = useCallback(() => {
    const submitted = submittedRef.current;
    submittedRef.current = null;
    if (submitted) {
      if (
        submitted.key !== keyRef.current ||
        submitted.revision !== revisionRef.current
      ) {
        return;
      }
      // Keep the submission snapshot even if localStorage is unavailable.
      valueRef.current = submitted.value;
      setValueInternal(submitted.value);
      return;
    }
    flushPending();
    try {
      const stored = localStorage.getItem(keyRef.current);
      valueRef.current = stored ?? "";
      setValueInternal(valueRef.current);
    } catch {
      // Ignore errors
    }
  }, [flushPending]);

  // Flush pending and cleanup on unmount
  useEffect(() => {
    return () => {
      // Flush any pending value before unmount (handles HMR and navigation)
      flushPending();
    };
  }, [flushPending]);

  const controls = useMemo(
    () => ({
      clearInput,
      clearDraft,
      restoreFromStorage,
      setText: setValue,
      getText: () => valueRef.current,
    }),
    [clearInput, clearDraft, restoreFromStorage, setValue],
  );

  return [value, setValue, controls];
}
