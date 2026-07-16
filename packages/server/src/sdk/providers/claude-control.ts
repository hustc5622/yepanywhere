import {
  type ModelInfo as ClaudeSdkModelInfo,
  type SDKControlGetUsageResponse,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ModelInfo,
  type RemoteExecutorConfig,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import { createRemoteSpawn } from "../remote-spawn.js";
import { filterEnvForChildProcess } from "./env-filter.js";

const CONTROL_PROBE_TIMEOUT_MS = 20_000;
const FIVE_HOURS_MINUTES = 5 * 60;
const SEVEN_DAYS_MINUTES = 7 * 24 * 60;

export interface ClaudeUsageWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface ClaudeUsageBucket {
  id: string;
  name: string | null;
  primary: ClaudeUsageWindow | null;
  secondary: ClaudeUsageWindow | null;
  planType: string | null;
}

export interface ClaudeUsageSnapshot {
  primary: ClaudeUsageWindow | null;
  secondary: ClaudeUsageWindow | null;
  planType: string | null;
  resetCredits: null;
  additionalBuckets: ClaudeUsageBucket[];
  updatedAt: string;
}

export interface ClaudeUsageResponse {
  usage: ClaudeUsageSnapshot | null;
  error: string | null;
}

export interface ClaudeControlProbeResult {
  models: ModelInfo[] | null;
  usage: ClaudeUsageSnapshot | null;
  modelsError: string | null;
  usageError: string | null;
}

type ClaudeUsageRateLimits = NonNullable<
  SDKControlGetUsageResponse["rate_limits"]
>;
type ClaudeUsageRateLimitWindow = NonNullable<
  ClaudeUsageRateLimits["five_hour"]
>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function getVersionedModelName(model: ClaudeSdkModelInfo): string {
  const descriptionName = model.description.split("·", 1)[0]?.trim();
  if (model.value === "default") {
    return descriptionName ? `Default (${descriptionName})` : model.displayName;
  }
  return descriptionName || model.displayName;
}

/**
 * Claude's context control response sometimes reports the usable prompt
 * budget after reserving its system buffer (for example 967K for Sonnet 5).
 * The model picker describes the model tier, so normalize those values to the
 * advertised 1M/200K windows.
 */
export function normalizeClaudeContextWindow(
  value: number | undefined,
  modelId?: string,
  resolvedModel?: string,
): number {
  if (value && Number.isFinite(value) && value > 0) {
    if (value >= 900_000) return 1_000_000;
    if (value >= 160_000 && value <= 220_000) return 200_000;
    return value;
  }

  if (modelId?.toLowerCase().includes("[1m]")) return 1_000_000;
  const canonical = (resolvedModel ?? modelId ?? "").toLowerCase();
  if (
    canonical.includes("sonnet-5") ||
    canonical.includes("fable-5") ||
    canonical.includes("opus-4-8")
  ) {
    return 1_000_000;
  }
  return getModelContextWindow(modelId, "claude");
}

export function mapClaudeSdkModel(
  model: ClaudeSdkModelInfo,
  contextWindow?: number,
): ModelInfo {
  const efforts = model.supportedEffortLevels?.map((reasoningEffort) => ({
    reasoningEffort,
  }));
  return {
    id: model.value,
    resolvedModel: model.resolvedModel,
    name: getVersionedModelName(model),
    description: model.description,
    contextWindow: normalizeClaudeContextWindow(
      contextWindow,
      model.value,
      model.resolvedModel,
    ),
    supportsEffort: model.supportsEffort ?? false,
    supportedReasoningEfforts: efforts?.length ? efforts : undefined,
    supportsAdaptiveThinking: model.supportsAdaptiveThinking ?? false,
    supportsFastMode: model.supportsFastMode ?? false,
    supportsAutoMode: model.supportsAutoMode ?? false,
  };
}

function normalizeResetTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : null;
}

function normalizeUsageWindow(
  value: ClaudeUsageRateLimitWindow | null | undefined,
  windowDurationMins: number,
): ClaudeUsageWindow | null {
  if (!value || typeof value.utilization !== "number") return null;
  return {
    usedPercent: value.utilization,
    windowDurationMins,
    resetsAt: normalizeResetTimestamp(value.resets_at),
  };
}

