import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { useFabVisibility } from "../hooks/useFabVisibility";
import { useProjects } from "../hooks/useProjects";
import {
  resolvePreferredProjectId,
  setRecentProjectId,
} from "../hooks/useRecentProject";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import {
  handleComposerSubmitKey,
  isComposerComposing,
} from "../lib/composerKeyboard";
import { VoiceInputButton } from "./VoiceInputButton";

const FAB_DRAFT_KEY = "fab-draft";
const FAB_PREFILL_KEY = "fab-prefill";

/**
 * Set pre-fill text for NewSessionForm to read on mount.
 * This is how FAB hands off the draft to the full form.
 */
export function getFabPrefill(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(FAB_PREFILL_KEY);
}

export function clearFabPrefill(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(FAB_PREFILL_KEY);
}

function setFabPrefill(text: string): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(FAB_PREFILL_KEY, text);
}

/**
 * Floating Action Button for quick session creation.
 * Desktop-only feature that appears in the right margin when there's room.
 */
export function FloatingActionButton() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const basePath = useRemoteBasePath();
  const fabVisibility = useFabVisibility();
  const [isExpanded, setIsExpanded] = useState(false);
  const [message, setMessage, draftControls] =
    useDraftPersistence(FAB_DRAFT_KEY);
  const [interimTranscript, setInterimTranscript] = useState("");
  const projectIdFromUrl = extractProjectIdFromPath(location.pathname);
  const isOnNewSessionPage = location.pathname.endsWith("/new-session");
  const shouldLoadProjects =
    Boolean(fabVisibility) && !isOnNewSessionPage && !projectIdFromUrl;
  const { projects } = useProjects({ enabled: shouldLoadProjects });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Update recent project when navigating to a project page
  useEffect(() => {
    if (projectIdFromUrl) {
      setRecentProjectId(projectIdFromUrl);
    }
  }, [projectIdFromUrl]);

  // Focus textarea when expanded
  useEffect(() => {
    if (isExpanded) {
      textareaRef.current?.focus();
    }
  }, [isExpanded]);

  // Close on click outside
  useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsExpanded(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded]);

  const handleSubmit = useCallback(() => {
    const trimmed = message.trim();
    if (!trimmed) return;

    // Get project to navigate to (prefer current project, then recent, then any)
    const targetProjectId =
      projectIdFromUrl ?? resolvePreferredProjectId(projects);
    if (!targetProjectId) {
      // No project context - can't proceed
      return;
    }

    // Store the message for NewSessionForm to pick up
    setFabPrefill(trimmed);
    draftControls.clearDraft();
    setIsExpanded(false);

    // Navigate to new session page
    navigate(
      `${basePath}/new-session?projectId=${encodeURIComponent(targetProjectId)}`,
    );
  }, [message, projectIdFromUrl, navigate, draftControls, basePath, projects]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposerComposing(e)) return;
      if (e.key === "Escape") {
        setIsExpanded(false);
        return;
      }
      handleComposerSubmitKey(e, { onSubmit: handleSubmit });
    },
    [handleSubmit],
  );

  const handleButtonClick = useCallback(() => {
    // Check if we have a valid project target (prefer current project, then recent, then any)
    const targetProjectId =
      projectIdFromUrl ?? resolvePreferredProjectId(projects);
    if (!targetProjectId) {
      // No project context - navigate to projects page instead
      navigate(`${basePath}/projects`);
      return;
    }
    setIsExpanded(true);
  }, [projectIdFromUrl, navigate, basePath, projects]);

  // Voice input handlers
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      const trimmed = message.trimEnd();
      if (trimmed) {
        setMessage(`${trimmed} ${transcript}`);
      } else {
        setMessage(transcript);
      }
      setInterimTranscript("");
    },
    [message, setMessage],
  );

  const handleInterimTranscript = useCallback((transcript: string) => {
    setInterimTranscript(transcript);
  }, []);

  // Combined display text: committed text + interim transcript
  const displayText = interimTranscript
    ? message + (message.trimEnd() ? " " : "") + interimTranscript
    : message;

  // Hide (but don't unmount) when not visible or on new-session page
  // This preserves expanded state and draft across navigation
  const isHidden = !fabVisibility || isOnNewSessionPage;

  const { right, bottom, maxWidth } = fabVisibility ?? {
    right: 24,
    bottom: 80,
    maxWidth: 200,
  };

  return (
    <div
      ref={containerRef}
      className={`fab-container ${isExpanded ? "fab-expanded" : "fab-collapsed"}`}
      style={{
        right: `${right}px`,
        bottom: `${bottom}px`,
        width: `${maxWidth}px`, // Always use maxWidth so button stays centered
        display: isHidden ? "none" : undefined,
      }}
    >
      {/* Input panel appears above the button */}
      {isExpanded && (
        <div className="fab-input-panel">
          <textarea
            ref={textareaRef}
            value={displayText}
            onChange={(e) => {
              setInterimTranscript("");
              setMessage(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t("fabPlaceholder")}
            className="fab-textarea"
            rows={3}
          />
          <div className="fab-input-toolbar">
            <VoiceInputButton
              onTranscript={handleVoiceTranscript}
              onInterimTranscript={handleInterimTranscript}
              className="toolbar-button"
            />
            <button
              type="button"
              className="fab-submit"
              onClick={handleSubmit}
              disabled={!message.trim()}
              title={t("fabContinueToSetupHint")}
              aria-label={t("fabGoToNewSession")}
            >
              <span>{t("fabContinueToSetup")}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </button>
          </div>
        </div>
      )}
      {/* FAB button always at the bottom */}
      <button
        type="button"
        className={`fab-button ${isExpanded ? "fab-button-active" : ""}`}
        onClick={isExpanded ? () => setIsExpanded(false) : handleButtonClick}
        aria-label={isExpanded ? t("fabClose") : t("fabNewSession")}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={isExpanded ? "fab-icon-rotated" : ""}
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Extract projectId from URL path.
 * Matches: /projects/:projectId and /projects/:projectId/sessions/:sessionId.
 */
function extractProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/projects\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
