import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { ThinkingIndicator } from "./ThinkingIndicator";

/**
 * Common SVG icons used in sidebar navigation.
 * Extracted to avoid duplication across components.
 */
export const SidebarIcons = {
  curl: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h15l-4-4M20 17H5l4 4M20 7l-5 4M4 17l5-4" />
    </svg>
  ),
  dsh: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11M13 13l3 2-3 2" />
    </svg>
  ),
  inbox: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
  projects: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  settings: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  allSessions: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  ),
  archive: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  ),
  slashCommands: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 17L10 7" />
      <path d="M13 8h5" />
      <path d="M13 12h7" />
      <path d="M13 16h4" />
    </svg>
  ),
  search: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  uploads: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  ),
  reports: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
      <line x1="8" y1="9" x2="10" y2="9" />
    </svg>
  ),
  newSession: (
    <svg
      className="sidebar-new-session-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="12" fill="var(--app-yep-green)" />
      <line
        x1="12"
        y1="7"
        x2="12"
        y2="17"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="7"
        y1="12"
        x2="17"
        y2="12"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  ),
  sourceControl: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  ),
  recents: (
    <svg
      width="16"
      height="16"
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
    </svg>
  ),
  terminal: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
};

export interface SidebarNavItemProps {
  /** Route path to navigate to */
  to: string;
  /** Icon to display (use SidebarIcons or custom ReactNode) */
  icon: ReactNode;
  /** Label text */
  label: string;
  /** Optional badge count (displays if > 0) */
  badge?: number;
  /** Called when item is clicked (e.g., to close mobile sidebar) */
  onClick?: () => void;
  /** Title tooltip */
  title?: string;
  /** Whether this item has an unsent draft */
  hasDraft?: boolean;
  /** Show pulsing activity indicator (e.g., for active agents) */
  hasActivityIndicator?: boolean;
  /** Base path prefix for navigation links */
  basePath?: string;
  /** Search params that should keep this item from rendering as active. */
  inactiveWhenSearchParams?: string[];
}

function matchesLocationTarget(
  location: ReturnType<typeof useLocation>,
  target: string,
): boolean {
  const queryStart = target.indexOf("?");
  const targetPath = queryStart >= 0 ? target.slice(0, queryStart) : target;
  const targetSearch = queryStart >= 0 ? target.slice(queryStart + 1) : "";

  if (location.pathname !== targetPath) {
    return false;
  }

  if (!targetSearch) {
    return true;
  }

  const currentParams = new URLSearchParams(location.search);
  const targetParams = new URLSearchParams(targetSearch);
  for (const [key, value] of targetParams) {
    if (currentParams.get(key) !== value) {
      return false;
    }
  }

  return true;
}

/**
 * Unified sidebar navigation item component.
 * Provides consistent styling across NavigationSidebar and Sidebar.
 */
export function SidebarNavItem({
  to,
  icon,
  label,
  badge,
  onClick,
  title,
  hasDraft,
  hasActivityIndicator,
  basePath = "",
  inactiveWhenSearchParams = [],
}: SidebarNavItemProps) {
  const location = useLocation();
  const fullPath = `${basePath}${to}`;
  const hasInactiveSearchParam = inactiveWhenSearchParams.some((param) =>
    new URLSearchParams(location.search).has(param),
  );
  // Check if current path matches (with or without basePath prefix)
  const isActive =
    !hasInactiveSearchParam &&
    (matchesLocationTarget(location, fullPath) ||
      matchesLocationTarget(location, to));

  return (
    <Link
      to={fullPath}
      className={`sidebar-nav-item ${isActive ? "active" : ""}`}
      onClick={onClick}
      title={title ?? label}
    >
      {icon}
      <span className="sidebar-nav-text">{label}</span>
      {hasDraft && <span className="session-draft-badge">(draft)</span>}
      {hasActivityIndicator && <ThinkingIndicator />}
      {badge !== undefined && badge > 0 && (
        <span className="sidebar-nav-badge">{badge}</span>
      )}
    </Link>
  );
}

export interface SidebarNavSectionProps {
  children: ReactNode;
  /** Accessible name for the navigation landmark. */
  label?: string;
  /** `grid` packs links into as many columns as the sidebar width allows. */
  layout?: "list" | "grid";
}

/**
 * Container for sidebar navigation items.
 * Provides consistent spacing between items.
 */
export function SidebarNavSection({
  children,
  label,
  layout = "list",
}: SidebarNavSectionProps) {
  return (
    <nav
      className={`sidebar-nav-section${layout === "grid" ? " sidebar-nav-section--grid" : ""}`}
      aria-label={label}
    >
      {children}
    </nav>
  );
}
