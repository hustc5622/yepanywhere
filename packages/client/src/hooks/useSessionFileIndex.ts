import type { SessionFileActivityIndex } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

interface UseSessionFileIndexOptions {
  /** Only fetch while the inspector panel is actually visible. */
  enabled?: boolean;
  branchId?: string;
  /** Bump to refetch (e.g. message count changed). */
  revision?: string | number;
}

/**
 * Server-derived index of files touched by a session.
 *
 * This replaces deriving file activity from whatever slice of the transcript
 * the client happens to have loaded: the server scans the whole session.
 */
export function useSessionFileIndex(
  projectId: string | undefined,
  sessionId: string | undefined,
  { enabled = true, branchId, revision }: UseSessionFileIndexOptions = {},
) {
  const [index, setIndex] = useState<SessionFileActivityIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetchIndex = useCallback(async () => {
    if (!enabled || !projectId || !sessionId) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const data = await api.getSessionFileIndex(projectId, sessionId, {
        ...(branchId ? { branchId } : {}),
      });
      if (requestId !== requestIdRef.current) return;
      setIndex(data);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [branchId, enabled, projectId, sessionId]);

  // Reset when the target session changes so a stale index is never shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on session identity
  useEffect(() => {
    setIndex(null);
    setError(null);
  }, [projectId, sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is an explicit refetch trigger
  useEffect(() => {
    void fetchIndex();
  }, [fetchIndex, revision]);
  return { index, loading, error, refetch: fetchIndex };
}
