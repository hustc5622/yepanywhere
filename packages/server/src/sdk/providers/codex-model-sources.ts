/**
 * Codex model source (Codex `model_provider`) registry.
 *
 * A "model source" is a server-owned, trusted definition of a Codex
 * `model_provider` (e.g. `openai`, `deepseek`). The browser only ever selects a
 * source *id*; it never supplies base URLs, API keys, env keys, headers, or
 * catalog paths. This module is the single place that:
 *
 * - holds the trusted source definitions,
 * - computes per-source availability (e.g. required API key present),
 * - validates source/model pairs,
 * - generates the Codex app-server `-c` config overrides for a source,
 * - materializes the versioned model catalog to the data dir, and
 * - produces the safe `CodexModelSourceInfo` summary returned to clients.
 *
 * Never log API keys or return connection details to the browser. See
 * docs/project/2026-07-31-codex-model-source-selection.md for the full design.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexModelSourceInfo, ModelInfo } from "@yep-anywhere/shared";
import { getDataDir } from "../../config.js";
import { getLogger } from "../../logging/logger.js";

const log = getLogger().child({ component: "codex-model-sources" });

/** The default Codex model source used when none is specified. */
export const DEFAULT_CODEX_MODEL_SOURCE = "openai";

/** Stable, client-localizable reason codes for an unavailable source. */
export type CodexModelSourceUnavailableReason =
  | "missing_api_key"
  | "invalid_catalog";

/** One model exposed by a custom source's managed catalog. */
export interface CodexModelSourceCatalogModel {
  /** Model slug sent to the Codex app-server (e.g. "deepseek-v4-flash"). */
  slug: string;
  displayName: string;
  description?: string;
  /** Context window in tokens; drives the app-server token-usage meter. */
  contextWindow: number;
  /** Max output tokens per response, when known. */
  maxOutputTokens?: number;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string;
    description?: string;
  }>;
  /** Provider-native compatibility mapping for legacy/client tier names. */
  reasoningEffortAliases?: Readonly<Record<string, string>>;
}

export interface CodexModelSourceCatalog {
  /** Versioned id, e.g. "deepseek-codex-2026-07-31". */
  managedId: string;
  /** Provenance / audit metadata for catalog updates. */
  provenance: {
    upstreamUrl: string;
    fetchedOn: string;
    minimalClientVersion?: string;
  };
  models: CodexModelSourceCatalogModel[];
  /** Only these slugs are selectable in the picker (may be subset of models). */
  allowedModelIds: readonly string[];
}

export interface CodexModelSourceDefinition {
  /** Codex `model_provider` id. */
  id: string;
  displayName: string;
  kind: "builtin" | "custom";
  /** Connection config for custom sources; never returned to the browser. */
  providerConfig?: {
    baseUrl: string;
    wireApi: "responses";
    envKey: string;
    /** Retry failed HTTP requests before Codex reports a terminal provider error. */
    requestMaxRetries?: number;
    /** Retry a dropped Responses SSE stream before failing the turn. */
    streamMaxRetries?: number;
    /** Maximum quiet period for a Responses SSE stream. */
    streamIdleTimeoutMs?: number;
  };
  /** Versioned Codex model catalog for custom sources. */
  catalog?: CodexModelSourceCatalog;
  /** Env var that must be present for this source to be available. */
  requiredEnv?: string;
}

/**
 * Trusted source definitions. Add new Responses-API providers here; do not
 * scatter `if (source === "deepseek")` checks across the Codex provider.
 */
const CODEX_MODEL_SOURCE_DEFINITIONS: Record<
  string,
  CodexModelSourceDefinition
