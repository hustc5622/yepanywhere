import type { AppSessionSummary } from "@yep-anywhere/shared";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n";

const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * Build a locator URL only for an opaque session id. Rejecting path-shaped
 * values keeps corrupt provider metadata from becoming a filesystem-like URL.
 */
export function buildForkParentLocatorPath(
  basePath: string,
  forkParentSessionId: string | undefined,
): string | null {
  const normalized = forkParentSessionId?.trim();
  if (!normalized || !SAFE_SESSION_ID_PATTERN.test(normalized)) return null;

  const normalizedBasePath = basePath.endsWith("/")
    ? basePath.slice(0, -1)
    : basePath;
  return `${normalizedBasePath}/sessions/${encodeURIComponent(normalized)}`;
}

export function SessionForkParentBanner({
  basePath,
  session,
}: {
  basePath: string;
  session: Pick<AppSessionSummary, "forkParentSessionId">;
}) {
  const { t } = useI18n();
  if (!session.forkParentSessionId) return null;

  const parentPath = buildForkParentLocatorPath(
    basePath,
    session.forkParentSessionId,
  );
  const content = (
    <>
      <span className="subagent-parent-banner-icon" aria-hidden="true">
        ⑂
      </span>
      <span className="subagent-parent-banner-text">
        {t("sessionForkParentBanner")}
      </span>
      <span className="subagent-parent-banner-link">
        {parentPath
          ? t("sessionForkParentBannerLink")
          : t("sessionForkParentBannerUnavailable")}
      </span>
    </>
  );

  if (!parentPath) {
    return (
      <div className="subagent-parent-banner fork-parent-banner" role="status">
        {content}
      </div>
    );
  }

  return (
    <Link className="subagent-parent-banner fork-parent-banner" to={parentPath}>
      {content}
    </Link>
  );
}
