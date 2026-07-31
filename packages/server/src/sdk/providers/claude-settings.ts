import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type EffortLevel,
  type ModelInfo,
  getModelContextWindow,
} from "@yep-anywhere/shared";

const DEFAULT_MODEL_CATALOG_BASE_URL = "https://api.ohmyrouter.com";
const MODEL_CATALOG_TIMEOUT_MS = 10000;
const EFFORT_LEVELS = new Set<EffortLevel>(["low", "medium", "high", "max"]);

type ClaudeSettingsJson = Record<string, unknown> & {
  env?: Record<string, unknown>;
};

interface RawModelRecord {
  id?: unknown;
  owned_by?: unknown;
  supported_endpoint_types?: unknown;
}

interface ModelCatalogResponse {
  success?: unknown;
  data?: unknown;
}

export interface ClaudeCodeSettingsSnapshot {
  path: string;
  model?: string;
  effortLevel?: EffortLevel;
}

export interface ClaudeCodeSettingsPatch {
  model?: string | null;
  effortLevel?: EffortLevel | null;
}

export function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function getClaudeSettingsPath(): string {
  return join(getClaudeConfigDir(), "settings.json");
}

async function readClaudeSettings(): Promise<{
  path: string;
  settings: ClaudeSettingsJson;
}> {
  const settingsPath = getClaudeSettingsPath();
  try {
    const content = await fs.readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { path: settingsPath, settings: {} };
    }
    return { path: settingsPath, settings: parsed as ClaudeSettingsJson };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: settingsPath, settings: {} };
    }
    throw error;
  }
}