function usageBucket(
  id: string,
  name: string,
  value: ClaudeUsageRateLimitWindow | null | undefined,
  planType: string | null,
): ClaudeUsageBucket | null {
  const primary = normalizeUsageWindow(value, SEVEN_DAYS_MINUTES);
  if (!primary) return null;
  return { id, name, primary, secondary: null, planType };
}

export function normalizeClaudeUsage(
  response: SDKControlGetUsageResponse,
): ClaudeUsageSnapshot {
  const limits = response.rate_limits;
  const planType = response.subscription_type;
  const additionalBuckets: ClaudeUsageBucket[] = [];

  if (limits) {
    const namedLimits: Array<
      [string, string, ClaudeUsageRateLimitWindow | null | undefined]
    > = [
      ["seven-day-sonnet", "Sonnet", limits.seven_day_sonnet],
      ["seven-day-opus", "Opus", limits.seven_day_opus],
      ["seven-day-oauth-apps", "OAuth apps", limits.seven_day_oauth_apps],
    ];
    for (const [id, name, value] of namedLimits) {
      const bucket = usageBucket(id, name, value, planType);
      if (bucket) additionalBuckets.push(bucket);
    }

    for (const [index, modelLimit] of (limits.model_scoped ?? []).entries()) {
      const primary = normalizeUsageWindow(modelLimit, SEVEN_DAYS_MINUTES);
      if (!primary) continue;
      additionalBuckets.push({
        id: `model-${index}`,
        name: modelLimit.display_name,
        primary,
        secondary: null,
        planType,
      });
    }
  }

  return {
    primary: normalizeUsageWindow(limits?.five_hour, FIVE_HOURS_MINUTES),
    secondary: normalizeUsageWindow(limits?.seven_day, SEVEN_DAYS_MINUTES),
    planType,
    resetCredits: null,
    additionalBuckets,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Initialize the remote CLI without sending a user message. The control
 * channel provides the same model catalog and structured /usage data as the
 * interactive CLI; persistSession=false keeps this probe out of transcripts.
 */
export async function probeRemoteClaudeControl(
  executor: RemoteExecutorConfig,
): Promise<ClaudeControlProbeResult> {
  const abortController = new AbortController();

  async function* waitForAbort(): AsyncGenerator<never> {
    await new Promise<void>((resolve) => {
      if (abortController.signal.aborted) {
        resolve();
        return;
      }
      abortController.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }

  const sdkQuery = query({
    prompt: waitForAbort(),
    options: {
      cwd: executor.remoteRoot,
      abortController,
      permissionMode: "default",
      persistSession: false,
      settingSources: ["user", "project", "local"],
      env: filterEnvForChildProcess(),
      spawnClaudeCodeProcess: createRemoteSpawn({ executor }),
    },
  });

  void (async () => {
    try {
      for await (const _ of sdkQuery) {
        // Drain the iterator so SDK control responses are processed.
      }
    } catch {
      // Aborting the initialize-only probe is expected.
    }
  })();

  try {
    return await withTimeout(
      (async () => {
        const [modelsResult, usageResult] = await Promise.allSettled([
          sdkQuery.supportedModels(),
          sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
        ]);

        let models: ModelInfo[] | null = null;
        if (modelsResult.status === "fulfilled") {
          models = modelsResult.value.map((model) =>
            mapClaudeSdkModel(
              model,
              (model as { contextWindow?: number }).contextWindow,
            ),
          );
        }

        return {
          models,
          usage:
            usageResult.status === "fulfilled"
              ? normalizeClaudeUsage(usageResult.value)
              : null,
          modelsError:
            modelsResult.status === "rejected"
              ? errorMessage(modelsResult.reason)
              : null,
          usageError:
            usageResult.status === "rejected"
              ? errorMessage(usageResult.reason)
              : null,
        };
      })(),
      CONTROL_PROBE_TIMEOUT_MS,
      "Claude remote control probe",
    );
  } finally {
    abortController.abort();
    sdkQuery.close();
  }
}
