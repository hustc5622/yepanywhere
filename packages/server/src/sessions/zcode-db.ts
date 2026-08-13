/**
 * ZCode SQLite database path constants.
 *
 * The main transcript database lives at `~/.zcode/cli/db/db.sqlite`.
 * This is a read-only target for the ZCode session reader and scanner.
 *
 * The DB helpers in `opencode-db.ts` (`queryOpenCodeRows`,
 * `queryOpenCodeRowsOrEmpty`, `runOpenCodeDbStatements`) and the worker
 * pool in `opencode-db-worker.ts` are db-path-keyed and work with any
 * SQLite file. ZCode imports them directly rather than maintaining a
 * parallel worker pool.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const ZCODE_DATA_DIR =
  process.env.ZCODE_DATA_DIR ?? join(homedir(), ".zcode");

export const ZCODE_DB_PATH =
  process.env.ZCODE_DB_PATH ?? join(ZCODE_DATA_DIR, "cli", "db", "db.sqlite");
