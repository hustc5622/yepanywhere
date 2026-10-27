import type { ThinkingMode } from "../hooks/useModelSettings";
import { useI18n } from "../i18n";

interface ThinkingToggleButtonProps {
  mode: ThinkingMode;
  /** Effort label shown when thinking is on (e.g. "High"). */
  levelLabel: string;
  onCycle: () => void;
  disabled?: boolean;
  /** Toolbar button class of the hosting composer. */
  className?: string;
  iconSize?: number;
}

/** Cycles off → auto → on; shared by every composer toolbar. */
export function ThinkingToggleButton({
  mode,
  levelLabel,
  onCycle,
  disabled,
  className,
  iconSize = 16,
}: ThinkingToggleButtonProps) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`${className ? `${className} ` : ""}thinking-toggle-button ${mode !== "off" ? `active ${mode}` : ""}`}
      onClick={onCycle}
      disabled={disabled}
      title={
        mode === "off"
          ? t("newSessionThinkingOff")
          : mode === "auto"
            ? t("newSessionThinkingAuto")
            : t("newSessionThinkingOn", { level: levelLabel })
      }
      aria-label={t("newSessionThinkingMode", { mode })}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
        {mode === "auto" && (
          <g>
            <circle cx="19" cy="5" r="5.5" fill="currentColor" stroke="none" />
            <text
              x="19"
              y="5"
              textAnchor="middle"
              dominantBaseline="central"
              fill="var(--bg-primary, #1a1a2e)"
              fontSize="8"
              fontWeight="700"
              fontFamily="var(--font-sans)"
              stroke="none"
            >
              A
            </text>
          </g>
        )}
      </svg>
    </button>
  );
}
