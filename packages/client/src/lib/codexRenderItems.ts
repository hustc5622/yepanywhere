import type {
  CodexThreadItemType,
  GeneratedArtifactManifest,
  InteractionOperation,
  InteractionOperationKind,
  InteractionRenderItem,
  NativeDecisionDescriptor,
  RenderItemLifecycleStatus,
  SafeInteractionQuestion,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import {
  CODEX_THREAD_ITEM_RENDER_POLICY,
  isGeneratedArtifactDownloadUrl,
} from "@yep-anywhere/shared";
import type { InputRequest, Message } from "../types";
import type { RenderItem } from "../types/renderItems";
import { getMessageId } from "./mergeMessages";

export interface CodexThreadItemRecord {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface CodexThreadItemSnapshot {
  item: CodexThreadItemRecord;
  threadId?: string;
  turnId?: string;
  timestamp?: string;
  sequence?: number;
  lifecycle?: "started" | "completed";
  /** Raw reasoning is only rendered when an explicit, policy-backed opt-in is present. */
  rawReasoningAllowed?: boolean;
  sourceMessage?: Message;
}

export interface SelectCodexRenderItemsInput {
  persisted?: readonly CodexThreadItemSnapshot[];
  live?: readonly CodexThreadItemSnapshot[];
  interactions?: readonly InteractionOperation[];
}

export interface InputRequestInteractionResolution {
  operationId: string;
  version: number;
  decisionId: string;
  value?: unknown;
}

export type InputRequestInteractionResponse = {
  response:
    | "approve"
    | "approve_accept_edits"
    | "approve_for_session"
    | "approve_strict_auto_review"
    | "approve_always"
    | "deny";
  answers?: UserQuestionAnswers;
};

const TERMINAL_STATUSES = new Set<RenderItemLifecycleStatus>([
  "complete",
  "error",
  "declined",
  "cancelled",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string")
    : [];
}

function safeAgentStates(value: unknown): Record<string, string> | undefined {
  const states = asRecord(value);
  if (!states) return undefined;
  const safe = Object.fromEntries(
    Object.entries(states).flatMap(([threadId, state]) => {
      const status = asString(asRecord(state)?.status);
      return status ? [[threadId, status]] : [];
    }),
  );
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function truncate(value: string, limit = 800): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function normalizeStatus(
  value: unknown,
  lifecycle: CodexThreadItemSnapshot["lifecycle"],
): RenderItemLifecycleStatus {
  const normalized =
    typeof value === "string"
      ? value.toLowerCase().replaceAll("_", "").replaceAll("-", "")
      : "";
  if (normalized === "inprogress" || normalized === "running") return "running";
  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "success"
  ) {
    return "complete";
  }
  if (normalized === "failed" || normalized === "error") return "error";
  if (normalized === "declined") return "declined";
  if (normalized === "cancelled" || normalized === "canceled")
    return "cancelled";
  return lifecycle === "completed" ? "complete" : "pending";
}

function commonFields(snapshot: CodexThreadItemSnapshot, itemId: string) {
  const nativeType = snapshot.item.type;
  const sourceMessages = snapshot.sourceMessage ? [snapshot.sourceMessage] : [];
  return {
    id: snapshot.turnId ? `${itemId}-${snapshot.turnId}` : itemId,
    sourceMessages,
    provider: "codex",
    threadId: snapshot.threadId,
    turnId: snapshot.turnId,
    providerItemId: itemId,
    nativeType,
    providerLifecycle: snapshot.lifecycle,
    createdAt: snapshot.timestamp,
    updatedAt: snapshot.timestamp,
    redaction: { level: "none" as const },
  };
}

function getUserMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      if (!record) return "";
      switch (record.type) {
        case "text":
          return asString(record.text) ?? "";
        case "skill":
          return asString(record.name) ? `$${record.name}` : "[Skill]";
        case "mention":
          return asString(record.name) ? `@${record.name}` : "[Mention]";
        case "image":
          return "[Image]";
        case "localImage":
          return `[Image: ${asString(record.path) ?? "attached"}]`;
        case "audio":
          return "[Audio]";
        case "localAudio":
          return `[Audio: ${asString(record.path) ?? "attached"}]`;
        default:
          return "[Attachment]";
      }
    })
    .filter(Boolean)
    .join("\n");
}

