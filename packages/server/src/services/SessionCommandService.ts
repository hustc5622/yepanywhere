import {
  ALL_CODEX_MCP_MODES,
  ALL_PERMISSION_MODES,
  type CodexMcpMode,
  type OpenCodeJsonObject,
  type OpenCodeModelCapabilities,
  type OpenCodeModelLimits,
  type OpenCodeRequestProtocol,
  type OpenCodeSessionConfig,
  type PermissionRules,
  type ProviderName,
  type ThinkingOption,
  type UploadedFile,
  isUrlProjectId,
  thinkingOptionToConfig,
} from "@yep-anywhere/shared";
import type {
  RespondToInputOptions,
  SessionInputResponseBody,
  SessionInteractionService,
} from "../interactions/SessionInteractionService.js";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/index.js";
import { encodeProjectId, resolveStartCwd } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { resolveSessionModel } from "../routes/session-model.js";
import type {
  RuntimeController,
  RuntimeProcessSnapshot,
  RuntimeSessionEventEmitter,
  RuntimeSessionStartResponse,
  RuntimeSessionSubscription,
  RuntimeSessionSubscriptionOptions,
  RuntimeStartedProcess,
} from "../runtime/types.js";
import type {
  CodexNativeControlRequest,
  CodexNativeControlResult,
} from "../sdk/providers/codex-controls.js";
import {
  CodexModelSourceError,
  getCodexModelSourceRegistry,
} from "../sdk/providers/codex-model-sources.js";
import type {
  CodexStructuredUserInput,
  PermissionMode,
  UserMessage,
} from "../sdk/types.js";
import type {
  ImmediateStartUnavailableResponse,
  QueueFullResponse,
} from "../supervisor/Supervisor.js";
import type { QueuedResponse } from "../supervisor/WorkerQueue.js";
import type { Project } from "../supervisor/types.js";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";
import type { EventBus } from "../watcher/index.js";
import type { ModelInfoService } from "./ModelInfoService.js";
import type { ServerSettingsService } from "./ServerSettingsService.js";

export interface SessionCommandServiceDeps {
  runtimeController: RuntimeController;
  scanner: ProjectScanner;
  /** Sole pending-input/CAS authority shared by HTTP and channel adapters. */
  sessionInteractionService: SessionInteractionService;
  /** Persists permission mode when no resident process exists. */
  sessionMetadataService?: SessionMetadataService;
  eventBus?: EventBus;
  serverSettingsService?: ServerSettingsService;
  modelInfoService?: ModelInfoService;
}

export interface StartSessionCommandInput {
  projectId: string;
  body: StartSessionBody;
  /** Reject atomically before worker-queue admission when an ID is needed now. */
  requireImmediate?: boolean;
}

export interface CreateSessionCommandInput {
  projectId: string;
  body?: CreateSessionBody;
  /** Reject atomically when a create-only session cannot start immediately. */
  requireImmediate?: boolean;
}

export interface StartSessionBody {
  message: string;
  images?: string[];
  documents?: string[];
  attachments?: UploadedFile[];
  /** Ordered native Codex skill/mention input items. */
  codexInputs?: CodexStructuredUserInput[];
  mode?: PermissionMode;
  model?: string;
  thinking?: ThinkingOption;
  /** Exact provider reasoning effort / OpenCode model variant. */
  reasoningEffort?: string;
  provider?: ProviderName;
  /** Codex MCP profile. Only used when provider resolves to Codex. */
  codexMcpMode?: CodexMcpMode;
  /** Codex model source (Codex `model_provider`). Only used for Codex. */
  codexModelProvider?: string;
  /** OpenCode-only managed provider/model configuration. */
  opencodeConfig?: OpenCodeSessionConfig;
  /** Client-generated temp ID for optimistic UI tracking. */
  tempId?: string;
  /** SSH host alias for remote execution (undefined = local). */
  executor?: string;
  /** Permission rules for tool filtering (deny/allow patterns). */
  permissions?: PermissionRules;
  resumeSessionAt?: string;
  rollbackNumTurns?: number;
  rollbackTarget?: {
    timestamp?: string;
    text?: string;
  };
}