> = {
  openai: {
    id: "openai",
    displayName: "OpenAI",
    kind: "builtin",
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    kind: "custom",
    providerConfig: {
      baseUrl: "https://api.deepseek.com/",
      wireApi: "responses",
      envKey: "DEEPSEEK_API_KEY",
      // DeepSeek documents transient 5xx/503 overloads and queues some
      // requests for an extended period. Codex's defaults (4 request retries,
      // 5 stream retries, 5 minute idle timeout) are too short for that
      // operating envelope, especially immediately after a model release.
      requestMaxRetries: 8,
      streamMaxRetries: 8,
      streamIdleTimeoutMs: 600_000,
    },
    requiredEnv: "DEEPSEEK_API_KEY",
    catalog: {
      // Bumped when the managed catalog contents change so the materialized
      // `<dataDir>/codex-model-catalogs/<managedId>.json` file is refreshed.
      managedId: "deepseek-codex-2026-08-13",
      provenance: {
        upstreamUrl:
          "https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex",
        fetchedOn: "2026-08-13",
        minimalClientVersion: "0.144.0",
      },
      // DeepSeek V4 Flash + V4 Pro over the Codex Responses API. The official
      // 2026-08-13 capability table advertises low/high/max; legacy medium and
      // xhigh requests map to high (see design §10.3).
      allowedModelIds: ["deepseek-v4-flash", "deepseek-v4-pro"],
      models: [
        {
          slug: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          description: "DeepSeek V4 Flash via the Codex Responses API.",
          contextWindow: 1_000_000,
          maxOutputTokens: 384_000,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast responses" },
            { reasoningEffort: "high", description: "Deeper reasoning" },
            { reasoningEffort: "max", description: "Maximum reasoning" },
          ],
          reasoningEffortAliases: {
            minimal: "low",
            medium: "high",
            xhigh: "high",
          },
        },
        {
          slug: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          description: "DeepSeek V4 Pro via the Codex Responses API.",
          contextWindow: 1_000_000,
          maxOutputTokens: 384_000,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast responses" },
            { reasoningEffort: "high", description: "Deeper reasoning" },
            { reasoningEffort: "max", description: "Maximum reasoning" },
          ],
          reasoningEffortAliases: {
            minimal: "low",
            medium: "high",
            xhigh: "high",
          },
        },
      ],
    },
  },
};

export class CodexModelSourceError extends Error {
  constructor(
    message: string,
    /** Stable API error code, e.g. "invalid_codex_model_provider". */
    readonly code: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "CodexModelSourceError";
  }
}

export interface CodexModelSourceRegistryOptions {
  /** Environment used for availability checks. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Data dir for materialized catalogs. Defaults to `getDataDir()`. */
  dataDir?: string;
}

export class CodexModelSourceRegistry {
  private readonly env: NodeJS.ProcessEnv;
  private readonly dataDir: string;
  /** Cache of materialized catalog absolute paths, keyed by managedId. */
  private readonly catalogPathCache = new Map<string, string>();

  constructor(options: CodexModelSourceRegistryOptions = {}) {
    this.env = options.env ?? process.env;
    this.dataDir = options.dataDir ?? getDataDir();
  }

  /** All defined sources in stable display order (openai first). */
  list(): CodexModelSourceDefinition[] {
    return Object.values(CODEX_MODEL_SOURCE_DEFINITIONS);
  }

  get(id: string | undefined): CodexModelSourceDefinition | undefined {
    if (!id) return undefined;
    return CODEX_MODEL_SOURCE_DEFINITIONS[id];
  }

  /** Resolve a source id (defaulting to `openai`), throwing when unknown. */
  require(id: string | undefined): CodexModelSourceDefinition {
    const resolved = id?.trim() || DEFAULT_CODEX_MODEL_SOURCE;
    const definition = CODEX_MODEL_SOURCE_DEFINITIONS[resolved];
    if (!definition) {
      throw new CodexModelSourceError(
        `Unknown Codex model source: ${resolved}`,
        "invalid_codex_model_provider",
      );
    }
    return definition;
  }

