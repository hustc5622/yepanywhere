interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map Pi's built-in tool names onto Yep's existing rich renderers. */
export function canonicalizePiToolName(name: string): string {
  switch (name.toLowerCase()) {
    case "bash":
      return "Bash";
    case "read":
      return "Read";
    case "ls":
    case "find":
      return "Glob";
    case "edit":
      return "Edit";
    case "write":
      return "Write";
    case "grep":
      return "Grep";
    default:
      return name;
  }
}

function replacementPatch(edits: unknown[]): Array<{
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}> {
  return edits.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const oldText = typeof value.oldText === "string" ? value.oldText : "";
    const newText = typeof value.newText === "string" ? value.newText : "";
    const oldLines = oldText ? oldText.split("\n") : [];
    const newLines = newText ? newText.split("\n") : [];
    return [
      {
        // Pi's call arguments do not include source line numbers. These
        // stable hunks are only the pre-execution preview; the completed call
        // supplies Pi's native unified patch below.
        oldStart: index + 1,
        oldLines: Math.max(oldLines.length, 1),
        newStart: index + 1,
        newLines: Math.max(newLines.length, 1),
        lines: [
          ...oldLines.map((line) => `-${line}`),
          ...newLines.map((line) => `+${line}`),
        ],
      },
    ];
  });
}

/**
 * Adapt Pi's native inputs to the field names consumed by Yep's Codex-style
 * tool renderers. Native fields are retained for diagnostics and future
 * Pi-specific UI.
 */
export function normalizePiToolInput(
  nativeName: string,
  input: unknown,
  resultDetails?: unknown,
): Record<string, unknown> {
  const normalized = isRecord(input) ? { ...input } : {};
  const name = nativeName.toLowerCase();

  if (
    (name === "read" || name === "write" || name === "edit") &&
    typeof normalized.path === "string" &&
    typeof normalized.file_path !== "string"
  ) {
    normalized.file_path = normalized.path;
  }

  if (name === "ls" && typeof normalized.pattern !== "string") {
    normalized.pattern = "*";
  }

  if (name === "edit" && Array.isArray(normalized.edits)) {
    const edits = normalized.edits.filter(isRecord);
    const first = edits[0];
    if (first && typeof first.oldText === "string") {
      normalized.old_string = first.oldText;
    }
    if (first && typeof first.newText === "string") {
      normalized.new_string = first.newText;
    }

    const details = isRecord(resultDetails) ? resultDetails : undefined;
    const rawPatch =
      typeof details?.patch === "string" && details.patch.trim()
        ? details.patch
        : typeof details?.diff === "string" && details.diff.trim()
          ? details.diff
          : undefined;
    if (rawPatch) {
      normalized._rawPatch = rawPatch;
    } else {
      const structuredPatch = replacementPatch(edits);
      if (structuredPatch.length > 0) {
        normalized._structuredPatch = structuredPatch;
      }
    }
  }

  return normalized;
}
