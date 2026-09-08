import type {
  SessionDisplayToolDetail,
  SessionDisplayToolOutput,
  SessionDisplayToolStep,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { useI18n } from "../../i18n";
import { preprocessMessages } from "../../lib/preprocessMessages";
import type { Message } from "../../types";
import type { DisplayToolGroupItem } from "../../types/renderItems";
import { LiveOutputPreview } from "./LiveOutputPreview";
import { ToolCallRow } from "./ToolCallRow";

interface ToolSelection {
  projectId: string;
  sessionId: string;
  branchId?: string;
  sessionProvider?: string;
}

// Row virtualization must not erase a user's explicit reading choice. Raw
// results remain local to the mounted detail reader and are never cached here.
const expandedGroups = new Map<string, boolean>();
const expandedTools = new Map<string, boolean>();
function remember(
  map: Map<string, boolean>,
  key: string,
  value: boolean,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > 500) {
    const first = map.keys().next().value;
    if (!first) break;
    map.delete(first);
  }
}

function statusGlyph(status: SessionDisplayToolStep["status"]): string {
  switch (status) {
    case "running":
      return "";
    case "completed":
      return "✓";
    case "failed":
      return "!";
    case "interrupted":
      return "×";
    case "unknown":
      return "?";
  }
}

export function ProjectedToolStepRow({
  step,
  onRead,
  ...selection
}: ToolSelection & { step: SessionDisplayToolStep; onRead?: () => void }) {
  const { t } = useI18n();
  const key = `${selection.projectId}:${selection.sessionId}:${selection.branchId ?? "active"}:${step.id}`;
  const [expanded, setExpanded] = useState(
    () => expandedTools.get(key) ?? false,
  );
  const [detail, setDetail] =
    useState<SessionDisplayToolDetail<Message> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [outputState, setOutputState] =
    useState<SessionDisplayToolOutput | null>(null);
  const [outputError, setOutputError] = useState(false);
  const generation = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const versionRef = useRef(step.version);
  versionRef.current = step.version;
  const requestedVersion = useRef<number | null>(null);
  const load = useCallback(
    async (cursor?: string) => {
      const request = ++generation.current;
      requestedVersion.current = versionRef.current;
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      setLoading(true);
      setError(false);
      try {
        const next = await api.getSessionDisplayTool(
          selection.projectId,
          selection.sessionId,
          step.id,
          { branchId: selection.branchId, cursor, signal: controller.signal },
        );
        if (request === generation.current) {
          requestedVersion.current = next.version;
          setDetail(next);
        }
      } catch {
        if (request === generation.current) setError(true);
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [selection.projectId, selection.sessionId, selection.branchId, step.id],
  );
  useEffect(() => {
    if (!expanded) return;
    void load();
    return () => {
      generation.current++;
      requestController.current?.abort();
    };
  }, [expanded, load]);
  useEffect(() => {
    if (
      expanded &&
      step.status !== "running" &&
      requestedVersion.current !== step.version
    )
      void load();
  }, [expanded, step.status, step.version, load]);
  const detailLoaded = detail !== null;
  const initialOutputRevision = detail?.liveOutputRevision;
  const outputEnded = outputState !== null && outputState.status !== "running";
  useEffect(() => {
    if (!expanded || !detailLoaded || outputEnded || step.status !== "running")
      return;
    let disposed = false;
    let since = initialOutputRevision;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!document.hidden) {
        controller = new AbortController();
        try {
          const next = await api.getSessionDisplayToolOutput(
            selection.projectId,
            selection.sessionId,
            step.id,
            { branchId: selection.branchId, since, signal: controller.signal },
          );
          if (disposed) return;
          since = next.revision;
          setOutputError(false);
          if (next.output !== undefined) setOutputState(next);
          if (next.status !== "running") {
            setOutputState(next);
            await load();
            return;
          }
        } catch {
          if (disposed) return;
          setOutputError(true);
        }
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 2_000);
    };
    timer = setTimeout(() => void refresh(), 2_000);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [
    expanded,
    detailLoaded,
    outputEnded,
    initialOutputRevision,
    step.status,
    step.id,
    selection.projectId,
    selection.sessionId,
    selection.branchId,
    load,
  ]);
  const items = useMemo(
    () =>
      detail
        ? preprocessMessages(detail.messages).filter(
            (item) => item.type === "tool_call",
          )
        : [],
    [detail],
  );
  const showLiveOutput =
    step.status === "running" &&
    (!outputState || outputState.status === "running") &&
    /^(bash|shell)$/i.test(step.name);
  const liveOutput =
    outputState?.output ??
    detail?.liveOutput ??
    items.find((item) => item.partialOutput)?.partialOutput ??
    step.preview;
  const toggle = () => {
    const next = !expanded;
    remember(expandedTools, key, next);
    setExpanded(next);
    if (next) onRead?.();
    else {
      generation.current++;
      requestController.current?.abort();
      setDetail(null);
      requestedVersion.current = null;
      setOutputState(null);
      setOutputError(false);
    }
  };
  return (
    <div
      className={`display-step display-step--${step.status} ${expanded ? "expanded" : "collapsed"}`}
      data-testid="display-step"
    >
      <button
        className="display-step-header"
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
      >
        <span
          className="display-step-status"
          aria-label={step.status}
          data-status={step.status}
        >
          {step.status === "running" ? (
            <span className="display-step-spinner" aria-hidden="true" />
          ) : (
            statusGlyph(step.status)
          )}
        </span>
        <span className="display-step-name">{step.name}</span>
        {step.summary && (
          <span className="display-step-summary" title={step.summary}>
            {step.summary}
          </span>
        )}
        <span className="display-step-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div className="display-step-detail">
          {showLiveOutput && (
            <section aria-label={t("sessionDisplayLatestOutput")}>
              <div className="display-tool-group-state">
                {t("sessionDisplayLatestOutput")}
              </div>
              {liveOutput.trim() ? (
                <LiveOutputPreview output={liveOutput} />
              ) : (
                <div className="display-tool-group-state" role="status">
                  {t("sessionDisplayWaitingOutput")}
                </div>
              )}
            </section>
          )}
          {showLiveOutput && outputError && (
            <div className="display-tool-group-state" role="status">
              {t("sessionDisplayOutputRetrying")}
            </div>
          )}
          {items.map((item) => (
            <ToolCallRow
              key={item.id}
              id={item.id}
              toolName={item.toolName}
              toolInput={item.toolInput}
              toolResult={item.toolResult}
              status={item.status}
              sessionProvider={selection.sessionProvider}
              detailOnly
            />
          ))}
          {detail?.rawJson && (
            <>
              <span className="display-tool-group-state">
                {t("sessionDisplayDetailRange", {
                  start: detail.rawJson.offset + 1,
                  end: detail.rawJson.offset + detail.rawJson.content.length,
                  total: detail.rawJson.total,
                })}
              </span>
              <pre className="display-step-raw">{detail.rawJson.content}</pre>
            </>
          )}
          {loading && !detail && (
            <div className="display-step-loading" role="status">
              {t("sessionToolGroupLoading")}
            </div>
          )}
          {error && (
            <button
              className="display-step-retry"
              type="button"
              onClick={() => void load()}
            >
              {t("sessionToolGroupLoadFailed")} · {t("sessionDisplayRetry")}
            </button>
          )}
          {detail?.nextCursor && !loading && (
            <button
              className="display-step-retry"
              type="button"
              onClick={() => void load(detail.nextCursor)}
            >
              {t("sessionToolGroupLoadMore")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectedToolGroupRow({
  item,
  sessionProvider,
}: { item: DisplayToolGroupItem; sessionProvider?: string }) {
  const { t } = useI18n();
  const group = item.group;
  const key = `${item.projectId}:${item.sessionId}:${item.branchId ?? "active"}:${group.id}`;
  const [choice, setChoice] = useState<boolean | undefined>(() =>
    expandedGroups.get(key),
  );
  const autoExpanded =
    group.type === "tool_group" && group.displayMode === "steps";
  const expanded = choice ?? autoExpanded;
  const [loadedSteps, setLoadedSteps] = useState<SessionDisplayToolStep[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const projectedSteps = group.type === "tool_group" ? (group.steps ?? []) : [];
  const lastProjectedSteps = useRef<SessionDisplayToolStep[]>([]);
  if (projectedSteps.length) lastProjectedSteps.current = projectedSteps;
  const retainedSteps =
    !autoExpanded && expanded && !loadedSteps.length
      ? lastProjectedSteps.current
      : [];
  const steps = useMemo(
    () => [
      ...new Map(
        [...retainedSteps, ...loadedSteps, ...projectedSteps].map((step) => [
          step.id,
          step,
        ]),
      ).values(),
    ],
    [retainedSteps, loadedSteps, projectedSteps],
  );
  const load = useCallback(
    async (before?: string) => {
      const request = ++generation.current;
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      setLoading(true);
      setError(false);
      try {
        const page = await api.getSessionDisplayGroup(
          item.projectId,
          item.sessionId,
          group.id,
          {
            branchId: item.branchId,
            cursor: before,
            signal: controller.signal,
          },
        );
        if (request !== generation.current) return;
        setLoadedSteps((current) =>
          before ? [...page.steps, ...current] : page.steps,
        );
        setCursor(page.nextCursor);
      } catch {
        if (request === generation.current) setError(true);
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [item.projectId, item.sessionId, item.branchId, group.id],
  );
  const count = group.type === "tool_group" ? group.count : 0;
  const groupVersion = group.type === "tool_group" ? group.version : undefined;
  useEffect(() => {
    if (!autoExpanded && !expanded) lastProjectedSteps.current = [];
  }, [autoExpanded, expanded]);
  // A closed group loads only its lightweight tool index after the user opens
  // it. A version change refreshes an already-open group for late results.
  // biome-ignore lint/correctness/useExhaustiveDependencies: groupVersion intentionally refreshes an explicitly opened historical group
  useEffect(() => {
    const timer =
      expanded && !autoExpanded
        ? setTimeout(() => void load(), 100)
        : undefined;
    return () => {
      clearTimeout(timer);
      generation.current++;
      requestController.current?.abort();
    };
  }, [expanded, autoExpanded, load, groupVersion]);
  const choose = (value: boolean) => {
    remember(expandedGroups, key, value);
    setChoice(value);
    if (!value) {
      generation.current++;
      requestController.current?.abort();
      const toolKeyPrefix = `${item.projectId}:${item.sessionId}:${item.branchId ?? "active"}:`;
      for (const step of steps) {
        expandedTools.delete(`${toolKeyPrefix}${step.id}`);
      }
      setLoadedSteps([]);
      setCursor(undefined);
      setError(false);
    }
  };
  const pinReading = () => choose(true);
  const onPointerUp = () => {
    if (window.getSelection()?.toString()) pinReading();
  };
  const running = group.type === "tool_group" ? (group.runningCount ?? 0) : 0;
  const failed = group.type === "tool_group" ? group.failedCount : 0;
  const interrupted =
    group.type === "tool_group" ? (group.interruptedCount ?? 0) : 0;
  const unknown = group.type === "tool_group" ? (group.unknownCount ?? 0) : 0;
  const completed = Math.max(
    0,
    count - running - failed - interrupted - unknown,
  );
  return (
    <div
      className={`display-tool-group display-tool-group--projected timeline-item display-tool-group--${group.status} ${expanded ? "expanded" : "collapsed"}`}
      data-testid="projected-tool-group"
      onPointerUp={onPointerUp}
    >
      <button
        className="display-tool-group-header"
        type="button"
        onClick={() => choose(!expanded)}
        aria-expanded={expanded}
      >
        <span className="display-tool-group-summary">
          {t("sessionToolGroupCount", { count })}
        </span>
        <span className="display-tool-group-meta">
          {completed > 0 && (
            <span className="is-completed">
              {t("sessionDisplayToolsCompleted", { count: completed })}
            </span>
          )}
          {running > 0 && (
            <span className="is-running">
              {t("sessionDisplayToolsRunning", { count: running })}
            </span>
          )}
          {failed > 0 && (
            <span className="is-error">
              {t("sessionToolGroupFailedCount", { count: failed })}
            </span>
          )}
          {interrupted > 0 ? (
            <span>
              {t("sessionDisplayToolsInterrupted", {
                count: interrupted,
              })}
            </span>
          ) : null}
          {unknown > 0 ? (
            <span>
              {t("sessionDisplayResultsSyncing", {
                count: unknown,
              })}
            </span>
          ) : null}
          {group.type === "tool_group" && group.changedFileCount ? (
            <span>
              {t("sessionToolGroupChangedFiles", {
                count: group.changedFileCount,
              })}
            </span>
          ) : null}
          {group.type === "tool_group" && group.checkCount ? (
            <span>
              {t("sessionToolGroupChecks", { count: group.checkCount })}
            </span>
          ) : null}
        </span>
        <span className="expand-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div className="display-tool-group-content">
          {steps.length < count && steps.length > 0 && (
            <button
              className="display-tool-group-more"
              type="button"
              disabled={loading}
              onClick={() =>
                void load(cursor ?? String(Math.max(0, count - steps.length)))
              }
            >
              {t("sessionDisplayEarlierSteps", {
                shown: steps.length,
                total: count,
              })}
            </button>
          )}
          {steps.map((step) => (
            <ProjectedToolStepRow
              key={step.id}
              step={step}
              projectId={item.projectId}
              sessionId={item.sessionId}
              branchId={item.branchId}
              sessionProvider={sessionProvider}
              onRead={pinReading}
            />
          ))}
          {loading && (
            <div className="display-tool-group-state" role="status">
              {t("sessionDisplayToolListLoading")}
            </div>
          )}
          {error && (
            <button
              className="display-tool-group-more"
              type="button"
              onClick={() => void load()}
            >
              {t("sessionDisplayToolListLoadFailed")} ·{" "}
              {t("sessionDisplayRetry")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