export interface CreateSessionBody {
  mode?: PermissionMode;
  model?: string;
  thinking?: ThinkingOption;
  reasoningEffort?: string;
  provider?: ProviderName;
  codexMcpMode?: CodexMcpMode;
  codexModelProvider?: string;
  opencodeConfig?: OpenCodeSessionConfig;
  executor?: string;
  permissions?: PermissionRules;
}

export interface ExecuteCodexControlCommandInput {
  sessionId: string;
  request: CodexNativeControlRequest;
}

export type SessionCommandStatus =
  | 200
  | 202
  | 400
  | 404
  | 409
  | 410
  | 502
  | 503;

export type SessionCommandResult<T extends Record<string, unknown>> =
  | { ok: true; status: 200 | 202; body: T }
  | {
      ok: false;
      status: Exclude<SessionCommandStatus, 200 | 202>;
      body: { error: string } & Record<string, unknown>;
    };

function commandSuccess<T extends Record<string, unknown>>(
  body: T,
  status: 200 | 202 = 200,
): SessionCommandResult<T> {
  return { ok: true, status, body };
}

function commandFailure(
  error: string,
  status: Exclude<SessionCommandStatus, 200 | 202>,
  details: Record<string, unknown> = {},
): SessionCommandResult<never> {
  return { ok: false, status, body: { error, ...details } };
}

function isQueuedResponse(
  result: RuntimeSessionStartResponse,
): result is QueuedResponse {
  return "queued" in result && result.queued === true;
}

function isQueueFullResponse(
  result: RuntimeSessionStartResponse,
): result is QueueFullResponse {
  return "error" in result && result.error === "queue_full";
}

function isImmediateStartUnavailableResponse(
  result: RuntimeSessionStartResponse,
): result is ImmediateStartUnavailableResponse {
  return "error" in result && result.error === "immediate_start_unavailable";
}

function isStartedResponse(
  result: RuntimeSessionStartResponse,
): result is RuntimeStartedProcess {
  return "id" in result && "sessionId" in result;
}

function parseOptionalExecutor(rawExecutor: unknown): {
  executor: string | undefined;
  error?: string;
} {
  if (rawExecutor === undefined || rawExecutor === null) {
    return { executor: undefined };
  }
  if (typeof rawExecutor !== "string") {
    return { executor: undefined, error: "executor must be a string" };
  }

  const executor = normalizeSshHostAlias(rawExecutor);
  if (!executor) return { executor: undefined };
  if (!isValidSshHostAlias(executor)) {
    return {
      executor: undefined,
      error: "executor must be a valid SSH host alias",
    };
  }
  return { executor };
}

function parseOptionalCodexMcpMode(rawMode: unknown): {
  codexMcpMode: CodexMcpMode | undefined;
  error?: string;
} {
  if (rawMode === undefined || rawMode === null || rawMode === "") {
    return { codexMcpMode: undefined };
  }
  if (
    typeof rawMode === "string" &&
    ALL_CODEX_MCP_MODES.includes(rawMode as CodexMcpMode)
  ) {
    return { codexMcpMode: rawMode as CodexMcpMode };
  }
  return { codexMcpMode: undefined, error: "codexMcpMode is invalid" };
}

function resolveCodexModelProviderForStart(
  provider: ProviderName | undefined,
  codexModelProvider: string | undefined,
  model: string | undefined,
): { value?: string; error?: string; code?: string } {
  if (provider !== "codex") return { value: undefined };
  const registry = getCodexModelSourceRegistry();
  const sourceId = codexModelProvider?.trim() || "openai";
  try {
    const source = registry.require(sourceId);
    registry.assertModelSelectable(source.id, model);
    return { value: source.id };
  } catch (error) {
    if (error instanceof CodexModelSourceError) {
      return { error: error.message, code: error.code };
    }
    throw error;
  }
}

