import { structuredPatch } from "diff";
import {
  extractRawPatchFromEditInput,
  parseRawEditPatch,
} from "../augments/edit-raw-patch.js";
import type { Message } from "../supervisor/types.js";
import { isUserPromptMessage } from "./user-prompt-message.js";

/**
 * Session-derived file changes.
 *
 * Everything here is reconstructed from the session's own edit tool calls:
 * what the agent asked to change, what the tool reported back. No repository
 * state is consulted, so "what did this session change?" cannot be polluted by
 * edits that existed before the session started or were made by someone else.
 */

export type FileEditOpKind = "replace" | "write" | "patch" | "delete";

export interface FileEditOp {
  kind: FileEditOpKind;
  additions: number;
  deletions: number;
  /** Replacement payload (`Edit`-style tools). */
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  /** Whole-file payload (`Write`-style tools). */
  content?: string;
  /** Unified / apply_patch text (Codex, Pi). */
  patchText?: string;
  /**
   * Complete pre-edit file content reported by the tool result. When the
   * earliest op for a file carries it, the session baseline is exact with no
   * reconstruction needed.
   */
  originalFile?: string;
  toolName: string;
  messageId: string;
  timestamp?: string;
}

export interface FileChangeSummary {
  additions: number;
  deletions: number;
  /** Number of edit operations applied to the file in this session. */
  edits: number;
}

const MAX_OPS_PER_FILE = 500;

const REPLACE_TOOLS = new Set([
  "edit",
  "multiedit",
  "strreplace",
  "strreplaceeditor",
  "strreplacebasededitor",
  "updatefile",
  "replace",
]);
const WRITE_TOOLS = new Set([
  "write",
  "writefile",
  "createfile",
  "create",
  "notebookedit",
]);
const PATCH_TOOLS = new Set(["applypatch", "patch", "editfile"]);

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Does this tool mutate file contents at all? */
export function isFileMutatingTool(name: string): boolean {
  const normalized = normalizeToolName(name);
  return (
    REPLACE_TOOLS.has(normalized) ||
    WRITE_TOOLS.has(normalized) ||
    PATCH_TOOLS.has(normalized)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function countLines(value: string): number {
  if (!value) return 0;
  return value.endsWith("\n")
    ? value.split("\n").length - 1
    : value.split("\n").length;
}

/** Line deltas between two whole strings. */
export function countReplacementLines(
  oldString: string,
  newString: string,
): { additions: number; deletions: number } {
  if (oldString === newString) return { additions: 0, deletions: 0 };
  const patch = structuredPatch("f", "f", oldString, newString, "", "", {
    context: 0,
  });
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function countPatchLines(patchText: string): {
  additions: number;
  deletions: number;
} | null {
  const parsed = parseRawEditPatch(patchText);
  if (!parsed || parsed.structuredPatch.length === 0) return null;
  let additions = 0;
  let deletions = 0;
  for (const hunk of parsed.structuredPatch) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}

interface ToolResultFacts {
  originalFile?: string;
  patchText?: string;
  isError: boolean;
}

/**
 * Pull the few result fields that improve reconstruction.
 *
 * `originalFile` (Claude's Edit/Write result) is the complete pre-edit file,
 * which makes the session baseline exact rather than reconstructed.
 */
function collectToolResults(
  messages: readonly Message[],
): Map<string, ToolResultFacts> {
  const facts = new Map<string, ToolResultFacts>();
  for (const message of messages) {
    const content = message.message?.content ?? message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        !isRecord(block) ||
        block.type !== "tool_result" ||
        typeof block.tool_use_id !== "string"
      ) {
        continue;
      }
      const payload = findResultPayload(block);
      facts.set(block.tool_use_id, {
        isError: block.is_error === true,
        ...(payload?.originalFile !== undefined
          ? { originalFile: payload.originalFile }
          : {}),
        ...(payload?.patchText !== undefined
          ? { patchText: payload.patchText }
          : {}),
      });
    }
  }
  return facts;
}

function findResultPayload(block: Record<string, unknown>): {
  originalFile?: string;
  patchText?: string;
} | null {
  const candidates: unknown[] = [block.content, block.result, block.details];
  const out: { originalFile?: string; patchText?: string } = {};
  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || !value) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    const original =
      str(value.originalFile) ??
      str(value.original_file) ??
      str(value.oldContent);
    if (original !== undefined && out.originalFile === undefined) {
      out.originalFile = original;
    }
    const patch = str(value.patch) ?? str(value.diff);
    if (patch?.trim() && out.patchText === undefined) out.patchText = patch;
    for (const nested of [value.result, value.details, value.content]) {
      visit(nested, depth + 1);
    }
  };
  for (const candidate of candidates) visit(candidate, 0);
  return out.originalFile !== undefined || out.patchText !== undefined
    ? out
    : null;
}

