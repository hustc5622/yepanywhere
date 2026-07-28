function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenCodeAbortError(error: unknown): boolean {
  if (!isRecord(error) || typeof error.name !== "string") return false;
  const name = error.name.toLowerCase();
  return name === "aborterror" || name === "messageabortederror";
}

/**
 * Extract the user-facing message from OpenCode's persisted/runtime error
 * shapes. API errors keep their useful detail in `data.message`, while older
 * versions may expose a top-level message or only an error name.
 */
export function formatOpenCodeError(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (!isRecord(error)) return String(error);

  if (isRecord(error.data)) {
    const message = error.data.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  if (typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }

  if (typeof error.name === "string" && error.name.trim()) {
    return error.name;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "OpenCode message failed";
  }
}