function parseOptionalPositiveInteger(
  value: unknown,
  fieldName: string,
): { value: number | undefined; error?: string } {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { value: undefined, error: `${fieldName} must be a number` };
  }
  if (!Number.isInteger(value) || value < 1) {
    return {
      value: undefined,
      error: `${fieldName} must be a positive integer`,
    };
  }
  return { value };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateOptionalCodexInputs(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return "codexInputs must be an array";
  if (value.length > 64) return "codexInputs must contain at most 64 items";

  for (let index = 0; index < value.length; index += 1) {
    const input = value[index];
    if (!isPlainObject(input)) {
      return `codexInputs[${index}] must be an object`;
    }
    if (input.type !== "skill" && input.type !== "mention") {
      return `codexInputs[${index}].type must be skill or mention`;
    }
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      return `codexInputs[${index}].name must be a non-empty string`;
    }
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      return `codexInputs[${index}].path must be a non-empty string`;
    }
    if (input.name.length > 256 || input.path.length > 8_192) {
      return `codexInputs[${index}] exceeds the supported size`;
    }
  }
  return undefined;
}

function parseOpenCodeModelLimits(rawLimits: unknown): {
  limits: OpenCodeModelLimits | undefined;
  error?: string;
} {
  if (rawLimits === undefined || rawLimits === null || rawLimits === "") {
    return { limits: undefined };
  }
  if (!isPlainObject(rawLimits)) {
    return {
      limits: undefined,
      error: "opencodeConfig.limits must be an object",
    };
  }

  const hasContext =
    rawLimits.context !== undefined && rawLimits.context !== null;
  const hasOutput = rawLimits.output !== undefined && rawLimits.output !== null;
  if (!hasContext && !hasOutput) return { limits: undefined };
  if (!hasContext || !hasOutput) {
    return {
      limits: undefined,
      error: "opencodeConfig.limits requires both context and output",
    };
  }

  const context = parseOptionalPositiveInteger(
    rawLimits.context,
    "opencodeConfig.limits.context",
  );
  if (context.error) return { limits: undefined, error: context.error };
  const output = parseOptionalPositiveInteger(
    rawLimits.output,
    "opencodeConfig.limits.output",
  );
  if (output.error) return { limits: undefined, error: output.error };
  if (context.value === undefined || output.value === undefined) {
    return {
      limits: undefined,
      error: "opencodeConfig.limits requires both context and output",
    };
  }
  const input = parseOptionalPositiveInteger(
    rawLimits.input,
    "opencodeConfig.limits.input",
  );
  if (input.error) return { limits: undefined, error: input.error };
  return {
    limits: {
      context: context.value,
      ...(input.value === undefined ? {} : { input: input.value }),
      output: output.value,
    },
  };
}

function validateOpenCodeJson(
  value: unknown,
  fieldName: string,
  depth = 0,
): string | undefined {
  if (depth > 12) return `${fieldName} is nested too deeply`;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : `${fieldName} must be JSON`;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateOpenCodeJson(
        value[index],
        `${fieldName}[${index}]`,
        depth + 1,
      );
      if (error) return error;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return `${fieldName} must be JSON`;
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      return `${fieldName} contains a reserved key`;
    }
    const error = validateOpenCodeJson(item, `${fieldName}.${key}`, depth + 1);
    if (error) return error;
  }
  return undefined;
}

function parseOpenCodeAdvancedObject(
  value: unknown,
  fieldName: string,
): { value?: OpenCodeJsonObject; error?: string } {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) return { error: `${fieldName} must be an object` };
  const error = validateOpenCodeJson(value, fieldName);
  if (error) return { error };
  if (JSON.stringify(value).length > 65_536) {
    return { error: `${fieldName} is too large` };
  }
  return { value: value as OpenCodeJsonObject };
}

