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

/** Actor identity already authenticated by the central interaction broker. */
export interface BridgeInputResolutionActor {
  id: string;
  displayName?: string;
  channel: "yep" | "feishu" | "provider" | "system";
}

/**
 * Proof that a bridge response has already won the central broker CAS.
 *
 * `operationVersion` is the claimed (`answering`) version, not the version
 * originally rendered by a client. Sidecars use this proof to reject direct
 * or replayed responses that bypass the broker.
 */
export interface BridgeInputResolutionContext {
  operationId: string;
  operationVersion: number;
  actor: BridgeInputResolutionActor;
}

/** Broker identity bound to a pending bridge request before it is answerable. */
export type BridgePendingInputBinding = Pick<
  BridgeInputResolutionContext,
  "operationId" | "operationVersion"
>;

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
  /** Transport-local id of the currently projected queue head, if any. */
  pendingInputRequestId?: string;
  /**
   * The sidecar's own liveness verdict, i.e. exactly what
   * `GET /sessions/:id/active` would answer for this session.
   *
   * It is deliberately *not* re-derivable from `activity` /
   * `pendingInputType`: a codex session whose TUI died mid-turn keeps
   * `activity: "in-turn"` while holding no connection, so treating live
   * activity as "active" would strand it in the inbox forever. Shipping the
   * verdict inside the bulk `/session-views` snapshot lets callers answer
   * liveness for a whole list without a per-session round-trip. Optional so
   * that an older sidecar (which omits it) still degrades to the
   * activity-derived approximation.
   */
  active?: boolean;
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
  /** Bind the central broker operation to the provider request. */
  bindPendingInputInteraction?(
    sessionId: string,
    requestId: string,
    binding: BridgePendingInputBinding,
  ): MaybePromise<boolean>;
  respondToInput(
    sessionId: string,
    requestId: string,
    response: BridgeInputResponse,
    answers?: UserQuestionAnswers,
    context?: BridgeInputResolutionContext,
  ): MaybePromise<boolean>;
}