function readSettingsEnv(
  settings: ClaudeSettingsJson,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (!settings.env || typeof settings.env !== "object") return env;

  for (const [key, value] of Object.entries(settings.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

function normalizeEffortLevel(value: unknown): EffortLevel | undefined {
  // Backward-compat: older configs may have stored "xhigh" for Claude.
  if (value === "xhigh") return "max";
  if (typeof value !== "string") return undefined;
  return EFFORT_LEVELS.has(value as EffortLevel)
    ? (value as EffortLevel)
    : undefined;
}

export async function getClaudeCodeSettings(): Promise<ClaudeCodeSettingsSnapshot> {
  const { path, settings } = await readClaudeSettings();
  const model =
    typeof settings.model === "string" && settings.model.trim()
      ? settings.model.trim()
      : undefined;
  const effortLevel = normalizeEffortLevel(settings.effortLevel);

  return { path, model, effortLevel };
}

export async function updateClaudeCodeSettings(
  patch: ClaudeCodeSettingsPatch,
): Promise<ClaudeCodeSettingsSnapshot> {
  const { path, settings } = await readClaudeSettings();

  if ("model" in patch) {
    const model = patch.model?.trim();
    if (model && model !== "default") {
      settings.model = model;
    } else {
      settings.model = undefined;
    }
  }

  if ("effortLevel" in patch) {
    if (patch.effortLevel) {
      settings.effortLevel = patch.effortLevel;
    } else {
      settings.effortLevel = undefined;
    }
  }

  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  return getClaudeCodeSettings();
}

export async function getConfiguredClaudeModels(): Promise<ModelInfo[]> {
  const settings = await getClaudeCodeSettings();
  if (!settings.model) return [];

  return [
    {
      id: settings.model,
      name: formatModelName(settings.model),
      description: "Current Claude Code setting",
      contextWindow: getModelContextWindow(settings.model, "claude"),
    },
  ];
}

function getModelCatalogCredentials(settings: ClaudeSettingsJson): {
  baseUrl: string;
  apiKey?: string;
} {
  const settingsEnv = readSettingsEnv(settings);

  const catalogBaseUrl = cleanEnvValue(
    process.env.CLAUDE_MODEL_CATALOG_BASE_URL,
  );
  if (catalogBaseUrl) {
    return {
      baseUrl: catalogBaseUrl,
      apiKey: firstEnvValue(
        process.env.CLAUDE_MODEL_CATALOG_API_KEY,
        process.env.LLM_API_KEY,
        settingsEnv.ANTHROPIC_AUTH_TOKEN,
      ),
    };
  }

  const llmBaseUrl = cleanEnvValue(process.env.LLM_API_BASE);
  if (llmBaseUrl) {
    return {
      baseUrl: llmBaseUrl,
      apiKey: firstEnvValue(
        process.env.LLM_API_KEY,
        process.env.CLAUDE_MODEL_CATALOG_API_KEY,
        settingsEnv.ANTHROPIC_AUTH_TOKEN,
      ),
    };
  }

  const anthropicBaseUrl = cleanEnvValue(settingsEnv.ANTHROPIC_BASE_URL);
  if (anthropicBaseUrl) {
    return {
      baseUrl: anthropicBaseUrl,
      apiKey: firstEnvValue(
        settingsEnv.ANTHROPIC_AUTH_TOKEN,
        process.env.CLAUDE_MODEL_CATALOG_API_KEY,
      ),
    };
  }

  return { baseUrl: DEFAULT_MODEL_CATALOG_BASE_URL };
}

function cleanEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function firstEnvValue(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = cleanEnvValue(value);
    if (trimmed) return trimmed;
  }
  return undefined;
}

function toModelsEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/v1/models")) return base;
  if (base.endsWith("/v1")) return `${base}/models`;
  return `${base}/v1/models`;
}

function isClaudeLikeModelId(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return (
    normalized.startsWith("claude") || normalized.startsWith("anthropic/claude")
  );
}

function normalizeSupportedEndpoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function supportsAnthropicEndpoint(model: RawModelRecord): boolean {
  const endpoints = normalizeSupportedEndpoints(model.supported_endpoint_types);
  return endpoints.some((endpoint) =>
    endpoint.toLowerCase().includes("anthropic"),
  );
}

function formatModelName(modelId: string): string {
  const rawName =
    modelId.toLowerCase().startsWith("anthropic/") && modelId.includes("/")
      ? (modelId.split("/").pop() ?? modelId)
      : modelId.replaceAll("/", " ");

  return rawName
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d+$/.test(part)) return part;
      if (/^\d+m$/i.test(part)) return part.toUpperCase();
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

export function normalizeClaudeModelCatalog(data: unknown): ModelInfo[] {
  const response = data as ModelCatalogResponse;
  if (response?.success === false || !Array.isArray(response?.data)) {
    return [];
  }

  const models = new Map<string, ModelInfo>();
  for (const raw of response.data as RawModelRecord[]) {
    if (!raw || typeof raw.id !== "string") continue;

    const id = raw.id.trim();
    if (!id) continue;
    const endpoints = normalizeSupportedEndpoints(raw.supported_endpoint_types);
    if (!supportsAnthropicEndpoint(raw) && !isClaudeLikeModelId(id)) continue;

    const parts = ["Anthropic-compatible gateway model"];
    if (typeof raw.owned_by === "string" && raw.owned_by.trim()) {
      parts.push(raw.owned_by.trim());
    }
    if (endpoints.length > 0) {
      parts.push(endpoints.join(", "));
    }

    models.set(id, {
      id,
      name: formatModelName(id),
      description: parts.join(" · "),
      contextWindow: getModelContextWindow(id, "claude"),
    });
  }

  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function fetchClaudeModelCatalog(): Promise<ModelInfo[]> {
  try {
    const { settings } = await readClaudeSettings();
    const { baseUrl, apiKey } = getModelCatalogCredentials(settings);
    if (!apiKey) return [];

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(toModelsEndpoint(baseUrl), {
      headers,
      signal: AbortSignal.timeout(MODEL_CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) return [];

    return normalizeClaudeModelCatalog(await response.json());
  } catch {
    return [];
  }
}
