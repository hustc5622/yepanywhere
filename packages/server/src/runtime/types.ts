import type {
  ContextStatusSdkPayload,
  InputRequest,
  ModelInfo,
  PermissionMode,
  ProviderName,
  RemoteExecutorConfig,
  SlashCommand,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import type { SDKMessage, UserMessage } from "../sdk/types.js";
import type {
  ModelSettings,
  QueueFullResponse,
} from "../supervisor/Supervisor.js";
import type {
  QueuedRequestInfo,
  QueuedResponse,
} from "../supervisor/WorkerQueue.js";
import type { ProcessInfo } from "../supervisor/types.js";
import type { BusEvent } from "../watcher/index.js";

export const RUNTIME_CONTROLLER_PROTOCOL_VERSION = 3;

export type RuntimeMode = "embedded" | "external";

export interface RuntimeStartedProcess {
  id: string;
  sessionId: string;
  provider: ProviderName;
  permissionMode?: PermissionMode;
  modeVersion?: number;
}

export type RuntimeStartResponse =
  | RuntimeStartedProcess
  | QueuedResponse
  | QueueFullResponse;

export type RuntimeQueueMessageResponse =
  | {
      success: true;
      process: Pick<RuntimeStartedProcess, "id">;
      restarted: boolean;
    }
  | { success: false; error: string };

export interface RuntimeWorkerActivity {
  activeWorkers: number;
  queueLength: number;
  hasActiveWork: boolean;
}

export interface RuntimeWorkerPoolStatus {
  activeWorkers: number;
  maxWorkers: number;
  queueLength: number;
}

export interface RuntimeStatus extends RuntimeWorkerActivity {
  mode: RuntimeMode;
  protocolVersion: number;
  processCount: number;
}

/**
 * Serializable live-process state used across the embedded/external boundary.
 * Keep this richer than ProcessInfo: session rendering needs a short replay
 * buffer and the current interaction state even when the web shell is remote.
 */
export interface RuntimeProcessSnapshot extends ProcessInfo {
  permissionMode?: PermissionMode;
  modeVersion: number;
  pendingInputRequest: InputRequest | null;
  messageHistory: SDKMessage[];
  contextWindow?: number;
  supportsDynamicModels: boolean;
  supportsDynamicCommands: boolean;
  supportsSetModel: boolean;
}

export type RuntimeSessionEventEmitter = (
  eventType: string,
  data: unknown,
) => void;

export interface RuntimeSessionSubscriptionOptions {
  replayAfterMessageId?: string;
  afterSeq?: number;
  onError?: (error: unknown) => void;
  logLabel?: string;
  signal?: AbortSignal;
}

export interface RuntimeSessionSubscription {
  cleanup(): void;
}

export type RuntimeActivityEventListener = (event: BusEvent) => void;

export interface RuntimeEventRecord {
  seq: number;
  timestamp: string;
  processId: string;
  sessionId: string;
  type: string;
  data: unknown;
}

export interface RuntimeReplayOptions {
  processId?: string;
  sessionId?: string;
  afterSeq?: number;
}

export interface RuntimeQueueStatus extends RuntimeWorkerPoolStatus {
  queue: QueuedRequestInfo[];
}

export interface StartRuntimeSessionRequest {
  projectPath: string;
  message: UserMessage;
  permissionMode?: PermissionMode;
  modelSettings?: ModelSettings;
}

export interface CreateRuntimeSessionRequest {
  projectPath: string;
  permissionMode?: PermissionMode;
  modelSettings?: ModelSettings;
}

export interface ResumeRuntimeSessionRequest {
  sessionId: string;
  projectPath: string;
  message: UserMessage;
  permissionMode?: PermissionMode;
  modelSettings?: ModelSettings;
}

export interface QueueRuntimeMessageRequest {
  sessionId: string;
  projectPath: string;
  message: UserMessage;
  permissionMode?: PermissionMode;
  modelSettings?: ModelSettings;
}

export interface RuntimeInputResponseRequest {
  sessionId: string;
  requestId: string;
  response: "approve" | "deny";
  answers?: UserQuestionAnswers;
  feedback?: string;
}

export interface RuntimePermissionModeRequest {
  sessionId: string;
  mode: PermissionMode;
}

export interface RuntimeHoldProcessRequest {
  sessionId: string;
  hold: boolean;
}

export interface RuntimeProviderSettings {
  claudeRemoteExecutors?: RemoteExecutorConfig[];
}

export interface RuntimeController {
  readonly mode: RuntimeMode;

  start(): Promise<void>;
  updateProviderSettings(settings: RuntimeProviderSettings): Promise<void>;
  shutdown(options?: { abortActive?: boolean }): Promise<void>;
  getStatus(): Promise<RuntimeStatus>;
  getWorkerActivity(): Promise<RuntimeWorkerActivity>;
  listProcesses(): Promise<ProcessInfo[]>;
  listProcessSnapshots(): Promise<RuntimeProcessSnapshot[]>;
  listRecentlyTerminatedProcesses(): Promise<ProcessInfo[]>;
  getProcess(processId: string): Promise<ProcessInfo | null>;
  getProcessForSession(sessionId: string): Promise<ProcessInfo | null>;
  getProcessSnapshotForSession(
    sessionId: string,
  ): Promise<RuntimeProcessSnapshot | null>;
  wasEverOwned(sessionId: string): Promise<boolean>;

  startSession(
    input: StartRuntimeSessionRequest,
  ): Promise<RuntimeStartResponse>;
  createSession(
    input: CreateRuntimeSessionRequest,
  ): Promise<RuntimeStartResponse>;
  resumeSession(
    input: ResumeRuntimeSessionRequest,
  ): Promise<RuntimeStartResponse>;
  queueMessage(
    input: QueueRuntimeMessageRequest,
  ): Promise<RuntimeQueueMessageResponse>;
  abortProcess(processId: string): Promise<{ aborted: boolean }>;
  interruptProcess(
    processId: string,
  ): Promise<{ success: boolean; supported: boolean }>;

  getQueueStatus(): Promise<RuntimeQueueStatus>;
  getQueuePosition(queueId: string): Promise<number | undefined>;
  cancelQueuedRequest(queueId: string): Promise<{ cancelled: boolean }>;

  getPendingInputRequest(sessionId: string): Promise<InputRequest | null>;
  respondToInput(
    input: RuntimeInputResponseRequest,
  ): Promise<{ accepted: boolean }>;
  setPermissionMode(input: RuntimePermissionModeRequest): Promise<{
    ok: boolean;
    permissionMode?: PermissionMode;
    modeVersion?: number;
  }>;
  setHold(input: RuntimeHoldProcessRequest): Promise<{
    ok: boolean;
    isHeld?: boolean;
    holdSince?: string | null;
    state?: string;
  }>;
  deferMessage(
    sessionId: string,
    message: UserMessage,
  ): Promise<{ queued: boolean }>;
  cancelDeferredMessage(
    sessionId: string,
    tempId: string,
  ): Promise<{ cancelled: boolean }>;

  getSupportedModels(processId: string): Promise<ModelInfo[] | null>;
  getSupportedCommands(processId: string): Promise<SlashCommand[] | null>;
  setModel(processId: string, model?: string): Promise<{ success: boolean }>;
  getContextUsage(sessionId: string): Promise<ContextStatusSdkPayload | null>;
  probeInitializationResult(sessionId: string): Promise<{
    models: Array<{ id: string; contextWindow?: number }>;
  } | null>;

  subscribeSession(
    sessionId: string,
    emit: RuntimeSessionEventEmitter,
    options?: RuntimeSessionSubscriptionOptions,
  ): Promise<RuntimeSessionSubscription | null>;
  subscribeActivity(
    listener: RuntimeActivityEventListener,
    options?: Pick<RuntimeSessionSubscriptionOptions, "onError">,
  ): Promise<RuntimeSessionSubscription | null>;
  replay(options: RuntimeReplayOptions): Promise<RuntimeEventRecord[]>;
}
