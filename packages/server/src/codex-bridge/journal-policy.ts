import { createHash } from "node:crypto";
import { CODEX_NOTIFICATION_CLASSIFICATIONS } from "../codex-events/classification.js";

export const CODEX_BRIDGE_JOURNAL_MODES = [
  "off",
  "lifecycle",
  "full",
  "legacy-blocking",
] as const;

export type CodexBridgeJournalMode =
  (typeof CODEX_BRIDGE_JOURNAL_MODES)[number];

export type CodexBridgeNotificationClass =
  | "delta"
  | "lifecycle"
  | "terminal"
  | "diagnostic";

/**
 * Notifications whose payload is already represented by a later item/turn
 * snapshot or by the native Codex rollout. These must always stay on the wire,
 * but the production bridge journal never needs their content.
 */
export const CODEX_BRIDGE_DELTA_METHODS = new Set<string>([
  "command/exec/outputDelta",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "process/outputDelta",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
  "turn/diff/updated",
]);

export const CODEX_BRIDGE_TERMINAL_METHODS = new Set<string>([
  "error",
  "item/completed",
  "process/exited",
  "serverRequest/resolved",
  "thread/closed",
  "thread/deleted",
  "turn/completed",
]);

const CODEX_BRIDGE_LIFECYCLE_METHODS = new Set<string>([
  "item/started",
  "mcpServer/startupStatus/updated",
  "thread/archived",
  "thread/compacted",
  "thread/goal/cleared",
  "thread/goal/updated",
  "thread/name/updated",
  "thread/settings/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "thread/unarchived",
  "turn/plan/updated",
  "turn/started",
]);

const KNOWN_NOTIFICATION_METHODS = new Set<string>(
  Object.keys(CODEX_NOTIFICATION_CLASSIFICATIONS),
);

const KNOWN_CLIENT_LIFECYCLE_METHODS = new Set<string>([
  "initialize",
  "thread/fork",
  "thread/resume",
  "thread/start",
  "thread/unsubscribe",
  "turn/interrupt",
  "turn/start",
  "turn/steer",
]);

export function resolveCodexBridgeJournalMode(
  value: string | null | undefined,
): CodexBridgeJournalMode {
  const normalized = value?.trim().toLowerCase();
  return CODEX_BRIDGE_JOURNAL_MODES.includes(
    normalized as CodexBridgeJournalMode,
  )
    ? (normalized as CodexBridgeJournalMode)
    : "lifecycle";
}

export function classifyCodexBridgeNotification(
  method: string,
): CodexBridgeNotificationClass {
  if (CODEX_BRIDGE_DELTA_METHODS.has(method)) return "delta";
  if (CODEX_BRIDGE_TERMINAL_METHODS.has(method)) return "terminal";
  if (CODEX_BRIDGE_LIFECYCLE_METHODS.has(method)) return "lifecycle";
  return "diagnostic";
}

export function shouldJournalClientMethod(
  mode: CodexBridgeJournalMode,
  method: string,
): boolean {
  if (mode === "off") return false;
  if (mode === "full" || mode === "legacy-blocking") return true;
  return KNOWN_CLIENT_LIFECYCLE_METHODS.has(method);
}

export function shouldJournalServerNotification(
  mode: CodexBridgeJournalMode,
  method: string,
): boolean {
  if (mode === "off" || mode === "legacy-blocking") return false;
  const classification = classifyCodexBridgeNotification(method);
  if (mode === "lifecycle") {
    return classification === "lifecycle" || classification === "terminal";
  }
  return true;
}

/**
 * Keep unrecognised method names out of low-context diagnostics. The stable
 * fingerprint is enough to correlate repeats without copying attacker- or
 * extension-controlled strings into logs/journals.
 */
export function safeCodexBridgeMethod(method: string): string {
  if (
    KNOWN_NOTIFICATION_METHODS.has(method) ||
    KNOWN_CLIENT_LIFECYCLE_METHODS.has(method) ||
    method === "config/read" ||
    method === "thread/read"
  ) {
    return method;
  }
  return `unknown:${createHash("sha256").update(method).digest("hex").slice(0, 16)}`;
}
