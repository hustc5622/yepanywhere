import type {
  AgentActivity,
  InputRequest,
  PendingInputType,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionSummary } from "../supervisor/types.js";

export type JsonRpcId = string | number;
export type CodexBridgeUpstreamProfile = "clear" | "light" | "full";

export interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export interface CodexBridgeStatus {
  enabled: boolean;
  listening: boolean;
  host: string;
  port: number;
  url: string;
  upstreamUrl: string | null;
  upstreamRunning: boolean;
  upstreamMode: "managed" | "external";
  upstreams: Record<CodexBridgeUpstreamProfile, CodexBridgeUpstreamStatus>;
  connectionCount: number;
  sessionCount: number;
  pendingInputCount: number;
  recentMcpStartupEvents: CodexBridgeMcpStartupEvent[];
  lastError: string | null;
}

export interface CodexBridgeUpstreamStatus {
  profile: CodexBridgeUpstreamProfile;
  url: string | null;
  running: boolean;
  starting: boolean;
  pid: number | null;
  args: string[];
}

export interface CodexBridgeMcpStartupEvent {
  timestamp: string;
  profile: CodexBridgeUpstreamProfile;
  connectionId: number;
  threadId?: string;
  name?: string;
  status?: string;
  error: string | null;
}

export interface CodexUsageWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexUsageBucket {
  id: string;
  name: string | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  planType: string | null;
}

export interface CodexUsageResetCredits {
  availableCount: number;
}

export interface CodexUsageSnapshot {
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  planType: string | null;
  resetCredits: CodexUsageResetCredits | null;
  additionalBuckets: CodexUsageBucket[];
  updatedAt: string;
}

export interface CodexUsageResponse {
  usage: CodexUsageSnapshot | null;
  error: string | null;
}

export interface CodexUsageRequestOptions {
  fresh?: boolean;
}

export interface CodexBridgeSession {
  id: string;
  projectId: UrlProjectId;
  projectPath: string;
  projectName: string;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  provider: "codex";
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  connectionIds: number[];
}

export interface CodexBridgeSessionView {
  session: SessionSummary;
  projectName: string;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
}

export interface CodexBridgePendingInput {
  request: InputRequest;
  method: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  createdAt: string;
}

export type CodexBridgeInputResponse =
  | "approve"
  | "approve_accept_edits"
  | "approve_for_session"
  | "approve_always"
  | "deny";

export type MaybePromise<T> = T | Promise<T>;

export interface CodexBridgeController {
  start?(): MaybePromise<void>;
  shutdown?(): MaybePromise<void>;
  getStatus(): MaybePromise<CodexBridgeStatus>;
  getUsage?(
    options?: CodexUsageRequestOptions,
  ): MaybePromise<CodexUsageResponse>;
  listSessions(): MaybePromise<CodexBridgeSession[]>;
  listSessionViews(): MaybePromise<CodexBridgeSessionView[]>;
  getSessionView(
    sessionId: string,
  ): MaybePromise<CodexBridgeSessionView | null>;
  isSessionActive(sessionId: string): MaybePromise<boolean>;
  getPendingInputRequest(
    sessionId: string,
  ): MaybePromise<CodexBridgePendingInput["request"] | null>;
  respondToInput(
    sessionId: string,
    requestId: string,
    response: CodexBridgeInputResponse,
    answers?: Record<string, string>,
  ): MaybePromise<boolean>;
}
