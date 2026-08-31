import { createHash } from "node:crypto";
import { reduceCodexEvents } from "./reducer.js";
import {
  type CanonicalCodexItemState,
  type CanonicalCodexSessionState,
  type CodexEventEnvelope,
  type SafeJsonObject,
  type SafeJsonValue,
  createCanonicalCodexSessionState,
} from "./types.js";

export const CODEX_TRANSCRIPT_SCHEMA_NAME =
  "yep.codex-canonical-transcript" as const;
export const CODEX_TRANSCRIPT_SCHEMA_VERSION = 1 as const;

const DEFAULT_MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const MIN_MAX_EXPORT_BYTES = 2 * 1024;
const PROJECTED_EVENT_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "thread/archived",
  "thread/deleted",
  "thread/unarchived",
  "thread/closed",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "turn/diff/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
]);
export type CodexTranscriptEntryKind =
  | "thread"
  | "turn"
  | "item"
  | "interaction"
  | "branch"
  | "event"
  | "unknown"
  | "anomaly";

export type CodexTranscriptRedactionReason =
  | "canonical_source"
  | "secret_key"
  | "secret_value"
  | "secret_answer"
  | "raw_reasoning"
  | "raw_protocol"
  | "binary_data"
  | "artifact_location";

export type CodexTranscriptContentTruncationReason =
  | "string_length"
  | "array_items"
  | "object_entries"
  | "max_depth";

export interface CodexTranscriptContentLimits {
  maxStringCharacters: number;
  maxArrayItems: number;
  maxObjectEntries: number;
  maxDepth: number;
}

export interface CodexTranscriptBuildOptions {
  maxStringCharacters?: number;
  maxArrayItems?: number;
  maxObjectEntries?: number;
  maxDepth?: number;
}

export interface CodexTranscriptSource {
  projection: CanonicalCodexSessionState;
  /** Canonical envelopes returned by CodexEventStore.replay(), never legacy rollout JSONL. */
  events?: readonly CodexEventEnvelope[];
}

export interface CodexTranscriptEntry {
  id: string;
  kind: CodexTranscriptEntryKind;
  sequence: number;
  lastSequence?: number;
  occurredAtMs?: number;
  occurredAt?: string;
  completedAtMs?: number;
  completedAt?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  method?: string;
  status?: string;
  title: string;
  content: SafeJsonValue;
}

export interface CodexTranscriptOutputMetadata {
  format: "json" | "markdown";
  maxBytes: number;
  originalBytes: number;
  emittedBytes: number;
  truncated: boolean;
  strategy: "complete" | "canonical-prefix";
  retainedEntries: number;
  omittedEntries: number;
}

export interface CanonicalCodexTranscript {
  schema: {
    name: typeof CODEX_TRANSCRIPT_SCHEMA_NAME;
    version: typeof CODEX_TRANSCRIPT_SCHEMA_VERSION;
  };
  transcriptId: string;
  sessionId: string;
  source: {
    kind: "canonical_replay" | "canonical_projection";
    throughSequence: number;
    eventCount: number;
    runtimeIdentities: Array<{
      codexVersion: string;
      schemaHash: string;
      profile: "stable" | "experimental";
      experimentalApi: boolean;
    }>;
    limitations: string[];
  };
  entries: CodexTranscriptEntry[];
  metadata: {
    deterministic: true;
    redaction: {
      applied: boolean;
      count: number;
      counts: Record<CodexTranscriptRedactionReason, number>;
      opaqueArtifactRefs: number;
    };
    truncation: {
      truncated: boolean;
      limits: CodexTranscriptContentLimits;
      counts: Record<CodexTranscriptContentTruncationReason, number>;
      omittedCharacters: number;
      omittedCollectionItems: number;
    };
    output?: CodexTranscriptOutputMetadata;
  };
}

export interface CodexTranscriptExportOptions {
  maxBytes?: number;
}

export interface CodexTranscriptExportResult {
  format: "json" | "markdown";
  mediaType: "application/json" | "text/markdown";
  fileName: string;
  body: string;
  metadata: CodexTranscriptOutputMetadata;
}

export class CodexTranscriptExportLimitError extends Error {
  readonly maxBytes: number;
  readonly minimumBytes: number;

  constructor(maxBytes: number, minimumBytes: number) {
    super(
      `Codex transcript maxBytes ${maxBytes} cannot fit required metadata (${minimumBytes} bytes)`,
    );
    this.name = "CodexTranscriptExportLimitError";
    this.maxBytes = maxBytes;
    this.minimumBytes = minimumBytes;
  }
}

