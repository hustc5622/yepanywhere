/**
 * Result of resolving a bare session id back to the project that owns it.
 *
 * Every session read path in Yep is keyed by `projectId + sessionId`, but the
 * ids handed to users (copied from the UI, pasted into an agent, quoted in a
 * bug report) carry no project. `GET /api/sessions/:sessionId/locate` closes
 * that gap so a bare id becomes addressable again.
 */

import type { UrlProjectId } from "../projectId.js";
import type { ProviderName } from "../types.js";

/**
 * Which lookup answered. Purely diagnostic — useful when a locate result
 * points at an unexpected project and you need to know who claimed it.
 */
export type SessionLocationSource =
  | "archive"
  | "bridge"
  | "codex-manifest"
  | "opencode-db"
  | "claude-file"
  | "metadata"
  | "provider-scan";

export interface SessionLocation {
  /**
   * Canonical session id. May differ from the requested id when a provider
   * swapped a bootstrap id for a durable one.
   */
  sessionId: string;
  /** The id as requested, echoed so clients can detect alias redirects. */
  requestedSessionId: string;
  provider: ProviderName;
  projectId: UrlProjectId;
  projectPath: string;
  projectName: string;
  /** Which lookup produced this answer. */
  source: SessionLocationSource;
  /** True when the session has been cold-archived off the hot scan paths. */
  archived: boolean;
}

export interface SessionLocateResponse {
  session: SessionLocation;
}
