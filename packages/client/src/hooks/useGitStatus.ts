import type { GitStatusInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

const POLL_INTERVAL_MS = 5000;

export function useGitStatus(projectId: string | undefined) {
  const [state, setState] = useState<{
    projectId: string;
    gitStatus: GitStatusInfo | null;
    loading: boolean;
    error: Error | null;
  } | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const requestIdRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    if (!projectId || projectIdRef.current !== projectId) return;
    const requestId = ++requestIdRef.current;
    const isCurrent = () =>
      requestId === requestIdRef.current && projectIdRef.current === projectId;
    setState((current) => ({
      projectId,
      gitStatus: current?.projectId === projectId ? current.gitStatus : null,
      loading: current?.projectId === projectId ? current.loading : true,
      error: null,
    }));
    try {
      const data = await api.getGitStatus(projectId);
      if (isCurrent())
        setState({ projectId, gitStatus: data, loading: false, error: null });
    } catch (err) {
      if (isCurrent())
        setState((current) => ({
          projectId,
          gitStatus:
            current?.projectId === projectId ? current.gitStatus : null,
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        }));
    }
  }, [projectId]);

  // A slow request finishes before scheduling the next poll. Cleanup also
  // invalidates responses when the panel closes or the project changes.
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || polling || document.visibilityState !== "visible") return;
      polling = true;
      await fetchStatus();
      polling = false;
      if (active && document.visibilityState === "visible")
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    const handleVisibility = () => {
      clearTimeout(timer);
      void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      active = false;
      requestIdRef.current++;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [projectId, fetchStatus]);

  const current = projectId && state?.projectId === projectId ? state : null;
  return {
    gitStatus: current?.gitStatus ?? null,
    loading: current?.loading ?? Boolean(projectId),
    error: current?.error ?? null,
    refetch: fetchStatus,
  };
}
