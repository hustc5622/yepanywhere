import { setTimeout as delay } from "node:timers/promises";
import type {
  ContextStatusSdkPayload,
  InputRequest,
  ModelInfo,
  PermissionMode,
  SlashCommand,
} from "@yep-anywhere/shared";
import type { CodexNativeControlResult } from "../sdk/providers/codex-controls.js";
import type { UserMessage } from "../sdk/types.js";
import type { ProcessInfo } from "../supervisor/types.js";
import { fetchEventStream, readSseFrames, sseFrameData } from "../utils/sse.js";
import type { BusEvent } from "../watcher/index.js";
import { ensureRuntimeToken } from "./token.js";
import {
  RUNTIME_CONTROLLER_PROTOCOL_VERSION,
  RUNTIME_STREAM_IDLE_TIMEOUT_MS,
} from "./types.js";
import type {
  CompactOptions,
  CreateRuntimeSessionRequest,
  QueueRuntimeMessageRequest,
  ResumeRuntimeSessionRequest,
  RuntimeActivityEventListener,
  RuntimeCodexControlRequest,
  RuntimeController,
  RuntimeEventRecord,
  RuntimeHoldProcessRequest,
  RuntimeInputResponseRequest,
  RuntimePermissionModeRequest,
  RuntimeProcessSnapshot,
  RuntimeProviderSettings,
  RuntimeQueueMessageResponse,
  RuntimeQueueStatus,
  RuntimeReplayOptions,
  RuntimeSessionEventEmitter,
  RuntimeSessionStartResponse,
  RuntimeSessionSubscription,
  RuntimeSessionSubscriptionOptions,
  RuntimeStatus,
  RuntimeWorkerActivity,
  StartRuntimeSessionRequest,
} from "./types.js";

export type RuntimeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpRuntimeControllerOptions {
  baseUrl: string;
  token?: string;
  tokenFile?: string;
  fetch?: RuntimeFetch;
  requestTimeoutMs?: number;
  slowRequestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
}

/** "slow" covers calls that may start or authenticate a provider process. */
type RuntimeRequestTimeout = "default" | "slow";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const SLOW_REQUEST_TIMEOUT_MS = 120_000;
/**
 * Model-bound calls stream heartbeats (see `longRunning` in control-server),
 * so a wedged runtime is caught by the stream idle timeout; these deadlines
 * only bound genuinely slow work. Pi compaction may run for 30 minutes after
 * waiting for the current turn.
 */
const COMPACT_DEADLINE_MS = 35 * 60_000;
const MODEL_CONTROL_DEADLINE_MS = 10 * 60_000;

class RuntimeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeHttpError";
  }
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

async function readJsonResult<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new RuntimeHttpError(
      response.status,
      payload?.error ?? `Runtime request failed (${response.status})`,
    );
  }
  return (await response.json()) as T;
}

function deadlineError(method: string, pathname: string, ms: number): Error {
  return new Error(
    `Agent runtime did not finish ${method} ${pathname} within ${ms}ms`,
  );
}

export class HttpRuntimeController implements RuntimeController {
  readonly mode = "external" as const;
  private readonly baseUrl: string;
  private readonly fetchFn: RuntimeFetch;
  private token: string | undefined;
  private readonly tokenFile: string | undefined;
  private readonly subscriptionControllers = new Set<AbortController>();
  private readonly requestTimeoutMs: number;
  private readonly slowRequestTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;

  constructor(options: HttpRuntimeControllerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.slowRequestTimeoutMs =
      options.slowRequestTimeoutMs ?? SLOW_REQUEST_TIMEOUT_MS;
    this.streamIdleTimeoutMs =
      options.streamIdleTimeoutMs ?? RUNTIME_STREAM_IDLE_TIMEOUT_MS;
    this.token = options.token;
    this.tokenFile = options.tokenFile;
    if (!this.token && !this.tokenFile) {
      throw new Error("HttpRuntimeController requires token or tokenFile");
    }
  }

