import type { ProviderName } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { type SearchMatch, type SearchResultSession, api } from "../api/client";
import {
  FilterDropdown,
  type FilterOption,
} from "../components/FilterDropdown";
import { PageHeader } from "../components/PageHeader";
import { SessionListSkeleton } from "../components/Skeleton";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/** Render a snippet with the matched substring wrapped in <mark>. */
function HighlightedSnippet({ match }: { match: SearchMatch }) {
  const { snippet, matchStart, matchLength } = match;
  const before = snippet.slice(0, matchStart);
  const hit = snippet.slice(matchStart, matchStart + matchLength);
  const after = snippet.slice(matchStart + matchLength);
  return (
    <span className="search-snippet">
      {before}
      <mark className="search-snippet__mark">{hit}</mark>
      {after}
    </span>
  );
}

/**
 * Full-text search page. Searches user prompts and assistant replies across all
 * sessions (or a single project), groups matches per session, and deep-links to
 * the matched message on click.
 */
export function SearchPage() {
  const { t } = useI18n();
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const basePath = useRemoteBasePath();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get("q") || "";
  const projectFilter = searchParams.get("project") || undefined;

  const [searchInput, setSearchInput] = useState(query);
  const [results, setResults] = useState<SearchResultSession[]>([]);
  const [projectOptions, setProjectOptions] = useState<FilterOption<string>[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [summary, setSummary] = useState<{
    sessions: number;
    matches: number;
  } | null>(null);

  useHideSplashOnReady(true);

  // Load project options once (for the scope dropdown).
  useEffect(() => {
    let cancelled = false;
    api
      .getGlobalSessions({ limit: 1 })
      .then((res) => {
        if (cancelled) return;
        setProjectOptions(
          res.projects.map((p) => ({ value: p.id, label: p.name })),
        );
      })
      .catch(() => {
        // Non-fatal: scope dropdown just won't populate.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the input in sync if the URL query changes externally.
  useEffect(() => {
    setSearchInput(query);
  }, [query]);

  // Debounce the input into the URL `q` param.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleInputChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            const trimmed = value.trim();
            if (trimmed) next.set("q", trimmed);
            else next.delete("q");
            return next;
          },
          { replace: true },
        );
      }, DEBOUNCE_MS);
    },
    [setSearchParams],
  );

  const handleProjectFilter = useCallback(
    (selected: string[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (selected[0]) next.set("project", selected[0]);
        else next.delete("project");
        return next;
      });
    },
    [setSearchParams],
  );

  // Run the search whenever the query or project scope changes.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSummary(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .search({ q: trimmed, project: projectFilter })
      .then((res) => {
        if (cancelled) return;
        setResults(res.results);
        setSummary({
          sessions: res.totalSessions,
          matches: res.totalMatches,
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err);
        setResults([]);
        setSummary(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [query, projectFilter]);

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length >= MIN_QUERY_LENGTH;
  const isEmpty = hasQuery && !loading && !error && results.length === 0;

  const roleLabel = useCallback(
    (role: string) =>
      role === "assistant" ? t("searchRoleAssistant") : t("searchRoleUser"),
    [t],
  );

  const handleResultClick = useCallback(
    (result: SearchResultSession, messageId: string) => {
      navigate(
        `${basePath}/projects/${result.projectId}/sessions/${result.sessionId}`,
        { state: { targetMessageId: messageId } },
      );
    },
    [navigate, basePath],
  );

  const summaryText = useMemo(() => {
    if (!summary) return null;
    return t("searchResultSummary", {
      sessions: summary.sessions,
      matches: summary.matches,
    });
  }, [summary, t]);

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
          title={t("searchTitle")}
          onOpenSidebar={openSidebar}
          isWideScreen={isWideScreen}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            <div className="filter-bar search-filter-bar">
              <input
                type="search"
                className="filter-search search-page-input"
                placeholder={t("searchPlaceholder")}
                value={searchInput}
                // biome-ignore lint/a11y/noAutofocus: search page's primary action
                autoFocus
                onChange={(e) => handleInputChange(e.target.value)}
              />
              {projectOptions.length > 0 && (
                <FilterDropdown
                  label={t("searchScopeProject")}
                  options={projectOptions}
                  selected={projectFilter ? [projectFilter] : []}
                  onChange={handleProjectFilter}
                  multiSelect={false}
                  placeholder={t("searchScopeAll")}
                />
              )}
            </div>

            {summaryText && !loading && (
              <p className="search-summary">{summaryText}</p>
            )}

            {loading && <SessionListSkeleton />}

            {error && (
              <p className="error">
                {t("projectsErrorPrefix")} {error.message}
              </p>
            )}

            {!hasQuery && !loading && (
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
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <h3>{t("searchHintTitle")}</h3>
                <p>{t("searchHintBody")}</p>
              </div>
            )}

            {isEmpty && (
              <div className="inbox-empty content-fade-in">
                <h3>{t("searchNoResultsTitle")}</h3>
                <p>{t("searchNoResultsBody")}</p>
              </div>
            )}

            {!error && results.length > 0 && (
              <div className="search-results">
                {results.map((result) => (
                  <div key={result.sessionId} className="search-result-group">
                    <Link
                      to={`${basePath}/projects/${result.projectId}/sessions/${result.sessionId}`}
                      className="search-result-header"
                    >
                      <span className="search-result-title">
                        {result.title}
                      </span>
                      <span className="search-result-meta">
                        <span className="search-result-project">
                          {result.projectName}
                        </span>
                        <ProviderTag provider={result.provider} />
                        <span className="search-result-count">
                          {result.matchCount === 1
                            ? t("searchMatchCountOne")
                            : t("searchMatchCount", {
                                count: result.matchCount,
                              })}
                        </span>
                      </span>
                    </Link>
                    <ul className="search-match-list">
                      {result.matches.map((match) => (
                        <li key={match.messageId}>
                          <button
                            type="button"
                            className="search-match"
                            onClick={() =>
                              handleResultClick(result, match.messageId)
                            }
                          >
                            <span className="search-match__role">
                              {roleLabel(match.role)}
                            </span>
                            <HighlightedSnippet match={match} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

const PROVIDER_COLORS: Partial<Record<ProviderName, string>> = {
  claude: "var(--app-yep-green)",
  "claude-ollama": "var(--app-yep-green)",
  codex: "#10a37f",
  "codex-oss": "#f97316",
  gemini: "#4285f4",
  "gemini-acp": "#4285f4",
  opencode: "#9333ea",
  kimi: "var(--provider-kimi)",
};

function ProviderTag({ provider }: { provider: ProviderName }) {
  const color = PROVIDER_COLORS[provider] ?? "var(--text-dimmed)";
  return (
    <span className="search-result-provider">
      <span
        className="search-result-provider__dot"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      {provider}
    </span>
  );
}