function getMcpResultSummary(value: unknown): string | undefined {
  const result = asRecord(value);
  if (!result) return asString(value);
  const content = Array.isArray(result.content) ? result.content : [];
  const textParts = content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== undefined)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
  if (textParts.length > 0) return truncate(textParts.join("\n"));
  if (content.length > 0) return `${content.length} content item(s)`;
  return result.structuredContent !== undefined
    ? "Structured result available"
    : undefined;
}

function getWebAction(value: unknown): string | undefined {
  const action = asRecord(value);
  if (!action) return undefined;
  const type = asString(action.type);
  if (!type) return undefined;
  const target = asString(action.url) ?? asString(action.pattern);
  return target ? `${type}: ${truncate(target, 240)}` : type;
}

function dynamicContent(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((part) => {
    const record = asRecord(part);
    if (!record) return { type: "unknown" as const };
    if (record.type === "inputText") {
      return { type: "text" as const, text: asString(record.text) ?? "" };
    }
    if (record.type === "inputImage") {
      return { type: "image" as const, url: asString(record.imageUrl) };
    }
    if (record.type === "inputAudio") {
      return { type: "audio" as const, url: asString(record.audioUrl) };
    }
    return { type: "unknown" as const };
  });
}

function fileChanges(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((change) => {
    const record = asRecord(change);
    const path = asString(record?.path);
    if (!record || !path) return [];
    return [
      {
        path,
        kind: asString(record.kind) ?? asString(asRecord(record.kind)?.type),
        diff: asString(record.diff),
      },
    ];
  });
}

function generatedArtifacts(
  sourceMessage: Message | undefined,
): GeneratedArtifactManifest[] | undefined {
  const value = sourceMessage?.codexGeneratedArtifacts;
  if (!Array.isArray(value)) return undefined;
  const artifacts = value.flatMap((candidate) => {
    const artifact = asRecord(candidate);
    const source = asRecord(artifact?.source);
    const retention = asRecord(artifact?.retention);
    const id = asString(artifact?.id);
    const managedRef = asString(artifact?.managedRef);
    const fileName = asString(artifact?.fileName);
    const kind = asString(artifact?.kind);
    const mimeType = asString(artifact?.mimeType);
    const sha256 = asString(artifact?.sha256);
    const downloadUrl = asString(artifact?.downloadUrl);
    const previewUrl = asString(artifact?.previewUrl);
    const sourceType = asString(source?.type);
    const threadId = asString(source?.threadId);
    const turnId = asString(source?.turnId);
    const itemId = asString(source?.itemId);
    const expiresAt = asString(retention?.expiresAt);
    if (
      artifact?.schemaVersion !== 1 ||
      !id ||
      !/^ga_[a-f0-9]{32}$/.test(id) ||
      !managedRef ||
      !/^upload:[a-f0-9-]{36}$/.test(managedRef) ||
      !fileName ||
      fileName.length > 120 ||
      hasUnsafeGeneratedArtifactName(fileName) ||
      ![
        "image",
        "document",
        "spreadsheet",
        "presentation",
        "text",
        "video",
      ].includes(kind ?? "") ||
      !mimeType ||
      mimeType.length > 160 ||
      !sha256 ||
      !/^sha256:[a-f0-9]{64}$/.test(sha256) ||
      !downloadUrl ||
      !isGeneratedArtifactDownloadUrl(downloadUrl) ||
      !downloadUrl.endsWith(
        `/generated-artifact/${id}/${sha256.slice(
          "sha256:".length,
        )}/${encodeURIComponent(fileName)}`,
      ) ||
      typeof artifact.sizeBytes !== "number" ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0 ||
      artifact.sizeBytes > 30 * 1024 * 1024 ||
      source?.provider !== "codex" ||
      (sourceType !== "image_generation" && sourceType !== "file_change") ||
      !threadId ||
      !turnId ||
      !itemId ||
      retention?.policy !== "temporary" ||
      !expiresAt ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      (previewUrl !== undefined &&
        (kind !== "image" || previewUrl !== downloadUrl))
    ) {
      return [];
    }
    return [
      {
        schemaVersion: 1,
        id,
        managedRef,
        fileName,
        kind: kind as GeneratedArtifactManifest["kind"],
        mimeType,
        sizeBytes: artifact.sizeBytes,
        sha256,
        source: {
          provider: "codex",
          type: sourceType,
          threadId,
          turnId,
          itemId,
        },
        retention: { policy: "temporary", expiresAt },
        downloadUrl,
        ...(previewUrl ? { previewUrl } : {}),
      } satisfies GeneratedArtifactManifest,
    ];
  });
  return artifacts.length > 0 ? artifacts : undefined;
}

