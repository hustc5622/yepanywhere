import type { CodexEventStore } from "./store.js";
import {
  type CanonicalCodexTranscript,
  type CodexTranscriptBuildOptions,
  type CodexTranscriptExportOptions,
  type CodexTranscriptExportResult,
  buildCanonicalCodexTranscriptFromEvents,
  exportCanonicalCodexTranscriptJson,
  exportCanonicalCodexTranscriptMarkdown,
} from "./transcript.js";

export interface LoadCanonicalCodexTranscriptOptions {
  throughSequence?: number;
  build?: CodexTranscriptBuildOptions;
}

export interface ExportCanonicalCodexTranscriptFromStoreOptions
  extends LoadCanonicalCodexTranscriptOptions,
    CodexTranscriptExportOptions {}

/**
 * Replay only Yep's canonical CodexEventStore and project an export document.
 * This deliberately has no fallback to provider rollout/session JSONL.
 */
export async function loadCanonicalCodexTranscript(
  store: CodexEventStore,
  sessionId: string,
  options: LoadCanonicalCodexTranscriptOptions = {},
): Promise<CanonicalCodexTranscript> {
  const events = await store.replay({
    sessionId,
    ...(options.throughSequence === undefined
      ? {}
      : { throughSequence: options.throughSequence }),
  });
  return buildCanonicalCodexTranscriptFromEvents(
    sessionId,
    events,
    options.build,
  );
}

export async function exportCanonicalCodexTranscriptFromStore(
  store: CodexEventStore,
  sessionId: string,
  format: "json" | "markdown",
  options: ExportCanonicalCodexTranscriptFromStoreOptions = {},
): Promise<CodexTranscriptExportResult> {
  const transcript = await loadCanonicalCodexTranscript(store, sessionId, {
    ...(options.throughSequence === undefined
      ? {}
      : { throughSequence: options.throughSequence }),
    ...(options.build === undefined ? {} : { build: options.build }),
  });
  const exportOptions =
    options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes };
  return format === "json"
    ? exportCanonicalCodexTranscriptJson(transcript, exportOptions)
    : exportCanonicalCodexTranscriptMarkdown(transcript, exportOptions);
}
