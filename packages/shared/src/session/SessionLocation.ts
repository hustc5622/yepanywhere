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

/**
 * Physical provider file backing one session, from
 * `GET /api/projects/:projectId/sessions/:sessionId/source-file`.
 */
export interface SessionSourceFileResponse {
  /** Absolute path on the machine that holds the file; null when unknown. */
  path: string | null;
  /**
   * SSH host when the file lives on a configured remote executor. The path is
   * then the remote machine's path, not necessarily readable from the Yep
   * server's filesystem (`ssh-replica` storage keeps only a copy).
   */
  remoteHost?: string;
}
