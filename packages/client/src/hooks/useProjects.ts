import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { Project } from "../types";
import { type SessionStatusEvent, useFileActivity } from "./useFileActivity";

/**
 * Fetch a single project by ID.
 */
export function useProject(projectId: string | undefined) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const loadedProjectIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!projectId) {
      setProject(null);
      setLoading(false);
      return;
    }

    // Reset when switching projects
    if (loadedProjectIdRef.current !== projectId) {
      setLoading(true);
      setError(null);
      loadedProjectIdRef.current = projectId;
    }

    let cancelled = false;

    api
      .getProject(projectId)
      .then((data) => {
        if (!cancelled) {
          setProject(data.project);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return useMemo(
    () => ({ project, loading, error }),
    [project, loading, error],
  );
}

const REFETCH_DEBOUNCE_MS = 500;

/**
 * Module-level single-flight for `GET /api/projects`.
 *
 * A page typically mounts several `useProjects()` consumers (page shell,
 * project selector, FAB, ...) and every one of them also reacts to session
 * status events. Each instance debounces on its own, so they fire near
 * simultaneously and used to issue one `/api/projects` request each - the
 * server then repeated the whole project + bridge snapshot per request.
 * Sharing the in-flight promise collapses that burst into one request without
 * introducing a stale cache: as soon as it settles the next call refetches.
 *
 * This is only the second line of defence; the server-side fix (bulk bridge
 * snapshots instead of per-session probes) is what bounds the cost per
 * request.
 */
let projectsRequest: Promise<{ projects: Project[] }> | null = null;

function fetchProjectsShared(): Promise<{ projects: Project[] }> {
  if (!projectsRequest) {
    projectsRequest = api.getProjects().finally(() => {
      projectsRequest = null;
    });
  }
  return projectsRequest;
}

export interface UseProjectsOptions {
  /** Skip project fetches while the consuming UI is hidden. */
  enabled?: boolean;
}

export function useProjects(options: UseProjectsOptions = {}) {
  const { enabled = true } = options;
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasFetchedRef = useRef(false);
  const hasResolvedInitialFetchRef = useRef(false);

  const fetch = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }

    // Preserve existing UI during background refetches triggered by activity
    // events so pages don't bounce back to their initial loading state.
    setLoading(!hasResolvedInitialFetchRef.current);
    setError(null);
    try {
      const data = await fetchProjectsShared();
      setProjects(data.projects);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      hasResolvedInitialFetchRef.current = true;
      setLoading(false);
    }
  }, [enabled]);

  // Initial fetch - only once (avoid StrictMode double-fetch)
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    fetch();
  }, [enabled, fetch]);

  // Debounced refetch for status change events
  const debouncedRefetch = useCallback(() => {
    if (!enabled) return;

    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
    }
    refetchTimerRef.current = setTimeout(() => {
      fetch();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetch, enabled]);

  // Handle session status changes - refetch to update active counts
  const handleSessionStatusChange = useCallback(
    (_event: SessionStatusEvent) => {
      debouncedRefetch();
    },
    [debouncedRefetch],
  );

  // Subscribe to session status changes
  useFileActivity(
    enabled
      ? {
          onSessionStatusChange: handleSessionStatusChange,
        }
      : {},
  );

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
      }
    };
  }, []);

  return { projects, loading, error, refetch: fetch };
}
