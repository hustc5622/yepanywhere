import { setTimeout as delay } from "node:timers/promises";
import type { BusEvent } from "../watcher/index.js";
import type {
  RuntimeController,
  RuntimeEventRecord,
  RuntimeProviderSettings,
  RuntimeSessionSubscription,
} from "./types.js";

type SessionIdChangedEvent = Extract<BusEvent, { type: "session-id-changed" }>;

export type AttachableRuntime = Pick<
  RuntimeController,
  "start" | "updateProviderSettings" | "subscribeActivity" | "replay"
>;

export interface ExternalRuntimeAttachOptions {
  runtime: AttachableRuntime;
  providerSettings: () => RuntimeProviderSettings;
  /** Applies one runtime activity event; calls arrive in stream order. */
  applyEvent: (event: BusEvent) => Promise<void>;
  /** Publishes the runtime's current workers and processes once attached. */
  onAttached: () => Promise<void>;
  signal?: AbortSignal;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  log?: Pick<Console, "log" | "error">;
}

export const SESSION_ID_REMAP_TYPES = ["session-id-changed"] as const;

export function sessionIdRemapFromRecord(
  record: RuntimeEventRecord,
): SessionIdChangedEvent | null {
  if (record.type !== "session-id-changed") return null;
  const data = record.data as {
    oldSessionId?: unknown;
    newSessionId?: unknown;
    projectId?: unknown;
    executor?: unknown;
  } | null;
  if (
    typeof data?.oldSessionId !== "string" ||
    typeof data.newSessionId !== "string" ||
    typeof data.projectId !== "string"
  ) {
    return null;
  }
  return {
    type: "session-id-changed",
    oldSessionId: data.oldSessionId,
    newSessionId: data.newSessionId,
    projectId: data.projectId as SessionIdChangedEvent["projectId"],
    executor: typeof data.executor === "string" ? data.executor : undefined,
    timestamp: record.timestamp,
  };
}

/**
 * Attach the web/API shell to an external agent runtime, retrying with
 * backoff until it succeeds or `signal` aborts.
 *
 * The shell serves session lists and history without the runtime, so a
 * wedged or restarting runtime must not keep the shell from starting: the
 * caller runs this in the background. Resolves true once attached.
 */
export async function attachExternalRuntime(
  options: ExternalRuntimeAttachOptions,
): Promise<boolean> {
  const log = options.log ?? console;
  const maxDelayMs = options.maxRetryDelayMs ?? 30_000;
  let retryDelayMs = options.initialRetryDelayMs ?? 1_000;
  let subscription: RuntimeSessionSubscription | null = null;

  for (let attempt = 1; !options.signal?.aborted; attempt++) {
    try {
      await options.runtime.start();
      await options.runtime.updateProviderSettings(options.providerSettings());
      subscription ??= await options.runtime.subscribeActivity((event) => {
        void options.applyEvent(event).catch((error) => {
          log.error("[AgentRuntime] Failed to apply runtime event:", error);
        });
      });
      if (!subscription) {
        throw new Error(
          "External agent runtime activity stream is unavailable",
        );
      }

      // Delayed provider IDs can arrive while the web shell is being
      // replaced. The remaps are idempotent, so replaying them after the
      // subscription is open cannot lose or double-apply one.
      const replay = await options.runtime.replay({
        types: SESSION_ID_REMAP_TYPES,
      });
      for (const record of replay) {
        const remap = sessionIdRemapFromRecord(record);
        if (remap) await options.applyEvent(remap);
      }
      await options.onAttached();
      if (attempt > 1)
        log.log(
          `[AgentRuntime] Attached to external runtime (attempt ${attempt})`,
        );
      return true;
    } catch (error) {
      if (options.signal?.aborted) break;
      log.error(
        `[AgentRuntime] External runtime unavailable (attempt ${attempt}); serving without it, retrying in ${retryDelayMs}ms:`,
        error,
      );
    }
    try {
      await delay(retryDelayMs, undefined, {
        signal: options.signal,
        ref: false,
      });
    } catch {
      break;
    }
    retryDelayMs = Math.min(retryDelayMs * 2, maxDelayMs);
  }
  subscription?.cleanup();
  return false;
}
