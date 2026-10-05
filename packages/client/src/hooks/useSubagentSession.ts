import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { AgentSession } from "../types";
import { useDocumentVisibility } from "./useDocumentVisibility";

interface Options {
  projectId: string;
  parentSessionId: string;
  rootSessionId?: string;
  agentId: string;
  enabled: boolean;
}

export interface SubagentSessionError {
  notFound: boolean;
  message: string;
}

interface State {
  scope: string;
  data: AgentSession | null;
  loading: boolean;
  error: SubagentSessionError | null;
}

/** Read a child through its parent and poll only while its detail is visible. */
export function useSubagentSession({
  projectId,
  parentSessionId,
  rootSessionId,
  agentId,
  enabled,
}: Options): Omit<State, "scope"> & { refresh: () => void } {
  const visible = useDocumentVisibility();
  const active = enabled && visible;
  const scope = JSON.stringify([
    projectId,
    parentSessionId,
    rootSessionId,
    agentId,
  ]);
  const [state, setState] = useState<State>({
    scope,
    data: null,
    loading: active,
    error: null,
  });
  const refreshRef = useRef<(() => void) | null>(null);
  // The API does not accept an AbortSignal. Keep retired reads until they
  // settle so reopening the same child cannot start an overlapping request.
  const requestsRef = useRef(new Map<string, Promise<AgentSession>>());

  useEffect(() => {
    if (!active) return;
    let current = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requests = requestsRef.current;

    const read = async () => {
      if (!current || busy) return;
      busy = true;
      clearTimeout(timer);
      setState((previous) => ({
        scope,
        data: previous.scope === scope ? previous.data : null,
        loading: true,
        error: null,
      }));

      let request: Promise<AgentSession> | undefined;
      try {
        const retiredRequest = requests.get(scope);
        if (retiredRequest) {
          // Its result belongs to a closed/hidden generation, so only wait
          // for completion. A fresh read supplies the reopened detail.
          await retiredRequest.catch(() => undefined);
          if (!current) return;
        }
        request =
          rootSessionId !== undefined
            ? api.getAgentSessionInTree(projectId, rootSessionId, agentId)
            : api.getAgentSession(projectId, parentSessionId, agentId);
        requests.set(scope, request);
        const data = await request;
        if (!current) return;
        setState({ scope, data, loading: false, error: null });
        const delay =
          data.status === "completed" || data.status === "failed"
            ? 15_000
            : 3_000;
        timer = setTimeout(() => void read(), delay);
      } catch (cause) {
        if (!current) return;
        const failure = cause as { status?: number; message?: string } | null;
        const error = {
          notFound: failure?.status === 404,
          message: failure?.message ?? "Failed to load subagent session.",
        };
        setState((previous) => ({
          scope,
          data: previous.scope === scope ? previous.data : null,
          loading: false,
          error,
        }));
        // A failed read waits for explicit retry or a visibility/open change.
      } finally {
        if (request && requests.get(scope) === request) requests.delete(scope);
        busy = false;
      }
    };

    const refresh = () => void read();
    refreshRef.current = refresh;
    refresh();
    return () => {
      current = false;
      clearTimeout(timer);
      if (refreshRef.current === refresh) refreshRef.current = null;
    };
  }, [active, scope, projectId, parentSessionId, rootSessionId, agentId]);

  const refresh = useCallback(() => refreshRef.current?.(), []);
  const sameScope = state.scope === scope;
  return {
    data: sameScope ? state.data : null,
    loading: active && (!sameScope || state.loading),
    error: sameScope ? state.error : null,
    refresh,
  };
}
