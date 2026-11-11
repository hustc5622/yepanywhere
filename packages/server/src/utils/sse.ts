/**
 * Client-side reading of a Server-Sent Events body shared by the runtime and
 * bridge sidecar clients.
 */

/** `data:` payload of one frame, or "" for comment-only frames. */
export function sseFrameData(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

/**
 * Deliver each complete frame (CR stripped). Any bytes, including comment
 * heartbeats, prove liveness: a body that sends nothing for `idleMs` is
 * cancelled and rejected, so a half-open connection to a wedged peer cannot
 * hold a subscriber until the transport's own 300s body timeout.
 */
export async function readSseFrames(
  response: Response,
  signal: AbortSignal,
  onFrame: (frame: string) => void,
  idleMs: number,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  let idle = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idle = true;
      cancel();
    }, idleMs);
    idleTimer.unref?.();
  };
  signal.addEventListener("abort", cancel, { once: true });
  armIdleTimer();
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (idle) throw new Error(`Event stream was silent for ${idleMs}ms`);
      armIdleTimer();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r/g, "");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        onFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
  } finally {
    clearTimeout(idleTimer);
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Fetch a long-lived stream where only the wait for response headers is
 * bounded; the body stays open for as long as `signal` allows.
 */
export async function fetchEventStream(
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit & { signal: AbortSignal },
  connectTimeoutMs: number,
): Promise<Response> {
  const connect = new AbortController();
  const timer = setTimeout(() => connect.abort(), connectTimeoutMs);
  try {
    return await fetchFn(url, {
      ...init,
      signal: AbortSignal.any([init.signal, connect.signal]),
    });
  } catch (error) {
    if (connect.signal.aborted && !init.signal.aborted) {
      throw new Error(
        `${new URL(url).pathname} did not open within ${connectTimeoutMs}ms`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