function parseOptionalOpenCodeConfig(raw: unknown): {
  opencodeConfig: OpenCodeSessionConfig | undefined;
  error?: string;
} {
  if (raw === undefined || raw === null || raw === "") {
    return { opencodeConfig: undefined };
  }
  if (!isPlainObject(raw)) {
    return {
      opencodeConfig: undefined,
      error: "opencodeConfig must be an object",
    };
  }
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (
    !model ||
    model.length > 512 ||
    model === "__proto__" ||
    model === "prototype" ||
    model === "constructor" ||
    Array.from(model).some((character) => character.charCodeAt(0) < 32)
  ) {
    return {
      opencodeConfig: undefined,
      error: "opencodeConfig.model must be a valid model ID",
    };
  }
  const requestProtocol = raw.requestProtocol;
  if (
    requestProtocol !== "openai-compatible" &&
    requestProtocol !== "anthropic"
  ) {
    return {
      opencodeConfig: undefined,
      error: "opencodeConfig.requestProtocol is invalid",
    };
  }
  const parsedLimits = parseOpenCodeModelLimits(raw.limits);
  if (parsedLimits.error) {
    return { opencodeConfig: undefined, error: parsedLimits.error };
  }

  let capabilities: OpenCodeModelCapabilities | undefined;
  if (raw.capabilities !== undefined && raw.capabilities !== null) {
    if (!isPlainObject(raw.capabilities)) {
      return {
        opencodeConfig: undefined,
        error: "opencodeConfig.capabilities must be an object",
      };
    }
    capabilities = {};
    for (const key of [
      "attachment",
      "reasoning",
      "temperature",
      "toolCall",
    ] as const) {
      const value = raw.capabilities[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") {
        return {
          opencodeConfig: undefined,
          error: `opencodeConfig.capabilities.${key} must be a boolean`,
        };
      }
      capabilities[key] = value;
    }
  }

  let advanced: OpenCodeSessionConfig["advanced"];
  if (raw.advanced !== undefined && raw.advanced !== null) {
    if (!isPlainObject(raw.advanced)) {
      return {
        opencodeConfig: undefined,
        error: "opencodeConfig.advanced must be an object",
      };
    }
    const provider = parseOpenCodeAdvancedObject(
      raw.advanced.provider,
      "opencodeConfig.advanced.provider",
    );
    if (provider.error) {
      return { opencodeConfig: undefined, error: provider.error };
    }
    const modelPatch = parseOpenCodeAdvancedObject(
      raw.advanced.model,
      "opencodeConfig.advanced.model",
    );
    if (modelPatch.error) {
      return { opencodeConfig: undefined, error: modelPatch.error };
    }
    if (provider.value || modelPatch.value) {
      advanced = { provider: provider.value, model: modelPatch.value };
    }
  }

  let name: string | undefined;
  if (raw.name !== undefined && raw.name !== null && raw.name !== "") {
    if (typeof raw.name !== "string" || raw.name.trim().length > 200) {
      return {
        opencodeConfig: undefined,
        error: "opencodeConfig.name must be a string up to 200 characters",
      };
    }
    name = raw.name.trim();
  }
  return {
    opencodeConfig: {
      model,
      requestProtocol: requestProtocol as OpenCodeRequestProtocol,
      ...(name ? { name } : {}),
      ...(parsedLimits.limits ? { limits: parsedLimits.limits } : {}),
      ...(capabilities && Object.keys(capabilities).length > 0
        ? { capabilities }
        : {}),
      ...(advanced ? { advanced } : {}),
    },
  };
}

function parseOptionalReasoningEffort(rawEffort: unknown): {
  reasoningEffort?: string;
  error?: string;
} {
  if (rawEffort === undefined || rawEffort === null || rawEffort === "") {
    return {};
  }
  if (typeof rawEffort !== "string") {
    return { error: "reasoningEffort must be a string" };
  }
  const reasoningEffort = rawEffort.trim();
  if (
    reasoningEffort.length === 0 ||
    reasoningEffort.length > 64 ||
    Array.from(reasoningEffort).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return { error: "Invalid reasoningEffort" };
  }
  return { reasoningEffort };
}

function normalizeReasoningEffortForProvider(
  provider: ProviderName | undefined,
  reasoningEffort: string | undefined,
): string | undefined {
  return provider === "opencode" && reasoningEffort === "default"
    ? undefined
    : reasoningEffort;
}

/**
 * Provider-neutral application boundary for session commands.
 *
 * Pending-input operations deliberately delegate to SessionInteractionService
 * so every caller shares one durable broker and one provider-resolution path.
 */
export class SessionCommandService {
  constructor(private readonly deps: SessionCommandServiceDeps) {}

  async start(
    input: StartSessionCommandInput,
  ): Promise<SessionCommandResult<Record<string, unknown>>> {
    const { projectId, body } = input;
    if (!isUrlProjectId(projectId)) {
      return commandFailure("Invalid project ID format", 400);
    }

    let project = await this.deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return commandFailure("Project not found or path does not exist", 404);
    }

