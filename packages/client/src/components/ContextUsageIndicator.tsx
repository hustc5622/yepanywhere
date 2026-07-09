import { useI18n } from "../i18n";
import { formatTokenCount as formatTokens } from "../lib/tokens";
import type { ContextUsage } from "../types";

interface ContextUsageIndicatorProps {
  /** Context usage data */
  usage?: ContextUsage;
  /** Size of the indicator in pixels (default: 16) */
  size?: number;
  /** Whether to show the percentage label (default: true) */
  showLabel?: boolean;
  /** Label style for compact surfaces. Default keeps existing percentage UI. */
  labelMode?: "percent" | "tokens";
  /**
   * When provided, the indicator becomes interactive (button) and invokes
   * this callback on click — used by SessionPage to open the
   * ContextStatusModal. Without it, the indicator stays as a static span
   * (current behavior in list rows).
   */
  onClick?: () => void;
  /** Accessible label for the interactive button. */
  ariaLabel?: string;
}

/**
 * Small pie chart indicator showing context window usage percentage.
 * Displays a gray pie chart that fills based on usage, with percentage label.
 */
export function ContextUsageIndicator({
  usage,
  size = 16,
  showLabel = true,
  labelMode = "percent",
  onClick,
  ariaLabel,
}: ContextUsageIndicatorProps) {
  const { t } = useI18n();
  if (!usage) return null;

  const { percentage } = usage;
  const displayPercentage = Math.max(0, percentage);
  // Clamp only the visual fill to 0-100.
  const clampedPercentage = Math.min(100, Math.max(0, percentage));

  // Calculate the stroke-dasharray for the pie chart
  // Circumference of circle with r=8 (for size=16) = 2 * PI * r
  const radius = size / 2 - 1; // Leave 1px for stroke
  const circumference = 2 * Math.PI * radius;
  const filled = (clampedPercentage / 100) * circumference;

  // Fill color - lighter color that shows usage amount
  const getFillColor = () => {
    if (clampedPercentage >= 90) return "var(--color-error, #dc3545)";
    if (clampedPercentage >= 75) return "var(--color-warning, #ffc107)";
    return "var(--text-muted, #9d9d9d)";
  };

  const tooltip = usage.contextWindow
    ? t("contextTooltipWithWindow", {
        percentage: displayPercentage,
        used: formatTokens(usage.inputTokens),
        total: formatTokens(usage.contextWindow),
      })
    : t("contextTooltipNoWindow", {
        percentage: displayPercentage,
        used: formatTokens(usage.inputTokens),
      });
  const label =
    labelMode === "tokens"
      ? usage.contextWindow
        ? `${formatTokens(usage.inputTokens)}/${formatTokens(usage.contextWindow)}`
        : formatTokens(usage.inputTokens)
      : `${displayPercentage}%`;

  return (
    <ContextUsageWrapper
      onClick={onClick}
      title={tooltip}
      ariaLabel={ariaLabel ?? tooltip}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="context-usage-pie"
        aria-hidden="true"
      >
        {/* Background circle - darker */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border-color, #3c3c3c)"
          strokeWidth="2"
        />
        {/* Filled arc - lighter color showing usage, rotated -90deg so it starts from top */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={getFillColor()}
          strokeWidth="2"
          strokeDasharray={`${filled} ${circumference}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {showLabel && <span className="context-usage-label">{label}</span>}
    </ContextUsageWrapper>
  );
}

function ContextUsageWrapper({
  onClick,
  title,
  ariaLabel,
  children,
}: {
  onClick?: () => void;
  title: string;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  if (onClick) {
    return (
      <button
        type="button"
        className="context-usage-indicator context-usage-indicator--button"
        title={title}
        aria-label={ariaLabel}
        onClick={onClick}
      >
        {children}
      </button>
    );
  }
  return (
    <span className="context-usage-indicator" title={title}>
      {children}
    </span>
  );
}
