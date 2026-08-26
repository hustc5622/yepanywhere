import { useI18n } from "../i18n";
import { PinIcon } from "./PinIcon";

interface BulkActionBarProps {
  selectedCount: number;
  onArchive: () => Promise<void>;
  onUnarchive: () => Promise<void>;
  onPin: () => Promise<void>;
  onUnpin: () => Promise<void>;
  onMarkRead: () => Promise<void>;
  onMarkUnread: () => Promise<void>;
  onClearSelection: () => void;
  isPending?: boolean;
  /** True if any selected item can be archived (is not archived) */
  canArchive?: boolean;
  /** True if any selected item can be unarchived (is archived) */
  canUnarchive?: boolean;
  /** True if any selected item can be pinned (is not pinned) */
  canPin?: boolean;
  /** True if any selected item can be unpinned (is pinned) */
  canUnpin?: boolean;
  /** True if any selected item can be marked as read (has unread) */
  canMarkRead?: boolean;
  /** True if any selected item can be marked as unread (is read) */
  canMarkUnread?: boolean;
  /** Archive all filtered sessions (shown when filters active, no selection) */
  onArchiveAllFiltered?: () => Promise<void>;
  /** Number of archivable sessions in filtered results */
  archivableFilteredCount?: number;
}

/**
 * Fixed bottom bar for bulk session actions.
 * Slides up when sessions are selected, slides down when cleared.
 */
export function BulkActionBar({
  selectedCount,
  onArchive,
  onUnarchive,
  onPin,
  onUnpin,
  onMarkRead,
  onMarkUnread,
  onClearSelection,
  isPending = false,
  canArchive = true,
  canUnarchive = true,
  canPin = true,
  canUnpin = true,
  canMarkRead = true,
  canMarkUnread = true,
  onArchiveAllFiltered,
  archivableFilteredCount = 0,
}: BulkActionBarProps) {
  const { t } = useI18n();
  // Show "Archive all N" bar when filters are active but no manual selection
  if (selectedCount === 0) {
    if (!onArchiveAllFiltered || archivableFilteredCount === 0) {
      return null;
    }

    return (
      <div className="bulk-action-bar">
        <div className="bulk-action-bar__actions">
          <button
            type="button"
            className="bulk-action-button bulk-action-button--primary"
            onClick={onArchiveAllFiltered}
            disabled={isPending}
            title={t("bulkArchiveAllFilteredTitle", {
              count: archivableFilteredCount,
            })}
          >
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
            <span>
              {t("bulkArchiveAll", { count: archivableFilteredCount })}
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bulk-action-bar">
      <div className="bulk-action-bar__info">
        <span className="bulk-action-bar__count">
          {t("bulkSelectedCount", { count: selectedCount })}
        </span>
        <button
          type="button"
          className="bulk-action-bar__clear"
          onClick={onClearSelection}
          disabled={isPending}
          aria-label={t("bulkClearSelection")}
        >
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
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="bulk-action-bar__actions">
        {canArchive && (
          <button
            type="button"
            className="bulk-action-button"
            onClick={onArchive}
            disabled={isPending}
            title={t("bulkArchiveSelected")}
          >
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
            <span>{t("bulkArchive")}</span>
          </button>
        )}

        {canUnarchive && (
          <button
            type="button"
            className="bulk-action-button"
            onClick={onUnarchive}
            disabled={isPending}
            title={t("bulkUnarchiveSelected")}
          >
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
              <polyline points="12 11 12 17" />
              <polyline points="9 14 12 11 15 14" />
            </svg>
            <span>{t("bulkUnarchive")}</span>
          </button>
        )}

        {canPin && (
          <button
            type="button"
            className="bulk-action-button"
            onClick={onPin}
            disabled={isPending}
            title={t("bulkPinSelected")}
          >
            <PinIcon size={16} />
            <span>{t("bulkPin")}</span>
          </button>
        )}

        {canUnpin && (
          <button
            type="button"
            className="bulk-action-button"
            onClick={onUnpin}
            disabled={isPending}
            title={t("bulkUnpinSelected")}
          >
            <PinIcon size={16} />
            <span>{t("bulkUnpin")}</span>
          </button>
        )}

        {canMarkRead && (
          <button
            type="button"
            className="bulk-action-button"
            onClick={onMarkRead}
            disabled={isPending}
            title={t("bulkMarkReadTitle")}
          >
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
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span>{t("bulkMarkRead")}</span>
          </button>
        )}

        {canMarkUnread && (
          <button
            type="button"
            className="bulk-action-button"
            onClick={onMarkUnread}
            disabled={isPending}
            title={t("bulkMarkUnreadTitle")}
          >
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
              <circle cx="12" cy="12" r="4" fill="currentColor" />
            </svg>
            <span>{t("bulkMarkUnread")}</span>
          </button>
        )}
      </div>
    </div>
  );
}
