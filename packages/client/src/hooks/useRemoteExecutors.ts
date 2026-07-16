import type { RemoteExecutorConfig } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { type RemoteExecutorTestResult, api } from "../api/client";

export function useRemoteExecutors() {
  const [executors, setExecutors] = useState<RemoteExecutorConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const fetched = useRef(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getRemoteExecutors();
      setExecutors(response.executors);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    void refetch();
  }, [refetch]);

  const save = useCallback(async (next: RemoteExecutorConfig[]) => {
    const response = await api.updateRemoteExecutors(next);
    setExecutors(response.executors);
    return response.executors;
  }, []);

  const addExecutor = useCallback(
    async (executor: RemoteExecutorConfig) => {
      const next = [
        ...executors.filter((candidate) => candidate.host !== executor.host),
        executor,
      ];
      await save(next);
    },
    [executors, save],
  );

  const removeExecutor = useCallback(
    async (host: string) => {
      await save(executors.filter((executor) => executor.host !== host));
    },
    [executors, save],
  );

  const testExecutor = useCallback(
    (executor: RemoteExecutorConfig): Promise<RemoteExecutorTestResult> =>
      api.testRemoteExecutor(executor),
    [],
  );

  return {
    executors,
    loading,
    error,
    refetch,
    addExecutor,
    removeExecutor,
    testExecutor,
  };
}