  private fetchStream(
    pathname: string,
    token: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return fetchEventStream(
      this.fetchFn,
      `${this.baseUrl}${pathname}`,
      {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${token}`,
        },
        signal,
      },
      this.requestTimeoutMs,
    );
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    this.token = await ensureRuntimeToken(this.tokenFile as string);
    return this.token;
  }

  private async request<T>(
    pathname: string,
    init: RequestInit = {},
    timeout: RuntimeRequestTimeout = "default",
  ): Promise<T> {
    const token = await this.getToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined)
      headers.set("content-type", "application/json");

    const timeoutMs =
      timeout === "slow" ? this.slowRequestTimeoutMs : this.requestTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

    try {
      const response = await this.fetchFn(`${this.baseUrl}${pathname}`, {
        ...init,
        headers,
        signal,
      });
      return await readJsonResult<T>(response);
    } catch (error) {
      if (timeoutSignal.aborted) {
        throw new Error(
          `Agent runtime did not answer ${init.method ?? "GET"} ${pathname} within ${timeoutMs}ms`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * A model-bound call: the runtime answers at once, heartbeats while the
   * work runs and sends the outcome as the final event. Silence past the
   * stream idle timeout means the runtime is gone; `deadlineMs` bounds the
   * work itself.
   */
  private async requestLongRunning<T>(
    pathname: string,
    init: RequestInit,
    deadlineMs: number,
  ): Promise<T> {
    const token = await this.getToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "text/event-stream");
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    const deadline = AbortSignal.timeout(deadlineMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, deadline])
      : deadline;
    const method = init.method ?? "GET";

    let outcome: { status: number; body: unknown } | undefined;
    try {
      const response = await fetchEventStream(
        this.fetchFn,
        `${this.baseUrl}${pathname}`,
        { ...init, headers, signal },
        this.requestTimeoutMs,
      );
      if (!response.headers.get("content-type")?.includes("text/event-stream"))
        return await readJsonResult<T>(response);
      await readSseFrames(
        response,
        signal,
        (frame) => {
          const data = sseFrameData(frame);
          if (data) outcome = JSON.parse(data) as typeof outcome;
        },
        this.streamIdleTimeoutMs,
      );
    } catch (error) {
      if (deadline.aborted) throw deadlineError(method, pathname, deadlineMs);
      throw error;
    }
    if (deadline.aborted) throw deadlineError(method, pathname, deadlineMs);
    if (!outcome)
      throw new Error(
        `Agent runtime closed ${method} ${pathname} without a result`,
      );
    if (outcome.status >= 400) {
      const error = (outcome.body as { error?: string } | null)?.error;
      throw new RuntimeHttpError(
        outcome.status,
        error ?? `Runtime request failed (${outcome.status})`,
      );
    }
    return outcome.body as T;
  }

  async start(): Promise<void> {
    const status = await this.getStatus();
    if (status.protocolVersion !== RUNTIME_CONTROLLER_PROTOCOL_VERSION) {
      throw new Error(
        `Agent runtime protocol mismatch (shell=${RUNTIME_CONTROLLER_PROTOCOL_VERSION}, runtime=${status.protocolVersion}). Reload the agent runtime before starting the web/API shell.`,
      );
    }
  }

  async updateProviderSettings(
    settings: RuntimeProviderSettings,
  ): Promise<void> {
    await this.request<{ ok: boolean }>("/provider-settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  }

  async shutdown(options: { abortActive?: boolean } = {}): Promise<void> {
    for (const controller of this.subscriptionControllers) controller.abort();
    this.subscriptionControllers.clear();
    if (options.abortActive) {
      await this.request<{ shuttingDown: boolean }>(
        "/shutdown",
        {
          method: "POST",
          body: JSON.stringify({ abortActive: true }),
        },
        "slow",
      );
    }
  }

  async getStatus(): Promise<RuntimeStatus> {
    const status = await this.request<RuntimeStatus>("/status");
    return { ...status, mode: this.mode };
  }

  async getWorkerActivity(): Promise<RuntimeWorkerActivity> {
    return this.request("/workers");
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    const result = await this.request<{ processes: ProcessInfo[] }>(
      "/processes",
    );
    return result.processes;
  }

  async listProcessSnapshots(): Promise<RuntimeProcessSnapshot[]> {
    const result = await this.request<{
      processes: RuntimeProcessSnapshot[];
    }>("/process-snapshots");
    return result.processes;
  }

  async listRecentlyTerminatedProcesses(): Promise<ProcessInfo[]> {
    const result = await this.request<{ processes: ProcessInfo[] }>(
      "/processes/recently-terminated",
    );
    return result.processes;
  }

  async getProcess(processId: string): Promise<ProcessInfo | null> {
    const result = await this.request<{ process: ProcessInfo | null }>(
      `/processes/${encode(processId)}`,
    );
    return result.process;
  }

  async getProcessForSession(sessionId: string): Promise<ProcessInfo | null> {
    const result = await this.request<{ process: ProcessInfo | null }>(
      `/sessions/${encode(sessionId)}/process`,
    );
    return result.process;
  }

  async getProcessSnapshotForSession(
    sessionId: string,
  ): Promise<RuntimeProcessSnapshot | null> {
    const result = await this.request<{
      process: RuntimeProcessSnapshot | null;
    }>(`/sessions/${encode(sessionId)}/snapshot`);
    return result.process;
  }

  async wasEverOwned(sessionId: string): Promise<boolean> {
    const result = await this.request<{ wasEverOwned: boolean }>(
      `/sessions/${encode(sessionId)}/ownership-history`,
    );
    return result.wasEverOwned;
  }

  async startSession(
    input: StartRuntimeSessionRequest,
  ): Promise<RuntimeSessionStartResponse> {
    return this.request(
      "/sessions",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      "slow",
    );
  }

  async createSession(
    input: CreateRuntimeSessionRequest,
  ): Promise<RuntimeSessionStartResponse> {
    return this.request(
      "/sessions",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      "slow",
    );
  }

  async resumeSession(
    input: ResumeRuntimeSessionRequest,
  ): Promise<RuntimeSessionStartResponse> {
    const { sessionId, ...body } = input;
    return this.request(
      `/sessions/${encode(sessionId)}/resume`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      "slow",
    );
  }

  async prepareCursorSession(input: {
    cwd: string;
    model?: string;
    permissionMode?: PermissionMode;
  }): Promise<void> {
    await this.request(
      "/cursor/prepare",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      "slow",
    );
  }

  async discardCursorPrepare(input: {
    cwd: string;
    model?: string;
  }): Promise<void> {
    await this.request("/cursor/prepare/discard", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async warmCursorAuth(input: { cwd: string; model?: string }): Promise<void> {
    await this.request(
      "/cursor/warm",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      "slow",
    );
  }

  async queueMessage(
    input: QueueRuntimeMessageRequest,
  ): Promise<RuntimeQueueMessageResponse> {
    const { sessionId, ...body } = input;
    return this.request(
      `/sessions/${encode(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      "slow",
    );
  }

  async abortProcess(processId: string): Promise<{ aborted: boolean }> {
    return this.request(`/processes/${encode(processId)}/cancel`, {
      method: "POST",
    });
  }

  async interruptProcess(
    processId: string,
  ): Promise<{ success: boolean; supported: boolean }> {
    return this.request(`/processes/${encode(processId)}/interrupt`, {
      method: "POST",
    });
  }

  async getQueueStatus(): Promise<RuntimeQueueStatus> {
    return this.request("/queue");
  }

  async getQueuePosition(queueId: string): Promise<number | undefined> {
    const result = await this.request<{ position?: number }>(
      `/queue/${encode(queueId)}`,
    );
    return result.position;
  }

  async cancelQueuedRequest(queueId: string): Promise<{ cancelled: boolean }> {
    return this.request(`/queue/${encode(queueId)}`, { method: "DELETE" });
  }

  async getPendingInputRequest(
    sessionId: string,
  ): Promise<InputRequest | null> {
    const result = await this.request<{ request: InputRequest | null }>(
      `/sessions/${encode(sessionId)}/pending-input`,
    );
    return result.request;
  }

  async respondToInput(
    input: RuntimeInputResponseRequest,
  ): Promise<{ accepted: boolean }> {
    const { sessionId, ...body } = input;
    return this.request(`/sessions/${encode(sessionId)}/input`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async setPermissionMode(input: RuntimePermissionModeRequest): Promise<{
    ok: boolean;
    permissionMode?: PermissionMode;
    modeVersion?: number;
  }> {
    const { sessionId, ...body } = input;
    return this.request(`/sessions/${encode(sessionId)}/mode`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async sideConversation(
    sessionId: string,
    request: import("@yep-anywhere/shared").SideConversationRequest,
  ): Promise<import("@yep-anywhere/shared").SideConversationResponse> {
    try {
      return await this.requestLongRunning(
        `/sessions/${encode(sessionId)}/side-conversation`,
        { method: "POST", body: JSON.stringify(request) },
        MODEL_CONTROL_DEADLINE_MS,
      );
    } catch (error) {
      if (error instanceof RuntimeHttpError && error.status === 404)
        return { supported: false, reason: "unsupported" };
      throw error;
    }
  }

  async executeCodexControl(
    input: RuntimeCodexControlRequest,
  ): Promise<CodexNativeControlResult> {
    const { sessionId, ...body } = input;
    return this.requestLongRunning<CodexNativeControlResult>(
      `/sessions/${encode(sessionId)}/codex-control`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      MODEL_CONTROL_DEADLINE_MS,
    );
  }

  async setHold(input: RuntimeHoldProcessRequest): Promise<{
    ok: boolean;
    isHeld?: boolean;
    holdSince?: string | null;
    state?: string;
  }> {
    const { sessionId, ...body } = input;
    return this.request(`/sessions/${encode(sessionId)}/hold`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deferMessage(
    sessionId: string,
    message: UserMessage,
  ): Promise<{ queued: boolean }> {
    return this.request(`/sessions/${encode(sessionId)}/deferred`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }

  async cancelDeferredMessage(
    sessionId: string,
    tempId: string,
  ): Promise<{ cancelled: boolean }> {
    return this.request(
      `/sessions/${encode(sessionId)}/deferred/${encode(tempId)}`,
      { method: "DELETE" },
    );
  }

  async getSupportedModels(processId: string): Promise<ModelInfo[] | null> {
    const result = await this.request<{ models: ModelInfo[] | null }>(
      `/processes/${encode(processId)}/models`,
    );
    return result.models;
  }

  async getSupportedCommands(
    processId: string,
  ): Promise<SlashCommand[] | null> {
    const result = await this.request<{ commands: SlashCommand[] | null }>(
      `/processes/${encode(processId)}/commands`,
    );
    return result.commands;
  }

  async setModel(
    processId: string,
    model?: string,
  ): Promise<{ success: boolean }> {
    return this.request(
      `/processes/${encode(processId)}/model`,
      {
        method: "POST",
        body: JSON.stringify({ model }),
      },
      "slow",
    );
  }

  async compact(
    processId: string,
    options?: CompactOptions,
  ): Promise<{ success: boolean }> {
    return this.requestLongRunning(
      `/processes/${encode(processId)}/compact`,
      {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      },
      COMPACT_DEADLINE_MS,
    );
  }

  async setReasoningEffort(
    processId: string,
    effort: string,
  ): Promise<{ success: boolean }> {
    return this.request(
      `/processes/${encode(processId)}/reasoning-effort`,
      {
        method: "POST",
        body: JSON.stringify({ effort }),
      },
      "slow",
    );
  }

  async getGoal(
    processId: string,
  ): Promise<import("@yep-anywhere/shared").ProviderGoalState | null> {
    return this.request(
      `/processes/${encode(processId)}/goal`,
      {
        method: "POST",
        body: JSON.stringify({ action: "show" }),
      },
      "slow",
    );
  }

  async goalAction(
    processId: string,
    action: import("@yep-anywhere/shared").ProviderGoalAction,
    objective?: string,
  ): Promise<import("@yep-anywhere/shared").ProviderGoalState | null> {
    return this.request(
      `/processes/${encode(processId)}/goal`,
      {
        method: "POST",
        body: JSON.stringify({ action, objective }),
      },
      "slow",
    );
  }

  async getContextUsage(
    sessionId: string,
  ): Promise<ContextStatusSdkPayload | null> {
    const result = await this.request<{
      contextUsage: ContextStatusSdkPayload | null;
    }>(`/sessions/${encode(sessionId)}/context-usage`);
    return result.contextUsage;
  }

  async probeInitializationResult(sessionId: string): Promise<{
    models: Array<{ id: string; contextWindow?: number }>;
  } | null> {
    const result = await this.request<{
      result: {
        models: Array<{ id: string; contextWindow?: number }>;
      } | null;
    }>(`/sessions/${encode(sessionId)}/initialization-result`, {
      method: "POST",
    });
    return result.result;
  }

  async subscribeSession(
    sessionId: string,
    emit: RuntimeSessionEventEmitter,
    options?: RuntimeSessionSubscriptionOptions,
  ): Promise<RuntimeSessionSubscription | null> {
    if (options?.signal?.aborted) return null;

    // The runtime, not the replaceable HTTP shell, is authoritative for both
    // live processes and its durable journal. A process preflight here would
    // suppress the finite replay-only subscription after completion.
    const token = await this.getToken();
    if (options?.signal?.aborted) return null;
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    options?.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const query = new URLSearchParams({ sessionId });
    if (options?.replayAfterMessageId) {
      query.set("lastMessageId", options.replayAfterMessageId);
    }
    if (options?.displayProjection) query.set("displayProjection", "true");
    if (options?.afterSeq !== undefined) {
      query.set("afterSeq", String(options.afterSeq));
    }
    let response: Response;
    try {
      response = await this.fetchStream(
        `/events?${query.toString()}`,
        token,
        controller.signal,
      );
    } catch (error) {
      options?.signal?.removeEventListener("abort", abortFromCaller);
      if (controller.signal.aborted) return null;
      throw error;
    }
    if (response.status === 404) {
      options?.signal?.removeEventListener("abort", abortFromCaller);
      controller.abort();
      return null;
    }
    if (!response.ok || !response.body) {
      options?.signal?.removeEventListener("abort", abortFromCaller);
      controller.abort();
      throw new RuntimeHttpError(
        response.status,
        `Runtime event subscription failed (${response.status})`,
      );
    }

    this.subscriptionControllers.add(controller);
    void this.consumeEventStream(response, controller, emit, options).finally(
      () => {
        options?.signal?.removeEventListener("abort", abortFromCaller);
      },
    );
    return {
      cleanup: () => {
        options?.signal?.removeEventListener("abort", abortFromCaller);
        controller.abort();
        this.subscriptionControllers.delete(controller);
      },
    };
  }

  async subscribeActivity(
    listener: RuntimeActivityEventListener,
    options?: Pick<RuntimeSessionSubscriptionOptions, "onError">,
  ): Promise<RuntimeSessionSubscription | null> {
    const controller = new AbortController();
    this.subscriptionControllers.add(controller);
    let response: Response | null;
    try {
      response = await this.openActivityStream(controller);
    } catch (error) {
      this.subscriptionControllers.delete(controller);
      throw error;
    }
    if (!response || controller.signal.aborted) {
      await response?.body?.cancel().catch(() => {});
      this.subscriptionControllers.delete(controller);
      return null;
    }

    void this.followActivityStream(response, controller, listener, options);
    return {
      cleanup: () => {
        controller.abort();
        this.subscriptionControllers.delete(controller);
      },
    };
  }

  private async openActivityStream(
    controller: AbortController,
    reconcile = false,
  ): Promise<Response | null> {
    const token = await this.getToken();
    const response = await this.fetchStream(
      `/activity-events${reconcile ? "?reconcile=true" : ""}`,
      token,
      controller.signal,
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (response.status === 503) return null;
      throw new RuntimeHttpError(
        response.status,
        `Runtime activity subscription failed (${response.status})`,
      );
    }

    return response;
  }

  private async followActivityStream(
    initialResponse: Response,
    controller: AbortController,
    listener: RuntimeActivityEventListener,
    options?: Pick<RuntimeSessionSubscriptionOptions, "onError">,
  ): Promise<void> {
    let response: Response | null = initialResponse;
    let retryDelayMs = 1000;
    try {
      while (!controller.signal.aborted) {
        const connectedAt = Date.now();
        try {
          response ??= await this.openActivityStream(controller, true);
          if (!response) throw new Error("Runtime activity stream unavailable");
          await this.consumeActivityStream(response, controller, listener);
          if (!controller.signal.aborted) {
            throw new Error("Runtime activity stream ended");
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          if (options?.onError) options.onError(error);
          else
            console.warn(
              "[AgentRuntime] Activity stream lost; reconnecting:",
              error,
            );
        }
        response = null;
        if (controller.signal.aborted) break;
        if (Date.now() - connectedAt >= 30_000) retryDelayMs = 1000;
        try {
          await delay(retryDelayMs, undefined, {
            signal: controller.signal,
            ref: false,
          });
        } catch {
          break; // Explicit cleanup/shutdown cancels both reads and retries.
        }
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    } finally {
      this.subscriptionControllers.delete(controller);
    }
  }

  async replay(options: RuntimeReplayOptions): Promise<RuntimeEventRecord[]> {
    const query = new URLSearchParams();
    if (options.processId) query.set("processId", options.processId);
    if (options.sessionId) query.set("sessionId", options.sessionId);
    if (options.allProcesses) query.set("allProcesses", "true");
    if (options.types?.length) query.set("types", options.types.join(","));
    if (options.afterSeq !== undefined) {
      query.set("afterSeq", String(options.afterSeq));
    }
    const result = await this.request<{ events: RuntimeEventRecord[] }>(
      `/replay?${query.toString()}`,
    );
    return result.events;
  }

  private async consumeEventStream(
    response: Response,
    controller: AbortController,
    emit: RuntimeSessionEventEmitter,
    options?: RuntimeSessionSubscriptionOptions,
  ): Promise<void> {
    let completed = false;
    try {
      await readSseFrames(
        response,
        controller.signal,
        (frame) => {
          const data = sseFrameData(frame);
          if (!data) return;
          const event = JSON.parse(data) as {
            eventType: string;
            data: unknown;
          };
          if (event.eventType === "complete") completed = true;
          emit(event.eventType, event.data);
        },
        this.streamIdleTimeoutMs,
      );
      // The runtime only closes a session stream after "complete". Any other
      // end means it restarted or dropped us; subscribers must resubscribe.
      if (!completed && !controller.signal.aborted)
        throw new Error("Runtime event stream ended before the session did");
    } catch (error) {
      if (!controller.signal.aborted) options?.onError?.(error);
    } finally {
      this.subscriptionControllers.delete(controller);
    }
  }

  private async consumeActivityStream(
    response: Response,
    controller: AbortController,
    listener: (event: BusEvent) => void,
  ): Promise<void> {
    await readSseFrames(
      response,
      controller.signal,
      (frame) => {
        const data = sseFrameData(frame);
        if (!data) return;
        const payload = JSON.parse(data) as { event: BusEvent };
        listener(payload.event);
      },
      this.streamIdleTimeoutMs,
    );
  }
}
