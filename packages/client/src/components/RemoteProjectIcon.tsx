import { useI18n } from "../i18n";

interface RemoteProjectIconProps {
  isRemoteProject?: boolean;
}

/** Compact marker for project copies used by Claude Code over SSH. */
export function RemoteProjectIcon({ isRemoteProject }: RemoteProjectIconProps) {
  const { t } = useI18n();

  if (!isRemoteProject) return null;

  const label = t("remoteProjectLabel");

  return (
    <span
      className="remote-project-icon"
      role="img"
      aria-label={label}
      title={label}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="14" rx="2" />
        <path d="m7 9 2.5 2L7 13" />
        <path d="M12 13h5" />
        <path d="M8 21h8" />
        <path d="M12 18v3" />
      </svg>
    </span>
  );
}
