import {
  type SessionFileActivity,
  type UploadCatalogEntry,
  type UploadSessionSummary,
  type UploadSource,
  type UploadTotals,
  fromUrlProjectId,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { type UploadListParams, api } from "../api/client";
import {
  FilterDropdown,
  type FilterOption,
} from "../components/FilterDropdown";
import { PageHeader } from "../components/PageHeader";
import { SessionSavedFilePanel } from "../components/SessionSavedFilePanel";
import { SessionListSkeleton } from "../components/Skeleton";
import { useToastContext } from "../contexts/ToastContext";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useRemoteImage } from "../hooks/useRemoteImage";
import { useSessionFileIndex } from "../hooks/useSessionFileIndex";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { formatSmartTime } from "../lib/datetime";
import { formatBytes } from "../lib/formatBytes";

type Translate = ReturnType<typeof useI18n>["t"];

const SOURCE_LABEL_KEYS = {
  web: "uploadsSourceWeb",
  feishu: "uploadsSourceFeishu",
  generated: "uploadsSourceGenerated",
} as const satisfies Record<UploadSource, string>;

const SEARCH_DEBOUNCE_MS = 300;

function projectLabel(projectId: string): string {
  if (!isUrlProjectId(projectId)) return projectId;
  try {
    const path = fromUrlProjectId(projectId).replace(/\/+$/, "");
    return path.split("/").pop() || path;
  } catch {
    return projectId;
  }
}

/** Title of the owning session; `null` once the session cannot be found. */
function useSessionTitle(
  projectId: string,
  sessionId: string,
): string | null | undefined {
  const [title, setTitle] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setTitle(undefined);
    api
      .getSessionMetadata(projectId, sessionId)
      .then(({ session }) => {
        if (cancelled) return;
        setTitle(
          (session.customTitle ?? session.aiTitle ?? session.title)?.trim() ||
            sessionId,
        );
      })
      .catch(() => {
        if (!cancelled) setTitle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId]);
  return title;
}

/** One paginated listing; `reload` restarts it from the first page. */
function usePagedList<T>(
  fetchPage: (
    cursor: string | null,
  ) => Promise<{ items: T[]; nextCursor: string | null; totals: UploadTotals }>,
) {
  const [items, setItems] = useState<T[]>([]);
  const [totals, setTotals] = useState<UploadTotals | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await fetchPage(cursor);
        setItems((current) =>
          cursor ? [...current, ...page.items] : page.items,
        );
        setTotals(page.totals);
        setNextCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setLoading(false);
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return {
    items,
    setItems,
    totals,
    setTotals,
    nextCursor,
    loading,
    error,
    loadMore: () => void load(nextCursor),
  };
}

