import type { ProjectGitStatusSummary } from "@yep-anywhere/shared";
import { useI18n } from "../i18n";

type TFunction = ReturnType<typeof useI18n>["t"];

interface ProjectGitStatusInlineProps {
  status?: ProjectGitStatusSummary | null;
  variant?: "card" | "sidebar";
  showIcon?: boolean;
}

function formatGitSummaryTitle(
  status: ProjectGitStatusSummary,
  t: TFunction,
): string {
  const parts = [
    status.branch ?? t("gitStatusDetachedHead"),
    status.isClean ? t("gitStatusClean") : t("gitStatusDirty"),
  ];

  if (status.ahead > 0) parts.push(`ahead ${status.ahead}`);
  if (status.behind > 0) parts.push(`behind ${status.behind}`);
  if (status.stagedCount > 0)
    parts.push(`${t("gitStatusStaged")}: ${status.stagedCount}`);
  if (status.unstagedCount > 0)
    parts.push(`${t("gitStatusChanges")}: ${status.unstagedCount}`);
  if (status.deletedCount > 0) parts.push(`deleted: ${status.deletedCount}`);
  if (status.untrackedCount > 0)
    parts.push(`${t("gitStatusUntracked")}: ${status.untrackedCount}`);
  if (status.conflictedCount > 0)
    parts.push(`conflicts: ${status.conflictedCount}`);
  if (status.stashCount > 0) parts.push(`stashes: ${status.stashCount}`);

  return parts.join(" · ");
}

export function ProjectGitStatusInline({
  status,
  variant = "card",
  showIcon = true,
}: ProjectGitStatusInlineProps) {
  const { t } = useI18n();

  if (!status?.isGitRepo) return null;

  const branchLabel =
    status.branch ?? (status.head ? `:${status.head}` : "HEAD");

  return (
    <span
      className={`project-git-status project-git-status--${variant} ${
        status.isClean ? "is-clean" : "is-dirty"
      }`}
      title={formatGitSummaryTitle(status, t)}
    >
      {showIcon && (
        <svg
          width="13"
          height="13"
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
      )}
      <span className="project-git-status__branch">{branchLabel}</span>
      {status.ahead > 0 && (
        <span className="project-git-status__count">↑{status.ahead}</span>
      )}
      {status.behind > 0 && (
        <span className="project-git-status__count">↓{status.behind}</span>
      )}
      {status.isClean ? (
        <span className="project-git-status__clean">✓</span>
      ) : (
        <>
          {status.stagedCount > 0 && (
            <span className="project-git-status__count is-staged">
              +{status.stagedCount}
            </span>
          )}
          {status.conflictedCount > 0 && (
            <span className="project-git-status__count is-conflicted">
              x{status.conflictedCount}
            </span>
          )}
          {status.unstagedCount > 0 && (
            <span className="project-git-status__count is-changed">
              !{status.unstagedCount}
            </span>
          )}
          {status.deletedCount > 0 && (
            <span className="project-git-status__count is-deleted">
              -{status.deletedCount}
            </span>
          )}
          {status.untrackedCount > 0 && (
            <span className="project-git-status__count is-untracked">
              ?{status.untrackedCount}
            </span>
          )}
          {status.stashCount > 0 && (
            <span className="project-git-status__count is-stashed">
              *{status.stashCount}
            </span>
          )}
        </>
      )}
    </span>
  );
}
