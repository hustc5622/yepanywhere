export const TURN_IDLE_PROBE_MS = 5 * 60_000;
export const TURN_PROBE_TIMEOUT_MS = 30_000;

export interface TurnLivenessOptions {
  idleMs?: number;
  probeTimeoutMs?: number;
}

const IDLE = Symbol("idle");

function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof IDLE> {
  let timer: NodeJS.Timeout | undefined;
  const idle = new Promise<typeof IDLE>((resolve) => {
    timer = setTimeout(() => resolve(IDLE), ms);
    timer.unref?.();
  });
  return Promise.race([promise, idle]).finally(() => clearTimeout(timer));
}

/**
 * Wait for the next event of an active turn.
 *
 * A quiet tool call can be silent for a long time, so silence alone only
 * triggers a liveness probe. An app-server that also leaves the probe
 * unanswered has stopped serving the turn (for example its stdout writer
 * died); it is closed so the turn fails instead of showing "in turn" forever.
 * `next` is called exactly once, so no event can be lost to the race.
 */
export async function nextTurnEvent<T>(
  next: () => Promise<T>,
  probe: () => Promise<unknown>,
  close: () => void,
  options: TurnLivenessOptions = {},
): Promise<T> {
  const idleMs = options.idleMs ?? TURN_IDLE_PROBE_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? TURN_PROBE_TIMEOUT_MS;
  const pending = next();
  for (;;) {
    const event = await within(pending, idleMs);
    if (event !== IDLE) return event;
    let answered: boolean;
    try {
      answered = (await within(probe(), probeTimeoutMs)) !== IDLE;
    } catch {
      // A rejected probe is still an answer from a live server.
      answered = true;
    }
    if (answered) continue;
    close();
    await pending.catch(() => {});
    throw new Error(
      `Codex app-server stopped responding during a turn: no event for ${idleMs}ms and no answer to a liveness probe within ${probeTimeoutMs}ms`,
    );
  }
}