    const recoverySessionDir = project.sessionDir;
    const recoveredCwd = await resolveStartCwd(
      project.path,
      recoverySessionDir,
      (cwd) => this.deps.scanner.mapSessionCwdToLocal(cwd, recoverySessionDir),
    );
    if (recoveredCwd) {
      const recoveredId = encodeProjectId(recoveredCwd);
      const fresh = await this.deps.scanner.getOrCreateProject(recoveredId);
      if (!fresh) {
        return commandFailure(
          `Project directory ${project.path} no longer exists and recovered path ${recoveredCwd} is also invalid`,
          404,
        );
      }
      console.warn(
        `[startSession] Stale projectId: ${project.path} no longer exists; recovered cwd=${recoveredCwd}`,
      );
      project = fresh;
    }

    if (!body.message) {
      return commandFailure("Message is required", 400);
    }
    const codexInputsError = validateOptionalCodexInputs(body.codexInputs);
    if (codexInputsError) return commandFailure(codexInputsError, 400);

    const prepared = this.prepareNewSession(project, body);
    if (!prepared.ok) return prepared.result;

    console.log("[startSession] Request body:", {
      provider: body.provider,
      executor: prepared.executor,
      model: body.model,
      opencodeConfig: prepared.opencodeConfig
        ? {
            model: prepared.opencodeConfig.model,
            requestProtocol: prepared.opencodeConfig.requestProtocol,
            limits: prepared.opencodeConfig.limits,
          }
        : undefined,
    });

    const result = await this.deps.runtimeController.startSession({
      projectPath: project.path,
      message: this.toUserMessage(body),
      permissionMode: body.mode,
      modelSettings: prepared.modelSettings,
      requireImmediate: input.requireImmediate,
    });
    const admissionFailure = this.mapAdmissionFailure(result);
    if (admissionFailure) return admissionFailure;
    if (isQueuedResponse(result)) {
      return commandSuccess(result as unknown as Record<string, unknown>, 202);
    }
    if (!isStartedResponse(result)) {
      return commandFailure("Session could not start", 503);
    }

    this.recordOpenCodeContextWindowOverride({
      provider: result.provider,
      model: prepared.opencodeConfig?.model ?? prepared.model,
      sessionId: result.sessionId,
      limits: prepared.opencodeConfig?.limits,
    });
    await this.persistNewSessionMetadata(result, prepared, body.provider);
    await this.recordYepSessionOrigin(result.sessionId, project);

