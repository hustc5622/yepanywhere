import { z } from "zod";
import type { CodexMcpMode, PermissionMode } from "./types.js";

export const FeishuDomainSchema = z.enum(["feishu", "lark"]);
export type FeishuDomain = z.infer<typeof FeishuDomainSchema>;

export const FeishuProxyModeSchema = z.enum(["auto", "direct", "environment"]);
export type FeishuProxyMode = z.infer<typeof FeishuProxyModeSchema>;

export const FeishuReplyModeSchema = z.enum(["card", "markdown", "text"]);
export type FeishuReplyMode = z.infer<typeof FeishuReplyModeSchema>;

export const FeishuGroupSessionModeSchema = z.enum([
  "chat",
  "thread-when-available",
]);
export type FeishuGroupSessionMode = z.infer<
  typeof FeishuGroupSessionModeSchema
>;

export const FeishuConnectionStateSchema = z.enum([
  "disabled",
  "locked",
  "connecting",
  "connected",
  "degraded",
  "stopped",
]);
export type FeishuConnectionState = z.infer<typeof FeishuConnectionStateSchema>;

export const FeishuSecretRefSchema = z.union([
  z.string().regex(/^store:[a-z0-9][a-z0-9_-]{0,63}$/),
  z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/),
]);
export type FeishuSecretRef = z.infer<typeof FeishuSecretRefSchema>;

export const FeishuPermissionModeSchema = z.enum([
  "auto",
  "default",
  "acceptEdits",
  "plan",
]);
export type FeishuPermissionMode = Exclude<PermissionMode, "bypassPermissions">;

export const FeishuAccountConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(false),
  domain: FeishuDomainSchema.default("feishu"),
  proxyMode: FeishuProxyModeSchema.default("auto"),
  appId: z
    .string()
    .trim()
    .regex(/^cli_[0-9a-fA-F]{16}$/),
  secretRef: FeishuSecretRefSchema,
  tenantKey: z.string().trim().min(1).max(200).optional(),
  defaultProjectPath: z.string().trim().min(1).optional(),
  allowedWorkspaceRoots: z.array(z.string().trim().min(1)).default([]),
  allowedUsers: z.array(z.string().trim().min(1)).default([]),
  adminUsers: z.array(z.string().trim().min(1)).default([]),
  allowedChats: z.array(z.string().trim().min(1)).default([]),
  requireMentionInGroup: z.boolean().default(true),
  groupSessionMode: FeishuGroupSessionModeSchema.default(
    "thread-when-available",
  ),
  defaultProvider: z.literal("codex").default("codex"),
  defaultModel: z.string().trim().min(1).max(512).optional(),
  /**
   * Codex model used only when the current OpenAI-backed turn fails with the
   * native `usageLimitExceeded` signal. Omit to disable automatic failover.
   */
  codexUsageLimitFallbackModel: z.string().trim().min(1).max(512).optional(),
  defaultReasoningEffort: z.string().trim().min(1).max(64).optional(),
  defaultCodexMcpMode: z
    .enum(["clear", "standard", "full"])
    .default("standard"),
  defaultPermissionMode: FeishuPermissionModeSchema.default("default"),
  replyMode: FeishuReplyModeSchema.default("card"),
});

export type FeishuAccountConfig = z.infer<typeof FeishuAccountConfigSchema>;

export const FeishuAccountsFileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(FeishuAccountConfigSchema),
});
export type FeishuAccountsFile = z.infer<typeof FeishuAccountsFileSchema>;

export type FeishuSecretSource = "store" | "env" | "unknown";

export interface FeishuSecretStatus {
  configured: boolean;
  source: FeishuSecretSource;
  value?: string;
}

export interface FeishuAccountPublicView
  extends Omit<FeishuAccountConfig, "secretRef"> {
  secret: FeishuSecretStatus;
}

export interface FeishuAccountStatus {
  accountId: string;
  state: FeishuConnectionState;
  updatedAt: string;
  connectedAt?: string;
  lastEventAt?: string;
  lastApiSuccessAt?: string;
  lastErrorCode?: string;
  metrics: FeishuAccountMetrics;
}

/** Process-local, content-free counters and timing snapshots for one account. */
export interface FeishuAccountMetrics {
  eventsReceived: number;
  messagesReceived: number;
  cardActionsReceived: number;
  messagesAccepted: number;
  messagesDuplicateDropped: number;
  messagesRejected: number;
  messagesFailed: number;
  mergeForwardExpanded: number;
  mergeForwardItems: number;
  mergeForwardFailed: number;
  mediaDownloadsSucceeded: number;
  mediaDownloadsFailed: number;
  mediaBytes: number;
  repliesStarted: number;
  cardUpdates: number;
  cardUpdateDegraded: number;
  pendingApprovals: number;
  approvalsAccepted: number;
  approvalsRejected: number;
  approvalsExpired: number;
  scopeQueueDepth: number;
  lastNormalizationDurationMs?: number;
  lastMergeForwardDurationMs?: number;
  lastFirstFeedbackDurationMs?: number;
  lastFirstTokenDurationMs?: number;
  lastCompletionDurationMs?: number;
}

export const FeishuSessionBindingSchema = z.object({
  version: z.literal(1),
  scopeKey: z.string().min(1).max(1_024),
  accountId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  chatId: z.string().min(1).max(512),
  threadId: z.string().min(1).max(512).optional(),
  projectId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  projectPath: z.string().min(1),
  sessionId: z.string().min(1).max(512),
  provider: z.literal("codex"),
  permissionMode: FeishuPermissionModeSchema.optional(),
  model: z.string().min(1).max(512).optional(),
  reasoningEffort: z.string().min(1).max(64).optional(),
  codexMcpMode: z.enum(["clear", "standard", "full"]).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastInboundMessageId: z.string().min(1).max(512).optional(),
  lastInboundSenderOpenId: z.string().min(1).max(512).optional(),
});

export interface FeishuSessionBinding
  extends Omit<
    z.infer<typeof FeishuSessionBindingSchema>,
    "permissionMode" | "codexMcpMode"
  > {
  permissionMode?: FeishuPermissionMode;
  codexMcpMode?: CodexMcpMode;
}

export const FeishuBindingsFileSchema = z.object({
  version: z.literal(1),
  bindings: z.array(FeishuSessionBindingSchema),
});

export interface FeishuBindingsFile {
  version: 1;
  bindings: FeishuSessionBinding[];
}
