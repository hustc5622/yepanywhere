import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { useI18n } from "../../i18n";
import { preprocessMessages } from "../../lib/preprocessMessages";
import type { Message } from "../../types";
import type { DisplayToolGroupItem } from "../../types/renderItems";
import { ToolCallRow } from "./ToolCallRow";

export function DisplayToolGroupRow({
  item,
  sessionProvider,
}: {
  item: DisplayToolGroupItem;
  sessionProvider?: string;
}) {
  const { t } = useI18n();
  const isLiveTail =
    item.group.type === "tool_group" && item.group.liveTail === true;
  const [expanded, setExpanded] = useState(isLiveTail);
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toolItems = useMemo(
    () =>
      preprocessMessages(messages).filter(
        (entry) => entry.type === "tool_call",
      ),
    [messages],
  );

  const loadDetails = useCallback(
    async (cursor?: string) => {
      if (loading) return;
      const detailRef = item.group.detailRef;
      if (!detailRef) return;
      setLoading(true);
      setError(null);
      try {
        const page = await api.getSessionToolGroupDetails(
          item.projectId,
          item.sessionId,
          detailRef,
          {
            revision: item.revision,
            cursor,
            branchId: item.branchId,
          },
        );
        setMessages((current) => [...current, ...page.messages]);
        setNextCursor(page.nextCursor);
        setLoaded(true);
      } catch (loadError) {
        const code =
          loadError && typeof loadError === "object"
            ? (loadError as { code?: unknown }).code
            : undefined;
        setError(
          code === "SESSION_DISPLAY_STALE"
            ? t("sessionToolGroupStale")
            : t("sessionToolGroupLoadFailed"),
        );
      } finally {
        setLoading(false);
      }
    },
    [
      item.branchId,
      item.group.detailRef,
      item.projectId,
      item.revision,
      item.sessionId,
      loading,
      t,
    ],
  );
  const autoLoadAttemptedRef = useRef(false);
  const wasLiveTailRef = useRef(isLiveTail);
  useEffect(() => {
    if (isLiveTail && !autoLoadAttemptedRef.current) {
      autoLoadAttemptedRef.current = true;
      setExpanded(true);
      void loadDetails();
    } else if (!isLiveTail && wasLiveTailRef.current) {
      setExpanded(false);
    }
    wasLiveTailRef.current = isLiveTail;
  }, [isLiveTail, loadDetails]);

  const handleToggle = () => {
    if (!item.group.detailRef) return;
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && !loaded && !loading) void loadDetails();
  };
  const status = item.group.status;
  const summary = getGroupSummary(item, t);

  return (
    <div
      className={`display-tool-group timeline-item status-${status} ${expanded ? "expanded" : "collapsed"}`}
      data-testid="display-tool-group"
    >
      <button
        type="button"
        className="display-tool-group-header"
        onClick={handleToggle}
        disabled={!item.group.detailRef}
        aria-expanded={expanded}
      >
        {status === "running" && (
          <span className="display-tool-group-spinner" aria-hidden="true" />
        )}
        <span className="display-tool-group-summary">{summary}</span>
        <span className="display-tool-group-names">
          {item.group.type === "tool_group"
            ? item.group.toolNames.join(" · ")
            : ""}
        </span>
        <span className="expand-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {expanded && (
        <div className="display-tool-group-content">
          {toolItems.map((tool) => (
            <ToolCallRow
              key={tool.id}
              id={tool.id}
              toolName={tool.toolName}
              toolInput={tool.toolInput}
              toolResult={tool.toolResult}
              status={tool.status}
              sessionProvider={sessionProvider}
              partialOutput={tool.partialOutput}
            />
          ))}
          {loading && (
            <div className="display-tool-group-state" role="status">
              {t("sessionToolGroupLoading")}
            </div>
          )}
          {error && (
            <div className="display-tool-group-state is-error" role="alert">
              {error}
            </div>
          )}
          {nextCursor && !loading && (
            <button
              type="button"
              className="display-tool-group-more"
              onClick={() => void loadDetails(nextCursor)}
            >
              {t("sessionToolGroupLoadMore")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

function getGroupSummary(item: DisplayToolGroupItem, t: Translate): string {
  const group = item.group;
  if (group.type === "action_required") {
    return group.action === "approval"
      ? t("sessionToolGroupApproval")
      : t("sessionToolGroupQuestion");
  }
  const parts = [t("sessionToolGroupCount", { count: group.count })];
  if (group.failedCount > 0) {
    parts.push(t("sessionToolGroupFailedCount", { count: group.failedCount }));
  }
  if (group.changedFileCount) {
    parts.push(
      t("sessionToolGroupChangedFiles", { count: group.changedFileCount }),
    );
  }
  if (group.checkCount) {
    parts.push(t("sessionToolGroupChecks", { count: group.checkCount }));
  }
  return parts.join(" · ");
}
