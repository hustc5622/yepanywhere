import { join } from "node:path";
import { Hono } from "hono";
import {
  type CodexEventEnvelope,
  CodexEventSourceAdmissionError,
  type CodexEventStoreSource,
  CodexTranscriptExportLimitError,
  JsonlCodexEventStore,
  buildCanonicalCodexTranscriptFromEvents,
  exportCanonicalCodexTranscriptJson,
  exportCanonicalCodexTranscriptMarkdown,
  normalizeCodexEventStoreSources,
  selectCodexEventSource,
} from "../codex-events/index.js";

const DEFAULT_MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const MIN_MAX_EXPORT_BYTES = 2 * 1024;
const DEFAULT_MAX_EVENTS = 100_000;
const MAX_SESSION_ID_LENGTH = 256;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type CodexTranscriptFormat = "json" | "markdown";

/**
 * A factory is used instead of a long-lived file store so an export request
 * observes events appended by the independently-owned provider/bridge store.
 */
export type CodexTranscriptStoreSource = CodexEventStoreSource;

export interface CodexTranscriptRoutesDeps {
  /** Ordered source precedence. The first source containing events wins. */
  sources: readonly CodexTranscriptStoreSource[];
  maxExportBytes?: number;
  maxEvents?: number;
}

export interface DefaultCodexTranscriptStoreSourcesOptions {
  dataDir: string;
  /** Must match the provider writer when YEP_CODEX_EVENT_STORE_PATH is set. */
  providerEventStorePath?: string;
}

/**
 * Production canonical journals. Provider and bridge sequences are independent,
 * so the route selects one complete source rather than merging sequence spaces.
 */
export function createDefaultCodexTranscriptStoreSources(
  options: DefaultCodexTranscriptStoreSourcesOptions,
): CodexTranscriptStoreSource[] {
  const providerEventStorePath =
    options.providerEventStorePath?.trim() ||
    join(options.dataDir, "codex-events", "events.jsonl");
  const bridgeEventStorePath = join(
    options.dataDir,
    "codex-bridge",
    "codex-events.jsonl",
  );
  return [
    jsonlSource("provider", providerEventStorePath),
    jsonlSource("bridge", bridgeEventStorePath, {
      legacyBridgeFull: true,
    }),
  ];
}

