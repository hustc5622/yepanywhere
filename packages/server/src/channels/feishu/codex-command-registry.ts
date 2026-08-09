export type CodexRemoteCommandSupport =
  | "implemented"
  | "equivalent"
  | "not-applicable"
  | "blocked-with-reason";

export interface CodexRemoteCommandCapability {
  command: string;
  aliases?: string[];
  yep: CodexRemoteCommandSupport;
  feishu: CodexRemoteCommandSupport;
  reasonCode?: string;
  highRisk?: boolean;
}

/**
 * Auditable mapping of every SlashCommand in the pinned Codex source. A
 * command may be intentionally unavailable, but it may not disappear from
 * the remote experience without a reason code.
 */
export const CODEX_REMOTE_COMMAND_CAPABILITIES = [
  capability(
    "model",
    "implemented",
    "blocked-with-reason",
    "FEISHU_PICKER_PENDING",
  ),
  capability("ide", "equivalent", "not-applicable", "NO_REMOTE_IDE_STATE"),
  capability("permissions", "implemented", "equivalent"),
  capability("keymap", "implemented", "not-applicable", "CLIENT_LOCAL_UI"),
  capability("vim", "implemented", "not-applicable", "CLIENT_LOCAL_UI"),
  capability(
    "setup-default-sandbox",
    "blocked-with-reason",
    "not-applicable",
    "WINDOWS_ONLY",
    true,
  ),
  capability(
    "sandbox-add-read-dir",
    "blocked-with-reason",
    "blocked-with-reason",
    "WINDOWS_PATH_AUTH_REQUIRED",
    true,
  ),
  capability(
    "experimental",
    "equivalent",
    "blocked-with-reason",
    "ADMIN_DEVELOPER_SETTING_ONLY",
    true,
  ),
  capability("approve", "equivalent", "equivalent", "AUTO_REVIEW_ONLY"),
  capability(
    "memories",
    "blocked-with-reason",
    "blocked-with-reason",
    "PRIVACY_UI_PENDING",
  ),
  capability("skills", "implemented", "implemented"),
  capability(
    "import",
    "blocked-with-reason",
    "blocked-with-reason",
    "ADMIN_IMPORT_WIZARD_PENDING",
    true,
  ),
  capability(
    "hooks",
    "equivalent",
    "blocked-with-reason",
    "FEISHU_HOOK_SUMMARY_PENDING",
  ),
  capability(
    "review",
    "blocked-with-reason",
    "implemented",
    "YEP_NATIVE_REVIEW_CONTROL_PENDING",
  ),
  capability(
    "rename",
    "implemented",
    "blocked-with-reason",
    "FEISHU_RENAME_PENDING",
  ),
  capability("new", "implemented", "implemented"),
  capability(
    "archive",
    "implemented",
    "blocked-with-reason",
    "CONFIRMATION_CARD_REQUIRED",
    true,
  ),
  capability(
    "delete",
    "implemented",
    "blocked-with-reason",
    "PERMANENT_DELETE_NOT_EXPOSED",
    true,
  ),
  capability(
    "resume",
    "implemented",
    "blocked-with-reason",
    "ACCOUNT_SCOPED_PICKER_PENDING",
  ),
  capability(
    "fork",
    "equivalent",
    "blocked-with-reason",
    "FEISHU_SOURCE_FORK_COMMAND_PENDING",
  ),
  capability(
    "app",
    "equivalent",
    "blocked-with-reason",
    "SIGNED_DEEP_LINK_PENDING",
  ),
  capability(
    "init",
    "equivalent",
    "equivalent",
    "NORMAL_AGENT_TASK_WITH_APPROVAL",
  ),
  capability(
    "compact",
    "blocked-with-reason",
    "implemented",
    "YEP_NATIVE_COMPACTION_CONTROL_PENDING",
  ),
  capability("plan", "implemented", "equivalent"),
  capability(
    "goal",
    "blocked-with-reason",
    "implemented",
    "YEP_NATIVE_GOAL_CONTROL_PENDING",
  ),
  capability(
    "agent",
    "blocked-with-reason",
    "blocked-with-reason",
    "SUBAGENT_SWITCHER_PENDING",
  ),
  capability(
    "side",
    "blocked-with-reason",
    "blocked-with-reason",
    "EPHEMERAL_FORK_LIFECYCLE_PENDING",
  ),
  capability(
    "btw",
    "blocked-with-reason",
    "blocked-with-reason",
    "EPHEMERAL_FORK_LIFECYCLE_PENDING",
  ),
  capability("copy", "implemented", "not-applicable", "FEISHU_NATIVE_COPY"),
  capability(
    "export",
    "implemented",
    "blocked-with-reason",
    "FEISHU_EXPORT_UPLOAD_PENDING",
  ),
  capability(
    "raw",
    "implemented",
    "blocked-with-reason",
    "RAW_FORBIDDEN_IN_GROUPS",
    true,
  ),
  capability("diff", "implemented", "equivalent", "RICH_DIFF_PROJECTION"),
  capability(
    "mention",
    "implemented",
    "blocked-with-reason",
    "STRUCTURED_RESOURCE_PICKER_PENDING",
  ),
  capability("status", "implemented", "implemented"),
  capability("usage", "implemented", "blocked-with-reason", "ACCOUNT_PRIVACY"),
  capability(
    "debug-config",
    "implemented",
    "blocked-with-reason",
    "ADMIN_DIAGNOSTIC_ONLY",
    true,
  ),
  capability("title", "equivalent", "not-applicable", "TERMINAL_LOCAL_UI"),
  capability("statusline", "equivalent", "not-applicable", "TERMINAL_LOCAL_UI"),
  capability("theme", "implemented", "not-applicable", "TERMINAL_LOCAL_UI"),
  capability(
    "pets",
    "not-applicable",
    "not-applicable",
    "NON_CORE_TERMINAL_DECORATION",
    false,
    ["pet"],
  ),
  capability(
    "mcp",
    "implemented",
    "blocked-with-reason",
    "SAFE_STATUS_CARD_PENDING",
  ),
  capability(
    "apps",
    "implemented",
    "blocked-with-reason",
    "SAFE_APP_PICKER_PENDING",
  ),
  capability(
    "plugins",
    "implemented",
    "blocked-with-reason",
    "INSTALL_CONFIRMATION_REQUIRED",
    true,
  ),
  capability(
    "logout",
    "implemented",
    "blocked-with-reason",
    "ACCOUNT_MUTATION_FORBIDDEN_IN_CHAT",
    true,
  ),
  capability(
    "quit",
    "not-applicable",
    "not-applicable",
    "SERVER_SESSION_PERSISTS",
  ),
  capability(
    "exit",
    "not-applicable",
    "not-applicable",
    "SERVER_SESSION_PERSISTS",
  ),
  capability(
    "feedback",
    "implemented",
    "blocked-with-reason",
    "REDACTED_PREVIEW_REQUIRED",
  ),
  capability(
    "rollout",
    "equivalent",
    "blocked-with-reason",
    "DEBUG_PATH_FORBIDDEN",
  ),
  capability(
    "ps",
    "blocked-with-reason",
    "blocked-with-reason",
    "BACKGROUND_TERMINAL_API_EXPERIMENTAL",
  ),
  capability(
    "stop",
    "blocked-with-reason",
    "blocked-with-reason",
    "BACKGROUND_STOP_DIFFERS_FROM_TURN_INTERRUPT",
    false,
    ["clean"],
  ),
  capability("clear", "equivalent", "equivalent", "ALIASES_NEW"),
  capability(
    "personality",
    "blocked-with-reason",
    "blocked-with-reason",
    "THREAD_SETTING_UI_PENDING",
  ),
  capability(
    "test-approval",
    "not-applicable",
    "not-applicable",
    "DEBUG_BUILD_ONLY",
  ),
  capability(
    "subagents",
    "blocked-with-reason",
    "blocked-with-reason",
    "SUBAGENT_SWITCHER_PENDING",
  ),
  capability(
    "debug-m-drop",
    "not-applicable",
    "not-applicable",
    "UPSTREAM_DO_NOT_USE",
  ),
  capability(
    "debug-m-update",
    "not-applicable",
    "not-applicable",
    "UPSTREAM_DO_NOT_USE",
  ),
] as const satisfies readonly CodexRemoteCommandCapability[];

export function getCodexRemoteCommandCapability(
  command: string,
): CodexRemoteCommandCapability | undefined {
  const normalized = command.replace(/^\//, "").trim().toLowerCase();
  return CODEX_REMOTE_COMMAND_CAPABILITIES.find(
    (entry) =>
      entry.command === normalized || entry.aliases?.includes(normalized),
  );
}

function capability(
  command: string,
  yep: CodexRemoteCommandSupport,
  feishu: CodexRemoteCommandSupport,
  reasonCode?: string,
  highRisk = false,
  aliases?: string[],
): CodexRemoteCommandCapability {
  return {
    command,
    yep,
    feishu,
    ...(reasonCode ? { reasonCode } : {}),
    ...(highRisk ? { highRisk } : {}),
    ...(aliases ? { aliases } : {}),
  };
}