function hasUnsafeGeneratedArtifactName(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      character === "/" ||
      character === "\\"
    ) {
      return true;
    }
  }
  return false;
}

function safeUnknownSummary(item: CodexThreadItemRecord): string {
  const keys = Object.keys(item)
    .filter((key) => key !== "id" && key !== "type")
    .slice(0, 8);
  return keys.length > 0
    ? `Fields: ${keys.join(", ")}`
    : "No user-visible details";
}

/**
 * Convert one native app-server ThreadItem snapshot into the shared render
 * model. The switch is exhaustive for the generated 0.147.0 stable schema;
 * future types are visible through UnknownItemCard instead of disappearing.
 */
export function renderCodexThreadItem(
  snapshot: CodexThreadItemSnapshot,
): RenderItem {
  const item = snapshot.item;
  const providerItemId =
    asString(item.id) ?? `unknown-${snapshot.sequence ?? 0}`;
  const common = commonFields(snapshot, providerItemId);
  const status = normalizeStatus(item.status, snapshot.lifecycle);

  switch (item.type as CodexThreadItemType) {
    case "userMessage":
      return {
        ...common,
        type: "user_prompt",
        content: getUserMessageText(item.content),
      };
    case "hookPrompt":
      return {
        ...common,
        type: "hook",
        fragments: Array.isArray(item.fragments)
          ? item.fragments.flatMap((fragment) => {
              const record = asRecord(fragment);
              const text = asString(record?.text);
              return text
                ? [{ text, hookRunId: asString(record?.hookRunId) }]
                : [];
            })
          : [],
        status,
      };
    case "agentMessage": {
      const phase = item.phase;
      return {
        ...common,
        type: "text",
        text: asString(item.text) ?? "",
        ...(phase === "commentary" || phase === "final_answer"
          ? { phase }
          : {}),
        isStreaming: snapshot.lifecycle !== "completed",
      };
    }
    case "plan":
      return {
        ...common,
        type: "plan",
        text: asString(item.text) ?? "",
        status,
      };
    case "reasoning": {
      const summary = strings(item.summary);
      const rawContent = strings(item.content);
      return {
        ...common,
        sourceMessages: snapshot.rawReasoningAllowed
          ? common.sourceMessages
          : [],
        type: "reasoning",
        summary,
        // Do not retain raw reasoning in the normal client render model unless
        // an explicit upstream policy gate has allowed it.
        content: snapshot.rawReasoningAllowed ? rawContent : [],
        visibility: snapshot.rawReasoningAllowed
          ? "raw_allowed"
          : summary.length > 0
            ? "summary_only"
            : "redacted",
        status,
        redaction: snapshot.rawReasoningAllowed
          ? { level: "none" }
          : {
              level: "partial",
              hiddenFields: ["content"],
              ...(rawContent.length > 0
                ? { reason: "Raw reasoning hidden by policy" }
                : {}),
            },
      };
    }
    case "commandExecution":
      return {
        ...common,
        type: "command",
        command: asString(item.command) ?? "",
        cwd: asString(item.cwd),
        processId: asString(item.processId),
        source: asString(item.source),
        pluginId: asString(item.pluginId),
        scriptPath: asString(item.scriptPath),
        output:
          typeof item.aggregatedOutput === "string"
            ? item.aggregatedOutput
            : undefined,
        exitCode: asNumber(item.exitCode),
        durationMs: asNumber(item.durationMs),
        status,
      };
    case "fileChange":
      return {
        ...common,
        type: "file_change",
        changes: fileChanges(item.changes),
        artifacts: generatedArtifacts(snapshot.sourceMessage),
        status,
      };
    case "mcpToolCall": {
      const appContext = asRecord(item.appContext);
      const error = asRecord(item.error);
      return {
        ...common,
        type: "mcp_tool",
        server: asString(item.server) ?? "unknown",
        tool: asString(item.tool) ?? "unknown",
        pluginId: asString(item.pluginId),
        appName: asString(appContext?.appName),
        actionName: asString(appContext?.actionName),
        readOnly: asBoolean(item.readOnlyHint),
        resultSummary: getMcpResultSummary(item.result),
        error: asString(error?.message),
        durationMs: asNumber(item.durationMs),
        status,
      };
    }
    case "dynamicToolCall":
      return {
        ...common,
        type: "dynamic_tool",
        namespace: asString(item.namespace),
        tool: asString(item.tool) ?? "unknown",
        contentItems: dynamicContent(item.contentItems),
        success: asBoolean(item.success),
        durationMs: asNumber(item.durationMs),
        status,
      };
    case "collabAgentToolCall":
      return {
        ...common,
        sourceMessages: [],
        type: "subagent",
        activity: asString(item.tool) ?? "activity",
        agentThreadIds: strings(item.receiverThreadIds),
        senderThreadId: asString(item.senderThreadId),
        model: asString(item.model),
        reasoningEffort: asString(item.reasoningEffort),
        agentStates: safeAgentStates(item.agentsStates),
        status,
        isSubagent: true,
        redaction: {
          level: "partial",
          hiddenFields: ["prompt", "agentsStates.message"],
          reason: "Internal subagent content hidden by policy",
        },
      };
    case "subAgentActivity":
      return {
        ...common,
        sourceMessages: [],
        type: "subagent",
        activity: asString(item.kind) ?? "activity",
        agentThreadIds: asString(item.agentThreadId)
          ? [item.agentThreadId as string]
          : [],
        status,
        isSubagent: true,
        redaction: {
          level: "partial",
          hiddenFields: ["agentPath"],
          reason: "Internal subagent path hidden by policy",
        },
      };
    case "webSearch":
      return {
        ...common,
        type: "web_search",
        query: asString(item.query) ?? "",
        action: getWebAction(item.action),
        resultCount: Array.isArray(item.results)
          ? item.results.length
          : undefined,
        status,
      };
    case "imageView":
      return {
        ...common,
        type: "image",
        mode: "view",
        path: asString(item.path),
        status,
      };
    case "sleep":
      return {
        ...common,
        type: "sleep",
        durationMs: asNumber(item.durationMs) ?? 0,
        status,
      };
    case "imageGeneration":
      return {
        ...common,
        type: "image",
        mode: "generation",
        // A provider supplied savedPath is never a browser capability. Only a
        // server-materialized manifest may expose preview/download controls.
        artifacts: generatedArtifacts(snapshot.sourceMessage),
        prompt: asString(item.revisedPrompt),
        transparentBackground: asBoolean(item.transparentBackground),
        status,
        redaction: asString(item.savedPath)
          ? {
              level: "partial",
              hiddenFields: ["savedPath"],
              reason: "Local generated path hidden by policy",
            }
          : common.redaction,
      };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return {
        ...common,
        type: "review",
        phase: item.type === "enteredReviewMode" ? "entered" : "exited",
        review: asString(item.review) ?? "",
        status,
      };
    case "contextCompaction":
      return { ...common, type: "compaction", status };
    default:
      return {
        ...common,
        sourceMessages: [],
        type: "unknown",
        originalType: item.type,
        safeSummary: safeUnknownSummary(item),
        status,
        redaction: { level: "partial", reason: "Unrecognized provider item" },
      };
  }
}

