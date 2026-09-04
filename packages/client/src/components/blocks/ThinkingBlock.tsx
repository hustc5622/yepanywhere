import { memo, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useI18n } from "../../i18n";
import type { ThinkingDetailRef } from "../../types/renderItems";

interface Props {
  thinking: string;
  status: "streaming" | "complete";
  isExpanded: boolean;
  onToggle: () => void;
  /** Present when the text is a display preview whose body loads on expand. */
  detail?: ThinkingDetailRef;
}

/** Single-line hint length; keeps collapsed reasoning rows distinguishable. */
const SUMMARY_PREVIEW_MAX_LENGTH = 120;

export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  status,
  isExpanded,
  onToggle,
  detail,
}: Props) {
  const { t } = useI18n();
  const isStreaming = status === "streaming";
  // A revision change invalidates detail refs, so the loaded body is keyed by
  // both and simply ignored once the row points at a new reasoning body.
  const detailKey = detail ? `${detail.revision}\u0000${detail.detailRef}` : "";
  const [loaded, setLoaded] = useState<{ key: string; content: string } | null>(
    null,
  );
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isExpanded || !detail?.truncated) return;
    if (loaded?.key === detailKey) return;
    if (requestedKeyRef.current === detailKey) return;
    requestedKeyRef.current = detailKey;
    setLoading(true);
    setError(null);
    let cancelled = false;
    void api
      .getSessionThinkingDetail(
        detail.projectId,
        detail.sessionId,
        detail.detailRef,
        {
          revision: detail.revision,
          ...(detail.branchId ? { branchId: detail.branchId } : {}),
        },
      )
      .then((response) => {
        if (!cancelled)
          setLoaded({ key: detailKey, content: response.content });
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        const code =
          loadError && typeof loadError === "object"
            ? (loadError as { code?: unknown }).code
            : undefined;
        setFailedKey(detailKey);
        setError(
          code === "SESSION_DISPLAY_STALE"
            ? t("sessionToolGroupStale")
            : t("sessionThinkingLoadFailed"),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detail, detailKey, isExpanded, loaded?.key, t]);

  const hasFullBody = loaded?.key === detailKey;
  const body = hasFullBody ? loaded.content : thinking;
  const isPartialBody = detail?.truncated === true && !hasFullBody;
  const summaryPreview = detail ? previewLine(thinking) : undefined;
  const visibleError = failedKey === detailKey ? error : null;
  const className = [
    "thinking-block",
    "collapsible",
    "timeline-item",
    isStreaming && !isExpanded ? "thinking-streaming-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <details
      className={className}
      open={isExpanded}
      onToggle={(e) => {
        if (e.currentTarget.open !== isExpanded) {
          onToggle();
        }
      }}
    >
      <summary className="collapsible__summary">
        <span>{isStreaming ? "Thinking..." : "Thinking"}</span>
        {summaryPreview && !isExpanded && (
          <span className="thinking-block__preview">{summaryPreview}</span>
        )}
        <span className="collapsible__icon">▸</span>
      </summary>
      <div className="collapsible__content">
        <span className="text-content">
          {body}
          {isPartialBody ? "…" : ""}
        </span>
        {loading && (
          <div className="thinking-block__state" role="status">
            {t("sessionThinkingLoading")}
          </div>
        )}
        {visibleError && (
          <div className="thinking-block__state is-error" role="alert">
            {visibleError}
          </div>
        )}
      </div>
    </details>
  );
});

function previewLine(thinking: string): string {
  const firstLine = thinking.trim().split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > SUMMARY_PREVIEW_MAX_LENGTH
    ? `${firstLine.slice(0, SUMMARY_PREVIEW_MAX_LENGTH - 1)}…`
    : firstLine;
}
