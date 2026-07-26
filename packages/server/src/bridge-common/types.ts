/**
 * Shared contracts for CLI bridge sidecars (codex-bridge, opencode-bridge).
 *
 * Each bridge exposes the same control surface to the main server: a status
 * endpoint, a list of externally-owned sessions, per-session views, and a
 * pending-input request/response channel. Provider-specific bridges extend
 * these base shapes with their own status/session fields.
 */
import type {
  AgentActivity,
  InputRequest,
  PendingInputType,
  UrlProjectId,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import type { SessionSummary } from "../supervisor/types.js";

export type MaybePromise<T> = T | Promise<T>;

/** Decision values carried by the shared pending-input control plane. */
export type BridgeInputResponse =
  | "approve"
  | "approve_accept_edits"
  | "approve_for_session"
  | "approve_strict_auto_review"
  | "approve_always"
  | "deny";

/** Fields shared by every bridge-tracked session, regardless of provider. */
export interface BridgeSessionBase {
  id: string;
  projectId: UrlProjectId;
  projectPath: string;
  projectName: string;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model?: string;
  reasoningEffort?: string;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  /** Terminal status of the most recent turn (provider-reported). */
  lastTurnStatus?: "completed" | "interrupted" | "failed";
  /** Most recent provider error message, if the last turn failed. */
  lastErrorMessage?: string;
}

export interface BridgeSessionView {
  session: SessionSummary;
  projectName: string;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
}

/** Status fields shared by every bridge sidecar. */
export interface BridgeStatusBase {
  enabled: boolean;
  listening: boolean;
  host: string;
  port: number;
  url: string;
  sessionCount: number;
  pendingInputCount: number;
  lastError: string | null;
}

/**
 * Control contract implemented both by the in-process bridge service and by
 * the HTTP client that talks to an external sidecar. Route handlers only
 * depend on this interface, which is what allows the sidecar deployment mode.
 */
export interface BridgeController<
  TStatus extends BridgeStatusBase = BridgeStatusBase,
  TSession extends BridgeSessionBase = BridgeSessionBase,
> {
  start?(): MaybePromise<void>;
  shutdown?(): MaybePromise<void>;
  /**
   * Inject a resolver that reports whether a session is currently owned by the
   * local Supervisor (ownership `self`). Implementations that replay bridge
   * lifecycle changes onto the local EventBus must not emit `external`/`none`
   * ownership for owned sessions: ownership of owned sessions is governed
   * solely by the Supervisor, and a racing bridge poll would otherwise flip
   * the client into a transient "external session" state. Optional because
   * only the HTTP-client transport needs it.
   */
  setOwnershipResolver?(resolver: (sessionId: string) => boolean): void;
  getStatus(): MaybePromise<TStatus>;
  listSessions(): MaybePromise<TSession[]>;
  listSessionViews(): MaybePromise<BridgeSessionView[]>;
  getSessionView(sessionId: string): MaybePromise<BridgeSessionView | null>;
  isSessionActive(sessionId: string): MaybePromise<boolean>;
  getPendingInputRequest(sessionId: string): MaybePromise<InputRequest | null>;
  respondToInput(
    sessionId: string,
    requestId: string,
    response: BridgeInputResponse,
    answers?: UserQuestionAnswers,
  ): MaybePromise<boolean>;
}