function itemDedupeKey(item: RenderItem): string {
  return [
    item.threadId ?? "",
    item.turnId ?? "",
    item.providerItemId ?? item.id,
    item.nativeType ?? item.type,
  ].join("\0");
}

function statusOf(item: RenderItem): RenderItemLifecycleStatus | undefined {
  return "status" in item && typeof item.status === "string"
    ? (item.status as RenderItemLifecycleStatus)
    : undefined;
}

function shouldReplace(existing: RenderItem, incoming: RenderItem): boolean {
  if (
    incoming.providerLifecycle === "completed" &&
    existing.providerLifecycle !== "completed"
  ) {
    return true;
  }
  if (
    existing.providerLifecycle === "completed" &&
    incoming.providerLifecycle !== "completed"
  ) {
    return false;
  }
  const existingStatus = statusOf(existing);
  const incomingStatus = statusOf(incoming);
  if (
    incomingStatus &&
    TERMINAL_STATUSES.has(incomingStatus) &&
    (!existingStatus || !TERMINAL_STATUSES.has(existingStatus))
  ) {
    return true;
  }
  if (
    existingStatus &&
    TERMINAL_STATUSES.has(existingStatus) &&
    incomingStatus &&
    !TERMINAL_STATUSES.has(incomingStatus)
  ) {
    return false;
  }
  const existingTime = Date.parse(
    existing.updatedAt ?? existing.createdAt ?? "",
  );
  const incomingTime = Date.parse(
    incoming.updatedAt ?? incoming.createdAt ?? "",
  );
  return (
    !Number.isFinite(existingTime) ||
    !Number.isFinite(incomingTime) ||
    incomingTime >= existingTime
  );
}

