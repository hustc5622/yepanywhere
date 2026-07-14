import type { ProviderName } from "@yep-anywhere/shared";
import { MODEL_OPTIONS } from "../hooks/useModelSettings";

const PROVIDER_COLORS: Record<ProviderName, string> = {
  claude: "var(--provider-claude)", // Claude orange
  "claude-ollama": "var(--provider-claude)", // Same as Claude (uses Claude SDK)
  codex: "var(--provider-codex)", // OpenAI green
  "codex-oss": "var(--provider-codex)", // OpenAI green (same as codex)
  gemini: "var(--provider-gemini)", // Google blue
  "gemini-acp": "var(--provider-gemini)", // Google blue (same as gemini)
  opencode: "var(--provider-opencode)", // OpenCode purple
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: "Claude",
  // Same product brand as `claude` (both use the Claude SDK + Anthropic agent
  // loop). The model name is what distinguishes them — e.g. "Sonnet 4" vs a
  // local "MiniMax-M3" — so we deliberately don't surface "Ollama" as the
  // short label here; the model chip carries that information instead.
  "claude-ollama": "Claude",
  codex: "Codex",
  "codex-oss": "CodexOSS",
  gemini: "Gemini",
  "gemini-acp": "Gemini ACP",
  opencode: "OpenCode",
};

interface ProviderBadgeProps {
  provider: ProviderName;
  /** Show as small dot only (for sidebar) vs full badge (for header) */
  compact?: boolean;
  /** Model name to display alongside provider (e.g., "opus", "sonnet") */
  model?: string;
  /** Provider-specific reasoning effort (e.g., Codex "xhigh", Claude "max") */
  reasoningEffort?: string;
  /** Provider-specific service tier / speed label (e.g., "fast") */
  serviceTier?: string;
  /** Whether the session is actively thinking/processing */
  isThinking?: boolean;
  className?: string;
}

/**
 * Badge showing which AI provider is running a session.
 * Use compact mode for sidebar lists, full mode for session headers.
 */
export function ProviderBadge({
  provider,
  compact = false,
  model,
  reasoningEffort,
  serviceTier,
  isThinking = false,
  className = "",
}: ProviderBadgeProps) {
  const color = PROVIDER_COLORS[provider];
  const label = PROVIDER_LABELS[provider];

  // Format model name for display
  const getModelLabel = (modelName: string | undefined): string | null => {
    if (!modelName) return null;
    if (modelName === "default") return null;
    const isExtendedContext = modelName.includes("[1m]");

    // Check if it's a known short model option (e.g., "opus", "sonnet")
    const knownModel = MODEL_OPTIONS.find((o) => o.value === modelName);
    if (knownModel && knownModel.value !== "default") {
      return knownModel.label;
    }

    // Parse full model IDs like "claude-opus-4-5-20251101" or "claude-sonnet-4-20250514"
    // Extract the model family (opus, sonnet, haiku) from the full ID
    const claudeMatch = modelName.match(/claude-(\w+)-/);
    if (claudeMatch?.[1]) {
      const family = claudeMatch[1];
      // Check if the extracted family is a known model
      const familyModel = MODEL_OPTIONS.find((o) => o.value === family);
      if (familyModel) {
        return isExtendedContext
          ? `${familyModel.label} 1M`
          : familyModel.label;
      }
      // Capitalize unknown family
      const capitalized = family.charAt(0).toUpperCase() + family.slice(1);
      return isExtendedContext ? `${capitalized} 1M` : capitalized;
    }

    // For other models, capitalize first letter
    const capitalized = modelName.charAt(0).toUpperCase() + modelName.slice(1);
    return isExtendedContext ? `${capitalized} 1M` : capitalized;
  };

  const normalizeConfigLabel = (value: string | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };

  const getReasoningEffortLabel = (
    effort: string | undefined,
  ): string | null => {
    const normalized = normalizeConfigLabel(effort);
    if (
      !normalized ||
      normalized === "none" ||
      (provider === "opencode" && normalized === "default")
    ) {
      return null;
    }
    if (
      (provider === "codex" || provider === "codex-oss") &&
      normalized === "max"
    ) {
      return "xhigh";
    }
    return normalized;
  };

  const modelLabel = getModelLabel(model);
  const configLabel = [
    modelLabel,
    getReasoningEffortLabel(reasoningEffort),
    normalizeConfigLabel(serviceTier),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");

  if (compact) {
    return (
      <span
        className={`provider-badge-stripe ${className}`}
        style={{ backgroundColor: color }}
        title={configLabel ? `${label} (${configLabel})` : label}
        aria-label={`Provider: ${label}${configLabel ? ` (${configLabel})` : ""}`}
      />
    );
  }

  // When thinking, dot is always orange with pulse animation
  const dotClass = isThinking
    ? "provider-badge-dot-inline thinking"
    : "provider-badge-dot-inline";
  const dotStyle = isThinking
    ? { backgroundColor: "var(--thinking-color)" }
    : { backgroundColor: color };

  return (
    <span
      className={`provider-badge ${className}`}
      style={{ borderColor: color, color }}
    >
      <span className={dotClass} style={dotStyle} />
      <span className="provider-badge-label">{label}</span>
      {configLabel && (
        <span className="provider-badge-model">{configLabel}</span>
      )}
    </span>
  );
}
