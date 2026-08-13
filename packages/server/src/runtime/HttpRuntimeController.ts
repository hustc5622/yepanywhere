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
import type { BusEvent } from "../watcher/index.js";
import { ensureRuntimeToken } from "./token.js";
import { RUNTIME_CONTROLLER_PROTOCOL_VERSION } from "./types.js";
import type {
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
}

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

export class HttpRuntimeController implements RuntimeController {
  readonly mode = "external" as const;
  private readonly baseUrl: string;
  private readonly fetchFn: RuntimeFetch;
  private token: string | undefined;
  private readonly tokenFile: string | undefined;
  private readonly subscriptionControllers = new Set<AbortController>();

  constructor(options: HttpRuntimeControllerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.token = options.token;
    this.tokenFile = options.tokenFile;
    if (!this.token && !this.tokenFile) {
      throw new Error("HttpRuntimeController requires token or tokenFile");
    }
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    this.token = await ensureRuntimeToken(this.tokenFile as string);
    return this.token;
  }

  private async request<T>(
    pathname: string,
    init: RequestInit = {},
  ): Promise<T> {
    const token = await this.getToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined)
      headers.set("content-type", "application/json");

    const response = await this.fetchFn(`${this.baseUrl}${pathname}`, {
      ...init,
      headers,
    });
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
      await this.request<{ shuttingDown: boolean }>("/shutdown", {
        method: "POST",
        body: JSON.stringify({ abortActive: true }),
      });
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
    return this.request("/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createSession(
    input: CreateRuntimeSessionRequest,
  ): Promise<RuntimeSessionStartResponse> {
    return this.request("/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async resumeSession(
    input: ResumeRuntimeSessionRequest,
  ): Promise<RuntimeSessionStartResponse> {
    const { sessionId, ...body } = input;
    return this.request(`/sessions/${encode(sessionId)}/resume`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async queueMessage(
    input: QueueRuntimeMessageRequest,
  ): Promise<RuntimeQueueMessageResponse> {
    const { sessionId, ...body } = input;
    return this.request(`/sessions/${encode(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
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

  async executeCodexControl(
    input: RuntimeCodexControlRequest,
  ): Promise<CodexNativeControlResult> {
    const { sessionId, ...body } = input;
    return this.request<CodexNativeControlResult>(
      `/sessions/${encode(sessionId)}/codex-control`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
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
    return this.request(`/processes/${encode(processId)}/model`, {
      method: "POST",
      body: JSON.stringify({ model }),
    });
  }

  async compact(processId: string): Promise<{ success: boolean }> {
    return this.request(`/processes/${encode(processId)}/compact`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async setReasoningEffort(
    processId: string,
    effort: string,
  ): Promise<{ success: boolean }> {
    return this.request(`/processes/${encode(processId)}/reasoning-effort`, {
      method: "POST",
      body: JSON.stringify({ effort }),
    });
  }

  async getGoal(
    processId: string,
  ): Promise<import("@yep-anywhere/shared").ProviderGoalState | null> {
    return this.request(`/processes/${encode(processId)}/goal`, {
      method: "POST",
      body: JSON.stringify({ action: "show" }),
    });
  }

  async goalAction(
    processId: string,
    action: import("@yep-anywhere/shared").ProviderGoalAction,
    objective?: string,
  ): Promise<import("@yep-anywhere/shared").ProviderGoalState | null> {
    return this.request(`/processes/${encode(processId)}/goal`, {
      method: "POST",
      body: JSON.stringify({ action, objective }),
    });
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
    if (options?.afterSeq !== undefined) {
      query.set("afterSeq", String(options.afterSeq));
    }
    let response: Response;
    try {
      response = await this.fetchFn(
        `${this.baseUrl}/events?${query.toString()}`,
        {
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        },
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
    const token = await this.getToken();
    const controller = new AbortController();
    const response = await this.fetchFn(`${this.baseUrl}/activity-events`, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      if (response.status === 503) return null;
      throw new RuntimeHttpError(
        response.status,
        `Runtime activity subscription failed (${response.status})`,
      );
    }

    this.subscriptionControllers.add(controller);
    void this.consumeActivityStream(response, controller, listener, options);
    return {
      cleanup: () => {
        controller.abort();
        this.subscriptionControllers.delete(controller);
      },
    };
  }

  async replay(options: RuntimeReplayOptions): Promise<RuntimeEventRecord[]> {
    const query = new URLSearchParams();
    if (options.processId) query.set("processId", options.processId);
    if (options.sessionId) query.set("sessionId", options.sessionId);
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
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary).replace(/\r/g, "");
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) {
            const event = JSON.parse(data) as {
              eventType: string;
              data: unknown;
            };
            emit(event.eventType, event.data);
          }
          boundary = buffer.indexOf("\n\n");
        }

        if (done) break;
      }
    } catch (error) {
      if (!controller.signal.aborted) options?.onError?.(error);
    } finally {
      this.subscriptionControllers.delete(controller);
      reader.releaseLock();
    }
  }

  private async consumeActivityStream(
    response: Response,
    controller: AbortController,
    listener: (event: BusEvent) => void,
    options?: Pick<RuntimeSessionSubscriptionOptions, "onError">,
  ): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary).replace(/\r/g, "");
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) {
            const payload = JSON.parse(data) as { event: BusEvent };
            listener(payload.event);
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
    } catch (error) {
      if (!controller.signal.aborted) options?.onError?.(error);
    } finally {
      this.subscriptionControllers.delete(controller);
      reader.releaseLock();
    }
  }
}