interface ExtractedEdit {
  /** Raw (not yet project-relative) path. */
  path?: string;
  op: Omit<FileEditOp, "messageId" | "toolName">;
}

/** Turn one edit tool call into per-file operations. */
function extractEdits(
  toolName: string,
  input: unknown,
  result: ToolResultFacts | undefined,
): ExtractedEdit[] {
  const normalized = normalizeToolName(toolName);
  const record = isRecord(input) ? input : {};
  const primaryPath =
    str(record.file_path) ??
    str(record.filePath) ??
    str(record.path) ??
    str(record.target_file) ??
    str(record.notebook_path);

  // Codex-style multi-file patches: one op per declared change.
  if (Array.isArray(record.changes)) {
    const edits: ExtractedEdit[] = [];
    for (const change of record.changes) {
      if (!isRecord(change)) continue;
      const path = str(change.path) ?? str(change.file_path) ?? primaryPath;
      const diff = str(change.diff);
      const kind = str(change.kind);
      if (kind === "delete") {
        edits.push({
          ...(path ? { path } : {}),
          op: { kind: "delete", additions: 0, deletions: 0 },
        });
        continue;
      }
      if (!diff) continue;
      const counts =
        countPatchLines(diff) ??
        // `add` changes may carry the raw body rather than a patch.
        (kind === "add"
          ? { additions: countLines(diff), deletions: 0 }
          : { additions: 0, deletions: 0 });
      edits.push({
        ...(path ? { path } : {}),
        op: { kind: "patch", patchText: diff, ...counts },
      });
    }
    if (edits.length > 0) return edits;
  }

  const patchText =
    result?.patchText ??
    str(record._rawPatch) ??
    (PATCH_TOOLS.has(normalized)
      ? extractRawPatchFromEditInput(record)
      : undefined);

  // Replacement edits (Claude Edit/MultiEdit, Pi edits[], str_replace).
  const replacements = extractReplacements(record);
  if (replacements.length > 0) {
    return replacements.map((replacement, index) => ({
      ...(primaryPath ? { path: primaryPath } : {}),
      op: {
        kind: "replace",
        oldString: replacement.oldString,
        newString: replacement.newString,
        ...(replacement.replaceAll ? { replaceAll: true } : {}),
        ...countReplacementLines(replacement.oldString, replacement.newString),
        // Only the first replacement of a call starts from the original file.
        ...(index === 0 && result?.originalFile !== undefined
          ? { originalFile: result.originalFile }
          : {}),
      },
    }));
  }

  if (patchText) {
    const counts = countPatchLines(patchText);
    if (counts) {
      return [
        {
          ...(primaryPath ? { path: primaryPath } : {}),
          op: { kind: "patch", patchText, ...counts },
        },
      ];
    }
  }

  if (WRITE_TOOLS.has(normalized)) {
    const content =
      str(record.content) ?? str(record.file_text) ?? str(record.text) ?? "";
    const counts =
      result?.originalFile !== undefined
        ? countReplacementLines(result.originalFile, content)
        : { additions: countLines(content), deletions: 0 };
    return [
      {
        ...(primaryPath ? { path: primaryPath } : {}),
        op: {
          kind: "write",
          content,
          ...(result?.originalFile !== undefined
            ? { originalFile: result.originalFile }
            : {}),
          ...counts,
        },
      },
    ];
  }

  return [];
}

function extractReplacements(record: Record<string, unknown>): Array<{
  oldString: string;
  newString: string;
  replaceAll: boolean;
}> {
  const out: Array<{
    oldString: string;
    newString: string;
    replaceAll: boolean;
  }> = [];
  const push = (value: unknown) => {
    if (!isRecord(value)) return;
    const oldString =
      str(value.old_string) ?? str(value.oldText) ?? str(value.old_str);
    const newString =
      str(value.new_string) ?? str(value.newText) ?? str(value.new_str);
    if (oldString === undefined || newString === undefined) return;
    if (oldString === newString) return;
    out.push({
      oldString,
      newString,
      replaceAll: value.replace_all === true || value.replaceAll === true,
    });
  };

  if (Array.isArray(record.edits)) for (const edit of record.edits) push(edit);
  if (out.length === 0) push(record);
  return out;
}

export interface CollectSessionFileEditsOptions {
  /** Called to map a raw tool path to its canonical index key. */
  resolvePath: (rawPath: string) => string | null;
}

/**
 * Ordered per-file edit operations for a session.
 *
 * Keys match the file index paths so the two views cannot disagree about which
 * file a change belongs to.
 */