function mergeSources(first: Message[], second: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const source of [...first, ...second]) {
    byId.set(
      getMessageId(source) ||
        `${source.type ?? "unknown"}:${source.timestamp ?? byId.size}`,
      source,
    );
  }
  return [...byId.values()];
}

function mergedSourcesFor(
  chosen: RenderItem,
  first: RenderItem,
  second: RenderItem,
): Message[] {
  if (
    chosen.type === "unknown" ||
    (chosen.type === "reasoning" && chosen.visibility !== "raw_allowed")
  ) {
    return [];
  }
  return mergeSources(first.sourceMessages, second.sourceMessages);
}

/** Select persisted and live snapshots through one normalizer and deterministic deduper. */
export function selectCodexRenderItems(
  input: SelectCodexRenderItemsInput,
): RenderItem[] {
  const snapshots = [...(input.persisted ?? []), ...(input.live ?? [])];
  const selected = new Map<string, { item: RenderItem; order: number }>();

  snapshots.forEach((snapshot, index) => {
    const incoming = renderCodexThreadItem(snapshot);
    const key = itemDedupeKey(incoming);
    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, { item: incoming, order: snapshot.sequence ?? index });
      return;
    }
    const chosen = shouldReplace(existing.item, incoming)
      ? incoming
      : existing.item;
    selected.set(key, {
      item: {
        ...chosen,
        sourceMessages: mergedSourcesFor(chosen, existing.item, incoming),
      } as RenderItem,
      order: Math.min(existing.order, snapshot.sequence ?? index),
    });
  });

  const items = [...selected.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ item }) => item);

  for (const operation of input.interactions ?? []) {
    items.push(mapInteractionOperationToRenderItem(operation));
  }
  return items;
}

/** Collapse replayed item/started + item/completed projections in-place. */
export function dedupeCodexNativeRenderItems(
  items: RenderItem[],
): RenderItem[] {
  const result: RenderItem[] = [];
  const indexByKey = new Map<string, number>();
  for (const item of items) {
    if (!item.providerItemId || !item.nativeType) {
      result.push(item);
      continue;
    }
    const key = itemDedupeKey(item);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push(item);
      continue;
    }
    const existing = result[existingIndex];
    if (!existing) continue;
    const chosen = shouldReplace(existing, item) ? item : existing;
    result[existingIndex] = {
      ...chosen,
      sourceMessages: mergedSourcesFor(chosen, existing, item),
    } as RenderItem;
  }
  return result;
}

function interactionKind(
  request: InputRequest,
  input: Record<string, unknown>,
): InteractionOperationKind {
  if (
    request.toolName === "AskUserQuestion" ||
    request.type === "question" ||
    request.type === "choice"
  )
    return "question";
  const kind = asString(input.approvalKind);
  if (kind === "command_execution") return "command_approval";
  if (kind === "file_change") return "file_approval";
  if (kind === "permissions") return "permission_approval";
  if (kind?.startsWith("mcp_")) return "mcp_elicitation";
  return "unknown";
}

function fallbackCommandDecisions(input: Record<string, unknown>): unknown[] {
  if (
    input.networkApprovalContext !== null &&
    input.networkApprovalContext !== undefined
  ) {
    const decisions: unknown[] = ["accept", "acceptForSession"];
    const amendment = Array.isArray(input.proposedNetworkPolicyAmendments)
      ? input.proposedNetworkPolicyAmendments.find(
          (candidate) => asRecord(candidate)?.action === "allow",
        )
      : undefined;
    if (amendment) {
      decisions.push({ applyNetworkPolicyAmendment: amendment });
    }
    decisions.push("cancel");
    return decisions;
  }

  if (
    input.additionalPermissions !== null &&
    input.additionalPermissions !== undefined
  ) {
    return ["accept", "cancel"];
  }

  const decisions: unknown[] = ["accept"];
  if (Array.isArray(input.proposedExecpolicyAmendment)) {
    decisions.push({
      acceptWithExecpolicyAmendment: input.proposedExecpolicyAmendment,
    });
  }
  decisions.push("cancel");
  return decisions;
}

