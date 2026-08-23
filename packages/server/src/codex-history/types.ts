export type CodexHistoryReadMode = "paginated-app-server" | "legacy-rollout";

export interface CodexHistoryCapability {
  protocolVersion: string;
  schemaHash: string;
  supportsThreadListStateDbOnly: boolean;
  supportsThreadTurnsList: boolean;
  supportsThreadItemsList: boolean;
}

export type CodexHistoryFallbackReason =
  | "disabled"
  | "provider_mismatch"
  | "legacy_history"
  | "unsupported_method"
  | "invalid_cursor"
  | "unmaterialized"
  | "transcript_parity"
  | "protocol_mismatch"
  | "app_server_timeout"
  | "app_server_unavailable"
  | "app_server_backoff"
  | "unsupported_query";

export interface SessionPageCursor {
  source: "codex-app-server" | "codex-rollout";
  revision?: string;
  cursor: string;
  /** Direction in which the upstream cursor must be consumed. */
  direction?: "older" | "newer";
  /** Prevents an opaque provider cursor from being reused for another thread. */
  sessionId?: string;
  /** Inclusive provider anchor to remove when it was already emitted. */
  overlapItemId?: string;
}

export type CodexHistoryClientFailure =
  | "backoff"
  | "unavailable"
  | "timeout"
  | "unsupported"
  | "invalid_cursor"
  | "unmaterialized"
  | "protocol";

export class CodexHistoryClientError extends Error {
  constructor(readonly reason: CodexHistoryClientFailure) {
    super(`Codex history client failure: ${reason}`);
    this.name = "CodexHistoryClientError";
  }
}
