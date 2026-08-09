import * as fs from "node:fs";
import * as path from "node:path";
import { publicCodexFilePath } from "../codex/file-change.js";
import { loadConfig } from "../config.js";
import {
  MANAGED_ATTACHMENT_MARKER,
  sanitizeManagedAttachmentPrompt,
} from "./messageQueue.js";

/**
 * Simple JSONL logger for raw SDK messages.
 * Captures exact message shapes for analysis.
 *
 * Disabled by default. Enable via LOG_SDK_MESSAGES=true
 * Output: {logDir}/sdk-raw.jsonl
 */

let writeStream: fs.WriteStream | null = null;
let enabled = false;

/**
 * Initialize the SDK message logger.
 * Call once at server startup.
 */
export function initMessageLogger(): void {
  enabled = process.env.LOG_SDK_MESSAGES === "true";
  if (!enabled) return;

  const config = loadConfig();
  const logPath = path.join(config.logDir, "sdk-raw.jsonl");

  // Ensure log directory exists
  fs.mkdirSync(config.logDir, { recursive: true });

  // Open append stream
  writeStream = fs.createWriteStream(logPath, { flags: "a" });

  // Log startup
  logRaw({
    _meta: "logger_started",
    timestamp: new Date().toISOString(),
    pid: process.pid,
  });
}

/**
 * Log a raw SDK message.
 */
export function logSDKMessage(
  sessionId: string,
  message: unknown,
  options?: {
    provider?: string;
  },
): void {
  if (!enabled || !writeStream) return;

  const base = {
    _ts: Date.now(),
    _sid: sessionId,
    ...(options?.provider ? { _provider: options.provider } : {}),
  };
  const safeMessage = sanitizeSDKMessageForLog(message);

  if (
    safeMessage &&
    typeof safeMessage === "object" &&
    !Array.isArray(safeMessage)
  ) {
    logRaw({
      ...base,
      ...(safeMessage as Record<string, unknown>),
    });
    return;
  }

  logRaw({
    ...base,
    _message: safeMessage,
  });
}

/** Project provider messages onto the public/log-safe boundary. */
export function sanitizeSDKMessageForPublic(message: unknown): unknown {
  if (Array.isArray(message)) {
    return message.map((entry) => sanitizeSDKMessageForPublic(entry));
  }
  const sanitizePromptStrings =
    Boolean(message) &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    (message as Record<string, unknown>).type === "user";
  return sanitizeSDKValue(message, false, sanitizePromptStrings, false);
}

function sanitizeSDKValue(
  value: unknown,
  insideAttachments: boolean,
  sanitizePromptStrings: boolean,
  insideCodexImageViewInput: boolean,
): unknown {
  if (typeof value === "string") {
    return sanitizePromptStrings
      ? sanitizeManagedAttachmentPrompt(value)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      sanitizeSDKValue(
        entry,
        insideAttachments,
        sanitizePromptStrings,
        insideCodexImageViewInput,
      ),
    );
  }
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const source = value as Record<string, unknown>;
  const isStructuredCodexReference =
    (source.type === "skill" || source.type === "mention") &&
    typeof source.name === "string";
  const isLocalMedia =
    source.type === "localImage" || source.type === "localAudio";
  const isCodexImageViewItem =
    source.type === "imageView" || source.type === "image_view";
  const isCodexImageViewToolUse =
    source.type === "tool_use" && source.name === "ViewImage";
  const isToolResult = source.type === "tool_result";
  const isUploadedFile =
    typeof source.path === "string" &&
    typeof source.mimeType === "string" &&
    typeof source.size === "number" &&
    (typeof source.id === "string" || typeof source.originalName === "string");
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (isStructuredCodexReference && key === "path") continue;
    if (key === "internalPrompt") continue;
    if (
      key === "path" &&
      (insideAttachments || isUploadedFile || isLocalMedia)
    ) {
      output[key] = MANAGED_ATTACHMENT_MARKER;
      continue;
    }
    if (
      key === "path" &&
      typeof entry === "string" &&
      (insideCodexImageViewInput || isCodexImageViewItem)
    ) {
      output[key] = publicCodexFilePath(entry);
      continue;
    }
    if (key === "content" && isToolResult && typeof entry === "string") {
      output[key] = sanitizeCodexImageViewToolResult(entry);
      continue;
    }
    output[key] = sanitizeSDKValue(
      entry,
      insideAttachments || key === "attachments",
      sanitizePromptStrings,
      insideCodexImageViewInput || (isCodexImageViewToolUse && key === "input"),
    );
  }
  return output;
}

function sanitizeCodexImageViewToolResult(value: string): string {
  const prefix = "Viewed image: ";
  if (!value.startsWith(prefix)) return value;
  return `${prefix}${publicCodexFilePath(value.slice(prefix.length))}`;
}

/** Keep provider-only paths out of the optional sdk-raw JSONL. */
export function sanitizeSDKMessageForLog(message: unknown): unknown {
  return sanitizeSDKMessageForPublic(message);
}

/**
 * Log any object as a raw line.
 */
function logRaw(obj: unknown): void {
  if (!writeStream) return;
  try {
    writeStream.write(`${JSON.stringify(obj)}\n`);
  } catch {
    // Ignore write errors
  }
}

/**
 * Close the logger.
 */
export function closeMessageLogger(): void {
  if (writeStream) {
    writeStream.end();
    writeStream = null;
  }
}
