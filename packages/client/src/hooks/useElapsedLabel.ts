import { useEffect, useState } from "react";
import { formatElapsed, parseStartedAt } from "../lib/formatElapsed";

// One shared 1s ticker for every running step on screen, so N live tools cost
// one interval instead of N. The interval only exists while someone listens.
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!ticker) {
    ticker = setInterval(() => {
      if (document.hidden) return;
      for (const fn of listeners) fn();
    }, 1_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

export interface ElapsedLabel {
  /** Compact duration such as `3m12s`, refreshed once per second. */
  label: string;
  /** Epoch milliseconds the step started, for absolute-time tooltips. */
  startedAt: number;
}

/**
 * Live "running for" label derived from a server-side start timestamp.
 *
 * Returns `null` when inactive or when the timestamp is missing/unparseable,
 * so callers can simply omit the badge. Ticks pause while the tab is hidden
 * and catch up on the next visible tick.
 */
export function useElapsedLabel(
  timestamp: string | undefined,
  active: boolean,
): ElapsedLabel | null {
  const startedAt = active ? parseStartedAt(timestamp) : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const refresh = () => setNow(Date.now());
    const unsubscribe = subscribe(refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [startedAt]);
  if (startedAt === null) return null;
  return { label: formatElapsed(now - startedAt), startedAt };
}