function interactionDecisionValues(
  request: InputRequest,
  input: Record<string, unknown>,
  kind: InteractionOperationKind,
  readOnly: boolean,
): unknown[] {
  if (readOnly || request.source === "persisted") return [];
  if (kind === "question") return ["submit", "cancel"];
  if (kind === "permission_approval") {
    return [
      "accept",
      "approve_strict_auto_review",
      "acceptForSession",
      "decline",
    ];
  }
  if (Array.isArray(input.availableDecisions)) {
    return input.availableDecisions;
  }

  if (kind === "command_approval") return fallbackCommandDecisions(input);
  if (kind === "file_approval") {
    return ["accept", "acceptForSession", "decline"];
  }
  if (kind === "mcp_elicitation") {
    const scopes = strings(input.persistScopes);
    return [
      "accept",
      ...(scopes.includes("session") ? ["acceptForSession"] : []),
      ...(scopes.includes("always") ? ["acceptAlways"] : []),
      "cancel",
    ];
  }
  return [];
}

function decisionDescriptor(
  value: unknown,
): NativeDecisionDescriptor | undefined {
  if (typeof value === "string") {
    const scope =
      value === "acceptForSession" || value === "approve_for_session"
        ? "session"
        : value === "accept" || value === "once" || value === "approve"
          ? "once"
          : value === "always" ||
              value === "acceptAlways" ||
              value === "approve_always"
            ? "persistent"
            : undefined;
    return {
      id: value,
      scope,
      tone:
        value === "decline" ||
        value === "cancel" ||
        value === "deny" ||
        value === "reject"
          ? "danger"
          : "primary",
    };
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const id =
    asString(record.id) ?? asString(record.type) ?? Object.keys(record)[0];
  return id
    ? {
        id,
        label: asString(record.label),
        description: asString(record.description),
        scope:
          record.scope === "once" ||
          record.scope === "turn" ||
          record.scope === "session" ||
          record.scope === "persistent"
            ? record.scope
            : undefined,
        requiresConfirmation: record.requiresConfirmation === true,
        tone:
          record.tone === "primary" ||
          record.tone === "neutral" ||
          record.tone === "danger"
            ? record.tone
            : "primary",
      }
    : undefined;
}

function interactionQuestions(
  request: InputRequest,
  input: Record<string, unknown>,
): SafeInteractionQuestion[] | undefined {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const projected = rawQuestions.flatMap((question, index) => {
    const record = asRecord(question);
    const prompt = asString(record?.question) ?? asString(record?.prompt);
    if (!record || !prompt) return [];
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          const optionRecord = asRecord(option);
          const label = asString(optionRecord?.label) ?? asString(option);
          return label
            ? [
                {
                  value: asString(optionRecord?.value) ?? label,
                  label,
                  description: asString(optionRecord?.description),
                },
              ]
            : [];
        })
      : [];
    const inputType = asString(record.inputType);
    return [
      {
        id:
          asString(record.id) ??
          asString(record.header) ??
          `question-${index + 1}`,
        title: asString(record.header),
        prompt,
        type:
          inputType === "password" || record.isSecret === true
            ? ("secret" as const)
            : record.multiSelect === true
              ? ("multi_select" as const)
              : options.length > 0
                ? ("single_select" as const)
                : ("text" as const),
        required: record.required !== false,
        options: options.length > 0 ? options : undefined,
      },
    ];
  });
  if (projected.length > 0) return projected;
  if (request.type === "question" || request.type === "choice") {
    return [
      {
        id: "question-1",
        prompt: request.prompt,
        type:
          request.options && request.options.length > 0
            ? "single_select"
            : "text",
        required: true,
        options: request.options?.map((option) => ({
          value: option,
          label: option,
        })),
      },
    ];
  }
  return undefined;
}