  /** Whether a source is currently selectable (built-ins always are). */
  getAvailability(id: string): {
    available: boolean;
    reason?: CodexModelSourceUnavailableReason;
  } {
    const definition = CODEX_MODEL_SOURCE_DEFINITIONS[id];
    if (!definition) return { available: false };

    if (definition.requiredEnv) {
      const value = this.env[definition.requiredEnv];
      if (!value || value.trim().length === 0) {
        return { available: false, reason: "missing_api_key" };
      }
    }
    if (definition.catalog && !this.materializeCatalog(definition)) {
      return { available: false, reason: "invalid_catalog" };
    }
    return { available: true };
  }

  /** Safe, browser-facing summaries (never include connection details). */
  getPublicSources(): CodexModelSourceInfo[] {
    return this.list().map((definition) => {
      const availability = this.getAvailability(definition.id);
      return {
        id: definition.id,
        displayName: definition.displayName,
        available: availability.available,
        ...(availability.reason
          ? { unavailableReason: availability.reason }
          : {}),
      };
    });
  }

  /**
   * Find the custom source that owns a model slug (via its catalog allowlist).
   * Returns undefined for models with no custom-source owner (e.g. OpenAI live
   * models), since the built-in source has no catalog to match against.
   */
  findModelSource(modelSlug: string | undefined): string | undefined {
    if (!modelSlug) return undefined;
    for (const definition of this.list()) {
      if (!definition.catalog) continue;
      if (definition.catalog.allowedModelIds.includes(modelSlug)) {
        return definition.id;
      }
    }
    return undefined;
  }

  /** Whether a model slug is selectable for a source in the new-session picker. */
  isModelSelectable(sourceId: string, modelSlug: string | undefined): boolean {
    const definition = CODEX_MODEL_SOURCE_DEFINITIONS[sourceId];
    if (!definition) return false;
    // Built-in OpenAI accepts any live model returned by model/list.
    if (!definition.catalog) return true;
    if (!modelSlug) return false;
    return definition.catalog.allowedModelIds.includes(modelSlug);
  }

  /**
   * Assert (for new sessions) that a model belongs to a source. Throws a
   * `CodexModelSourceError` with a stable code otherwise.
   */
  assertModelSelectable(sourceId: string, modelSlug: string | undefined): void {
    const availability = this.getAvailability(sourceId);
    if (!availability.available) {
      throw new CodexModelSourceError(
        `Codex model source is unavailable: ${sourceId}`,
        "codex_model_provider_unavailable",
      );
    }
    if (!this.isModelSelectable(sourceId, modelSlug)) {
      throw new CodexModelSourceError(
        `Model "${modelSlug ?? "(none)"}" is not valid for Codex source "${sourceId}"`,
        "invalid_codex_model_for_provider",
      );
    }
  }

  /**
   * Resolve the reasoning effort to send to a source's app-server.
   *
   * Built-in OpenAI accepts the full standard tier set (low/medium/high/xhigh/
   * max/ultra). Custom sources (e.g. DeepSeek) only advertise a subset of
   * tiers, so a GPT-only tier such as `xhigh` must never be passed through
   * verbatim: higher tiers clamp to the source's highest supported level and
   * unknown values fall back to the model's default. This keeps DeepSeek
   * sessions on `low/medium/high` regardless of which client path set the
   * effort (new session, resume, fork, queued message, or a stale `xhigh`
   * read back from a previous turn).
   */
  resolveReasoningEffort(
    sourceId: string,
    modelSlug: string | undefined,
    requested: string | undefined,
  ): string | undefined {
    if (!requested) return requested;
    const trimmedRequested = requested.trim();
    if (!trimmedRequested) return undefined;
    const definition = CODEX_MODEL_SOURCE_DEFINITIONS[sourceId];
    // Built-in source: no catalog constraints; keep the requested tier.
    if (!definition?.catalog) return trimmedRequested;

    const catalogModel =
      definition.catalog.models.find((model) => model.slug === modelSlug) ??
      definition.catalog.models[0];
    if (!catalogModel) return trimmedRequested;

    const supported = (catalogModel.supportedReasoningEfforts ?? []).map(
      (option) => option.reasoningEffort,
    );
    if (supported.includes(trimmedRequested)) return trimmedRequested;

    const aliased = catalogModel.reasoningEffortAliases?.[trimmedRequested];
    if (aliased && supported.includes(aliased)) return aliased;

    // Remaining higher GPT-only tiers clamp to the source's highest advertised
    // tier. Provider-native aliases above take precedence (DeepSeek xhigh,
    // for example, intentionally maps to high rather than max).
    const HIGHER_TIERS = new Set(["xhigh", "max", "ultra"]);
    if (HIGHER_TIERS.has(trimmedRequested)) {
      const highest = supported[supported.length - 1];
      if (highest) return highest;
    }

    // Unknown or unsupported values fall back to the model's advertised
    // default, then its first supported tier.
    const modelDefault = catalogModel.defaultReasoningEffort?.trim();
    if (modelDefault && supported.includes(modelDefault)) return modelDefault;
    if (supported.length > 0) return supported[0];
    return undefined;
  }

