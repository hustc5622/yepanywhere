/**
 * Canonical provider-group normalization.
 *
 * Session storage is shared per provider family: "codex-oss" sessions live in
 * the same rollout tree as "codex", "gemini-acp" shares ~/.gemini with the
 * legacy "gemini" name, and retired "claude-ollama" sessions sit in the
 * claude projects dir. Call sites that only support a subset of groups
 * (e.g. archiving) filter the result rather than redefining the mapping.
 */
export type ProviderGroup = "claude" | "codex" | "gemini" | "opencode" | "kimi";

export function normalizeProviderGroup(
  provider: string | null | undefined,
): ProviderGroup | null {
  if (!provider) return null;
  if (provider === "codex" || provider === "codex-oss") return "codex";
  if (provider === "gemini" || provider === "gemini-acp") return "gemini";
  if (provider === "opencode") return "opencode";
  if (provider === "kimi") return "kimi";
  if (provider === "claude" || provider === "claude-ollama") return "claude";
  return null;
}
