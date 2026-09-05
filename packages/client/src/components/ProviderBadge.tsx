import type { LiveProviderName, ProviderName } from "@yep-anywhere/shared";
import { resolveModelDisplayLabel } from "@yep-anywhere/shared";
import { useOptionalI18n } from "../i18n";

const PROVIDER_COLORS: Record<LiveProviderName, string> = {
  claude: "var(--provider-claude)", // Claude orange
  "claude-ollama": "var(--provider-claude)", // Same as Claude (uses Claude SDK)
  codex: "var(--provider-codex)", // OpenAI green
  "codex-oss": "var(--provider-codex)", // OpenAI green (same as codex)
  gemini: "var(--provider-gemini)", // Google blue
  "gemini-acp": "var(--provider-gemini)", // Google blue (same as gemini)
  pi: "var(--provider-pi)", // Pi cyan
  kimi: "var(--provider-kimi, #1783ff)", // Kimi KMBlue
  zcode: "var(--provider-zcode)", // ZCode
};

const PROVIDER_LABELS: Record<LiveProviderName, string> = {
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
  pi: "Pi",
  kimi: "Kimi",
  zcode: "ZCode",
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
  const i18n = useOptionalI18n();
  const color = PROVIDER_COLORS[provider as LiveProviderName] ?? "currentColor";
  const label = PROVIDER_LABELS[provider as LiveProviderName] ?? provider;

  // Format model name for display
  const getModelLabel = (modelName: string | undefined): string | null => {
    if (!modelName) return null;
    if (modelName === "default") return null;
    return resolveModelDisplayLabel(modelName);
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
      (provider === "pi" && normalized === "default")
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

  const getServiceTierLabel = (): string | null => {
    const normalized = normalizeConfigLabel(serviceTier);
    if (provider === "codex" || provider === "codex-oss") {
      if (normalized === "priority" || normalized === "fast") {
        return i18n?.t("codexFastModeLabel") ?? "Fast (priority)";
      }
      if (normalized === "default") {
        return i18n?.t("codexStandardModeLabel") ?? "Standard";
      }
    }
    return normalized;
  };

  const modelLabel = getModelLabel(model);
  const configLabel = [
    modelLabel,
    getReasoningEffortLabel(reasoningEffort),
    getServiceTierLabel(),
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
