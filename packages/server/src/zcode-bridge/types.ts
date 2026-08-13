/**
 * ZCode bridge hook payload types.
 *
 * The Yep ZCode plugin (`resources/zcode-plugin/hook-entry.mjs`) reads the
 * CLI's hook stdin JSON and POSTs it to `/api/zcode-bridge/hook`. These are
 * the wire shapes for that channel. The CLI 0.16.1 hook events and their
 * fields were verified against the Desktop bundle:
 *   - every event: `hook_event_name`, `session_id`, `permission_mode`,
 *     `cwd`, `transcript_path`
 *   - tool events add `tool_name`, `tool_input`, `tool_use_id`
 *   - `PermissionRequest` adds `permission_suggestions`
 */

export const ZCODE_BRIDGE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;
export type ZCodeBridgeHookEventName =
  (typeof ZCODE_BRIDGE_HOOK_EVENTS)[number];

export interface ZCodeBridgeHookBase {
  hook_event_name: ZCodeBridgeHookEventName;
  session_id?: string;
  permission_mode?: string;
  cwd?: string;
  transcript_path?: string;
}

export interface ZCodeBridgePermissionRequestHook extends ZCodeBridgeHookBase {
  hook_event_name: "PermissionRequest";
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  permission_suggestions?: unknown[];
}

export type ZCodeBridgeHookPayload =
  | ZCodeBridgeHookBase
  | ZCodeBridgePermissionRequestHook;

/** The decision payload the hook returns synchronously to the CLI. */
export interface ZCodeBridgeHookResponse {
  decision:
    | { behavior: "allow"; updatedInput?: unknown }
    | { behavior: "deny"; message?: string }
    | null;
}
