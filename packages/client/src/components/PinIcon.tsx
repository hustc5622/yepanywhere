interface PinIconProps {
  size?: number;
  className?: string;
}

/** Shared push-pin icon used by session pin controls and indicators. */
export function PinIcon({ size = 14, className }: PinIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M5 17h14" />
      <path d="M6 3h12" />
      <path d="M8 3v5a5 5 0 0 1-2 3.5L5 12v5h14v-5l-1-.5A5 5 0 0 1 16 8V3" />
    </svg>
  );
}