function interactionFilePaths(input: Record<string, unknown>): string[] {
  const changes = Array.isArray(input.fileChanges) ? input.fileChanges : [];
  const paths = changes.flatMap((change) => {
    const path = asString(asRecord(change)?.path);
    return path ? [path] : [];
  });
  const grantRoot = asString(input.grantRoot);
  if (grantRoot && !paths.includes(grantRoot)) paths.push(grantRoot);
  return paths.slice(0, 50);
}

export interface InputRequestInteractionContext {
  projectId?: string;
  provider?: string;
  version?: number;
  readOnly?: boolean;
}

/** Project one broker-owned operation into the session timeline. */
export function mapInteractionOperationToRenderItem(
  operation: InteractionOperation,
): InteractionRenderItem<Message> {
  return {
    type: "interaction",
    id: `interaction-${operation.operationId}-v${operation.version}`,
    provider: operation.provider,
    threadId: operation.threadId,
    turnId: operation.turnId,
    providerItemId: operation.itemId,
    nativeType: operation.requestMethod,
    createdAt: new Date(operation.createdAt).toISOString(),
    updatedAt: operation.resolution?.resolvedAt
      ? new Date(operation.resolution.resolvedAt).toISOString()
      : undefined,
    sourceMessages: [],
    operation,
    status:
      operation.state === "open"
        ? "pending"
        : operation.state === "answering"
          ? "running"
          : operation.state === "resolved"
            ? "complete"
            : operation.state === "cancelled" || operation.state === "expired"
              ? "cancelled"
              : "error",
  };
}

/** Compatibility projection while the client API still exposes InputRequest. */
export function mapInputRequestToInteractionOperation(
  request: InputRequest,
  context: InputRequestInteractionContext = {},
): InteractionOperation {
  if (request.interaction) {
    return request.interaction;
  }
  const input = asRecord(request.toolInput) ?? {};
  const kind = interactionKind(request, input);
  const available = interactionDecisionValues(
    request,
    input,
    kind,
    context.readOnly === true,
  );
  const allowedDecisions = available.flatMap((decision) => {
    const descriptor = decisionDescriptor(decision);
    return descriptor ? [descriptor] : [];
  });
  const createdAt = Date.parse(request.timestamp);
  const questions = interactionQuestions(request, input);
  const files = interactionFilePaths(input);
  const permissionRecord = asRecord(input.permissions);
  const permissions = permissionRecord
    ? Object.keys(permissionRecord).slice(0, 20)
    : [];
  const command = asString(input.command);
  const requestMethod =
    asString(input.requestMethod) ??
    (kind === "question"
      ? "item/tool/requestUserInput"
      : kind === "file_approval"
        ? "item/fileChange/requestApproval"
        : kind === "permission_approval"
          ? "item/permissions/requestApproval"
          : kind === "mcp_elicitation"
            ? "mcpServer/elicitation/request"
            : "item/commandExecution/requestApproval");

  return {
    operationId: asString(input.operationId) ?? request.id,
    provider:
      context.provider ??
      (request.source === "codex-bridge"
        ? "codex"
        : request.source === "opencode-bridge"
          ? "opencode"
          : "unknown"),
    requestId: asString(input.requestId) ?? request.id,
    requestMethod,
    projectId: context.projectId,
    sessionId: request.sessionId,
    threadId: asString(input.threadId),
    turnId: asString(input.turnId),
    itemId: asString(input.itemId),
    kind,
    state: "open",
    publicPayload: {
      title: request.toolName,
      prompt: request.prompt,
      toolName: request.toolName,
      cwd: asString(input.cwd),
      command: command ? truncate(command, 4000) : undefined,
      files: files.length > 0 ? files : undefined,
      permissions: permissions.length > 0 ? permissions : undefined,
      questions,
    },
    allowedActors: { mode: "requester_or_admin" },
    allowedDecisions,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    expiresAt: asNumber(input.expiresAt),
    version: asNumber(input.version) ?? context.version ?? 1,
  };
}

/** Build the canonical timeline item used by the production message list. */
export function mapInputRequestToInteractionRenderItem(
  request: InputRequest,
  context: InputRequestInteractionContext = {},
): InteractionRenderItem<Message> {
  const operation = mapInputRequestToInteractionOperation(request, context);
  return {
    ...mapInteractionOperationToRenderItem(operation),
    createdAt: request.timestamp,
  };
}