export function createCodexTranscriptRoutes(
  deps: CodexTranscriptRoutesDeps,
): Hono {
  const sources = normalizeCodexEventStoreSources(deps.sources);
  const maxExportBytes = boundedInteger(
    deps.maxExportBytes,
    DEFAULT_MAX_EXPORT_BYTES,
    MIN_MAX_EXPORT_BYTES,
    DEFAULT_MAX_EXPORT_BYTES,
    "maxExportBytes",
  );
  const maxEvents = boundedInteger(
    deps.maxEvents,
    DEFAULT_MAX_EVENTS,
    1,
    DEFAULT_MAX_EVENTS,
    "maxEvents",
  );
  const routes = new Hono();

  routes.get("/:sessionId/codex-transcript", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!isSafeSessionId(sessionId)) {
      return c.json(
        {
          error: "Invalid Codex session id",
          code: "INVALID_CODEX_TRANSCRIPT_SESSION_ID",
        },
        400,
      );
    }

    const requestedFormat = c.req.query("format");
    if (
      requestedFormat !== undefined &&
      requestedFormat !== "markdown" &&
      requestedFormat !== "json"
    ) {
      return c.json(
        {
          error: "format must be markdown or json",
          code: "INVALID_CODEX_TRANSCRIPT_FORMAT",
        },
        400,
      );
    }
    const format: CodexTranscriptFormat = requestedFormat ?? "markdown";

    let selected: {
      sourceId: string;
      sourceKind: "provider" | "legacy-bridge-full" | "custom";
      coverage: {
        scope: "retained-journal";
        completePrefix: boolean;
        firstAvailableSequence: number;
        lastSequence: number;
        leadingGap: number;
        fallback: "rollout";
      };
      events: readonly CodexEventEnvelope[];
    } | null;
    try {
      selected = await selectCodexEventSource(sources, sessionId);
    } catch (error) {
      if (error instanceof CodexEventSourceAdmissionError) {
        return c.json(
          {
            error: "Canonical Codex events exceed the safe read budget",
            code: error.code,
            source: "unavailable",
            coverage: "unavailable",
            fallback: error.fallback,
            maxBytes: error.maxBytes,
          },
          413,
        );
      }
      return c.json(
        {
          error: "Failed to read canonical Codex events",
          code: "CODEX_TRANSCRIPT_READ_FAILED",
        },
        500,
      );
    }

    if (!selected) {
      return c.json(
        {
          error: "No canonical Codex events found for this session",
          code: "CODEX_CANONICAL_TRANSCRIPT_NOT_FOUND",
        },
        404,
      );
    }
    if (selected.events.length > maxEvents) {
      return c.json(
        {
          error: "Canonical Codex event count exceeds the export limit",
          code: "CODEX_TRANSCRIPT_EVENT_LIMIT_EXCEEDED",
          maxEvents,
        },
        413,
      );
    }

    try {
      const transcript = buildCanonicalCodexTranscriptFromEvents(
        sessionId,
        selected.events,
      );
      const exported =
        format === "json"
          ? exportCanonicalCodexTranscriptJson(transcript, {
              maxBytes: maxExportBytes,
            })
          : exportCanonicalCodexTranscriptMarkdown(transcript, {
              maxBytes: maxExportBytes,
            });

      c.header("Content-Type", `${exported.mediaType}; charset=utf-8`);
      c.header(
        "Content-Disposition",
        `attachment; filename="${exported.fileName}"`,
      );
      c.header("Cache-Control", "private, no-store");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Content-Security-Policy", "default-src 'none'");
      c.header("X-Yep-Codex-Transcript-Source", selected.sourceId);
      c.header("X-Yep-Codex-Transcript-Source-Kind", selected.sourceKind);
      c.header(
        "X-Yep-Codex-Transcript-Coverage",
        selected.coverage.completePrefix
          ? "retained-complete-prefix"
          : "retained-partial-leading-gap",
      );
      c.header(
        "X-Yep-Codex-Transcript-First-Sequence",
        String(selected.coverage.firstAvailableSequence),
      );
      c.header("X-Yep-Codex-Transcript-Fallback", "rollout");
      c.header(
        "X-Yep-Codex-Transcript-Truncated",
        String(exported.metadata.truncated),
      );
      return c.body(exported.body);
    } catch (error) {
      if (error instanceof CodexTranscriptExportLimitError) {
        return c.json(
          {
            error: "Codex transcript metadata exceeds the export limit",
            code: "CODEX_TRANSCRIPT_EXPORT_LIMIT_TOO_SMALL",
          },
          413,
        );
      }
      return c.json(
        {
          error: "Failed to build canonical Codex transcript",
          code: "CODEX_TRANSCRIPT_BUILD_FAILED",
        },
        500,
      );
    }
  });

  return routes;
}

function jsonlSource(
  id: string,
  filePath: string,
  options: { legacyBridgeFull?: boolean } = {},
): CodexTranscriptStoreSource {
  // Share a single long-lived store instance per file path so that the
  // incremental file refresh (stat + tail read) works across requests.
  // The store hydrates once and then only reads new appended bytes on each
  // subsequent replay, avoiding a full-file read on every session refresh.
  let store: JsonlCodexEventStore | null = null;
  return {
    id,
    ...(options.legacyBridgeFull ? { legacyBridgeFull: true } : {}),
    createStore: () => {
      if (!store) {
        store = new JsonlCodexEventStore({ filePath });
      }
      return store;
    },
  };
}

function isSafeSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= MAX_SESSION_ID_LENGTH &&
    SAFE_SESSION_ID.test(sessionId)
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new RangeError(
      `Codex transcript ${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return selected;
}