interface BuildContext {
  limits: CodexTranscriptContentLimits;
  redactionCounts: Record<CodexTranscriptRedactionReason, number>;
  truncationCounts: Record<CodexTranscriptContentTruncationReason, number>;
  omittedCharacters: number;
  omittedCollectionItems: number;
  artifactRefs: Set<string>;
}

interface SanitizeContext {
  method?: string;
  parentType?: string;
  key?: string;
  depth: number;
}

const ENTRY_KIND_ORDER: Record<CodexTranscriptEntryKind, number> = {
  thread: 0,
  turn: 1,
  branch: 2,
  interaction: 3,
  item: 4,
  event: 5,
  unknown: 6,
  anomaly: 7,
};

/**
 * Build a deterministic, safe transcript from the canonical projection and,
 * when available, its replay envelopes. No current clock, random ID, or legacy
 * provider rollout file participates in the result.
 */
export function buildCanonicalCodexTranscript(
  source: CodexTranscriptSource,
  options: CodexTranscriptBuildOptions = {},
): CanonicalCodexTranscript {
  const projection = structuredClone(source.projection);
  const events = [...(source.events ?? [])].sort(compareEvents);
  for (const event of events) {
    if (event.sessionId !== projection.sessionId) {
      throw new Error(
        `Cannot export mixed Codex sessions: expected ${projection.sessionId}, received ${event.sessionId}`,
      );
    }
  }

  const context = createBuildContext(options);
  context.redactionCounts.canonical_source = events.reduce(
    (count, event) => count + (event.payload.redactionCount ?? 0),
    0,
  );
  const eventBySequence = new Map(
    events.map((event) => [event.sequence, event]),
  );
  const unknownEventIds = new Set(
    projection.unknownEvents.map((event) => event.eventId),
  );
  const entries: CodexTranscriptEntry[] = [];

  addProjectionEntries(entries, projection, eventBySequence, context);
  if (events.length > 0) {
    addInteractionEntries(entries, events, context);
    addBranchEntries(entries, events, context);
    addProtocolEventEntries(entries, events, unknownEventIds, context);
  }
  addUnknownEntries(entries, projection, eventBySequence, context);
  addAnomalyEntries(entries, projection, eventBySequence);

  entries.sort(compareEntries);
  const runtimeIdentities = uniqueRuntimeIdentities(events);
  const redactionCount = sumRecord(context.redactionCounts);
  const truncationCount = sumRecord(context.truncationCounts);
  const throughSequence = Math.max(
    projection.lastSequence,
    events.at(-1)?.sequence ?? 0,
  );

  return {
    schema: {
      name: CODEX_TRANSCRIPT_SCHEMA_NAME,
      version: CODEX_TRANSCRIPT_SCHEMA_VERSION,
    },
    transcriptId: stableTranscriptId(projection.sessionId, throughSequence),
    sessionId: projection.sessionId,
    source: {
      kind: events.length > 0 ? "canonical_replay" : "canonical_projection",
      throughSequence,
      eventCount: events.length,
      runtimeIdentities,
      limitations:
        events.length > 0
          ? []
          : [
              "interaction payloads and record-only protocol events require canonical replay envelopes",
              "event receive timestamps require canonical replay envelopes",
            ],
    },
    entries,
    metadata: {
      deterministic: true,
      redaction: {
        applied: redactionCount > 0,
        count: redactionCount,
        counts: { ...context.redactionCounts },
        opaqueArtifactRefs: context.artifactRefs.size,
      },
      truncation: {
        truncated: truncationCount > 0,
        limits: { ...context.limits },
        counts: { ...context.truncationCounts },
        omittedCharacters: context.omittedCharacters,
        omittedCollectionItems: context.omittedCollectionItems,
      },
    },
  };
}

/** Pure convenience adapter for callers that only hold canonical replay events. */
export function buildCanonicalCodexTranscriptFromEvents(
  sessionId: string,
  events: readonly CodexEventEnvelope[],
  options: CodexTranscriptBuildOptions = {},
): CanonicalCodexTranscript {
  const projection = reduceCodexEvents(
    createCanonicalCodexSessionState(sessionId),
    events,
  );
  return buildCanonicalCodexTranscript({ projection, events }, options);
}

export function exportCanonicalCodexTranscriptJson(
  transcript: CanonicalCodexTranscript,
  options: CodexTranscriptExportOptions = {},
): CodexTranscriptExportResult {
  return exportWithEntryLimit(transcript, "json", options, renderJson);
}

