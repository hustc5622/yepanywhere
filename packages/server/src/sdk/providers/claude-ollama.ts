/**
 * Claude + Ollama provider.
 *
 * Uses the Claude SDK agent loop (tools, permissions, session persistence)
 * but routes API calls to an Ollama instance via ANTHROPIC_BASE_URL.
 * Ollama 0.14+ natively speaks the Anthropic Messages API.
 */

import type { ModelInfo } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { ClaudeProvider } from "./claude.js";
import { OllamaClient, getOllamaUrl, setOllamaUrl } from "./ollama-client.js";
import type { AuthStatus } from "./types.js";

/**
 * Claude + Ollama provider.
 * Extends ClaudeProvider, overriding env injection and model discovery.
 */
export class ClaudeOllamaProvider extends ClaudeProvider {
  override readonly name = "claude-ollama" as const;
  override readonly displayName = "Claude + Ollama";

  /** Custom system prompt override (undefined = use default minimal prompt). */
  private static customSystemPrompt: string | undefined;

  /** Whether to use the full Claude system prompt instead of the minimal/custom one. */
  private static useFullSystemPrompt = false;

  /**
   * Update the Ollama URL at runtime (called from settings route).
   */
  static setOllamaUrl(url: string | undefined): void {
    setOllamaUrl(url);
  }

  /**
   * Get the current Ollama URL.
   */
  static getOllamaUrl(): string {
    return getOllamaUrl();
  }

  /**
   * Update the custom system prompt at runtime (called from settings route).
   */
  static setSystemPrompt(prompt: string | undefined): void {
    ClaudeOllamaProvider.customSystemPrompt = prompt;
  }

  /**
   * Toggle using the full Claude system prompt (called from settings route).
   */
  static setUseFullSystemPrompt(enabled: boolean): void {
    ClaudeOllamaProvider.useFullSystemPrompt = enabled;
  }

  /**
   * Check if Ollama is reachable by pinging its API.
   * If the user explicitly configured a URL, skip detection and assume available.
   */
  override async isInstalled(): Promise<boolean> {
    return new OllamaClient(getOllamaUrl(), 3000).isReachable();
  }

  /**
   * No authentication needed for Ollama.
   */
  override async isAuthenticated(): Promise<boolean> {
    return this.isInstalled();
  }

  override async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    return {
      installed,
      authenticated: installed,
      enabled: installed,
    };
  }

  /**
   * Fetch available models from Ollama's HTTP API.
   * Works over SSH tunnels (unlike `ollama list` CLI).
   */
  override async getAvailableModels(): Promise<ModelInfo[]> {
    const log = getLogger();
    try {
      return await new OllamaClient(getOllamaUrl()).listModels();
    } catch (error) {
      log.debug({ error }, "Failed to fetch Ollama models");
      return [];
    }
  }

  /**
   * Use a minimal system prompt that local models can actually follow.
   * The full claude_code preset is far too complex for most Ollama models
   * and causes them to get stuck in tool-calling loops.
   *
   * When useFullSystemPrompt is enabled (for large-context models like Qwen3),
   * delegates to the parent ClaudeProvider to use the full claude_code preset.
   */
  protected override getSystemPrompt(
    globalInstructions?: string,
  ):
    | string
    | { type: "preset"; preset: "claude_code"; append?: string }
    | undefined {
    if (ClaudeOllamaProvider.useFullSystemPrompt) {
      return super.getSystemPrompt(globalInstructions);
    }
    const base =
      ClaudeOllamaProvider.customSystemPrompt ||
      "You are a helpful coding assistant. You help users with software engineering tasks. You have access to tools for reading files, editing files, running shell commands, and searching code. Use tools when needed to answer questions or make changes. Be concise and direct.";
    return globalInstructions ? `${base}\n\n${globalInstructions}` : base;
  }

  /**
   * Inject ANTHROPIC_BASE_URL pointing at Ollama into the child process env.
   */
  protected override getEnv(): Record<string, string | undefined> {
    return {
      ...super.getEnv(),
      ANTHROPIC_BASE_URL: getOllamaUrl(),
      ANTHROPIC_AUTH_TOKEN: "ollama",
    };
  }
}

/** Singleton instance */
export const claudeOllamaProvider = new ClaudeOllamaProvider();
