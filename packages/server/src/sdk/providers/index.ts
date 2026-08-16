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

// OpenCode provider (uses opencode serve for multi-provider agent)
import { opencodeProvider } from "./opencode.js";
export {
  OpenCodeProvider,
  opencodeProvider,
  type OpenCodeProviderConfig,
} from "./opencode.js";

// Pi provider (uses `pi --mode rpc` with a process-local Yep extension)
import { piProvider } from "./pi.js";
export { PiProvider, piProvider, type PiProviderConfig } from "./pi.js";

// Kimi provider (uses `kimi acp` for ACP-based agent execution)
import { kimiProvider } from "./kimi.js";
export {
  KimiProvider,
  kimiProvider,
  type KimiProviderConfig,
} from "./kimi.js";

// ZCode provider (uses `zcode app-server` for JSON-RPC over stdio)
import { zcodeProvider } from "./zcode.js";
export {
  ZCodeProvider,
  zcodeProvider,
  type ZCodeProviderConfig,
} from "./zcode.js";

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
    opencodeProvider,
    piProvider,
    kimiProvider,
    zcodeProvider,
  ];
}

/**
 * Get a provider by name.
 *
 * Note: "gemini" maps to geminiACPProvider (ACP mode) since it's the better
 * implementation with proper permission handling. The non-ACP stream-json
 * provider is deprecated and will be removed.
 */
export function getProvider(name: ProviderName): AgentProvider | null {
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
    case "opencode":
      return opencodeProvider;
    case "pi":
      return piProvider;
    case "kimi":
      return kimiProvider;
    case "zcode":
      return zcodeProvider;
    default:
      return null;
  }
}
