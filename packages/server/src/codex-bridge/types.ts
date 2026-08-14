import type { ContextUsage, InputRequest } from "@yep-anywhere/shared";
import type {
  BridgeController,
  BridgeInputResponse,
  BridgeSessionBase,
  BridgeSessionView,
  BridgeStatusBase,
  MaybePromise,
} from "../bridge-common/types.js";

export type { MaybePromise };

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
  /** Top-level app-server notification timestamp (Codex 0.147+). */
  emittedAtMs?: number;
}

export interface CodexBridgeStatus extends BridgeStatusBase {
  upstreamUrl: string | null;
  upstreamRunning: boolean;
  upstreamMode: "managed" | "external";
  upstreams: Record<CodexBridgeUpstreamProfile, CodexBridgeUpstreamStatus>;
  connectionCount: number;
  attachedClientCount: number;
  detachedConnectionCount: number;
  recentMcpStartupEvents: CodexBridgeMcpStartupEvent[];
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

export interface CodexBridgeSession extends BridgeSessionBase {
  provider: "codex";
  serviceTier?: string;
  /** Context window fill reported by the app-server, when observed. */
  contextUsage?: ContextUsage;
  connectionIds: number[];
}

export type CodexBridgeSessionView = BridgeSessionView;

export interface CodexBridgePendingInput {
  request: InputRequest;
  createdAt: string;
}

export type CodexBridgeInputResponse = BridgeInputResponse;

export interface CodexBridgeController
  extends BridgeController<CodexBridgeStatus, CodexBridgeSession> {
  getUsage?(
    options?: CodexUsageRequestOptions,
  ): MaybePromise<CodexUsageResponse>;
}