export function exportCanonicalCodexTranscriptMarkdown(
  transcript: CanonicalCodexTranscript,
  options: CodexTranscriptExportOptions = {},
): CodexTranscriptExportResult {
  return exportWithEntryLimit(transcript, "markdown", options, renderMarkdown);
}

export function stableCodexTranscriptJson(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

function addProjectionEntries(
  entries: CodexTranscriptEntry[],
  projection: CanonicalCodexSessionState,
  eventBySequence: ReadonlyMap<number, CodexEventEnvelope>,
  context: BuildContext,
): void {
  const threads = Object.values(projection.threads).sort(
    (left, right) =>
      left.firstSequence - right.firstSequence ||
      compareStrings(left.id, right.id),
  );
  for (const thread of threads) {
    entries.push({
      id: `thread:${thread.id}`,
      kind: "thread",
      sequence: thread.firstSequence,
      lastSequence: thread.lastSequence,
      ...timeFields(eventTime(eventBySequence.get(thread.firstSequence))),
      threadId: thread.id,
      ...(thread.status === undefined ? {} : { status: thread.status }),
      title: "Thread",
      content: sanitizeValue(
        {
          lifecycle: thread.lifecycle ?? "active",
          turnCount: Object.keys(thread.turns).length,
        },
        context,
        { depth: 0 },
      ),
    });

    const turns = Object.values(thread.turns).sort(
      (left, right) =>
        left.firstSequence - right.firstSequence ||
        compareStrings(left.id, right.id),
    );
    for (const turn of turns) {
      const turnContent: SafeJsonObject = {
        itemCount: Object.keys(turn.items).length,
      };
      if (turn.plan !== undefined) turnContent.plan = turn.plan;
      if (turn.diff !== undefined) turnContent.diff = turn.diff;
      if (turn.error !== undefined) turnContent.error = turn.error;
      entries.push({
        id: `turn:${thread.id}:${turn.id}`,
        kind: "turn",
        sequence: turn.firstSequence,
        lastSequence: turn.lastSequence,
        ...timeFields(
          turn.startedAtMs ??
            eventTime(eventBySequence.get(turn.firstSequence)),
        ),
        ...completionTimeFields(turn.completedAtMs),
        threadId: thread.id,
        turnId: turn.id,
        status: turn.status,
        title: "Turn",
        content: sanitizeValue(turnContent, context, { depth: 0 }),
      });

      const items = Object.values(turn.items).sort(
        (left, right) =>
          left.firstSequence - right.firstSequence ||
          compareStrings(left.id, right.id),
      );
      for (const item of items) {
        entries.push({
          id: `item:${thread.id}:${turn.id}:${item.id}`,
          kind: "item",
          sequence: item.firstSequence,
          lastSequence: item.lastSequence,
          ...timeFields(
            item.startedAtMs ??
              eventTime(eventBySequence.get(item.firstSequence)),
          ),
          ...completionTimeFields(item.completedAtMs),
          threadId: thread.id,
          turnId: turn.id,
          itemId: item.id,
          status: item.status,
          title: itemTitle(item),
          content: itemContent(item, context),
        });
      }
    }
  }
}

function addInteractionEntries(
  entries: CodexTranscriptEntry[],
  events: readonly CodexEventEnvelope[],
  context: BuildContext,
): void {
  const responsesByCorrelation = responsesByCorrelationId(events);
  for (const request of events) {
    if (request.direction !== "server_request") continue;
    const response = responsesByCorrelation.get(request.correlationId);
    const requestPayload = asObject(request.payload.data);
    const content: SafeJsonObject = {
      request: sanitizeValue(request.payload.data, context, {
        method: request.method,
        depth: 0,
      }),
      resolution: response
        ? sanitizeValue(response.payload.data, context, {
            method: response.method,
            depth: 0,
          })
        : null,
      blocking: readBoolean(requestPayload, "isBlocking") ?? true,
    };
    entries.push({
      id: `interaction:${request.eventId}`,
      kind: "interaction",
      sequence: request.sequence,
      lastSequence: response?.sequence ?? request.sequence,
      ...timeFields(eventTime(request)),
      ...completionTimeFields(eventTime(response)),
      ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
      ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
      ...(request.itemId === undefined ? {} : { itemId: request.itemId }),
      method: request.method,
      status: response
        ? hasError(response.payload.data)
          ? "failed"
          : "resolved"
        : "open",
      title: "Interaction request",
      content,
    });
  }
}

function addBranchEntries(
  entries: CodexTranscriptEntry[],
  events: readonly CodexEventEnvelope[],
  context: BuildContext,
): void {
  const responsesByCorrelation = responsesByCorrelationId(events);
  for (const request of events) {
    if (
      request.direction !== "client_request" ||
      request.method !== "thread/fork"
    ) {
      continue;
    }
    const params = asObject(request.payload.data);
    const response = responsesByCorrelation.get(request.correlationId);
    const result = asObject(response?.payload.data);
    const forkedThread = asObject(result?.thread);
    const content: SafeJsonObject = {
      sourceThreadId:
        readString(params, "threadId") ?? request.threadId ?? "unknown",
      beforeTurnId: readString(params, "beforeTurnId") ?? null,
      lastTurnId: readString(params, "lastTurnId") ?? null,
      forkedThreadId: readString(forkedThread, "id") ?? null,
      sourcePreserved: true,
    };
    if (response && hasError(response.payload.data)) {
      content.error = sanitizeValue(response.payload.data, context, {
        method: response.method,
        depth: 0,
      });
    }
    entries.push({
      id: `branch:${request.eventId}`,
      kind: "branch",
      sequence: request.sequence,
      lastSequence: response?.sequence ?? request.sequence,
      ...timeFields(eventTime(request)),
      ...completionTimeFields(eventTime(response)),
      ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
      method: request.method,
      status: response
        ? hasError(response.payload.data)
          ? "failed"
          : "created"
        : "pending",
      title: "Branch lineage",
      content,
    });
  }
}

function addProtocolEventEntries(
  entries: CodexTranscriptEntry[],
  events: readonly CodexEventEnvelope[],
  unknownEventIds: ReadonlySet<string>,
  context: BuildContext,
): void {
  const serverRequestCorrelations = new Set(
    events
      .filter((event) => event.direction === "server_request")
      .map((event) => event.correlationId),
  );
  for (const event of events) {
    if (
      event.direction === "server_request" ||
      (event.direction === "client_response" &&
        serverRequestCorrelations.has(event.correlationId)) ||
      event.method === "thread/fork" ||
      PROJECTED_EVENT_METHODS.has(event.method) ||
      unknownEventIds.has(event.eventId)
    ) {
      continue;
    }
    const content: SafeJsonObject = {
      direction: event.direction,
      phase: event.phase,
      correlationId: event.correlationId,
      payload: sanitizeValue(event.payload.data, context, {
        method: event.method,
        depth: 0,
      }),
    };
    if (event.rawRef !== undefined) {
      content.rawRef = sanitizeText(event.rawRef, context);
    }
    if (event.payload.redactionCount !== undefined) {
      content.canonicalRedactionCount = event.payload.redactionCount;
    }
    if (event.payload.truncated) content.canonicalPayloadTruncated = true;
    entries.push({
      id: `event:${event.eventId}`,
      kind: "event",
      sequence: event.sequence,
      ...timeFields(eventTime(event)),
      ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
      method: event.method,
      status: event.phase,
      title: "Protocol event",
      content,
    });
  }
}

function addUnknownEntries(
  entries: CodexTranscriptEntry[],
  projection: CanonicalCodexSessionState,
  eventBySequence: ReadonlyMap<number, CodexEventEnvelope>,
  context: BuildContext,
): void {
  for (const unknown of [...projection.unknownEvents].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      compareStrings(left.eventId, right.eventId),
  )) {
    const event = eventBySequence.get(unknown.sequence);
    entries.push({
      id: `unknown:${unknown.eventId}`,
      kind: "unknown",
      sequence: unknown.sequence,
      ...timeFields(eventTime(event)),
      ...(event?.threadId === undefined ? {} : { threadId: event.threadId }),
      ...(event?.turnId === undefined ? {} : { turnId: event.turnId }),
      ...(event?.itemId === undefined ? {} : { itemId: event.itemId }),
      method: unknown.method,
      status: unknown.compatibility,
      title: "Unknown protocol event",
      content: {
        direction: unknown.direction,
        compatibility: unknown.compatibility,
        payload: sanitizeValue(unknown.payload.data, context, {
          method: unknown.method,
          depth: 0,
        }),
      },
    });
  }
}

