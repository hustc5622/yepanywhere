import type { ProviderName } from "@yep-anywhere/shared";

export interface SessionFileEvent {
  relativePath: string;
  provider?: ProviderName;
}

export function extractSessionIdFromFileEvent(
  event: SessionFileEvent,
): string | null {
  const pathParts = event.relativePath.split(/[\\/]/).filter(Boolean);
  const filename = pathParts.at(-1);
  if (!filename) return null;

  // Kimi stores one wire log per agent at
  // <workspace>/<sessionId>/agents/<agentId>/wire.jsonl. The basename is
  // therefore always "wire", so recover the session id from the directory
  // immediately above "agents" instead.
  if (event.provider === "kimi") {
    const agentsIndex = pathParts.lastIndexOf("agents");
    if (agentsIndex > 0) {
      return pathParts[agentsIndex - 1] ?? null;
    }
  }

  let base = filename;
  if (base.endsWith(".jsonl")) {
    base = base.slice(0, -6);
  } else if (base.endsWith(".json")) {
    base = base.slice(0, -5);
  }

  if (event.provider === "codex" || event.provider === "pi") {
    const match = base.match(/([0-9a-fA-F-]{36})$/);
    if (match) return match[1] ?? null;
  }

  return base;
}
