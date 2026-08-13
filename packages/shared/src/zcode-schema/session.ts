/**
 * ZCode persisted session content.
 *
 * This is the shape used by `UnifiedSession` when `provider === "zcode"`.
 * It mirrors the relevant columns of the ZCode SQLite database at
 * `~/.zcode/cli/db/db.sqlite`:
 *   - `session` table: 25 columns (id, project_id, directory, title, etc.)
 *   - `message` table: 6 columns (id, session_id, time_created, data, sequence)
 *   - `part` table: 7 columns (id, message_id, session_id, data, sequence)
 *
 * `message.data` and `part.data` are JSON text columns. The JSON structure:
 *   - message.data: `{ role, time: { created, completed }, model?, ... }`
 *   - part.data: `{ type, text?, time?, callID?, tool?, state?: { status, input, output } }`
 *
 * Part types observed: `text`, `reasoning`, `tool`, `step-start`, `step-finish`,
 * `timeline`, `file`. Unknown types are safely ignored by the normalizer.
 */

/**
 * A stored message in a ZCode session.
 *
 * Mapped from the `message` table row. The `data` column is parsed and
 * spread into the object; `role` and `time` are the key fields.
 */
export interface ZCodeStoredMessage {
  /** Native ZCode message ID (from `message.id` column). */
  id: string;
  /** `"user"` or `"assistant"` (from `message.data.role`). */
  role: string;
  /** Creation timestamp in ms epoch (from `message.time_created`). */
  createdAt?: number;
  /** Update timestamp in ms epoch (from `message.time_updated`). */
  updatedAt?: number;
  /** Resolved model for assistant messages (from `message.data.modelID`). */
  model?: string;
  /** Parent message ID (from `message.data.parentID`). */
  parentID?: string;
  /**
   * Raw part objects from the `part` table, ordered by
   * `message_id, sequence IS NULL, sequence, time_created, id`.
   * Each part's `data` column is parsed and spread with `id`/`messageID`/`sessionID`.
   */
  parts: ZCodeStoredPart[];
}

/**
 * A stored part in a ZCode message.
 *
 * Mapped from the `part` table row. The `data` column is parsed and
 * spread into the object; `type` is the discriminator.
 */
export interface ZCodeStoredPart {
  /** Native ZCode part ID (from `part.id` column). */
  id: string;
  /** Owning message ID (from `part.message_id`). */
  messageID: string;
  /** Owning session ID (from `part.session_id`). */
  sessionID: string;
  /** Part type discriminator (from `part.data.type`). */
  type: string;
  /** Additional fields from `part.data` (text, reasoning, tool state, etc.). */
  [key: string]: unknown;
}

/**
 * Persisted ZCode session content.
 *
 * Contains session metadata and the reconstructed message list.
 */
export interface ZCodeSessionContent {
  sessionId: string;
  /** Session title (from `session.title`). */
  title?: string;
  /** Project directory (from `session.directory`). */
  directory?: string;
  /** Creation timestamp in ms epoch (from `session.time_created`). */
  createdAt?: number;
  /** Update timestamp in ms epoch (from `session.time_updated`). */
  updatedAt?: number;
  /** Resolved model (from `session` metadata or last assistant message). */
  model?: string;
  /** Execution mode (from `session.permission` JSON `{ mode }`). */
  mode?: string;
  /** Whether the session is archived (from `session.time_archived`). */
  archived?: boolean;
  /** Reconstructed messages in order. */
  messages: ZCodeStoredMessage[];
}