function addAnomalyEntries(
  entries: CodexTranscriptEntry[],
  projection: CanonicalCodexSessionState,
  eventBySequence: ReadonlyMap<number, CodexEventEnvelope>,
): void {
  for (const anomaly of [...projection.anomalies].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.eventId, right.eventId),
  )) {
    entries.push({
      id: `anomaly:${anomaly.eventId}:${anomaly.kind}:${anomaly.sequence}`,
      kind: "anomaly",
      sequence: anomaly.sequence,
      ...timeFields(eventTime(eventBySequence.get(anomaly.sequence))),
      ...(anomaly.threadId === undefined ? {} : { threadId: anomaly.threadId }),
      ...(anomaly.turnId === undefined ? {} : { turnId: anomaly.turnId }),
      ...(anomaly.itemId === undefined ? {} : { itemId: anomaly.itemId }),
      method: anomaly.method,
      status: anomaly.kind,
      title: "Canonical replay anomaly",
      content: {
        eventId: anomaly.eventId,
        anomaly: anomaly.kind,
      },
    });
  }
}

function itemContent(
  item: CanonicalCodexItemState,
  context: BuildContext,
): SafeJsonValue {
  const snapshot = item.snapshot ?? {};
  if (item.kind === "reasoning") {
    const snapshotSummary = Array.isArray(snapshot.summary)
      ? snapshot.summary
      : undefined;
    const summary =
      snapshotSummary && snapshotSummary.length > 0
        ? snapshotSummary
        : (item.stream.reasoningSummary ?? []);
    const snapshotContent = snapshot.content;
    return {
      summary: sanitizeValue(summary, context, {
        parentType: "reasoning",
        key: "summary",
        depth: 0,
      }),
      rawReasoning: sanitizeValue(
        snapshotContent ?? item.stream.reasoningContent ?? [],
        context,
        { depth: 0 },
      ),
      lateDeltaCount: item.lateDeltaCount,
    };
  }

  const visibleStream: SafeJsonObject = {};
  if (item.stream.assistantText !== undefined) {
    visibleStream.assistantText = item.stream.assistantText;
  }
  if (item.stream.planText !== undefined) {
    visibleStream.planText = item.stream.planText;
  }
  if (item.stream.commandOutput !== undefined) {
    visibleStream.commandOutput = item.stream.commandOutput;
  }
  if (item.stream.fileChangeOutput !== undefined) {
    visibleStream.fileChangeOutput = item.stream.fileChangeOutput;
  }
  if (item.stream.patchChanges !== undefined) {
    visibleStream.patchChanges = item.stream.patchChanges;
  }
  if (item.stream.mcpProgress !== undefined) {
    visibleStream.mcpProgress = item.stream.mcpProgress;
  }
  if (item.stream.terminalInteractions !== undefined) {
    visibleStream.terminalInteractions = item.stream.terminalInteractions;
  }
  const content: SafeJsonObject = {
    nativeType: item.nativeType,
    canonicalKind: item.kind,
    snapshot,
    stream: visibleStream,
    lateDeltaCount: item.lateDeltaCount,
  };
  return sanitizeValue(content, context, {
    parentType: item.nativeType,
    depth: 0,
  });
}

