/**
 * ZCode SQLite database path constants.
 *
 * The main transcript database lives at `~/.zcode/cli/db/db.sqlite`.
 * This is a read-only target for the ZCode session reader and scanner.
 *
 * Queries use the provider-neutral SQLite layer; this module owns only the
 * ZCode-specific database location.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const ZCODE_DATA_DIR =
  process.env.ZCODE_DATA_DIR ?? join(homedir(), ".zcode");

export const ZCODE_DB_PATH =
  process.env.ZCODE_DB_PATH ?? join(ZCODE_DATA_DIR, "cli", "db", "db.sqlite");
