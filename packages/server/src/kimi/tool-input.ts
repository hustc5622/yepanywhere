/**
 * Normalize Kimi's native built-in tool arguments into the field names used
 * by Yep's shared renderers. Keep the native fields as well so diagnostics and
 * future Kimi-specific UI can still inspect the original payload.
 */
export function normalizeKimiToolInput(
  toolName: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const normalized = { ...(args ?? {}) };
  const lowerToolName = toolName.toLowerCase();

  if (
    (lowerToolName === "read" ||
      lowerToolName === "write" ||
      lowerToolName === "edit") &&
    typeof normalized.path === "string" &&
    typeof normalized.file_path !== "string"
  ) {
    normalized.file_path = normalized.path;
  }

  if (
    lowerToolName === "read" &&
    typeof normalized.line_offset === "number" &&
    typeof normalized.offset !== "number"
  ) {
    normalized.offset = normalized.line_offset;
  }

  if (
    lowerToolName === "read" &&
    typeof normalized.n_lines === "number" &&
    typeof normalized.limit !== "number"
  ) {
    normalized.limit = normalized.n_lines;
  }

  return normalized;
}
