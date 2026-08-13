import type { ServerNotification } from "../sdk/providers/codex-protocol/index.js";

export type CodexKnownServerNotificationMethod = ServerNotification["method"];

export type CodexNotificationDomain =
  | "account"
  | "application"
  | "command"
  | "compatibility"
  | "configuration"
  | "environment"
  | "error"
  | "external_import"
  | "filesystem"
  | "hook"
  | "interaction"
  | "item"
  | "mcp"
  | "model"
  | "process"
  | "realtime"
  | "search"
  | "skills"
  | "thread"
  | "turn"
  | "warning";

export type CodexNotificationDisposition = "reduce" | "record" | "diagnostic";

export interface CodexKnownNotificationClassification {
  known: true;
  domain: CodexNotificationDomain;
  disposition: CodexNotificationDisposition;
}

export interface CodexUnknownNotificationClassification {
  known: false;
  domain: "compatibility";
  disposition: "record";
  compatibility: "newer_server";
}

function policy(
  domain: CodexNotificationDomain,
  disposition: CodexNotificationDisposition,
): Omit<CodexKnownNotificationClassification, "known"> {
  return { domain, disposition };
}

/**
 * Explicit classification for every method in Codex 0.147.0's generated
 * ServerNotification TypeScript union. Keep this hand-maintained: adding an
 * upstream method must produce a TypeScript error until it is audited.
 */
export const CODEX_NOTIFICATION_CLASSIFICATIONS = {
  "account/login/completed": policy("account", "record"),
  "account/rateLimits/updated": policy("account", "record"),
  "account/updated": policy("account", "record"),
  "app/list/updated": policy("application", "record"),
  "command/exec/outputDelta": policy("command", "record"),
  configWarning: policy("warning", "record"),
  deprecationNotice: policy("compatibility", "record"),
  error: policy("error", "reduce"),
  "externalAgentConfig/import/completed": policy("external_import", "record"),
  "externalAgentConfig/import/progress": policy("external_import", "record"),
  "fs/changed": policy("filesystem", "diagnostic"),
  "fuzzyFileSearch/sessionCompleted": policy("search", "record"),
  "fuzzyFileSearch/sessionUpdated": policy("search", "record"),
  guardianWarning: policy("warning", "record"),
  "hook/completed": policy("hook", "record"),
  "hook/started": policy("hook", "record"),
  "item/agentMessage/delta": policy("item", "reduce"),
  "item/autoApprovalReview/completed": policy("interaction", "record"),
  "item/autoApprovalReview/started": policy("interaction", "record"),
  "item/commandExecution/outputDelta": policy("item", "reduce"),
  "item/commandExecution/terminalInteraction": policy("item", "reduce"),
  "item/completed": policy("item", "reduce"),
  "item/fileChange/outputDelta": policy("item", "reduce"),
  "item/fileChange/patchUpdated": policy("item", "reduce"),
  "item/mcpToolCall/progress": policy("item", "reduce"),
  "item/plan/delta": policy("item", "reduce"),
  "item/reasoning/summaryPartAdded": policy("item", "reduce"),
  "item/reasoning/summaryTextDelta": policy("item", "reduce"),
  "item/reasoning/textDelta": policy("item", "reduce"),
  "item/started": policy("item", "reduce"),
  "mcpServer/oauthLogin/completed": policy("mcp", "record"),
  "mcpServer/startupStatus/updated": policy("mcp", "record"),
  "model/rerouted": policy("model", "record"),
  "model/safetyBuffering/updated": policy("model", "record"),
  "model/verification": policy("model", "record"),
  "process/exited": policy("process", "record"),
  "process/outputDelta": policy("process", "record"),
  "rawResponse/completed": policy("compatibility", "diagnostic"),
  "rawResponseItem/completed": policy("compatibility", "diagnostic"),
  "remoteControl/status/changed": policy("configuration", "record"),
  "serverRequest/resolved": policy("interaction", "reduce"),
  "skills/changed": policy("skills", "record"),
  "thread/archived": policy("thread", "reduce"),
  "thread/closed": policy("thread", "reduce"),
  "thread/compacted": policy("thread", "record"),
  "thread/deleted": policy("thread", "reduce"),
  "thread/environment/connected": policy("environment", "record"),
  "thread/environment/disconnected": policy("environment", "record"),
  "thread/goal/cleared": policy("thread", "reduce"),
  "thread/goal/updated": policy("thread", "reduce"),
  "thread/name/updated": policy("thread", "record"),
  "thread/realtime/closed": policy("realtime", "record"),
  "thread/realtime/error": policy("realtime", "record"),
  "thread/realtime/itemAdded": policy("realtime", "record"),
  "thread/realtime/outputAudio/delta": policy("realtime", "record"),
  "thread/realtime/sdp": policy("realtime", "record"),
  "thread/realtime/started": policy("realtime", "record"),
  "thread/realtime/transcript/delta": policy("realtime", "record"),
  "thread/realtime/transcript/done": policy("realtime", "record"),
  "thread/settings/updated": policy("thread", "record"),
  "thread/started": policy("thread", "reduce"),
  "thread/status/changed": policy("thread", "reduce"),
  "thread/tokenUsage/updated": policy("thread", "record"),
  "thread/unarchived": policy("thread", "reduce"),
  "turn/completed": policy("turn", "reduce"),
  "turn/diff/updated": policy("turn", "reduce"),
  "turn/moderationMetadata": policy("turn", "record"),
  "turn/plan/updated": policy("turn", "reduce"),
  "turn/started": policy("turn", "reduce"),
  warning: policy("warning", "record"),
  "windows/worldWritableWarning": policy("warning", "record"),
  "windowsSandbox/setupCompleted": policy("configuration", "record"),
} as const satisfies Record<
  CodexKnownServerNotificationMethod,
  Omit<CodexKnownNotificationClassification, "known">
>;

export function classifyCodexNotification(
  method: string,
):
  | CodexKnownNotificationClassification
  | CodexUnknownNotificationClassification {
  if (method in CODEX_NOTIFICATION_CLASSIFICATIONS) {
    const classification =
      CODEX_NOTIFICATION_CLASSIFICATIONS[
        method as CodexKnownServerNotificationMethod
      ];
    return { known: true, ...classification };
  }
  return {
    known: false,
    domain: "compatibility",
    disposition: "record",
    compatibility: "newer_server",
  };
}
