/**
 * Canonical file field for file tools (Read/Write/Edit) across providers.
 *
 * Yep's renderers and file preview read `file_path`. Providers name it
 * `path` (Pi, MiniMax Code, Cursor ACP), `filePath`, or only report ACP
 * `locations`. Provider adapters call this once instead of each copying the
 * field; native fields are kept for diagnostics.
 */
export function withCanonicalFilePath(
  input: Record<string, unknown>,
  locations?: unknown,
): Record<string, unknown> {
  if (typeof input.file_path === "string" && input.file_path) return input;
  const alias = [input.path, input.filePath].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const fromLocations = Array.isArray(locations)
    ? locations
        .map((location) =>
          location && typeof location === "object"
            ? (location as { path?: unknown }).path
            : undefined,
        )
        .find(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
    : undefined;
  const filePath = alias ?? fromLocations;
  return filePath ? { ...input, file_path: filePath } : input;
}