function itemTitle(item: CanonicalCodexItemState): string {
  switch (item.kind) {
    case "user_message":
      return "User";
    case "assistant_message":
      return "Assistant";
    case "plan":
      return "Plan";
    case "reasoning":
      return "Reasoning summary";
    case "command_execution":
      return "Command execution";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Dynamic tool call";
    case "function_call_output":
      return "Function call output";
    case "collab_agent_tool_call":
      return "Collaboration tool call";
    case "subagent_activity":
      return "Subagent activity";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "sleep":
      return "Sleep";
    case "image_generation":
      return "Image generation";
    case "hook_prompt":
      return "Hook prompt";
    case "review_entered":
      return "Entered review mode";
    case "review_exited":
      return "Exited review mode";
    case "context_compaction":
      return "Context compaction";
    case "unknown":
      return `Unknown item (${item.nativeType})`;
  }
}

function sanitizeValue(
  input: unknown,
  context: BuildContext,
  location: SanitizeContext,
): SafeJsonValue {
  const { parentType, method, depth } = location;
  if (input === null) return null;
  if (typeof input === "boolean") return input;
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : String(input);
  }
  if (typeof input === "string") {
    return sanitizeText(input, context);
  }
  if (
    typeof input === "undefined" ||
    typeof input === "function" ||
    typeof input === "symbol" ||
    typeof input === "bigint"
  ) {
    return input === undefined ? null : String(input);
  }
  if (depth >= context.limits.maxDepth) {
    context.truncationCounts.max_depth += 1;
    return "[TRUNCATED:max-depth]";
  }
  if (Array.isArray(input)) {
    if (input.length > context.limits.maxArrayItems) {
      context.truncationCounts.array_items += 1;
      context.omittedCollectionItems +=
        input.length - context.limits.maxArrayItems;
    }
    return input.slice(0, context.limits.maxArrayItems).map((value) => {
      return sanitizeValue(value, context, {
        method,
        parentType,
        depth: depth + 1,
      });
    });
  }
  const object = input as Record<string, unknown>;
  const objectType = typeof object.type === "string" ? object.type : parentType;
  const entries = Object.entries(object).sort(([left], [right]) =>
    compareStrings(left, right),
  );
  if (entries.length > context.limits.maxObjectEntries) {
    context.truncationCounts.object_entries += 1;
    context.omittedCollectionItems +=
      entries.length - context.limits.maxObjectEntries;
  }
  const output: SafeJsonObject = {};
  for (const [entryKey, value] of entries.slice(
    0,
    context.limits.maxObjectEntries,
  )) {
    output[entryKey] = sanitizeValue(value, context, {
      method,
      parentType: objectType,
      key: entryKey,
      depth: depth + 1,
    });
  }
  return output;
}