  /**
   * Build Codex app-server `-c` config overrides for a source. Always pins the
   * `model_provider` explicitly (even for OpenAI) so a default process cannot
   * inherit a user's globally-configured DeepSeek provider/catalog.
   */
  buildAppServerArgs(definition: CodexModelSourceDefinition): string[] {
    const args: string[] = ["-c", `model_provider="${definition.id}"`];

    if (definition.providerConfig) {
      const {
        baseUrl,
        wireApi,
        envKey,
        requestMaxRetries,
        streamMaxRetries,
        streamIdleTimeoutMs,
      } = definition.providerConfig;
      const prefix = `model_providers.${definition.id}`;
      args.push(
        "-c",
        `${prefix}.name="${definition.displayName}"`,
        "-c",
        `${prefix}.base_url="${baseUrl}"`,
        "-c",
        `${prefix}.wire_api="${wireApi}"`,
        "-c",
        `${prefix}.env_key="${envKey}"`,
        // Custom OpenAI-compatible providers use HTTP Responses, never the
        // ChatGPT-authenticated WebSocket transport. Pin both flags so a
        // same-named entry in the user's global config cannot leak through.
        "-c",
        `${prefix}.requires_openai_auth=false`,
        "-c",
        `${prefix}.supports_websockets=false`,
      );
      if (requestMaxRetries !== undefined) {
        args.push("-c", `${prefix}.request_max_retries=${requestMaxRetries}`);
      }
      if (streamMaxRetries !== undefined) {
        args.push("-c", `${prefix}.stream_max_retries=${streamMaxRetries}`);
      }
      if (streamIdleTimeoutMs !== undefined) {
        args.push(
          "-c",
          `${prefix}.stream_idle_timeout_ms=${streamIdleTimeoutMs}`,
        );
      }
      // The user's global config may set an OpenAI-only `service_tier` (e.g.
      // "priority"/"flex"). Custom sources don't advertise those tiers, so
      // Codex would warn and drop it per request. Pin the neutral "default"
      // tier for custom sources so nothing incompatible leaks in. OpenAI is
      // left untouched so the user's own tier preference still applies there.
      args.push("-c", 'service_tier="default"');
    }

    if (definition.catalog) {
      const catalogPath = this.materializeCatalog(definition);
      if (catalogPath) {
        args.push("-c", `model_catalog_json="${catalogPath}"`);
      }
    }

    return args;
  }

  /** Convert a source's catalog into picker `ModelInfo` entries. */
  getCatalogModelInfos(definition: CodexModelSourceDefinition): ModelInfo[] {
    const catalog = definition.catalog;
    if (!catalog) return [];
    return catalog.models
      .filter((model) => catalog.allowedModelIds.includes(model.slug))
      .map((model) => ({
        id: `${definition.id}/${model.slug}`,
        modelProvider: definition.id,
        providerModelId: model.slug,
        name: model.displayName,
        description: model.description,
        contextWindow: model.contextWindow,
        ...(model.maxOutputTokens !== undefined
          ? { maxOutputTokens: model.maxOutputTokens }
          : {}),
        ...(model.defaultReasoningEffort
          ? { defaultReasoningEffort: model.defaultReasoningEffort }
          : {}),
        ...(model.supportedReasoningEfforts
          ? { supportedReasoningEfforts: model.supportedReasoningEfforts }
          : {}),
      }));
  }

