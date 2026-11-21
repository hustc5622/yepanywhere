/**
 * Antigravity CLI (`agy`) model catalog helpers.
 *
 * agy encodes the reasoning tier in the model slug (`gemini-4-neon-high`,
 * `gemini-3.8-flash-low`); its ACP server exposes the same catalog as a
 * `model` select option holding the family (`gemini-4-neon`) plus a separate
 * `thought_level` select (`low|medium|high|xhigh`). Families with a single
 * tier keep the full slug as their id (`gpt-oss-120b-medium`), exactly like
 * agy's own `model` option values.
 *
 * Yep shows one picker entry per family and maps the tier onto reasoning
 * effort, mirroring Codex's model + effort controls.
 */

import type { ModelInfo } from "@yep-anywhere/shared";

export const AGY_MODEL_CONFIG_ID = "model";
export const AGY_THOUGHT_CONFIG_ID = "thought_level";

export const AGY_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgyTier = (typeof AGY_TIERS)[number];

const TIER_SLUG = /^(?<base>.+)-(?<tier>low|medium|high|xhigh|max)$/;
const TIER_LABEL = /\s*\((?:low|medium|high|x-?high|extra|max)\)\s*$/i;
/** Tier agy picks for a family when the user did not choose one. */
const DEFAULT_TIER: AgyTier = "high";

export interface AgyModelRow {
  slug: string;
  label: string;
}

export function splitAgyTier(
  slug: string,
): { base: string; tier: AgyTier } | null {
  const match = TIER_SLUG.exec(slug);
  if (!match?.groups?.base || !match.groups.tier) return null;
  return { base: match.groups.base, tier: match.groups.tier as AgyTier };
}

/**
 * Parse `agy models` output: a progress line followed by
 * `slug<TAB>label` rows. Anything else is ignored.
 */
export function parseAgyModelsOutput(stdout: string): AgyModelRow[] {
  const rows: AgyModelRow[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const [rawSlug, rawLabel] = line.split("\t");
    const slug = rawSlug?.trim();
    const label = rawLabel?.trim();
    if (!slug || !label) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    rows.push({ slug, label });
  }
  return rows;
}

/** Group tiered slugs into families with reasoning efforts. */
export function buildAgyModelCatalog(
  rows: readonly AgyModelRow[],
): ModelInfo[] {
  const tiersByBase = new Map<string, Set<AgyTier>>();
  for (const row of rows) {
    const split = splitAgyTier(row.slug);
    if (!split) continue;
    const tiers = tiersByBase.get(split.base) ?? new Set<AgyTier>();
    tiers.add(split.tier);
    tiersByBase.set(split.base, tiers);
  }
  const models: ModelInfo[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    const split = splitAgyTier(row.slug);
    const tiers = split ? tiersByBase.get(split.base) : undefined;
    if (!split || !tiers || tiers.size < 2) {
      if (!emitted.has(row.slug)) {
        emitted.add(row.slug);
        models.push({ id: row.slug, name: row.label });
      }
      continue;
    }
    if (emitted.has(split.base)) continue;
    emitted.add(split.base);
    const ordered = AGY_TIERS.filter((tier) => tiers.has(tier));
    models.push({
      id: split.base,
      name: row.label.replace(TIER_LABEL, "").trim() || split.base,
      supportedReasoningEfforts: ordered.map((reasoningEffort) => ({
        reasoningEffort,
      })),
      defaultReasoningEffort: ordered.includes(DEFAULT_TIER)
        ? DEFAULT_TIER
        : ordered.at(-1),
      supportsEffort: true,
    });
  }
  return models;
}

/** A picker choice resolved to agy's ACP `model` value and tier. */
export interface AgyModelChoice {
  family: string;
  tier?: AgyTier;
}

/**
 * Resolve a Yep model id (family, or a full persisted slug such as
 * `gemini-3.8-flash-low`) plus an optional reasoning effort against the
 * session's advertised `model` option values.
 */
export function resolveAgyModelChoice(
  familyValues: readonly string[],
  model: string,
  reasoningEffort: string | undefined,
): AgyModelChoice | null {
  const effort = AGY_TIERS.find((tier) => tier === reasoningEffort);
  if (familyValues.includes(model)) {
    return { family: model, ...(effort ? { tier: effort } : {}) };
  }
  const split = splitAgyTier(model);
  if (split && familyValues.includes(split.base)) {
    return { family: split.base, tier: effort ?? split.tier };
  }
  return null;
}

/**
 * Small fallback used before `agy models` succeeds (not installed or not
 * signed in). Ids match agy's ACP `model` option values.
 */
export const AGY_FALLBACK_MODELS: ModelInfo[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
    ],
    defaultReasoningEffort: "high",
    supportsEffort: true,
  },
];