function sanitizeText(value: string, context: BuildContext): string {
  let output = stripTerminalControls(value);
  if (output.length > context.limits.maxStringCharacters) {
    context.truncationCounts.string_length += 1;
    context.omittedCharacters +=
      output.length - context.limits.maxStringCharacters;
    output = `${safeStringSlice(output, context.limits.maxStringCharacters)}[TRUNCATED:${output.length - context.limits.maxStringCharacters}]`;
  }
  return output;
}

function exportWithEntryLimit(
  transcript: CanonicalCodexTranscript,
  format: "json" | "markdown",
  options: CodexTranscriptExportOptions,
  renderer: (
    document: CanonicalCodexTranscript,
    output: CodexTranscriptOutputMetadata,
  ) => string,
): CodexTranscriptExportResult {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const totalEntries = transcript.entries.length;
  let originalBytes = 0;
  for (let index = 0; index < 8; index += 1) {
    const metadata = outputMetadata(
      format,
      maxBytes,
      originalBytes,
      originalBytes,
      false,
      totalEntries,
      0,
    );
    const next = byteLength(
      renderer(withOutput(transcript, metadata), metadata),
    );
    if (next === originalBytes) break;
    originalBytes = next;
  }

  const renderCount = (
    entryCount: number,
  ): { body: string; metadata: CodexTranscriptOutputMetadata } => {
    const truncated = entryCount < totalEntries;
    let emittedBytes = 0;
    let body = "";
    let metadata = outputMetadata(
      format,
      maxBytes,
      originalBytes,
      emittedBytes,
      truncated,
      entryCount,
      totalEntries - entryCount,
    );
    for (let index = 0; index < 8; index += 1) {
      const document = withOutput(
        { ...transcript, entries: transcript.entries.slice(0, entryCount) },
        metadata,
      );
      body = renderer(document, metadata);
      const next = byteLength(body);
      if (next === emittedBytes) break;
      emittedBytes = next;
      metadata = { ...metadata, emittedBytes };
    }
    return { body, metadata };
  };

  const complete = renderCount(totalEntries);
  if (complete.metadata.emittedBytes <= maxBytes) {
    return exportResult(transcript, format, complete);
  }

  let low = 0;
  let high = totalEntries;
  let best = renderCount(0);
  if (best.metadata.emittedBytes > maxBytes) {
    throw new CodexTranscriptExportLimitError(
      maxBytes,
      best.metadata.emittedBytes,
    );
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = renderCount(middle);
    if (candidate.metadata.emittedBytes <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return exportResult(transcript, format, best);
}

function exportResult(
  transcript: CanonicalCodexTranscript,
  format: "json" | "markdown",
  rendered: { body: string; metadata: CodexTranscriptOutputMetadata },
): CodexTranscriptExportResult {
  return {
    format,
    mediaType: format === "json" ? "application/json" : "text/markdown",
    fileName: `codex-transcript-${safeFileSegment(transcript.sessionId)}.${format === "json" ? "json" : "md"}`,
    body: rendered.body,
    metadata: rendered.metadata,
  };
}

function renderJson(
  document: CanonicalCodexTranscript,
  _output: CodexTranscriptOutputMetadata,
): string {
  return stableCodexTranscriptJson(document);
}

function renderMarkdown(
  document: CanonicalCodexTranscript,
  output: CodexTranscriptOutputMetadata,
): string {
  const lines = [
    "# Codex canonical transcript",
    "",
    `- Transcript: \`${markdownInline(document.transcriptId)}\``,
    `- Session: \`${markdownInline(document.sessionId)}\``,
    `- Source: \`${document.source.kind}\``,
    `- Through sequence: ${document.source.throughSequence}`,
    `- Canonical events: ${document.source.eventCount}`,
    `- Redactions: ${document.metadata.redaction.count}`,
    `- Opaque artifact refs: ${document.metadata.redaction.opaqueArtifactRefs}`,
    `- Content truncated: ${document.metadata.truncation.truncated ? "yes" : "no"}`,
    `- Output: ${output.emittedBytes}/${output.originalBytes} bytes${output.truncated ? `; ${output.omittedEntries} timeline entries omitted` : ""}`,
  ];
  if (document.source.limitations.length > 0) {
    lines.push("", "## Export limitations", "");
    for (const limitation of document.source.limitations) {
      lines.push(`- ${markdownText(limitation)}`);
    }
  }
  for (const entry of document.entries) {
    lines.push("", `## ${markdownText(entry.title)}`, "");
    lines.push(
      `- Entry: \`${markdownInline(entry.id)}\``,
      `- Kind: \`${entry.kind}\``,
      `- Sequence: ${entry.sequence}${entry.lastSequence === undefined ? "" : `–${entry.lastSequence}`}`,
    );
    if (entry.occurredAt) lines.push(`- Time: \`${entry.occurredAt}\``);
    if (entry.completedAt) lines.push(`- Completed: \`${entry.completedAt}\``);
    if (entry.threadId)
      lines.push(`- Thread: \`${markdownInline(entry.threadId)}\``);
    if (entry.turnId) lines.push(`- Turn: \`${markdownInline(entry.turnId)}\``);
    if (entry.itemId) lines.push(`- Item: \`${markdownInline(entry.itemId)}\``);
    if (entry.method)
      lines.push(`- Method: \`${markdownInline(entry.method)}\``);
    if (entry.status)
      lines.push(`- Status: \`${markdownInline(entry.status)}\``);
    lines.push("", fencedJson(entry.content));
  }
  if (output.truncated) {
    lines.push(
      "",
      "## Transcript truncated",
      "",
      `${output.omittedEntries} later canonical timeline entries were omitted by the ${output.maxBytes}-byte export limit.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function fencedJson(value: SafeJsonValue): string {
  const json = stableCodexTranscriptJson(value).trimEnd();
  const longestFence = Math.max(
    2,
    ...[...json.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longestFence + 1);
  return `${fence}json\n${json}\n${fence}`;
}

function withOutput(
  transcript: CanonicalCodexTranscript,
  output: CodexTranscriptOutputMetadata,
): CanonicalCodexTranscript {
  return {
    ...transcript,
    metadata: {
      ...transcript.metadata,
      output,
    },
  };
}

function outputMetadata(
  format: "json" | "markdown",
  maxBytes: number,
  originalBytes: number,
  emittedBytes: number,
  truncated: boolean,
  retainedEntries: number,
  omittedEntries: number,
): CodexTranscriptOutputMetadata {
  return {
    format,
    maxBytes,
    originalBytes,
    emittedBytes,
    truncated,
    strategy: truncated ? "canonical-prefix" : "complete",
    retainedEntries,
    omittedEntries,
  };
}

function createBuildContext(
  options: CodexTranscriptBuildOptions,
): BuildContext {
  return {
    limits: {
      maxStringCharacters: positiveInteger(
        options.maxStringCharacters,
        64 * 1024,
      ),
      maxArrayItems: positiveInteger(options.maxArrayItems, 2_000),
      maxObjectEntries: positiveInteger(options.maxObjectEntries, 2_000),
      maxDepth: positiveInteger(options.maxDepth, 24),
    },
    redactionCounts: {
      canonical_source: 0,
      secret_key: 0,
      secret_value: 0,
      secret_answer: 0,
      raw_reasoning: 0,
      raw_protocol: 0,
      binary_data: 0,
      artifact_location: 0,
    },
    truncationCounts: {
      string_length: 0,
      array_items: 0,
      object_entries: 0,
      max_depth: 0,
    },
    omittedCharacters: 0,
    omittedCollectionItems: 0,
    artifactRefs: new Set(),
  };
}

function responsesByCorrelationId(
  events: readonly CodexEventEnvelope[],
): ReadonlyMap<string, CodexEventEnvelope> {
  const responses = new Map<string, CodexEventEnvelope>();
  for (const event of events) {
    if (event.direction !== "client_response" || event.phase !== "resolved") {
      continue;
    }
    const current = responses.get(event.correlationId);
    if (!current || compareEvents(event, current) < 0) {
      responses.set(event.correlationId, event);
    }
  }
  return responses;
}

function uniqueRuntimeIdentities(
  events: readonly CodexEventEnvelope[],
): CanonicalCodexTranscript["source"]["runtimeIdentities"] {
  const identities = new Map<
    string,
    CanonicalCodexTranscript["source"]["runtimeIdentities"][number]
  >();
  for (const event of events) {
    const identity = event.runtime;
    const key = `${identity.codexVersion}\0${identity.schemaHash}\0${identity.profile}\0${identity.experimentalApi}`;
    identities.set(key, structuredClone(identity));
  }
  return [...identities.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, identity]) => identity);
}

function stableTranscriptId(
  sessionId: string,
  throughSequence: number,
): string {
  const digest = createHash("sha256")
    .update(`${sessionId}\0${throughSequence}`)
    .digest("hex")
    .slice(0, 24);
  return `transcript:sha256:${digest}`;
}

function eventTime(event: CodexEventEnvelope | undefined): number | undefined {
  return (
    event?.appServerEmittedAtMs ?? event?.receivedAtMs ?? event?.persistedAtMs
  );
}

function timeFields(
  milliseconds: number | undefined,
): Pick<CodexTranscriptEntry, "occurredAtMs" | "occurredAt"> {
  const iso = stableIsoTime(milliseconds);
  return milliseconds === undefined || iso === undefined
    ? {}
    : { occurredAtMs: milliseconds, occurredAt: iso };
}

function completionTimeFields(
  milliseconds: number | undefined,
): Pick<CodexTranscriptEntry, "completedAtMs" | "completedAt"> {
  const iso = stableIsoTime(milliseconds);
  return milliseconds === undefined || iso === undefined
    ? {}
    : { completedAtMs: milliseconds, completedAt: iso };
}

function stableIsoTime(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined || !Number.isFinite(milliseconds))
    return undefined;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return undefined;
  }
}

function compareEvents(
  left: CodexEventEnvelope,
  right: CodexEventEnvelope,
): number {
  return (
    left.sequence - right.sequence ||
    compareStrings(left.eventId, right.eventId)
  );
}

function compareEntries(
  left: CodexTranscriptEntry,
  right: CodexTranscriptEntry,
): number {
  return (
    left.sequence - right.sequence ||
    ENTRY_KIND_ORDER[left.kind] - ENTRY_KIND_ORDER[right.kind] ||
    compareStrings(left.id, right.id)
  );
}

function asObject(value: unknown): SafeJsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SafeJsonObject)
    : undefined;
}

function readString(
  object: SafeJsonObject | undefined,
  key: string,
): string | undefined {
  const value = object?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(
  object: SafeJsonObject | undefined,
  key: string,
): boolean | undefined {
  const value = object?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function hasError(value: SafeJsonValue): boolean {
  const object = asObject(value);
  return object?.error !== undefined && object.error !== null;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    if (entry !== undefined) output[key] = sortJsonValue(entry);
  }
  return output;
}

function sumRecord<T extends string>(record: Record<T, number>): number {
  return Object.values<number>(record).reduce((sum, count) => sum + count, 0);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? DEFAULT_MAX_EXPORT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_MAX_EXPORT_BYTES) {
    throw new RangeError(
      `Codex transcript maxBytes must be an integer >= ${MIN_MAX_EXPORT_BYTES}`,
    );
  }
  return maxBytes;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      "Codex transcript content limits must be positive integers",
    );
  }
  return value;
}

function safeStringSlice(value: string, length: number): string {
  let output = value.slice(0, length);
  const last = output.charCodeAt(output.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) output = output.slice(0, -1);
  return output;
}

function safeFileSegment(value: string): string {
  const segment = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return segment || "session";
}

function markdownInline(value: string): string {
  return markdownText(value).replace(/`/g, "'");
}

function markdownText(value: string): string {
  return stripTerminalControls(value)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripTerminalControls(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current >= 0x40 && current <= 0x7e) break;
          index += 1;
        }
      } else if (next === 0x5d) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current === 0x07) break;
          if (current === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
            index += 1;
            break;
          }
          index += 1;
        }
      } else {
        index += 1;
      }
      continue;
    }
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code !== 0x7f)
    ) {
      output += value[index];
    }
  }
  return output;
}
