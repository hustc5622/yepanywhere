import { useCallback, useEffect, useState } from "react";

const DRAFT_KEY_PREFIX = "draft-message-";
const NEW_SESSION_DRAFT_KEY_PREFIX = "draft-new-session-";

/**
 * Scan all localStorage keys to find sessions with non-empty drafts.
 * Iterates keys by prefix rather than checking per-session — fast when
 * total localStorage key count is small (typically ~10-20 keys).
 *
 * This is the only function that touches storage directly. To migrate
 * to IndexedDB or another backend, replace this function.
 */
function scanDrafts(): Set<string> {
  const result = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(DRAFT_KEY_PREFIX)) {
        const value = localStorage.getItem(key);
        if (value?.trim()) {
          result.add(key.slice(DRAFT_KEY_PREFIX.length));
        }
      }
    }
  } catch {
    // localStorage might be unavailable
  }
  return result;
}

/**
 * Returns `prev` if both sets contain the same elements, otherwise `next`.
 * Used to avoid React re-renders when the draft set hasn't actually changed.
 */
export function setsEqual<T>(prev: Set<T>, next: Set<T>): Set<T> {
  if (prev.size !== next.size) return next;
  for (const id of next) {
    if (!prev.has(id)) return next;
  }
  return prev;
}

/**
 * Hook to track which sessions have draft messages in localStorage.
 * Returns a Set of session IDs with non-empty drafts.
 *
 * Listens for cross-tab storage events and polls every 1s for same-tab changes.
 */
export function useDrafts(): Set<string> {
  const [drafts, setDrafts] = useState(scanDrafts);

  const scan = useCallback(() => {
    setDrafts((prev) => setsEqual(prev, scanDrafts()));
  }, []);

  // Listen for storage events (changes from other tabs)
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key?.startsWith(DRAFT_KEY_PREFIX)) {
        scan();
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [scan]);

  // Poll for same-tab changes (storage event doesn't fire for same-tab)
  useEffect(() => {
    const interval = setInterval(scan, 1000);
    return () => clearInterval(interval);
  }, [scan]);

  return drafts;
}

/**
 * Hook to track whether the new session form has a draft for a specific project.
 * Listens for storage events and polls for same-tab changes.
 */
export function useNewSessionDraft(projectId: string | undefined): boolean {
  const [hasDraft, setHasDraft] = useState(() =>
    checkNewSessionDraft(projectId),
  );

  const check = useCallback(() => {
    setHasDraft(checkNewSessionDraft(projectId));
  }, [projectId]);

  // Re-check when projectId changes
  useEffect(() => {
    check();
  }, [check]);

  // Listen for storage events (changes from other tabs)
  useEffect(() => {
    if (!projectId) return;

    const handleStorage = (e: StorageEvent) => {
      if (e.key === `${NEW_SESSION_DRAFT_KEY_PREFIX}${projectId}`) {
        check();
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [check, projectId]);

  // Poll for same-tab changes (storage event doesn't fire for same-tab)
  useEffect(() => {
    const interval = setInterval(check, 1000);
    return () => clearInterval(interval);
  }, [check]);

  return hasDraft;
}

function checkNewSessionDraft(projectId: string | undefined): boolean {
  if (!projectId) return false;
  try {
    const key = `${NEW_SESSION_DRAFT_KEY_PREFIX}${projectId}`;
    const value = localStorage.getItem(key);
    return !!value?.trim();
  } catch {
    return false;
  }
}

// Tool prompt draft storage keys
const TOOL_PROMPT_DRAFT_PREFIX = "draft-tool-prompt-";

/**
 * Hook to persist draft text for tool approval feedback.
 * ("Tell {agent} what to do instead" in ToolApprovalPanel)
 * Keyed by sessionId, not by specific tool call.
 *
 * @param sessionId - The session ID
 * @returns [value, setValue, clearValue] tuple
 */
export function useToolApprovalFeedbackDraft(
  sessionId: string,
): [string, (value: string) => void, () => void] {
  const key = `${TOOL_PROMPT_DRAFT_PREFIX}${sessionId}-toolApprovalFeedback`;

  const [value, setValueState] = useState<string>(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });

  const setValue = useCallback(
    (newValue: string) => {
      setValueState(newValue);
      try {
        if (newValue) {
          localStorage.setItem(key, newValue);
        } else {
          localStorage.removeItem(key);
        }
      } catch {
        // localStorage might be unavailable
      }
    },
    [key],
  );

  const clearValue = useCallback(() => {
    setValueState("");
    try {
      localStorage.removeItem(key);
    } catch {
      // localStorage might be unavailable
    }
  }, [key]);

  return [value, setValue, clearValue];
}

/**
 * Hook to persist "Other" text inputs for AskUserQuestion panels.
 * Stores a map of question key -> otherText, keyed by session and request.
 *
 * For multi-stage questions (multiple tabs), each question's "Other"
 * input is stored separately under the same session key. When navigating
 * between tabs, each tab's draft is preserved.
 *
 * @param sessionId - The session ID
 * @param requestId - The pending input request ID
 * @returns [otherTexts, setOtherText, clearAll] tuple
 */
export function useQuestionOtherDrafts(
  sessionId: string,
  requestId?: string,
): [
  Record<string, string>,
  (question: string, value: string) => void,
  () => void,
] {
  const requestSuffix = requestId ? `-${requestId}` : "";
  const key = `${TOOL_PROMPT_DRAFT_PREFIX}${sessionId}${requestSuffix}-questionOther`;

  const [otherTexts, setOtherTextsState] = useState<Record<string, string>>(
    () => {
      try {
        const stored = localStorage.getItem(key);
        return stored ? JSON.parse(stored) : {};
      } catch {
        return {};
      }
    },
  );

  const setOtherText = useCallback(
    (question: string, value: string) => {
      setOtherTextsState((prev) => {
        const next = { ...prev };
        if (value) {
          next[question] = value;
        } else {
          delete next[question];
        }
        try {
          if (Object.keys(next).length > 0) {
            localStorage.setItem(key, JSON.stringify(next));
          } else {
            localStorage.removeItem(key);
          }
        } catch {
          // localStorage might be unavailable
        }
        return next;
      });
    },
    [key],
  );

  const clearAll = useCallback(() => {
    setOtherTextsState({});
    try {
      localStorage.removeItem(key);
    } catch {
      // localStorage might be unavailable
    }
  }, [key]);

  return [otherTexts, setOtherText, clearAll];
}
