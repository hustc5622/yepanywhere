import type { CodexEventStore } from "./store.js";

export type CodexEventProjectionMode = "legacy" | "shadow" | "primary";

export interface CodexEventRolloutScope {
  sessionId: string;
  accountId?: string;
}

export interface CodexEventRolloutConfig {
  /** Default is shadow: persist/reduce every event while preserving old UI. */
  defaultMode?: CodexEventProjectionMode;
  primarySessionIds?: readonly string[];
  primaryAccountIds?: readonly string[];
  legacySessionIds?: readonly string[];
  legacyAccountIds?: readonly string[];
  durableStorePath?: string;
  store?: CodexEventStore;
}

export function codexEventRolloutConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CodexEventRolloutConfig {
  return {
    defaultMode: parseMode(env.YEP_CODEX_EVENT_SPINE_MODE) ?? "shadow",
    primarySessionIds: parseCsv(env.YEP_CODEX_EVENT_SPINE_PRIMARY_SESSIONS),
    primaryAccountIds: parseCsv(env.YEP_CODEX_EVENT_SPINE_PRIMARY_ACCOUNTS),
    legacySessionIds: parseCsv(env.YEP_CODEX_EVENT_SPINE_LEGACY_SESSIONS),
    legacyAccountIds: parseCsv(env.YEP_CODEX_EVENT_SPINE_LEGACY_ACCOUNTS),
    ...(nonEmpty(env.YEP_CODEX_EVENT_STORE_PATH)
      ? { durableStorePath: env.YEP_CODEX_EVENT_STORE_PATH?.trim() }
      : {}),
  };
}

/**
 * Resolve the projection independently for each native session/account. A
 * legacy override wins so rollback is immediate, while event ingestion stays
 * enabled in every mode and therefore loses no canonical history.
 */
export function resolveCodexEventProjectionMode(
  scope: CodexEventRolloutScope,
  config: CodexEventRolloutConfig,
): CodexEventProjectionMode {
  if (
    matches(scope.sessionId, config.legacySessionIds) ||
    matches(scope.accountId, config.legacyAccountIds)
  ) {
    return "legacy";
  }
  if (
    matches(scope.sessionId, config.primarySessionIds) ||
    matches(scope.accountId, config.primaryAccountIds)
  ) {
    return "primary";
  }
  return config.defaultMode ?? "shadow";
}

function parseMode(value: string | undefined): CodexEventProjectionMode | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "legacy" ||
    normalized === "shadow" ||
    normalized === "primary"
    ? normalized
    : null;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function matches(
  value: string | undefined,
  candidates: readonly string[] | undefined,
): boolean {
  return value !== undefined && Boolean(candidates?.includes(value));
}
