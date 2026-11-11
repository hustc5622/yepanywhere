import type { ModelInfo } from "@yep-anywhere/shared";

export function getCursorModelSelection(
  models: ModelInfo[],
  value: string | null,
) {
  const raw = value === "default" ? "auto" : value;
  const match = raw?.match(/^([^\[\]]+)(?:\[([^\[\]]+)\])?$/);
  const model = models.find(
    (candidate) => candidate.id === (match?.[1] ?? raw),
  );
  const parameters = Object.fromEntries(
    (model?.cursorConfigOptions ?? []).map((option) => [
      option.id,
      option.currentValue,
    ]),
  );
  let valid = Boolean(model);
  if (match?.[2]) {
    for (const entry of match[2].split(",")) {
      const [key, selected, extra] = entry.split("=");
      const option = model?.cursorConfigOptions?.find(
        (option) => option.id === key,
      );
      if (
        extra !== undefined ||
        !selected ||
        !option?.options.some((value) => value.value === selected)
      ) {
        valid = false;
        break;
      }
      parameters[key as string] = selected;
    }
  }
  return { model: valid ? model : undefined, parameters, raw };
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
 * `grok-4.7[context=500k,reasoning_effort=high,fast=false]`.
 * Returns null for bare ids and old variant slugs that have no bracket body.
 */
export function parseCursorModelBadge(
  model: string | undefined,
): CursorModelBadgeDetails | null {
  const match = model?.trim().match(/^([^\[\]]+)\[([^\[\]]+)\]$/);
  const body = match?.[2];
  if (!body) return null;

  const details: CursorModelBadgeDetails = {};
  for (const entry of body.split(",")) {
    const parts = entry.split("=");
    const id = parts[0]?.trim();
    const value = parts[1]?.trim();
    if (parts.length !== 2 || !id || !value) return null;
    if (id === "context") details.context = formatCursorContext(value);
    else if (id === "thinking") details.thinking = value;
    else if (
      id === "reasoning" ||
      id === "reasoning_effort" ||
      id === "effort"
    ) {
      details.reasoning = value;
    } else if (id === "fast") details.fast = value;
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

function formatCursorContext(value: string): string {
  const match = value.match(/^(\d+(?:\.\d+)?)([kmb])$/i);
  if (!match?.[1] || !match[2]) return value;
  return `${match[1]}${match[2].toUpperCase()}`;
}

export function getPreferredCursorModelId(
  models: ModelInfo[],
  saved?: string | null,
): string | null {
  // Preserve old variant IDs too: the CLI can still accept them. The picker
  // exposes the saved value until the user deliberately selects a native model.
  if (saved) {
    const selection = getCursorModelSelection(models, saved);
    if (selection.model?.cursorConfigOptions) {
      return buildCursorModelValue(selection.model, selection.parameters);
    }
    return saved === "default" ? "auto" : saved;
  }
  return (
    models.find((model) => model.id === "auto")?.id ?? models[0]?.id ?? null
  );
}
