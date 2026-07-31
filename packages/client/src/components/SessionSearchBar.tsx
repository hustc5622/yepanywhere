import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { type SearchMatch, api } from "../api/client";
import { useI18n } from "../i18n";

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

interface SessionSearchBarProps {
  isOpen: boolean;
  projectId: string;
  sessionId: string;
  onOpen: () => void;
  onClose: () => void;
  onSelectMessage: (messageId: string) => void;
}

export function SessionSearchBar({
  isOpen,
  projectId,
  sessionId,
  onOpen,
  onClose,
  onSelectMessage,
}: SessionSearchBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const [inputValue, setInputValue] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
        return;
      }

      const isFindShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f";
      if (isFindShortcut) {
        event.preventDefault();
        if (isOpen) inputRef.current?.focus();
        else onOpen();
        return;
      }

      if (isOpen && event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, onOpen]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setLoading(false);
      return;
    }

    const query = inputValue.trim();
    setMatches([]);
    setTotalMatches(0);
    setCurrentIndex(-1);
    setFailed(false);

    if (query.length < MIN_QUERY_LENGTH) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .search({
          q: query,
          project: projectId,
          session: sessionId,
          limit: 1,
        })
        .then((response) => {
          if (cancelled) return;
          const result = response.results.find(
            (candidate) => candidate.sessionId === sessionId,
          );
          const nextMatches = result?.matches ?? [];
          setMatches(nextMatches);
          setTotalMatches(result?.matchCount ?? 0);
          if (nextMatches.length > 0) {
            setCurrentIndex(0);
            const firstMatch = nextMatches[0];
            if (firstMatch) onSelectMessage(firstMatch.messageId);
          }
        })
        .catch(() => {
          if (cancelled) return;
          setFailed(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [inputValue, isOpen, onSelectMessage, projectId, sessionId]);

  const selectMatch = useCallback(
    (index: number) => {
      const match = matches[index];
      if (!match) return;
      setCurrentIndex(index);
      onSelectMessage(match.messageId);
    },
    [matches, onSelectMessage],
  );

  const moveSelection = useCallback(
    (direction: -1 | 1) => {
      if (matches.length === 0) return;
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex =
        (baseIndex + direction + matches.length) % matches.length;
      selectMatch(nextIndex);
    },
    [currentIndex, matches.length, selectMatch],
  );

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      event.preventDefault();
      moveSelection(event.shiftKey ? -1 : 1);
    },
    [moveSelection],
  );

  const statusText = useMemo(() => {
    const query = inputValue.trim();
    if (loading) return t("sessionSearchLoading");
    if (failed) return t("sessionSearchFailed");
    if (query.length < MIN_QUERY_LENGTH) return t("sessionSearchHint");
    if (matches.length === 0) return t("sessionSearchNoResults");

    const current = Math.max(1, currentIndex + 1);
    if (totalMatches > matches.length) {
      return t("sessionSearchPositionLimited", {
        current,
        shown: matches.length,
        total: totalMatches,
      });
    }
    return t("sessionSearchPosition", {
      current,
      total: matches.length,
    });
  }, [
    currentIndex,
    failed,
    inputValue,
    loading,
    matches.length,
    t,
    totalMatches,
  ]);

  if (!isOpen) return null;

  return (
    <div
      id="session-search-panel"
      className="session-search-bar"
      role="search"
      aria-label={t("sessionSearchTitle")}
    >
      <div className="session-search-bar-inner">
        <svg
          className="session-search-leading-icon"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          className="session-search-input"
          value={inputValue}
          placeholder={t("sessionSearchPlaceholder")}
          aria-label={t("sessionSearchTitle")}
          aria-describedby={statusId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setInputValue(event.target.value)}
          onKeyDown={handleInputKeyDown}
        />
        <span
          id={statusId}
          className={`session-search-status${failed ? " is-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {statusText}
        </span>
        <div className="session-search-controls">
          <button
            type="button"
            className="session-search-control"
            onClick={() => moveSelection(-1)}
            disabled={matches.length === 0}
            title={t("sessionSearchPrevious")}
            aria-label={t("sessionSearchPrevious")}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            type="button"
            className="session-search-control"
            onClick={() => moveSelection(1)}
            disabled={matches.length === 0}
            title={t("sessionSearchNext")}
            aria-label={t("sessionSearchNext")}
          >
            <svg
              width="16"
              height="16"
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
          <button
            type="button"
            className="session-search-control session-search-close"
            onClick={onClose}
            title={t("sessionSearchClose")}
            aria-label={t("sessionSearchClose")}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
