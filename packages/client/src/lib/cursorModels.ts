import type { CursorModelConfigOption, ModelInfo } from "@yep-anywhere/shared";

const EFFORT_VALUES = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const EFFORT_OPTION_IDS = ["reasoning", "reasoning_effort", "effort"];
const CONTEXT_VALUE = /^\d+(?:\.\d+)?[kmb]$/i;

interface CursorVariantParts {
  modelId: string;
  /** Raw context token, e.g. "500k" or "1m". */
  context?: string;
  reasoning?: string;
  fast?: string;
}

function hasCursorParameters(models: ModelInfo[]): boolean {
  return models.some((model) => (model.cursorConfigOptions?.length ?? 0) > 0);
}

/**
 * Prefer a freshly loaded parameterized catalog. A non-empty flat list must
 * not hide that catalog: the picker needs each model's options to expand a
 * saved expression into separate controls.
 */
export function selectCursorModels(
  listed: ModelInfo[],
  fresh: ModelInfo[] | null,
): ModelInfo[] {
  if (fresh && hasCursorParameters(fresh)) return fresh;
  if (hasCursorParameters(listed)) return listed;
  if (fresh && fresh.length > 0) return fresh;
  return listed;
}

function canonicalOptionValue(
  option: CursorModelConfigOption | undefined,
  selected: string,
): string | undefined {
  if (!option) return undefined;
  return (
    option.options.find((value) => value.value === selected)?.value ??
    option.options.find(
      (value) => value.value.toLowerCase() === selected.toLowerCase(),
    )?.value
  );
}

function applyOption(
  model: ModelInfo,
  parameters: Record<string, string>,
  id: string,
  selected: string,
) {
  const canonical = canonicalOptionValue(
    model.cursorConfigOptions?.find((option) => option.id === id),
    selected,
  );
  if (canonical) parameters[id] = canonical;
}

function applyEffort(
  model: ModelInfo,
  parameters: Record<string, string>,
  reasoning: string,
) {
  for (const id of EFFORT_OPTION_IDS) {
    const canonical = canonicalOptionValue(
      model.cursorConfigOptions?.find((option) => option.id === id),
      reasoning,
    );
    if (canonical) {
      parameters[id] = canonical;
      return;
    }
  }
}

/**
 * Legacy variant ids encode options in the slug, for example
 * `claude-opus-5-5-high` or `gpt-5.6-sol-high-fast`. Only recognized
 * suffixes are removed, and only from the end, so a version number is kept.
 */
function parseVariantParts(model: string): CursorVariantParts | null {
  const tokens = model.split("-");
  let end = tokens.length;
  let context: string | undefined;
  let reasoning: string | undefined;
  let fast: string | undefined;
  while (end > 1) {
    const token = tokens[end - 1]?.toLowerCase();
    if (!token) break;
    if (token === "fast" && !fast) {
      fast = "true";
      end -= 1;
      continue;
    }
    if (
      !reasoning &&
      end >= 2 &&
      tokens[end - 2]?.toLowerCase() === "extra" &&
      token === "high"
    ) {
      reasoning = "extra-high";
      end -= 2;
      continue;
    }
    if (!reasoning && EFFORT_VALUES.has(token)) {
      reasoning = token;
      end -= 1;
      continue;
    }
    if (!context && CONTEXT_VALUE.test(token)) {
      context = token.toLowerCase();
      end -= 1;
      continue;
    }
    break;
  }
  if (!context && !reasoning && !fast) return null;
  const modelId = tokens.slice(0, end).join("-");
  if (!modelId) return null;
  return { modelId, context, reasoning, fast };
}

function parseBracket(
  value: string,
): { modelId: string; body?: string } | null {
  const match = value.match(/^([^\[\]]+)(?:\[([^\[\]]*)\])?$/);
  if (!match?.[1]) return null;
  return { modelId: match[1], body: match[2] };
}

