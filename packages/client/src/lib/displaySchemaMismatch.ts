import {
  type SessionDisplaySnapshot,
  SessionDisplaySnapshotSchema,
} from "@yep-anywhere/shared";
import type { ZodError } from "zod";
import { checkForNewBuild } from "./buildRefresh";

export const DISPLAY_SCHEMA_MISMATCH = "DISPLAY_SCHEMA_MISMATCH";

/**
 * The display contract is strict, so a client bundle older than the server
 * rejects fields the server added. Surface that as "this client is stale"
 * instead of a raw Zod dump.
 */
export class DisplaySchemaMismatchError extends Error {
  readonly code = DISPLAY_SCHEMA_MISMATCH;

  constructor(readonly detail: string) {
    super("Session display data does not match this client build");
    this.name = "DisplaySchemaMismatchError";
  }
}

export function isDisplaySchemaMismatchError(
  error: unknown,
): error is DisplaySchemaMismatchError {
  return error instanceof DisplaySchemaMismatchError;
}

const MAX_SUMMARY_ISSUES = 5;
const WARN_INTERVAL_MS = 10_000;
const lastWarnAt = new Map<string, number>();

/** Compact, de-duplicated issue list such as `nodes.*.segment: unrecognized_keys (messageIds)`. */
export function summarizeDisplaySchemaIssues(error: ZodError): string {
  const lines = new Set<string>();
  for (const issue of error.issues) {
    const path = issue.path
      .map((part) => (typeof part === "number" ? "*" : String(part)))
      .join(".");
    const keys =
      "keys" in issue && Array.isArray(issue.keys) && issue.keys.length > 0
        ? ` (${issue.keys.join(", ")})`
        : "";
    lines.add(`${path || "<root>"}: ${issue.code}${keys}`);
  }
  const all = [...lines];
  const shown = all.slice(0, MAX_SUMMARY_ISSUES);
  if (all.length > shown.length)
    shown.push(`… +${all.length - shown.length} more`);
  return shown.join("\n");
}

/** Logs a rejected display payload and checks whether this tab is stale. */
export function reportDisplaySchemaMismatch(
  error: ZodError,
  source: string,
): string {
  const detail = summarizeDisplaySchemaIssues(error);
  // Streaming patches can fail on every event; keep the console readable.
  const now = Date.now();
  if (now - (lastWarnAt.get(source) ?? 0) >= WARN_INTERVAL_MS) {
    lastWarnAt.set(source, now);
    console.warn(
      `[SessionDisplay] ${source} rejected by client schema`,
      detail,
    );
  }
  void checkForNewBuild();
  return detail;
}

export function parseDisplaySnapshot(
  data: unknown,
  source: string,
): SessionDisplaySnapshot {
  const parsed = SessionDisplaySnapshotSchema.safeParse(data);
  if (parsed.success) return parsed.data;
  throw new DisplaySchemaMismatchError(
    reportDisplaySchemaMismatch(parsed.error, source),
  );
}
