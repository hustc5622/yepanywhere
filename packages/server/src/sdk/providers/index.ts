/**
 * Provider exports.
 *
 * Re-exports all provider implementations and types.
 */

// Types
import type { AgentProvider, ProviderName } from "./types.js";
export type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

// Claude provider (Agent SDK protocol, remote CLI over SSH only)
import { claudeProvider } from "./claude.js";
export {
  ClaudeProvider,
  claudeProvider,
  configureClaudeRemoteExecutors,
  configureClaudeSessionFileObserver,
  type ClaudeProviderConfig,
  type ClaudeSessionFileUpdate,
} from "./claude.js";

// Codex provider (uses codex CLI)
import { codexProvider } from "./codex.js";
export {
  CodexProvider,
  codexProvider,
  type CodexBridgeExecutionConfig,
  type CodexProviderConfig,
} from "./codex.js";

// Gemini provider (uses gemini CLI)
import { geminiProvider } from "./gemini.js";
export {
  GeminiProvider,
  geminiProvider,
  type GeminiProviderConfig,
} from "./gemini.js";

// Gemini ACP provider (uses gemini CLI with --experimental-acp)
import { geminiACPProvider } from "./gemini-acp.js";
export {
  GeminiACPProvider,
  geminiACPProvider,
  type GeminiACPProviderConfig,
} from "./gemini-acp.js";

// CodexOSS provider (uses codex CLI with --oss for local models)
import { codexOSSProvider } from "./codex-oss.js";
export {
  CodexOSSProvider,
  codexOSSProvider,
  type CodexOSSProviderConfig,
} from "./codex-oss.js";

// Pi provider (uses `pi --mode rpc` with a process-local Yep extension)
import { piProvider } from "./pi.js";
export { PiProvider, piProvider, type PiProviderConfig } from "./pi.js";

import { cursorProvider } from "./cursor.js";
export { CursorProvider, cursorProvider } from "./cursor.js";

// MiniMax Code provider (uses `mcode acp`; shares ~/.minimax with the App)
import { mcodeProvider } from "./mcode.js";
export {
  McodeProvider,
  mcodeProvider,
  type McodeProviderConfig,
} from "./mcode.js";

/**
 * Get all active provider instances exposed by the provider catalog.
 *
 * Claude remains available through getProvider() for historical session
 * compatibility, but its retired SSH channel must not participate in provider
 * discovery because that would trigger a remote control probe.
 */
export function getAllProviders(): AgentProvider[] {
  return [
    codexProvider,
    codexOSSProvider,
    geminiProvider,
    geminiACPProvider,
    piProvider,
    cursorProvider,
    mcodeProvider,
  ];
}

/**
 * Get a provider by name.
 *
 * Note: "gemini" maps to geminiACPProvider (ACP mode) since it's the better
 * implementation with proper permission handling. The non-ACP stream-json
 * provider is deprecated and will be removed.
 */
export function getProvider(name: ProviderName | string): AgentProvider | null {
  switch (name) {
    case "claude":
      return claudeProvider;
    case "codex":
      return codexProvider;
    case "codex-oss":
      return codexOSSProvider;
    case "gemini":
    case "gemini-acp":
      // Both map to ACP provider - "gemini" is legacy name for backward compatibility
      return geminiACPProvider;
    case "pi":
      return piProvider;
    case "cursor":
      return cursorProvider;
    case "mcode":
      return mcodeProvider;
    default:
      return null;
  }
}
