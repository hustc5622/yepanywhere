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
  raw: unknown;
  createdAt: string;
}

export type OpenCodeBridgeInputResponse = BridgeInputResponse;

export type OpenCodeBridgeController = BridgeController<
  OpenCodeBridgeStatus,
  OpenCodeBridgeSession
>;
