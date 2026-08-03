import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type ArchivedSessionRecord, api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { ProviderBadge } from "../components/ProviderBadge";
import { SessionListSkeleton } from "../components/Skeleton";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { formatSmartTime } from "../lib/datetime";

function getArchivedSessionTitle(session: ArchivedSessionRecord): string {
  return session.title ?? session.fullTitle ?? session.sessionId;
}

function getProjectLabel(projectPath: string): string {
  const normalized = projectPath.replace(/\/+$/, "");
  return normalized.split("/").pop() || normalized || projectPath;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getArchivedSessionSize(session: ArchivedSessionRecord): number {
  return session.files.reduce((sum, file) => sum + file.size, 0);
}

export function ArchivePage() {
  const { t, locale } = useI18n();
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();

  const [sessions, setSessions] = useState<ArchivedSessionRecord[]>([]);
  const [archiveDir, setArchiveDir] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadArchive = useCallback(async (mode: "initial" | "refresh") => {
    if (mode === "initial") {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(null);
    try {
      const response = await api.getArchivedSessions();
      setSessions(response.sessions);
      setArchiveDir(response.archiveDir);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadArchive("initial");
  }, [loadArchive]);

  useHideSplashOnReady(!loading);

  const filteredSessions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return sessions;

    return sessions.filter((session) => {
      const fields = [
        session.sessionId,
        getArchivedSessionTitle(session),
        session.projectPath,
        getProjectLabel(session.projectPath),
        session.provider,
        session.reason,
      ];
      return fields.some((field) => field.toLowerCase().includes(trimmed));
    });
  }, [sessions, query]);

  const totalBytes = useMemo(
    () =>
      sessions.reduce(
        (sum, session) => sum + getArchivedSessionSize(session),
        0,
      ),
    [sessions],
  );

  const handleRestoreAndOpen = async (session: ArchivedSessionRecord) => {
    if (restoringId) return;
    setRestoringId(session.sessionId);
    setError(null);
    try {
      await api.updateSessionMetadata(session.sessionId, { archived: false });
      setSessions((current) =>
        current.filter((item) => item.sessionId !== session.sessionId),
      );
      navigate(
        `${basePath}/projects/${session.projectId}/sessions/${session.sessionId}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setRestoringId(null);
    }
  };

  const isEmpty = !loading && !error && filteredSessions.length === 0;

  return (
    <div
      className={isWideScreen ? "main-content-wrapper" : "main-content-mobile"}
    >
      <div
        className={
          isWideScreen
            ? "main-content-constrained"
            : "main-content-mobile-inner"
        }
      >
        <PageHeader
          title={t("archiveTitle")}
          onOpenSidebar={openSidebar}
          isWideScreen={isWideScreen}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            <div className="archive-toolbar">
              <input
                type="search"
                className="filter-search archive-search"
                placeholder={t("archiveSearchPlaceholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button
                type="button"
                className="global-sessions-load-more-button archive-refresh"
                onClick={() => void loadArchive("refresh")}
                disabled={refreshing}
              >
                {refreshing ? t("inboxRefreshing") : t("inboxRefresh")}
              </button>
            </div>

            {!loading && (
              <div className="archive-summary">
                <span>
                  {t("archiveSummarySessions", { count: sessions.length })}
                </span>
                <span>
                  {t("archiveSummarySize", { size: formatBytes(totalBytes) })}
                </span>
                {archiveDir && (
                  <span className="archive-summary-path" title={archiveDir}>
                    {archiveDir}
                  </span>
                )}
              </div>
            )}

            {loading && <SessionListSkeleton />}

            {error && (
              <p className="error">
                {t("projectsErrorPrefix")} {error.message}
              </p>
            )}

            {isEmpty && (
              <div className="inbox-empty content-fade-in">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="21 8 21 21 3 21 3 8" />
                  <rect x="1" y="3" width="22" height="5" />
                  <line x1="10" y1="12" x2="14" y2="12" />
                </svg>
                <h3>
                  {query.trim()
                    ? t("archiveNoResultsTitle")
                    : t("archiveEmptyTitle")}
                </h3>
                <p>
                  {query.trim()
                    ? t("archiveNoResultsBody")
                    : t("archiveEmptyBody")}
                </p>
              </div>
            )}

            {!error && filteredSessions.length > 0 && (
              <ul className="archive-session-list content-fade-in">
                {filteredSessions.map((session) => {
                  const title = getArchivedSessionTitle(session);
                  const size = getArchivedSessionSize(session);
                  const fileCount = session.files.length;
                  return (
                    <li
                      key={session.sessionId}
                      className="archive-session-card"
                    >
                      <div className="archive-session-main">
                        <div className="archive-session-title-row">
                          <strong className="archive-session-title">
                            {title}
                          </strong>
                          <span className="session-archived-badge">
                            {session.reason === "auto"
                              ? t("archiveReasonAuto")
                              : t("archiveReasonManual")}
                          </span>
                        </div>
                        <div className="archive-session-meta">
                          <span>{getProjectLabel(session.projectPath)}</span>
                          <ProviderBadge provider={session.provider} compact />
                          {session.messageCount !== undefined && (
                            <span>
                              {t("cardMessageCount", {
                                count: session.messageCount,
                              })}
                            </span>
                          )}
                          <span>
                            {t("archiveFileCount", { count: fileCount })}
                          </span>
                          <span>{formatBytes(size)}</span>
                        </div>
                        <div className="archive-session-dates">
                          {session.updatedAt && (
                            <span
                              title={new Date(session.updatedAt).toLocaleString(
                                locale,
                              )}
                            >
                              {t("archiveUpdatedAt", {
                                time: formatSmartTime(
                                  session.updatedAt,
                                  locale,
                                ),
                              })}
                            </span>
                          )}
                          <span
                            title={new Date(session.archivedAt).toLocaleString(
                              locale,
                            )}
                          >
                            {t("archiveArchivedAt", {
                              time: formatSmartTime(session.archivedAt, locale),
                            })}
                          </span>
                        </div>
                        <div
                          className="archive-session-path"
                          title={session.projectPath}
                        >
                          {session.projectPath}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn-primary archive-restore-button"
                        onClick={() => void handleRestoreAndOpen(session)}
                        disabled={restoringId !== null}
                      >
                        {restoringId === session.sessionId
                          ? t("archiveRestoring")
                          : t("archiveRestoreAndOpen")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
