import type { AgentCommandListing } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

/** Providers whose commands/skills Yep can list without a running process. */
const LISTABLE_PROVIDERS = new Set(["codex", "pi", "mcode", "cursor"]);
const REFRESH_THROTTLE_MS = 15_000;

interface Options {
  projectId?: string;
  provider?: string | null;
  /** Live answers come from this session's process when it runs. */
  sessionId?: string;
  /** Changing it refetches (e.g. the session's process started). */
  refreshKey?: string;
  /** Wait before refetching after `refreshKey` changes (ACP lists arrive late). */
  refreshDelayMs?: number;
}

/**
 * Commands and skills for the composer from `GET /agent-commands`: the
 * running process when there is one, else the provider's last report for the
 * project, else a scan of its skill directories. `refresh()` is throttled so
 * it can run whenever the user opens a command menu.
 */
export function useAgentCommandListing({
  projectId,
  provider,
  sessionId,
  refreshKey,
  refreshDelayMs = 0,
}: Options) {
  const [listing, setListing] = useState<AgentCommandListing | null>(null);
  const lastFetchRef = useRef(0);
  const requestRef = useRef(0);
  const enabled = !!projectId && !!provider && LISTABLE_PROVIDERS.has(provider);

  const load = useCallback(async () => {
    if (!enabled || !projectId || !provider) return;
    const request = ++requestRef.current;
    lastFetchRef.current = Date.now();
    try {
      const result = await api.getAgentCommands(projectId, provider, sessionId);
      if (request === requestRef.current) setListing(result);
    } catch {
      // Keep the previous list; the menu falls back to what it already has.
    }
  }, [enabled, projectId, provider, sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey intentionally triggers a refetch.
  useEffect(() => {
    if (!enabled) {
      requestRef.current++;
      setListing(null);
      return;
    }
    const timer = setTimeout(() => void load(), refreshDelayMs);
    return () => clearTimeout(timer);
  }, [enabled, load, refreshKey, refreshDelayMs]);

  // Drop a list that belongs to another provider/project right away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on identity change only.
  useEffect(() => {
    setListing(null);
  }, [projectId, provider]);

  const refresh = useCallback(() => {
    if (Date.now() - lastFetchRef.current < REFRESH_THROTTLE_MS) return;
    void load();
  }, [load]);

  const current = listing && listing.provider === provider ? listing : null;
  return { listing: current, refresh };
}