  /**
   * Materialize a source's catalog to `<dataDir>/codex-model-catalogs/<id>.json`
   * (atomic write). Returns the absolute path, or null when the catalog is
   * invalid or cannot be written. Cached per managedId.
   */
  materializeCatalog(definition: CodexModelSourceDefinition): string | null {
    const catalog = definition.catalog;
    if (!catalog) return null;

    const cached = this.catalogPathCache.get(catalog.managedId);
    if (cached) return cached;

    const catalogJson = buildCodexCatalogJson(catalog);
    if (!catalogJson || catalogJson.models.length === 0) {
      log.error(
        { source: definition.id, managedId: catalog.managedId },
        "Codex model catalog is empty or invalid; disabling source",
      );
      return null;
    }

    const dir = path.join(this.dataDir, "codex-model-catalogs");
    const target = path.join(dir, `${catalog.managedId}.json`);
    try {
      mkdirSync(dir, { recursive: true });
      const serialized = JSON.stringify(catalogJson, null, 2);
      const tmp = path.join(
        tmpdir(),
        `${catalog.managedId}.${process.pid}.${Date.now()}.tmp`,
      );
      writeFileSync(tmp, serialized, "utf-8");
      renameSync(tmp, target);
    } catch (error) {
      log.error(
        { source: definition.id, managedId: catalog.managedId, error },
        "Failed to materialize Codex model catalog",
      );
      return null;
    }

    this.catalogPathCache.set(catalog.managedId, target);
    return target;
  }
}

/** Codex `ModelsResponse` model entry (subset of fields Codex requires). */
interface CodexCatalogModelJson {
  slug: string;
  display_name: string;
  description: string | null;
  default_reasoning_level: string | null;
  supported_reasoning_levels: Array<{ effort: string; description: string }>;
  shell_type: string;
  visibility: string;
  supported_in_api: boolean;
  priority: number;
  availability_nux: null;
  upgrade: null;
  base_instructions: string;
  support_verbosity: boolean;
  default_verbosity: string | null;
  apply_patch_tool_type: string | null;
  truncation_policy: { mode: string; limit: number };
  supports_parallel_tool_calls: boolean;
  context_window: number;
  max_context_window: number;
  experimental_supported_tools: string[];
  input_modalities: string[];
}

/** Build the Codex `model_catalog_json` payload from a source catalog. */
function buildCodexCatalogJson(catalog: CodexModelSourceCatalog): {
  models: CodexCatalogModelJson[];
} {
  const models = catalog.models
    .filter((model) => catalog.allowedModelIds.includes(model.slug))
    .map((model, index) => ({
      slug: model.slug,
      display_name: model.displayName,
      description: model.description ?? null,
      default_reasoning_level: model.defaultReasoningEffort ?? null,
      supported_reasoning_levels: (model.supportedReasoningEfforts ?? []).map(
        (option) => ({
          effort: option.reasoningEffort,
          description: option.description ?? "",
        }),
      ),
      shell_type: "default",
      visibility: "list",
      supported_in_api: true,
      priority: index,
      availability_nux: null,
      upgrade: null,
      base_instructions: "",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      truncation_policy: { mode: "tokens", limit: model.contextWindow },
      supports_parallel_tool_calls: true,
      context_window: model.contextWindow,
      max_context_window: model.contextWindow,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
    }));
  return { models };
}

/** Shared singleton for the running server. */
let sharedRegistry: CodexModelSourceRegistry | null = null;

export function getCodexModelSourceRegistry(): CodexModelSourceRegistry {
  if (!sharedRegistry) {
    sharedRegistry = new CodexModelSourceRegistry();
  }
  return sharedRegistry;
}
