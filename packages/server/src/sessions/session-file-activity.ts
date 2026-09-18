import {
  type SessionFileActivity,
  type SessionFileActivityKind,
  classifyFileActivityKind,
  extractShellWritePaths,
  extractToolCommand,
  extractToolFilePaths,
  normalizeSessionFilePath,
  prioritizeFileActivityKind,
} from "@yep-anywhere/shared";
import type { Message } from "../supervisor/types.js";
import {
  collectSessionFileEdits,
  summarizeFileEdits,
} from "./session-file-changes.js";
import { isUserPromptMessage } from "./user-prompt-message.js";

const MAX_TOOLS_PER_FILE = 8;

export interface BuildSessionFileActivityOptions {
  /** Absolute project root used to relativize observed paths. */
  projectPath?: string;
  /** Cap on the number of distinct files returned. */
  maxFiles?: number;
}

interface Accumulator {
  activity: SessionFileActivity;
  order: number;
}

/**
 * Derive the per-session file index from structured tool calls.
 *
 * Unlike the previous client-only derivation this runs over the whole session
 * (not just the page currently rendered), and additionally recovers writes
 * performed through shell commands, which no tool-input key exposes.
 */
export function buildSessionFileActivity(
  messages: readonly Message[],
  options: BuildSessionFileActivityOptions = {},
): { files: SessionFileActivity[]; truncated: boolean } {
  const { projectPath, maxFiles = 500 } = options;
  const grouped = new Map<string, Accumulator>();
  let truncated = false;
  let currentQuestionId: string | undefined;
  let order = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (isUserPromptMessage(message)) {
      currentQuestionId = getMessageId(message, index);
      continue;
    }
    const content = message.message?.content ?? message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (
        !isRecord(block) ||
        block.type !== "tool_use" ||
        typeof block.name !== "string"
      ) {
        continue;
      }
      const toolName = block.name.trim();
      if (!toolName) continue;
      const messageId =
        asString(message.inspectorNavigationMessageId) ??
        currentQuestionId ??
        getMessageId(message, index);
      order += 1;

      const toolPaths = extractToolFilePaths(block.input);
      for (const rawPath of toolPaths) {
        truncated =
          record(grouped, rawPath, {
            projectPath,
            maxFiles,
            toolName,
            kind: classifyFileActivityKind(toolName),
            source: "tool",
            confidence: "high",
            messageId,
            timestamp: message.timestamp,
            order,
          }) || truncated;
      }

      // Shell writes are only consulted when the tool did not already declare
      // structured paths, so `apply_patch`-style tools keep high confidence.
      if (toolPaths.length > 0) continue;
      const command = extractToolCommand(block.input);
      if (!command) continue;
      for (const rawPath of extractShellWritePaths(command)) {
        truncated =
          record(grouped, rawPath, {
            projectPath,
            maxFiles,
            toolName,
            kind: "modified",
            source: "shell",
            confidence: "low",
            messageId,
            timestamp: message.timestamp,
            order,
          }) || truncated;
      }
    }
  }

  const files = [...grouped.values()]
    .sort((a, b) => b.order - a.order)
    .map((entry) => entry.activity);
  attachSessionChangeStats(files, messages, projectPath);
  return { files, truncated };
}

/**
 * Attach per-file line deltas derived from the session's own edit calls.
 *
 * Deliberately not measured against git: the repository may carry unrelated
 * uncommitted work, and commits made mid-session would otherwise erase the
 * session's own changes from the diff.
 */
function attachSessionChangeStats(
  files: SessionFileActivity[],
  messages: readonly Message[],
  projectPath?: string,
): void {
  if (files.length === 0) return;
  const edits = collectSessionFileEdits(messages, {
    resolvePath: (rawPath) =>
      normalizeSessionFilePath(rawPath, projectPath)?.path ?? null,
  });
  if (edits.size === 0) return;

  for (const file of files) {
    const ops = edits.get(file.path);
    if (!ops || ops.length === 0) continue;
    const summary = summarizeFileEdits(ops);
    file.additions = summary.additions;
    file.deletions = summary.deletions;
    file.edits = summary.edits;
    // Recorded edits are proof of mutation, whatever the tool name suggested.
    file.kind = "modified";
    file.confidence = "high";
    file.source = "tool";
  }
}

interface RecordInput {
  projectPath?: string;
  maxFiles: number;
  toolName: string;
  kind: SessionFileActivityKind;
  source: SessionFileActivity["source"];
  confidence: SessionFileActivity["confidence"];
  messageId: string;
  timestamp?: string;
  order: number;
}

/** Returns true when the entry was dropped because the cap was reached. */
function record(
  grouped: Map<string, Accumulator>,
  rawPath: string,
  input: RecordInput,
): boolean {
  const normalized = normalizeSessionFilePath(rawPath, input.projectPath);
  if (!normalized) return false;
  const existing = grouped.get(normalized.path);
  if (!existing) {
    if (grouped.size >= input.maxFiles) return true;
    grouped.set(normalized.path, {
      order: input.order,
      activity: {
        path: normalized.path,
        outsideProject: normalized.outsideProject,
        kind: input.kind,
        tools: [input.toolName],
        count: 1,
        source: input.source,
        confidence: input.confidence,
        messageId: input.messageId,
        ...(input.timestamp ? { timestamp: input.timestamp } : {}),
      },
    });
    return false;
  }

  const activity = existing.activity;
  activity.count += 1;
  if (
    !activity.tools.includes(input.toolName) &&
    activity.tools.length < MAX_TOOLS_PER_FILE
  ) {
    activity.tools.push(input.toolName);
  }
  if (input.order >= existing.order) {
    existing.order = input.order;
    activity.kind = prioritizeFileActivityKind(activity.kind, input.kind);
    activity.messageId = input.messageId;
    if (input.timestamp) activity.timestamp = input.timestamp;
  }
  // A single high-confidence observation is enough to trust the row.
  if (input.confidence === "high") {
    activity.confidence = "high";
    activity.source = "tool";
  }
  return false;
}

function getMessageId(message: Message, index: number): string {
  return (
    message.uuid ??
    (typeof message.id === "string" ? message.id : `message:${index}`)
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