export function collectSessionFileEdits(
  messages: readonly Message[],
  options: CollectSessionFileEditsOptions,
): Map<string, FileEditOp[]> {
  const results = collectToolResults(messages);
  const byPath = new Map<string, FileEditOp[]>();
  let currentQuestionId: string | undefined;

  messages.forEach((message, index) => {
    if (isUserPromptMessage(message)) {
      currentQuestionId = message.uuid ?? str(message.id) ?? `message:${index}`;
      return;
    }
    const content = message.message?.content ?? message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (
        !isRecord(block) ||
        block.type !== "tool_use" ||
        typeof block.name !== "string"
      ) {
        continue;
      }
      const toolName = block.name.trim();
      if (!isFileMutatingTool(toolName)) continue;
      const result =
        typeof block.id === "string" ? results.get(block.id) : undefined;
      // A failed edit changed nothing; counting it would overstate the diff.
      if (result?.isError) continue;

      const messageId =
        str(message.inspectorNavigationMessageId) ??
        currentQuestionId ??
        message.uuid ??
        str(message.id) ??
        `message:${index}`;

      for (const extracted of extractEdits(toolName, block.input, result)) {
        if (!extracted.path) continue;
        const path = options.resolvePath(extracted.path);
        if (!path) continue;
        const ops = byPath.get(path) ?? [];
        if (ops.length >= MAX_OPS_PER_FILE) continue;
        ops.push({
          ...extracted.op,
          toolName,
          messageId,
          ...(message.timestamp ? { timestamp: message.timestamp } : {}),
        });
        byPath.set(path, ops);
      }
    }
  });

  return byPath;
}

/** Total lines this session added and removed in one file. */
export function summarizeFileEdits(
  ops: readonly FileEditOp[],
): FileChangeSummary {
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    additions += op.additions;
    deletions += op.deletions;
  }
  return { additions, deletions, edits: ops.length };
}

export interface ReconstructedBaseline {
  content: string;
  /**
   * False when some operation could not be undone (an unknown `Write`
   * overwrite, a patch whose context no longer matches). The baseline is then
   * only partially rewound and the diff understates the session's changes.
   */
  exact: boolean;
}

/**
 * Rebuild the file's content as it was when the session started.
 *
 * Preference order: the pre-edit content the tool itself reported, otherwise
 * undo each recorded operation backwards from the current content.
 */
export function reconstructSessionBaseline(
  currentContent: string,
  ops: readonly FileEditOp[],
): ReconstructedBaseline {
  if (ops.length === 0) return { content: currentContent, exact: true };
  const first = ops[0];
  if (first?.originalFile !== undefined) {
    return { content: first.originalFile, exact: true };
  }

  let content = currentContent;
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const op = ops[index];
    if (!op) continue;
    if (op.originalFile !== undefined) {
      // An op that recorded its own pre-state ends the rewind exactly.
      return { content: op.originalFile, exact: index === 0 };
    }
    const undone = undoOp(content, op, index === 0);
    if (undone === null) return { content, exact: false };
    content = undone;
  }
  return { content, exact: true };
}

function undoOp(
  content: string,
  op: FileEditOp,
  isEarliest: boolean,
): string | null {
  switch (op.kind) {
    case "replace": {
      const { oldString = "", newString = "" } = op;
      if (!newString) {
        // Pure insertion: remove the inserted text if we can find it.
        return oldString ? null : content;
      }
      if (!content.includes(newString)) return null;
      return op.replaceAll
        ? content.replaceAll(newString, oldString)
        : content.replace(newString, oldString);
    }
    case "write": {
      // The earliest write in a session is the file's creation unless the tool
      // told us otherwise, in which case `originalFile` short-circuits above.
      if (isEarliest) return "";
      return null;
    }
    case "patch":
      return op.patchText ? reverseApplyPatchText(content, op.patchText) : null;
    case "delete":
      // The removed content was never recorded.
      return null;
  }
}

/**
 * Undo a patch by replacing each hunk's post-image with its pre-image.
 *
 * Line numbers in agent-produced patches are unreliable (Codex `apply_patch`
 * hunks often carry no ranges at all), so this matches on hunk text instead of
 * offsets.
 */
function reverseApplyPatchText(
  content: string,
  patchText: string,
): string | null {
  const parsed = parseRawEditPatch(patchText);
  if (!parsed || parsed.structuredPatch.length === 0) return null;

  let result = content;
  for (let index = parsed.structuredPatch.length - 1; index >= 0; index -= 1) {
    const hunk = parsed.structuredPatch[index];
    if (!hunk) continue;
    const after: string[] = [];
    const before: string[] = [];
    for (const line of hunk.lines) {
      const body = line.slice(1);
      const prefix = line[0];
      if (prefix === " ") {
        after.push(body);
        before.push(body);
      } else if (prefix === "+") {
        after.push(body);
      } else if (prefix === "-") {
        before.push(body);
      }
    }
    const afterText = after.join("\n");
    const beforeText = before.join("\n");
    if (afterText === beforeText) continue;
    if (!afterText) {
      // Pure deletion hunk: nothing to locate, cannot safely reinsert.
      return null;
    }
    if (!result.includes(afterText)) return null;
    result = result.replace(afterText, beforeText);
  }
  return result;
}
