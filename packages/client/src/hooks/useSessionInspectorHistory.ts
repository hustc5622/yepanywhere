import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { getMessageId } from "../lib/mergeMessages";
import { resolveSessionInspectorNavigation } from "../lib/sessionDisplay";
import type { Message } from "../types";

interface Options {
  projectId: string;
  sessionId: string;
  branchId?: string;
  revision?: string;
  processState?: string;
  enabled: boolean;
  onError: () => void;
}

/** Owns cancellable, paged Inspector history independently of transcript rendering. */
export function useSessionInspectorHistory({
  projectId,
  sessionId: actualSessionId,
  branchId: selectedBranchId,
  revision,
  processState,
  enabled,
  onError,
}: Options) {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const requestInFlight = useRef(false);
  const [legacyInspectorMessages, setLegacyInspectorMessages] = useState<
    Message[] | null
  >(null);
  const [legacyInspectorLoading, setLegacyInspectorLoading] = useState(false);
  const [legacyInspectorError, setLegacyInspectorError] = useState(false);
  const legacyInspectorLoadGenerationRef = useRef(0);
  const legacyInspectorRevisionRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: session/branch identity intentionally invalidates the derived Inspector index
  useEffect(() => {
    requestInFlight.current = false;
    legacyInspectorLoadGenerationRef.current += 1;
    legacyInspectorRevisionRef.current = null;
    setLegacyInspectorMessages(null);
    setLegacyInspectorLoading(false);
    setLegacyInspectorError(false);
  }, [projectId, actualSessionId, selectedBranchId]);
  useEffect(() => {
    if (enabled && processState !== "in-turn") return;
    // The lightweight display and live tail remain authoritative while a turn
    // is changing. A complete Inspector index spans multiple persisted-history
    // pages, so cancel its logical generation instead of mixing pages from
    // different active snapshots or surfacing a transient stale cursor.
    if (requestInFlight.current || processState === "in-turn")
      legacyInspectorRevisionRef.current = null;
    requestInFlight.current = false;
    legacyInspectorLoadGenerationRef.current += 1;
    setLegacyInspectorLoading(false);
    setLegacyInspectorError(false);
  }, [enabled, processState]);
  const loadLegacyInspectorHistory = useCallback(
    async (force = false) => {
      if (
        !enabled ||
        revision === undefined ||
        processState === "in-turn" ||
        (!force && legacyInspectorMessages) ||
        legacyInspectorLoading ||
        requestInFlight.current
      )
        return;
      requestInFlight.current = true;
      const generation = ++legacyInspectorLoadGenerationRef.current;
      const projectedRevision = revision;
      setLegacyInspectorLoading(true);
      setLegacyInspectorError(false);
      try {
        let loaded: Message[] | null = null;
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            let data = await api.getSession(
              projectId,
              actualSessionId,
              undefined,
              {
                view: "canonical",
                inspectorProjection: true,
                tailCompactions: 2,
                maxMessages: 100,
                branchId: selectedBranchId,
              },
            );
            if (generation !== legacyInspectorLoadGenerationRef.current) return;
            let snapshot = data.messages.map((message) => ({
              ...message,
              _source: "jsonl" as const,
            }));
            for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
              const paginationInfo = data.pagination;
              if (
                !paginationInfo?.hasOlderMessages ||
                !paginationInfo.truncatedBeforeMessageId
              ) {
                break;
              }
              data = await api.getSession(
                projectId,
                actualSessionId,
                undefined,
                {
                  view: "canonical",
                  inspectorProjection: true,
                  tailCompactions: 2,
                  maxMessages: 100,
                  beforeMessageId: paginationInfo.truncatedBeforeMessageId,
                  rolloutRevision: paginationInfo.rolloutRevision,
                  branchId: selectedBranchId,
                },
              );
              if (generation !== legacyInspectorLoadGenerationRef.current)
                return;
              snapshot = [
                ...data.messages.map((message) => ({
                  ...message,
                  _source: "jsonl" as const,
                })),
                ...snapshot,
              ];
            }
            if (data.pagination?.hasOlderMessages) {
              throw new Error(
                "Session index exceeds the safe pagination budget",
              );
            }
            loaded = snapshot;
            break;
          } catch (error) {
            lastError = error;
            if (generation !== legacyInspectorLoadGenerationRef.current) return;
            if (attempt === 0 && isRetryableInspectorHistoryError(error)) {
              continue;
            }
            throw error;
          }
        }
        if (!loaded)
          throw lastError ?? new Error("Session index is unavailable");
        if (generation !== legacyInspectorLoadGenerationRef.current) return;
        const seen = new Set<string>();
        setLegacyInspectorMessages(
          resolveSessionInspectorNavigation(
            loaded.filter((message) => {
              const id = getMessageId(message);
              if (seen.has(id)) return false;
              seen.add(id);
              return true;
            }),
          ),
        );
        legacyInspectorRevisionRef.current = projectedRevision;
      } catch (error) {
        if (generation !== legacyInspectorLoadGenerationRef.current) return;
        console.error("Failed to load session inspector index:", error);
        if (force && legacyInspectorMessages) {
          // Keep the last complete safe index and wait for the next revision
          // instead of turning one transient idle refresh into a retry loop.
          legacyInspectorRevisionRef.current = projectedRevision;
          return;
        }
        setLegacyInspectorError(true);
        onErrorRef.current();
      } finally {
        if (generation === legacyInspectorLoadGenerationRef.current) {
          requestInFlight.current = false;
          setLegacyInspectorLoading(false);
        }
      }
    },
    [
      actualSessionId,
      enabled,
      revision,
      legacyInspectorLoading,
      legacyInspectorMessages,
      projectId,
      processState,
      selectedBranchId,
    ],
  );

  useEffect(() => {
    if (
      !enabled ||
      revision === undefined ||
      legacyInspectorLoading ||
      legacyInspectorError ||
      processState === "in-turn" ||
      (legacyInspectorMessages && processState !== "idle") ||
      legacyInspectorRevisionRef.current === revision
    ) {
      return;
    }
    void loadLegacyInspectorHistory(true);
  }, [
    enabled,
    revision,
    legacyInspectorLoading,
    legacyInspectorError,
    legacyInspectorMessages,
    loadLegacyInspectorHistory,
    processState,
  ]);

  useEffect(
    () => () => {
      requestInFlight.current = false;
      legacyInspectorLoadGenerationRef.current++;
    },
    [],
  );
  return {
    messages: legacyInspectorMessages,
    loading: enabled && legacyInspectorLoading,
    error: enabled && legacyInspectorError,
    load: loadLegacyInspectorHistory,
  };
}

function isRetryableInspectorHistoryError(error: unknown): boolean {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return (
    code === "SESSION_HISTORY_CURSOR_STALE" ||
    code === "SESSION_HISTORY_CHANGED"
  );
}
