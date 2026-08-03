import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { truncateText } from "../lib/text";

interface PageHeaderProps {
  title: string;
  /** Optional custom element to render instead of the default title */
  titleElement?: ReactNode;
  /** Mobile: opens the sidebar overlay */
  onOpenSidebar?: () => void;
  /** Whether we're in desktop mode (wide screen) */
  isWideScreen: boolean;
  /** Show a back button instead of sidebar toggle */
  showBack?: boolean;
  /** Callback when back button is clicked */
  onBack?: () => void;
}

const SidebarToggleIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="9" y1="3" x2="9" y2="21" />
  </svg>
);

const BackIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

export function PageHeader({
  title,
  titleElement,
  onOpenSidebar,
  isWideScreen,
  showBack = false,
  onBack,
}: PageHeaderProps) {
  const { t } = useI18n();
  // Desktop sidebar controls live inside the sidebar itself. Content headers
  // only need an entry point for the mobile overlay.
  const handleOpenSidebar = isWideScreen ? undefined : onOpenSidebar;

  return (
    <header className="session-header">
      <div className="session-header-inner">
        <div className="session-header-left">
          {showBack && onBack ? (
            <button
              type="button"
              className="sidebar-toggle"
              onClick={onBack}
              title={t("actionBack")}
              aria-label={t("actionBack")}
            >
              <BackIcon />
            </button>
          ) : (
            handleOpenSidebar && (
              <button
                type="button"
                className="sidebar-toggle"
                onClick={handleOpenSidebar}
                title={t("actionOpenSidebar")}
                aria-label={t("actionOpenSidebar")}
              >
                <SidebarToggleIcon />
              </button>
            )
          )}
          {titleElement ?? (
            <span
              className="session-title"
              title={title.length > 60 ? title : undefined}
            >
              {truncateText(title)}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
