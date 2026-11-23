import type { SessionDisplayNode } from "@yep-anywhere/shared";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../../api/client";
import { useI18n } from "../../i18n";
import {
  buildSessionDisplayProcessItems,
  formatSessionDisplayNotice,
} from "../../lib/sessionDisplay";
import {
  type SubagentStatLabels,
  formatSubagentDuration,
} from "../../lib/subagentStats";
import type { DisplayProcessItem, RenderItem } from "../../types/renderItems";

/** Durations below this are noise for a whole answer; show the bare status. */
const MIN_VISIBLE_DURATION_MS = 1_000;

// Remember explicit choices so virtualized rows re-mount in the same state.
const expandedProcesses = new Map<string, boolean>();
function rememberExpanded(key: string, value: boolean): void {
  expandedProcesses.delete(key);
  expandedProcesses.set(key, value);
  while (expandedProcesses.size > 500) {
    const first = expandedProcesses.keys().next().value;
    if (!first) break;
    expandedProcesses.delete(first);
  }
}

export function resetDisplayProcessStateForTests(): void {
  expandedProcesses.clear();
}

type Translate = ReturnType<typeof useI18n>["t"];

function processDurationMs(
  startedAt: string | undefined,
  endedAt: string | undefined,
): number | undefined {
  const start = Date.parse(startedAt ?? "");
  const end = Date.parse(endedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return undefined;
  return end - start;
}

function processTitle(
  status: DisplayProcessItem["process"]["status"],
  duration: string | undefined,
  t: Translate,
): string {
  if (duration) {
    switch (status) {
      case "completed":
        return t("sessionProcessCompleted", { duration });
      case "interrupted":
        return t("sessionProcessInterrupted", { duration });
      case "failed":
        return t("sessionProcessFailed", { duration });
      case "incomplete":
        return t("sessionProcessIncomplete", { duration });
      case "unknown":
        return t("sessionProcessWorked", { duration });
    }
  }
  switch (status) {
    case "completed":
      return t("sessionProcessCompletedNoDuration");
    case "interrupted":
      return t("sessionProcessInterruptedNoDuration");
    case "failed":
      return t("sessionProcessFailedNoDuration");
    case "incomplete":
      return t("sessionProcessIncompleteNoDuration");
    case "unknown":
      return t("sessionProcessWorkedNoDuration");
  }
}

/**
 * One collapsed row standing in for a settled answer's working steps
 * (reasoning, progress updates and tool groups). Members are fetched only when
 * the reader opens the row, then rendered with the regular item renderers.
 */
export function DisplayProcessRow({
  item,
  sessionProvider,
  renderItem,
}: {
  item: DisplayProcessItem;
  sessionProvider?: string;
  renderItem: (
    child: RenderItem,
    thinkingExpanded: boolean,
    toggleThinking: (id: string) => void,
  ) => ReactNode;
}) {
  const { t } = useI18n();
  const process = item.process;
  const key = `${item.projectId}:${item.sessionId}:${item.branchId ?? "active"}:${process.id}`;
  const [expanded, setExpanded] = useState(
    () => expandedProcesses.get(key) ?? false,
  );
  const [nodes, setNodes] = useState<SessionDisplayNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const generation = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const versionRef = useRef(process.version);
  versionRef.current = process.version;
  const loadedVersion = useRef<number | null>(null);

  const load = useCallback(async () => {
    const request = ++generation.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const version = versionRef.current;
    setLoading(true);
    setError(false);
    try {
      const page = await api.getSessionDisplayProcess(
        item.projectId,
        item.sessionId,
        process.id,
        {
          branchId: item.branchId,
          cursor: process.pageCursor,
          signal: controller.signal,
        },
      );
      if (request !== generation.current) return;
      loadedVersion.current = version;
      setNodes(page.nodes);
    } catch {
      if (request === generation.current) setError(true);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [
    item.projectId,
    item.sessionId,
    item.branchId,
    process.id,
    process.pageCursor,
  ]);

  // Load on open, and refresh an open fold when a member changes (for example
  // a late tool result). Closing cancels any request in flight.
  useEffect(() => {
    if (!expanded) return;
    if (loadedVersion.current !== process.version) void load();
    return () => {
      generation.current++;
      requestController.current?.abort();
    };
  }, [expanded, process.version, load]);

  const toggle = () => {
    const next = !expanded;
    rememberExpanded(key, next);
    setExpanded(next);
    if (!next) setError(false);
  };
  const toggleThinking = useCallback((id: string) => {
    setExpandedThinking((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const children = useMemo(
    () =>
      nodes
        ? buildSessionDisplayProcessItems(nodes, {
            projectId: item.projectId,
            sessionId: item.sessionId,
            revision: item.revision,
            branchId: item.branchId,
            provider: sessionProvider,
            formatNotice: (notice) => formatSessionDisplayNotice(notice, t),
          })
        : [],
    [
      nodes,
      item.projectId,
      item.sessionId,
      item.revision,
      item.branchId,
      sessionProvider,
      t,
    ],
  );

  const durationLabels = useMemo<SubagentStatLabels>(
    () => ({
      seconds: (count) => t("subagentStatSeconds", { count }),
      minutesSeconds: (minutes, seconds) =>
        t("subagentStatMinutesSeconds", { minutes, seconds }),
      hoursMinutes: (hours, minutes) =>
        t("subagentStatHoursMinutes", { hours, minutes }),
      tools: (count) => t("subagentStatTools", { count }),
      context: (tokens) => t("subagentStatContext", { tokens }),
      total: (tokens) => t("subagentStatTotal", { tokens }),
    }),
    [t],
  );
  const durationMs = processDurationMs(process.startedAt, process.endedAt);
  const duration =
    durationMs !== undefined && durationMs >= MIN_VISIBLE_DURATION_MS
      ? formatSubagentDuration(durationMs, durationLabels)
      : undefined;

  return (
    <div
      className={`display-process timeline-item display-process--${process.status} ${expanded ? "expanded" : "collapsed"}`}
      data-testid="display-process"
    >
      <button
        type="button"
        className="display-process-header"
        onClick={toggle}
        aria-expanded={expanded}
      >
        <span className="display-process-title">
          {processTitle(process.status, duration, t)}
        </span>
        <span className="display-process-meta">
          <span>
            {process.toolCount > 0
              ? t("sessionToolGroupCount", { count: process.toolCount })
              : t("sessionProcessSteps", { count: process.stepCount })}
          </span>
          {process.failedToolCount > 0 && (
            <span className="is-error">
              {t("sessionToolGroupFailedCount", {
                count: process.failedToolCount,
              })}
            </span>
          )}
          {process.changedFileCount ? (
            <span>
              {t("sessionToolGroupChangedFiles", {
                count: process.changedFileCount,
              })}
            </span>
          ) : null}
        </span>
        <span className="display-process-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div className="display-process-content">
          {children.map((child) => (
            <Fragment key={child.id}>
              {renderItem(
                child,
                expandedThinking.has(child.id),
                toggleThinking,
              )}
            </Fragment>
          ))}
          {loading && !nodes && (
            <div className="display-tool-group-state" role="status">
              {t("sessionProcessLoading")}
            </div>
          )}
          {error && (
            <button
              className="display-tool-group-more"
              type="button"
              onClick={() => void load()}
            >
              {t("sessionProcessLoadFailed")} · {t("sessionDisplayRetry")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