export function getCursorModelSelection(
  models: ModelInfo[],
  value: string | null,
): {
  model: ModelInfo | undefined;
  parameters: Record<string, string>;
  raw: string | null;
} {
  const raw = value === "default" ? "auto" : value;
  const bracket = raw ? parseBracket(raw) : null;
  let model = models.find(
    (candidate) => candidate.id === (bracket?.modelId ?? raw),
  );
  let variant: CursorVariantParts | null = null;
  if (!model && raw && !bracket?.body) {
    variant = parseVariantParts(raw);
    if (variant) {
      model = models.find((candidate) => candidate.id === variant?.modelId);
    }
  }
  const parameterized = Boolean(bracket?.body || variant);
  // A flat id list has the base model but none of its options. Keep the raw
  // expression visible until a parameterized catalog can expand it.
  if (!model || (parameterized && !model.cursorConfigOptions?.length)) {
    return { model: undefined, parameters: {}, raw };
  }
  const parameters = Object.fromEntries(
    (model.cursorConfigOptions ?? []).map((option) => [
      option.id,
      option.currentValue,
    ]),
  );
  if (variant) {
    if (variant.context)
      applyOption(model, parameters, "context", variant.context);
    if (variant.reasoning) applyEffort(model, parameters, variant.reasoning);
    if (variant.fast) applyOption(model, parameters, "fast", variant.fast);
    return { model, parameters, raw };
  }
  if (bracket?.body) {
    for (const entry of bracket.body.split(",")) {
      const parts = entry.split("=");
      const key = parts[0]?.trim();
      const selected = parts[1]?.trim();
      if (parts.length !== 2 || !key || !selected) continue;
      if (EFFORT_OPTION_IDS.includes(key))
        applyEffort(model, parameters, selected);
      else applyOption(model, parameters, key, selected);
    }
  }
  return { model, parameters, raw };
}

/** A single native model expression persists every independent option. */
export function buildCursorModelValue(
  model: ModelInfo,
  parameters: Record<string, string> = {},
): string {
  const entries = (model.cursorConfigOptions ?? []).map((option) => {
    const value = parameters[option.id] ?? option.currentValue;
    if (!option.options.some((candidate) => candidate.value === value)) {
      throw new Error(`Unsupported Cursor parameter: ${option.id}`);
    }
    return `${option.id}=${value}`;
  });
  return entries.length ? `${model.id}[${entries.join(",")}]` : model.id;
}

export interface CursorModelBadgeDetails {
  /**
   * Base model id for a legacy variant slug. Bracket expressions leave this
   * empty; their display label already drops the parameter body.
   */
  modelId?: string;
  /** Context window with the unit uppercased, e.g. "500K". */
  context?: string;
  /** Raw `thinking` value from the expression. */
  thinking?: string;
  /** Raw reasoning / effort value (`reasoning`, `reasoning_effort`, or `effort`). */
  reasoning?: string;
  /** Raw `fast` value. "true" and "false" are the supported toggles. */
  fast?: string;
}

/**
 * Read Cursor picker parameters out of a stored model expression such as
 * `grok-4.7[context=500k,reasoning_effort=high,fast=false]`, or out of a
 * legacy variant slug such as `claude-opus-5-5-high`. A slug only reports
 * the suffixes it actually contains.
 */
export function parseCursorModelBadge(
  model: string | undefined,
): CursorModelBadgeDetails | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  const bracket = trimmed.match(/^([^\[\]]+)\[([^\[\]]+)\]$/);
  const body = bracket?.[2];
  if (body) {
    const details: CursorModelBadgeDetails = {};
    for (const entry of body.split(",")) {
      const parts = entry.split("=");
      const id = parts[0]?.trim();
      const value = parts[1]?.trim();
      if (parts.length !== 2 || !id || !value) return null;
      if (id === "context") details.context = formatCursorContext(value);
      else if (id === "thinking") details.thinking = value;
      else if (EFFORT_OPTION_IDS.includes(id)) details.reasoning = value;
      else if (id === "fast") details.fast = value;
    }
    if (
      !details.context &&
      !details.thinking &&
      !details.reasoning &&
      !details.fast
    ) {
      return null;
    }
    return details;
  }

  const variant = parseVariantParts(trimmed);
  if (!variant) return null;
  return {
    modelId: variant.modelId,
    ...(variant.context
      ? { context: formatCursorContext(variant.context) }
      : {}),
    ...(variant.reasoning ? { reasoning: variant.reasoning } : {}),
    ...(variant.fast ? { fast: variant.fast } : {}),
  };
}

function formatCursorContext(value: string): string {
  const match = value.match(/^(\d+(?:\.\d+)?)([kmb])$/i);
  if (!match?.[1] || !match[2]) return value;
  return `${match[1]}${match[2].toUpperCase()}`;
}

export function getPreferredCursorModelId(
  models: ModelInfo[],
  saved?: string | null,
): string | null {
  // Rewrite a saved expression or legacy variant into the native parameter
  // form when the catalog can represent it. Unrecognized ids stay unchanged
  // so the CLI can still launch them.
  if (saved) {
    const selection = getCursorModelSelection(models, saved);
    if (selection.model?.cursorConfigOptions?.length) {
      return buildCursorModelValue(selection.model, selection.parameters);
    }
    return saved === "default" ? "auto" : saved;
  }
  return (
    models.find((model) => model.id === "auto")?.id ?? models[0]?.id ?? null
  );
}