    return commandSuccess({
      sessionId: result.sessionId,
      processId: result.id,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
    });
  }

  async create(
    input: CreateSessionCommandInput,
  ): Promise<SessionCommandResult<Record<string, unknown>>> {
    const { projectId } = input;
    const body = input.body ?? {};
    if (!isUrlProjectId(projectId)) {
      return commandFailure("Invalid project ID format", 400);
    }

    const project = await this.deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return commandFailure("Project not found or path does not exist", 404);
    }

    const prepared = this.prepareNewSession(project, body);
    if (!prepared.ok) return prepared.result;

    const result = await this.deps.runtimeController.createSession({
      projectPath: project.path,
      permissionMode: body.mode,
      modelSettings: prepared.modelSettings,
      requireImmediate: input.requireImmediate,
    });
    const admissionFailure = this.mapAdmissionFailure(result);
    if (admissionFailure) return admissionFailure;
    if (isQueuedResponse(result)) {
      return commandSuccess(result as unknown as Record<string, unknown>, 202);
    }
    if (!isStartedResponse(result)) {
      return commandFailure("Session could not start", 503);
    }

    this.recordOpenCodeContextWindowOverride({
      provider: result.provider,
      model: prepared.opencodeConfig?.model ?? prepared.model,
      sessionId: result.sessionId,
      limits: prepared.opencodeConfig?.limits,
    });
    await this.persistNewSessionMetadata(result, prepared, body.provider, true);
    await this.recordYepSessionOrigin(result.sessionId, project);

    return commandSuccess({
      sessionId: result.sessionId,
      processId: result.id,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
    });
  }

  async interrupt(
    sessionId: string,
  ): Promise<SessionCommandResult<Record<string, unknown>>> {
    const process =
      await this.deps.runtimeController.getProcessSnapshotForSession(sessionId);
    if (!process) {
      return commandFailure("No active process for session", 404);
    }

    const result = await this.deps.runtimeController.interruptProcess(
      process.id,
    );
    if (!result.success && !result.supported) {
      return commandFailure("Interrupt not supported for this process", 400);
    }
    if (result.success) {
      await this.terminateInteractionAliases(sessionId, process);
    }
    return commandSuccess({
      interrupted: result.success,
      supported: result.supported,
      processId: process.id,
    });
  }

  /** Release runtime ownership without deleting persisted provider history. */
  async releaseSession(
    sessionId: string,
  ): Promise<SessionCommandResult<Record<string, unknown>>> {
    const process =
      await this.deps.runtimeController.getProcessSnapshotForSession(sessionId);
    if (!process) {
      await this.deps.sessionInteractionService.terminateInteractionOperations(
        sessionId,
        "interrupt",
      );
      return commandSuccess({ released: true, hadProcess: false });
    }

    const result = await this.deps.runtimeController.abortProcess(process.id);
    if (!result.aborted) {
      const remaining =
        await this.deps.runtimeController.getProcessSnapshotForSession(
          sessionId,
        );
      if (remaining) {
        return commandFailure("Session process could not be released", 409, {
          code: "session_release_failed",
        });
      }
    }

    await this.terminateInteractionAliases(sessionId, process);
    return commandSuccess({
      released: true,
      hadProcess: true,
      processId: process.id,
    });
  }

  async executeCodexControl(input: ExecuteCodexControlCommandInput): Promise<
    SessionCommandResult<{
      control: CodexNativeControlResult["control"];
      data: unknown;
    }>
  > {
    const snapshot =
      await this.deps.runtimeController.getProcessSnapshotForSession(
        input.sessionId,
      );
    if (!snapshot) {
      return commandFailure("No active process for session", 404);
    }
    if (snapshot.provider !== "codex") {
      return commandFailure("Session is not backed by Codex app-server", 400, {
        code: "unsupported_provider",
        control: input.request.control,
      });
    }

    const result = await this.deps.runtimeController.executeCodexControl(input);
    if (result.ok) {
      return commandSuccess({ control: result.control, data: result.data });
    }

    const status =
      result.error.code === "provider_error"
        ? 502
        : result.error.code === "not_ready"
          ? 410
          : 400;
    return commandFailure(result.error.message, status, {
      code: result.error.code,
      control: result.control,
      retryable: result.error.retryable,
    });
  }

  getSessionSnapshot(
    sessionId: string,
  ): Promise<RuntimeProcessSnapshot | null> {
    return this.deps.runtimeController.getProcessSnapshotForSession(sessionId);
  }

  getRuntimeStatus() {
    return this.deps.runtimeController.getStatus();
  }

  async setPermissionMode(
    sessionId: string,
    mode: PermissionMode,
  ): Promise<SessionCommandResult<Record<string, unknown>>> {
    if (!mode) return commandFailure("mode is required", 400);

    try {
      const result = await this.deps.runtimeController.setPermissionMode({
        sessionId,
        mode,
      });
      if (!result.ok) {
        if (!this.deps.sessionMetadataService) {
          return commandFailure("No active process for session", 404);
        }
        await this.deps.sessionMetadataService.setPermissionMode(
          sessionId,
          mode,
        );
        return commandSuccess({ permissionMode: mode, modeVersion: 0 });
      }

      const confirmedMode = result.permissionMode ?? mode;
      await this.deps.sessionMetadataService?.setPermissionMode(
        sessionId,
        confirmedMode,
      );
      return commandSuccess({
        permissionMode: confirmedMode,
        modeVersion: result.modeVersion ?? 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().warn(
        {
          event: "session_permission_mode_sync_failed",
          sessionId,
          mode,
          error: message,
        },
        "Provider rejected the permission mode change",
      );
      return commandFailure(`Failed to apply permission mode: ${message}`, 502);
    }
  }

  getPendingInput(
    sessionId: string,
    options?: { processSnapshot: RuntimeProcessSnapshot | null },
  ) {
    return this.deps.sessionInteractionService.getPendingInput(
      sessionId,
      options,
    );
  }

  respondToInput(
    sessionId: string,
    body: SessionInputResponseBody,
    options?: RespondToInputOptions,
  ) {
    return this.deps.sessionInteractionService.respondToInput(
      sessionId,
      body,
      options,
    );
  }

  terminateInteractionOperations(
    sessionId: string,
    reason: Parameters<
      SessionInteractionService["terminateInteractionOperations"]
    >[1],
    keepRequestId?: string,
  ) {
    return this.deps.sessionInteractionService.terminateInteractionOperations(
      sessionId,
      reason,
      keepRequestId,
    );
  }

  getInteractionOperation(operationId: string) {
    return this.deps.sessionInteractionService.getInteractionOperation(
      operationId,
    );
  }

  getInteractionOperations(sessionId: string) {
    return this.deps.sessionInteractionService.getInteractionOperations(
      sessionId,
    );
  }

  getInteractionBroker() {
    return this.deps.sessionInteractionService.getInteractionBroker();
  }

  subscribe(
    sessionId: string,
    emit: RuntimeSessionEventEmitter,
    options?: RuntimeSessionSubscriptionOptions,
  ): Promise<RuntimeSessionSubscription | null> {
    return this.deps.runtimeController.subscribeSession(
      sessionId,
      emit,
      options,
    );
  }

  private prepareNewSession(
    project: Project,
    body: CreateSessionBody | StartSessionBody,
  ):
    | {
        ok: true;
        executor?: string;
        model?: string;
        opencodeConfig?: OpenCodeSessionConfig;
        codexMcpMode?: CodexMcpMode;
        codexModelProvider?: string;
        modelSettings: Parameters<
          RuntimeController["createSession"]
        >[0]["modelSettings"];
      }
    | { ok: false; result: SessionCommandResult<never> } {
    if (body.mode !== undefined && !this.isPermissionMode(body.mode)) {
      return {
        ok: false,
        result: commandFailure("Invalid permission mode", 400),
      };
    }
    const parsedExecutor = parseOptionalExecutor(body.executor);
    if (parsedExecutor.error) {
      return { ok: false, result: commandFailure(parsedExecutor.error, 400) };
    }
    const parsedCodexMcpMode = parseOptionalCodexMcpMode(body.codexMcpMode);
    if (parsedCodexMcpMode.error) {
      return {
        ok: false,
        result: commandFailure(parsedCodexMcpMode.error, 400),
      };
    }
    const parsedOpenCodeConfig = parseOptionalOpenCodeConfig(
      body.opencodeConfig,
    );
    if (parsedOpenCodeConfig.error) {
      return {
        ok: false,
        result: commandFailure(parsedOpenCodeConfig.error, 400),
      };
    }
    const parsedReasoningEffort = parseOptionalReasoningEffort(
      body.reasoningEffort,
    );
    if (parsedReasoningEffort.error) {
      return {
        ok: false,
        result: commandFailure(parsedReasoningEffort.error, 400),
      };
    }

    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };
    const provider = body.provider ?? project.provider;
    const model = resolveSessionModel(body.model, provider);
    const parsedCodexModelProvider = resolveCodexModelProviderForStart(
      provider,
      body.codexModelProvider,
      model,
    );
    if (parsedCodexModelProvider.error) {
      return {
        ok: false,
        result: commandFailure(parsedCodexModelProvider.error, 400, {
          code: parsedCodexModelProvider.code,
        }),
      };
    }

    return {
      ok: true,
      executor: parsedExecutor.executor,
      model,
      opencodeConfig: parsedOpenCodeConfig.opencodeConfig,
      codexMcpMode: parsedCodexMcpMode.codexMcpMode,
      codexModelProvider: parsedCodexModelProvider.value,
      modelSettings: {
        model,
        thinking,
        effort,
        reasoningEffort: normalizeReasoningEffortForProvider(
          provider,
          parsedReasoningEffort.reasoningEffort,
        ),
        providerName: body.provider,
        codexMcpMode: parsedCodexMcpMode.codexMcpMode,
        codexModelProvider: parsedCodexModelProvider.value,
        opencodeConfig: parsedOpenCodeConfig.opencodeConfig,
        executor: parsedExecutor.executor,
        globalInstructions:
          this.deps.serverSettingsService?.getSetting("globalInstructions") ||
          undefined,
        permissions: body.permissions,
      },
    };
  }

  private toUserMessage(body: StartSessionBody): UserMessage {
    return {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      codexInputs: body.codexInputs?.map((input) => ({ ...input })),
      mode: body.mode,
      tempId: body.tempId,
    };
  }

  private mapAdmissionFailure(
    result: RuntimeSessionStartResponse,
  ): SessionCommandResult<never> | null {
    if (isQueueFullResponse(result)) {
      return commandFailure("Queue is full", 503, {
        maxQueueSize: result.maxQueueSize,
      });
    }
    if (isImmediateStartUnavailableResponse(result)) {
      return commandFailure("Immediate start unavailable", 503, {
        code: result.error,
      });
    }
    return null;
  }

  private isPermissionMode(value: unknown): value is PermissionMode {
    return (
      typeof value === "string" &&
      ALL_PERMISSION_MODES.includes(value as PermissionMode)
    );
  }

  private async persistNewSessionMetadata(
    result: RuntimeStartedProcess,
    prepared: {
      executor?: string;
      opencodeConfig?: OpenCodeSessionConfig;
      codexMcpMode?: CodexMcpMode;
      codexModelProvider?: string;
    },
    requestedProvider: ProviderName | undefined,
    persistCodexModelProvider = false,
  ): Promise<void> {
    const metadata = this.deps.sessionMetadataService;
    if (!metadata) return;
    if (requestedProvider) {
      await metadata.setProvider(result.sessionId, requestedProvider);
    }
    if (prepared.executor) {
      await metadata.setExecutor(result.sessionId, prepared.executor);
    }
    if (prepared.opencodeConfig) {
      await metadata.setOpenCodeConfig(
        result.sessionId,
        prepared.opencodeConfig,
      );
    }
    if (result.provider === "codex" && prepared.codexMcpMode) {
      await metadata.setCodexMcpMode?.(result.sessionId, prepared.codexMcpMode);
    }
    if (
      persistCodexModelProvider &&
      result.provider === "codex" &&
      prepared.codexModelProvider
    ) {
      await metadata.setCodexModelProvider?.(
        result.sessionId,
        prepared.codexModelProvider,
      );
    }
    if (result.permissionMode) {
      await metadata.setPermissionMode?.(
        result.sessionId,
        result.permissionMode,
      );
    }
  }

  private async recordYepSessionOrigin(
    sessionId: string,
    project: Project,
  ): Promise<void> {
    const metadata = this.deps.sessionMetadataService;
    if (!metadata) return;
    await metadata.setCreatedBy(sessionId, "yep");
    await metadata.setProjectLocation(sessionId, project.id, project.path);
    this.deps.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId,
      projectId: project.id,
      timestamp: new Date().toISOString(),
    });
  }

  private recordOpenCodeContextWindowOverride(input: {
    provider?: ProviderName;
    model?: string;
    sessionId?: string;
    limits?: OpenCodeModelLimits;
  }): void {
    if (
      input.provider !== "opencode" ||
      !input.limits ||
      input.limits.context <= 0
    ) {
      return;
    }
    if (input.model) {
      this.deps.modelInfoService?.recordContextWindow(
        input.model,
        input.limits.context,
        "opencode",
      );
    }
    if (input.sessionId) {
      this.deps.modelInfoService?.recordSessionContextWindow(
        input.sessionId,
        input.limits.context,
        "opencode",
      );
    }
  }

  private async terminateInteractionAliases(
    requestedSessionId: string,
    process: RuntimeProcessSnapshot,
  ): Promise<void> {
    const canonicalSessionId =
      process.pendingInputRequest?.sessionId || process.sessionId;
    await Promise.all(
      [...new Set([requestedSessionId, canonicalSessionId])].map((sessionId) =>
        this.deps.sessionInteractionService.terminateInteractionOperations(
          sessionId,
          "interrupt",
        ),
      ),
    );
  }
}
