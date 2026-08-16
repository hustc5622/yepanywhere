import type { ClaudeSessionEntry } from "../claude-sdk-schema/types.js";
import type { CodexSessionEntry } from "../codex-schema/index.js";
import type { GeminiSessionFile } from "../gemini-schema/session.js";
import type { KimiSessionContent } from "../kimi-schema/types.js";
import type { OpenCodeSessionContent } from "../opencode-schema/session.js";
import type { PiSessionContent } from "../pi-schema/session.js";
import type { ZCodeSessionContent } from "../zcode-schema/session.js";

/**
 * Claude session file content - array of JSONL entries.
 * Uses the Zod-validated ClaudeSessionEntry type.
 */
export interface ClaudeSessionFile {
  messages: ClaudeSessionEntry[];
}

// Codex sessions are a series of entries (lines)
export interface CodexSessionContent {
  entries: CodexSessionEntry[];
}

export type UnifiedSession =
  | { provider: "claude"; session: ClaudeSessionFile }
  | { provider: "claude-ollama"; session: ClaudeSessionFile }
  | { provider: "codex"; session: CodexSessionContent }
  | { provider: "codex-oss"; session: CodexSessionContent }
  | { provider: "gemini"; session: GeminiSessionFile }
  | { provider: "opencode"; session: OpenCodeSessionContent }
  | { provider: "pi"; session: PiSessionContent }
  | { provider: "kimi"; session: KimiSessionContent }
  | { provider: "zcode"; session: ZCodeSessionContent };