const INPUT_RESPONSE_BY_DECISION = {
  accept: "approve",
  approve: "approve",
  once: "approve",
  submit: "approve",
  acceptForSession: "approve_for_session",
  approve_for_session: "approve_for_session",
  acceptAlways: "approve_always",
  always: "approve_always",
  approve_always: "approve_always",
  acceptWithExecpolicyAmendment: "approve_always",
  applyNetworkPolicyAmendment: "approve_always",
  approve_accept_edits: "approve_accept_edits",
  approve_strict_auto_review: "approve_strict_auto_review",
  cancel: "deny",
  decline: "deny",
  deny: "deny",
  reject: "deny",
} as const satisfies Record<
  string,
  InputRequestInteractionResponse["response"]
>;

function isInputResponseDecision(
  decisionId: string,
): decisionId is keyof typeof INPUT_RESPONSE_BY_DECISION {
  return Object.prototype.hasOwnProperty.call(
    INPUT_RESPONSE_BY_DECISION,
    decisionId,
  );
}

function interactionAnswers(
  operation: InteractionOperation,
  resolution: InputRequestInteractionResolution,
): UserQuestionAnswers | undefined {
  const questions = operation.publicPayload.questions ?? [];
  if (questions.length === 0 || resolution.decisionId !== "submit") {
    return undefined;
  }
  const answerRecord = asRecord(asRecord(resolution.value)?.answers);
  if (!answerRecord) return {};

  const answers: UserQuestionAnswers = {};
  for (const question of questions) {
    const answer = answerRecord[question.id];
    if (typeof answer === "string") {
      answers[question.id] = answer;
      continue;
    }
    if (
      Array.isArray(answer) &&
      answer.every((part): part is string => typeof part === "string")
    ) {
      answers[question.id] = answer;
    }
  }
  return answers;
}

/**
 * Map the canonical decision back to the existing pending-input API. The
 * operation/version checks are a client-side stale guard; the request id is
 * still validated authoritatively by the existing server route.
 */
export function mapInteractionResolutionToInputResponse(
  operation: InteractionOperation,
  resolution: InputRequestInteractionResolution,
): InputRequestInteractionResponse {
  if (
    operation.operationId !== resolution.operationId ||
    operation.version !== resolution.version
  ) {
    throw new Error("Interaction operation is stale");
  }
  if (
    !operation.allowedDecisions.some(
      (decision) => decision.id === resolution.decisionId,
    )
  ) {
    throw new Error("Interaction decision is not allowed");
  }
  if (!isInputResponseDecision(resolution.decisionId)) {
    throw new Error("Interaction decision is not supported");
  }

  const answers = interactionAnswers(operation, resolution);
  return {
    response: INPUT_RESPONSE_BY_DECISION[resolution.decisionId],
    ...(answers ? { answers } : {}),
  };
}

/**
 * Only hand interaction ownership to the timeline when every visible action
 * can use the existing input endpoint. URL/install flows stay in the footer
 * because the canonical payload does not yet model their required link.
 */
export function canResolveInputRequestInteraction(
  request: InputRequest,
  operation: InteractionOperation,
): boolean {
  const input = asRecord(request.toolInput) ?? {};
  const approvalKind = asString(input.approvalKind);
  if (
    !request.interaction ||
    operation.state !== "open" ||
    request.source === "persisted" ||
    operation.allowedDecisions.length === 0 ||
    asString(input.actionUrl) ||
    approvalKind === "mcp_url_action" ||
    approvalKind === "mcp_tool_suggestion"
  ) {
    return false;
  }
  if (
    operation.kind !== "command_approval" &&
    operation.kind !== "file_approval" &&
    operation.kind !== "permission_approval" &&
    operation.kind !== "question" &&
    operation.kind !== "mcp_elicitation"
  ) {
    return false;
  }
  return operation.allowedDecisions.every((decision) =>
    isInputResponseDecision(decision.id),
  );
}

/** Runtime assertion used by tests/diagnostics to compare generated coverage. */
export function getCodexThreadItemPolicy(type: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(
    CODEX_THREAD_ITEM_RENDER_POLICY,
    type,
  )
    ? CODEX_THREAD_ITEM_RENDER_POLICY[type as CodexThreadItemType]
    : undefined;
}
