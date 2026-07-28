import { randomUUID } from "node:crypto";
import type { ModelInfo, OpenCodeRequestProtocol } from "@yep-anywhere/shared";
import {
  type OpenCodeGatewayConfig,
  fetchOpenCodeGatewayModels,
  resolveOpenCodeGatewayConfig,
} from "../opencode-bridge/gateway-config.js";
import type { ServerSettingsService } from "./ServerSettingsService.js";

const REQUEST_TIMEOUT_MS = 90_000;
const BENCHMARK_MAX_TOKENS = 128;
const BENCHMARK_PROMPT =
  "Output the word token exactly 96 times, separated by single spaces. Do not add any other text.";

export interface OhMyRouterThroughputResult {
  modelId: string;
  modelName: string;
  protocol: OpenCodeRequestProtocol;
  testedAt: string;
  outputTokens?: number;
  /** Whether the gateway reported the output token count or it was estimated from streamed text. */
  tokenCountSource?: "reported" | "estimated";
  tokensPerSecond?: number;
  timeToFirstTokenMs?: number;
  generationDurationMs?: number;
  error?: string;
}

export interface OhMyRouterThroughputBenchmark {
  id: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  completedAt?: string;
  totalModels: number;
  completedModels: number;
  results: OhMyRouterThroughputResult[];
  error?: string;
}

export interface OhMyRouterThroughputStatus {
  available: boolean;
  unavailableReason?: string;
  benchmark?: OhMyRouterThroughputBenchmark;
}

export interface BenchmarkModelOptions {
  config: OpenCodeGatewayConfig;
  model: ModelInfo;
  fetchImpl?: typeof fetch;
}

function isOhMyRouterGateway(config: OpenCodeGatewayConfig): boolean {
  try {
    return new URL(config.apiBase).hostname === "api.ohmyrouter.com";
  } catch {
    return false;
  }
}

function selectProtocol(model: ModelInfo): OpenCodeRequestProtocol {
  return model.supportedRequestProtocols?.includes("anthropic") &&
    !model.supportedRequestProtocols.includes("openai-compatible")
    ? "anthropic"
    : "openai-compatible";
}

function getRequestUrl(
  config: OpenCodeGatewayConfig,
  protocol: OpenCodeRequestProtocol,
): string {
  const apiBase = config.apiBase.replace(/\/+$/, "");
  return protocol === "anthropic"
    ? `${apiBase}/messages`
    : `${apiBase}/chat/completions`;
}

function getRequestHeaders(
  config: OpenCodeGatewayConfig,
  protocol: OpenCodeRequestProtocol,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
  if (protocol === "anthropic") {
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  if (config.subModule) headers["X-Sub-Module"] = config.subModule;
  return headers;
}

function getRequestBody(
  modelId: string,
  model: ModelInfo,
  protocol: OpenCodeRequestProtocol,
): Record<string, unknown> {
  // OhMyRouter's Claude Opus 4.8 rejects explicit temperature with
  // "temperature is deprecated for this model". Only send temperature for
  // models that are known to accept it (non-Claude-Opus-4.8 families).
  const supportsTemperature = !modelId.startsWith("claude-opus-4-8");

  if (protocol === "anthropic") {
    return {
      model: modelId,
      max_tokens: BENCHMARK_MAX_TOKENS,
      ...(supportsTemperature ? { temperature: 0 } : {}),
      stream: true,
      messages: [{ role: "user", content: BENCHMARK_PROMPT }],
    };
  }
  return {
    model: modelId,
    max_tokens: BENCHMARK_MAX_TOKENS,
    ...(supportsTemperature ? { temperature: 0 } : {}),
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: BENCHMARK_PROMPT }],
  };
}

