import type { ModelInfo } from "@yep-anywhere/shared";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
let configuredOllamaUrl = normalizeOllamaUrl(
  process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL,
);

interface OllamaTagsResponse {
  models?: Array<{ name: string; size?: number }>;
}

interface OllamaShowResponse {
  parameters?: string;
  details?: {
    parent_model?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export function normalizeOllamaUrl(url: string): string {
  const parsed = new URL(url.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Ollama URL 必须使用 http 或 https");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function setOllamaUrl(url?: string): void {
  configuredOllamaUrl = normalizeOllamaUrl(url || DEFAULT_OLLAMA_URL);
}

export function getOllamaUrl(): string {
  return configuredOllamaUrl;
}

export class OllamaClient {
  constructor(
    private readonly baseUrl = getOllamaUrl(),
    private readonly timeoutMs = 5000,
  ) {}

  async isReachable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) return [];

    const data = (await response.json()) as OllamaTagsResponse;
    const models = data.models ?? [];
    const details = await Promise.all(
      models.map((model) => this.getModelDetails(model.name)),
    );
    return models.map((model, index) => ({
      id: model.name,
      name: model.name,
      size: model.size,
      ...details[index],
    }));
  }

  private async getModelDetails(
    modelName: string,
  ): Promise<
    Pick<
      ModelInfo,
      "contextWindow" | "parameterSize" | "parentModel" | "quantizationLevel"
    >
  > {
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return {};
      const data = (await response.json()) as OllamaShowResponse;
      const match = data.parameters?.match(/num_ctx\s+(\d+)/);
      const contextWindow = match?.[1]
        ? Number.parseInt(match[1], 10)
        : undefined;
      return {
        contextWindow,
        parameterSize: data.details?.parameter_size || undefined,
        parentModel:
          data.details?.parent_model && data.details.parent_model !== modelName
            ? data.details.parent_model
            : undefined,
        quantizationLevel: data.details?.quantization_level || undefined,
      };
    } catch {
      return {};
    }
  }
}
