import type {
  CodexEventStore,
  CodexJournalGap,
  CodexPrunedSegmentSummary,
} from "./store.js";

export type CodexEventProjectionMode = "legacy" | "shadow" | "primary";

export interface CodexEventRolloutScope {
  sessionId: string;
  accountId?: string;
}

export interface CodexEventRolloutConfig {
  /**
   * Default is legacy: ingest and journal every event, project once.
   *
   * `shadow` additionally runs the canonical projection and hashes both to
   * compare them. That comparison cannot currently succeed. The canonical side
   * consumes the *redacted* envelope payload while the legacy side consumes the
   * raw notification, and redaction rewrites `path`/`movePath` to
   * workspace-relative form, fingerprints other path-bearing keys, and scrubs
   * absolute paths inside strings. Only `timestamp` is normalised before
   * hashing, so any payload carrying a path diverges by construction --
   * measured on one install as 53,649 warnings dominated by
   * `item/commandExecution/outputDelta` (37,302) and `item/started` /
   * `item/completed` (16,331), against just 16 for the path-free
   * `turn/plan/updated`.
   *
   * So shadow was paying for a second projection and two SHA-256 hashes per
   * event to re-report redaction, into a parity snapshot no caller reads. It
   * stays available for whoever resumes the canonical-to-primary migration,
   * which is the only context where the signal is worth its cost and where the
   * comparison itself needs fixing first.
   */
  defaultMode?: CodexEventProjectionMode;
  primarySessionIds?: readonly string[];
  primaryAccountIds?: readonly string[];
  legacySessionIds?: readonly string[];
  legacyAccountIds?: readonly string[];
  durableStorePath?: string;
  /** Size-based rotation for the durable JSONL store, when one is configured. */
  storeRotation?: {
    maxBytes?: number;
    keepSegments?: number;
  };
  /** Observes durable-store rotations for diagnostics. */
  onStoreRotate?: (details: {
    from: string;
    to: string;
    pruned: string[];
    prunedSummary: CodexPrunedSegmentSummary[];
  }) => void;
  /** Observes sessions whose journal prefix was lost to earlier pruning. */
  onStoreJournalGaps?: (details: {
    gaps: CodexJournalGap[];
    sessionCount: number;
    journalFiles: number;
  }) => void;
  store?: CodexEventStore;
}

export function codexEventRolloutConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CodexEventRolloutConfig {
  return {
    defaultMode: parseMode(env.YEP_CODEX_EVENT_SPINE_MODE) ?? "legacy",
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
  return config.defaultMode ?? "legacy";
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