function estimateTokenCount(text: string): number {
  const parts = text.match(/[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
  return parts.length;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function getReportedOutputTokens(
  usage: Record<string, unknown> | undefined,
): number | undefined {
  for (const value of [usage?.output_tokens, usage?.completion_tokens]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function parseStreamPayload(
  payload: unknown,
  protocol: OpenCodeRequestProtocol,
): { content?: string; outputTokens?: number } {
  if (!payload || typeof payload !== "object") return {};
  const data = payload as Record<string, unknown>;
  const usage =
    data.usage && typeof data.usage === "object"
      ? (data.usage as Record<string, unknown>)
      : undefined;
  // OhMyRouter's OpenAI-compatible Claude responses include an `output_tokens`
  // field set to 0 alongside the actual positive `completion_tokens` value.
  // A zero is not useful throughput data and must not mask the fallback.
  const outputTokens = getReportedOutputTokens(usage);

  if (protocol === "anthropic") {
    const delta =
      data.delta && typeof data.delta === "object"
        ? (data.delta as Record<string, unknown>)
        : undefined;
    return {
      content: typeof delta?.text === "string" ? delta.text : undefined,
      outputTokens,
    };
  }

  const choices = Array.isArray(data.choices) ? data.choices : [];
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return { outputTokens };
  const delta = (firstChoice as Record<string, unknown>).delta;
  if (!delta || typeof delta !== "object") return { outputTokens };
  const content = (delta as Record<string, unknown>).content;
  return {
    content: typeof content === "string" ? content : undefined,
    outputTokens,
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.text()).replace(/\s+/g, " ").trim();
    return body ? `: ${body.slice(0, 500)}` : "";
  } catch {
    return "";
  }
}

/** Run a small streaming generation and calculate its output token throughput. */
export async function benchmarkOhMyRouterModel(
  options: BenchmarkModelOptions,
): Promise<OhMyRouterThroughputResult> {
  const { config, model, fetchImpl = fetch } = options;
  const protocol = selectProtocol(model);
  const testedAt = new Date().toISOString();
  const startedAt = performance.now();

  try {
    const response = await fetchImpl(getRequestUrl(config, protocol), {
      method: "POST",
      headers: getRequestHeaders(config, protocol),
      body: JSON.stringify(getRequestBody(model.id, model, protocol)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Gateway returned ${response.status}${await readError(response)}`,
      );
    }
    if (!response.body) throw new Error("Gateway returned an empty response");

    let firstTokenAt: number | undefined;
    let lastTokenAt: number | undefined;
    let reportedOutputTokens: number | undefined;
    let generatedText = "";
    let buffer = "";
    const decoder = new TextDecoder();

    const processLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const value = line.slice(5).trim();
      if (!value || value === "[DONE]") return;
      let payload: unknown;
      try {
        payload = JSON.parse(value);
      } catch {
        return;
      }
      const parsed = parseStreamPayload(payload, protocol);
      if (typeof parsed.outputTokens === "number") {
        reportedOutputTokens = parsed.outputTokens;
      }
      if (!parsed.content) return;
      const now = performance.now();
      firstTokenAt ??= now;
      lastTokenAt = now;
      generatedText += parsed.content;
    };

    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);

    const finishedAt = performance.now();
    const estimatedOutputTokens = estimateTokenCount(generatedText);
    const outputTokens = reportedOutputTokens ?? estimatedOutputTokens;
    if (!firstTokenAt || !lastTokenAt || outputTokens <= 0) {
      throw new Error("Gateway stream did not contain output tokens");
    }
    const generationDurationMs = Math.max(1, finishedAt - firstTokenAt);
    return {
      modelId: model.id,
      modelName: model.name,
      protocol,
      testedAt,
      outputTokens,
      tokenCountSource: reportedOutputTokens ? "reported" : "estimated",
      tokensPerSecond: (outputTokens * 1000) / generationDurationMs,
      timeToFirstTokenMs: firstTokenAt - startedAt,
      generationDurationMs,
    };
  } catch (error) {
    return {
      modelId: model.id,
      modelName: model.name,
      protocol,
      testedAt,
      error: getErrorMessage(error),
    };
  }
}

export interface OhMyRouterBenchmarkServiceOptions {
  serverSettingsService: ServerSettingsService;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * Persists a full OhMyRouter model throughput run in server settings so it can
 * continue to be observed by any connected Yep client.
 */
export class OhMyRouterBenchmarkService {
  private readonly serverSettingsService: ServerSettingsService;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private activeRun: OhMyRouterThroughputBenchmark | null = null;

  constructor(options: OhMyRouterBenchmarkServiceOptions) {
    this.serverSettingsService = options.serverSettingsService;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async initialize(): Promise<void> {
    const previous = this.serverSettingsService.getSetting(
      "ohmyrouterThroughputBenchmark",
    );
    if (previous?.status !== "running") return;
    await this.persist({
      ...previous,
      status: "interrupted",
      completedAt: new Date().toISOString(),
      error: "Benchmark interrupted because the Yep server restarted.",
    });
  }

  getStatus(): OhMyRouterThroughputStatus {
    const config = resolveOpenCodeGatewayConfig(this.env);
    const benchmark = this.serverSettingsService.getSetting(
      "ohmyrouterThroughputBenchmark",
    );
    if (!config) {
      return {
        available: false,
        unavailableReason: "OhMyRouter API key is not configured.",
        benchmark,
      };
    }
    if (!isOhMyRouterGateway(config)) {
      return {
        available: false,
        unavailableReason:
          "The configured model gateway is not api.ohmyrouter.com.",
        benchmark,
      };
    }
    return { available: true, benchmark };
  }

  async start(): Promise<OhMyRouterThroughputBenchmark> {
    if (this.activeRun) return this.activeRun;
    const config = resolveOpenCodeGatewayConfig(this.env);
    if (!config || !isOhMyRouterGateway(config)) {
      throw new Error(this.getStatus().unavailableReason ?? "Unavailable");
    }

    const run: OhMyRouterThroughputBenchmark = {
      id: randomUUID(),
      status: "running",
      startedAt: new Date().toISOString(),
      totalModels: 0,
      completedModels: 0,
      results: [],
    };
    this.activeRun = run;
    try {
      await this.persist(run);
    } catch (error) {
      this.activeRun = null;
      throw error;
    }
    void this.run(run, config);
    return run;
  }

  private async run(
    run: OhMyRouterThroughputBenchmark,
    config: OpenCodeGatewayConfig,
  ): Promise<void> {
    try {
      const models = await fetchOpenCodeGatewayModels(config, this.fetchImpl);
      if (models.length === 0) {
        throw new Error("OhMyRouter did not return any models to benchmark.");
      }
      run.totalModels = models.length;
      await this.persist(run);

      for (const model of models) {
        const result = await benchmarkOhMyRouterModel({
          config,
          model,
          fetchImpl: this.fetchImpl,
        });
        run.results.push(result);
        run.completedModels += 1;
        await this.persist(run);
      }

      run.status = "completed";
      run.completedAt = new Date().toISOString();
      await this.persist(run);
    } catch (error) {
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      run.error = getErrorMessage(error);
      try {
        await this.persist(run);
      } catch (persistError) {
        console.error(
          "[OhMyRouterBenchmarkService] Failed to persist benchmark failure:",
          persistError,
        );
      }
    } finally {
      if (this.activeRun?.id === run.id) this.activeRun = null;
    }
  }

  private async persist(run: OhMyRouterThroughputBenchmark): Promise<void> {
    await this.serverSettingsService.updateSettings({
      ohmyrouterThroughputBenchmark: {
        ...run,
        results: [...run.results],
      },
    });
  }
}
