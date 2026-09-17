import { asRecord } from "../bridge-common/util.js";
import { CodexAppServerClient } from "./CodexAppServerClient.js";
import type {
  CodexUsageBucket,
  CodexUsageResetCredits,
  CodexUsageSnapshot,
  CodexUsageWindow,
} from "./types.js";

export async function readCodexUsage(
  codexPathOverride?: string,
  codexHome?: string,
): Promise<CodexUsageSnapshot> {
  const client = new CodexAppServerClient({ codexPathOverride, codexHome });
  try {
    await client.start();
    const result = await client.request("account/rateLimits/read", null);
    const usage = normalizeUsageSnapshot(result);
    if (!usage) {
      throw new Error("Codex app-server returned invalid rate-limit data");
    }
    return usage;
  } finally {
    client.close();
  }
}

export function normalizeUsageSnapshot(
  value: unknown,
): CodexUsageSnapshot | null {
  const result = asRecord(value);
  if (!result) return null;
  const rateLimits =
    asRecord(result.rateLimits) ?? asRecord(result.rate_limits);
  const byLimitId =
    asRecord(result.rateLimitsByLimitId) ??
    asRecord(result.rate_limits_by_limit_id);
  const primaryBucket =
    normalizeBucket(byLimitId?.codex, "codex") ??
    normalizeBucket(rateLimits, "codex");
  if (!primaryBucket) return null;

  const additionalBuckets = byLimitId
    ? Object.entries(byLimitId)
        .map(([limitId, bucket]) => normalizeBucket(bucket, limitId))
        .filter((bucket): bucket is CodexUsageBucket =>
          Boolean(bucket && bucket.id !== primaryBucket.id),
        )
    : [];

  return {
    primary: primaryBucket.primary,
    secondary: primaryBucket.secondary,
    planType: primaryBucket.planType,
    resetCredits: normalizeResetCredits(
      result.rateLimitResetCredits ?? result.rate_limit_reset_credits,
    ),
    additionalBuckets,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeBucket(
  value: unknown,
  fallbackId: string,
): CodexUsageBucket | null {
  const bucket = asRecord(value);
  if (!bucket) return null;
  const primary = normalizeWindow(bucket.primary);
  const secondary = normalizeWindow(bucket.secondary);
  if (!primary && !secondary) return null;

  return {
    id: getString(bucket.limitId) ?? getString(bucket.limit_id) ?? fallbackId,
    name: getString(bucket.limitName) ?? getString(bucket.limit_name),
    primary,
    secondary,
    planType: getString(bucket.planType) ?? getString(bucket.plan_type),
  };
}

function normalizeWindow(value: unknown): CodexUsageWindow | null {
  const window = asRecord(value);
  if (!window) return null;
  const usedPercent =
    getNumber(window.usedPercent) ?? getNumber(window.used_percent);
  if (usedPercent === null) return null;

  return {
    usedPercent,
    windowDurationMins:
      getNumber(window.windowDurationMins) ??
      getNumber(window.window_duration_mins),
    resetsAt: getNumber(window.resetsAt) ?? getNumber(window.resets_at),
  };
}

function normalizeResetCredits(value: unknown): CodexUsageResetCredits | null {
  const credits = asRecord(value);
  if (!credits) return null;
  const availableCount =
    getNumber(credits.availableCount) ?? getNumber(credits.available_count);
  if (availableCount === null) return null;
  return { availableCount };
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
