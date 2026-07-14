import type {
  AgentActivity,
  InputRequest,
  PendingInputType,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionSummary } from "../supervisor/types.js";

export interface OpenCodeBridgeStatus {
  enabled: boolean;
  listening: boolean;
  host: string;
  port: number;
  url: string;
  serverUrl: string;
  opencodeServerUrl: string;
  opencodeServerMode: "managed" | "external";
  opencodeServerRunning: boolean;
  opencodeServerPid: number | null;
  opencodeConnected: boolean;
  sessionCount: number;
  pendingInputCount: number;
  lastError: string | null;
}

export interface OpenCodeBridgeSession {
  id: string;
  projectId: UrlProjectId;
  projectPath: string;
  projectName: string;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  provider: "opencode";
  model?: string;
  reasoningEffort?: string;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  active: boolean;
}

export interface OpenCodeBridgeSessionView {
  session: SessionSummary;
  projectName: string;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
}

export interface OpenCodeBridgePendingInput {
  request: InputRequest;
  requestId: string;
  kind: "permission" | "question";
  raw: unknown;
  createdAt: string;
}

export type OpenCodeBridgeInputResponse =
  | "approve"
  | "approve_accept_edits"
  | "approve_for_session"
  | "approve_always"
  | "deny";

export type MaybePromise<T> = T | Promise<T>;

export interface OpenCodeBridgeController {
  start?(): MaybePromise<void>;
  shutdown?(): MaybePromise<void>;
  getStatus(): MaybePromise<OpenCodeBridgeStatus>;
  listSessions(): MaybePromise<OpenCodeBridgeSession[]>;
  listSessionViews(): MaybePromise<OpenCodeBridgeSessionView[]>;
  getSessionView(
    sessionId: string,
  ): MaybePromise<OpenCodeBridgeSessionView | null>;
  isSessionActive(sessionId: string): MaybePromise<boolean>;
  getPendingInputRequest(
    sessionId: string,
  ): MaybePromise<OpenCodeBridgePendingInput["request"] | null>;
  respondToInput(
    sessionId: string,
    requestId: string,
    response: OpenCodeBridgeInputResponse,
    answers?: Record<string, string>,
  ): MaybePromise<boolean>;
}
