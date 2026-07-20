import type { InputRequest } from "@yep-anywhere/shared";
import type {
  BridgeController,
  BridgeInputResponse,
  BridgeSessionBase,
  BridgeSessionView,
  BridgeStatusBase,
  MaybePromise,
} from "../bridge-common/types.js";

export type { MaybePromise };

export type OpenCodeApprovalProtocol = "v1" | "v2";

export interface OpenCodeBridgeStatus extends BridgeStatusBase {
  serverUrl: string;
  opencodeServerUrl: string;
  opencodeServerMode: "managed" | "external";
  opencodeServerRunning: boolean;
  opencodeServerPid: number | null;
  opencodeConnected: boolean;
}

export interface OpenCodeBridgeSession extends BridgeSessionBase {
  provider: "opencode";
  /** OpenCode task/subagent parent; child sessions stay out of list views. */
  parentSessionId?: string;
  active: boolean;
  /** Present while OpenCode is retrying a failed provider request. */
  retryStatus?: {
    attempt?: number;
    message?: string;
    /** Epoch ms of the next retry attempt. */
    next?: number;
    actionLabel?: string;
    actionLink?: string;
  };
}

export type OpenCodeBridgeSessionView = BridgeSessionView;

export interface OpenCodeBridgePendingInput {
  request: InputRequest;
  requestId: string;
  kind: "permission" | "question";
  /** OpenCode API generation that owns this request. */
  protocol: OpenCodeApprovalProtocol;
  raw: unknown;
  createdAt: string;
  /**
   * Present when the request came from an external OpenCode instance (via the
   * Yep forwarder plugin) instead of the bridge-managed server. Decisions for
   * these requests are queued for the plugin to apply in-process.
   */
  instanceId?: string;
  /** Stable while an external decision is retried and acknowledged. */
  externalDecisionId?: string;
}

/**
 * A user decision queued for an external OpenCode instance. The Yep forwarder
 * plugin long-polls these and applies them through its in-process SDK client.
 */
export interface ExternalOpenCodeDecision {
  /** Delivery/idempotency key used by the plugin and bridge ACK endpoint. */
  id: string;
  /** OpenCode already emitted the terminal event; skip application and ACK. */
  confirmed?: boolean;
  kind: "permission" | "question";
  protocol: OpenCodeApprovalProtocol;
  requestId: string;
  sessionId: string;
  /** Permission decisions map to OpenCode's reply values. */
  reply?: "once" | "always" | "reject";
  /** Question decisions either reply with answers or reject. */
  action?: "reply" | "reject";
  /** Ordered answers (each an array of selected labels) for question replies. */
  answers?: string[][];
}

export type OpenCodeBridgeInputResponse = BridgeInputResponse;

export type OpenCodeBridgeController = BridgeController<
  OpenCodeBridgeStatus,
  OpenCodeBridgeSession
>;