export function UploadsPage() {
  const { t } = useI18n();
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId") ?? undefined;
  const sessionId = searchParams.get("sessionId") ?? undefined;
  const sourceParam = searchParams.get("source");
  const source =
    sourceParam && sourceParam in SOURCE_LABEL_KEYS
      ? (sourceParam as UploadSource)
      : undefined;
  const query = searchParams.get("q") ?? "";
  const [queryInput, setQueryInput] = useState(query);

  const updateParams = useCallback(
    (changes: Record<string, string | undefined>) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(changes)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (queryInput === query) return;
    const timer = setTimeout(
      () => updateParams({ q: queryInput.trim() || undefined }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [query, queryInput, updateParams]);

  const sourceOptions: FilterOption<UploadSource>[] = (
    Object.keys(SOURCE_LABEL_KEYS) as UploadSource[]
  ).map((value) => ({ value, label: t(SOURCE_LABEL_KEYS[value]) }));

  const session = projectId && sessionId ? { projectId, sessionId } : null;

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
          title={session ? t("uploadsSessionTitle") : t("uploadsTitle")}
          onOpenSidebar={openSidebar}
          isWideScreen={isWideScreen}
        />
        <main className="page-scroll-container">
          <div className="page-content-inner">
            <div className="archive-toolbar">
              <input
                type="search"
                className="filter-search archive-search"
                placeholder={t("uploadsSearchPlaceholder")}
                value={queryInput}
                onChange={(event) => setQueryInput(event.target.value)}
              />
              <FilterDropdown
                label={t("uploadsFilterSource")}
                options={sourceOptions}
                selected={source ? [source] : []}
                onChange={(selected) => updateParams({ source: selected[0] })}
                multiSelect={false}
                placeholder={t("uploadsSourceAll")}
              />
            </div>
            {session ? (
              <SessionUploads
                {...session}
                source={source}
                query={query}
                onBack={() =>
                  updateParams({
                    projectId: undefined,
                    sessionId: undefined,
                    tab: undefined,
                  })
                }
                tab={
                  searchParams.get("tab") === "changes" ? "changes" : "files"
                }
                onTab={(tab) =>
                  updateParams({ tab: tab === "files" ? undefined : tab })
                }
              />
            ) : (
              <UploadSessions
                source={source}
                query={query}
                onOpen={(summary) =>
                  updateParams({
                    projectId: summary.projectId,
                    sessionId: summary.sessionId,
                  })
                }
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function UploadSessions({
  source,
  query,
  onOpen,
}: {
  source?: UploadSource;
  query: string;
  onOpen: (summary: UploadSessionSummary) => void;
}) {
  const { t, locale } = useI18n();
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const params: UploadListParams = { source, q: query, cursor };
      const page = await api.listUploadSessions(params);
      return { ...page, items: page.sessions };
    },
    [source, query],
  );
  const list = usePagedList(fetchPage);
  useHideSplashOnReady(!list.loading || list.items.length > 0);

  return (
    <>
      <UploadsSummary totals={list.totals} t={t} />
      <ListState
        loading={list.loading && list.items.length === 0}
        error={list.error}
        empty={!list.loading && list.items.length === 0}
        filtered={Boolean(source || query)}
      />
      {list.items.length > 0 && (
        <ul className="archive-session-list content-fade-in">
          {list.items.map((summary) => (
            <li key={`${summary.projectId}/${summary.sessionId}`}>
              <button
                type="button"
                className="archive-session-card uploads-session-card"
                onClick={() => onOpen(summary)}
              >
                <div className="archive-session-main">
                  <SessionTitle {...summary} />
                  <div className="archive-session-meta">
                    <span>{projectLabel(summary.projectId)}</span>
                    <span>
                      {t("uploadsSummary", {
                        count: summary.count,
                        size: formatBytes(summary.bytes),
                      })}
                    </span>
                  </div>
                  <div className="archive-session-dates">
                    {t("uploadsLastAdded", {
                      time: formatSmartTime(summary.lastUploadedAt, locale),
                    })}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <LoadMore list={list} t={t} />
    </>
  );
}

function SessionTitle({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const { t } = useI18n();
  const title = useSessionTitle(projectId, sessionId);
  return (
    <strong className="archive-session-title">
      {title === null ? t("uploadsSessionMissing") : (title ?? sessionId)}
    </strong>
  );
}

function SessionUploads({
  projectId,
  sessionId,
  source,
  query,
  tab,
  onTab,
  onBack,
}: {
  projectId: string;
  sessionId: string;
  source?: UploadSource;
  query: string;
  tab: "files" | "changes";
  onTab: (tab: "files" | "changes") => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  return (
    <>
      <div className="uploads-session-header">
        <button type="button" className="uploads-link-button" onClick={onBack}>
          ‹ {t("uploadsBackToAll")}
        </button>
        <div className="archive-session-title-row">
          <SessionTitle projectId={projectId} sessionId={sessionId} />
          <span className="archive-session-meta">
            {projectLabel(projectId)}
          </span>
          <Link
            className="uploads-link-button"
            to={`${basePath}/projects/${projectId}/sessions/${sessionId}`}
          >
            {t("uploadsOpenSession")}
          </Link>
        </div>
      </div>
      <div className="session-inspector-tabs uploads-tabs" role="tablist">
        {(["files", "changes"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`session-inspector-tab ${tab === key ? "active" : ""}`}
            onClick={() => onTab(key)}
          >
            {key === "files" ? t("uploadsTabFiles") : t("uploadsTabChanges")}
          </button>
        ))}
      </div>
      {tab === "files" ? (
        <SessionFiles
          projectId={projectId}
          sessionId={sessionId}
          source={source}
          query={query}
        />
      ) : (
        <SessionChanges projectId={projectId} sessionId={sessionId} />
      )}
    </>
  );
}

function SessionFiles({
  projectId,
  sessionId,
  source,
  query,
}: {
  projectId: string;
  sessionId: string;
  source?: UploadSource;
  query: string;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [deleting, setDeleting] = useState<string | null>(null);
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const page = await api.listUploads({
        projectId,
        sessionId,
        source,
        q: query,
        cursor,
      });
      return { ...page, items: page.entries };
    },
    [projectId, sessionId, source, query],
  );
  const list = usePagedList(fetchPage);
  useHideSplashOnReady(!list.loading || list.items.length > 0);

  const handleDelete = async (entry: UploadCatalogEntry) => {
    const sent = entry.usedBy.length > 0;
    if (
      sent &&
      !window.confirm(t("uploadsDeleteConfirm", { count: entry.usedBy.length }))
    ) {
      return;
    }
    setDeleting(entry.ref);
    try {
      await api.deleteUpload(entry.ref, sent);
      list.setItems((items) => items.filter((item) => item.ref !== entry.ref));
      list.setTotals((totals) =>
        totals
          ? { count: totals.count - 1, bytes: totals.bytes - entry.size }
          : totals,
      );
    } catch (err) {
      showToast(
        t("uploadsDeleteFailed", {
          message: err instanceof Error ? err.message : String(err),
        }),
        "error",
      );
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <UploadsSummary totals={list.totals} t={t} />
      <ListState
        loading={list.loading && list.items.length === 0}
        error={list.error}
        empty={!list.loading && list.items.length === 0}
        filtered={Boolean(source || query)}
      />
      {list.items.length > 0 && (
        <ul className="archive-session-list content-fade-in">
          {list.items.map((entry) => (
            <UploadFileRow
              key={entry.ref}
              entry={entry}
              deleting={deleting === entry.ref}
              onDelete={() => void handleDelete(entry)}
            />
          ))}
        </ul>
      )}
      <LoadMore list={list} t={t} />
    </>
  );
}

function UploadFileRow({
  entry,
  deleting,
  onDelete,
}: {
  entry: UploadCatalogEntry;
  deleting: boolean;
  onDelete: () => void;
}) {
  const { t, locale } = useI18n();
  const { url } = useRemoteImage(entry.downloadUrl ?? null);
  const isImage = entry.mimeType.startsWith("image/");
  return (
    <li className="archive-session-card uploads-file-card">
      <div className="uploads-file-thumb" aria-hidden="true">
        {isImage && url ? (
          <img src={url} alt="" loading="lazy" />
        ) : (
          <span>{entry.originalName.split(".").pop()?.slice(0, 4) || "?"}</span>
        )}
      </div>
      <div className="archive-session-main">
        <strong className="archive-session-title">{entry.originalName}</strong>
        <div className="archive-session-meta">
          <span className="session-archived-badge">
            {t(SOURCE_LABEL_KEYS[entry.source])}
          </span>
          <span>{formatBytes(entry.size)}</span>
          <span title={new Date(entry.uploadedAt).toLocaleString(locale)}>
            {formatSmartTime(entry.uploadedAt, locale)}
          </span>
          <span>
            {entry.usedBy.length > 0
              ? t("uploadsUsedBy", { count: entry.usedBy.length })
              : t("uploadsUnused")}
          </span>
        </div>
      </div>
      <div className="uploads-file-actions">
        {url && (
          <>
            <a href={url} target="_blank" rel="noreferrer">
              {t("uploadsOpen")}
            </a>
            <a href={`${url}?download=1`} download={entry.originalName}>
              {t("uploadsDownload")}
            </a>
          </>
        )}
        <button
          type="button"
          className="uploads-delete-button"
          onClick={onDelete}
          disabled={deleting}
        >
          {deleting ? t("uploadsDeleting") : t("uploadsDelete")}
        </button>
      </div>
    </li>
  );
}

function SessionChanges({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { index, loading, error } = useSessionFileIndex(projectId, sessionId);
  const [openFile, setOpenFile] = useState<SessionFileActivity | null>(null);
  const changes = (index?.files ?? []).filter(
    (file) => file.kind === "modified",
  );
  const openCurrent = (file: SessionFileActivity) =>
    navigate(
      `${basePath}/file?path=${encodeURIComponent(file.path)}&projectId=${projectId}`,
    );

  if (!index && loading) return <SessionListSkeleton />;
  if (error && !index) {
    return (
      <p className="error">
        {t("projectsErrorPrefix")} {error.message}
      </p>
    );
  }
  if (changes.length === 0) {
    return <p className="archive-summary">{t("uploadsChangesEmpty")}</p>;
  }
  return (
    <>
      <ul className="archive-session-list content-fade-in">
        {changes.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="archive-session-card uploads-session-card"
              onClick={() =>
                file.savedVersions?.length
                  ? setOpenFile(file)
                  : openCurrent(file)
              }
            >
              <div className="archive-session-main">
                <strong className="archive-session-title uploads-change-path">
                  {file.path}
                </strong>
                <div className="archive-session-meta">
                  {file.additions !== undefined && (
                    <span>+{file.additions}</span>
                  )}
                  {file.deletions !== undefined && (
                    <span>−{file.deletions}</span>
                  )}
                  {file.savedVersions?.length ? (
                    <span>
                      {t("uploadsChangesSaved", {
                        count: file.savedVersions.length,
                      })}
                    </span>
                  ) : null}
                  {file.timestamp && (
                    <span>{formatSmartTime(file.timestamp, locale)}</span>
                  )}
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {openFile && (
        <SessionSavedFilePanel
          projectId={projectId}
          sessionId={sessionId}
          file={openFile}
          onClose={() => setOpenFile(null)}
          onOpenCurrent={() => openCurrent(openFile)}
        />
      )}
    </>
  );
}

function UploadsSummary({
  totals,
  t,
}: {
  totals: UploadTotals | null;
  t: Translate;
}) {
  if (!totals) return null;
  return (
    <div className="archive-summary">
      <span>
        {t("uploadsSummary", {
          count: totals.count,
          size: formatBytes(totals.bytes),
        })}
      </span>
    </div>
  );
}

function ListState({
  loading,
  error,
  empty,
  filtered,
}: {
  loading: boolean;
  error: Error | null;
  empty: boolean;
  filtered: boolean;
}) {
  const { t } = useI18n();
  if (loading) return <SessionListSkeleton />;
  if (error) {
    return (
      <p className="error">
        {t("projectsErrorPrefix")} {error.message}
      </p>
    );
  }
  if (!empty) return null;
  return (
    <div className="inbox-empty content-fade-in">
      <h3>{filtered ? t("uploadsNoResultsTitle") : t("uploadsEmptyTitle")}</h3>
      <p>{filtered ? t("uploadsNoResultsBody") : t("uploadsEmptyBody")}</p>
    </div>
  );
}

function LoadMore({
  list,
  t,
}: {
  list: { nextCursor: string | null; loading: boolean; loadMore: () => void };
  t: Translate;
}) {
  if (!list.nextCursor) return null;
  return (
    <button
      type="button"
      className="global-sessions-load-more-button uploads-load-more"
      onClick={list.loadMore}
      disabled={list.loading}
    >
      {t("globalSessionsLoadMore")}
    </button>
  );
}
