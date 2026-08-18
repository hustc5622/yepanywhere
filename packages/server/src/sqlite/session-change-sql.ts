/**
 * Cheap digest for session/message/part SQLite schemas shared by providers.
 *
 * The aggregate changes for ordinary same-millisecond writes without loading
 * full JSON payloads into the API process.
 */
export const SESSION_DIGEST_SQL = `
  SELECT
    s.id AS id,
    s.time_updated AS session_updated,
    (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count,
    (SELECT MAX(m.id) FROM message m WHERE m.session_id = s.id) AS message_max_id,
    (SELECT MAX(m.time_updated) FROM message m WHERE m.session_id = s.id) AS message_updated,
    (SELECT SUM(LENGTH(m.data)) FROM message m WHERE m.session_id = s.id) AS message_bytes,
    (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id) AS part_count,
    (SELECT MAX(p.id) FROM part p WHERE p.session_id = s.id) AS part_max_id,
    (SELECT MAX(p.time_updated) FROM part p WHERE p.session_id = s.id) AS part_updated,
    (SELECT SUM(LENGTH(p.data)) FROM part p WHERE p.session_id = s.id) AS part_bytes
  FROM session s
  WHERE s.id = ?
`;

export function sessionDigestFromRow(
  row: Record<string, unknown> | null,
): string {
  if (!row) return "";
  return JSON.stringify([
    row.session_updated ?? null,
    row.message_count ?? 0,
    row.message_max_id ?? null,
    row.message_updated ?? null,
    row.message_bytes ?? 0,
    row.part_count ?? 0,
    row.part_max_id ?? null,
    row.part_updated ?? null,
    row.part_bytes ?? 0,
  ]);
}
