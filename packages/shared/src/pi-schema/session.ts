/**
 * Tolerant types and parsing helpers for Pi coding-agent JSONL sessions.
 *
 * Upstream reference:
 * references/pi/packages/coding-agent/docs/session-format.md
 */

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
  /** Pi's native opaque reasoning signature field. */
  thinkingSignature?: string;
  /** Compatibility alias accepted from older/custom Pi providers. */
  signature?: string;
  redacted?: boolean;
}

export interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type PiContentBlock =
  | PiTextContent
  | PiImageContent
  | PiThinkingContent
  | PiToolCallContent;

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface PiUserMessage {
  role: "user";
  content: string | Array<PiTextContent | PiImageContent>;
  timestamp?: number;
  attachments?: unknown[];
}

export interface PiAssistantMessage {
  role: "assistant";
  content: PiContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: PiUsage;
  stopReason?:
    | "pending"
    | "stop"
    | "length"
    | "toolUse"
    | "error"
    | "aborted"
    | "deferred";
  errorMessage?: string;
  timestamp?: number;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<PiTextContent | PiImageContent>;
  details?: unknown;
  usage?: PiUsage;
  isError: boolean;
  timestamp?: number;
}

export interface PiBashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp?: number;
}

export interface PiCustomMessage {
  role: "custom";
  customType: string;
  content: string | Array<PiTextContent | PiImageContent>;
  display: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface PiBranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp?: number;
}

export interface PiCompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp?: number;
}

export type PiAgentMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiBashExecutionMessage
  | PiCustomMessage
  | PiBranchSummaryMessage
  | PiCompactionSummaryMessage;

export interface PiSessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface PiSessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface PiMessageEntry extends PiSessionEntryBase {
  type: "message";
  message: PiAgentMessage;
}

export interface PiModelChangeEntry extends PiSessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface PiThinkingLevelChangeEntry extends PiSessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface PiCompactionEntry extends PiSessionEntryBase {
  type: "compaction";
  summary: string;
  tokensBefore?: number;
  firstKeptEntryId?: string;
  retainedTail?: PiAgentMessage[];
  usage?: PiUsage;
  details?: unknown;
}

export interface PiBranchSummaryEntry extends PiSessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  usage?: PiUsage;
  details?: unknown;
}

export interface PiSessionInfoEntry extends PiSessionEntryBase {
  type: "session_info";
  name?: string;
}

export type PiSessionEntry =
  | PiMessageEntry
  | PiModelChangeEntry
  | PiThinkingLevelChangeEntry
  | PiCompactionEntry
  | PiBranchSummaryEntry
  | PiSessionInfoEntry
  | (PiSessionEntryBase & Record<string, unknown>);

export interface PiSessionContent {
  header: PiSessionHeader;
  /** Every append-only entry, including abandoned in-file branches. */
  entries: PiSessionEntry[];
  /** Entries on the current leaf-to-root branch, in display order. */
  activeEntries: PiSessionEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePiSessionHeader(value: unknown): PiSessionHeader | null {
  if (!isRecord(value) || value.type !== "session") return null;
  if (
    typeof value.id !== "string" ||
    typeof value.timestamp !== "string" ||
    typeof value.cwd !== "string"
  ) {
    return null;
  }
  return value as unknown as PiSessionHeader;
}

export function parsePiSessionEntry(value: unknown): PiSessionEntry | null {
  if (!isRecord(value) || value.type === "session") return null;
  if (
    typeof value.type !== "string" ||
    typeof value.id !== "string" ||
    (typeof value.parentId !== "string" && value.parentId !== null) ||
    typeof value.timestamp !== "string"
  ) {
    return null;
  }
  return value as PiSessionEntry;
}

export function collectPiActiveEntries(
  entries: readonly PiSessionEntry[],
  leafId?: string | null,
): PiSessionEntry[] {
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = leafId ? byId.get(leafId) : entries.at(-1);
  if (!current) current = entries.at(-1);

  const reversed: PiSessionEntry[] = [];
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    reversed.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return reversed.reverse();
}

export function parsePiSessionJsonl(content: string): PiSessionContent | null {
  let header: PiSessionHeader | null = null;
  const entries: PiSessionEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!header) {
      header = parsePiSessionHeader(value);
      if (header) continue;
    }
    const entry = parsePiSessionEntry(value);
    if (entry) entries.push(entry);
  }

  if (!header) return null;
  return { header, entries, activeEntries: collectPiActiveEntries(entries) };
}

export function getPiMessageText(message: PiAgentMessage): string {
  if (
    message.role === "branchSummary" ||
    message.role === "compactionSummary"
  ) {
    return message.summary;
  }
  if (message.role === "bashExecution") return message.output;
  if (message.role === "toolResult") {
    return message.content
      .filter((block): block is PiTextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "thinking"
          ? block.thinking
          : "",
    )
    .filter(Boolean)
    .join("\n");
}
